// Thread voice: GPT-Live (Responses delegation) with the box tools + ask_thread_agent.
// Box tools run through /api/voice/tool; ask_thread_agent becomes a 🎙 message IN the open
// thread, answers at once, and the thread agent's final reply is spoken as commentary.
// Also covers the full-screen view (expand / minimize / Back) wiring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('./thread-voice.js', import.meta.url), 'utf8');

const byId = {};
function register(n) { if (n.id) byId[n.id] = n; for (const m of String(n.innerHTML).matchAll(/id="(\w+)"/g)) if (!byId[m[1]]) byId[m[1]] = el(m[1]); }
function el(id = '') {
  const e = {
    id, textContent: '', className: '', innerHTML: '', style: { setProperty() {} }, childNodes: [], attrs: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined) on = !this._s.has(c); if (on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    parentNode: { insertBefore(n) { register(n); } },
    appendChild(n) { this.childNodes.push(n); n.parentEl = this; return n; },
    removeChild(n) { this.childNodes = this.childNodes.filter((x) => x !== n); },
    get firstChild() { return this.childNodes[0]; },
    remove() { if (this.parentEl) this.parentEl.removeChild(this); },
    setAttribute(k, v) { this.attrs[k] = v; },
    onclick: null, scrollTop: 0, scrollHeight: 0,
  };
  return e;
}
byId.inputWrap = el('inputWrap'); byId.threadVoiceBtn = el('threadVoiceBtn');
const body = el('body'); body.appendChild = (n) => { register(n); return n; };

let engine;
function fakeEngine(opts) {
  engine = {
    opts, state: 'idle', muted: false, segments: [], commentaries: [], thoughts: [],
    async start(b) { this.body = b; this.state = 'live'; opts.onState('live'); return { vsid: 'v1', cursor: 7 }; },
    close() { this.state = 'closed'; }, setMuted(m) { this.muted = m; },
    commentary(id, text) { this.commentaries.push({ id, text }); return true; },
    thinking(id, text) { this.thoughts.push({ id, text }); return true; },
    outputLevel: () => 0, inputLevel: () => 0,
    say(role, text, startMs, endMs) { const seg = { id: `s${this.segments.length}`, role, text, startMs, endMs, final: true }; this.segments.push(seg); opts.onCaption(seg); },
    // The Responses backend calls a function; returns the string output the engine would send back.
    call(name, args) { return opts.onFunctionCall({ name, arguments: JSON.stringify(args), call_id: `c_${Math.random()}`, delegationId: 'd' }); },
  };
  return engine;
}

const sent = [];
const toasts = [];
const apiCalls = [];
const hist = { pushes: 0, backs: 0, state: { view: 'chat', id: 'sess-1' } };
const ctx = {
  console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {}, JSON, Date, Math, String, Number, Map, Set,
  cur: { key: 'k1', id: 'sess-1', agent: 'claude', title: 'Voice work', cwd: '/repo', mode: 'normal' },
  $: (id) => byId[id] || null,
  api: async (path, init) => { apiCalls.push({ path, body: init && init.body ? JSON.parse(init.body) : null }); return { ok: true, json: async () => ({ output: JSON.stringify({ events: [{ when: 'tomorrow 10am', title: 'Spectrum sync' }] }) }) }; },
  toast: (m) => toasts.push(m),
  enqueueText: (text, opts) => sent.push({ text, opts }),
  paintIcons: () => {},
  requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  navigator: {},
  location: { href: 'https://box/sessions/sess-1' },
  history: {
    get state() { return hist.state; },
    pushState(s) { hist.pushes++; hist.state = s; },
    back() { hist.backs++; },
  },
  document: { createElement: () => el(), body },
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.window.RTCPeerConnection = function () {};
// The real shared helpers from live-voice.js (runBoxTool / toolLabel), with our fake engine.
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('./live-voice.js', import.meta.url), 'utf8'), ctx);
ctx.window.LiveVoice.create = fakeEngine;
vm.runInContext(src, ctx);
const TV = ctx.ThreadVoice;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const feedText = () => byId.tvFeed.childNodes.map((n) => [n.className, ...n.classList._s].join(' ') + ':' + (n._name ? n._name.textContent : n.textContent)).join(' | ');

// ---- start: full-screen view opens, session is thread scope ----
await TV.start();
assert.equal(TV.active, true);
assert.equal(TV.expanded, true, 'opens full screen');
assert.equal(byId.tvFull.classList.contains('hidden'), false);
assert.equal(byId.tvBar.classList.contains('hidden'), true, 'bar hidden while expanded');
assert.equal(byId.tvTitle.textContent, 'Voice work');
assert.equal(hist.pushes, 1, 'expanded view owns a history entry');
assert.deepEqual({ scope: engine.body.scope, sessionId: engine.body.sessionId, agent: engine.body.agent }, { scope: 'thread', sessionId: 'sess-1', agent: 'claude' });
assert.match(engine.commentaries[0].text, /Greet Jimmy/);
assert.equal(engine.commentaries[0].id, null);
assert.equal(typeof engine.opts.onFunctionCall, 'function', 'thread voice runs backend function calls');

