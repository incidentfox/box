// GPT-Live client: the parallel-function-call gate. A backend turn may emit several calls;
// continue (response.create) only after every call answered AND the turn completed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('./live-voice.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(src, { window, crypto: globalThis.crypto, setTimeout, clearTimeout, console });
const { createCallGate, toolOutcome, toolDoneLabel } = window.LiveVoice;
assert.equal(typeof createCallGate, 'function');

function harness() {
  const continued = [];
  const timers = [];
  const gate = createCallGate({
    onContinue: (id) => continued.push(id),
    fallbackMs: 3000,
    setTimer: (f) => { const t = { f, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
  });
  const fire = () => { for (const t of timers.splice(0)) if (!t.cleared) t.f(); };
  return { gate, continued, fire };
}

// Two parallel calls; the fast one finishes before the second even starts → no early continue.
{
  const { gate, continued } = harness();
  gate.callStarted('d1');
  gate.callFinished('d1');          // first done; turn not completed yet
  assert.deepEqual(continued, []);
  gate.callStarted('d1');           // second call item arrives
  gate.turnDone('d1');              // backend turn completed
  assert.deepEqual(continued, []);  // still waiting on the second call
  gate.callFinished('d1');
  assert.deepEqual(continued, ['d1']);
  assert.equal(gate.pending('d1'), 0);
}

// Single call where the turn completes before the call returns → continue once, after it.
{
  const { gate, continued } = harness();
  gate.callStarted('d2');
  gate.turnDone('d2');
  assert.deepEqual(continued, []);
  gate.callFinished('d2');
  assert.deepEqual(continued, ['d2']);
  // A later text-only turn's completion is a no-op (no entry).
  gate.turnDone('d2');
  assert.deepEqual(continued, ['d2']);
}

// Terminal event never arrives → fallback timer continues anyway (no wedge), exactly once.
{
  const { gate, continued, fire } = harness();
  gate.callStarted('d3');
  gate.callFinished('d3');
  assert.deepEqual(continued, []);
  fire();
  assert.deepEqual(continued, ['d3']);
  gate.turnDone('d3');
  assert.deepEqual(continued, ['d3']);
}

// A new call arriving cancels the pending fallback.
{
  const { gate, continued, fire } = harness();
  gate.callStarted('d4');
  gate.callFinished('d4');
  gate.callStarted('d4');
  fire();                           // the first fallback was cleared
  assert.deepEqual(continued, []);
  gate.callFinished('d4');
  gate.turnDone('d4');
  assert.deepEqual(continued, ['d4']);
}

console.log('live-voice call gate: ok');

// Tool outcomes: a tool that failed INSIDE its result must not show green (the calendar
// tool reports each account separately — one revoked token used to look like success).
{
  const o = (x) => JSON.parse(JSON.stringify(toolOutcome(typeof x === 'string' ? x : JSON.stringify(x)))); // vm realm → plain
  assert.deepEqual(o({ error: 'nope' }), { outcome: 'fail', failedParts: [] });
  assert.deepEqual(o({ personal: { error: 'Token refresh failed' }, work: 'Fri 10:00 Spectrum sync' }), { outcome: 'warn', failedParts: ['personal'] });
  assert.deepEqual(o({ personal: { error: 'x' }, work: { error: 'y' } }), { outcome: 'fail', failedParts: ['personal', 'work'] });
  // the pre-fix server shape: stderr returned as if it were the events
  assert.equal(o({ personal: 'Token refresh failed: {"error":"invalid_grant"}', work: 'Fri 10:00' }).outcome, 'warn');
  assert.equal(o({ query: 'error logs', results: [] }).outcome, 'ok', 'a field that merely mentions "error" is fine');
  assert.equal(o({ saved: true, entry: 'x' }).outcome, 'ok');
  assert.equal(o('plain text output').outcome, 'ok');
  assert.equal(o({ events: [{ title: 'error budget review' }] }).outcome, 'ok');
  assert.equal(toolDoneLabel('calendar'), 'Checked calendar');
  assert.equal(toolDoneLabel('no_such_tool'), 'no_such_tool');
}
// runBoxTool carries the outcome through.
{
  const fakeApi = (out) => async () => ({ json: async () => ({ output: out }) });
  const r = await window.LiveVoice.runBoxTool(fakeApi(JSON.stringify({ personal: { error: 'x' }, work: 'ok' })), { name: 'calendar', args: '{}' });
  assert.equal(r.outcome, 'warn'); assert.equal(r.failed, false); assert.deepEqual([...r.failedParts], ['personal']);
  const f = await window.LiveVoice.runBoxTool(async () => { throw new Error('offline'); }, { name: 'calendar', args: '{}' });
  assert.equal(f.outcome, 'fail'); assert.equal(f.failed, true);
}
console.log('live-voice tool outcomes: ok');

// ---- background / screen-off lifecycle (iOS web policy: pause on hide, resume on return) ----
{
  const LV = window.LiveVoice;
  // drop classification
  assert.equal(LV.lostReason({ hidden: true }), 'backgrounded');
  assert.equal(LV.lostReason({ hidden: false, hiddenAt: 10_000, now: 12_000 }), 'backgrounded'); // hidden 2s ago
  assert.equal(LV.lostReason({ hidden: false, hiddenAt: 10_000, now: 20_000 }), 'connection_lost');
  assert.equal(LV.lostReason({}), 'connection_lost');
  // what the caller does
  assert.equal(LV.closeAction({ reason: 'backgrounded', reconnects: 99, maxReconnects: 3 }), 'pause'); // no budget used
  assert.equal(LV.closeAction({ reason: 'backgrounded', stopping: true }), 'end');
  assert.equal(LV.closeAction({ reason: 'connection_lost', reconnects: 2, maxReconnects: 3 }), 'reconnect');
  assert.equal(LV.closeAction({ reason: 'connection_lost', reconnects: 3, maxReconnects: 3 }), 'end');
  assert.equal(LV.closeAction({ reason: 'expired', reconnects: 0 }), 'reconnect');
  assert.equal(LV.closeAction({ reason: 'content' }), 'end');
  assert.equal(LV.closeAction({ reason: 'start_failed' }), 'end');
  // audio session category
  const nav = { audioSession: { type: 'auto' } };
  assert.equal(LV.setAudioSession(nav, 'play-and-record'), true);
  assert.equal(nav.audioSession.type, 'play-and-record');
  assert.equal(LV.setAudioSession({}, 'play-and-record'), false);
  assert.equal(LV.setAudioSession(null, 'auto'), false);
  // iPhone home-screen detection
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.5 Mobile/15E148';
  assert.equal(LV.isIosStandalone({ userAgent: iphone, standalone: true }, {}), true);
  assert.equal(LV.isIosStandalone({ userAgent: iphone }, { matchMedia: () => ({ matches: true }) }), true);
  assert.equal(LV.isIosStandalone({ userAgent: iphone }, { matchMedia: () => ({ matches: false }) }), false); // Safari tab
  assert.equal(LV.isIosStandalone({ userAgent: 'Mozilla/5.0 (Linux; Android 14)', standalone: true }, {}), false);
  assert.match(LV.IOS_BACKGROUND_NOTICE, /pauses voice/);
}
// whenVisible: fires once on return, cancel works, immediate when already visible
function fakeDoc(state) {
  const l = new Map();
  return {
    visibilityState: state,
    addEventListener: (t, f) => { (l.get(t) || l.set(t, new Set()).get(t)).add(f); },
    removeEventListener: (t, f) => { l.get(t) && l.get(t).delete(f); },
    fire(t) { for (const f of [...(l.get(t) || [])]) f(); },
    count: (t) => (l.get(t) ? l.get(t).size : 0),
    defaultView: { addEventListener() {}, removeEventListener() {} },
  };
}
{
  const LV = window.LiveVoice;
  const d = fakeDoc('hidden');
  let n = 0;
  LV.whenVisible(d, () => n++);
  d.fire('visibilitychange'); assert.equal(n, 0); // still hidden
  d.visibilityState = 'visible'; d.fire('visibilitychange'); d.fire('visibilitychange');
  assert.equal(n, 1); assert.equal(d.count('visibilitychange'), 0);
  const d2 = fakeDoc('hidden'); let m = 0;
  const cancel = LV.whenVisible(d2, () => m++); cancel();
  d2.visibilityState = 'visible'; d2.fire('visibilitychange'); assert.equal(m, 0);
  let k = 0; LV.whenVisible(fakeDoc('visible'), () => k++); await Promise.resolve(); assert.equal(k, 1);
}
// Engine: audio session set for the call and restored after; a drop while hidden closes as
// 'backgrounded'; an ended mic is re-acquired and swapped into the same sender on return.
{
  const doc = fakeDoc('visible');
  const nav = { audioSession: { type: 'auto' }, mediaSession: { metadata: null, handlers: {}, setActionHandler(a, f) { this.handlers[a] = f; }, micActive: null, setMicrophoneActive(v) { this.micActive = v; } } };
  let gum = 0;
  const mkTrack = () => ({ enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; } });
  const mkStream = () => { const t = mkTrack(); return { getAudioTracks: () => [t], getTracks: () => [t] }; };
  const replaced = [];
  let dcRef = null;
  class FakePC {
    constructor() { this.l = {}; this.localDescription = { sdp: 'offer' }; this.iceGatheringState = 'complete'; }
    addEventListener(t, f) { this.l[t] = f; } removeEventListener() {}
    addTrack() { return { replaceTrack: async (t) => { replaced.push(t); } }; }
    createDataChannel() {
      const l = {};
      dcRef = { readyState: 'open', sent: [], addEventListener: (t, f) => { l[t] = f; }, send(x) { this.sent.push(JSON.parse(x)); }, close() { this.readyState = 'closed'; }, fire: (t, e) => l[t] && l[t](e) };
      return dcRef;
    }
    async createOffer() { return {}; } async setLocalDescription() {} async setRemoteDescription() {} close() {}
  }
  const ctx = {
    window: {}, crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval, console,
    document: doc, navigator: { ...nav, mediaDevices: { getUserMedia: async () => { gum++; return mkStream(); } } },
    RTCPeerConnection: FakePC, Audio: class { setAttribute() {} play() { return Promise.resolve(); } }, MediaStream: class {},
    MediaMetadata: class { constructor(m) { Object.assign(this, m); } },
  };
  ctx.navigator.audioSession = nav.audioSession; ctx.navigator.mediaSession = nav.mediaSession;
  vm.runInNewContext(src, ctx);
  const closed = [];
  let toggled = 0;
  const eng = ctx.window.LiveVoice.create({
    api: async () => ({ ok: true, json: async () => ({ transport: { sdp: 'answer' }, vsid: 'v1' }) }),
    onClosed: (c) => closed.push(c.reason), onMuteToggle: () => toggled++,
  });
  await eng.start({ scope: 'thread' });
  assert.equal(ctx.navigator.audioSession.type, 'play-and-record');
  assert.equal(ctx.navigator.mediaSession.metadata.title, 'Box voice');
  ctx.navigator.mediaSession.handlers.togglemicrophone(); assert.equal(toggled, 1);
  dcRef.fire('message', { data: JSON.stringify({ type: 'session.started' }) });
  assert.equal(eng.state, 'live');
  // Page hidden; the mic track is still live, so a recovery attempt is a no-op.
  doc.visibilityState = 'hidden'; doc.fire('visibilitychange');
  assert.equal(await eng.recoverMicIfEnded(), false);
  assert.equal(gum, 1);
  closed.length = 0;
  // Mute state is mirrored to the lock-screen mic indicator.
  eng.setMuted(true); assert.equal(ctx.navigator.mediaSession.micActive, false);
  eng.setMuted(false);
  assert.equal(ctx.navigator.mediaSession.micActive, true);
  // A drop while hidden → 'backgrounded'
  dcRef.fire('close');
  assert.deepEqual(closed, ['backgrounded']);
  assert.equal(ctx.navigator.audioSession.type, 'auto');
  assert.equal(ctx.navigator.mediaSession.handlers.togglemicrophone, null);
  assert.equal(doc.count('visibilitychange'), 0, 'engine removed its visibility listener');
}
// Engine: mic recovery via replaceTrack when the track ended but the session is alive.
{
  const doc = fakeDoc('visible');
  let gum = 0; const streams = [];
  const mkStream = () => { const t = { enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; } }; const s = { t, getAudioTracks: () => [t], getTracks: () => [t] }; streams.push(s); return s; };
  const replaced = []; let dcRef = null;
  class FakePC {
    constructor() { this.localDescription = { sdp: 'o' }; this.iceGatheringState = 'complete'; }
    addEventListener() {} removeEventListener() {}
    addTrack() { return { replaceTrack: async (t) => { replaced.push(t); } }; }
    createDataChannel() { const l = {}; dcRef = { readyState: 'open', addEventListener: (t, f) => { l[t] = f; }, send() {}, close() {}, fire: (t, e) => l[t] && l[t](e) }; return dcRef; }
    async createOffer() { return {}; } async setLocalDescription() {} async setRemoteDescription() {} close() {}
  }
  const ctx = { window: {}, crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval, console, document: doc,
    navigator: { mediaDevices: { getUserMedia: async () => { gum++; return mkStream(); } } }, RTCPeerConnection: FakePC,
    Audio: class { setAttribute() {} play() { return Promise.resolve(); } }, MediaStream: class {} };
  vm.runInNewContext(src, ctx);
  const events = [];
  const eng = ctx.window.LiveVoice.create({ api: async () => ({ ok: true, json: async () => ({ transport: { sdp: 'a' } }) }), onEvent: (e) => events.push(e.type) });
  await eng.start({});
  dcRef.fire('message', { data: JSON.stringify({ type: 'session.started' }) });
  doc.visibilityState = 'hidden'; doc.fire('visibilitychange');
  streams[0].t.readyState = 'ended'; // iOS ended capture while hidden
  doc.visibilityState = 'visible'; doc.fire('visibilitychange');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(gum, 2, 'mic re-acquired once');
  assert.equal(replaced.length, 1); assert.equal(replaced[0], streams[1].t, 'new track swapped into the same sender');
  assert.ok(events.includes('client.page_hidden') && events.includes('client.page_visible') && events.includes('client.mic_recovered'));
  assert.equal(eng.state, 'live', 'no new session needed');
  eng.close();
}
console.log('live-voice background lifecycle: ok');
