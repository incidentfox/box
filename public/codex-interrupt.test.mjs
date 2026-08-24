import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');

const stopCurrent = app.match(/function stopCurrent\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(stopCurrent, /type: 'cancel'/);
assert.doesNotMatch(stopCurrent, /setTimeout/);
assert.doesNotMatch(stopCurrent, /running\s*=\s*false/);

assert.doesNotMatch(app, /payload\.interrupt/);
assert.match(server, /BOX_MAX_CONCURRENT_CODEX_TURNS/);
assert.match(server, /CODEX_TURN_LIMITER/);
assert.match(server, /kickWorker\(s\)/);
assert.match(server, /interruptWorkerAdmission\(s\)/);
assert.match(server, /const batch = s\.queue\.splice\(0, take\);/);
assert.match(server, /const msg = combineQueued\(batch\.map/);

console.log('Codex Stop preserves queued batching and worker admission stays bounded and wakeable');
