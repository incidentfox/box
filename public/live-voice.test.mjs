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
