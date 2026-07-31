import assert from 'node:assert/strict';
import {
  CODEX_RECOVERY_DISPLAY, CODEX_RECOVERY_PROMPT, cancelQueuedMessage,
  prepareRecoveredCodexMessage, recoverPersistedQueue, restoreCanceledMessage,
} from './queue-state.mjs';

const inflight = { qid: 'active-1', text: 'Now?', agent: 'codex' };
const queued = { qid: 'next-1', text: 'Then do this', agent: 'codex' };

assert.deepEqual(recoverPersistedQueue({ queue: [queued], inflight }), [{ ...inflight, recovered: true }, queued]);
assert.deepEqual(recoverPersistedQueue({ queue: [inflight, queued], inflight }), [{ ...inflight, recovered: true }, queued]);
assert.deepEqual(recoverPersistedQueue({ queue: [queued] }), [queued]);
assert.deepEqual(recoverPersistedQueue({}), []);

const recovered = recoverPersistedQueue({ inflight })[0];
assert.equal(prepareRecoveredCodexMessage(recovered, { originalLanded: false }).text, 'Now?');
assert.deepEqual(prepareRecoveredCodexMessage(recovered, { originalLanded: true }), {
  ...recovered,
  text: CODEX_RECOVERY_PROMPT,
  displayText: CODEX_RECOVERY_DISPLAY,
  recoveredOriginalLanded: true,
});
assert.equal(prepareRecoveredCodexMessage({ ...recovered, agent: 'claude' }, { originalLanded: true }).text, 'Now?');

const cancelSource = [
  { qid: 'first', text: 'first' },
  { qid: 'middle', text: 'middle', displayText: 'Scheduled middle' },
  { qid: 'last', text: 'last' },
];
const canceled = cancelQueuedMessage(cancelSource, 'middle', { now: 1000, undoMs: 8000 });
assert.deepEqual(canceled.queue.map((message) => message.qid), ['first', 'last']);
assert.deepEqual(canceled.undo, { qid: 'middle', message: cancelSource[1], index: 1, expiresAt: 9000 });
assert.deepEqual(restoreCanceledMessage(canceled.queue, canceled.undo, { now: 8999 }).queue, cancelSource);
assert.equal(restoreCanceledMessage(canceled.queue, canceled.undo, { now: 9001 }).restored, false);
assert.equal(cancelQueuedMessage(cancelSource, 'first').undo.message.qid, 'first');
assert.equal(cancelQueuedMessage(cancelSource, 'missing').undo, null);

console.log('queue-state recovery and cancel undo ok');
