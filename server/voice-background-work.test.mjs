// Integration: the voice assistant's nonblocking paths, through the real tool route.
//   • quick_lookup runs a (fake) sandboxed `claude -p` in the right directory and answers inline;
//   • a slow lookup returns "running" at once and its answer is announced to the asking call only;
//   • start_agent from thread voice defaults to the thread's directory, runs in the background,
//     announces its result to that call, and is capped per call.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerVoiceAssistant } from './voice-assistant.mjs';

function makeApp() {
  const routes = new Map();
  const add = (method) => (path, ...handlers) => routes.set(`${method} ${path}`, handlers[handlers.length - 1]);
  return {
    use() {}, all() {}, set() {},
    get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'),
    async call(method, path, body = {}, query = {}) {
      const h = routes.get(`${method} ${path}`);
      let payload;
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(o) { payload = o; return this; }, send(o) { payload = o; return this; }, setHeader() {}, end() { return this; } };
      await h({ body, params: {}, query }, res);
      return payload;
    },
  };
}

const root = mkdtempSync(join(tmpdir(), 'vbg-'));
const HOME = join(root, 'home');
const STATE_DIR = join(HOME, '.cc-mobile');
const BIN = join(root, 'bin');
const CALLS = join(root, 'claude-calls.log');
const THREAD_CWD = join(HOME, 'development', 'repos', 'thread-repo');
const OTHER = join(HOME, 'development', 'repos', 'mindbill');
for (const d of [BIN, STATE_DIR, THREAD_CWD, OTHER]) mkdirSync(d, { recursive: true });

// Fake `claude`: records argv + cwd; "slow" prompts take 3s; prints the -p JSON result.
writeFileSync(join(BIN, 'claude'), `#!/usr/bin/env node
const a = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ argv: a, cwd: process.cwd() }) + '\\n');
const prompt = a[a.length - 1];
const reply = () => console.log(JSON.stringify({ type: 'result', result: 'Answer for: ' + prompt.split('\\n')[0] + ' token sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX', total_cost_usd: 0.01, num_turns: 2 }));
if (/slow/.test(prompt)) setTimeout(reply, 3000); else reply();
`);
chmodSync(join(BIN, 'claude'), 0o755);

// Fake chat runtime for start_agent: each enqueued key runs for ~2 polls, then goes idle.
const enqueued = [];
const runtime = new Map();
const ctx = {
  requireAuth: (_q, _s, next) => (typeof next === 'function' ? next() : undefined),
  cfg: (k, d) => ({ OPENAI_API_KEY: 'sk-test-not-real', VOICE_QUICK_WAIT_MS: '2000', VOICE_MAX_BACKGROUND_AGENTS: '2' }[k] ?? (d != null ? d : '')),
  HOME, STATE_DIR, PORT: 1, authToken: 'test', ownerName: 'Jimmy',
  defaultCwd: () => HOME,
  listSessions: () => ({ sessions: [], counts: {} }),
  findSessionFile: () => null, tailInfo: () => ({}),
  enqueue: (key, item) => { enqueued.push({ key, ...item }); runtime.set(key, { polls: 0 }); },
  rt: (key) => {
    if (key === 'thread-1') return { running: true, inflight: { text: 'Fix the fax router retry logic' }, queue: [{ displayText: '🎙 what is the status token ghp_ABCDEFabcdef0123456789ABCDEFabcdef01' }, { text: 'and run the tests' }], activityLabel: 'Running npm test', lastActivityAt: Date.now() - 90000, sessionId: 'thread-1', agent: 'claude' };
    const r = runtime.get(key) || { polls: 99 };
    r.polls++;
    return { running: r.polls <= 1, queue: [], sessionId: null, agent: 'claude' };
  },
  RUNNING: new Map(),
  childEnv: () => ({ ...process.env, PATH: `${BIN}:${process.env.PATH}` }), macAvailable: () => false,
  loadCodexMessages: () => [], codexHome: join(root, 'codex'), codexMessagePath: () => '', transcribe: null,
};

// The live-session route talks to OpenAI; stub only that URL.
const realFetch = globalThis.fetch;
let sentSession = null;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/v1/live/sessions')) {
    sentSession = JSON.parse(init.body).session;
    return new Response(JSON.stringify({ id: 'sess_1', transport: { type: 'webrtc', sdp: 'v=0 answer' } }), { status: 200 });
  }
  if (String(url).startsWith('http://127.0.0.1:1/')) return new Response('{}', { status: 404 });
  return realFetch(url, init);
};

const app = makeApp();
registerVoiceAssistant(app, ctx);
const tool = async (name, args, vsid) => JSON.parse((await app.call('POST', '/api/voice/tool', { name, args, vsid })).output);
const claudeCalls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const events = async () => (await app.call('GET', '/api/voice/updates', {}, { cursor: 0 })).events;
async function until(pred, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); }
  throw new Error(`timed out waiting for ${label}`);
}