// ---- 1) a direct box tool (calendar) runs through /api/voice/tool with a chip ----
const calOut = await engine.call('calendar', { days: 1 });
const toolReq = apiCalls.find((c) => c.path === '/api/voice/tool');
assert.ok(toolReq, 'box tool hit /api/voice/tool');
assert.equal(toolReq.body.name, 'calendar');
assert.equal(toolReq.body.vsid, 'v1');
assert.match(calOut, /Spectrum sync/);
assert.match(feedText(), /voToolChip ok:Checking calendar…/);
assert.equal(sent.length, 0, 'a lookup does not touch the thread');

// ---- 2) ask_thread_agent → a 🎙 message in the thread; answers immediately ----
engine.say('user', 'Have the agent run the voice unit tests', 100, 900);
const out1 = JSON.parse(await engine.call('ask_thread_agent', { request: 'Run the unit tests for the voice module and tell me if they pass.' }));
assert.equal(out1.status, 'sent');
assert.equal(sent.length, 0, 'waits for Jimmy to stop talking');
await wait(1600);
assert.equal(sent.length, 1);
assert.match(sent[0].text, /^Run the unit tests for the voice module and tell me if they pass\.\n\n\(Sent by voice/);
assert.equal(sent[0].opts.displayText, '🎙 Run the unit tests for the voice module and tell me if they pass.');
assert.match(feedText(), /voToolChip:Sent to Claude Code/);

// the thread runs the turn; the final message after the last tool is what gets spoken
TV.onChatEvent({ type: 'turn_start', text: sent[0].opts.displayText });
TV.onChatEvent({ type: 'text', delta: 'Let me run them.' });
TV.onChatEvent({ type: 'tool', name: 'Bash', input: 'npm test' });
assert.match(feedText(), /Claude Code · Bash/, 'chip shows what the agent is doing');
TV.onChatEvent({ type: 'text', delta: '**All 42 tests pass.** See `server/live-voice.test.mjs` and https://example.com/x' });
TV.onChatEvent({ type: 'done' });
const reply = engine.commentaries.find((c) => /agent replied/.test(c.text));
assert.ok(reply, 'reply spoken');
assert.equal(reply.id, null, 'session-wide commentary (the backend turn is long finished)');
assert.match(reply.text, /All 42 tests pass\. See server\/live-voice\.test\.mjs and \(link\)/);
assert.ok(!/Let me run them/.test(reply.text), 'pre-tool chatter is not spoken');
assert.match(feedText(), /voToolChip ok:Claude Code · Bash/);

// ---- 3) agent asks a question mid-turn → spoken right away ----
JSON.parse(await engine.call('ask_thread_agent', { request: 'Yes, open a PR with that fix.' }));
await wait(1600);
TV.onChatEvent({ type: 'turn_start', text: '🎙 Yes, open a PR with that fix.' });
TV.onChatEvent({ type: 'tool', name: 'AskUserQuestion', input: 'Which branch should the PR target?' });
assert.ok(engine.commentaries.some((c) => /asking Jimmy a question: Which branch/.test(c.text)));
TV.onChatEvent({ type: 'done' });

// ---- 4) a typed (non-voice) turn only updates silent context ----
TV.onChatEvent({ type: 'turn_start', text: 'typed message' });
TV.onChatEvent({ type: 'text', delta: 'Typed reply here.' });
TV.onChatEvent({ type: 'done' });
assert.ok(engine.thoughts.some((t) => t.id === null && /typed message: Typed reply here/.test(t.text)));

// ---- 5) blocked send (chat live on another device) is reported, not left hanging ----
await engine.call('ask_thread_agent', { request: 'Deploy it now.' });
await wait(1600);
TV.onChatEvent({ type: 'blocked', text: 'x' });
assert.ok(engine.commentaries.some((c) => /open live on another device/.test(c.text)));

// ---- 6) INC-2443: a request cut off mid-sentence, then re-sent whole, replaces it ----
await engine.call('ask_thread_agent', { request: 'Please run the unit tests for the' });
await wait(1600);
const fragment = sent[sent.length - 1];
const out6 = JSON.parse(await engine.call('ask_thread_agent', { request: 'Please run the unit tests for the voice module and tell me if they pass' }));
assert.equal(out6.status, 'sent');
await wait(1600);
const whole = sent[sent.length - 1];
assert.notEqual(whole, fragment);
assert.equal(whole.opts.displayText, '🎙 Please run the unit tests for the voice module and tell me if they pass');
assert.match(whole.text, /cut off mid-sentence/);
const spokenBefore = engine.commentaries.length;
TV.onChatEvent({ type: 'turn_start', text: fragment.opts.displayText });
TV.onChatEvent({ type: 'text', delta: 'Tests for what?' });
TV.onChatEvent({ type: 'done' });
assert.equal(engine.commentaries.length, spokenBefore, 'the cut-off fragment reply is not spoken');
TV.onChatEvent({ type: 'turn_start', text: whole.opts.displayText });
TV.onChatEvent({ type: 'text', delta: 'All voice tests pass.' });
TV.onChatEvent({ type: 'done' });
assert.ok(engine.commentaries.some((c) => /All voice tests pass/.test(c.text)));

// ---- 6b) exact duplicate of an in-flight request is not sent twice ----
const before = sent.length;
await engine.call('ask_thread_agent', { request: 'Check the deploy logs.' });
await wait(1600);
const dup = JSON.parse(await engine.call('ask_thread_agent', { request: 'check the deploy logs.' }));
assert.equal(dup.status, 'already_sent');
await wait(400);
assert.equal(sent.length, before + 1);
TV.onChatEvent({ type: 'turn_start', text: '🎙 Check the deploy logs.' }); TV.onChatEvent({ type: 'done' });

// ---- 6c) two requests while Jimmy is still talking become one message ----
const before2 = sent.length;
engine.say('user', 'check the deploy', 20000, 21000);
await engine.call('ask_thread_agent', { request: 'Check the deploy.' });
await wait(400);
engine.say('user', 'and update the readme too', 21100, 22000);
await engine.call('ask_thread_agent', { request: 'Update the readme.' });
await wait(1800);
assert.equal(sent.length, before2 + 1);
assert.equal(sent[sent.length - 1].opts.displayText, '🎙 Check the deploy.\n\nAlso: Update the readme.');
TV.onChatEvent({ type: 'turn_start', text: sent[sent.length - 1].opts.displayText }); TV.onChatEvent({ type: 'done' });

// ---- 6d) agent busy with an earlier (typed) turn → the tool result says it's queued ----
ctx.running = true;
const q = JSON.parse(await engine.call('ask_thread_agent', { request: 'Also bump the version.' }));
assert.equal(q.status, 'queued');
assert.match(q.note, /queued/);
await wait(1600);
ctx.running = false;
TV.onChatEvent({ type: 'turn_start', text: '🎙 Also bump the version.' }); TV.onChatEvent({ type: 'done' });

// ---- 6e) empty request is an error the backend can relay ----
assert.match(await engine.call('ask_thread_agent', { request: '  ' }), /empty request/);

// ---- 7) full-screen UI: minimize → bar; Back while expanded minimizes; bar re-expands ----
TV.minimize();
assert.equal(TV.expanded, false);
assert.equal(byId.tvBar.classList.contains('hidden'), false, 'bar visible when minimized');
assert.equal(byId.tvFull.classList.contains('hidden'), true);
assert.equal(hist.backs, 1, 'minimize pops its own history entry');
assert.equal(TV.onPopState(), true, 'our own history.back() is swallowed');
assert.equal(TV.onPopState(), false, 'a real Back while minimized is the app\'s');
byId.tvExpand.onclick();
assert.equal(TV.expanded, true);
assert.equal(hist.pushes, 2);
assert.equal(TV.onPopState(), true, 'Back while expanded is handled here');
assert.equal(TV.expanded, false, '…by minimizing');
assert.equal(hist.backs, 1, 'no extra back() after a real Back');
await TV.start(); // the composer button re-opens a minimized call instead of ending it
assert.equal(TV.active, true);
assert.equal(TV.expanded, true);

// mute is shared by the bar and the full view
byId.tvFMute.onclick();
assert.equal(engine.muted, true);
assert.ok(byId.tvMute.classList.contains('active') && byId.tvFMute.classList.contains('active'));
byId.tvMute.onclick();
assert.equal(engine.muted, false);

// ---- 8) End stops the call and drops the expanded history entry ----
byId.tvFEnd.onclick();
assert.equal(TV.active, false);
assert.equal(engine.state, 'closed');
assert.equal(hist.backs, 2);
assert.equal(byId.tvFull.classList.contains('hidden'), true);
assert.equal(byId.tvBar.classList.contains('hidden'), true);

assert.ok(TV._overlap('run the unit tests for the', 'Please run the unit tests for the voice module') >= 0.99);
assert.ok(TV._overlap('check the deploy', 'update the readme') < 0.6);
console.log('thread-voice tests ok');
