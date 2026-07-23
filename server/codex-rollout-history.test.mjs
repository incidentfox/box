import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexRolloutHistory, codexRolloutMeta, codexRolloutState, parseCodexLiveEntry, parseCodexRollout,
} from './codex-rollout-history.mjs';

const rows = [
  { timestamp: '2026-07-17T17:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Monitor calls' } },
  { timestamp: '2026-07-17T17:00:01Z', type: 'response_item', payload: { type: 'reasoning', summary: ['secret'] } },
  { timestamp: '2026-07-17T17:00:02Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Checking ten live calls.' } },
  { timestamp: '2026-07-17T17:00:03Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.exec_command({"cmd":"poll calls","workdir":"/tmp"});' } },
  { timestamp: '2026-07-17T17:00:04Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: '9 active' } },
  { timestamp: '2026-07-17T17:00:05Z', type: 'response_item', payload: { type: 'function_call', name: 'wait', call_id: 'c2', arguments: '{"cell_id":"12"}' } },
  { timestamp: '2026-07-17T17:00:06Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'finished' }] } },
].map(JSON.stringify).join('\n');

const messages = parseCodexRollout(rows);
assert.equal(messages.length, 2);
assert.equal(messages[0].role, 'user');
assert.deepEqual(messages[1].parts.map((part) => part.t === 'text' ? part.text : part.name), ['Checking ten live calls.', 'Bash', 'Wait']);
assert.equal(messages[1].parts[1].input, 'poll calls');
assert.equal(messages[1].parts[1].result, '9 active');
assert.equal(messages[1].parts[2].result, 'finished');
assert.ok(!JSON.stringify(messages).includes('secret'));

const root = mkdtempSync(join(tmpdir(), 'box-codex-rollout-'));
try {
  const file = join(root, 'rollout-test.jsonl');
  const diskRows = [
    { timestamp: '2026-07-17T16:59:59Z', type: 'session_meta', payload: { id: 'thread-1', cwd: '/tmp/work', timestamp: '2026-07-17T16:59:59Z' } },
    ...rows.split('\n').map((line) => JSON.parse(line)),
    // Simulate the giant persisted context rows that made the old readFileSync path freeze.
    { type: 'world_state', payload: 'private-context-should-be-skipped-' + 'x'.repeat(3 * 1024 * 1024) },
    { timestamp: '2026-07-17T17:01:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Latest turn' } },
    { timestamp: '2026-07-17T17:01:01Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Still working.', phase: 'commentary' } },
  ];
  writeFileSync(file, diskRows.map(JSON.stringify).join('\n') + '\n');
  const page = await codexRolloutHistory(file, { maxBytes: 1024 * 1024 });
  assert.equal(page.hasMore, true);
  assert.ok(page.cursor > 0);
  assert.ok(page.liveCursor > page.cursor);
  assert.deepEqual(page.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(page.messages[0].parts[0].text, 'Latest turn');
  assert.ok(!JSON.stringify(page.messages).includes('private-context'));
  assert.deepEqual(codexRolloutMeta(file), {
    id: 'thread-1', cwd: '/tmp/work', created: '2026-07-17T16:59:59Z', source: 'native', opening: 'Monitor calls', size: page.liveCursor,
  });
  assert.deepEqual(parseCodexLiveEntry({ timestamp: 't', type: 'event_msg', payload: { type: 'agent_message', message: 'Done.', phase: 'final_answer' } }).map((e) => e.kind), ['text', 'turn_end']);
  assert.equal(codexRolloutState(file).busy, true);
  appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: 'Done.', phase: 'final_answer' } }) + '\n');
  assert.equal(codexRolloutState(file).phase, 'final_answer');
  assert.equal(codexRolloutState(file).busy, false);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('codex rollout history ok');
