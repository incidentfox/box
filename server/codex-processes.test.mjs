import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { procLinesFor } from './proc-table.mjs';
import { shouldRunTaskFinisher } from './session-scheduler.mjs';
import { codexResumeProcessPids, codexResumeThreadActive, terminateCodexThreadProcesses } from './codex-processes.mjs';

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
assert.equal(codexResumeThreadActive(processes, id), true);
assert.equal(codexResumeThreadActive(processes, other), true);
assert.equal(codexResumeThreadActive(processes, 'not-a-thread'), false);

const calls = [];
assert.deepEqual(terminateCodexThreadProcesses(id, 'SIGTERM', {
  procText: processes,
  killImpl: (...args) => calls.push(args),
}), [102, 101]);
assert.deepEqual(calls, [[102, 'SIGTERM'], [101, 'SIGTERM']]);

// Exercise the server's admission check: a new native worker must be detected
// immediately, without a subprocess or a stale list-view cache on Linux.
const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
const checkSource = source.match(/function codexThreadProcessBusy\(id\) \{[\s\S]*?\n\}/)[0];
let snapshot = '';
let reads = 0;
let fallbacks = 0;
const check = runInNewContext(`(${checkSource})`, {
  codexResumeThreadActive,
  procTableSnapshot: () => { reads++; return snapshot; },
  procLines: (thread, text) => procLinesFor(thread, text, () => { fallbacks++; return processes; }),
});
assert.equal(check(id), false);
snapshot = processes;
assert.equal(check(id), true, 'a just-started native worker blocks admission');
snapshot = `103 codex exec resume ${other}`;
assert.equal(check(id), false, 'another chat does not block this chat');
assert.equal(reads, 3, 'each admission check reads fresh process state');
assert.equal(fallbacks, 0, 'Linux checks never spawn pgrep');
snapshot = null;
assert.equal(check(id), true, 'hosts without procfs keep the portable check');
assert.equal(fallbacks, 1);

const busySource = source.match(/function taskFinisherBusy\(id, agent, session\) \{[\s\S]*?\n\}/)[0];
let probes = 0;
const busy = runInNewContext(`(${busySource})`, {
  codexThreadProcessBusy: () => { probes++; return false; },
});
for (const state of [{ running: true }, { inflight: {} }, { queue: [{}] }, { codexGoalProc: {} }]) {
  assert.equal(busy(id, 'codex', { queue: [], ...state }), true);
}
assert.equal(probes, 0, 'known busy chats need no process scan');
assert.equal(busy(id, 'codex', { queue: [] }), false);
assert.equal(probes, 1);

// A large collection of stopped policies must not trigger per-chat process
// checks; an armed policy still performs the concurrency check before enqueue.
const records = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [String(i), {
  autoContinue: { enabled: i % 2 === 0, armed: false }, wakeups: [],
}]));
records.active = { autoContinue: { enabled: true, armed: true }, wakeups: [] };
const checked = [];
const tickSource = source.slice(source.indexOf('async function runScheduleTick('), source.indexOf('\nrequestScheduleTick();', source.indexOf('async function runScheduleTick(')));
const tick = runInNewContext(`(${tickSource})`, {
  scheduleTickRunning: false, scheduleTickAgain: false,
  loadSchedules: () => ({ sessions: records }),
  scheduledSessionAgent: () => 'codex',
  scheduleRecord: (state, thread) => state.sessions[thread],
  rt: () => ({ queue: [] }),
  dueWakeups: () => [],
  shouldRunTaskFinisher,
  taskFinisherBusy: (thread) => { checked.push(thread); return true; },
});
await tick();
assert.deepEqual(checked, ['active'], 'only armed policies check native workers');

console.log('✅ codex-processes.test.mjs passed');
