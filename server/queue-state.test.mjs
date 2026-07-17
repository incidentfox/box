import assert from 'node:assert/strict';
import { recoverPersistedQueue } from './queue-state.mjs';

const inflight = { qid: 'active-1', text: 'Now?', agent: 'codex' };
const queued = { qid: 'next-1', text: 'Then do this', agent: 'codex' };

assert.deepEqual(recoverPersistedQueue({ queue: [queued], inflight }), [inflight, queued]);
assert.deepEqual(recoverPersistedQueue({ queue: [inflight, queued], inflight }), [inflight, queued]);
assert.deepEqual(recoverPersistedQueue({ queue: [queued] }), [queued]);
assert.deepEqual(recoverPersistedQueue({}), []);

console.log('queue-state recovery ok');
