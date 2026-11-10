// GPT-Live client: the parallel-function-call gate. A backend turn may emit several calls;
// continue (response.create) only after every call answered AND the turn completed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('./live-voice.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(src, { window, crypto: globalThis.crypto, setTimeout, clearTimeout, console });
const { createCallGate } = window.LiveVoice;
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
