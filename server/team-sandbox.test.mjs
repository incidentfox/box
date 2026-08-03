import assert from 'node:assert/strict';
import { buildTeamSandbox } from './team-sandbox.mjs';

// This is intentionally structural: the production host test executes bwrap below.
const original = process.env.BOX_TEAM_BWRAP;
process.env.BOX_TEAM_BWRAP = '/usr/bin/bwrap';
try {
  // The test runner's cwd is real and exists; use the repository root as a safe stand-in.
  const root = process.cwd();
  const out = buildTeamSandbox({ workspaceRoot: root, cwd: '/etc', args: ['exec', '--json'], env: { OPENAI_API_KEY: 'team-only' } });
  assert.equal(out.command, '/usr/bin/bwrap');
  assert.ok(out.args.includes('--clearenv'));
  assert.ok(out.args.includes('--unshare-all'));
  assert.equal(out.args[out.args.indexOf('--chdir') + 1], '/workspace');
  assert.ok(out.args.includes('/workspace'));
  const bindAt = out.args.indexOf('--bind');
  assert.equal(out.args[bindAt + 1], root);
  assert.equal(out.args[bindAt + 2], '/workspace');
  assert.ok(!out.args.includes('/home/factory/development/box-selfhost'));
  assert.equal(out.args[out.args.indexOf('OPENAI_API_KEY') + 1], 'team-only');
} finally {
  if (original === undefined) delete process.env.BOX_TEAM_BWRAP; else process.env.BOX_TEAM_BWRAP = original;
}
console.log('✅ team-sandbox.test.mjs passed');
