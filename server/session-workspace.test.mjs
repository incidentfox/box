import assert from 'node:assert/strict';
import {
  normalizeSessionWorkspace, sessionInTeamWorkspace, sessionUsesTeamSandbox, sessionWorkspace,
} from './session-workspace.mjs';

assert.equal(normalizeSessionWorkspace('team'), 'team');
assert.equal(normalizeSessionWorkspace('personal'), 'personal');
assert.equal(normalizeSessionWorkspace('other'), '');

assert.equal(sessionWorkspace({ id: 'owner', workspace: 'team', teamSandbox: false }), 'team');
assert.equal(sessionUsesTeamSandbox({ workspace: 'team', teamSandbox: false }), false);
assert.equal(sessionWorkspace({ id: 'rose', workspace: 'personal', teamSandbox: true }), 'personal');
assert.equal(sessionUsesTeamSandbox({ workspace: 'personal', teamSandbox: true }), true);
assert.equal(sessionWorkspace({ id: 'legacy' }, { isShared: (id) => id === 'legacy' }), 'team');
assert.equal(sessionInTeamWorkspace({ id: 'legacy' }, { isShared: () => true }), true);

console.log('session-workspace tests passed');
