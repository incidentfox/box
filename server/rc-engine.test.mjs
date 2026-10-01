import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeStartupBlockReason, parseEntry } from './rc-engine.mjs';

test('interactive setup and OAuth screens are caught before sending a prompt', () => {
  assert.equal(claudeStartupBlockReason('\x1b[2JLet\x1b[1m\'s get started\x1b[0m Choose the text style'), 'setup');
  assert.equal(claudeStartupBlockReason('\x1b[2JOAuth error: Invalid code. Press Enter to retry.'), 'sign-in');
  assert.equal(claudeStartupBlockReason('Claude Code 2.1.178 > Ask Claude anything'), null);
});

const kinds = (o) => parseEntry(o).map((e) => e.kind);

// Claude Code splits ONE assistant message across several JSONL rows — one per content
// block — and stamps every row with that message's stop_reason. So the thinking row of a
// final answer already says `end_turn` while the text row holding the answer is still to
// come. Ending the turn on that first row makes the box emit `done` before the answer,
// and the client renders the finished turn's trailing block empty (its `live.raw` was
// reset by the preceding tool chip) while the real text lands in an orphaned bubble.
test('a thinking-only row does not end the turn even when it says end_turn', () => {
  assert.deepEqual(
    kinds({ type: 'assistant', message: { id: 'msg_1', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'weighing the options' }] } }),
    ['thinking'],
  );
});

test('the text row of the same message ends the turn, after its text', () => {
  assert.deepEqual(
    kinds({ type: 'assistant', message: { id: 'msg_1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is the answer.' }] } }),
    ['text', 'turn_end'],
  );
});

test('a row mixing thinking and text still ends the turn', () => {
  assert.deepEqual(
    kinds({ type: 'assistant', message: { id: 'msg_2', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Done.' }] } }),
    ['thinking', 'text', 'turn_end'],
  );
});

test('a tool_use row does not end the turn', () => {
  assert.deepEqual(
    kinds({ type: 'assistant', message: { id: 'msg_3', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } }] } }),
    ['tool'],
  );
});

test('stop_sequence ends the turn the same way end_turn does', () => {
  assert.deepEqual(
    kinds({ type: 'assistant', message: { id: 'msg_4', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'stopped' }] } }),
    ['text', 'turn_end'],
  );
});

// An assistant row with no content blocks carries no answer to wait for, so it keeps the
// old behaviour: it still closes the turn rather than stalling until the turn timeout.
test('an empty assistant row still ends the turn', () => {
  assert.deepEqual(
    kinds({ type: 'assistant', message: { id: 'msg_5', stop_reason: 'end_turn', content: [] } }),
    ['turn_end'],
  );
});
