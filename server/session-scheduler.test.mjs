import assert from 'node:assert/strict';
import {
  armTaskFinisher, dueWakeups, normalizeAutoContinue, noteTaskFinisherActivity,
  shouldRunTaskFinisher, stopTaskFinisher,
} from './session-scheduler.mjs';

const now = new Date('2026-08-29T12:00:00Z');
const defaults = normalizeAutoContinue({});
assert.equal(defaults.enabled, true, 'task finisher is enabled by default');
assert.equal(defaults.armed, false, 'old idle sessions are not revived');
assert.equal(defaults.maxContinuations, 12);

const armed = armTaskFinisher(defaults, now);
assert.equal(armed.armed, true);
assert.equal(armed.continuationCount, 0);
assert.equal(shouldRunTaskFinisher({ policy: armed, now: new Date('2026-08-29T12:02:59Z') }).due, false);
assert.equal(shouldRunTaskFinisher({ policy: armed, now: new Date('2026-08-29T12:03:00Z') }).due, true);
assert.equal(shouldRunTaskFinisher({ policy: armed, now: new Date('2026-08-29T12:04:00Z'), busy: true }).due, false);

const active = noteTaskFinisherActivity({ ...armed, continuationCount: 2 }, new Date('2026-08-29T12:05:00Z'));
assert.equal(active.continuationCount, 2, 'automatic continuations do not reset the bound');
assert.equal(active.lastActivityAt, Date.parse('2026-08-29T12:05:00Z'));

const limited = shouldRunTaskFinisher({ policy: { ...active, maxContinuations: 2 }, now: new Date('2026-08-29T12:10:00Z') });
assert.equal(limited.terminal, 'limit_reached');

const stopped = stopTaskFinisher(armed, 'complete', 'Requested result delivered', now);
assert.equal(stopped.armed, false);
assert.equal(stopped.state, 'complete');
assert.equal(stopped.reason, 'Requested result delivered');

const legacy = normalizeAutoContinue({ enabled: true, start: '05:00', end: '17:00', maxPerWindow: 240 });
assert.equal(legacy.armed, false, 'legacy nonstop policies remain dormant until a new task');
assert.equal(legacy.maxContinuations, 50, 'legacy bound is clamped to the new safety limit');

const wakeups = [
  { id: 'past', at: '2026-08-29T11:00:00Z' },
  { id: 'future', at: '2026-08-30T11:00:00Z' },
  { id: 'fired', at: '2026-08-29T10:00:00Z', firedAt: '2026-08-29T10:00:01Z' },
];
assert.deepEqual(dueWakeups(wakeups, now).map((wake) => wake.id), ['past']);

console.log('session scheduler ok');
