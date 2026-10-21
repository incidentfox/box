// Keeps Claude sessions alive across Box server restarts.
//
// On systemd hosts the keeper runs each Box server generation in its own transient
// unit with KillMode=control-group (scripts/keeper.sh), so a restart reaps every
// helper the server spawned. A `dtach` master started from the server lands in that
// same cgroup, so every deploy (`pkill -f "node server/index.mjs"`) also killed every
// running Claude session and its subagents, mid-task and without warning (2026-10-21:
// a Box PR deploy killed a session three hours into a customer build).
//
// Sessions therefore get their own transient scope, outside the server's cgroup:
// a restart detaches from them and the new server reattaches to the live socket.
// Archived sessions are still torn down explicitly (rc-engine `pkill` by socket).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SESSION_MEMORY_MAX = process.env.BOX_SESSION_MEMORY_MAX || '8G';

let systemdChecked = null;
export function systemdUserAvailable() {
  if (systemdChecked !== null) return systemdChecked;
  if (process.env.BOX_SESSION_SCOPES === '0' || process.platform !== 'linux') return (systemdChecked = false);
  const r = spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 3000 });
  return (systemdChecked = r.status === 0);
}

export function sessionScopeName(sock, now = Date.now()) {
  const base = String(sock).split('/').pop().replace(/\.dtach$/, '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 60);
  return `box-session-${base}-${now}`;
}

/** systemd-run argv that starts a detached dtach master for `command` in its own scope. */
export function detachedMasterArgv(sock, command, { now = Date.now(), memoryMax = SESSION_MEMORY_MAX } = {}) {
  return [
    '--user', '--scope', '--quiet', '--collect',
    `--unit=${sessionScopeName(sock, now)}`,
    '-p', `MemoryMax=${memoryMax}`,
    'dtach', '-n', sock, '-z', ...command,
  ];
}

/**
 * Starts the session's dtach master in its own scope and returns true once its socket
 * exists. Returns false when scopes are unavailable or the start fails, in which case
 * the caller's `dtach -A` creates the master as before.
 */
export function startDetachedSession({ sock, command, cwd, env }) {
  if (!systemdUserAvailable() || fs.existsSync(sock)) return false;
  const r = spawnSync('systemd-run', detachedMasterArgv(sock, command), {
    cwd, env, stdio: 'ignore', timeout: 15000,
  });
  if (r.status !== 0) return false;
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(sock) && Date.now() < deadline) spawnSync('sleep', ['0.1']);
  return fs.existsSync(sock);
}

// ---- rescue: move sessions already running inside the server's cgroup ------------

function readProc(pid, file) {
  try { return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8'); } catch { return ''; }
}
function cmdline(pid) { return readProc(pid, 'cmdline').split('\0').filter(Boolean); }
function childrenOf() {
  const kids = new Map();
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readProc(name, 'stat');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(Number(name));
  }
  return kids;
}
function descendants(pid, kids) {
  const out = [pid];
  for (let i = 0; i < out.length; i++) out.push(...(kids.get(out[i]) || []));
  return out;
}

/** dtach masters (the dtach whose child runs claude) still inside a Box server unit. */
export function sessionsInServerCgroup() {
  const kids = childrenOf();
  const found = [];
  for (const [pid, children] of kids) {
    if (pid <= 1) continue;
    const argv = cmdline(pid);
    if (argv[0] !== 'dtach' && !String(argv[0]).endsWith('/dtach')) continue;
    if (!/box-app-server-[^/]*\.service/.test(readProc(pid, 'cgroup'))) continue;
    if (!children.some((c) => /(^|\/)claude$/.test(cmdline(c)[0] || ''))) continue;
    found.push({ pid, sock: argv[argv.indexOf('-A') + 1] || argv[argv.indexOf('-n') + 1] || String(pid), tree: descendants(pid, kids) });
  }
  return found;
}

/** Moves each live session's whole process tree into its own delegated scope. */
export function rescueSessions({ dryRun = false } = {}) {
  const sessions = sessionsInServerCgroup();
  const results = [];
  for (const s of sessions) {
    const unit = `${sessionScopeName(s.sock)}-rescued`;
    if (dryRun) { results.push({ ...s, unit, moved: false }); continue; }
    const holder = spawnSync('bash', ['-c',
      `systemd-run --user --scope --quiet --collect -p Delegate=yes -p MemoryMax=${SESSION_MEMORY_MAX} --unit=${unit} sleep 30 >/dev/null 2>&1 & sleep 1`], { stdio: 'ignore' });
    if (holder.status !== 0) { results.push({ ...s, unit, moved: false }); continue; }
    const live = s.tree.filter((p) => fs.existsSync(`/proc/${p}`));
    const r = spawnSync('busctl', ['--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
      'org.freedesktop.systemd1.Manager', 'AttachProcessesToUnit', 'ssau', `${unit}.scope`, '/', String(live.length), ...live.map(String)],
    { encoding: 'utf8' });
    results.push({ ...s, unit, moved: r.status === 0, error: r.status === 0 ? undefined : (r.stderr || '').trim() });
  }
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const cmd = process.argv[2];
  if (cmd === 'rescue' || cmd === 'list') {
    const results = rescueSessions({ dryRun: cmd === 'list' });
    for (const r of results) console.log(`${r.moved ? 'moved' : cmd === 'list' ? 'at-risk' : 'FAILED'} pid=${r.pid} procs=${r.tree.length} ${r.sock}${r.error ? ` (${r.error})` : ''}`);
    console.log(`${results.length} session(s) ${cmd === 'list' ? 'inside the server cgroup' : 'processed'}`);
    process.exitCode = results.some((r) => cmd === 'rescue' && !r.moved) ? 1 : 0;
  } else {
    console.log('usage: node server/session-scope.mjs list|rescue');
  }
}
