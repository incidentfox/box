// Kernel-enforced execution envelope for team turns.  Nothing from the host user's
// home directory is mounted here: the only writable host mount is the team workspace.
import { existsSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const BWRAP = process.env.BOX_TEAM_BWRAP || '/usr/bin/bwrap';
const CODEX = '/opt/box-tools/node-global/bin/codex';

function inside(child, root) {
  const r = relative(root, child);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !r.includes(`..${sep}`));
}

export function teamSandboxAvailable() {
  return existsSync(BWRAP) && existsSync('/home/factory/.npm-global/bin/codex');
}

export function buildTeamSandbox({ workspaceRoot, cwd, args = [], env = {} } = {}) {
  if (!teamSandboxAvailable()) throw new Error('Team sandbox is unavailable on this host');
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
      '--', CODEX, ...args,
    ],
    cwd: root,
    env: {},
  };
}
