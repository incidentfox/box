import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexGeneratedImage, codexRolloutHistory, codexRolloutMeta, codexRolloutState, parseCodexLiveEntry, parseCodexRollout,
  tailCodexRollout,
} from './codex-rollout-history.mjs';

const rows = [
  { timestamp: '2026-07-17T17:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Monitor calls' } },
  { timestamp: '2026-07-17T17:00:01Z', type: 'response_item', payload: { type: 'reasoning', summary: ['secret'] } },
  { timestamp: '2026-07-17T17:00:02Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Checking ten live calls.' } },
  { timestamp: '2026-07-17T17:00:02.5Z', type: 'event_msg', payload: { type: 'image_generation_end', status: 'completed', saved_path: '/tmp/generated/concept.png', result: 'secret-base64' } },
  { timestamp: '2026-07-17T17:00:03Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.exec_command({"cmd":"poll calls","workdir":"/tmp"});' } },
  { timestamp: '2026-07-17T17:00:04Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: '9 active' } },
  { timestamp: '2026-07-17T17:00:05Z', type: 'response_item', payload: { type: 'function_call', name: 'wait', call_id: 'c2', arguments: '{"cell_id":"12"}' } },
  { timestamp: '2026-07-17T17:00:06Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'finished' }] } },
].map(JSON.stringify).join('\n');

const messages = parseCodexRollout(rows);
assert.equal(messages.length, 2);
assert.equal(messages[0].role, 'user');
assert.deepEqual(messages[1].parts.map((part) => part.t === 'text' ? part.text : part.t === 'image' ? part.alt : part.name), ['Checking ten live calls.', 'concept.png', 'Bash', 'Wait']);
assert.equal(messages[1].parts[1].path, '/tmp/generated/concept.png');
assert.equal(messages[1].parts[2].input, 'poll calls');
assert.equal(messages[1].parts[2].result, '9 active');
assert.equal(messages[1].parts[3].result, 'finished');
assert.ok(!JSON.stringify(messages).includes('secret'));

assert.deepEqual(codexGeneratedImage({ type: 'image_generation_end', status: 'completed', saved_path: '/tmp/generated/concept.webp' }), {
  path: '/tmp/generated/concept.webp', alt: 'concept.webp',
});
assert.equal(codexGeneratedImage({ type: 'image_generation_end', status: 'pending', saved_path: '/tmp/generated/concept.png' }), null);
assert.equal(codexGeneratedImage({ type: 'image_generation_end', status: 'completed', saved_path: 'relative.png' }), null);
assert.equal(codexGeneratedImage({ type: 'image_generation_end', status: 'completed', saved_path: '/tmp/generated/not-image.txt' }), null);

const responseMessage = (role, text, phase = '', timestamp = '2026-09-05T07:00:00Z') => ({
  timestamp, type: 'response_item', payload: { type: 'message', role, phase,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
});
const modernRows = [
  responseMessage('developer', 'private developer instructions'),
  responseMessage('user', '# AGENTS.md instructions for /tmp/private'),
  responseMessage('user', '<environment_context>private environment</environment_context>'),
  responseMessage('user', 'Show the Astra conversation'),
  responseMessage('assistant', 'private reasoning', 'analysis'),
  { type: 'response_item', payload: { type: 'agent_message', author: 'private agent', content: [{ type: 'input_text', text: 'private delegation' }] } },
  responseMessage('assistant', 'Checking the transcript.', 'commentary'),
  { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'modern-tool', arguments: '{"cmd":"echo verified"}' } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'modern-tool', output: 'verified' } },
  responseMessage('assistant', 'Astra messages are visible again.', 'final_answer'),
];
const modernRaw = modernRows.map(JSON.stringify).join('\n');
const modernMessages = parseCodexRollout(modernRaw);
assert.deepEqual(modernMessages.map((m) => m.role), ['user', 'assistant']);
assert.deepEqual(modernMessages[1].parts.map((p) => p.text || p.result), ['Checking the transcript.', 'verified', 'Astra messages are visible again.']);
assert.ok(!JSON.stringify(modernMessages).includes('private'));
assert.deepEqual(modernRows.flatMap((r) => parseCodexLiveEntry(r)).map((e) => e.kind), ['user', 'text', 'tool', 'tool_result', 'text', 'turn_end']);
for (const emptyFinal of [responseMessage('assistant', '', 'final_answer'),
  { type: 'event_msg', payload: { type: 'agent_message', message: '', phase: 'final_answer' } }]) {
  assert.deepEqual(parseCodexLiveEntry(emptyFinal).map((e) => e.kind), ['turn_end']);
  assert.deepEqual(parseCodexRollout(JSON.stringify(emptyFinal)), []);
}

