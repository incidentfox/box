import assert from 'node:assert/strict';
import { assistantStopsAutoContinue, dueWakeups, insideAutoContinueWindow, normalizeAutoContinue, shouldAutoContinue } from './session-scheduler.mjs';

const policy = normalizeAutoContinue({ enabled: true, timeZone: 'America/Los_Angeles', start: '05:00', end: '17:00', days: [1, 2, 3, 4, 5], delayMinutes: 3 });
assert.equal(normalizeAutoContinue({}).timeZone, 'America/Los_Angeles');
assert.equal(insideAutoContinueWindow(policy, new Date('2026-07-29T12:01:00Z')).inside, true, '05:01 PDT is inside');
assert.equal(insideAutoContinueWindow(policy, new Date('2026-07-30T00:01:00Z')).inside, false, '17:01 PDT is outside');
assert.equal(insideAutoContinueWindow(policy, new Date('2026-08-01T16:00:00Z')).inside, false, 'Saturday is outside weekday policy');

assert.equal(shouldAutoContinue({ policy, now: new Date('2026-07-29T19:00:00Z') }).due, true);
assert.equal(shouldAutoContinue({ policy, now: new Date('2026-07-29T19:00:00Z'), busy: true }).due, false);
assert.equal(shouldAutoContinue({ policy, now: new Date('2026-07-29T19:00:00Z'), needsInput: true }).due, false);
assert.equal(shouldAutoContinue({ policy, now: new Date('2026-07-29T19:00:00Z'), goalStatus: 'paused' }).due, false);
assert.equal(shouldAutoContinue({ policy: { ...policy, lastEnqueuedAt: Date.parse('2026-07-29T18:59:00Z') }, now: new Date('2026-07-29T19:00:00Z') }).due, false);

const wakeups = [
  { id: 'past', at: '2026-07-29T11:00:00Z' },
  { id: 'future', at: '2026-07-30T11:00:00Z' },
  { id: 'fired', at: '2026-07-29T10:00:00Z', firedAt: '2026-07-29T10:00:01Z' },
];
assert.deepEqual(dueWakeups(wakeups, new Date('2026-07-29T12:00:00Z')).map((wake) => wake.id), ['past']);
assert.equal(assistantStopsAutoContinue('Blocked\nI need Jimmy input'), true);
assert.equal(assistantStopsAutoContinue('Work is complete for today.'), true);
assert.equal(assistantStopsAutoContinue('I completed the next row and will continue.'), false);

console.log('session scheduler ok');
