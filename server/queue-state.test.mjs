import assert from 'node:assert/strict';
import { CODEX_RECOVERY_DISPLAY, CODEX_RECOVERY_PROMPT, prepareRecoveredCodexMessage, recoverPersistedQueue } from './queue-state.mjs';

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

console.log('queue-state recovery ok');
