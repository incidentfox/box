// Thread voice: a GPT-Live client delegation becomes a message IN the open thread, and the
// thread agent's final reply goes back to GPT-Live as spoken commentary.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('./thread-voice.js', import.meta.url), 'utf8');

function el() {
  const e = {
    textContent: '', className: '', innerHTML: '', style: { setProperty() {} }, children: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined) on = !this._s.has(c); if (on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    parentNode: { insertBefore(n) { byId[n.id] = n; for (const m of String(n.innerHTML).matchAll(/id="(\w+)"/g)) byId[m[1]] = el(); } },
    onclick: null,
  };
  return e;
}
const byId = { inputWrap: el(), threadVoiceBtn: el() };

let engine;
function fakeEngine(opts) {
  engine = {
    opts, state: 'idle', muted: false, segments: [], commentaries: [], thoughts: [],
    async start(body) { this.body = body; this.state = 'live'; opts.onState('live'); return { vsid: 'v1' }; },
    close() { this.state = 'closed'; }, setMuted(m) { this.muted = m; },
    commentary(id, text) { this.commentaries.push({ id, text }); return true; },
    thinking(id, text) { this.thoughts.push({ id, text }); return true; },
    outputLevel: () => 0, inputLevel: () => 0,
    say(role, text, startMs, endMs) { const seg = { id: `s${this.segments.length}`, role, text, startMs, endMs, final: true }; this.segments.push(seg); opts.onCaption(seg); },
  };
  return engine;
}

const sent = [];
const toasts = [];
const ctx = {
  console, setTimeout, clearTimeout, JSON, Date, Math, String, Number,
  cur: { key: 'k1', id: 'sess-1', agent: 'claude', title: 'Voice work', cwd: '/repo', mode: 'normal' },
  $: (id) => byId[id] || null,
  api: async () => ({ ok: true, json: async () => ({}) }),
  toast: (m) => toasts.push(m),
  enqueueText: (text, opts) => sent.push({ text, opts }),
  paintIcons: () => {},
  requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  navigator: {},
  document: { createElement: () => el() },
};
ctx.window = ctx;
ctx.window.RTCPeerConnection = function () {};
ctx.window.LiveVoice = { create: fakeEngine };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const TV = ctx.ThreadVoice;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await TV.start();
assert.equal(TV.active, true);
assert.deepEqual({ scope: engine.body.scope, sessionId: engine.body.sessionId, agent: engine.body.agent }, { scope: 'thread', sessionId: 'sess-1', agent: 'claude' });
assert.match(engine.commentaries[0].text, /Greet Jimmy/); // opening greeting
assert.equal(engine.commentaries[0].id, null);

// 1) user asks for work → delegation → sent into the thread with the voice hint
engine.say('user', 'Run the unit tests for the voice module', 100, 900);
engine.opts.onDelegation({ id: 'del_1', target: 'client', offsetMs: 950 });
await wait(1100);
assert.equal(sent.length, 1);
assert.match(sent[0].text, /^Run the unit tests for the voice module\n\n\(Sent by voice/);
assert.equal(sent[0].opts.displayText, '🎙 Run the unit tests for the voice module');
assert.ok(engine.thoughts.some((t) => t.id === 'del_1' && /Sent to the thread's agent/.test(t.text)));

// 2) the thread runs the turn; final message after the last tool is what gets spoken
TV.onChatEvent({ type: 'turn_start', text: sent[0].opts.displayText });
TV.onChatEvent({ type: 'text', delta: 'Let me run them.' });
TV.onChatEvent({ type: 'tool', name: 'Bash', input: 'npm test' });
TV.onChatEvent({ type: 'text', delta: '**All 42 tests pass.** See `server/live-voice.test.mjs` and https://example.com/x' });
TV.onChatEvent({ type: 'done' });
const reply = engine.commentaries.find((c) => c.id === 'del_1');
assert.ok(reply, 'reply spoken for the delegation');
assert.match(reply.text, /All 42 tests pass\. See server\/live-voice\.test\.mjs and \(link\)/);
assert.ok(!/Let me run them/.test(reply.text), 'pre-tool chatter is not spoken');

// 3) a short answer ("yes, do it") carries the assistant line it answers
engine.say('assistant', 'Want me to open a PR with that fix?', 1000, 2000);
engine.say('user', 'yes do it', 2200, 2600);
engine.opts.onDelegation({ id: 'del_2', target: 'client', offsetMs: 2650 });
await wait(1100);
assert.equal(sent.length, 2);
assert.match(sent[1].text, /^yes do it\n\n\(Replying to the voice assistant, which had just said: "Want me to open a PR with that fix\?"\)/);

// 4) agent asks a question mid-turn → spoken right away
TV.onChatEvent({ type: 'turn_start', text: '🎙 yes do it' });
TV.onChatEvent({ type: 'tool', name: 'AskUserQuestion', input: 'Which branch should the PR target?' });
assert.ok(engine.commentaries.some((c) => c.id === 'del_2' && /asking Jimmy a question: Which branch/.test(c.text)));
TV.onChatEvent({ type: 'done' });

// 5) a typed (non-voice) turn only updates silent context
TV.onChatEvent({ type: 'turn_start', text: 'typed message' });
TV.onChatEvent({ type: 'text', delta: 'Typed reply here.' });
TV.onChatEvent({ type: 'done' });
assert.ok(engine.thoughts.some((t) => t.id === null && /typed message: Typed reply here/.test(t.text)));

// 6) blocked send (chat live on another device) is reported, not left hanging
engine.say('user', 'deploy it now please', 3000, 3500);
engine.opts.onDelegation({ id: 'del_3', target: 'client', offsetMs: 3600 });
await wait(1100);
TV.onChatEvent({ type: 'blocked', text: 'x' });
assert.ok(engine.commentaries.some((c) => c.id === 'del_3' && /open live on another device/.test(c.text)));

// 7) leaving the thread / ending stops the call
TV.stop('ended');
assert.equal(TV.active, false);
assert.equal(engine.state, 'closed');

console.log('thread-voice tests ok');