// Legacy mirrors occur in both orders. User attachment metadata lives on the event.
const mirroredRows = [
  responseMessage('user', 'Repeat'),
  { timestamp: '2026-09-05T07:00:00.005Z', type: 'event_msg', payload: { type: 'user_message', message: 'Repeat', local_images: ['/tmp/example.png'] } },
  { timestamp: '2026-09-05T07:00:00Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Done', phase: 'final_answer' } },
  responseMessage('assistant', 'Done', 'final_answer'),
  responseMessage('user', 'Repeat', '', '2026-09-05T07:01:00Z'),
  responseMessage('assistant', 'Done', 'final_answer', '2026-09-05T07:01:01Z'),
];
const mirrored = parseCodexRollout(mirroredRows.map(JSON.stringify).join('\n'));
assert.deepEqual(mirrored.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
assert.equal(mirrored[0].parts[1].path, '/tmp/example.png');
assert.equal(mirrored[1].parts.length, 1);
const liveState = {};
assert.deepEqual(mirroredRows.flatMap((r) => parseCodexLiveEntry(r, liveState)).map((e) => e.kind), ['user', 'text', 'turn_end', 'user', 'text', 'turn_end']);

const root = mkdtempSync(join(tmpdir(), 'box-codex-rollout-'));
try {
  const modernFile = join(root, 'rollout-modern.jsonl');
  writeFileSync(modernFile, JSON.stringify({ type: 'session_meta', payload: { id: 'modern', cwd: '/tmp' } }) + '\n' + modernRaw + '\n');
  assert.deepEqual((await codexRolloutHistory(modernFile)).messages, modernMessages);
  assert.equal(codexRolloutMeta(modernFile).opening, 'Show the Astra conversation');
  assert.equal(codexRolloutState(modernFile).busy, false);
  assert.equal(codexRolloutState(modernFile).preview, 'Astra messages are visible again.');
  const modernLive = [];
  const stopModern = tailCodexRollout(modernFile, (event) => modernLive.push(event));
  try {
    appendFileSync(modernFile, JSON.stringify(responseMessage('user', 'Live Astra prompt')) + '\n');
    assert.equal(codexRolloutState(modernFile).busy, true);
    appendFileSync(modernFile, JSON.stringify(responseMessage('assistant', 'Live Astra answer', 'final_answer')) + '\n');
    appendFileSync(modernFile, JSON.stringify({ timestamp: '2026-09-05T07:00:00Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Live Astra answer', phase: 'final_answer' } }) + '\n');
    for (let i = 0; i < 50 && modernLive.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(modernLive.map((event) => event.kind), ['user', 'text', 'turn_end']);
    assert.equal(codexRolloutState(modernFile).busy, false);
  } finally { stopModern(); }
  const file = join(root, 'rollout-test.jsonl');
  const diskRows = [
    { timestamp: '2026-07-17T16:59:59Z', type: 'session_meta', payload: { id: 'thread-1', cwd: '/tmp/work', timestamp: '2026-07-17T16:59:59Z' } },
    ...rows.split('\n').map((line) => JSON.parse(line)),
    // Simulate the giant persisted context rows that made the old readFileSync path freeze.
    { type: 'world_state', payload: 'private-context-should-be-skipped-' + 'x'.repeat(10 * 1024 * 1024) },
    { timestamp: '2026-07-17T17:01:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Latest turn' } },
    { timestamp: '2026-07-17T17:01:01Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Still working.', phase: 'commentary' } },
  ];
  writeFileSync(file, diskRows.map(JSON.stringify).join('\n') + '\n');
  // The default path should inspect only a recent window, not scan the full giant
  // context row before it can show the latest turn.
  const fastPage = await codexRolloutHistory(file);
  assert.equal(fastPage.hasMore, true);
  assert.ok(fastPage.cursor > 0);
  assert.deepEqual(fastPage.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(fastPage.messages[0].parts[0].text, 'Latest turn');
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
  assert.deepEqual(parseCodexLiveEntry({ timestamp: 't', type: 'event_msg', payload: { type: 'image_generation_end', status: 'completed', saved_path: '/tmp/generated/live.png', result: 'secret-base64' } }), [
    { kind: 'image', path: '/tmp/generated/live.png', alt: 'live.png', ts: 't' },
  ]);
  assert.equal(codexRolloutState(file).busy, true);
  appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'agent_message', message: 'Done.', phase: 'final_answer' } }) + '\n');
  assert.equal(codexRolloutState(file).phase, 'final_answer');
  assert.equal(codexRolloutState(file).busy, false);

  // A bounded tail can contain only a huge non-conversation record.  That is
  // inconclusive, not evidence that an old terminal is still doing work.
  const noTurnFile = join(root, 'rollout-no-turn.jsonl');
  writeFileSync(noTurnFile, JSON.stringify({ type: 'world_state', payload: 'x'.repeat(5 * 1024 * 1024) }) + '\n');
  assert.equal(codexRolloutState(noTurnFile).busy, false);
  // Completion bookkeeping can append much later than the final answer. File mtime must
  // not turn a terminal session back into a stale "working" card.
  appendFileSync(file, JSON.stringify({ type: 'response_item', payload: { type: 'task_complete' } }) + '\n');
  utimesSync(file, new Date(), new Date(Date.now() + 10_000));
  assert.equal(codexRolloutState(file).busy, false);

  const streamed = [];
  const stop = tailCodexRollout(file, (event) => streamed.push(event));
  appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'image_generation_end', status: 'completed', saved_path: '/tmp/generated/streamed.png', result: 'secret-base64' } }) + '\n');
  appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'one live message' } }) + '\n');
  assert.equal(codexRolloutState(file).busy, true);
  for (let i = 0; i < 25 && streamed.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(streamed.filter((event) => event.kind === 'image').length, 1);
  assert.equal(streamed.find((event) => event.kind === 'image').path, '/tmp/generated/streamed.png');
  assert.equal(streamed.filter((event) => event.kind === 'user').length, 1);
  stop();
  appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'user_message', message: 'must not replay after stop' } }) + '\n');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(streamed.filter((event) => event.kind === 'user').length, 1);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('codex rollout history ok');
