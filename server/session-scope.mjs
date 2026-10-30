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
//
// OOMPolicy=continue is load-bearing. A scope's default OOMPolicy is `stop`: when the
// kernel OOM-kills ANY process in it (an agent's `next build`, Playwright, a Remotion
// render hitting the per-session MemoryMax), systemd then stops the whole scope and
// kills Claude itself plus every background subagent. 2026-10-21..30 this ended 14
// sessions (e.g. 6e955a5d twice on 10-30, each time a node build child at ~3G RSS).
// With `continue` only the offending process dies; Claude sees the failed tool call.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SESSION_MEMORY_MAX = process.env.BOX_SESSION_MEMORY_MAX || '8G';
const SESSION_OOM_POLICY = 'continue';
const SCOPE_PROPS = (memoryMax = SESSION_MEMORY_MAX) => ['-p', `MemoryMax=${memoryMax}`, '-p', `OOMPolicy=${SESSION_OOM_POLICY}`];

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
    ...SCOPE_PROPS(memoryMax),
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
function readCgroupProcs(cgroupLine) {
  const rel = String(cgroupLine).split('\n')[0].replace(/^0::/, '').trim();
  try { return fs.readFileSync(`/sys/fs/cgroup${rel}/cgroup.procs`, 'utf8').split('\n').filter(Boolean).map(Number); } catch { return []; }
}
function descendants(pid, kids) {
  const out = [pid];
  for (let i = 0; i < out.length; i++) out.push(...(kids.get(out[i]) || []));
  return out;
}

// OOMPolicy cannot be changed on a live scope, so a session scope created before
// OOMPolicy=continue (or by an older server) is migrated into a fresh one instead.
const scopePolicyCache = new Map();
function scopeOomPolicy(unit) {
  if (scopePolicyCache.has(unit)) return scopePolicyCache.get(unit);
  const r = spawnSync('systemctl', ['--user', 'show', '-p', 'OOMPolicy', '--value', unit], { encoding: 'utf8', timeout: 3000 });
  const policy = r.status === 0 ? r.stdout.trim() : '';
  if (policy) scopePolicyCache.set(unit, policy);
  return policy;
}

/** Why a dtach master's cgroup is unsafe for a long-running session, or null if it is fine. */
export function unsafeSessionCgroup(cgroup, policyOf = scopeOomPolicy) {
  if (/box-app-server-[^/]*\.service/.test(cgroup)) return 'server-cgroup';
  const m = cgroup.match(/(box-session-[^/\s]*\.scope)/);
  if (m && policyOf(m[1]) === 'stop') return 'oom-stop-scope';
  return null;
}

/** dtach masters (the dtach whose child runs claude) still inside a Box server unit or a legacy OOMPolicy=stop scope. */
export function sessionsInServerCgroup() {
  const kids = childrenOf();
  const found = [];
  for (const [pid, children] of kids) {
    if (pid <= 1) continue;
    const argv = cmdline(pid);
    if (argv[0] !== 'dtach' && !String(argv[0]).endsWith('/dtach')) continue;
    if (!children.some((c) => /(^|\/)claude$/.test(cmdline(c)[0] || ''))) continue;
    const cgroup = readProc(pid, 'cgroup');
    const reason = unsafeSessionCgroup(cgroup);
    if (!reason) continue;
    const sockFlag = argv.findIndex((a) => a === '-A' || a === '-n');
    // A legacy session scope holds only this session, so move everything in it (incl.
    // daemonized tool processes that left the dtach tree); the server cgroup is shared.
    let tree = descendants(pid, kids);
    if (reason === 'oom-stop-scope') {
      const procs = readCgroupProcs(cgroup);
      if (procs.length) tree = procs;
    }
    found.push({ pid, reason, sock: sockFlag >= 0 ? argv[sockFlag + 1] : String(pid), tree });
  }
  return found;
}

/** Moves each live session's whole process tree into its own delegated scope. */
export function rescueSessions({ dryRun = false, only = () => true } = {}) {
  const sessions = sessionsInServerCgroup().filter(only);
  const results = [];
  for (const s of sessions) {
    const unit = `${sessionScopeName(s.sock)}-${s.reason === 'oom-stop-scope' ? 'oomsafe' : 'rescued'}`;
    if (dryRun) { results.push({ ...s, unit, moved: false }); continue; }
    const holder = spawnSync('bash', ['-c',
      `systemd-run --user --scope --quiet --collect -p Delegate=yes ${SCOPE_PROPS().join(' ')} --unit=${unit} sleep 30 >/dev/null 2>&1 & sleep 1`], { stdio: 'ignore' });
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
    for (const r of results) console.log(`${r.moved ? 'moved' : cmd === 'list' ? 'at-risk' : 'FAILED'} (${r.reason}) pid=${r.pid} procs=${r.tree.length} ${r.sock}${r.error ? ` (${r.error})` : ''}`);
    console.log(`${results.length} session(s) ${cmd === 'list' ? 'in the server cgroup or an OOMPolicy=stop scope' : 'processed'}`);
    process.exitCode = results.some((r) => cmd === 'rescue' && !r.moved) ? 1 : 0;
  } else {
    console.log('usage: node server/session-scope.mjs list|rescue');
  }
}
