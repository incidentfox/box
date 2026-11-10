import assert from 'node:assert/strict';
import {
  buildLiveSession, createLiveWebrtcSession, liveBackendInstructions, liveBackendTools,
  liveGlobalInstructions, liveInputFromTurns, liveThreadInstructions, liveVoiceConfig, speakableText,
  LIVE_INPUT_MAX_TOKENS,
} from './live-voice.mjs';

const cfgOf = (env) => (k, d = '') => (env[k] == null || env[k] === '' ? d : env[k]);

// config defaults + '' treated as unset (INC-1088 lesson)
{
  const c = liveVoiceConfig(cfgOf({ VOICE_LIVE_ACK_DELAY_MS: '' }));
  assert.equal(c.model, 'gpt-live-1');
  assert.equal(c.voice, 'marin');
  assert.equal(c.backendModel, 'gpt-6-luna');
  assert.equal(c.ackDelayMs, 600);
  assert.equal(liveVoiceConfig(cfgOf({ VOICE_LIVE_ACK_DELAY_MS: '99999', VOICE_ASSISTANT_VOICE: 'cedar' })).ackDelayMs, 5000);
  assert.equal(liveVoiceConfig(cfgOf({ VOICE_ASSISTANT_VOICE: 'cedar' })).voice, 'cedar');
  assert.equal(liveVoiceConfig(cfgOf({ VOICE_ASSISTANT_VOICE: 'cedar', VOICE_LIVE_VOICE: 'gleam' })).voice, 'gleam');
}

// history → session.input: roles, part types, newest kept, budget, head+tail truncation
{
  const turns = [];
  for (let i = 0; i < 300; i++) turns.push({ role: i % 2 ? 'assistant' : 'user', text: `turn ${i} ` + 'x'.repeat(400) });
  const { input, tokens, omitted } = liveInputFromTurns(turns);
  assert.ok(input.length > 5 && input.length <= 40);
  assert.ok(tokens <= LIVE_INPUT_MAX_TOKENS);
  assert.equal(omitted, 300 - input.length);
  assert.match(input[input.length - 1].content[0].text, /^turn 299/);
  for (const m of input) {
    assert.equal(m.type, 'message');
    assert.equal(m.content.length, 1);
    assert.equal(m.content[0].type, m.role === 'assistant' ? 'output_text' : 'input_text');
  }
  const long = liveInputFromTurns([{ role: 'assistant', text: 'HEAD' + 'y'.repeat(10000) + 'TAIL' }], { maxCharsPerTurn: 1000 });
  assert.match(long.input[0].content[0].text, /^HEAD/);
  assert.match(long.input[0].content[0].text, /TAIL$/);
  assert.ok(long.input[0].content[0].text.length < 1010);
  // redaction hook and junk filtering
  const red = liveInputFromTurns([{ role: 'user', text: 'key sk-abc' }, { role: 'tool', text: 'x' }, null, { role: 'user', text: '' }], { redact: (t) => t.replace(/sk-\w+/, '[redacted]') });
  assert.equal(red.input.length, 1);
  assert.equal(red.input[0].content[0].text, 'key [redacted]');
}

// prompts carry the documented delegation-policy structure
{
  const t = liveThreadInstructions({ title: 'Fix voice', agent: 'codex', cwd: '/repo', hasHistory: true, omitted: 3 });
  for (const needle of ['Backchannel policy:', 'Interruption policy:', 'Delegation policy:', 'Backend tools:', 'Generate <|SpawnThinking|> when:', 'Do not generate <|SpawnThinking|> when:', 'Codex', 'Fix voice', '3 older messages omitted']) {
    assert.ok(t.includes(needle), `thread prompt missing ${needle}`);
  }
  assert.match(liveThreadInstructions({}), /brand-new chat/);
  const g = liveGlobalInstructions({ snapshot: 'Agents active right now: none.' });
  assert.ok(g.includes('Generate <|SpawnThinking|> when:') && g.includes('CURRENT CONTEXT SNAPSHOT'));
  const b = liveBackendInstructions('- keep\n- wait_for_user: silence\n- Self-echo: drop\n- Quick facts → web_search. Big open questions → deep_research.\n- tools: a, web_search, b', 'snap');
  assert.ok(b.includes('- keep') && !b.includes('wait_for_user') && !b.includes('Self-echo') && !b.includes('deep_research'));
  assert.ok(b.includes('- tools: a, b') && b.includes('snap'));
}

