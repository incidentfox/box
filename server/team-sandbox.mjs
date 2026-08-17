// Kernel-enforced execution envelope for team turns.  Nothing from the host user's
// home directory is mounted here: the only writable host mount is the team workspace.
import { existsSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const BWRAP = process.env.BOX_TEAM_BWRAP || '/usr/bin/bwrap';
const CODEX_NATIVE = '/home/factory/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
const CODEX_NATIVE_SANDBOX = '/opt/box-tools/node-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
const RUNTIMES = {
  // Invoke the packaged native binary directly. The npm launcher tries to create
  // aliases beside itself, which is intentionally read-only inside Bubblewrap.
  codex: { host: CODEX_NATIVE, sandbox: CODEX_NATIVE_SANDBOX },
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

function serializeEnv(env = {}) {
  const chunks = [];
  for (const [key, rawValue] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid Team environment variable: ${key}`);
    const value = String(rawValue);
    if (value.includes('\0')) throw new Error(`Invalid NUL byte in Team environment variable: ${key}`);
    chunks.push(`${key}=${value}\0`);
  }
  return Buffer.from(chunks.join(''));
}

// Codex receives its working directory twice: Bubblewrap's --chdir and Codex's
// own -C/--cd argument. Translate the latter into the sandbox namespace too.
export function translateRuntimeArgs(args = [], { runtime = 'codex', sandboxCwd = '/workspace' } = {}) {
  const translated = [...args];
  if (runtime !== 'codex') return translated;
  for (let i = 0; i < translated.length - 1; i += 1) {
    if (translated[i] === '-C' || translated[i] === '--cd') {
      translated[i + 1] = sandboxCwd;
      i += 1;
    }
  }
  return translated;
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
  const sandboxArgs = translateRuntimeArgs(args, { runtime, sandboxCwd });
  const cleanEnv = {
    HOME: '/workspace/.box-runtime',
    PATH: '/opt/box-tools/node-global/bin:/usr/local/bin:/usr/bin:/bin',
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    ...env,
  };
  return {
    command: BWRAP,
    args: [
      '--die-with-parent', '--new-session', '--unshare-all', '--share-net', '--clearenv',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
      '--ro-bind', '/home/factory/.npm-global', '/opt/box-tools/node-global',
      '--dir', '/etc', '--dir', '/etc/ssl', '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf',
      '--ro-bind', '/etc/hosts', '/etc/hosts', '--ro-bind', '/etc/ssl/certs', '/etc/ssl/certs',
      '--bind', root, '/workspace', '--dir', '/home', '--dir', '/home/team', '--dir', '/run',
      '--perms', '0400', '--ro-bind-data', '0', '/run/box-team-env',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--chdir', sandboxCwd,
      '--', '/bin/bash', '-c', 'while IFS= read -r -d "" pair; do export "$pair"; done < /run/box-team-env; exec "$@"',
      'box-team-env', spec.sandbox, ...sandboxArgs,
    ],
    cwd: root,
    env: {},
    envInput: serializeEnv(cleanEnv),
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
  const rel = relative(root, workdir);
  const sandboxCwd = rel ? `/workspace/${rel}` : '/workspace';
  const sandboxArgs = translateRuntimeArgs(args, { runtime, sandboxCwd });
  return {
    command: 'sudo',
    args: ['-n', '/usr/local/sbin/box-team-codex', '--runtime', runtime, '--user', user, '--workspace', root, '--cwd', workdir, '--env-stdin', '--', ...sandboxArgs],
    cwd: root,
    env: {},
    envInput: serializeEnv(env),
  };
}
