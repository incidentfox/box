// Kernel-enforced execution envelope for team turns.  Nothing from the host user's
// home directory is mounted here: the only writable host mount is the team workspace.
import { existsSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const BWRAP = process.env.BOX_TEAM_BWRAP || '/usr/bin/bwrap';
const RUNTIMES = {
  codex: { host: '/home/factory/.npm-global/bin/codex', sandbox: '/opt/box-tools/node-global/bin/codex' },
  // Use the real CLI binary, not /usr/bin/claude: that path is this host's
  // account-broker wrapper and would read host account configuration before
  // reaching the sandboxed process.
  claude: { host: '/usr/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-x64/claude', sandbox: '/usr/lib/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-linux-x64/claude' },
};
function runtimeSpec(runtime = 'codex') {
  const spec = RUNTIMES[runtime];
  if (!spec) throw new Error(`Unsupported Team runtime: ${runtime}`);
  return spec;
}

function inside(child, root) {
  const r = relative(root, child);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !r.includes(`..${sep}`));
}

export function teamSandboxAvailable(runtime = 'codex') {
  return existsSync(BWRAP) && existsSync(runtimeSpec(runtime).host);
}

export function buildTeamSandbox({ workspaceRoot, cwd, args = [], env = {}, runtime = 'codex' } = {}) {
  const spec = runtimeSpec(runtime);
  if (!teamSandboxAvailable(runtime)) throw new Error('Team sandbox is unavailable on this host');
  const root = realpathSync(workspaceRoot);
  const requested = resolve(cwd || root);
  const workdir = inside(requested, root) ? requested : root;
  const rel = relative(root, workdir);
  const sandboxCwd = rel ? `/workspace/${rel}` : '/workspace';
  const cleanEnv = {
    HOME: '/workspace/.box-runtime',
    PATH: '/opt/box-tools/node-global/bin:/usr/local/bin:/usr/bin:/bin',
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    ...env,
  };
  const envArgs = Object.entries(cleanEnv).flatMap(([key, value]) => ['--setenv', key, String(value)]);
  return {
    command: BWRAP,
    args: [
      '--die-with-parent', '--new-session', '--unshare-all', '--share-net', '--clearenv',
      ...envArgs,
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
      '--ro-bind', '/home/factory/.npm-global', '/opt/box-tools/node-global',
      '--dir', '/etc', '--dir', '/etc/ssl', '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf',
      '--ro-bind', '/etc/hosts', '/etc/hosts', '--ro-bind', '/etc/ssl/certs', '/etc/ssl/certs',
      '--bind', root, '/workspace', '--dir', '/home', '--dir', '/home/team',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--chdir', sandboxCwd,
      '--', spec.sandbox, ...args,
    ],
    cwd: root,
    env: {},
  };
}

// A non-owner guest can optionally have a real Unix identity.  The root-owned helper
// constructs the same fixed Bubblewrap envelope after dropping to that account; Box
// never gets a general sudo command or a caller-controlled mount list.
export function buildUnixTeamSandbox({ workspaceRoot, cwd, args = [], env = {}, user = '', runtime = 'codex' } = {}) {
  runtimeSpec(runtime);
  if (!/^box-[a-z][a-z0-9-]{0,30}$/.test(user)) return buildTeamSandbox({ workspaceRoot, cwd, args, env, runtime });
  const root = realpathSync(workspaceRoot);
  const requested = resolve(cwd || root);
  const workdir = inside(requested, root) ? requested : root;
  const envArgs = Object.entries(env).flatMap(([key, value]) => ['--env', String(key), String(value)]);
  return {
    command: 'sudo',
    args: ['-n', '/usr/local/sbin/box-team-codex', '--runtime', runtime, '--user', user, '--workspace', root, '--cwd', workdir, ...envArgs, '--', ...args],
    cwd: root,
    env: {},
  };
}
