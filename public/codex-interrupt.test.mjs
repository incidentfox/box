import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
const limiter = readFileSync(new URL('../server/turn-limiter.mjs', import.meta.url), 'utf8');

const stopCurrent = app.match(/function stopCurrent\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(stopCurrent, /type: 'cancel'/);
assert.doesNotMatch(stopCurrent, /setTimeout/);
assert.doesNotMatch(stopCurrent, /running\s*=\s*false/);

assert.doesNotMatch(app, /payload\.interrupt/);
assert.doesNotMatch(server, /BOX_MAX_CONCURRENT_CODEX_TURNS/);
assert.doesNotMatch(server, /CODEX_TURN_LIMITER/);
assert.match(server, /BOX_MAX_CONCURRENT_CODEX_RECOVERIES/);
assert.match(server, /CODEX_RECOVERY_LIMITER/);
assert.match(server, /kickWorker\(s\)/);
assert.match(server, /interruptWorkerAdmission\(s\)/);
const cancelCurrent = server.match(/function cancelCurrent\(extKey\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(cancelCurrent, /cancelWaitingTurnAdmission\(s\)/);
const undoQueuedCancel = server.match(/function undoQueuedCancel\(extKey, qid\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(undoQueuedCancel, /kickWorker\(s\)/);
assert.doesNotMatch(undoQueuedCancel, /runWorker\(s\)/);
assert.match(limiter, /state\._admissionQid = qid/);
assert.match(server, /const recoveryQid = s\.queue\[0\]\?\.recovered \? turnAdmissionQid\(s\) : null;/);
assert.match(server, /if \(canResetCodexActivity\(s, state\)\)/);
assert.match(server, /await acquireTurnAdmission\(s, CODEX_RECOVERY_LIMITER, recoveryQid\)/);
assert.match(server, /const take = queuedTurnBatchSize\(s\);/);
assert.match(server, /const batch = s\.queue\.splice\(0, take\);/);
assert.match(server, /const msg = combineQueued\(batch\.map/);

console.log('Codex Stop preserves batching; normal turns are unlimited and recovery stays wakeable');
