// rc-engine.mjs — drive Claude Code sessions as `claude --remote-control` over
// node-pty, so the SAME session is live in Box, on desktop, and in the official
// Claude app (three-way sync). Input is injected as keystrokes into the PTY;
// rendering reads the session JSONL as the source of truth.
//
//   open(sessionId|null, name) -> { sessionId, ... }   spawn/reuse an RC process
//   send(sessionId, text)                              inject a message (paste + Enter)
//   interrupt(sessionId)                               ESC (stop current turn)
//   tail(sessionId, fromSeq, onEvent)                  stream parsed JSONL events
//
// Turn boundaries come from the JSONL, not from parsing the TUI: an assistant
// entry with message.stop_reason === 'end_turn' ends the turn ('tool_use' means
// more is coming). This avoids any brittle ANSI scraping.

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { homedir } from 'node:os';
import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { execSync } = require('child_process');

const HOME = homedir();
const CWD = process.env.CC_WORKSPACE || HOME;
const PROJECTS_BASE = path.join(HOME, '.claude', 'projects');
const projectDirFor = (cwd) => path.join(PROJECTS_BASE, String(cwd || CWD).replace(/\//g, '-'));
const PROJ_DIR = projectDirFor(CWD);
// Per-process runtime state claude writes for each session: { sessionId, pid, status, waitingFor, ... }.
// status==='waiting' means the session is parked on an interactive prompt (AskUserQuestion /
// ExitPlanMode / permission) — which is NOT written to the JSONL until answered. This is the
// detection signal the box uses to surface a pending prompt that JSONL can't show.
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
// Detach node-pty from dtach after 30 min idle; the claude RC process keeps
// running in the background. Next message reattaches via dtach -A (idempotent).
const IDLE_MS = 30 * 60 * 1000;
const RECENT_MS = 90 * 1000;    // a session JSONL written this recently is presumed LIVE elsewhere

// --- Account-aware config-dir discovery ------------------------------------
// The cc-account-broker (installed as /usr/bin/claude) routes a session to a
// pooled account by running claude with CLAUDE_CONFIG_DIR=~/.claude-<id>. That
// session's JSONL + per-process state then live under ~/.claude-<id>/{projects,
// sessions}, NOT the primary ~/.claude. So every lookup must scan ALL config
// dirs, or pooled sessions are invisible — the box renders no output and just
// looks silent. We glob ~/.claude and ~/.claude-* (primary first, stable order).
export function claudeConfigDirs() {
  const primary = path.join(HOME, '.claude');
  const out = [];
  try {
    for (const name of fs.readdirSync(HOME)) {
      if (name !== '.claude' && !name.startsWith('.claude-')) continue;
      const dir = path.join(HOME, name);
      try { if (fs.statSync(dir).isDirectory()) out.push(dir); } catch {}
    }
  } catch {}
  if (!out.includes(primary)) out.unshift(primary);
  return out.sort((a, b) => (a === primary ? -1 : b === primary ? 1 : a.localeCompare(b)));
}
export const projectsBases = () => claudeConfigDirs().map((d) => path.join(d, 'projects'));
export const sessionsDirs = () => claudeConfigDirs().map((d) => path.join(d, 'sessions'));

// Dtach socket for the RC bridge — survives server restarts and SSH disconnects.
// SSH attach: dtach -a /tmp/cc-box-<id>.dtach
const rcSockPath = (sessionId, name) => {
  const id = (sessionId || name || 'new').replace(/-/g, '');
  return `/tmp/cc-box-${id.slice(0, 8)}.dtach`;
};

// Search all project dirs for a session's JSONL (sessions live under their
// start cwd, which may differ from PROJ_DIR for cross-project sessions).
function findJsonl(sessionId) {
  for (const base of projectsBases()) {
    try {
      for (const d of fs.readdirSync(base)) {
        const cand = path.join(base, d, sessionId + '.jsonl');
        if (fs.existsSync(cand)) return cand;
      }
    } catch {}
  }
  return path.join(PROJ_DIR, sessionId + '.jsonl'); // fallback (primary)
}

function childEnv() {
  // Force the Max subscription (OAuth credentials file), never the metered API.
  // Also strip session-inheritance vars: the box server may run inside a claude
  // session and those env vars would make spawned claude processes behave as
  // child sessions (no independent JSONL, wrong session context).
  const e = { ...process.env };
  delete e.CLAUDE_CODE_OAUTH_TOKEN;
  delete e.CLAUDE_OAUTH_TOKEN;
  delete e.ANTHROPIC_API_KEY;
  delete e.CLAUDE_CODE_SESSION_ID;
  delete e.CLAUDE_CODE_CHILD_SESSION;
  delete e.CODEX_COMPANION_SESSION_ID;
  return e;
}

// Claude Code shows a one-time "Do you trust this folder?" dialog the first time it
// runs in a directory. It's a pre-TUI screen our boot detector can't distinguish from a
// ready input box, so the first pasted prompt gets swallowed and the chat looks dead.
// Pre-seed trust for the cwd in ~/.claude.json (the same store the dialog writes) so the
// dialog never shows. Only writes when not already trusted (so steady state never touches
// the file); atomic rename + best-effort.
function trustCwd(cwd) {
  try {
    if (!cwd) return;
    const p = path.join(homedir(), '.claude.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.projects = j.projects || {};
    const cur = j.projects[cwd] || {};
    if (cur.hasTrustDialogAccepted === true) return; // already trusted — no write, no race
    cur.hasTrustDialogAccepted = true;
    j.projects[cwd] = cur;
    const tmp = p + '.box.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2));
    fs.renameSync(tmp, p); // atomic swap; readers never see a torn file
  } catch { /* never block a spawn on trust bookkeeping */ }
}

// Wrap text in a bracketed-paste so embedded newlines / special chars land in
// the input box without submitting; a separate CR submits.
const bracketedPaste = (t) => '\x1b[200~' + t + '\x1b[201~';

function listJsonl() {
  const out = new Set();
  for (const base of projectsBases()) {
    try {
      for (const d of fs.readdirSync(base)) {
        const dir = path.join(base, d);
        try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) out.add(path.join(dir, f)); } catch {}
      }
    } catch {}
  }
  return out;
}

export class RCEngine extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // sessionId -> session record
  }

  get(sessionId) { return this.sessions.get(sessionId); }

  // Spawn a new RC process, or reuse the warm one for this session.
  // For a brand-new chat pass sessionId=null; the real id is detected from the
  // newly-created JSONL and the record is re-keyed. Returns the record (its
  // .sessionId may resolve asynchronously — await ready() for new chats).
  // True when `sessionId`'s JSONL has been written very recently — i.e. SOME process
  // (anywhere) is live on this session right now. On its own this can't tell apart a
  // genuine foreign owner (a laptop) from one of THIS box's own twin bridges, so it's
  // only the first signal; classifyOwner() refines it.
  jsonlRecentlyTouched(sessionId) {
    if (!sessionId) return false;
    for (const base of projectsBases()) {
      try {
        for (const d of fs.readdirSync(base)) {
          const cand = path.join(base, d, sessionId + '.jsonl');
          try {
            const st = fs.statSync(cand);
            if ((Date.now() - st.mtimeMs) < RECENT_MS) return true;
          } catch {}
        }
      } catch {}
    }
    return false;
  }

  // Find a live BOX-LOCAL dtach bridge already driving `sessionId` — i.e. a
  // `claude … --remote-control … --resume <sessionId>` process running on THIS box,
  // wrapped in a dtach master we can reattach to. Covers both the cc-rc-supervisor's
  // long-lived sessions (/tmp/cc-rc-*.dtach) and any ad-hoc interactive `claude`
  // started on the box with remote-control + resume. Returns { sock, pid } or null.
  //
  // This is the key to a collision-SAFE take-over: if the owner is already one of our
  // own bridges, we don't spawn a SECOND `--remote-control` process (which is what
  // archive-loops, per docs/rc-collision-fix.md) — we reattach to the EXISTING one,
  // so there is always exactly one owner of the claude.ai surface.
  // requireRecent: the cwd-fallback (no-`--resume` sessions) normally only counts a
  // bridge whose JSONL was written in the last RECENT_MS — a recency proxy for
  // archive-loop ownership decisions.
  // argvOnly: skip the cwd-fallback entirely and trust ONLY the proc-specific arg-scan
  // (the full sessionId UUID in argv). The cwd-fallback canNOT distinguish sessions
  // that SHARE a cwd: every session under ~/development has its JSONL in the same
  // project dir, so the "<id>.jsonl exists in this proc's project dir" test is true for
  // EVERY such proc and returns the first one — the WRONG bridge. That mismatch is
  // harmless for ownership classification (any box-local owner means "reattach, don't
  // spawn") but catastrophic for injection/binding, where it cross-wires a session to
  // another's bridge. So injectIfLive() passes argvOnly:true.
  localBridgeFor(sessionId, { requireRecent = true, argvOnly = false } = {}) {
    if (!sessionId) return null;

    // Helper: given a claude --remote-control PID, find its dtach parent's socket.
    const dtachSockFor = (pid) => {
      try {
        const ppid = execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf8', timeout: 2000 }).trim();
        if (!ppid) return null;
        const pcmd = execSync(`ps -o args= -p ${ppid}`, { encoding: 'utf8', timeout: 2000 }).trim();
        if (!/^dtach\b/.test(pcmd)) return null;
        const sm = pcmd.match(/(\/tmp\/cc-[A-Za-z0-9._-]+\.dtach)/);
        if (!sm) return null;
        const sock = sm[1];
        if (!fs.existsSync(sock)) return null;
        try { execSync(`fuser ${sock} 2>/dev/null`, { timeout: 2000 }); return sock; } catch { return null; }
      } catch { return null; }
    };

    // Primary search: find the sessionId anywhere in process args (covers both
    // `--resume <id>`, used by the cc-rc-supervisor, AND `--session-id <id>`, used by
    // the interactive `cnew` wrapper for a fresh RC session). The filters below still
    // require a real `claude --remote-control` process, so a bare id match can't false-hit.
    try {
      const out = execSync(
        `pgrep -af -- '${sessionId}' 2>/dev/null || true`,
        { encoding: 'utf8', timeout: 2000 },
      );
      for (const line of out.split('\n')) {
        const m = line.match(/^(\d+)\s+(.*)$/);
        if (!m) continue;
        const [, pid, cmd] = m;
        if (!/--remote-control/.test(cmd)) continue;
        if (/^dtach\b/.test(cmd) || /\bbash -c\b/.test(cmd)) continue;
        if (!/\bclaude\b/.test(cmd)) continue;
        const sock = dtachSockFor(pid);
        if (sock) return { sock, pid: Number(pid) };
      }
    } catch {}

    // Fallback: sessions spawned WITHOUT --resume (e.g. fresh sessions started in a repo dir).
    // Scan ALL local claude --remote-control processes; for each, read its CWD via /proc
    // and check if the target sessionId's JSONL is in its project dir (recently touched).
    // This is how we detect "box-local bridge with no --resume in argv" without spawning
    // a competing bridge and archive-looping. NOTE: this can mis-match sessions that
    // share a cwd (see argvOnly above) — never use it to pick a socket to inject into.
    if (argvOnly) return null;
    try {
      const all = execSync(`pgrep -af -- '--remote-control' 2>/dev/null || true`, { encoding: 'utf8', timeout: 2000 });
      for (const line of all.split('\n')) {
        const m = line.match(/^(\d+)\s+(.*)$/);
        if (!m) continue;
        const [, pid, cmd] = m;
        if (!/\bclaude\b/.test(cmd) || /^dtach\b/.test(cmd) || /\bbash -c\b/.test(cmd)) continue;
        try {
          const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
          const proj = projectDirFor(cwd);
          const jf = path.join(proj, sessionId + '.jsonl');
          const st = fs.statSync(jf);
          if (!requireRecent || (Date.now() - st.mtimeMs) < RECENT_MS) {
            const sock = dtachSockFor(pid);
            if (sock) return { sock, pid: Number(pid) };
          }
        } catch {}
      }
    } catch {}

    return null;
  }

  // Classify who owns `sessionId` right now, so open() can pick the safe path:
  //   'none'           — nobody live; spawn our own bridge.
  //   'self'           — we already have it in this.sessions; reuse.
  //   'box-bridge'     — a BOX-LOCAL twin bridge owns it (returns { sock }); reattach to
  //                      it instead of spawning a competing one. Collision-safe.
  //   'external'       — JSONL is fresh but NO box-local bridge owns it ⇒ a real foreign
  //                      owner (your laptop / the official app). Spawning here WOULD
  //                      archive-loop ⇒ require an explicit take-over.
  classifyOwner(sessionId) {
    if (!sessionId) return { kind: 'none' };
    if (this.sessions.has(sessionId)) return { kind: 'self' };
    const bridge = this.localBridgeFor(sessionId);
    if (bridge) return { kind: 'box-bridge', sock: bridge.sock };
    if (this.jsonlRecentlyTouched(sessionId)) return { kind: 'external' };
    return { kind: 'none' };
  }

  // Back-compat: a session has a "foreign" (non-box) owner only when it's truly
  // external — a box-local twin bridge is NOT foreign (we can reattach to it).
  foreignOwner(sessionId) {
    return this.classifyOwner(sessionId).kind === 'external';
  }

  open(sessionId, name, opts = {}) {
    if (sessionId && this.sessions.has(sessionId)) {
      this.touch(sessionId);
      return this.sessions.get(sessionId);
    }
    // For a BRAND-NEW chat, mint the session id ourselves and pass it via `--session-id`
    // instead of discovering it later by diffing the JSONL directory. The old approach
    // ("the .jsonl that appeared after spawn") RACES when two new sessions are created in
    // the same window: detectSession would grab whichever file appeared first and bind a
    // chat to the WRONG id — so a delegate's title (e.g. "INC-926: …") got written onto an
    // unrelated chat. A pre-minted id is known synchronously, is unique entropy for the
    // dtach socket, and lands in argv so localBridgeFor() can find this bridge on resume.
    const newId = sessionId ? null : randomUUID();
    const effId = sessionId || newId;
    // opts.sock: reattach to a specific live dtach socket (e.g. a box-local twin found
    // via localBridgeFor) instead of our own — `dtach -A` on it attaches, never respawns.
    let sock = (opts.sock && fs.existsSync(opts.sock)) ? opts.sock : rcSockPath(effId, name);
    let reattach = fs.existsSync(sock); // our own (or the given) bridge's socket is already alive
    // Decide how to (re)connect to an already-live session WITHOUT ever creating a
    // second `claude --remote-control` for it (that's what archive-loops; see
    // docs/rc-collision-fix.md). Only relevant when we don't already own our own socket.
    if (!reattach && sessionId) {
      const owner = this.classifyOwner(sessionId);
      if (owner.kind === 'box-bridge') {
        // A box-local twin (the cc-rc-supervisor's session, or an interactive box
        // `claude --remote-control --resume`) already owns this surface. Reattach to
        // ITS dtach socket and inject through the one existing bridge — single owner,
        // no collision. No `force`/take-over needed; this is always safe.
        sock = owner.sock;
        reattach = true;
      } else if (owner.kind === 'external' && !opts.force) {
        // Genuinely owned elsewhere (your laptop / the official app). Spawning here
        // would make two owners → archive-loop. Require an explicit take-over.
        return { blocked: true, reason: 'external-owner', sessionId, name };
      }
      // owner.kind === 'none' (or forced) → fall through and spawn our own bridge.
    }
    // `reattach` is true when `sock` is an already-live dtach master (ours OR a box
    // twin's) — `dtach -A` then attaches to it instead of running `claude` again, so
    // no second --remote-control bridge is ever created. When false we spawn fresh.
    void reattach;
    // Fallback only: with a pre-minted --session-id the JSONL appears at effId, so we no
    // longer rely on this diff. Kept defensively in case a build of claude ignores the flag.
    const before = effId ? null : listJsonl();
    const cwd = opts.cwd || CWD;
    // Wrap the RC process in dtach so it survives server restarts and SSH disconnects.
    // dtach -A creates the socket+process if absent, or reattaches if it exists (idempotent).
    const claudeArgs = ['--remote-control', name, '--permission-mode', 'auto'];
    if (opts.settings && opts.settings.model) claudeArgs.push('--model', opts.settings.model);
    if (opts.settings && opts.settings.effort) claudeArgs.push('--effort', opts.settings.effort);
    if (sessionId) claudeArgs.push('--resume', sessionId);
    else claudeArgs.push('--session-id', newId);   // deterministic id for a fresh chat
    trustCwd(cwd); // pre-accept the folder-trust dialog so the first prompt isn't eaten
    const term = pty.spawn('dtach', ['-A', sock, '-r', 'winch', '-z', 'claude', ...claudeArgs], {
      name: 'xterm-256color', cols: 100, rows: 40, cwd, env: childEnv(),
    });
    const s = {
      pty: term, name, sock,
      sessionId: effId || null,                    // known up front now, even for new chats
      jsonl: sessionId ? findJsonl(sessionId) : path.join(projectDirFor(cwd), newId + '.jsonl'),
      booted: false, idleTimer: null,
      outBuf: '',   // rolling tail of raw PTY output, for scraping a pending interactive prompt
    };
    // booted: TUI is ready to accept keystrokes. session_p resolves once the real id is
    // known — immediate now that we mint it ourselves (was deferred until the JSONL appeared).
    s.booted_p = new Promise((res) => { s._bootRes = res; });
    s.session_p = new Promise((res) => { s._sessRes = res; });
    if (effId) { this.sessions.set(effId, s); s._sessRes(s); }

    // Boot is "done" when the TUI has actually painted and then stopped repainting.
    // We require a floor of 3s (the input box isn't interactive instantly), then fire
    // once output has been quiet for ~1.2s. CRITICAL: the quiet countdown only starts
    // AFTER the first real output (see term.onData) — never on a pre-output tick.
    // The cc-account-broker wrapper (/usr/bin/claude) is SILENT for a beat while it
    // picks an account before exec'ing claude; the old code armed the timer at spawn
    // and marked "booted" at 3s during that silence, so sendRecord pasted the first
    // prompt into a not-yet-live TUI and the keystrokes were dropped (→ no response).
    // The 20s hard cap is a backstop for a session that never paints (e.g. a reattach
    // with no repaint, or a very slow account pick).
    const spawnedAt = Date.now();
    const markBooted = () => { if (!s.booted) { s.booted = true; clearTimeout(s._quietT); clearTimeout(s._capT); s._bootRes(s); this.emit('booted', s.sessionId); } };
    s._capT = setTimeout(markBooted, 20000);
    const scheduleQuiet = () => {
      clearTimeout(s._quietT);
      const wait = Math.max(1200, 3000 - (Date.now() - spawnedAt));
      s._quietT = setTimeout(markBooted, wait);
    };
    let boot = '';
    const detectSession = () => {
      // For a new chat, find the JSONL that appeared after spawn (post first send).
      if (!s.sessionId) {
        const now = listJsonl();
        for (const f of now) if (!before.has(f)) {
          s.sessionId = path.basename(f).replace(/\.jsonl$/, '');
          s.jsonl = f;
          this.sessions.set(s.sessionId, s);
          if (s._detectI) { clearInterval(s._detectI); s._detectI = null; }
          s._sessRes(s);
          this.emit('session', s.sessionId);
          break;
        }
      }
    };
    // Only needed if we somehow have NO id (flag ignored). Normally effId is set, so the
    // interval never starts and detectSession() is inert (it self-guards on !s.sessionId).
    if (!effId) s._detectI = setInterval(detectSession, 500);
    term.onData((d) => {
      if (!s.booted) { boot += d; scheduleQuiet(); }
      if (!s.sessionId) detectSession();
      // keep a rolling tail of the TUI so we can reconstruct the screen when parked on a prompt
      s.outBuf += d;
      if (s.outBuf.length > 96000) s.outBuf = s.outBuf.slice(-64000);
    });
    // dtach client exits when we detach or when the session ends; either way
    // clean up our local record (dtach sock may still exist if claude is alive).
    term.onExit(() => {
      if (s._detectI) clearInterval(s._detectI);
      if (s.sessionId) this.sessions.delete(s.sessionId);
      this.emit('exit', s.sessionId);
    });

    if (sessionId) this.sessions.set(sessionId, s);
    this.touch(s);
    return s;
  }

  touch(idOrRec) {
    const s = typeof idOrRec === 'string' ? this.sessions.get(idOrRec) : idOrRec;
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    // After idle: detach node-pty but leave the claude RC process alive in dtach.
    s.idleTimer = setTimeout(() => this.detach(s.sessionId), IDLE_MS);
  }

  // Inject a message into an existing/known session by id.
  async send(sessionId, text, name, opts = {}) {
    let s = this.sessions.get(sessionId);
    if (!s) { s = this.open(sessionId, name || ('box-' + sessionId.slice(0, 8)), opts); }
    if (s && s.blocked) return s; // caller handles the take-over prompt
    await this.sendRecord(s, text);
    return s;
  }

  // Inject text into a session ONLY if it is already LIVE — either we hold it
  // (self) or a box-local twin bridge owns it (e.g. the cc-rc-supervisor, or a
  // bridge this server spawned before a restart). Reattaches to the existing dtach
  // socket; NEVER spawns a new bridge (so a dormant session is left asleep) and
  // never fights a truly external owner (laptop / official app). Returns true if it
  // injected. Used to push `/rename` to the running process so the official Claude
  // app reflects a Box rename in real time (a disk-only title write never would).
  injectIfLive(sessionId, text, opts = {}) {
    if (!sessionId) return false;
    let rec = this.sessions.get(sessionId);          // already ours
    if (!rec) {
      // Find this session's OWN live bridge by the full sessionId UUID in argv
      // (argvOnly — NEVER the cwd-fallback, which mis-matches sessions sharing a cwd and
      // would cross-wire one chat's rename/messages onto another's bridge). fuser-verified
      // live socket. No match ⇒ dormant, or live without the UUID in argv (a box-NEW
      // bridge across a restart) ⇒ skip injection; the disk-written custom-title still
      // covers Box/pickup/picker and the official app picks it up on resume.
      const b = this.localBridgeFor(sessionId, { argvOnly: true });
      if (!b) return false;
      rec = this.open(sessionId, opts.name || ('box-' + String(sessionId).slice(0, 8)), { ...opts, sock: b.sock });
    }
    if (!rec || rec.blocked) return false;
    this.sendRecord(rec, text).catch(() => {});
    return true;
  }

  // Inject into a session record directly (works before sessionId is known, e.g.
  // the very first message of a brand-new chat that has no JSONL yet).
  async sendRecord(s, text) {
    this.touch(s);
    await s.booted_p;
    s.pty.write(bracketedPaste(text));
    await new Promise((r) => setTimeout(r, 120)); // let the paste settle before submit
    s.pty.write('\r');
  }

  interrupt(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s) s.pty.write('\x1b'); // ESC interrupts the current turn in the TUI
  }

  // Read claude's per-process runtime state for a session (status/waitingFor/pid), by matching
  // sessionId across ~/.claude/sessions/<pid>.json. Cheap; safe to poll. Returns null if absent.
  sessionState(sessionId) {
    if (!sessionId) return null;
    for (const sdir of sessionsDirs()) {
      try {
        for (const f of fs.readdirSync(sdir)) {
          if (!f.endsWith('.json')) continue;
          try { const o = JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8')); if (o.sessionId === sessionId) return o; } catch {}
        }
      } catch {}
    }
    return null;
  }

  isWaiting(sessionId) { const st = this.sessionState(sessionId); return !!(st && st.status === 'waiting'); }

  // Force a fresh full repaint of the TUI (so outBuf holds the current screen even if we attached
  // after the prompt appeared) and return the rolling buffer. Requires a live local pty.
  async captureScreen(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.pty) return null;
    await s.booted_p;
    // nudge the size to provoke a redraw, then restore — net no size change, just a repaint.
    try { s.pty.resize(99, 40); await new Promise((r) => setTimeout(r, 70)); s.pty.resize(100, 40); } catch {}
    await new Promise((r) => setTimeout(r, 260));
    return s.outBuf;
  }

  // Answer a pending selection prompt by injecting keystrokes.
  //   { index: n }            -> select the n-th option (cursor starts at 1): Down×(n-1) then Enter.
  //   { text, freeTextIndex } -> select the free-text option, then TYPE the text (plain chars —
  //                              NOT bracketed paste, whose leading ESC the menu reads as cancel)
  //                              and Enter.
  // Assumes the menu cursor is at option 1 (a freshly-shown prompt), which holds because the box
  // injects the whole sequence atomically and doesn't otherwise move the cursor.
  async answerWaiting(sessionId, sel) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.pty || !sel) return false;
    await s.booted_p;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const down = async (k) => { for (let i = 1; i < k; i++) { s.pty.write('\x1b[B'); await sleep(110); } };
    if (sel.text != null && Number.isInteger(sel.freeTextIndex) && sel.freeTextIndex >= 1) {
      // The free-text option ("Type something" / "Tell Claude what to change") DECLINES the
      // structured question and drops to the normal composer; then we send the reply as a normal
      // message (bracketed paste so newlines/specials survive — safe now that the menu is gone).
      await down(sel.freeTextIndex);
      s.pty.write('\r'); await sleep(500);
      s.pty.write(bracketedPaste(String(sel.text))); await sleep(150);
      s.pty.write('\r');
      return true;
    }
    if (Number.isInteger(sel.index) && sel.index >= 1) {
      await down(sel.index);
      s.pty.write('\r');
      return true;
    }
    // Plain free reply: no menu to navigate — a generic "waiting for input" state, or a
    // permission/other prompt the box couldn't parse into options. Type PLAIN chars (NOT
    // bracketed paste, whose leading ESC a still-open menu would read as cancel) then Enter,
    // exactly like a desktop user would. Lets the phone answer permission/free-text prompts.
    if (sel.text != null) {
      s.pty.write(String(sel.text)); await sleep(150);
      s.pty.write('\r');
      return true;
    }
    return false;
  }

  // Soft close: detach node-pty from dtach, leaving the claude RC process alive.
  // The dtach socket persists; next open() call reattaches seamlessly.
  detach(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    try { s.pty.kill(); } catch {} // kills the dtach CLIENT, not the claude RC process
    this.sessions.delete(sessionId);
  }

  // Hard close: kill the actual claude RC process (and its dtach socket).
  // Use only when you truly want to end the session, not just disconnect.
  destroy(sessionId) {
    const s = this.sessions.get(sessionId);
    const sock = s ? s.sock : rcSockPath(sessionId, '');
    this.detach(sessionId);
    try {
      const { execSync } = require('child_process');
      execSync(`pkill -TERM -f "${path.basename(sock)}"`, { stdio: 'ignore' });
    } catch {}
  }

  close(sessionId) { this.detach(sessionId); } // backward-compat alias

  closeAll() { for (const id of [...this.sessions.keys()]) this.detach(id); }

  // Return the dtach socket path so callers can surface an SSH attach hint.
  sockPath(sessionId, name) { return rcSockPath(sessionId, name); }
}

