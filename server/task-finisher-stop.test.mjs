import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  clearTaskFinisherStop, ensureTaskFinisherStopScript, taskFinisherReminder,
  taskFinisherStopMarkerPath, taskFinisherStopped,
} from './task-finisher-stop.mjs';

const root = mkdtempSync(join(tmpdir(), 'box-task-finisher-'));
try {
  const home = join(root, 'home');
  const stateDir = join(home, '.cc-mobile');
  mkdirSync(home, { recursive: true });
  const sessionId = 'session-with-safe-id';

  const command = ensureTaskFinisherStopScript({ home, stateDir });
  assert.equal(command, 'bash ~/stop.sh');
  assert.equal(existsSync(join(home, 'stop.sh')), true);
  assert.match(taskFinisherReminder(sessionId, command), /^This is an automated message\. Continue\./);
  assert.match(taskFinisherReminder(sessionId, command), /bash ~\/stop\.sh 'session-with-safe-id'/);
  assert.equal(taskFinisherStopped(stateDir, sessionId), false);

  const stopped = spawnSync('bash', [join(home, 'stop.sh'), sessionId], { encoding: 'utf8' });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /Automatic continuation reminders stopped/);
  assert.equal(taskFinisherStopped(stateDir, sessionId), true);
  assert.equal(existsSync(taskFinisherStopMarkerPath(stateDir, sessionId)), true);
  clearTaskFinisherStop(stateDir, sessionId);
  assert.equal(taskFinisherStopped(stateDir, sessionId), false);

  writeFileSync(join(home, 'stop.sh'), '#!/bin/sh\necho user-owned\n');
  const fallback = ensureTaskFinisherStopScript({ home, stateDir });
  assert.equal(fallback, 'bash ~/.cc-mobile/autocontinue-bin/stop.sh');
  assert.equal(readFileSync(join(home, 'stop.sh'), 'utf8'), '#!/bin/sh\necho user-owned\n');

  const teamRuntime = join(root, 'team', '.box-runtime');
  const teamCommand = ensureTaskFinisherStopScript({
    home: teamRuntime,
    stateDir: teamRuntime,
    commandPath: '/workspace/.box-runtime/stop.sh',
    preserveExisting: false,
    shared: true,
  });
  assert.equal(teamCommand, 'bash /workspace/.box-runtime/stop.sh');
  const teamStopped = spawnSync('bash', [join(teamRuntime, 'stop.sh'), sessionId], { encoding: 'utf8' });
  assert.equal(teamStopped.status, 0, teamStopped.stderr);
  assert.equal(taskFinisherStopped(teamRuntime, sessionId), true);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('task finisher stop command ok');
