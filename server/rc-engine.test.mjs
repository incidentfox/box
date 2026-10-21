import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RCEngine, claudeOwnsSession, claudePermissionMode, claudeStartupBlockReason, parseEntry, isCompactSummaryEntry } from './rc-engine.mjs';

test('interactive setup and OAuth screens are caught before sending a prompt', () => {
  assert.equal(claudeStartupBlockReason('\x1b[2JLet\x1b[1m\'s get started\x1b[0m Choose the text style'), 'setup');
  assert.equal(claudeStartupBlockReason('\x1b[2JOAuth error: Invalid code. Press Enter to retry.'), 'sign-in');
  assert.equal(claudeStartupBlockReason('Claude Code 2.1.178 > Ask Claude anything'), null);
});

test('a fresh repaint excludes an old sign-in error from the startup check', async () => {
  const engine = new RCEngine();
  const record = {
    booted_p: Promise.resolve(), outBuf: 'OAuth error: Invalid code. Press Enter to retry.',
    pty: { resize: () => { record.outBuf += 'Claude Code 2.1.178 > Ask Claude anything'; } },
  };
  engine.sessions.set('session', record);
  const screen = await engine.captureScreen('session', { fresh: true });
  assert.equal(claudeStartupBlockReason(screen), null);
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

test('dialog controls send exact terminal keys and reject unknown controls', async () => {
  const engine = new RCEngine(); const writes = [];
  engine.sessions.set('dialog', { booted_p: Promise.resolve(), pty: { write: key => writes.push(key) } });
  for (const key of ['up', 'down', 'left', 'right', 'enter', 'escape']) {
    assert.equal(await engine.answerWaiting('dialog', { key }), true);
  }
  assert.deepEqual(writes, ['\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C', '\r', '\x1b']);
  assert.equal(await engine.answerWaiting('dialog', { key: 'toString' }), false);
  assert.equal(writes.length, 6);
});


test('watchdog ownership requires exact Claude launch flags, not remote-control or prompt mentions', () => {
  const id = 'c43e168e-c863-459e-8d05-6ecf37475d90';
  assert.ok(claudeOwnsSession(`claude --dangerously-skip-permissions --session-id ${id} task`, id));
  assert.ok(claudeOwnsSession(`/usr/bin/claude --resume=${id}`, id));
  assert.ok(claudeOwnsSession(`claude --remote-control name --resume ${id}`, id));
  for (const command of [`dtach -n /tmp/cc-test.dtach claude --session-id ${id}`, `bash -c claude --resume ${id}`, `claude --session-id another-id explain ${id}`, `claude --resume ${id}extra`]) {
    assert.equal(claudeOwnsSession(command, id), false, command);
  }
});

test('ownership classification never binds a socket by shared cwd', () => {
  const engine = new RCEngine();
  engine.localBridgeFor = (_id, opts) => { assert.equal(opts.argvOnly, true); return null; };
  engine.jsonlRecentlyTouched = () => true;
  assert.equal(engine.classifyOwner('target').kind, 'external');
});

test('a terminal that exits before boot preserves the unsent prompt', async () => {
  const engine = new RCEngine();
  engine.touch = () => {};
  const record = { exited: true, booted_p: Promise.resolve(), pty: { write: () => assert.fail('must not paste into dead terminal') } };
  await assert.rejects(engine.sendRecord(record, 'exact user prompt'), { code: 'CLAUDE_STARTUP_BLOCKED' });
});

test('claudePermissionMode: auto by default, owner opt-in, guests pinned to auto', () => {
  assert.equal(claudePermissionMode(undefined), 'auto');
  assert.equal(claudePermissionMode('bypassPermissions'), 'bypassPermissions');
  assert.equal(claudePermissionMode('manual'), 'manual');
  assert.equal(claudePermissionMode('default'), 'auto'); // not a CLI choice
  assert.equal(claudePermissionMode('bogus'), 'auto');
  assert.equal(claudePermissionMode('bypassPermissions', { guest: true }), 'auto');
});

test('claude-permission-mode.sh: env > .env > EXTRA_ENV_FILE, quotes stripped, invalid → auto', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'box-perm-'));
  const script = new URL('../harness/scripts/claude-permission-mode.sh', import.meta.url).pathname;
  const run = (env) => execFileSync('bash', [script, dir], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).trim();
  try {
    assert.equal(run({}), 'auto');                                        // no .env at all
    fs.writeFileSync(path.join(dir, '.env'), 'CLAUDE_PERMISSION_MODE="bypassPermissions"\n');
    assert.equal(run({}), 'bypassPermissions');                           // quoted .env value
    assert.equal(run({ CLAUDE_PERMISSION_MODE: 'plan' }), 'plan');        // process env wins
    const extra = path.join(dir, 'extra.env');
    fs.writeFileSync(extra, "CLAUDE_PERMISSION_MODE='acceptEdits'\n");
    fs.writeFileSync(path.join(dir, '.env'), `EXTRA_ENV_FILE=${extra}\n`);
    assert.equal(run({}), 'acceptEdits');                                 // via .env's EXTRA_ENV_FILE
    fs.writeFileSync(path.join(dir, '.env'), 'CLAUDE_PERMISSION_MODE=default\n');
    assert.equal(run({}), 'auto');                                        // invalid → auto
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a compaction summary row is a compacted marker, never a user turn', () => {
  const text = 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. ...';
  const flagged = { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, uuid: 'u1', timestamp: 't', message: { role: 'user', content: text } };
  assert.deepEqual(parseEntry(flagged), [{ kind: 'compacted', text, uuid: 'u1', ts: 't' }]);
  // Older transcripts may lack the flag; the fixed preamble still identifies the row.
  const unflagged = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
  assert.deepEqual(kinds(unflagged), ['compacted']);
  assert.equal(isCompactSummaryEntry(unflagged), true);
  // A real user message that merely mentions compaction stays a user turn.
  const real = { type: 'user', message: { role: 'user', content: 'why did the session get compacted?' } };
  assert.deepEqual(kinds(real), ['user']);
  assert.equal(isCompactSummaryEntry({ type: 'assistant', isCompactSummary: true, message: { content: [] } }), false);
});
