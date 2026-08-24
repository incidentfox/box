import assert from 'node:assert/strict';
import { acquireTurnAdmission, cancelWaitingTurnAdmission, canResetCodexActivity, createTurnLimiter, normalizeTurnLimit, queuedTurnBatchSize, turnAdmissionQid } from './turn-limiter.mjs';

assert.equal(normalizeTurnLimit('4'), 4);
assert.equal(normalizeTurnLimit('0'), 3);
assert.equal(normalizeTurnLimit('nope', 2), 2);

// Bash messages may carry a Codex agent label, but only actual Codex turns use
// the bounded Codex worker pool.
assert.equal(turnAdmissionQid({ agent: 'codex', queue: [{ qid: 'bash', mode: 'bash', agent: 'codex' }] }), null);
assert.equal(turnAdmissionQid({ agent: 'codex', queue: [{ qid: 'codex', mode: 'chat' }] }), 'codex');
assert.equal(turnAdmissionQid({ agent: 'claude', queue: [{ qid: 'claude', mode: 'chat' }] }), null);
assert.equal(turnAdmissionQid({ agent: 'codex', queue: [] }), null);

const soloCodex = { agent: 'codex', queue: [
  { qid: 'one', mode: 'normal', agent: 'codex' },
  { qid: 'two', mode: 'normal', agent: 'codex' },
] };
assert.equal(queuedTurnBatchSize(soloCodex), 2);
assert.equal(queuedTurnBatchSize({ agent: 'codex', queue: [
  { qid: 'bash', mode: 'bash', agent: 'codex' },
  { qid: 'chat', mode: 'normal', agent: 'codex' },
] }), 1);
assert.equal(queuedTurnBatchSize({ agent: 'codex', queue: [
  { qid: 'chat', mode: 'normal', agent: 'codex' },
  { qid: 'bash', mode: 'bash', agent: 'codex' },
] }), 1);
assert.equal(queuedTurnBatchSize({ agent: 'claude', queue: [
  { qid: 'claude', mode: 'normal', agent: 'claude' },
  { qid: 'codex', mode: 'normal', agent: 'codex' },
] }), 1);
assert.equal(queuedTurnBatchSize({ queue: [] }), 0);

// A phone reconnect may inspect an idle rollout while this session is queued behind
// another Codex turn. It must not clear `running` and allow a second worker to start.
const reconnectLimiter = createTurnLimiter(1);
const heldReconnectSlot = await reconnectLimiter.acquire();
const reconnectState = { running: true, proc: null };
const reconnectAdmission = acquireTurnAdmission(reconnectState, reconnectLimiter, 'queued-on-reconnect');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(reconnectState._admissionQid, 'queued-on-reconnect');
assert.ok(reconnectState._admissionAbort);
assert.equal(canResetCodexActivity(reconnectState, { busy: false }), false);
heldReconnectSlot();
const releaseReconnectSlot = await reconnectAdmission;
assert.equal(canResetCodexActivity(reconnectState, { busy: false }), true);
releaseReconnectSlot();

const limiter = createTurnLimiter(2);
const first = await limiter.acquire();
const second = await limiter.acquire();
assert.equal(limiter.active, 2);
assert.equal(limiter.queued, 0);

const order = [];
const thirdPromise = limiter.acquire().then((release) => { order.push('third'); return release; });
const fourthPromise = limiter.acquire().then((release) => { order.push('fourth'); return release; });
await Promise.resolve();
assert.equal(limiter.active, 2);
assert.equal(limiter.queued, 2);

first();
const third = await thirdPromise;
assert.deepEqual(order, ['third']);
assert.equal(limiter.active, 2);
assert.equal(limiter.queued, 1);

third();
const fourth = await fourthPromise;
assert.deepEqual(order, ['third', 'fourth']);
assert.equal(limiter.active, 2);
assert.equal(limiter.queued, 0);

// A duplicate release must not consume another holder's slot.
first();
assert.equal(limiter.active, 2);
second();
fourth();
assert.equal(limiter.active, 0);

// A queue mutation must be able to wake a worker that is waiting for admission.
const single = createTurnLimiter(1);
const holder = await single.acquire();
const controller = new AbortController();
const canceledPromise = single.acquire({ signal: controller.signal });
assert.equal(single.queued, 1);
controller.abort();
assert.equal(await canceledPromise, null);
assert.equal(single.active, 1);
assert.equal(single.queued, 0);
holder();
assert.equal(single.active, 0);

// Canceling the head waiter must not strand the next session in the FIFO.
const heldAgain = await single.acquire();
const firstWaiterController = new AbortController();
const canceledHead = single.acquire({ signal: firstWaiterController.signal });
const survivingWaiter = single.acquire();
assert.equal(single.queued, 2);
firstWaiterController.abort();
assert.equal(await canceledHead, null);
assert.equal(single.queued, 1);
heldAgain();
const survivingRelease = await survivingWaiter;
assert.equal(single.active, 1);
assert.equal(single.queued, 0);
survivingRelease();
assert.equal(single.active, 0);

const alreadyCanceled = new AbortController();
alreadyCanceled.abort();
assert.equal(await single.acquire({ signal: alreadyCanceled.signal }), null);
assert.equal(single.active, 0);

// Cancel/voice barge-in while waiting must remove only the admitted message and wake
// the worker. The following message remains available for the next admission pass.
const admissionController = new AbortController();
const waitingState = {
  queue: [{ qid: 'waiting', text: 'cancel me' }, { qid: 'next', text: 'keep me' }],
  _admissionQid: 'waiting',
  _admissionAbort: admissionController,
};
assert.deepEqual(cancelWaitingTurnAdmission(waitingState), { qid: 'waiting', text: 'cancel me' });
assert.equal(admissionController.signal.aborted, true);
assert.deepEqual(waitingState.queue, [{ qid: 'next', text: 'keep me' }]);

const changedHeadController = new AbortController();
const changedHeadState = {
  queue: [{ qid: 'replacement', text: 'do not cancel' }],
  _admissionQid: 'old-head',
  _admissionAbort: changedHeadController,
};
assert.equal(cancelWaitingTurnAdmission(changedHeadState), null);
assert.equal(changedHeadController.signal.aborted, true);
assert.deepEqual(changedHeadState.queue, [{ qid: 'replacement', text: 'do not cancel' }]);

console.log('turn-limiter tests passed');
