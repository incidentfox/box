import assert from 'node:assert/strict';
import { codexResumeProcessPids, terminateCodexThreadProcesses } from './codex-processes.mjs';

const id = '019fb186-84df-7391-85b1-ec9623692b07';
const other = '019fb72e-2c17-7bd3-a765-c75b8c57aa86';
const processes = [
  `101 node /usr/bin/codex exec resume --json ${id} Continue`,
  `102 /opt/codex-linux-x64/bin/codex exec resume --json ${id} Continue`,
  `103 /opt/codex-linux-x64/bin/codex exec resume --json ${other} Continue`,
  `104 bash -lc pgrep -f ${id}`,
  `105 node server/index.mjs resume ${id}`,
].join('\n');

assert.deepEqual(codexResumeProcessPids(processes, id), [102, 101]);
assert.deepEqual(codexResumeProcessPids(processes, 'not-a-thread'), []);

const calls = [];
assert.deepEqual(terminateCodexThreadProcesses(id, 'SIGTERM', {
  procText: processes,
  killImpl: (...args) => calls.push(args),
}), [102, 101]);
assert.deepEqual(calls, [[102, 'SIGTERM'], [101, 'SIGTERM']]);

console.log('✅ codex-processes.test.mjs passed');
