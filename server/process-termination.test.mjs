import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { terminateProcessWithEscalation } from './process-termination.mjs';

function child() {
  return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
}

{
  const proc = child();
  const signals = [];
  let escalate;
  const ok = terminateProcessWithEscalation(proc, {
    signalProcess: (_proc, signal) => { signals.push(signal); return true; },
    setTimer: (fn) => { escalate = fn; return { unref() {} }; },
    clearTimer() {},
  });
  assert.equal(ok, true);
  assert.deepEqual(signals, ['SIGTERM']);
  escalate();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
}

{
  const proc = child();
  const signals = [];
  let escalate;
  let cleared = false;
  terminateProcessWithEscalation(proc, {
    signalProcess: (_proc, signal) => { signals.push(signal); return true; },
    setTimer: (fn) => { escalate = fn; return { unref() {} }; },
    clearTimer: () => { cleared = true; },
  });
  proc.exitCode = 0;
  proc.emit('close');
  escalate();
  assert.equal(cleared, true);
  assert.deepEqual(signals, ['SIGTERM']);
}

{
  const proc = child();
  const signals = [];
  let escalate;
  const options = {
    signalProcess: (_proc, signal) => { signals.push(signal); return true; },
    setTimer: (fn) => { escalate = fn; return { unref() {} }; },
    clearTimer() {},
  };
  terminateProcessWithEscalation(proc, options);
  terminateProcessWithEscalation(proc, options);
  assert.deepEqual(signals, ['SIGTERM', 'SIGTERM']);
  escalate();
  assert.deepEqual(signals, ['SIGTERM', 'SIGTERM', 'SIGKILL']);
}

console.log('✅ process-termination.test.mjs passed');
