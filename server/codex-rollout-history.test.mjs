import assert from 'node:assert/strict';
import { parseCodexRollout } from './codex-rollout-history.mjs';

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

console.log('codex rollout history ok');