// ---- JSONL tailing -------------------------------------------------------
// Parse a JSONL file into render events. Stateless w.r.t. processes so it can
// follow a session edited from ANY device (Box / desktop / official app).

export function parseEntry(o) {
  // Returns an array of normalized events for one JSONL line, or [].
  const out = [];
  if (o.type === 'user') {
    const c = o.message && o.message.content;
    if (typeof c === 'string') out.push({ kind: 'user', text: c, uuid: o.uuid, ts: o.timestamp });
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text') out.push({ kind: 'user', text: b.text, uuid: o.uuid, ts: o.timestamp });
        else if (b.type === 'tool_result') out.push({ kind: 'tool_result', id: b.tool_use_id, content: b.content, uuid: o.uuid, ts: o.timestamp });
      }
    }
  } else if (o.type === 'assistant') {
    const c = o.message && o.message.content;
    const stop = o.message && o.message.stop_reason;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text') out.push({ kind: 'text', text: b.text, uuid: o.uuid, ts: o.timestamp });
        else if (b.type === 'thinking') out.push({ kind: 'thinking', text: b.thinking || '', uuid: o.uuid, ts: o.timestamp });
        else if (b.type === 'tool_use') out.push({ kind: 'tool', id: b.id, name: b.name, input: b.input, uuid: o.uuid, ts: o.timestamp });
      }
    }
    if (stop === 'end_turn' || stop === 'stop_sequence') out.push({ kind: 'turn_end', uuid: o.uuid, ts: o.timestamp });
  } else if (o.type === 'attachment') {
    out.push({ kind: 'attachment', uuid: o.uuid, ts: o.timestamp });
  } else if (o.type === 'system' && o.subtype === 'api_error') {
    // upstream hiccup (e.g. 529 overloaded) — claude retries automatically; surface
    // it as a transient notice so the user isn't staring at silence.
    let m = (o.error && o.error.message) || '';
    if (/overloaded/i.test(m)) m = 'Anthropic overloaded — retrying…';
    else m = ('API error: ' + m).slice(0, 160);
    out.push({ kind: 'notice', text: m, uuid: o.uuid, ts: o.timestamp });
  } else if (o.type === 'system' && o.subtype === 'bridge_status' && o.url) {
    out.push({ kind: 'bridge', url: o.url, text: o.content || '', uuid: o.uuid, ts: o.timestamp });
  }
  return out;
}