try {
  // Open a thread-voice call: the server remembers which thread (and cwd) it belongs to.
  const s = await app.call('POST', '/api/voice/live/session', { scope: 'thread', sdp: 'v=0 offer', sessionId: 'thread-1', agent: 'claude', title: 'Voice work', cwd: THREAD_CWD });
  assert.ok(s.vsid, JSON.stringify(s));
  const vsid = s.vsid;
  const backendTools = sentSession.delegation.responses.tools.map((t) => t.name || t.type);
  assert.ok(backendTools.includes('quick_lookup') && backendTools.includes('start_agent') && backendTools.includes('ask_thread_agent'));
  assert.match(sentSession.delegation.responses.instructions, /call quick_lookup/);

  // 0) thread_status: instant running/queued state of THIS thread, no hand-off, secrets scrubbed
  {
    const st = await tool('thread_status', {}, vsid);
    assert.equal(st.state, 'working');
    assert.equal(st.agent, 'Claude Code');
    assert.match(st.working_on, /fax router/);
    assert.equal(st.current_step, 'Running npm test');
    assert.equal(st.queued_count, 2);
    assert.ok(!JSON.stringify(st).includes('ghp_ABCDEF'), 'queued text must be scrubbed');
    assert.ok(Array.isArray(st.recent));
    assert.equal(enqueued.length, 0, 'status never enqueues anything');
    assert.match((await tool('thread_status', {}, 'not-a-thread-call')).error, /only works during voice inside a chat thread/);
    // the Voice screen (global scope) does not get the thread-only tool
    sentSession = null;
    await app.call('POST', '/api/voice/live/session', { scope: 'global', sdp: 'v=0 offer' });
    assert.ok(!sentSession.delegation.responses.tools.some((t) => t.name === 'thread_status'));
    assert.match(sentSession.instructions, /Backend tools/);
  }

  // 1) inline quick lookup: thread directory by default, sandbox flags, answer scrubbed
  {
    const r = await tool('quick_lookup', { question: 'What did the last commit change?' }, vsid);
    assert.match(r.answer, /^Answer for: What did the last commit change\?/);
    assert.ok(!r.answer.includes('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX'), 'secrets must be scrubbed');
    assert.equal(r.project_dir, THREAD_CWD);
    const c = claudeCalls()[0];
    assert.equal(c.cwd, THREAD_CWD);
    for (const f of ['--restricted', '--no-session-persistence', '--strict-mcp-config']) assert.ok(c.argv.includes(f));
    assert.equal(c.argv[c.argv.indexOf('--permission-mode') + 1], 'dontAsk');
    // an explicit project wins over the thread default
    const r2 = await tool('quick_lookup', { question: 'Where is the fax router?', project: 'mindbill' }, vsid);
    assert.equal(r2.project_dir, OTHER);
    assert.equal(claudeCalls()[1].cwd, OTHER);
  }

  // 2) slow lookup: returns at the inline wait, then the answer is announced to THIS call only
  {
    const t0 = Date.now();
    const r = await tool('quick_lookup', { question: 'slow: summarize the whole diff' }, vsid);
    assert.equal(r.status, 'running');
    assert.ok(r.task_id);
    assert.ok(Date.now() - t0 < 2900, 'the tool call must not wait for the slow lookup');
    const ev = await until(async () => (await events()).find((e) => e.kind === 'task_done' && /slow: summarize/.test(e.title)), 6000, 'lookup announcement');
    assert.equal(ev.audible, true);
    assert.equal(ev.vsid, vsid);
    assert.match(ev.speak, /Answer to the earlier lookup/);
    assert.ok(!ev.speak.includes('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX'));
    const tasks = JSON.parse((await app.call('POST', '/api/voice/tool', { name: 'check_tasks', args: {}, vsid })).output);
    assert.ok(tasks.recent.some((x) => /lookup/.test(x)));
  }

  // 3) background agents from thread voice: thread cwd, per-call cap, announced to this call
  {
    const a = await tool('start_agent', { task: 'Pull the payer counts into a CSV', title: 'Payer counts CSV', agent: 'codex' }, vsid);
    assert.equal(a.started, true);
    assert.equal(a.project_dir, THREAD_CWD);
    assert.match(a.note, /announced in this call/);
    const b = await tool('start_agent', { task: 'Investigate the fax retry logic', title: 'Fax retry investigation' }, vsid);
    assert.equal(b.started, true);
    assert.equal(enqueued.length, 2);
    assert.ok(enqueued.every((e) => e.cwd === THREAD_CWD));
    const c = await tool('start_agent', { task: 'A third thing', title: 'Third' }, vsid);
    assert.equal(c.started, false);
    assert.match(c.error, /limit 2/);
    // a different call is not blocked by this call's cap, and an explicit project is honored
    const d = await tool('start_agent', { task: 'Other call work', title: 'Other call', project: 'mindbill' }, 'other-call');
    assert.equal(d.started, true);
    assert.equal(d.project_dir, OTHER);
    const done = await until(async () => {
      const ev = (await events()).filter((e) => e.kind === 'task_done' && /Payer counts CSV|Fax retry investigation/.test(e.title));
      return ev.length === 2 ? ev : null;
    }, 25000, 'agent completions');
    for (const e of done) { assert.equal(e.audible, true); assert.equal(e.vsid, vsid); }
    const other = await until(async () => (await events()).find((e) => e.kind === 'task_done' && e.title === 'Other call'), 25000, 'other call completion');
    assert.equal(other.vsid, 'other-call');
  }

  console.log('voice background work: ok');
} finally {
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
