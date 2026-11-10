import assert from 'node:assert/strict';
import {
  ASK_THREAD_AGENT_TOOL, buildLiveSession, createLiveWebrtcSession, liveBackendInstructions, liveBackendTools,
  liveGlobalInstructions, liveInputFromTurns, liveThreadInstructions, liveVoiceConfig, speakableText,
  LIVE_INPUT_MAX_TOKENS, liveContextSection,
} from './live-voice.mjs';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildJimmyContext, createJimmyContext, extractSection, readJimmyContextSources, scrubPersonal,
  JIMMY_CONTEXT_MAX_CHARS,
} from './jimmy-context.mjs';
import { redactSecrets } from './voice-assistant.mjs';

const cfgOf = (env) => (k, d = '') => (env[k] == null || env[k] === '' ? d : env[k]);

// config defaults + '' treated as unset (INC-1088 lesson)
{
  const c = liveVoiceConfig(cfgOf({ VOICE_LIVE_MODEL: '' }));
  assert.equal(c.model, 'gpt-live-1');
  assert.equal(c.voice, 'marin');
  assert.equal(c.backendModel, 'gpt-6-luna');
  assert.equal(c.ackDelayMs, undefined); // client delegation (and its ack delay) is gone
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

// prompts carry the documented delegation-policy structure. The VOICE prompts hold only
// conversational behaviour + when to delegate — no tool list (GPT-Live office hours); tools
// and their rules live in the backend instructions.
{
  const t = liveThreadInstructions({ title: 'Fix voice', agent: 'codex', cwd: '/repo', hasHistory: true, omitted: 3 });
  for (const needle of ['Backchannel policy:', 'Interruption policy:', 'Delegation policy:', 'Generate <|SpawnThinking|> when:', 'Do not generate <|SpawnThinking|> when:', 'Codex', 'Fix voice', '3 older messages omitted']) {
    assert.ok(t.includes(needle), `thread prompt missing ${needle}`);
  }
  assert.match(liveThreadInstructions({}), /brand-new chat/);
  const g = liveGlobalInstructions({ snapshot: 'Agents active right now: none.' });
  assert.ok(g.includes('Generate <|SpawnThinking|> when:') && g.includes('CURRENT CONTEXT SNAPSHOT'));
  for (const voice of [t, g]) {
    assert.ok(!voice.includes('Backend tools:'), 'no tool list in a voice prompt');
    assert.ok(!/ask_thread_agent|start_agent|send_to_session|gmail_|calendar_add|brain_save|think_hard|linear_\w+|web_search/.test(voice), 'no tool names in a voice prompt');
  }
  const b = liveBackendInstructions('- keep\n- wait_for_user: silence\n- Self-echo: drop\n- Quick facts → web_search. Big open questions → deep_research.\n- tools: a, web_search, b', 'snap');
  assert.ok(b.includes('- keep') && !b.includes('wait_for_user') && !b.includes('Self-echo') && !b.includes('deep_research'));
  assert.ok(b.includes('- tools: a, b') && b.includes('snap'));
  assert.ok(!b.includes('ask_thread_agent'), 'Voice-screen backend has no thread section');
  // thread backend: the split between direct tools and the thread's own agent
  const tb = liveBackendInstructions('- persona: start_agent for new work', 'snap', 'CTX', { thread: { title: 'Fix voice', agent: 'codex', cwd: '/repo' } });
  assert.ok(tb.includes('ask_thread_agent') && tb.includes('"Fix voice"') && tb.includes('Codex agent, working in /repo'));
  assert.match(tb, /email, calendar, the company brain, Linear tickets/);
  assert.match(tb, /Do not use start_agent, send_to_session, or delegate_ticket for this thread's own work/);
  assert.ok(tb.indexOf('- persona') < tb.indexOf('inside one chat thread'), 'thread rules come after (and override) the persona');
  assert.ok(tb.indexOf('inside one chat thread') < tb.indexOf('CTX') && tb.indexOf('CTX') < tb.indexOf('CURRENT CONTEXT SNAPSHOT'));
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
  // thread scope adds the client-handled ask_thread_agent
  const tt = liveBackendTools([{ type: 'function', name: 'calendar', parameters: {} }], { extra: [ASK_THREAD_AGENT_TOOL] });
  assert.deepEqual(tt.map((t) => t.name || t.type), ['web_search', 'calendar', 'ask_thread_agent']);
  assert.deepEqual(ASK_THREAD_AGENT_TOOL.parameters.required, ['request']);
  assert.equal(ASK_THREAD_AGENT_TOOL.type, 'function');
}

// session shape: both scopes use Responses delegation with the given tools
{
  const config = liveVoiceConfig(cfgOf({}));
  const thread = buildLiveSession({ config, instructions: 'i', input: [{ type: 'message' }], backendInstructions: 'tb', tools: [{ type: 'web_search' }, ASK_THREAD_AGENT_TOOL] });
  assert.equal(thread.delegation.type, 'responses');
  assert.equal(thread.delegation.responses.instructions, 'tb');
  assert.ok(thread.delegation.responses.tools.some((t) => t.name === 'ask_thread_agent'));
  assert.equal(thread.audio.output.voice, 'marin');
  assert.equal(thread.audio.format, undefined); // WebRTC negotiates the format
  assert.equal(thread.input.length, 1);
  const global = buildLiveSession({ config, instructions: 'i', backendInstructions: 'b', tools: [{ type: 'web_search' }] });
  assert.equal(global.delegation.type, 'responses');
  assert.equal(global.delegation.responses.model, 'gpt-6-luna');
  assert.deepEqual(global.delegation.responses.reasoning, { effort: 'low' });
  assert.equal(global.delegation.responses.parallel_tool_calls, true);
  const serial = buildLiveSession({ config: liveVoiceConfig(cfgOf({ VOICE_LIVE_PARALLEL_TOOLS: '0' })), instructions: 'i' });
  assert.equal(serial.delegation.responses.parallel_tool_calls, false);
  assert.equal(liveVoiceConfig(cfgOf({ VOICE_LIVE_PARALLEL_TOOLS: '' })).parallelTools, true);
  assert.equal(global.input, undefined);
  const noReason = buildLiveSession({ config: { ...config, backendReasoning: 'none' }, instructions: 'i' });
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

// "who Jimmy is right now" context: scrubbing drops personal/credential sentences only
{
  const s = scrubPersonal('Jimmy is founder of IncidentFox. Jimmy on H-1B, with an active RFE. Ex-Roblox.\n- Therapy sessions with Yushan on Fridays\n- AWS creds are exported\n  in the shell env.\n- Spectrum is the **anchor** customer');
  assert.ok(s.includes('Jimmy is founder of IncidentFox.') && s.includes('Ex-Roblox.'));
  assert.ok(s.includes('Spectrum is the anchor customer'));
  for (const bad of [/H-?1B/, /RFE/, /[Tt]herapy/, /Yushan/, /creds|shell env/]) assert.ok(!bad.test(s), `scrub kept ${bad}: ${s}`);
  assert.equal(extractSection('# T\n## Who is Jimmy\nhe is\n### sub\nx\n## Next\ny', 'Who is Jimmy'), 'he is\n### sub\nx');
  assert.equal(extractSection('## A\nb', 'missing'), '');
}

// block assembly: sections, newest-facts framing, cap, empty when no sources
{
  assert.equal(buildJimmyContext({}), '');
  const t = buildJimmyContext({
    now: new Date('2026-11-10T18:00:00Z'),
    userMemories: [{ name: 'job', description: 'Since 2026-10-19 Jimmy works full-time at Hippocratic AI', body: 'Startup is part-time.\nHis immigration lawyer called.' }],
    whoIs: 'Founder/CEO of IncidentFox. On H-1B with an RFE.',
    companyPriority: '- MindBill is the primary product.',
    directives: ['Jimmy 2026-11-08 — never use Parallel'],
    recentWork: ['Box voice assistant'],
    projects: [{ title: 'QME Companion', updated: '2026-10-15' }],
    meetings: [{ date: '2026-11-07', title: 'Medical billing transition setup' }],
    needs: ['Approve the demo seed'],
  });
  for (const needle of ['WHO JIMMY IS RIGHT NOW', 'November 10, 2026', 'Hippocratic AI', 'override anything older', 'Startup is part-time.', 'MindBill is the primary product', 'never use Parallel', 'Box voice assistant', 'QME Companion (updated 2026-10-15)', '2026-11-07 — Medical billing transition setup', 'Approve the demo seed']) {
    assert.ok(t.includes(needle), `context missing ${needle}`);
  }
  assert.ok(!/H-?1B|RFE|immigration|lawyer/.test(t), t);
  const big = buildJimmyContext({ recentWork: Array.from({ length: 2000 }, (_, i) => `note ${i} ` + 'z'.repeat(40)) });
  assert.ok(big.length <= JIMMY_CONTEXT_MAX_CHARS + 2 && big.endsWith('…'));
}

// sources read from disk (fixture HOME + brain) and the cached, redacted provider
{
  const root = mkdtempSync(join(tmpdir(), 'jimmy-ctx-'));
  const HOME = join(root, 'home'); const brain = join(root, 'brain');
  const mem = join(HOME, '.claude-2nd', 'projects', '-home-factory-development', 'memory');
  for (const d of [mem, join(HOME, '.claude'), join(HOME, 'development'), join(brain, 'people'), join(brain, 'projects'), join(brain, 'meetings')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(mem, 'MEMORY.md'), '# Memory index\n\n- [Jimmy full-time job](job.md) — x\n- [Spectrum price fixed](price.md) — y\n- [Box voice assistant](voice.md) — z\n- [Therapy guard](therapy.md) — t\n');
  writeFileSync(join(mem, 'job.md'), '---\nname: job\ndescription: Since 2026-10-19 Jimmy works full-time at Hippocratic AI\nmetadata:\n  type: user\n---\nJimmy started at Hippocratic AI.\n\n**Why:** his time is scarce.\n');
  writeFileSync(join(mem, 'price.md'), '---\nname: price\ndescription: Jimmy 2026-10-31 — Spectrum $3/bill cannot be raised\nmetadata:\n  type: feedback\n---\nbody\n');
  writeFileSync(join(mem, 'voice.md'), '---\nname: voice\ndescription: patient Jane Roe bill MB123 detail\nmetadata:\n  type: project\n---\nbody\n');
  writeFileSync(join(mem, 'therapy.md'), '---\nname: therapy\ndescription: emails before Yushan therapy sessions\nmetadata:\n  type: project\n---\nbody\n');
  writeFileSync(join(HOME, '.claude-2nd', 'CLAUDE.md'), '# Ctx\n## Who is Jimmy\nJimmy Wei — founder/CEO of IncidentFox. Jimmy on H-1B, with an active RFE. Ex-Roblox.\n## Other\nsk-proj-abcdefghijklmnopqrstuvwxyz0123456789\n');
  writeFileSync(join(HOME, 'development', 'CLAUDE.md'), '# Shared\n## Company and priority\n- MindBill is primary. Debug key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 here.\n## Repository routing\n- repos/mindbill\n');
  writeFileSync(join(HOME, '.claude', 'CLAUDE.md'), '# Factory box\n\nThis is Jimmy Wei\'s always-on Linux factory box. Keep this file small.\n\n## Box posture\n- x\n');
  writeFileSync(join(brain, 'people', 'jimmy-wei.md'), '---\nid: per-jimmy-wei\n---\n\n## Context\n\nPart-time on IncidentFox since 2026-10-19.\n');
  writeFileSync(join(brain, 'projects', 'a.md'), '---\ntitle: QME Companion build\nstatus: active\nupdated_at: 2026-10-15T00:00:00Z\n---\n');
  writeFileSync(join(brain, 'projects', 'b.md'), '---\ntitle: Old RCM thing\nstatus: archived\nupdated_at: 2026-11-01T00:00:00Z\n---\n');
  for (const [f, title] of [['2026-11-07--medical-billing--mtg-cb-1.md', 'Medical billing transition setup'], ['2026-10-01--older--mtg-cb-2.md', 'Older call']]) writeFileSync(join(brain, 'meetings', f), `---\ntitle: "${title}"\n---\nbody`);

  const src = readJimmyContextSources({ HOME, brainDir: brain });
  assert.equal(src.userMemories.length, 1);
  assert.match(src.userMemories[0].body, /Hippocratic AI/);
  assert.ok(!/Why/.test(src.userMemories[0].body));
  assert.deepEqual(src.directives, ['Jimmy 2026-10-31 — Spectrum $3/bill cannot be raised']);
  assert.deepEqual(src.recentWork, ['Box voice assistant']);   // titles only; therapy note excluded
  assert.deepEqual(src.projects.map((p) => p.title), ['QME Companion build']);
  assert.deepEqual(src.meetings.map((m) => m.title), ['Medical billing transition setup', 'Older call']);
  assert.equal(src.boxPosture, "This is Jimmy Wei's always-on Linux factory box.");

  let builds = 0; let clock = 1_000_000;
  const provider = createJimmyContext({
    HOME, brainDir: () => brain, ttlMs: 1000, now: () => new Date(clock),
    readNeeds: async () => { builds++; return ['Decide on the demo seed']; },
    redact: (t) => redactSecrets(t).text,
  });
  const [a, b] = await Promise.all([provider.get(), provider.get()]);
  assert.equal(a, b); assert.equal(builds, 1);
  for (const needle of ['Hippocratic AI', 'Spectrum $3/bill cannot be raised', 'QME Companion build', 'Medical billing transition setup', 'Decide on the demo seed', 'MindBill is primary', 'Linux factory box']) {
    assert.ok(a.includes(needle), `provider missing ${needle}`);
  }
  for (const bad of [/sk-proj-/, /H-?1B|RFE/, /Jane Roe|MB123/, /Yushan|[Tt]herapy/]) assert.ok(!bad.test(a), `provider leaked ${bad}`);
  assert.ok(a.length / 3.6 < 4200);
  await provider.get(); assert.equal(builds, 1);           // cached
  clock += 2000; await provider.get(); assert.equal(builds, 2); // refreshed after TTL
  rmSync(root, { recursive: true, force: true });
}

// all three GPT-Live prompts carry the context; the voice is told it is part of the Claude setup
{
  const ctx = 'WHO JIMMY IS RIGHT NOW\n- Since 2026-10-19 Jimmy works full-time at Hippocratic AI';
  assert.equal(liveContextSection(''), '');
  const t = liveThreadInstructions({ title: 'x', context: ctx });
  assert.ok(t.includes('Hippocratic AI') && /part of Jimmy's Claude setup/.test(t) && /never say you don't know who he is/.test(t));
  assert.ok(t.includes('You can answer from the context about him below'));
  assert.ok(!liveThreadInstructions({ title: 'x' }).includes("Claude setup"));
  const g = liveGlobalInstructions({ snapshot: 'snap', context: ctx });
  assert.ok(g.includes('Hippocratic AI') && g.includes('CURRENT CONTEXT SNAPSHOT') && /part of Jimmy's Claude setup/.test(g));
  const b = liveBackendInstructions('- persona', 'snap', ctx);
  assert.ok(b.includes('Hippocratic AI') && b.indexOf('Hippocratic') < b.indexOf('CURRENT CONTEXT SNAPSHOT'));
  // fits the 16K-token instructions limit with a max-size block
  const maxCtx = 'y'.repeat(JIMMY_CONTEXT_MAX_CHARS);
  assert.ok(liveGlobalInstructions({ snapshot: 'z'.repeat(4000), context: maxCtx }).length / 3.6 < 16000);
}

console.log('live-voice tests ok');
