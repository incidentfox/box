import assert from 'node:assert/strict';
import { createTurnLimiter, normalizeTurnLimit } from './turn-limiter.mjs';

assert.equal(normalizeTurnLimit('4'), 4);
assert.equal(normalizeTurnLimit('0'), 3);
assert.equal(normalizeTurnLimit('nope', 2), 2);

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

console.log('turn-limiter tests passed');