// Read all entries currently in the file (for backfill), returning {events, lines}.
export function readAll(jsonl) {
  let raw = '';
  try { raw = fs.readFileSync(jsonl, 'utf8'); } catch { return { events: [], lines: 0 }; }
  const lines = raw.split('\n').filter(Boolean);
  const events = [];
  for (const l of lines) { try { events.push(...parseEntry(JSON.parse(l))); } catch {} }
  return { events, lines: lines.length };
}

// Follow a JSONL from a given line offset, emitting events as new lines append.
// Returns a stop() function. Robust to truncation/replacement (re-reads).
export function tail(jsonl, fromLine, onEvent) {
  let offset = fromLine || 0;
  let reading = false;
  const pump = () => {
    if (reading) return; reading = true;
    let raw = '';
    try { raw = fs.readFileSync(jsonl, 'utf8'); } catch { reading = false; return; }
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length < offset) offset = 0; // file shrank/replaced -> re-sync
    for (let i = offset; i < lines.length; i++) {
      try { for (const ev of parseEntry(JSON.parse(lines[i]))) onEvent(ev); } catch {}
    }
    offset = lines.length;
    reading = false;
  };
  pump();
  let watcher = null;
  try { watcher = fs.watch(jsonl, { persistent: false }, pump); } catch {}
  const poll = setInterval(pump, 1000); // belt-and-suspenders for fs.watch misses
  return () => { try { watcher && watcher.close(); } catch {}; clearInterval(poll); };
}

export const PROJECT_DIR = PROJ_DIR;
export { findJsonl, rcSockPath };
