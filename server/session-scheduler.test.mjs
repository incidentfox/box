import assert from 'node:assert/strict';
import {
  armTaskFinisher, clearTaskFinisherFailureCount, DEFAULT_CONTINUE_MESSAGE, dueWakeups, normalizeAutoContinue,
  noteTaskFinisherActivity, recordTaskFinisherFailure, shouldRunTaskFinisher, stopTaskFinisher,
  taskFinisherStopRequested,
} from './session-scheduler.mjs';

const now = new Date('2026-08-29T12:00:00Z');
const defaults = normalizeAutoContinue({});
assert.equal(defaults.enabled, true, 'task finisher is enabled by default');
assert.equal(defaults.armed, false, 'old idle sessions are not revived');
assert.equal(defaults.message, DEFAULT_CONTINUE_MESSAGE);
assert.equal(defaults.delayMinutes, undefined, 'there is no idle delay setting');
assert.equal(defaults.maxContinuations, undefined, 'automatic continuations are unlimited');
assert.equal(DEFAULT_CONTINUE_MESSAGE, 'This is an automated message. Continue. If done already, run the command `bash ~/stop.sh` to stop future automated continuation reminders and prevent going in a loop.');
assert.equal(taskFinisherStopRequested('/stop'), true);
assert.equal(taskFinisherStopRequested('Done.\n\n/stop'), true);
assert.equal(taskFinisherStopRequested(DEFAULT_CONTINUE_MESSAGE), false);
assert.equal(taskFinisherStopRequested('/stopping'), false);

const armed = armTaskFinisher(defaults, now);
assert.equal(armed.armed, true);
assert.equal(armed.continuationCount, 0);
assert.equal(shouldRunTaskFinisher({ policy: armed, now }).due, true, 'continuation is sent immediately');
assert.equal(shouldRunTaskFinisher({ policy: armed, now: new Date('2026-08-29T12:04:00Z'), busy: true }).due, false);

const active = noteTaskFinisherActivity({ ...armed, continuationCount: 10_000 }, new Date('2026-08-29T12:05:00Z'));
assert.equal(active.continuationCount, 10_000, 'automatic continuations have no configured cap');
assert.equal(active.lastActivityAt, Date.parse('2026-08-29T12:05:00Z'));
assert.equal(shouldRunTaskFinisher({ policy: active, now: new Date('2026-08-29T12:05:00Z') }).due, true);

const stopped = stopTaskFinisher(armed, 'complete', 'Requested result delivered', now);
assert.equal(stopped.armed, false);
assert.equal(stopped.state, 'complete');
assert.equal(stopped.reason, 'Requested result delivered');

const stoppedByCommand = stopTaskFinisher(armed, 'stopped', 'Stopped by /stop', now);
assert.equal(stoppedByCommand.enabled, true, '/stop leaves the task finisher toggle enabled');
assert.equal(stoppedByCommand.armed, false, '/stop disarms the current task');
assert.equal(armTaskFinisher(stoppedByCommand, now).armed, true, 'the next user message can re-arm it');

const disabled = stopTaskFinisher({ ...armed, enabled: false }, 'disabled', 'Disabled', now);
assert.equal(armTaskFinisher(disabled, now).armed, false, 'the next user message cannot re-arm a disabled task finisher');

const legacy = normalizeAutoContinue({ enabled: true, start: '05:00', end: '17:00', maxPerWindow: 240 });
assert.equal(legacy.armed, false, 'legacy nonstop policies remain dormant until a new task');
assert.equal(legacy.maxContinuations, undefined, 'legacy continuation limits are ignored');

const customized = normalizeAutoContinue({ message: 'A verbose old prompt' });
assert.equal(customized.message, DEFAULT_CONTINUE_MESSAGE, 'the continuation message is fixed and concise');

const wakeups = [
  { id: 'past', at: '2026-08-29T11:00:00Z' },
  { id: 'future', at: '2026-08-30T11:00:00Z' },
  { id: 'fired', at: '2026-08-29T10:00:00Z', firedAt: '2026-08-29T10:00:01Z' },
];
assert.deepEqual(dueWakeups(wakeups, now).map((wake) => wake.id), ['past']);

// failure tracking
assert.equal(normalizeAutoContinue({}).consecutiveFailureCount, 0, 'default failure count');
assert.equal(normalizeAutoContinue({}).failoverAgent, null, 'default failoverAgent');

const after1Failure = recordTaskFinisherFailure(armed, now);
assert.equal(after1Failure.armed, true, 'still armed after first error');
assert.equal(after1Failure.consecutiveFailureCount, 1, 'failure count incremented');
assert.equal(after1Failure.failoverAgent, 'claude', 'degrades to claude on first error');

const after2Failures = recordTaskFinisherFailure(after1Failure, now);
assert.equal(after2Failures.armed, false, 'stops after second error');
assert.equal(after2Failures.state, 'error', 'terminal state is error');

const cleared = clearTaskFinisherFailureCount(after1Failure);
assert.equal(cleared.consecutiveFailureCount, 0, 'failure count reset');
assert.equal(cleared.failoverAgent, null, 'failoverAgent cleared');
assert.equal(cleared.armed, true, 'remains armed after reset');

const failureOnStopped = recordTaskFinisherFailure(stopped, now);
assert.equal(failureOnStopped.armed, false, 'failure on unarmed policy leaves it unarmed');
assert.equal(failureOnStopped.consecutiveFailureCount, 0, 'count unchanged on unarmed');

console.log('session scheduler ok');
