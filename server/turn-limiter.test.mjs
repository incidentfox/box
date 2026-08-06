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

console.log('turn-limiter tests passed');