// backend tools: drop voice-only + Parallel-backed tools, add hosted web search
{
  const tools = liveBackendTools([
    { type: 'function', name: 'wait_for_user', parameters: {} },
    { type: 'function', name: 'web_search', parameters: {} },
    { type: 'function', name: 'deep_research', parameters: {} },
    { type: 'function', name: 'list_sessions', description: 'd', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
  ]);
  assert.deepEqual(tools.map((t) => t.name || t.type), ['web_search', 'list_sessions']);
  assert.equal(tools[0].type, 'web_search');
  assert.deepEqual(tools[1], { type: 'function', name: 'list_sessions', description: 'd', parameters: { type: 'object', properties: { q: { type: 'string' } } } });
}

// session shape per scope
{
  const config = liveVoiceConfig(cfgOf({}));
  const thread = buildLiveSession({ scope: 'thread', config, instructions: 'i', input: [{ type: 'message' }] });
  assert.deepEqual(thread.delegation, { type: 'client', acknowledgement_delay_ms: 600 });
  assert.equal(thread.audio.output.voice, 'marin');
  assert.equal(thread.audio.format, undefined); // WebRTC negotiates the format
  assert.equal(thread.input.length, 1);
  const global = buildLiveSession({ scope: 'global', config, instructions: 'i', backendInstructions: 'b', tools: [{ type: 'web_search' }] });
  assert.equal(global.delegation.type, 'responses');
  assert.equal(global.delegation.responses.model, 'gpt-6-luna');
  assert.deepEqual(global.delegation.responses.reasoning, { effort: 'low' });
  assert.equal(global.delegation.responses.parallel_tool_calls, false);
  assert.equal(global.input, undefined);
  const noReason = buildLiveSession({ scope: 'global', config: { ...config, backendReasoning: 'none' }, instructions: 'i' });
  assert.equal(noReason.delegation.responses.reasoning, undefined);
}

// speakable text strips markdown/code/urls and caps length at a sentence
{
  const s = speakableText('## Done\n**Fixed** the `voice` bug. See [PR](https://github.com/x/y/pull/1).\n```js\nconst a=1\n```\n- one\n- two');
  assert.ok(!/[#*`]|https?:/.test(s), s);
  assert.match(s, /Fixed the voice bug\. See PR\./);
  assert.match(s, /code omitted/);
  const capped = speakableText('A sentence here. '.repeat(400), 300);
  assert.ok(capped.length < 360 && /rest is in the chat/.test(capped));
}

// WebRTC exchange: request shape + error mapping
{
  let seen;
  const ok = await createLiveWebrtcSession({
    apiKey: 'k', session: { model: 'gpt-live-1' }, sdp: 'v=0',
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 201, json: async () => ({ session: { id: 'live_1' }, transport: { type: 'webrtc', sdp: 'answer' } }) }; },
  });
  assert.equal(seen.url, 'https://api.openai.com/v1/live/sessions');
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(seen.init.body), { session: { model: 'gpt-live-1' }, transport: { type: 'webrtc', sdp: 'v=0' } });
  assert.equal(ok.transport.sdp, 'answer');
  await assert.rejects(
    createLiveWebrtcSession({ apiKey: 'k', session: {}, sdp: 'v=0', fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad reasoning effort' } }) }) }),
    (e) => e.status === 400 && e.retryWithoutReasoning === true && /GPT-Live session failed/.test(e.message),
  );
}

console.log('live-voice tests ok');
