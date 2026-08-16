import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTeamSandbox, buildUnixTeamSandbox, teamSandboxAvailable, translateRuntimeArgs } from './team-sandbox.mjs';

// This is intentionally structural: the production host test executes bwrap below.
const original = process.env.BOX_TEAM_BWRAP;
process.env.BOX_TEAM_BWRAP = '/usr/bin/bwrap';
try {
  // The test runner's cwd is real and exists; use the repository root as a safe stand-in.
  const root = process.cwd();
  if (teamSandboxAvailable()) {
    const out = buildTeamSandbox({ workspaceRoot: root, cwd: '/etc', args: ['exec', '--json', '-C', '/host-only/path'], env: { OPENAI_API_KEY: 'team-only' } });
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
    assert.equal(out.args[out.args.indexOf('-C') + 1], '/workspace');
  }

  const nested = join(root, 'server');
  const unix = buildUnixTeamSandbox({
    workspaceRoot: root,
    cwd: nested,
    user: 'box-rose',
    args: ['exec', '--json', '-C', nested, 'keep this host path unchanged: ' + nested],
  });
  assert.equal(unix.command, 'sudo');
  assert.equal(unix.args[unix.args.indexOf('-C') + 1], '/workspace/server');
  assert.equal(unix.args.at(-1), 'keep this host path unchanged: ' + nested);

  assert.deepEqual(
    translateRuntimeArgs(['resume', 'thread-id'], { runtime: 'codex', sandboxCwd: '/workspace/server' }),
    ['resume', 'thread-id'],
  );
  assert.deepEqual(
    translateRuntimeArgs(['-C', nested], { runtime: 'claude', sandboxCwd: '/workspace/server' }),
    ['-C', nested],
  );

  const helper = readFileSync(join(root, 'scripts/box-team-codex'), 'utf8');
  assert.match(helper, /--setenv HOME \/home\/team/);
  assert.match(helper, /--bind "\$runtime_home" \/home\/team/);
  assert.match(helper, /SHARED_AUTH_USERS/);
  assert.match(helper, /\.codex\/auth\.json/);
  assert.match(helper, /\.claude\/\.credentials\.json/);
  assert.match(helper, /codex:OPENAI_API_KEY\|codex:CODEX_API_KEY/);
  assert.match(helper, /claude:ANTHROPIC_API_KEY\|claude:CLAUDE_CODE_OAUTH_TOKEN\|claude:CLAUDE_OAUTH_TOKEN/);
  assert.match(helper, /--bind "\$auth_file" "\$auth_guest_file"/);
  assert.match(helper, /codex-linux-x64\/vendor\/x86_64-unknown-linux-musl\/bin\/codex/);
} finally {
  if (original === undefined) delete process.env.BOX_TEAM_BWRAP; else process.env.BOX_TEAM_BWRAP = original;
}
console.log('✅ team-sandbox.test.mjs passed');
