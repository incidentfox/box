import assert from 'node:assert/strict';
import { judgeTaskFinisher, taskFinisherTranscript } from './task-finisher.mjs';

const messages = [
  { role: 'user', parts: [{ t: 'text', text: 'Implement the feature and verify it.' }] },
  { role: 'assistant', content: [{ type: 'output_text', text: 'I implemented half. Next I will run the tests.' }] },
];
assert.match(taskFinisherTranscript(messages), /USER: Implement/);
assert.match(taskFinisherTranscript(messages), /ASSISTANT: I implemented/);

let request;
const result = await judgeTaskFinisher({
  messages, apiKey: 'test',
  fetchImpl: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ output_text: '{"action":"continue","reason":"Tests remain."}' }) };
  },
});
assert.equal(result.action, 'continue');
assert.equal(request.url, 'https://api.openai.com/v1/responses');
assert.equal(request.body.model, 'gpt-5-nano');
assert.equal(request.body.store, false);
assert.equal(request.body.text.format.strict, true);

await assert.rejects(() => judgeTaskFinisher({
  messages, apiKey: 'test',
  fetchImpl: async () => ({ ok: true, json: async () => ({ output_text: 'not json' }) }),
}), /invalid JSON/);

console.log('task finisher ok');
