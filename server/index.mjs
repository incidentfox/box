// cc-mobile — personal mobile CHAT app for box-side Claude Code.
// Native-style chat UI backed by `claude` headless stream-json (per-turn resume),
// so every box session is listable/resumable, with bash mode, @files, /skills,
// bilingual voice, and image attach. Token-gated; sits behind a Cloudflare tunnel.
import express from 'express';
import { WebSocketServer, WebSocket as WSClient } from 'ws';
import { createServer } from 'node:http';
import { spawn, execSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, statSync, readdirSync, mkdirSync, unlinkSync,
  openSync, readSync, closeSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { join, resolve, dirname, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import multer from 'multer';
import { RCEngine, tail as tailJsonl, readAll as readJsonl, projectsBases } from './rc-engine.mjs';
import * as accounts from './accounts.mjs';
import { promptFromBuffer } from './tui-prompt.mjs';
import { CodexExecEngine } from './codex-exec-engine.mjs';

// One engine drives every session as `claude --remote-control` over node-pty, so
// a session driven from Box is simultaneously live on desktop + the official app
// (three-way sync). Input = injected keystrokes; rendering = the JSONL tail.
const rcEngine = new RCEngine();
const codexEngine = new CodexExecEngine();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PUBLIC = join(ROOT, 'public');
const HOME = homedir();
const PROJECTS = join(HOME, '.claude', 'projects'); // primary; for fallbacks only — scans must use eachProjectDir()
const RC_REGISTRY = join(HOME, '.config', 'cc-rc-sessions.tsv');

// Account-aware session discovery: the cc-account-broker routes a session to a
// pooled account (CLAUDE_CONFIG_DIR=~/.claude-<id>), so its JSONL lives under
// ~/.claude-<id>/projects, not just ~/.claude/projects. projectsBases() (from
// rc-engine) enumerates every config dir's projects base; these helpers fan the
// box's session scans across ALL of them so pooled sessions aren't invisible.
function eachProjectDir() {
  const dirs = [];
  for (const base of projectsBases()) {
    try { for (const d of readdirSync(base, { withFileTypes: true })) if (d.isDirectory()) dirs.push(join(base, d.name)); } catch {}
  }
  return dirs;
}
function findSessionFile(id) {
  for (const dir of eachProjectDir()) { const c = join(dir, id + '.jsonl'); if (existsSync(c)) return c; }
  return null;
}
const STATE_DIR = join(HOME, '.cc-mobile');
const NAMES_FILE = join(STATE_DIR, 'names.json');
const UPLOAD_DIR = join(STATE_DIR, 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });
// Persisted voice clips (so a garbled transcript can be re-transcribed later).
const VOICE_DIR = join(STATE_DIR, 'voice');
mkdirSync(VOICE_DIR, { recursive: true });
// Per-session status/"needs your input" docs, keyed by SESSION ID (not cwd). The old
// <cwd>/.claude/ATTENTION.md scheme clobbered: every box session starts in ~/development,
// so they all wrote one shared file and each chat showed whichever session wrote last.
// Keyed by session id, each chat keeps its own status. (the user 2026-06-24.)
const SESS_ATT_DIR = join(HOME, '.factory', 'session-attention');
mkdirSync(SESS_ATT_DIR, { recursive: true });
const sessionAttFile = (sessionId) => join(SESS_ATT_DIR, `${String(sessionId).replace(/[^\w.-]/g, '_')}.md`);
const sessionAttOff = (sessionId) => join(SESS_ATT_DIR, `${String(sessionId).replace(/[^\w.-]/g, '_')}.off`);

// ---- config ---------------------------------------------------------------
function loadEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const localEnv = loadEnvFile(join(ROOT, '.env'));
// Optional: point EXTRA_ENV_FILE at a shared secrets file (e.g. one your harness
// already maintains) to source keys from there instead of duplicating them in .env.
const extraEnv = loadEnvFile(process.env.EXTRA_ENV_FILE || localEnv.EXTRA_ENV_FILE || '');
// Resolve a config value from (in order) the process env, .env, then the extra env file.
const cfg = (k, d = '') => process.env[k] || localEnv[k] || extraEnv[k] || d;

const PORT = Number(cfg('PORT', 7321));
// Default working directory for new chats / where /skills are scanned. Defaults to $HOME;
// set CC_WORKSPACE to your main code dir (e.g. ~/code) for a nicer default.
const DEFAULT_CWD = cfg('CC_WORKSPACE') || HOME;
const STT_MODELS = cfg('STT_MODEL', 'scribe_v2,scribe_v1').split(',');
// Voice (speech-to-text) is OPTIONAL. ElevenLabs Scribe is the zero-friction pick;
// Deepgram nova-3 is the higher-quality batch transcriber. Leave both unset to disable voice.
const ELEVEN_KEY = cfg('ELEVENLABS_API_KEY');
const DEEPGRAM_KEY = cfg('DEEPGRAM_API_KEY');
const DG_MODEL = cfg('DG_STT_MODEL', 'nova-3');

// ---- personalization + optional integrations ------------------------------
// Your name, used in the morning-brief status doc the app keeps per session.
const OWNER_NAME = cfg('OWNER_NAME', 'you');
// Linear (optional): set LINEAR_API_KEY to enable the in-app Board + "needs you" inbox.
// LINEAR_TEAM_ID = the GraphQL team UUID whose board you want; LINEAR_TEAM_KEY = its key
// (e.g. "ENG") to scope issue-by-number lookups; NEEDS_LABEL = the label that flags an
// issue as needing your personal decision.
const LINEAR_TEAM_ID = cfg('LINEAR_TEAM_ID');
const LINEAR_TEAM_KEY = cfg('LINEAR_TEAM_KEY');
const NEEDS_LABEL = cfg('NEEDS_LABEL', 'needs-me');
// Your Linear workspace URL slug (the bit in linear.app/<slug>/…), used only to build
// fallback issue links. Optional — resolved issues carry their own canonical url.
const LINEAR_WORKSPACE = cfg('LINEAR_WORKSPACE');
// Scope an issues() lookup to your team only when a team key is configured.
const TEAM_KEY_FILTER = LINEAR_TEAM_KEY ? `, team:{ key:{ eq:"${LINEAR_TEAM_KEY}" } }` : '';
// Issue-id mentions in transcripts (e.g. "ENG-123") link to the Board. Derived from your
// team key; if no team key is set the "issues this session mentions" feature is disabled.
const ISSUE_PREFIX = LINEAR_TEAM_KEY ? `${LINEAR_TEAM_KEY}-` : '';
const ISSUE_RE = LINEAR_TEAM_KEY ? new RegExp(`\\b${LINEAR_TEAM_KEY}-(\\d+)\\b`, 'g') : null;
const issueUrl = (n) => (LINEAR_WORKSPACE ? `https://linear.app/${LINEAR_WORKSPACE}/issue/${ISSUE_PREFIX}${n}` : '');

// ---- optional private overlay -------------------------------------------------
// Business-specific extensions that must NEVER fork the public core. If BOX_OVERLAY
// (or ~/.config/box/box.local.mjs) exists, it's imported at boot. It may export:
//   categorizeAuto(session, file) -> subcat key | null   — override the auto-session bucket
//   subLabels: { key: 'Label' }                          — display names for those buckets
//   routes(app, ctx)                                     — register extra Express routes
//   onReady(ctx)                                         — arbitrary init hook
// Keeps your private logic in your own file; the core stays generic = no drift.
let overlay = {};
const OVERLAY_PATH = process.env.BOX_OVERLAY || localEnv.BOX_OVERLAY || join(HOME, '.config', 'box', 'box.local.mjs');
if (existsSync(OVERLAY_PATH)) {
  try { overlay = await import(pathToFileURL(OVERLAY_PATH).href); console.log('[box] loaded overlay:', OVERLAY_PATH); }
  catch (e) { console.error('[box] overlay load failed:', e && e.message); }
}

let AUTH_TOKEN = process.env.CC_AUTH_TOKEN || localEnv.CC_AUTH_TOKEN;
if (!AUTH_TOKEN) {
  AUTH_TOKEN = randomBytes(16).toString('hex');
  const envPath = join(ROOT, '.env');
  const prev = existsSync(envPath) ? readFileSync(envPath, 'utf8').replace(/\n*$/, '\n') : '';
  writeFileSync(envPath, prev + `CC_AUTH_TOKEN=${AUTH_TOKEN}\n`);
}

// claude must use full Max creds, not the injected inference-only token.
// Also strip session-inheritance vars so spawned claude processes are
// top-level sessions, not children of the box server's parent session.
function childEnv() {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.CLAUDE_OAUTH_TOKEN; delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_SESSION_ID; delete env.CLAUDE_CODE_CHILD_SESSION; delete env.CODEX_COMPANION_SESSION_ID;
  if (ELEVEN_KEY) env.ELEVENLABS_API_KEY = ELEVEN_KEY;
  return env;
}

// ---- helpers: names store -------------------------------------------------
const loadNames = () => { try { return JSON.parse(readFileSync(NAMES_FILE, 'utf8')); } catch { return {}; } };
const saveNames = (n) => writeFileSync(NAMES_FILE, JSON.stringify(n, null, 2));

// ---- helpers: sessions ----------------------------------------------------
function readRcRegistry() {
  const map = {};
  if (!existsSync(RC_REGISTRY)) return map;
  for (const line of readFileSync(RC_REGISTRY, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [rcName, cwd, sessionId, note] = line.split('\t');
    if (sessionId) map[sessionId.trim()] = {
      rcName: rcName.trim(), cwd: (cwd || '').trim(),
      note: note ? note.replace(/^note:/, '').replace(/[-()]/g, ' ').trim() : null,
    };
  }
  return map;
}

// After a Box-app-SERVER restart, the dtach-wrapped `claude --remote-control`
// processes it was driving keep running, but the in-memory RUNNING/live map is
// wiped — so live sessions silently show as idle and can sink below the recency
// cap (exactly the "missing live chats after downtime" symptom). This scans the box
// for live box-local `claude --remote-control` bridges and re-binds the ones whose
// session-id is recoverable from argv (--resume / --session-id), so they pin as live
// immediately without a manual resurface.
//
// We deliberately do NOT write these to the supervisor registry (cc-rc-sessions.tsv):
// the supervisor keys its dtach socket as /tmp/cc-rc-<rcName> while box-app sessions
// live at /tmp/cc-box-<id>. A mismatch would make the supervisor think the session is
// dead and spawn a DUPLICATE --remote-control bridge — the surface-collision / archive
// -loop bug (docs/rc-collision-fix.md). Pinning in-memory is collision-safe; opening a
// card reattaches to the existing bridge via rc-engine's box-local owner detection.
//
// Box-new sessions started without --resume/--session-id (fresh uuid only in their
// JSONL) are intentionally left as recency-listed idle cards: they're still visible
// and reconnect on open; auto-resolving their uuid would need a heavier RC probe.
const LIVE_BRIDGES = new Map(); // sessionId -> { rcName, cwd, pid }
function reconcileLiveBridges() {
  const next = new Map();
  let out = '';
  try { out = execSync(`pgrep -af -- '--remote-control' 2>/dev/null || true`, { encoding: 'utf8', timeout: 4000 }); } catch {}
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const pid = line.slice(0, sp).trim();
    const cmd = line.slice(sp + 1);
    if (!/\bclaude\b/.test(cmd)) continue;             // only real claude RC processes
    if (/^dtach\b/.test(cmd) || /\bbash -c\b/.test(cmd)) continue; // skip the dtach wrapper / shell
    if (/--name\s+factory-box/.test(cmd)) continue;    // the phone RC listener, not a session
    const m = cmd.match(/--(?:resume|session-id)\s+([0-9a-fA-F-]{36})/);
    if (!m) continue;                                  // box-new w/o argv id → stays an idle card
    const sessionId = m[1];
    const rcm = cmd.match(/--remote-control\s+(\S+)/);
    let cwd = '';
    try { cwd = execSync(`readlink /proc/${pid}/cwd 2>/dev/null || true`, { encoding: 'utf8', timeout: 1000 }).trim(); } catch {}
    next.set(sessionId, { rcName: rcm ? rcm[1] : null, cwd: cwd || DEFAULT_CWD, pid });
  }
  LIVE_BRIDGES.clear();
  for (const [k, v] of next) LIVE_BRIDGES.set(k, v);
  return LIVE_BRIDGES.size;
}

// Dream-cycle / meta sessions all open with the SAME boilerplate prompt, so the
// title is identical for every one. When we detect a meta-prompt, pull the ACTUAL
// subject out of the embedded "SESSION TRANSCRIPT:" (the session being distilled)
// and tag it by stage, so each dream is distinguishable at a glance.
function metaSubject(t) {
  const i = t.indexOf('SESSION TRANSCRIPT:');
  if (i < 0) return null;
  const after = t.slice(i + 'SESSION TRANSCRIPT:'.length);
  const m = after.match(/USER:\s*([^\n]+)/);
  let subj = (m ? m[1] : (after.trim().split('\n')[0] || '')).replace(/\s+/g, ' ').trim();
  if (!subj || subj.length < 3) return null;
  const stage = /You are distilling/.test(t) ? 'distill'
    : /ACTION ITEMS/.test(t) ? 'action items'
    : /Decide whether this session/.test(t) ? 'scope'
    : 'dream';
  return `🌀 ${stage}: ${subj.slice(0, 64)}`;
}

// Pull a human title from a session's jsonl: first real user text message.
function sessionTitle(file) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines.slice(0, 60)) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'summary' && o.summary) return o.summary.slice(0, 80);
      if (o.type === 'user' && o.message) {
        const c = o.message.content;
        let t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
        t = t.trim();
        if (t && !t.startsWith('<') && !t.startsWith('/') && !t.startsWith('Caveat:')) {
          return metaSubject(t) || t.replace(/\s+/g, ' ').slice(0, 80);
        }
      }
    }
  } catch {}
  return '';
}

// Claude persists the session title as appended JSONL meta-lines — the SAME source
// the `claude --resume` picker and the official Claude mobile app read:
//   {"type":"custom-title","customTitle":"…"}  ← set by /rename (latest one wins)
//   {"type":"ai-title","aiTitle":"…"}          ← auto-generated fallback
// Both are re-appended periodically, so the latest custom-title is reliably in the
// tail; we also scan the head (ai-title is written at line 1, and to catch an early
// rename that wasn't re-appended). Reading/writing this keeps Box, pickup, the picker
// and the mobile app all showing ONE name. See writeCustomTitle()/the rename route.
function titleMeta(file) {
  let custom = '', ai = '';
  const scan = (buf) => {
    for (const line of buf.split('\n')) {
      if (!line.startsWith('{"type":"custom-title"') && !line.startsWith('{"type":"ai-title"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'custom-title' && o.customTitle) custom = o.customTitle;
      else if (o.type === 'ai-title' && o.aiTitle) ai = o.aiTitle;
    }
  };
  try {
    const { size } = statSync(file);
    const tailLen = Math.min(size, 128 * 1024);
    const fd = openSync(file, 'r');
    let hbuf = null;
    if (size > tailLen) { const headLen = Math.min(size, 32 * 1024); hbuf = Buffer.alloc(headLen); readSync(fd, hbuf, 0, headLen, 0); }
    const tbuf = Buffer.alloc(tailLen); readSync(fd, tbuf, 0, tailLen, size - tailLen);
    closeSync(fd);
    if (hbuf) scan(hbuf.toString('utf8'));   // head first…
    scan(tbuf.toString('utf8'));             // …tail last, so the newest custom-title wins
  } catch {}
  return { custom, ai };
}
// The human-facing name Claude itself shows for a session ('' if none yet).
function sessionCustomName(file) { const m = titleMeta(file); return m.custom || m.ai || ''; }

// Set a session's canonical title the way Claude does: append a custom-title meta-line
// to its JSONL (atomic O_APPEND for a short line). If a box-owned RC bridge is already
// attached, ALSO inject `/rename` so the running process updates and pushes the new
// title over the bridge to the official Claude app. Returns true if anything was written.
function writeCustomTitle(sessionId, name, { inject = true } = {}) {
  const clean = String(name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
  if (!sessionId || !clean) return false;
  let wrote = false;
  try {
    const file = jsonlPath(sessionId);
    if (file && existsSync(file)) {
      appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: clean, sessionId }) + '\n');
      wrote = true;
    }
  } catch {}
  // Push the rename to the RUNNING process so the official Claude app reflects it in
  // real time (a disk-only custom-title write never reaches the live bridge). This
  // reattaches ANY live box-local bridge — not just sessions held in THIS server's
  // memory — which is what was missing: after a box restart the in-memory map is empty,
  // so the old `rcEngine.get` gate almost never fired. injectIfLive never spawns a
  // bridge for a dormant session (those get the disk write only, picked up on resume)
  // and never fights an external owner. Skip mid-turn (RUNNING) and when inject:false
  // (e.g. delegate seeding the first turn), so the typed /rename can't collide.
  try { if (inject && !RUNNING.has(sessionId) && rcEngine.injectIfLive(sessionId, '/rename ' + clean)) wrote = true; } catch {}
  return wrote;
}
// Reliably stamp the JSONL custom-title once the file exists. With a PRE-MINTED session
// id (rc-engine mints it at spawn), `session_p` resolves immediately — BEFORE claude has
// created the JSONL — so a one-shot custom-title write right after spawn finds no file
// and silently no-ops (writeCustomTitle only appends when the file exists). That left
// delegated sessions ("INC-123: …") un-renamed in the official Claude app / CLI picker
// (which read the custom-title meta-line) even though the box app showed the name via its
// own RC/queue title. Poll briefly until the file appears so the title actually lands.
// inject:false — the seed turn is still running, so we don't type a /rename into it; the
// disk write is what the official app/picker read on open.
function stampTitleWhenReady(sessionId, title, tries = 24) {
  if (!sessionId || !title) return;
  try { if (writeCustomTitle(sessionId, title, { inject: false })) return; } catch {}
  if (tries <= 0) return;
  setTimeout(() => stampTitleWhenReady(sessionId, title, tries - 1), 500);
}

// last meaningful message in a session (read only the tail for speed)
function sessionPreview(file) {
  try {
    const st = statSync(file); const len = Math.min(st.size, 48 * 1024); const start = st.size - len;
    const fd = openSync(file, 'r'); const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, start); closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      if ((o.type === 'assistant' || o.type === 'user') && o.message) {
        const c = o.message.content;
        let t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
        t = (t || '').trim();
        if (t && !t.startsWith('<') && !t.startsWith('Caveat:')) return t.replace(/\s+/g, ' ').slice(0, 100);
      }
    }
  } catch {}
  return '';
}
// tail-read a session: last meaningful message text (preview) + whether the agent
// is waiting on the user (last turn was the assistant and it ended with a question).
function tailInfo(file) {
  try {
    const st = statSync(file); const len = Math.min(st.size, 48 * 1024); const start = st.size - len;
    const fd = openSync(file, 'r'); const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, start); closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      if ((o.type === 'assistant' || o.type === 'user') && o.message) {
        const c = o.message.content;
        let t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
        t = (t || '').trim();
        if (!t || t.startsWith('<') || t.startsWith('Caveat:')) continue;
        const role = o.message.role || o.type;
        return { preview: t.replace(/\s+/g, ' ').slice(0, 100), needsInput: role === 'assistant' && /[?？]["'）)\]]*\s*$/.test(t) };
      }
    }
  } catch {}
  return { preview: '', needsInput: false };
}
// session ids with a currently-running worker turn (set maintained by runWorker)
const RUNNING = new Set();

const ARCH_FILE = join(STATE_DIR, 'archived.json');
const loadArchived = () => { try { return new Set(JSON.parse(readFileSync(ARCH_FILE, 'utf8'))); } catch { return new Set(); } };
const saveArchived = (set) => { try { writeFileSync(ARCH_FILE, JSON.stringify([...set])); } catch {} };
const CODEX_FILE = join(STATE_DIR, 'codex-sessions.json');
const loadCodex = () => { try { return JSON.parse(readFileSync(CODEX_FILE, 'utf8')); } catch { return { sessions: {} }; } };
const saveCodex = (state) => { try { writeFileSync(CODEX_FILE, JSON.stringify(state, null, 2)); } catch {} };
// Delegation ledger: INC-id (e.g. "INC-917") -> array of delegation records, oldest→newest.
// The LAST entry is the current/primary delegation (the session the user delegated to most
// recently); the history is kept so a re-delegated ticket still shows every owner.
const DELEG_FILE = join(STATE_DIR, 'delegations.json');
const loadDelegations = () => { try { return JSON.parse(readFileSync(DELEG_FILE, 'utf8')); } catch { return {}; } };
const saveDelegations = (d) => { try { writeFileSync(DELEG_FILE, JSON.stringify(d, null, 2)); } catch {} };
const latestDelegation = (arr) => (Array.isArray(arr) && arr.length) ? arr[arr.length - 1] : null;
const DEFAULT_SETTINGS = {
  codex: { model: 'gpt-5.5', reasoningEffort: 'high' },
  claude: { model: 'opus', effort: 'xhigh' },
};
function normalizeSettings(settings = {}) {
  return {
    codex: { ...DEFAULT_SETTINGS.codex, ...((settings && settings.codex) || {}) },
    claude: { ...DEFAULT_SETTINGS.claude, ...((settings && settings.claude) || {}) },
  };
}
function ensureCodexSession(id, attrs = {}) {
  if (!id) return null;
  const state = loadCodex();
  const now = Date.now();
  const prev = state.sessions[id] || {};
  // Title precedence: an ESTABLISHED title always wins. attrs.title is derived from the
  // CURRENT turn's message text (msg.title || msg.text.slice(0,80)) and is only a sensible
  // name for the FIRST message of a brand-new session. On every resume turn it would be the
  // latest thing typed — so the old code clobbered a real title with "Continue" (or whatever
  // you just said) each turn. Only adopt attrs.title when there's no real title yet. A user
  // rename goes through names.json (the rename route), not here, so this never fights it.
  const established = prev.title && prev.title !== 'Codex chat' ? prev.title : '';
  state.sessions[id] = {
    id,
    agent: 'codex',
    title: established || attrs.title || prev.title || 'Codex chat',
    cwd: attrs.cwd || prev.cwd || DEFAULT_CWD,
    created: prev.created || attrs.created || now,
    lastUsed: attrs.lastUsed || now,
    preview: attrs.preview != null ? attrs.preview : (prev.preview || ''),
    messages: attrs.messages || prev.messages || [],
    settings: normalizeSettings(attrs.settings || prev.settings || {}),
    parentId: attrs.parentId || prev.parentId || null,
    parentTitle: attrs.parentTitle || prev.parentTitle || '',
  };
  saveCodex(state);
  return state.sessions[id];
}
function appendCodexMessage(id, role, text, extra = {}) {
  if (!id || (!text && !extra.parts)) return;
  const state = loadCodex();
  const now = Date.now();
  const prev = state.sessions[id] || { id, agent: 'codex', title: 'Codex chat', cwd: DEFAULT_CWD, created: now, messages: [] };
  const parts = extra.parts || [{ t: 'text', text: String(text || '') }];
  prev.messages = [...(prev.messages || []), { role, parts }].slice(-160);
  const plain = String(text || parts.filter((p) => p.t === 'text').map((p) => p.text).join(' ')).trim();
  if (role === 'user' && (!prev.title || prev.title === 'Codex chat')) prev.title = plain.slice(0, 80) || 'Codex chat';
  if (role === 'assistant' && plain) prev.preview = plain.replace(/\s+/g, ' ').slice(0, 160);
  prev.lastUsed = now;
  state.sessions[id] = prev;
  saveCodex(state);
}

// META: the real skill / slash-command list as reported by claude's init event
// (plugin & built-in skills aren't on disk, so we can't find them by scanning dirs).
const META_FILE = join(STATE_DIR, 'meta.json');
let META = (() => { try { return JSON.parse(readFileSync(META_FILE, 'utf8')); } catch { return { skills: [], slashCommands: [] }; } })();
function captureMeta(o) {
  if (!o || !Array.isArray(o.skills)) return;
  META = { skills: o.skills, slashCommands: o.slash_commands || [] };
  try { writeFileSync(META_FILE, JSON.stringify(META)); } catch {}
}

// "Automated" sessions = unattended background agents you run on a schedule (cron, etc.).
// They can number in the thousands and flood the list, so they get their own category/tab
// and are kept OUT of All + status tabs. Detection is purely by project dir (cheap; no file
// read). Configure which dirs count as automated via AUTO_DIRS (comma-separated substrings,
// e.g. "cron-agent,nightly"); defaults to a single generic marker.
const AUTO_DIRS = cfg('AUTO_DIRS', 'box-automation').split(',').map((s) => s.trim()).filter(Boolean);
const AUTO_DIR_RE = AUTO_DIRS.length
  ? new RegExp('(' + AUTO_DIRS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')')
  : /$.^/;  // never matches when no AUTO_DIRS configured
const isAutoFile = (file) => !!file && AUTO_DIR_RE.test(basename(dirname(file)));

// Optional fine-grained subcategory for an auto session so the Automated tab can be broken
// down instead of one undifferentiated dump. Cached to ~/.cc-mobile/auto-cat.json by id.
const AUTO_CAT_FILE = join(STATE_DIR, 'auto-cat.json');
let autoCat = (() => { try { return JSON.parse(readFileSync(AUTO_CAT_FILE, 'utf8')); } catch { return {}; } })();
let autoCatDirty = false;
function saveAutoCat() { if (!autoCatDirty) return; try { writeFileSync(AUTO_CAT_FILE, JSON.stringify(autoCat)); } catch {} autoCatDirty = false; }
// Return the first real user-message text. Reads the file in chunks and STOPS
// at the first user line, so it's cheap even on multi-MB transcripts — but it
// won't be fooled by big image/attachment lines that precede the prompt (those
// can push the real opening well past any fixed head window).
function openingPrompt(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const CHUNK = 64 * 1024, CAP = 4 * 1024 * 1024;
    const buf = Buffer.alloc(CHUNK);
    let acc = '', pos = 0;
    while (pos < CAP) {
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      pos += n; acc += buf.toString('utf8', 0, n);
      let nl;
      while ((nl = acc.indexOf('\n')) >= 0) {
        const line = acc.slice(0, nl); acc = acc.slice(nl + 1);
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.type === 'user' && o.message) {
          const c = o.message.content;
          let t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
          t = t.trim();
          if (t && !t.startsWith('<') && !t.startsWith('/') && !t.startsWith('Caveat:')) return t.slice(0, 400);
        }
      }
    }
  } catch {} finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
  return '';
}
function autoSubcat(id, file) {
  // A private overlay may classify auto-sessions into its own buckets (e.g. by prompt/dir).
  if (overlay.categorizeAuto) { try { const k = overlay.categorizeAuto({ id }, file); if (k) return k; } catch {} }
  const dir = basename(dirname(file || ''));
  // Generic sub-buckets. Add your own dir markers here if you run scheduled agents in
  // dedicated directories and want them split out under the Automated tab.
  if (/heal/.test(dir)) return 'healer';
  if (/cron|nightly|scheduled/.test(dir)) return 'scheduled';
  return 'other-auto';
}

function listSessions({ limit = 40, filter = 'all' } = {}) {
  const rc = readRcRegistry();
  const names = loadNames();
  const archived = loadArchived();
  const files = [];
  const seenIds = new Set();
  for (const dir of eachProjectDir()) {
    let entries = [];
    try { entries = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch {}
    for (const f of entries) {
      const full = join(dir, f);
      let mtime = 0, size = 0;
      try { const st = statSync(full); mtime = st.mtimeMs; size = st.size; } catch { continue; }
      if (size < 200) continue; // skip empty/stub sessions
      const id = f.replace(/\.jsonl$/, '');
      if (seenIds.has(id)) continue; // a session id is unique across accounts; keep the first seen
      seenIds.add(id);
      files.push({ id, file: full, mtime });
    }
  }
  const codexSessions = Object.values(loadCodex().sessions || {}).map((s) => ({
    id: s.id, agent: 'codex', file: null, mtime: s.lastUsed || s.created || 0,
    title: s.title || 'Codex chat', cwd: s.cwd || DEFAULT_CWD, preview: s.preview || '',
    parentId: s.parentId || null, parentTitle: s.parentTitle || '',
  }));
  files.sort((a, b) => b.mtime - a.mtime);
  const items = files.concat(codexSessions).sort((a, b) => b.mtime - a.mtime);
  const now = Date.now();
  const rcIds = new Set(Object.keys(rc));
  // Live = supervisor-registered (TSV) ∪ box-local --remote-control bridges discovered
  // at runtime (survives a Box-app-server restart that wiped the in-memory map).
  const liveIds = new Set([...rcIds, ...LIVE_BRIDGES.keys()]);
  // tail-scan the most-recent non-archived sessions for preview + needs-input
  const scan = new Map();
  for (const f of files) { if (scan.size >= 130) break; if (!archived.has(f.id)) scan.set(f.id, tailInfo(f.file)); }
  const statusOf = (id) => archived.has(id) ? 'archived' : RUNNING.has(id) ? 'working' : (scan.get(id) && scan.get(id).needsInput) ? 'needs_input' : liveIds.has(id) ? 'live' : 'idle';
  const byId = new Map(items.map((f) => [f.id, f]));
  const isAuto = (id) => isAutoFile((byId.get(id) || {}).file);
  // counts over ALL sessions. Auto sessions are tallied only under `auto` (and
  // `archived` if archived) so they never inflate All/Working/Needs input/Live.
  // autoSub breaks the auto total into subcategories for the Automated sub-tabs.
  const counts = { all: 0, working: 0, needs_input: 0, live: 0, idle: 0, archived: 0, auto: 0 };
  const autoSub = {};
  for (const f of items) {
    if (archived.has(f.id)) { counts.archived++; continue; }
    if (f.file && isAutoFile(f.file)) { counts.auto++; const sk = autoSubcat(f.id, f.file); autoSub[sk] = (autoSub[sk] || 0) + 1; continue; }
    const st = statusOf(f.id); counts[st]++; counts.all++;
  }
  saveAutoCat();
  // candidate set for the requested filter. `auto` shows all auto sessions;
  // `auto:<subkey>` narrows to one subcategory.
  const [fbase, fsub] = String(filter || 'all').split(':');
  let cand;
  if (filter === 'archived') cand = items.filter((f) => archived.has(f.id));
  else if (fbase === 'auto') cand = items.filter((f) => !archived.has(f.id) && f.file && isAutoFile(f.file) && (!fsub || autoSubcat(f.id, f.file) === fsub));
  else if (filter && filter !== 'all') cand = items.filter((f) => !(f.file && isAutoFile(f.file)) && statusOf(f.id) === filter);
  else cand = items.filter((f) => !archived.has(f.id) && !(f.file && isAutoFile(f.file)));
  const chosen = [], seen = new Set();
  if (!filter || filter === 'all') { for (const id of liveIds) if (!archived.has(id) && !isAuto(id)) { chosen.push(byId.get(id) || { id, file: null, mtime: 0 }); seen.add(id); } }
  for (const f of cand) { if (chosen.length >= limit) break; if (!seen.has(f.id)) { chosen.push(f); seen.add(f.id); } }
  const out = chosen.map((s) => {
    const r = rc[s.id];
    const lb = !r ? LIVE_BRIDGES.get(s.id) : null; // discovered box-local live bridge (not in TSV)
    const cwd = r ? r.cwd : (lb ? lb.cwd : (s.cwd || (s.file ? decodeCwd(dirname(s.file)) : DEFAULT_CWD)));
    let hasAttention = false;
    try {
      const af = readFileSync(sessionAttFile(s.id), 'utf8');
      const ni = af.split('## Needs your input')[1];
      if (ni) hasAttention = /^- .+/m.test(ni.split('##')[0]);
    } catch {}
    // Canonical name = what Claude itself shows (custom-title from /rename, else
    // ai-title). Legacy box renames in names.json still win over an ai-title so old
    // names aren't lost. rcName ("box-xxxx") is a last-resort surface label.
    const tm = s.file ? titleMeta(s.file) : { custom: '', ai: '' };
    return {
      id: s.id,
      agent: s.agent || 'claude',
      title: tm.custom || names[s.id] || tm.ai || (r && r.rcName) || (lb && lb.rcName) || s.title || (s.file && sessionTitle(s.file)) || 'session',
      cwd,
      preview: s.preview || (scan.get(s.id) && scan.get(s.id).preview) || (s.file ? sessionPreview(s.file) : ''),
      parentId: s.parentId || null, parentTitle: s.parentTitle || '',
      live: !!r || !!lb, rcName: r ? r.rcName : (lb ? lb.rcName : null), note: r ? r.note : null, archived: archived.has(s.id),
      status: statusOf(s.id), category: s.file && isAutoFile(s.file) ? 'auto' : 'main',
      subcat: s.file && isAutoFile(s.file) ? autoSubcat(s.id, s.file) : null,
      pinned: (!!r || !!lb) && !archived.has(s.id), mtime: s.mtime, renamed: !!(tm.custom || names[s.id]),
      hasAttention,
    };
  });
  out.sort((a, b) => (b.pinned - a.pinned) || (b.mtime - a.mtime));
  counts.autoSub = autoSub;
  return { sessions: out, counts };
}
// project dir name "-home-user-code" -> "/home/user/code"
function decodeCwd(dir) {
  const base = basename(dir);
  if (base === '-') return '/';
  return base.replace(/^-/, '/').replace(/-/g, '/');
}

const HIST_MSG_LIMIT = 400;
const HIST_TAIL_BYTES = 6 * 1024 * 1024; // read last 6MB for large files
function parseJsonlMessages(raw) {
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if ((o.type === 'user' || o.type === 'assistant') && o.message) {
      const role = o.message.role || o.type;
      const c = o.message.content;
      const parts = [];
      if (typeof c === 'string') { if (c.trim()) parts.push({ t: 'text', text: c }); }
      else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'text' && b.text) parts.push({ t: 'text', text: b.text });
          else if (b.type === 'tool_use') parts.push({ t: 'tool', name: b.name, input: b.input });
          else if (b.type === 'tool_result' || b.type === 'thinking') { /* skip */ }
        }
      }
      const isToolResultOnly = Array.isArray(c) && c.every((b) => b.type === 'tool_result');
      if (parts.length && !isToolResultOnly) {
        const firstText = parts.find((p) => p.t === 'text');
        if (role === 'user' && firstText && (firstText.text.startsWith('<') || firstText.text.startsWith('Caveat:'))) continue;
        messages.push({ role, parts, ts: o.timestamp || null });
      }
    }
  }
  return messages;
}
function readJsonlChunk(file, endOffset) {
  // Read up to HIST_TAIL_BYTES ending at endOffset (or file end if null).
  const { size } = statSync(file);
  const end = endOffset != null ? Math.min(endOffset, size) : size;
  if (end <= 0) return { raw: '', startOffset: 0 };
  const readLen = Math.min(end, HIST_TAIL_BYTES);
  const start = end - readLen;
  if (start === 0 && readLen === size) return { raw: readFileSync(file, 'utf8'), startOffset: 0 };
  const buf = Buffer.allocUnsafe(readLen);
  const fd = openSync(file, 'r');
  readSync(fd, buf, 0, readLen, start);
  closeSync(fd);
  const raw = buf.toString('utf8');
  // drop the first (possibly partial) line when we started mid-file
  const nl = raw.indexOf('\n');
  return { raw: start > 0 && nl >= 0 ? raw.slice(nl + 1) : raw, startOffset: start };
}
function sessionHistory(id, { before = null } = {}) {
  const codex = (loadCodex().sessions || {})[id];
  if (codex) return { messages: (codex.messages || []).slice(-HIST_MSG_LIMIT), hasMore: false, cursor: 0, cwd: codex.cwd || DEFAULT_CWD, agent: 'codex', settings: normalizeSettings(codex.settings || {}), parentId: codex.parentId || null, parentTitle: codex.parentTitle || '' };
  const file = findSessionFile(id);
  if (!file) return { messages: [], hasMore: false, cursor: 0, cwd: DEFAULT_CWD };
  const { raw, startOffset } = readJsonlChunk(file, before);
  const messages = parseJsonlMessages(raw).slice(-HIST_MSG_LIMIT);
  return { messages, hasMore: startOffset > 0, cursor: startOffset, cwd: decodeCwd(dirname(file)), agent: 'claude', settings: normalizeSettings({}) };
}

// ---- helpers: available skills/commands for the "/" picker ----------------
function skillDesc(skillMd) {
  try {
    const text = readFileSync(skillMd, 'utf8').slice(0, 2500);
    const fm = text.match(/description:\s*>?-?\s*([\s\S]*?)(?:\n[a-z][\w-]*:|\n#|$)/i);
    if (fm) return fm[1].replace(/\s+/g, ' ').trim().slice(0, 90);
  } catch {}
  return '';
}
function scanCommands() {
  const out = [];
  const seen = new Set();
  const add = (name, desc, kind) => { if (name && !seen.has(name)) { seen.add(name); out.push({ name, desc: desc || '', kind }); } };
  const skillDirs = [join(HOME, '.claude', 'skills'), join(DEFAULT_CWD, '.claude', 'skills'), join(HOME, 'development', '.claude', 'skills')];
  for (const sd of skillDirs) {
    try {
      for (const d of readdirSync(sd, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const skillMd = join(sd, d.name, 'SKILL.md');
        add(d.name, skillDesc(skillMd), 'skill');
      }
    } catch {}
  }
  // full skill list reported by claude (plugin/built-in skills aren't on disk) —
  // dir-scanned ones above keep their descriptions; the rest get added by name.
  for (const name of (META.skills || [])) add(name, '', 'skill');
  const cmdDirs = [join(HOME, '.claude', 'commands'), join(DEFAULT_CWD, '.claude', 'commands')];
  for (const cd of cmdDirs) {
    try { for (const f of readdirSync(cd)) if (f.endsWith('.md')) add(f.replace(/\.md$/, ''), '', 'command'); } catch {}
  }
  // skills first (they work in headless -p), then commands, alphabetical within group
  return out.sort((a, b) => (a.kind === 'skill' ? 0 : 1) - (b.kind === 'skill' ? 0 : 1) || a.name.localeCompare(b.name));
}
function scanCodexCommands() {
  const out = [];
  const seen = new Set();
  const add = (name, desc) => { if (name && !seen.has(name)) { seen.add(name); out.push({ name, desc: desc || '', kind: 'skill' }); } };
  const skillName = (skillMd) => {
    const parts = skillMd.split('/');
    const skillIdx = parts.lastIndexOf('skills');
    if (skillIdx > 1 && parts[skillIdx + 1]) {
      if (parts[skillIdx + 1] === '.system' && parts[skillIdx + 2]) return parts[skillIdx + 2];
      const skill = parts[skillIdx + 1];
      const cacheIdx = parts.indexOf('cache');
      const plugin = cacheIdx >= 0 && skillIdx > cacheIdx ? parts[cacheIdx + 2] : null;
      return plugin && plugin !== '.system' ? `${plugin}:${skill}` : skill;
    }
    return basename(dirname(skillMd));
  };
  const walk = (dir, depth = 0) => {
    if (depth > 7) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      if (e.isFile() && e.name === 'SKILL.md') add(skillName(full), skillDesc(full));
      else if (e.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(join(HOME, '.codex', 'skills'));
  walk(join(HOME, '.codex', 'plugins', 'cache'));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- app ------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '2mb' }));
const authOk = (req) => {
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;
  return (bearer || req.query.token) === AUTH_TOKEN;
};
const requireAuth = (req, res, next) => (authOk(req) ? next() : res.status(401).json({ error: 'unauthorized' }));

app.post('/api/login', (req, res) =>
  (req.body && req.body.token) === AUTH_TOKEN ? res.json({ ok: true }) : res.status(401).json({ error: 'bad token' }));

app.get('/api/sessions', requireAuth, (req, res) => { const r = listSessions({ filter: req.query.filter || 'all' }); res.json({ sessions: r.sessions, counts: r.counts, defaultCwd: DEFAULT_CWD }); });
app.post('/api/sessions/:id/archive', requireAuth, (req, res) => {
  const set = loadArchived(); const on = !(req.body && req.body.archived === false);
  if (on) set.add(req.params.id); else set.delete(req.params.id);
  saveArchived(set); res.json({ ok: true, archived: on });
});
app.get('/api/sessions/:id/history', requireAuth, (req, res) => {
  const before = req.query.before != null ? parseInt(req.query.before, 10) : null;
  res.json(sessionHistory(req.params.id, { before }));
});
// All user messages from the full JSONL (for the "my messages" browser)
app.get('/api/sessions/:id/user-messages', requireAuth, async (req, res) => {
  const file = findSessionFile(req.params.id);
  if (!file) return res.json({ messages: [] });
  const messages = [];
  try {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'user' || !o.message) continue;
      const c = o.message.content;
      const isToolResultOnly = Array.isArray(c) && c.every((b) => b.type === 'tool_result');
      if (isToolResultOnly) continue;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        for (const b of c) { if (b.type === 'text') text += (text ? '\n' : '') + b.text; }
      }
      text = text.replace(/^\[Image attached at .+?\]\n?/gm, '').trim();
      if (!text || text.startsWith('<') || text.startsWith('Caveat:')) continue;
      messages.push({ text, ts: o.timestamp || null });
    }
  } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }
  res.json({ messages });
});
// Export full conversation as markdown (up to 50MB of JSONL)
app.get('/api/sessions/:id/export', requireAuth, (req, res) => {
  const file = findSessionFile(req.params.id);
  if (!file) return res.status(404).end();
  try {
    const MAX = 50 * 1024 * 1024;
    const { size } = statSync(file);
    let raw;
    if (size <= MAX) {
      raw = readFileSync(file, 'utf8');
    } else {
      const buf = Buffer.allocUnsafe(MAX);
      const fd = openSync(file, 'r'); readSync(fd, buf, 0, MAX, size - MAX); closeSync(fd);
      const s = buf.toString('utf8'); const nl = s.indexOf('\n'); raw = nl >= 0 ? s.slice(nl + 1) : s;
    }
    const messages = parseJsonlMessages(raw);
    const title = sessionTitle(file) || req.params.id.slice(0, 8);
    const header = `# ${title}\n\nExported ${messages.length} messages\n\n`;
    const body = messages.map((m) => {
      const role = m.role === 'user' ? '**You**' : '**Claude**';
      const text = m.parts.filter((p) => p.t === 'text').map((p) => p.text).join('\n').trim();
      const tools = m.parts.filter((p) => p.t === 'tool').map((p) => `\`[${p.name}]\``).join(' ');
      return `${role}\n\n${text || ''}${tools ? (text ? '\n\n' : '') + tools : ''}`.trim();
    }).filter((s) => s.length > 10).join('\n\n---\n\n');
    const fname = title.replace(/[^a-z0-9]/gi, '-').slice(0, 50).replace(/-+$/, '') + '.md';
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(header + body);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Per-session attention file: ~/.factory/session-attention/<sessionId>.md (auto-updated after turns)
app.get('/api/sessions/:id/attention', requireAuth, (req, res) => {
  const s = RT.get(resolveKey(req.params.id)) || [...RT.values()].find((x) => x.sessionId === req.params.id);
  const sid = (s && s.sessionId) || req.params.id;
  const file = sessionAttFile(sid);
  try {
    const text = readFileSync(file, 'utf8');
    res.json({ markdown: text, file, sessionId: sid });
  } catch {
    res.json({ markdown: null, file, sessionId: sid });
  }
});
app.post('/api/sessions/:id/rename', requireAuth, (req, res) => {
  // Sync the rename to Claude's OWN session title (custom-title meta-line + live
  // /rename) so the resume picker, pickup, and the official Claude app all match.
  // Codex sessions have no Claude JSONL → keep the box-local names.json store.
  const id = req.params.id;
  const name = String((req.body && req.body.name) || '').slice(0, 80);
  const isCodex = !!(loadCodex().sessions || {})[id];
  const wrote = isCodex ? false : writeCustomTitle(id, name);
  const names = loadNames();
  if (wrote) { if (names[id] != null) { delete names[id]; saveNames(names); } } // drop legacy shadow
  else { names[id] = name; saveNames(names); }                                 // codex / no-jsonl-yet fallback
  res.json({ ok: true, synced: wrote });
});
app.get('/api/commands', requireAuth, (req, res) => res.json({ commands: req.query.agent === 'codex' ? scanCodexCommands() : scanCommands() }));

// ---- Accounts: pool/switch Claude accounts via an external account broker -----
// The `/login` dialog wraps the headless OAuth flow (authorize URL → paste code) and an
// API-key option, writing each account's creds into its own config dir and registering it
// with the broker. Optional — needs a broker (set CC_BROKER_JS); see server/accounts.mjs.
const acctRoute = (fn) => [requireAuth, async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
}];
app.get('/api/accounts', ...acctRoute(async () => ({ ...(await accounts.listAccounts()), consoleKeysUrl: accounts.consoleKeysUrl, manageUsage: accounts.manageUsageUrls })));
app.post('/api/accounts/refresh-usage', ...acctRoute(async () => ({ ...(await accounts.refreshUsage()), consoleKeysUrl: accounts.consoleKeysUrl, manageUsage: accounts.manageUsageUrls })));
app.post('/api/accounts/oauth/start', ...acctRoute((req) => accounts.startOAuth(req.body || {})));
app.post('/api/accounts/oauth/complete', ...acctRoute((req) => accounts.completeOAuth(req.body || {})));
app.post('/api/accounts/apikey', ...acctRoute((req) => accounts.saveApiKey(req.body || {})));
app.post('/api/accounts/remove', ...acctRoute((req) => accounts.removeAccount((req.body || {}).id)));
app.post('/api/accounts/primary', ...acctRoute((req) => accounts.setPrimary((req.body || {}).id)));
app.post('/api/accounts/cooldown', ...acctRoute((req) => accounts.cooldown((req.body || {}).id, (req.body || {}).minutes)));
app.post('/api/accounts/clear', ...acctRoute((req) => accounts.clearCooldown((req.body || {}).id)));

// "Needs you" inbox — Linear-backed (any issue on your team labeled NEEDS_LABEL). Any
// agent can file an item via the Linear API / your harness; it survives compaction and new
// sessions. The chat UI renders these as cards you can act on. 🔴 = Urgent, 🟡 = High.
// Returns the count of OPEN items so the header bell can badge unanswered ones.
// Disabled (returns empty) unless LINEAR_API_KEY + LINEAR_TEAM_ID are configured.
app.get('/api/needs-attention', requireAuth, async (req, res) => {
  try {
    const data = await linearGql(`{ issues(first: 50, orderBy: updatedAt, filter: {
        team: { id: { eq: "${LINEAR_TEAM_ID}" } },
        labels: { name: { eq: "${NEEDS_LABEL}" } },
        state: { type: { in: ["triage","backlog","unstarted","started"] } }
      }) { nodes { identifier title url priority description createdAt state { name } } } }`);
    const nodes = (data && data.issues && data.issues.nodes) || [];
    const items = nodes.map((n) => {
      const status = n.priority === 1 ? '\u{1F534}' : n.priority === 2 ? '\u{1F7E1}' : '\u{26AA}';
      const desc = (n.description || '').trim();
      const ask = (desc.split('\n').find((l) => l.trim()) || n.title).slice(0, 300);
      return { open: true, status, date: (n.createdAt || '').slice(0, 10), title: n.title,
        identifier: n.identifier, url: n.url, ask, what: desc.slice(0, 1500),
        decision: '', rec: '', plan: '', statusLine: n.state ? n.state.name : '' };
    });
    res.json({ items, open: items.length });
  } catch (e) {
    res.json({ items: [], open: 0, error: String((e && e.message) || e) });
  }
});

// ---- pipelines health: recent meetings + signals recorded to an optional notes "brain".
// Honor $BRAIN_DIR, else fall back to ~/brain (a dir with a meetings/ subdir). Optional —
// the whole Pipelines tab is empty (and harmless) if you don't keep a brain dir.
const BRAIN_DIR_CANDIDATES = [
  process.env.BRAIN_DIR,
  localEnv.BRAIN_DIR,
  extraEnv.BRAIN_DIR,
  join(HOME, 'brain'),
].filter(Boolean);
function findBrainDir() {
  for (const d of BRAIN_DIR_CANDIDATES) {
    try { if (existsSync(join(d, 'meetings')) || existsSync(join(d, 'index.json'))) return d; } catch {}
  }
  return null;
}
function readFrontmatter(file, keys) {
  const out = {};
  try {
    const fd = openSync(file, 'r'); const buf = Buffer.alloc(4096); const n = readSync(fd, buf, 0, 4096, 0); closeSync(fd);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (line.trim() === '---' && Object.keys(out).length) break; // end of frontmatter
      const m = line.match(/^([a-z_]+):\s*(.*)$/i);
      if (m && keys.includes(m[1])) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch {}
  return out;
}
function recentFromBrain(brain, sub, keys, limit = 15) {
  const dir = join(brain, sub);
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => ({ f, m: (() => { try { return statSync(join(dir, f)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.m - a.m);
  } catch {}
  return { count: files.length, items: files.slice(0, limit).map(({ f, m }) => ({ ...readFrontmatter(join(dir, f), keys), mtime: m, path: join(dir, f) })) };
}
function readHealth() {
  try { return JSON.parse(readFileSync(join(HOME, '.factory', 'pipeline-health.json'), 'utf8')); } catch { return null; }
}
// Dream-cycle run results: the LAST run's outcome + the per-session decisions the
// judge LLM made (scope skips w/ reasons, items auto-filed). This is "what the LLM
// thought" of the run — surfaced so it isn't buried in a log nobody reads.
function readDreamRuns() {
  // Optional: point DREAM_LOG at a log your scheduled-agent setup writes. Off by default.
  const file = [process.env.DREAM_LOG, localEnv.DREAM_LOG].filter(Boolean).find((p) => { try { return existsSync(p); } catch { return false; } });
  if (!file) return null;
  let lines = [];
  try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-500); } catch { return null; }
  let startIdx = 0;
  for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].includes('run start')) { startIdx = i; break; } }
  const block = lines.slice(startIdx);
  const at = (block[0] && block[0].match(/\[([^\]]+)\]/) || [])[1] || '';
  let summary = '', found = '';
  const decisions = [];
  for (const l of block) {
    const f = l.match(/found (\d+) transcript/); if (f) found = f[1];
    if (/distilled \d+ session/.test(l)) summary = l.replace(/^\[[^\]]+\]\s*/, '').trim();
    const skip = l.match(/scope-gate SKIP \(([^)]*)\):\s*(.+)/); if (skip) decisions.push({ action: 'skip', text: skip[2].trim() });
    const fil = l.match(/Auto-filing in-scope item to Linear:\s*"(.+)"/); if (fil) decisions.push({ action: 'filed', text: fil[1] });
    if (/kept \d+ fact/.test(l)) { const k = l.match(/kept (\d+) fact/); if (k) decisions.push({ action: 'distilled', text: `kept ${k[1]} durable fact(s)` }); }
  }
  return { lastRunAt: at, found, summary, decisions: decisions.slice(-16) };
}
// Harness activity feed — the event stream (meetings/emails/Linear/locks/session-outcomes)
// + active resource locks. Surfaces where the user looks (replaces Telegram alerts).
function readActivity() {
  const FAC = join(HOME, '.factory');
  let events = [];
  try {
    events = readFileSync(join(FAC, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .slice(-40).reverse();
  } catch {}
  let locks = [];
  try {
    for (const f of readdirSync(join(FAC, 'locks'))) {
      if (!f.endsWith('.json')) continue;
      try {
        const l = JSON.parse(readFileSync(join(FAC, 'locks', f), 'utf8'));
        const age = (Date.now() - Date.parse(l.since)) / 1000;
        if (age <= (l.ttl || 7200)) locks.push({ resource: l.resource, agent: l.agent, task: l.task, ageMin: Math.round(age / 60) });
      } catch {}
    }
  } catch {}
  return { events, locks };
}
function readPipelines() {
  const health = readHealth();
  const activity = readActivity();
  const brain = findBrainDir();
  if (!brain) return { brainDir: null, health, activity, meetings: { count: 0, items: [] }, emails: { count: 0, items: [] } };
  const meetings = recentFromBrain(brain, 'meetings', ['title', 'date', 'recording_status', 'transcript_source']);
  const emails = recentFromBrain(brain, 'signals', ['from', 'subject', 'priority', 'triage_action', 'source', 'date', 'ingested_at']);
  return { brainDir: brain, health, activity, meetings, emails };
}
app.get('/api/pipelines', requireAuth, (req, res) => res.json(readPipelines()));

// ---- Linear integration: view an issue + its PR, close the ticket, merge the PR.
const LINEAR_KEY = cfg('LINEAR_API_KEY');
const GH_TOKEN = cfg('GITHUB_TOKEN');
// OpenAI — used (optionally) for the cheap per-session morning-brief refresh.
const OPENAI_KEY = cfg('OPENAI_API_KEY');
const OPENAI_ENDPOINT = (cfg('OPENAI_ENDPOINT', 'https://api.openai.com/v1')).replace(/\/$/, '');
const BOX_ATTENTION_MODEL = cfg('BOX_ATTENTION_MODEL', 'gpt-4o-mini'); // cheap; override via env

// Is the `codex` CLI installed? (Codex chats are optional.) Cached after first probe.
let _codexAvail = null;
function codexAvailable() {
  if (_codexAvail !== null) return _codexAvail;
  try { execSync('command -v codex', { stdio: 'ignore' }); _codexAvail = true; }
  catch { _codexAvail = false; }
  return _codexAvail;
}

// Lightweight client bootstrap: lets the frontend learn $HOME (for path shortening),
// the owner name, and which optional integrations are wired so it can hide the Board /
// brain UI when they aren't configured. Safe to expose (no secrets).
const LINEAR_ENABLED = !!(LINEAR_KEY && LINEAR_TEAM_ID);
app.get('/api/config', requireAuth, (req, res) => res.json({
  home: HOME,
  ownerName: OWNER_NAME,
  features: {
    linear: LINEAR_ENABLED,
    brain: !!findBrainDir(),
    voice: !!(ELEVEN_KEY || DEEPGRAM_KEY),
    codex: codexAvailable(),
  },
  // Display names for Automated-tab sub-buckets; a private overlay can add its own.
  subLabels: overlay.subLabels || {},
}));

// Let a private overlay register extra routes / run init (business endpoints, etc.).
if (overlay.routes) { try { overlay.routes(app, { requireAuth, HOME, DEFAULT_CWD }); } catch (e) { console.error('[box] overlay.routes failed:', e && e.message); } }
if (overlay.onReady) { try { overlay.onReady({ HOME, DEFAULT_CWD }); } catch (e) { console.error('[box] overlay.onReady failed:', e && e.message); } }

async function linearGql(query, variables) {
  const r = await fetch('https://api.linear.app/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: LINEAR_KEY }, body: JSON.stringify(variables ? { query, variables } : { query }) });
  const j = await r.json(); if (j.errors) throw new Error(JSON.stringify(j.errors)); return j.data;
}
const issueNum = (id) => String(id || '').replace(/[^0-9]/g, '');
function prFromText(t) { const m = String(t || '').match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/); return m ? { owner: m[1], repo: m[2], number: Number(m[3]), url: m[0] } : null; }
async function fetchLinearIssue(id) {
  const d = await linearGql(`{ issues(filter:{ number:{ eq:${issueNum(id)} }${TEAM_KEY_FILTER} }){ nodes { id identifier title url state{name type} team{id} attachments{nodes{url title}} comments{nodes{body}} } } }`);
  const it = (d.issues.nodes || [])[0]; if (!it) return null;
  let pr = (it.attachments.nodes || []).map((a) => prFromText(a.url)).find(Boolean)
    || (it.comments.nodes || []).map((c) => prFromText(c.body)).find(Boolean);
  if (pr && GH_TOKEN) {
    try { const r = await fetch(`https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, { headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github+json' } }); if (r.ok) { const p = await r.json(); pr.state = p.merged ? 'merged' : p.state; pr.title = p.title; pr.mergeable = p.mergeable; } } catch {}
  }
  return { id: it.id, identifier: it.identifier, title: it.title, url: it.url, state: it.state, teamId: it.team.id, pr };
}
app.get('/api/linear/:id', requireAuth, async (req, res) => {
  if (!LINEAR_KEY) return res.status(500).json({ error: 'no LINEAR_API_KEY' });
  try { const r = await fetchLinearIssue(req.params.id); r ? res.json(r) : res.status(404).json({ error: 'not found' }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Kanban board: all open INC issues grouped by workflow state (+ recent Done),
// ordered Backlog → Todo → In Progress → In Review → Done. GLOBAL (not per-cwd),
// so it reflects real current status regardless of which dir the session runs in.
const BOARD_TEAM = LINEAR_TEAM_ID;
const BOARD_FIELDS = 'identifier title url priority updatedAt state { name type position } labels { nodes { name } } assignee { displayName }';
const BOARD_RANK = { triage: 0, backlog: 1, unstarted: 2, started: 3, completed: 4 };
app.get('/api/linear-board', requireAuth, async (req, res) => {
  if (!LINEAR_KEY) return res.status(500).json({ error: 'no LINEAR_API_KEY' });
  try {
    const sd = await linearGql(`{ team(id:"${BOARD_TEAM}"){ states{ nodes{ name type position } } } }`);
    const states = ((sd.team && sd.team.states && sd.team.states.nodes) || [])
      .filter((s) => s.type in BOARD_RANK)                       // drop canceled/duplicate
      .sort((a, b) => (BOARD_RANK[a.type] - BOARD_RANK[b.type]) || (a.position - b.position));
    const active = await linearGql(`{ issues(first: 250, orderBy: updatedAt, filter: {
      team: { id: { eq: "${BOARD_TEAM}" } }, state: { type: { in: ["triage","backlog","unstarted","started"] } }
    }) { nodes { ${BOARD_FIELDS} } } }`);
    const done = await linearGql(`{ issues(first: 30, orderBy: updatedAt, filter: {
      team: { id: { eq: "${BOARD_TEAM}" } }, state: { type: { eq: "completed" } }
    }) { nodes { ${BOARD_FIELDS} } } }`);
    const activeNodes = (active.issues && active.issues.nodes) || [];
    const delg = loadDelegations();           // box-local delegation ledger → board badge
    const byState = new Map();
    for (const n of [...activeNodes, ...((done.issues && done.issues.nodes) || [])]) {
      if (!byState.has(n.state.name)) byState.set(n.state.name, []);
      const dl = latestDelegation(delg[n.identifier]);
      byState.get(n.state.name).push({
        id: n.identifier, title: n.title, url: n.url, priority: n.priority || 0,
        updatedAt: n.updatedAt, labels: ((n.labels && n.labels.nodes) || []).map((l) => l.name),
        assignee: (n.assignee && n.assignee.displayName) || null,
        delegation: dl ? { sessionId: dl.sessionId, sessionTitle: dl.sessionTitle, agent: dl.agent, kind: dl.kind, ts: dl.ts } : null,
      });
    }
    // Seed a column per workflow state (in order) so empty columns still show the
    // board's structure. Done is labeled "recent" (capped) — it isn't "open" work.
    const columns = states.map((s) => ({
      name: s.name, type: s.type, recent: s.type === 'completed',
      issues: byState.get(s.name) || [], count: (byState.get(s.name) || []).length,
    }));
    res.json({ columns, total: activeNodes.length, generatedAt: new Date().toISOString() });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});
app.post('/api/linear/:id/done', requireAuth, async (req, res) => {
  try {
    const it = await fetchLinearIssue(req.params.id); if (!it) return res.status(404).json({ error: 'not found' });
    const ws = await linearGql(`{ team(id:"${it.teamId}"){ states{ nodes{ id name type } } } }`);
    const done = ws.team.states.nodes.find((s) => s.type === 'completed');
    await linearGql(`mutation{ issueUpdate(id:"${it.id}", input:{ stateId:"${done.id}" }){ success } }`);
    res.json({ ok: true, state: done.name });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/linear/:id/merge', requireAuth, async (req, res) => {
  if (!GH_TOKEN) return res.status(500).json({ error: 'no GITHUB_TOKEN' });
  try {
    const it = await fetchLinearIssue(req.params.id); if (!it || !it.pr) return res.status(404).json({ error: 'no PR linked' });
    const { owner, repo, number } = it.pr;
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}/merge`, { method: 'PUT', headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github+json' }, body: JSON.stringify({ merge_method: 'squash' }) });
    const j = await r.json();
    if (!r.ok) return res.status(400).json({ error: j.message || 'merge failed' });
    res.json({ ok: true, merged: j.merged, sha: j.sha });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- richer Linear integration (in-app issue workspace) --------------------
// Resolve an INC-id (or bare number) to its Linear GraphQL node id.
async function linearGid(id) {
  const d = await linearGql(`{ issues(filter:{ number:{ eq:${issueNum(id)} }${TEAM_KEY_FILTER} }){ nodes { id } } }`);
  return ((d.issues.nodes || [])[0] || {}).id || null;
}
// Full issue detail: description, labels, assignee, comments, linked PR.
app.get('/api/linear/:id/detail', requireAuth, async (req, res) => {
  if (!LINEAR_KEY) return res.status(500).json({ error: 'no LINEAR_API_KEY' });
  try {
    const d = await linearGql(`{ issues(filter:{ number:{ eq:${issueNum(req.params.id)} }${TEAM_KEY_FILTER} }){ nodes {
      id identifier title description priority url createdAt updatedAt
      state { id name type color } assignee { displayName }
      labels { nodes { id name color } }
      comments { nodes { id body createdAt user { displayName } } }
      attachments { nodes { url title } }
    } } }`);
    const it = (d.issues.nodes || [])[0];
    if (!it) return res.status(404).json({ error: 'not found' });
    let pr = (it.attachments.nodes || []).map((a) => prFromText(a.url)).find(Boolean)
      || (it.comments.nodes || []).map((c) => prFromText(c.body)).find(Boolean);
    if (pr && GH_TOKEN) {
      try { const r = await fetch(`https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, { headers: { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github+json' } }); if (r.ok) { const p = await r.json(); pr.state = p.merged ? 'merged' : p.state; pr.title = p.title; } } catch {}
    }
    res.json({
      id: it.id, identifier: it.identifier, title: it.title, description: it.description || '',
      priority: it.priority || 0, url: it.url, createdAt: it.createdAt, updatedAt: it.updatedAt,
      state: it.state, assignee: it.assignee ? it.assignee.displayName : null,
      labels: (it.labels.nodes || []).map((l) => ({ name: l.name, color: l.color })),
      comments: (it.comments.nodes || []).map((c) => ({ body: c.body, createdAt: c.createdAt, user: c.user ? c.user.displayName : 'someone' })),
      delegations: loadDelegations()[it.identifier] || [],
      pr,
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Team workflow states + labels — for the create form and status-change picker.
// (hyphenated path so it doesn't collide with the /api/linear/:id route above)
app.get('/api/linear-meta', requireAuth, async (req, res) => {
  if (!LINEAR_KEY) return res.status(500).json({ error: 'no LINEAR_API_KEY' });
  try {
    const d = await linearGql(`{ team(id:"${BOARD_TEAM}"){ states{ nodes{ id name type position } } labels{ nodes{ id name color } } } }`);
    const t = d.team || {};
    // include ALL states (incl. Canceled — needed so the status picker / Dismiss can
    // move an issue there), ordered workflow-wise with canceled/duplicate at the end.
    const META_RANK = { triage: 0, backlog: 1, unstarted: 2, started: 3, completed: 4, canceled: 5, duplicate: 6 };
    const states = ((t.states && t.states.nodes) || []).filter((s) => s.type in META_RANK)
      .sort((a, b) => (META_RANK[a.type] - META_RANK[b.type]) || (a.position - b.position));
    res.json({
      states: states.map((s) => ({ id: s.id, name: s.name, type: s.type })),
      labels: ((t.labels && t.labels.nodes) || []).map((l) => ({ id: l.id, name: l.name, color: l.color })),
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Create an issue on team INC.
app.post('/api/linear/issue', requireAuth, async (req, res) => {
  if (!LINEAR_KEY) return res.status(500).json({ error: 'no LINEAR_API_KEY' });
  const { title, description, priority, stateId, labelIds } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title required' });
  try {
    const input = { teamId: BOARD_TEAM, title: String(title).trim() };
    if (description) input.description = String(description);
    if (priority != null && priority !== '') input.priority = Number(priority);
    if (stateId) input.stateId = stateId;
    if (Array.isArray(labelIds) && labelIds.length) input.labelIds = labelIds;
    const d = await linearGql(`mutation Create($input: IssueCreateInput!){ issueCreate(input:$input){ success issue{ identifier url } } }`, { input });
    const issue = d.issueCreate && d.issueCreate.issue;
    res.json({ ok: !!(d.issueCreate && d.issueCreate.success), identifier: issue && issue.identifier, url: issue && issue.url });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Add a comment to an issue.
app.post('/api/linear/:id/comment', requireAuth, async (req, res) => {
  if (!LINEAR_KEY) return res.status(500).json({ error: 'no LINEAR_API_KEY' });
  const body = ((req.body && req.body.body) || '').toString().trim();
  if (!body) return res.status(400).json({ error: 'empty comment' });
  try {
    const gid = await linearGid(req.params.id); if (!gid) return res.status(404).json({ error: 'not found' });
    const d = await linearGql(`mutation Comment($id: String!, $body: String!){ commentCreate(input:{ issueId:$id, body:$body }){ success } }`, { id: gid, body });
    res.json({ ok: !!(d.commentCreate && d.commentCreate.success) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Record a delegation of an issue to a box agent session. Persists the link locally
// (the source of truth for the board badge + the clickable "Delegated to" card), drops
// a breadcrumb comment, and — per the fleet claim convention — moves the ticket to
// In Progress + tags it `agent:delegated` so it reads as claimed everywhere, not just
// in the box app. All Linear side-effects are best-effort: a delegation is never failed
// because Linear is briefly unreachable.
const DELEG_LABEL = 'agent:delegated';
let _startedStateId = null;                  // cached team "started" (In Progress) state id
async function startedStateId() {
  if (_startedStateId) return _startedStateId;
  const d = await linearGql(`{ team(id:"${BOARD_TEAM}"){ states{ nodes{ id type position } } } }`);
  const started = (((d.team && d.team.states && d.team.states.nodes) || []).filter((s) => s.type === 'started').sort((a, b) => a.position - b.position))[0];
  if (started) _startedStateId = started.id;
  return _startedStateId;
}
const _labelIdCache = {};                    // label name -> id (get-or-create, cached)
async function ensureLabelId(name, color = '#8b5cf6') {
  if (_labelIdCache[name]) return _labelIdCache[name];
  const d = await linearGql(`{ team(id:"${BOARD_TEAM}"){ labels{ nodes{ id name } } } }`);
  let id = (((d.team && d.team.labels && d.team.labels.nodes) || []).find((l) => l.name === name) || {}).id;
  if (!id) {
    try {
      const c = await linearGql(`mutation L($input: IssueLabelCreateInput!){ issueLabelCreate(input:$input){ success issueLabel{ id } } }`, { input: { name, teamId: BOARD_TEAM, color } });
      id = c.issueLabelCreate && c.issueLabelCreate.issueLabel && c.issueLabelCreate.issueLabel.id;
    } catch {}
  }
  if (id) _labelIdCache[name] = id;
  return id;
}
app.post('/api/linear/:id/delegation', requireAuth, async (req, res) => {
  const inc = String(req.params.id || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!/^[A-Z]+-\d+$/.test(inc)) return res.status(400).json({ error: 'bad id' });
  const b = req.body || {};
  const rec = {
    sessionId: b.sessionId ? String(b.sessionId) : null,
    sessionTitle: (b.sessionTitle || '').toString().slice(0, 120),
    agent: b.agent === 'codex' ? 'codex' : 'claude',
    kind: b.kind === 'resume' ? 'resume' : 'new',
    ts: Date.now(),
  };
  // 1) persist locally (always — this is the source of truth for the badge + deep-link)
  try {
    const all = loadDelegations();
    const arr = Array.isArray(all[inc]) ? all[inc] : [];
    const last = arr[arr.length - 1];
    if (last && last.sessionId && last.sessionId === rec.sessionId) { last.ts = rec.ts; if (rec.sessionTitle) last.sessionTitle = rec.sessionTitle; }
    else arr.push(rec);
    all[inc] = arr.slice(-10);   // keep a short history of owners
    saveDelegations(all);
  } catch {}
  // 2) Linear side (best-effort)
  let claimed = false, commented = false;
  if (LINEAR_KEY) {
    try {
      const det = await linearGql(`{ issues(filter:{ number:{ eq:${issueNum(inc)} }${TEAM_KEY_FILTER} }){ nodes { id state{ type } labels{ nodes{ id } } } } }`);
      const it = (det.issues.nodes || [])[0];
      if (it) {
        const agentName = rec.agent === 'codex' ? 'Codex' : 'Claude';
        const verb = rec.kind === 'resume' ? 'Resumed in' : 'Delegated to';
        const body = `🤖 ${verb} a box ${agentName} agent${rec.sessionTitle ? ` — “${rec.sessionTitle}”` : ''}.`
          + (rec.sessionId ? `\n<!-- box-session:${rec.sessionId} -->` : '');
        try { await linearGql(`mutation C($id: String!, $body: String!){ commentCreate(input:{ issueId:$id, body:$body }){ success } }`, { id: it.id, body }); commented = true; } catch {}
        const input = {};
        const labelId = await ensureLabelId(DELEG_LABEL);
        const have = ((it.labels && it.labels.nodes) || []).map((l) => l.id);
        if (labelId && !have.includes(labelId)) input.addedLabelIds = [labelId];
        // only advance the workflow state if it hasn't started yet — never regress an
        // In Review / Done ticket back to In Progress.
        if (['triage', 'backlog', 'unstarted'].includes(it.state && it.state.type)) {
          const sid = await startedStateId(); if (sid) input.stateId = sid;
        }
        if (Object.keys(input).length) {
          try { await linearGql(`mutation U($id: String!, $input: IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success } }`, { id: it.id, input }); claimed = true; } catch {}
        }
      }
    } catch {}
  }
  res.json({ ok: true, claimed, commented });
});
// Set an issue's workflow state (generalizes /done — dismiss=Canceled, close=Done, etc.).
app.post('/api/linear/:id/state', requireAuth, async (req, res) => {
  if (!LINEAR_KEY) return res.status(500).json({ error: 'no LINEAR_API_KEY' });
  const stateId = ((req.body && req.body.stateId) || '').toString();
  if (!stateId) return res.status(400).json({ error: 'stateId required' });
  try {
    const gid = await linearGid(req.params.id); if (!gid) return res.status(404).json({ error: 'not found' });
    const d = await linearGql(`mutation SetState($id: String!, $stateId: String!){ issueUpdate(id:$id, input:{ stateId:$stateId }){ success issue{ state{ name } } } }`, { id: gid, stateId });
    res.json({ ok: !!(d.issueUpdate && d.issueUpdate.success), state: d.issueUpdate && d.issueUpdate.issue && d.issueUpdate.issue.state && d.issueUpdate.issue.state.name });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Sessions whose transcript references this issue — i.e. the chat(s) that filed or
// worked on the ticket, so the user can jump back in / resume the original context.
app.get('/api/linear/:id/sessions', requireAuth, (req, res) => {
  const id = String(req.params.id || '').replace(/[^A-Za-z0-9-]/g, '');
  if (!/^[A-Z]+-\d+$/.test(id)) return res.json({ sessions: [] });
  const exclude = String(req.query.exclude || '');
  const counts = {};   // sessionId -> mention count (relevance: the filer/worker references it most)
  // claude transcripts (one JSONL per session). -c gives "path:count" per matching file;
  // word-bounded fixed match avoids INC-86 matching INC-864.
  try {
    // search every account's projects base (broker-pooled sessions live under ~/.claude-<id>)
    const globs = projectsBases().map((b) => `${JSON.stringify(b)}/*/*.jsonl`).join(' ');
    const out = execSync(`rg -cwF --no-messages -- ${JSON.stringify(id)} ${globs} 2>/dev/null || true`,
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: '/bin/bash' });
    for (const line of out.split('\n')) {
      const m = line.trim().match(/\/([^/]+)\.jsonl:(\d+)$/);
      if (m) counts[m[1]] = (counts[m[1]] || 0) + parseInt(m[2], 10);
    }
  } catch {}
  // codex sessions live in one JSON store keyed by id
  try {
    for (const [sid, s] of Object.entries(loadCodex().sessions || {})) {
      const n = (JSON.stringify(s.messages || '').match(new RegExp(id, 'g')) || []).length;
      if (n) counts[sid] = (counts[sid] || 0) + n;
    }
  } catch {}
  const names = loadNames();
  const codex = loadCodex().sessions || {};
  const sessions = [];
  for (const sid of Object.keys(counts)) {
    if (sid === exclude) continue;
    if (codex[sid]) {
      const c = codex[sid];
      sessions.push({ id: sid, title: names[sid] || c.title || 'Codex session', agent: 'codex', cwd: c.cwd || DEFAULT_CWD, category: 'main', subcat: null, mtime: c.updatedAt ? Date.parse(c.updatedAt) : 0, mentions: counts[sid] });
      continue;
    }
    const file = jsonlPath(sid);
    if (!file || !existsSync(file)) continue;
    let mtime = 0; try { mtime = statSync(file).mtimeMs; } catch {}
    sessions.push({
      id: sid, title: sessionCustomName(file) || names[sid] || sessionTitle(file) || 'session', agent: 'claude',
      cwd: decodeCwd(dirname(file)), category: isAutoFile(file) ? 'auto' : 'main',
      subcat: isAutoFile(file) ? autoSubcat(sid, file) : null, mtime, mentions: counts[sid],
    });
  }
  // most-relevant first (mention count), then most-recent
  sessions.sort((a, b) => (b.mentions - a.mentions) || (b.mtime - a.mtime));
  res.json({ sessions: sessions.slice(0, 8) });
});

// Inverse of the above: the Linear issues a SINGLE session has touched. Powers the
// "Linear" tab in the per-session bell. ripgrep the session's own transcript for
// INC-<n> identifiers (most-mentioned first), then resolve title/state from Linear.
// Count INC-<n> mentions in a session's REAL dialogue only — the user's typed
// messages and the assistant's prose. Tool calls/results, thinking, and injected
// system/hook/event entries (which are type:"attachment" or start with <,Caveat:,📨,🔔
// and name many UNRELATED tickets) are skipped — that injected noise was why the
// "Linear" tab surfaced random issues. Genuinely worked-on tickets recur (≥2×).
const INC_INJECT_RE = /^(<|Caveat:|📨|🔔|\[Image|\[Request|Current time|UserPromptSubmit|SessionStart|System:)/;
function tallyIssues(text, counts) {
  if (!ISSUE_RE) return;
  for (const m of String(text || '').matchAll(ISSUE_RE)) { const n = m[1]; counts[n] = (counts[n] || 0) + 1; }
}
function sessionIssueCounts(file) {
  const counts = {};
  try {
    const { size } = statSync(file);
    let raw;
    if (size > 24 * 1024 * 1024) {                     // very large → tail (recent dialogue)
      const len = 24 * 1024 * 1024, fd = openSync(file, 'r'), buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len); closeSync(fd);
      const s = buf.toString('utf8'); raw = s.slice(s.indexOf('\n') + 1);
    } else raw = readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!ISSUE_PREFIX || !line.includes(ISSUE_PREFIX)) continue;   // cheap pre-filter
      let o; try { o = JSON.parse(line); } catch { continue; }
      if ((o.type !== 'user' && o.type !== 'assistant') || !o.message) continue;   // skip attachments/meta
      const c = o.message.content;
      let txt = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n') : '';
      txt = txt.trim();
      if (!txt) continue;
      // drop injected/system/hook/event user text that merely *names* tickets
      if (o.type === 'user' && (INC_INJECT_RE.test(txt) || /New since your last turn|Needs your input/.test(txt))) continue;
      tallyIssues(txt, counts);
    }
  } catch {}
  return counts;
}
app.get('/api/sessions/:id/linear', requireAuth, async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9-]+$/.test(id)) return res.json({ issues: [] });
  const counts = {};                                   // issue number -> mention count (dialogue only)
  try { const file = jsonlPath(id); if (file && existsSync(file)) Object.assign(counts, sessionIssueCounts(file)); } catch {}
  try {                                                // codex dialogue (user/assistant text only)
    const c = (loadCodex().sessions || {})[id];
    if (c) for (const m of (c.messages || [])) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      tallyIssues(typeof m.text === 'string' ? m.text : (typeof m.content === 'string' ? m.content : ''), counts);
    }
  } catch {}
  // Keep tickets with a real signal: mentioned ≥2× in dialogue (drops one-off passing
  // references). If none clear the bar, fall back to all so a single-mention session
  // isn't empty. Most-discussed first, capped.
  const allNums = [...new Set(Object.keys(counts).map(Number).filter(Boolean))];
  const strong = allNums.filter((n) => counts[n] >= 2);
  const nums = (strong.length ? strong : allNums).sort((a, b) => (counts[b] - counts[a]) || (b - a)).slice(0, 12);
  if (!nums.length) return res.json({ issues: [] });
  const bare = nums
    .map((n) => ({ identifier: ISSUE_PREFIX + n, title: '', url: issueUrl(n), state: null, mentions: counts[n] }));
  if (!LINEAR_KEY) return res.json({ issues: bare });
  try {
    const d = await linearGql(`{ issues(first: 100, filter: { number: { in: [${nums.join(',')}] }${TEAM_KEY_FILTER} }) { nodes { identifier number title url state { name type } } } }`);
    const byNum = new Map(((d.issues && d.issues.nodes) || []).map((n) => [n.number, n]));
    const issues = nums.map((n) => {
      const it = byNum.get(n);
      return it ? { identifier: it.identifier, title: it.title, url: it.url, state: it.state, mentions: counts[n] }
                : { identifier: ISSUE_PREFIX + n, title: '', url: issueUrl(n), state: null, mentions: counts[n] };
    }).sort((a, b) => (b.mentions - a.mentions) || a.identifier.localeCompare(b.identifier, undefined, { numeric: true }));
    res.json({ issues: issues.slice(0, 30) });
  } catch (e) { res.json({ issues: bare }); }
});

// filesystem browser / @-picker
app.get('/api/fs', requireAuth, (req, res) => {
  const p = resolve(req.query.path || DEFAULT_CWD);
  try {
    const st = statSync(p);
    if (st.isDirectory()) {
      const entries = readdirSync(p, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.') || req.query.hidden === '1')
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      return res.json({ type: 'dir', path: p, parent: dirname(p), entries });
    }
    if (st.size > 1_000_000) return res.json({ type: 'file', path: p, tooBig: true, size: st.size });
    res.json({ type: 'file', path: p, content: readFileSync(p, 'utf8') });
  } catch (e) { res.status(404).json({ error: String(e.message || e) }); }
});

// image upload (for the camera/library attach, and pasted clipboard images on web)
const imgExtForMime = (m = '') =>
  /png/.test(m) ? '.png' : /jpe?g/.test(m) ? '.jpg' : /gif/.test(m) ? '.gif' :
  /webp/.test(m) ? '.webp' : /svg/.test(m) ? '.svg' : /heic|heif/.test(m) ? '.heic' : '';
const upload = multer({ storage: multer.diskStorage({
  destination: UPLOAD_DIR,
  // Pasted clipboard blobs often arrive with no (or an extension-less) name; Claude's Read
  // tool keys off the file extension to treat it as an image, so derive one from the MIME type.
  filename: (req, file, cb) => {
    let name = (file.originalname || 'img').replace(/[^\w.\-]/g, '_');
    if (!extname(name)) name += imgExtForMime(file.mimetype);
    cb(null, randomBytes(6).toString('hex') + '-' + name);
  },
}), limits: { fileSize: 25 * 1024 * 1024 } });
app.post('/api/upload', requireAuth, upload.array('images', 6), (req, res) =>
  res.json({ paths: (req.files || []).map((f) => f.path) }));

// serve an uploaded image back to the UI (restricted to the uploads dir)
app.get('/api/img', requireAuth, (req, res) => {
  const p = resolve(req.query.path || '');
  if (!p.startsWith(UPLOAD_DIR + '/')) return res.status(403).end();
  res.sendFile(p, (e) => { if (e && !res.headersSent) res.status(404).end(); });
});

// serve any file on the box (token-gated, personal use) — for the media viewer
app.get('/api/raw', requireAuth, (req, res) => {
  const p = resolve(req.query.path || '');
  try { if (!statSync(p).isFile()) return res.status(404).end(); } catch { return res.status(404).end(); }
  if (req.query.dl) res.setHeader('Content-Disposition', `attachment; filename="${basename(p)}"`);
  res.sendFile(p, (e) => { if (e && !res.headersSent) res.status(404).end(); });
});

// ---- voice transcription (bilingual EN+中文) -------------------------------
// Persist every clip so a garbled transcript can be re-transcribed (the user 6/24:
// "see if the audio is on the box and transcribe it"). Primary engine = Deepgram
// nova-3 (multilingual, our meeting-grade transcriber); ElevenLabs Scribe is the
// fallback. The realtime /stt relay also persists its clip + does an HQ pass.
const VOICE_LOG = join(VOICE_DIR, 'index.jsonl');
const extForMime = (m = '') =>
  /wav/.test(m) ? '.wav' : /mp4|m4a|aac/.test(m) ? '.m4a' : /ogg|opus/.test(m) ? '.ogg' :
  /mpeg|mp3/.test(m) ? '.mp3' : '.webm';
function pruneVoice(max = 400) {
  try {
    const files = readdirSync(VOICE_DIR).filter((f) => f !== 'index.jsonl')
      .map((f) => ({ f, t: statSync(join(VOICE_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(max)) { try { unlinkSync(join(VOICE_DIR, f)); } catch {} }
  } catch {}
}
function persistClip(buffer, mimetype) {
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
  const name = id + extForMime(mimetype);
  try { writeFileSync(join(VOICE_DIR, name), buffer); pruneVoice(); } catch (e) { return null; }
  return name;
}
function logVoice(meta) { try { writeFileSync(VOICE_LOG, JSON.stringify({ ts: new Date().toISOString(), ...meta }) + '\n', { flag: 'a' }); } catch {} }

// Deepgram batch transcription of a clip buffer. nova-3 + language=multi handles
// EN+中文 without the cross-language hallucinations the ElevenLabs auto-detect hits.
async function transcribeDeepgram(buffer, mimetype) {
  if (!DEEPGRAM_KEY) throw new Error('no DEEPGRAM key');
  const u = `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(DG_MODEL)}&language=multi&smart_format=true&punctuate=true`;
  const r = await fetch(u, { method: 'POST', headers: { Authorization: `Token ${DEEPGRAM_KEY}`, 'Content-Type': mimetype || 'audio/webm' }, body: buffer });
  if (!r.ok) throw new Error(`deepgram ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const alt = d?.results?.channels?.[0]?.alternatives?.[0];
  return { text: (alt?.transcript || '').trim(), model: `deepgram:${DG_MODEL}` };
}
async function transcribeEleven(buffer, mimetype, originalname) {
  if (!ELEVEN_KEY) throw new Error('no ELEVENLABS key');
  let lastErr = '';
  for (const model of STT_MODELS) {
    try {
      const form = new FormData();
      form.append('model_id', model.trim());
      form.append('file', new Blob([buffer], { type: mimetype || 'audio/webm' }), originalname || 'clip.webm');
      const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': ELEVEN_KEY }, body: form });
      if (r.ok) { const d = await r.json(); return { text: (d.text || '').trim(), model: `eleven:${model.trim()}` }; }
      lastErr = `${model.trim()} -> ${r.status}`;
    } catch (e) { lastErr = String(e.message || e); }
  }
  throw new Error(lastErr || 'eleven failed');
}
// Try Deepgram first, fall back to ElevenLabs. Returns {text, model, engine}.
async function transcribeBuffer(buffer, mimetype, originalname) {
  const errs = [];
  for (const fn of [() => transcribeDeepgram(buffer, mimetype), () => transcribeEleven(buffer, mimetype, originalname)]) {
    try { const r = await fn(); if (r.text) return r; errs.push(`${r.model}: empty`); }
    catch (e) { errs.push(String(e.message || e)); }
  }
  throw new Error(errs.join(' | '));
}

const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.post('/api/transcribe', requireAuth, uploadMem.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no audio' });
  const clip = persistClip(req.file.buffer, req.file.mimetype);
  try {
    const { text, model } = await transcribeBuffer(req.file.buffer, req.file.mimetype, req.file.originalname);
    logVoice({ clip, model, bytes: req.file.size, mimetype: req.file.mimetype, text });
    res.json({ text, model, clip });
  } catch (e) {
    logVoice({ clip, error: String(e.message || e), bytes: req.file.size, mimetype: req.file.mimetype });
    res.status(502).json({ error: String(e.message || e), clip });
  }
});

// Re-transcribe a previously-saved clip (recover a garbled message). Pass ?clip=<name>
// (from VOICE_DIR) or the most recent clip if omitted. Optional ?engine=deepgram|eleven.
app.get('/api/retranscribe', requireAuth, async (req, res) => {
  try {
    let clip = (req.query.clip || '').toString().replace(/[^\w.\-:]/g, '');
    if (!clip) {
      const files = readdirSync(VOICE_DIR).filter((f) => f !== 'index.jsonl')
        .map((f) => ({ f, t: statSync(join(VOICE_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      clip = files[0]?.f;
    }
    if (!clip || !existsSync(join(VOICE_DIR, clip))) return res.status(404).json({ error: 'clip not found' });
    const buffer = readFileSync(join(VOICE_DIR, clip));
    const mimetype = clip.endsWith('.wav') ? 'audio/wav' : clip.endsWith('.m4a') ? 'audio/mp4' : clip.endsWith('.ogg') ? 'audio/ogg' : 'audio/webm';
    const engine = (req.query.engine || '').toString();
    const r = engine === 'eleven' ? await transcribeEleven(buffer, mimetype, clip)
      : engine === 'deepgram' ? await transcribeDeepgram(buffer, mimetype)
      : await transcribeBuffer(buffer, mimetype, clip);
    logVoice({ clip, model: r.model, retranscribe: true, text: r.text });
    res.json({ text: r.text, model: r.model, clip });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.use(express.static(PUBLIC));

// ---- per-session queue workers --------------------------------------------
// Each session has a server-side queue + worker that runs turns sequentially,
// independent of any connected client — so queued messages auto-send even if the
// app is closed or navigated away. Queue persisted to disk for restart resume.
const QDIR = join(STATE_DIR, 'queue');
mkdirSync(QDIR, { recursive: true });
const isUuid = (k) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(k);
const qpath = (k) => join(QDIR, String(k).replace(/[^\w.-]/g, '_') + '.json');
const RT = new Map();      // internalKey -> state
const ALIAS = new Map();   // realSessionId -> internalKey (for new chats keyed by a temp id)
const resolveKey = (k) => ALIAS.get(k) || k;

function rt(extKey) {
  const key = resolveKey(extKey);
  if (!RT.has(key)) {
    let p = {};
    try { p = JSON.parse(readFileSync(qpath(key), 'utf8')); } catch {}
    RT.set(key, { key, sessionId: p.sessionId || (isUuid(key) ? key : null), cwd: p.cwd || null, agent: p.agent || null,
      parentId: p.parentId || null, parentTitle: p.parentTitle || '', title: p.title || '',
      settings: normalizeSettings(p.settings || {}),
      queue: p.queue || [], running: false, curText: '', curTools: [], curParts: [], subs: new Set(), proc: null, canceled: false });
  }
  return RT.get(key);
}
function persist(s) { try { writeFileSync(qpath(s.sessionId || s.key), JSON.stringify({ sessionId: s.sessionId, cwd: s.cwd, agent: s.agent, parentId: s.parentId || null, parentTitle: s.parentTitle || '', title: s.title || '', settings: normalizeSettings(s.settings || {}), queue: s.queue })); } catch {} }
function bcast(s, o) { for (const ws of s.subs) { try { ws.send(JSON.stringify(o)); } catch {} } }
const queueView = (s) => s.queue.map((q, i) => ({ qid: q.qid, text: q.displayText != null ? q.displayText : q.text, mode: q.mode, agent: q.agent || s.agent || 'claude', images: q.images || [], running: i === 0 && s.running }));

// locate a session's jsonl across project dirs (sessions can live under any cwd)
function jsonlPath(id) {
  return findSessionFile(id) || join(PROJECTS, '-home-factory-development', id + '.jsonl');
}
// The name we pass to `claude --remote-control <name>` IS the session's display name
// in the official Claude app/CLI — it's sticky for the life of the bridge and an
// ai-title generated mid-turn does NOT override it. So a delegated chat (title set up
// front, e.g. "INC-123: …") must be NAMED with that title at spawn, or the official app
// shows the throwaway "box-<key>" forever. (The custom-title we also write to the JSONL
// is for the resume picker / pickup; it does NOT reach the live remote-control card.)
// Precedence: explicit box title → the session's canonical Claude title (so a
// resume-respawn doesn't rename it back to "box-…") → the "box-<id>" last resort.
const rcName = (s) => {
  const explicit = String(s.title || '').replace(/[\r\n]+/g, ' ').trim();
  if (explicit) return explicit.slice(0, 72);
  if (s.sessionId) { try { const n = sessionCustomName(jsonlPath(s.sessionId)); if (n) return n.slice(0, 72); } catch {} }
  return 'box-' + String(s.sessionId || s.key || 'new').replace(/[^\w-]/g, '').slice(0, 12);
};

// Track the in-flight turn as an ORDERED part list (text segments interleaved with
// tools) so a mid-turn reconnect (onSync) can rebuild the bubble with its REAL
// structure instead of hoisting every tool to the top and mashing all text into one
// block. Consecutive text deltas coalesce into one segment; a tool closes it.
function pushTextPart(s, text) {
  if (!text) return;
  const last = s.curParts[s.curParts.length - 1];
  if (last && last.t === 'text') last.text += text;
  else s.curParts.push({ t: 'text', text });
}

// Stream JSONL events for a session to its subscribers. This is the renderer and
// the source of truth: it shows turns we inject AND turns driven from any other
// device. Started once per session (from current EOF — history loads via REST).
function onTailEvent(s, ev) {
  if (ev.kind === 'user') {
    // our own injected message echoes back as a user entry; skip one per inject.
    if (s.expectUserEcho > 0) { s.expectUserEcho--; return; }
    if (ev.text && !ev.text.startsWith('<') && !ev.text.startsWith('Caveat:')) bcast(s, { type: 'remote_user', text: ev.text });
    return;
  }
  if (ev.kind === 'text') { s.curText += ev.text; pushTextPart(s, ev.text); bcast(s, { type: 'text', delta: ev.text }); }
  else if (ev.kind === 'thinking') bcast(s, { type: 'thinking', delta: ev.text });
  else if (ev.kind === 'tool') {
    const t = { type: 'tool', id: ev.id, name: ev.name, input: summarizeToolInput(ev.name, ev.input), detail: ev.input };
    s.curTools.push(t); s.curParts.push({ t: 'tool', id: ev.id, name: t.name, input: t.input, detail: t.detail }); bcast(s, t);
  } else if (ev.kind === 'tool_result') {
    let c = ev.content; if (Array.isArray(c)) c = c.map((x) => (x && x.type === 'text' ? x.text : '')).join('');
    const o = { type: 'tool_result', id: ev.id, content: String(c || '').slice(0, 6000) };
    const t = s.curTools.find((x) => x.id === ev.id); if (t) t.result = o.content;
    const tp = s.curParts.find((p) => p.t === 'tool' && p.id === ev.id); if (tp) tp.result = o.content;
    bcast(s, o);
  } else if (ev.kind === 'notice') {
    bcast(s, { type: 'notice', text: ev.text });
  } else if (ev.kind === 'turn_end') {
    if (s.onTurnEnd) s.onTurnEnd();
    s.turnCount = (s.turnCount || 0) + 1;
    // Every 10 turns, refresh the session's ATTENTION.md (via OpenAI, not Claude)
    if (s.turnCount % 10 === 0) triggerAttentionUpdate(s);
  }
}
function scanRecentImages(sessionId) {
  // Return the last ~8 SendUserFile batches that included images, newest first.
  // Each entry: { paths: ['/tmp/...png', ...], caption: '...' }
  // Reads only the tail of the JSONL (last 3 MB) so large sessions stay fast.
  const IMG_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
  const SCAN_BYTES = 20 * 1024 * 1024;
  const results = [];
  try {
    const jf = jsonlPath(sessionId);
    const { size } = statSync(jf);
    const start = Math.max(0, size - SCAN_BYTES);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    const fd = openSync(jf, 'r');
    readSync(fd, buf, 0, len, start);
    closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (const ln of (start > 0 ? lines.slice(1) : lines)) { // skip possible partial first line
      let o; try { o = JSON.parse(ln); } catch { continue; }
      if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
      for (const b of o.message.content) {
        if (b.type !== 'tool_use' || b.name !== 'SendUserFile') continue;
        const files = ((b.input || {}).files || []).filter((f) => IMG_RE.test(f) && existsSync(f));
        if (files.length) results.push({ paths: files, caption: (b.input || {}).caption || '' });
      }
    }
  } catch {}
  return results.slice(-8).reverse(); // newest first, cap at 8 batches
}

function triggerAttentionUpdate(s) {
  if (!s.sessionId || s._attnUpdating) return;
  // Never run for automated / headless `claude -p` sessions the box app merely
  // tracks (dream-cycle, linear-dispatch, healer, brain, career-ops, box-attention).
  // Morning-brief docs are only for real interactive sessions the user started.
  if (AUTO_DIR_RE.test(s.cwd || '') || isAutoFile(jsonlPath(s.sessionId))) return;
  s._attnUpdating = true;
  const hist = sessionHistory(s.sessionId);
  if (!hist || !hist.messages || hist.messages.length < 2) { s._attnUpdating = false; return; }
  // Stored per SESSION (not cwd) so concurrent ~/development sessions don't clobber.
  const attFile = sessionAttFile(s.sessionId);
  // Per-chat toggle: `<dir>/.attention-off` (cwd-scoped, legacy) or per-session sentinel.
  const cwd = s.cwd || hist.cwd || DEFAULT_CWD;
  if (existsSync(sessionAttOff(s.sessionId)) || existsSync(join(cwd, '.claude', '.attention-off'))) { s._attnUpdating = false; return; }
  // Read the existing doc so the model can refine rather than overwrite from scratch
  let existing = '';
  try { existing = readFileSync(attFile, 'utf8').trim(); } catch {}
  // Collect recent verification screenshots (SendUserFile image batches)
  const recentImgs = scanRecentImages(s.sessionId);
  const turns = hist.messages.slice(-20).map((m) => {
    const text = m.parts.filter((p) => p.t === 'text').map((p) => p.text).join(' ').slice(0, 2000);
    return `[${m.role === 'user' ? 'USER' : 'CLAUDE'}]: ${text}`;
  }).join('\n\n---\n\n');
  const imgSection = recentImgs.length
    ? `RECENT VERIFICATION SCREENSHOTS (evidence of completed work — newest first):
${recentImgs.map(({ paths, caption }) => `- ${paths.join(', ')}${caption ? `\n  Caption: "${caption.slice(0, 200)}"` : ''}`).join('\n')}

`
    : '';
  // Image rule: the cheap model used to invent image refs — a website URL as a screenshot
  // (![dashboard](https://example.com)) or the literal placeholder (path/to/x.png) — which
  // render as broken-image boxes in the box app. Allow embedding ONLY a real path from the
  // screenshots list above, copied verbatim; otherwise no images at all.
  const allowedImgPaths = recentImgs.flatMap((r) => r.paths);
  const imgRule = allowedImgPaths.length
    ? `- For a "Done recently" item with a matching screenshot, you MAY embed ONE inline using a path copied EXACTLY from the RECENT VERIFICATION SCREENSHOTS list above: ![short description](EXACT_PATH_FROM_LIST). Use ONLY paths from that list. NEVER invent a path, NEVER put a website/http(s) URL inside ![](…) (those are not images), NEVER use a placeholder like /path/to/x.png. If no listed screenshot fits the item, omit the image.`
    : `- Do NOT embed any images: no screenshots are available. NEVER invent an image path and NEVER put a website/http(s) URL or a placeholder inside ![](…).`;
  const prompt = `You are maintaining a morning-briefing status doc for ${OWNER_NAME} so ${OWNER_NAME} can orient after being away, without reading the full chat.

${existing ? `EXISTING STATUS DOC (current best knowledge — refine it, don't discard it):
${existing}

` : ''}${imgSection}RECENT CONVERSATION (last 20 turns — use this to update the doc):
${turns}

Output ONLY the updated markdown — no preamble, no commentary. Rules:
- KEEP existing "Needs your input" items unless the new conversation clearly resolves them
- REMOVE or move to "Done recently" any item explicitly completed in the new turns
- ADD new blocking items or decisions discovered in the new turns
- If the new turns are just idle checks / heartbeats with no new information, output the existing doc mostly unchanged
- Omit a section only if it genuinely has nothing to say
${imgRule}

## Needs your input
For each open decision or question blocking progress, write:

**[Topic label]**
- *Question:* Exactly what needs to be decided or answered — specific, not vague
- *Context:* 1–2 sentences: what's already done, what's at stake, what options exist if relevant
- *Why now:* why it's blocking (skip if obvious)

## In progress
- [item] — [what specifically is happening and current state]

## Done recently
- [item] — [what was completed and its outcome]${allowedImgPaths.length ? '\n  ![description](exact path copied from the screenshots list above — omit this line entirely if none fits)' : ''}

Be specific enough that ${OWNER_NAME} can act or reply without reading the chat. List all sub-questions under a topic, not just the topic label.`;
  // Generate via the OpenAI API (cheap model) instead of `claude -p` — saves Claude/Max
  // tokens on this high-frequency mundane refresh (the user 2026-06-22).
  (async () => {
    try {
      if (!OPENAI_KEY) { s._attnUpdating = false; return; }
      const r = await fetch(`${OPENAI_ENDPOINT}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: BOX_ATTENTION_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 1600,
        }),
      });
      const j = await r.json();
      const output = ((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
      if (output) {
        try { writeFileSync(attFile, output); } catch {}
        bcast(s, { type: 'attention_updated', sessionId: s.sessionId });
      }
    } catch { /* leave existing ATTENTION.md untouched on error */ }
    finally { s._attnUpdating = false; }
  })();
}
function ensureTail(s, fromLine) {
  if (!s.sessionId || s.tailStop) return;
  const jf = jsonlPath(s.sessionId);
  const start = fromLine != null ? fromLine : readJsonl(jf).lines;
  s.tailStop = tailJsonl(jf, start, (ev) => onTailEvent(s, ev));
}
function stopTail(s) { if (s.tailStop) { try { s.tailStop(); } catch {} s.tailStop = null; } }

// Watch for any subscribed session being parked on an interactive prompt (AskUserQuestion /
// ExitPlanMode / permission). claude does NOT write the pending tool_use to the JSONL until it's
// answered, so the JSONL tail can't surface it — the box would look stuck. We detect it from
// ~/.claude/sessions (status==='waiting') and scrape the TUI for the question + options so it
// renders in-chat. One global poller (vs per-session intervals) sidesteps start-timing for new
// chats whose sessionId resolves only after the first turn begins.
setInterval(() => { for (const s of RT.values()) { if (s.subs.size && s.sessionId) checkWaiting(s).catch(() => {}); } }, 1200);
async function checkWaiting(s) {
  if (!s.sessionId || !s.subs.size) return;            // only while someone's watching this chat
  const st = rcEngine.sessionState(s.sessionId);
  const waiting = !!(st && st.status === 'waiting');
  if (!waiting) {
    if (s.waitingActive) { s.waitingActive = false; s.waitingPayload = null; s.waitingSettled = false; s.waitingTries = 0; bcast(s, { type: 'waiting_clear', sessionId: s.sessionId }); }
    return;
  }
  // waiting === true. Re-scrape across polls until we get a parsed prompt — status can flip to
  // 'waiting' a beat before the menu finishes painting, so the first scrape may come up empty.
  if (s.waitingActive && s.waitingSettled) return;     // already surfaced the final prompt
  let prompt = null, attached = false;
  try {
    // Attach a local pty so we can read the TUI (collision-safe: reattaches a box-local bridge,
    // refuses to spawn a competing one for a session owned elsewhere). Then scrape the screen.
    const rec = rcEngine.open(s.sessionId, rcName(s), { cwd: s.cwd, settings: (s.settings || {}).claude });
    if (rec && !rec.blocked) { attached = true; const buf = await rcEngine.captureScreen(s.sessionId); if (buf) prompt = promptFromBuffer(buf); }
  } catch {}
  s.waitingActive = true;
  s.waitingTries = (s.waitingTries || 0) + 1;
  // Stop retrying once we have a prompt, we can't scrape (not attached → owned elsewhere), or we've tried enough.
  if (prompt || !attached || s.waitingTries >= 5) s.waitingSettled = true;
  s.waitingPayload = { type: 'waiting', sessionId: s.sessionId, waitingFor: (st && st.waitingFor) || '', prompt, answerable: attached };
  bcast(s, s.waitingPayload);
}
async function answerWaiting(extKey, sel) {
  const s = rt(extKey);
  if (!s.sessionId) return;
  try {
    const rec = rcEngine.open(s.sessionId, rcName(s), { cwd: s.cwd, settings: (s.settings || {}).claude });
    if (rec && rec.blocked) { bcast(s, { type: 'error', msg: 'This session is running elsewhere — answer it on desktop.' }); return; }
    const ok = await rcEngine.answerWaiting(s.sessionId, sel);
    // Optimistically clear the card; the JSONL tail will render the answered tool_use/result and
    // Claude's continuation as they land. (Don't touch RUNNING — this session may not be box-driven.)
    if (ok) { s.waitingActive = false; s.waitingPayload = null; s.waitingSettled = false; s.waitingTries = 0; bcast(s, { type: 'waiting_clear', sessionId: s.sessionId }); }
  } catch (e) { bcast(s, { type: 'error', msg: String((e && e.message) || e).slice(-300) }); }
}

function enqueue(extKey, msg) {
  const s = rt(extKey);
  msg.qid = randomBytes(4).toString('hex');
  if (msg.cwd) s.cwd = msg.cwd;
  if (msg.agent) s.agent = msg.agent;
  if (msg.parentId) s.parentId = msg.parentId;
  if (msg.parentTitle) s.parentTitle = msg.parentTitle;
  if (msg.title) s.title = msg.title;
  s.queue.push(msg); persist(s);
  bcast(s, { type: 'queue', queue: queueView(s) });
  runWorker(s);
  return msg.qid;
}
function dequeue(extKey, qid) {
  const s = rt(extKey);
  const idx = s.queue.findIndex((q, i) => q.qid === qid && !(i === 0 && s.running));
  if (idx >= 0) { s.queue.splice(idx, 1); persist(s); bcast(s, { type: 'queue', queue: queueView(s) }); }
}
function cancelCurrent(extKey) {
  const s = rt(extKey); s.canceled = true;
  if (s.bashProc) { try { s.bashProc.kill('SIGTERM'); } catch {} }
  if (s.proc) { try { s.proc.kill('SIGTERM'); } catch {} }
  if (s.sessionId) rcEngine.interrupt(s.sessionId); // ESC into the RC TUI
  if (s.onTurnEnd) { const f = s.onTurnEnd; s.onTurnEnd = null; f(); } // unblock the worker
}

// Merge everything queued right now into ONE turn — so Claude sees all the user's
// intentions at once instead of processing them slowly one-by-one.
function combineQueued(batch) {
  if (batch.length === 1) return batch[0];
  const allBash = batch.every((m) => m.mode === 'bash');
  return {
    qid: batch[0].qid,
    text: batch.map((m) => m.text).filter(Boolean).join(allBash ? '\n' : '\n\n'),
    displayText: batch.map((m) => m.displayText != null ? m.displayText : m.text).filter(Boolean).join(allBash ? '\n' : '\n\n'),
    images: batch.flatMap((m) => m.images || []),
    mode: allBash ? 'bash' : 'normal',
    agent: batch.find((m) => m.agent)?.agent || batch[0].agent || 'claude',
    cwd: batch[0].cwd,
    force: batch.some((m) => m.force),
    parentId: batch.find((m) => m.parentId)?.parentId || batch[0].parentId || null,
    parentTitle: batch.find((m) => m.parentTitle)?.parentTitle || batch[0].parentTitle || '',
    title: batch.find((m) => m.title)?.title || batch[0].title || '',
  };
}
async function runWorker(s) {
  if (s.running) return; s.running = true;
  while (s.queue.length) {
    const batch = s.queue.splice(0, s.queue.length);   // drain ALL currently queued
    const msg = combineQueued(batch);
    s.agent = msg.agent || s.agent || 'claude';
    if (msg.parentId) s.parentId = msg.parentId;
    if (msg.parentTitle) s.parentTitle = msg.parentTitle;
    if (msg.title) s.title = msg.title;
    s.curText = ''; s.curTools = []; s.curParts = []; s.canceled = false; s.curUser = msg.displayText != null ? msg.displayText : msg.text; s.curUserImages = msg.images || [];
    if (s.sessionId) RUNNING.add(s.sessionId);
    bcast(s, { type: 'turn_start', qid: msg.qid, text: msg.displayText != null ? msg.displayText : msg.text, mode: msg.mode, agent: s.agent, images: msg.images || [] });
    persist(s);
    bcast(s, { type: 'queue', queue: queueView(s) });  // emptied — chips clear
    await runTurn(s, msg);
    persist(s);
    bcast(s, { type: 'queue', queue: queueView(s) });
  }
  s.running = false; s.curText = ''; s.curParts = []; s.curUser = ''; s.curUserImages = []; if (s.sessionId) RUNNING.delete(s.sessionId); bcast(s, { type: 'idle' });
}
const TURN_TIMEOUT_MS = 12 * 60 * 1000; // safety: never block the worker forever
// A turn = inject the message into the session's RC process, then render from the
// JSONL tail until the turn ends (assistant stop_reason === end_turn). Bash mode
// stays a local shell. Normal mode goes through `claude --remote-control` so the
// turn is mirrored to desktop + the official app, and uses the Max subscription.
function runTurn(s, msg) {
  return new Promise((resolve) => {
	    if (msg.mode === 'bash') {
      const emit = (o) => bcast(s, o);
      const p = spawn('bash', ['-lc', msg.text || ''], { cwd: msg.cwd || s.cwd || DEFAULT_CWD, env: childEnv() });
      s.bashProc = p;
      p.stdout.on('data', (d) => emit({ type: 'bash_out', text: d.toString() }));
      p.stderr.on('data', (d) => emit({ type: 'bash_out', text: d.toString() }));
      p.on('close', (code) => { s.bashProc = null; bcast(s, { type: 'done', qid: msg.qid, sessionId: s.sessionId, exit: code, canceled: s.canceled }); resolve(); });
      return;
	    }
    if ((msg.agent || s.agent) === 'codex') return runCodexTurn(s, msg, resolve);
	    if (!s.cwd) s.cwd = msg.cwd || DEFAULT_CWD;
    let prompt = msg.text || '';
    if (Array.isArray(msg.images) && msg.images.length) {
      const isImg = (p) => /\.(png|jpe?g|gif|webp|svg|bmp|heic|heif|avif|tiff?)$/i.test(p || '');
      prompt = msg.images.map((pp) => `[${isImg(pp) ? 'Image' : 'File'} attached at ${pp} — view it with the Read tool]`).join('\n') + '\n\n' + prompt;
    }

    let done = false;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(s.turnTimer); s.onTurnEnd = null;
      bcast(s, { type: 'done', qid: msg.qid, sessionId: s.sessionId, canceled: s.canceled });
      resolve();
    };

    (async () => {
      try {
        // Open (or reuse) the RC process for this session.
        const rec = s.sessionId ? rcEngine.open(s.sessionId, rcName(s), { force: !!msg.force, cwd: s.cwd, settings: (s.settings || {}).claude }) : rcEngine.open(null, rcName(s), { cwd: s.cwd, settings: (s.settings || {}).claude });
        if (rec && rec.blocked) {
          // Only reached for reason 'external-owner': the session is live on a REAL
          // foreign owner (your laptop / the official app) — there's no box-local
          // bridge to reattach to, so a second remote-control here would archive-loop
          // both. (A box-local twin — the cc-rc-supervisor's session or an interactive
          // box `claude` — is NOT blocked; open() reattaches to its existing bridge.)
          // Surface a take-over instead of fighting: the client renders a banner with a
          // "Take over" button that re-enqueues this same message with force:true.
          // Carry the images too so an attachment isn't lost when the user takes over.
          bcast(s, { type: 'blocked', reason: rec.reason, sessionId: s.sessionId, text: msg.text || '', images: msg.images || [] });
          finish();
          return;
        }
        s.expectUserEcho = (s.expectUserEcho || 0) + 1; // suppress our own user echo in the tail
        // For an existing session, start the tail BEFORE injecting so we catch
        // everything; for a new one we can't (no id yet) — we start it after.
        if (s.sessionId) ensureTail(s);
        s.onTurnEnd = finish;
        s.turnTimer = setTimeout(finish, TURN_TIMEOUT_MS);

        await rcEngine.sendRecord(rec, prompt);

        if (!s.sessionId) {
          await rec.session_p;                 // real id appears once the JSONL is created
          s.sessionId = rec.sessionId;
          ALIAS.set(s.sessionId, s.key); RUNNING.add(s.sessionId);
          if (s.key !== s.sessionId) { try { unlinkSync(qpath(s.key)); } catch {} }
          persist(s);
          // If this chat was started with an EXPLICIT title (e.g. delegating a Linear
          // issue sets "INC-123: …"), the official Claude app already shows it — rcName(s)
          // passed the title as the `--remote-control` name at spawn. We STILL stamp the
          // custom-title on disk so the CLI `--resume` picker and `pickup` show the ticket
          // too (those read the JSONL, not the live remote-control card). The JSONL doesn't
          // exist yet at this instant (pre-minted id → session_p resolves at spawn), so
          // poll until it appears, then stamp.
          if (s.title) stampTitleWhenReady(s.sessionId, s.title);
          bcast(s, { type: 'session', id: s.sessionId });
          ensureTail(s, 0);                    // backfill from the start (no prior history loaded)
        }
      } catch (e) {
        bcast(s, { type: 'error', msg: String(e && e.message || e).slice(-400) });
        finish();
      }
    })();
	  });
	}
function runCodexTurn(s, msg, resolve) {
  if (!s.cwd) s.cwd = msg.cwd || DEFAULT_CWD;
  let done = false;
  let assistantText = '';
  const finish = () => {
    if (done) return; done = true;
    clearTimeout(s.turnTimer); s.proc = null;
    if (s.sessionId) {
      // Persist the turn as ordered parts (separate text paragraphs + tool chips), the
      // same shape Claude history uses, so a reloaded Codex conversation renders like
      // the live view instead of collapsing into one text block. Strip heavy tool
      // results/detail — history only renders the chip label, and the store is capped.
      const parts = (s.curParts || [])
        .filter((p) => (p.t === 'text' ? !!(p.text && p.text.trim()) : p.t === 'tool'))
        .map((p) => (p.t === 'tool'
          ? { t: 'tool', id: p.id, name: p.name, input: p.input }
          : { t: 'text', text: p.text }));
      if (parts.length) appendCodexMessage(s.sessionId, 'assistant', assistantText, { parts });
    }
    bcast(s, { type: 'done', qid: msg.qid, sessionId: s.sessionId, canceled: s.canceled });
    resolve();
  };
  s.turnTimer = setTimeout(() => {
    if (s.proc) { try { s.proc.kill('SIGTERM'); } catch {} }
    finish();
  }, TURN_TIMEOUT_MS);
  s.proc = codexEngine.run({
    sessionId: s.sessionId,
    cwd: s.cwd,
    prompt: msg.text || '',
    images: msg.images || [],
    settings: (s.settings || {}).codex || DEFAULT_SETTINGS.codex,
    onEvent: (ev) => {
      if (ev.type === 'session' && ev.id) {
        s.sessionId = ev.id; s.agent = 'codex';
        ALIAS.set(s.sessionId, s.key); RUNNING.add(s.sessionId);
        if (s.key !== s.sessionId) { try { unlinkSync(qpath(s.key)); } catch {} }
        ensureCodexSession(s.sessionId, { cwd: s.cwd, title: msg.title || (msg.text || '').slice(0, 80), lastUsed: Date.now(), settings: s.settings, parentId: msg.parentId || s.parentId || null, parentTitle: msg.parentTitle || s.parentTitle || '' });
        appendCodexMessage(s.sessionId, 'user', msg.displayText != null ? msg.displayText : (msg.text || ''));
        persist(s);
        bcast(s, { type: 'session', id: s.sessionId, agent: 'codex', parentId: s.parentId || null, parentTitle: s.parentTitle || '', title: s.title || '' });
      } else if (ev.type === 'text') {
        // Codex streams each agent_message as a complete, self-contained chunk. When
        // two arrive back-to-back (no tool between) we must separate them with a blank
        // line, or the markdown renderer runs them into one block ("...worktree.The
        // company-brain skill..."). Gate the separator on the previous part already
        // being text — right after a tool the client opens a fresh text element, so a
        // leading separator there would render a stray empty paragraph.
        const raw = ev.delta || '';
        assistantText += (assistantText ? '\n\n' : '') + raw;
        const last = s.curParts[s.curParts.length - 1];
        const delta = ((last && last.t === 'text' && last.text) ? '\n\n' : '') + raw;
        pushTextPart(s, delta);
        bcast(s, { type: 'text', delta });
      } else if (ev.type === 'tool') {
        s.curTools.push(ev);
        s.curParts.push({ t: 'tool', id: ev.id, name: ev.name, input: ev.input, detail: ev.detail });
        bcast(s, ev);
      } else if (ev.type === 'tool_result') {
        const t = s.curTools.find((x) => x.id === ev.id); if (t) t.result = ev.content;
        const tp = s.curParts.find((p) => p.t === 'tool' && p.id === ev.id); if (tp) tp.result = ev.content;
        bcast(s, ev);
      } else if (ev.type === 'notice' || ev.type === 'error') {
        bcast(s, ev);
      }
    },
  });
  s.proc.on('close', finish);
  s.proc.on('error', (e) => { bcast(s, { type: 'error', msg: String(e.message || e) }); finish(); });
}
// resume persisted, non-empty queues on startup (after a restart)
(function resumePersisted() {
  let files = []; try { files = readdirSync(QDIR).filter((f) => f.endsWith('.json')); } catch {}
  for (const f of files) {
    try { const p = JSON.parse(readFileSync(join(QDIR, f), 'utf8')); if (p.queue && p.queue.length && p.sessionId) runWorker(rt(p.sessionId)); } catch {}
  }
})();

// ---- websocket ------------------------------------------------------------
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
// ---- realtime STT relay: client streams 16-bit PCM → we relay to a realtime STT
// provider → partial/committed transcripts back. PRIMARY = Deepgram streaming
// (nova-3, language=multi) — far less prone to the multilingual hallucination
// (Hindi/Russian garbage) that ElevenLabs Scribe auto-detect hits on EN+中文. Falls
// back to ElevenLabs Scribe v2 realtime only when no Deepgram key is present.
const sttWss = new WebSocketServer({ noServer: true });

// Deepgram realtime: raw PCM frames go straight onto the socket (binary), JSON control
// messages flush/close. Maps interim→partial, is_final→committed for the client, which
// has its own seal/dedup logic (sealCommitted/isSameUtterance) over those segments.
function sttDeepgram(client, rate) {
  const dgUrl = `wss://api.deepgram.com/v1/listen?model=${encodeURIComponent(DG_MODEL)}&language=multi`
    + `&encoding=linear16&sample_rate=${rate}&channels=1&interim_results=true&smart_format=true&punctuate=true`;
  const dg = new WSClient(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_KEY}` } });
  let dgOpen = false; const queue = [];
  // keep the stream alive across short pauses (Deepgram closes after ~10s of silence)
  const keepAlive = setInterval(() => { try { if (dgOpen) dg.send(JSON.stringify({ type: 'KeepAlive' })); } catch {} }, 7000);
  dg.on('open', () => { dgOpen = true; for (const b of queue) { try { dg.send(b); } catch {} } queue.length = 0; try { client.send(JSON.stringify({ type: 'ready' })); } catch {} });
  dg.on('message', (data) => {
    let o; try { o = JSON.parse(data.toString()); } catch { return; }
    if (o.type !== 'Results') return;
    const text = (o.channel && o.channel.alternatives && o.channel.alternatives[0] && o.channel.alternatives[0].transcript || '').trim();
    if (!text) return;
    try { client.send(JSON.stringify({ type: o.is_final ? 'committed' : 'partial', text })); } catch {}
  });
  dg.on('error', (e) => { try { client.send(JSON.stringify({ type: 'error', msg: String(e.message || e) })); } catch {} });
  dg.on('close', () => { clearInterval(keepAlive); try { client.close(); } catch {} });
  client.on('message', (data, isBinary) => {
    if (isBinary) { if (dgOpen) { try { dg.send(data); } catch {} } else queue.push(data); }
    else { try { const m = JSON.parse(data.toString()); if (m.type === 'commit' && dgOpen) dg.send(JSON.stringify({ type: 'Finalize' })); } catch {} }
  });
  client.on('close', () => { clearInterval(keepAlive); try { dg.send(JSON.stringify({ type: 'CloseStream' })); } catch {} try { dg.close(); } catch {} });
}

function sttEleven(client, rate) {
  const el = new WSClient(
    `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&commit_strategy=vad&audio_format=pcm_${rate}&include_language_detection=true`,
    { headers: { 'xi-api-key': ELEVEN_KEY } },
  );
  let elOpen = false; const queue = [];
  const sendChunk = (buf, commit) => { try { el.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: buf ? Buffer.from(buf).toString('base64') : '', sample_rate: rate, commit: !!commit })); } catch {} };
  el.on('open', () => { elOpen = true; for (const b of queue) sendChunk(b); queue.length = 0; });
  el.on('message', (data) => {
    let o; try { o = JSON.parse(data.toString()); } catch { return; }
    if (o.message_type === 'partial_transcript') client.send(JSON.stringify({ type: 'partial', text: o.text || '' }));
    else if (o.message_type === 'committed_transcript') client.send(JSON.stringify({ type: 'committed', text: o.text || '' }));
    else if (o.message_type === 'session_started') { try { client.send(JSON.stringify({ type: 'ready' })); } catch {} }
  });
  el.on('error', (e) => { try { client.send(JSON.stringify({ type: 'error', msg: String(e.message || e) })); } catch {} });
  el.on('close', () => { try { client.close(); } catch {} });
  client.on('message', (data, isBinary) => {
    if (isBinary) { if (elOpen) sendChunk(data, false); else queue.push(data); }
    else { try { const m = JSON.parse(data.toString()); if (m.type === 'commit' && elOpen) sendChunk(null, true); } catch {} }
  });
  client.on('close', () => { try { el.close(); } catch {} });
}

sttWss.on('connection', (client, url) => {
  const rate = Number(url.searchParams.get('rate')) || 16000;
  if (DEEPGRAM_KEY) return sttDeepgram(client, rate);
  if (ELEVEN_KEY) return sttEleven(client, rate);
  try { client.send(JSON.stringify({ type: 'error', msg: 'no STT key' })); } catch {} client.close();
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('token') !== AUTH_TOKEN) return socket.destroy();
  if (url.pathname === '/ws') return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
  if (url.pathname === '/stt') return sttWss.handleUpgrade(req, socket, head, (ws) => sttWss.emit('connection', ws, url));
  socket.destroy();
});
// Keep WebSocket connections alive through Cloudflare tunnels (which drop idle sockets after ~100s).
// Every 20s: send a protocol-level PING (dead-connection detection) AND an app-level
// { type:'ping' } text frame so the client's onmessage watchdog resets and doesn't
// kill the connection while Claude is quietly thinking between tool calls.
setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) { client.terminate(); continue; }
    client.isAlive = false;
    try { client.ping(); } catch {}
    try { if (client.readyState === 1) client.send(JSON.stringify({ type: 'ping' })); } catch {}
  }
}, 20000);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let subKey = null;
  const unsub = () => { if (subKey != null) { const s = RT.get(resolveKey(subKey)); if (s) s.subs.delete(ws); } };
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'subscribe') {
      unsub(); subKey = m.key; const s = rt(subKey); s.subs.add(ws);
      if (s.sessionId) { ensureTail(s); triggerAttentionUpdate(s); } // stream live turns + refresh status snapshot (the global waiting-watch poller handles pending prompts)
      ws.send(JSON.stringify({ type: 'sync', sessionId: s.sessionId, agent: s.agent || 'claude', parentId: s.parentId || null, parentTitle: s.parentTitle || '', title: s.title || '', settings: normalizeSettings(s.settings || {}), running: s.running, curUser: s.curUser || '', curUserImages: s.curUserImages || [], curText: s.curText, curTools: s.curTools, curParts: s.curParts, queue: queueView(s) }));
      if (s.waitingActive && s.waitingPayload) { try { ws.send(JSON.stringify(s.waitingPayload)); } catch {} } // replay a pending prompt to a (re)subscriber
    } else if (m.type === 'enqueue') {
      enqueue(m.key, { text: m.text || '', displayText: m.displayText, images: m.images || [], mode: m.mode || 'normal', agent: m.agent || 'claude', cwd: m.cwd, force: !!m.force, parentId: m.parentId || null, parentTitle: m.parentTitle || '', title: m.title || '' });
    } else if (m.type === 'settings') {
      const s = rt(m.key);
      s.settings = normalizeSettings(m.settings || s.settings || {});
      persist(s);
      if (s.sessionId && s.agent === 'codex') ensureCodexSession(s.sessionId, { cwd: s.cwd, settings: s.settings, lastUsed: Date.now() });
      bcast(s, { type: 'settings', settings: s.settings });
    } else if (m.type === 'dequeue') { dequeue(m.key, m.qid); }
    else if (m.type === 'cancel') { cancelCurrent(m.key); }
    else if (m.type === 'answer_waiting') { answerWaiting(m.key, m.sel || {}); }
  });
  ws.on('close', unsub);
});

function summarizeToolInput(name, input) {
  if (!input) return '';
  if (name === 'Bash') return (input.command || '').slice(0, 80);
  if (name === 'Read' || name === 'Edit' || name === 'Write') return (input.file_path || '').split('/').slice(-2).join('/');
  if (name === 'Grep' || name === 'Glob') return input.pattern || '';
  if (name === 'Task') return input.description || '';
  return '';
}

function killAllProcs() { for (const s of RT.values()) { if (s.bashProc) { try { s.bashProc.kill("SIGKILL"); } catch {} } } try { rcEngine.closeAll(); } catch {} }
process.on("exit", killAllProcs);
for (const sig of ["SIGTERM","SIGINT"]) process.on(sig, () => { killAllProcs(); process.exit(0); });

// Background: every 15 min refresh ATTENTION.md for sessions active in the last 4 hours
setInterval(() => {
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  const active = [];
  const seen = new Set();
  for (const dir of eachProjectDir()) {
    try {
      for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
        const id = f.replace(/\.jsonl$/, '');
        if (seen.has(id)) continue;
        try { const st = statSync(join(dir, f)); if (st.mtimeMs > cutoff && st.size > 1000) { seen.add(id); active.push(id); } } catch {}
      }
    } catch {}
  }
  active.slice(0, 6).forEach((id, i) => setTimeout(() => triggerAttentionUpdate(rt(id)), i * 8000));
}, 15 * 60 * 1000);

// Re-bind live box-local RC bridges that outlived a Box-app-server restart, so they
// show as live immediately (not as orphaned idle cards). Run once at boot + refresh
// every 30s as sessions start/stop. Cheap: one pgrep + a readlink per live bridge.
try { const n = reconcileLiveBridges(); console.log(`reconciled ${n} live RC bridge(s)`); } catch (e) { console.log('reconcile failed:', e.message); }
setInterval(() => { try { reconcileLiveBridges(); } catch {} }, 30 * 1000);

server.listen(PORT, () => {
  console.log(`\ncc-mobile (chat) on http://localhost:${PORT}`);
  console.log(`auth token: ${AUTH_TOKEN}`);
  console.log(`default cwd: ${DEFAULT_CWD}`);
  console.log(`voice: primary=${DEEPGRAM_KEY ? `Deepgram(${DG_MODEL})` : 'none'} fallback=${ELEVEN_KEY ? 'ElevenLabs Scribe' : 'none'}; clips→${VOICE_DIR}\n`);
});

// one-time: learn the real skill/command list from a claude init (kill before it answers)
if (!META.skills || !META.skills.length) {
  try {
    const p = spawn('claude', ['-p', 'hi', '--output-format', 'stream-json', '--verbose'], { cwd: DEFAULT_CWD, env: childEnv() });
    const rl2 = createInterface({ input: p.stdout });
    rl2.on('line', (line) => { let o; try { o = JSON.parse(line); } catch { return; } if (o.type === 'system' && o.subtype === 'init') { captureMeta(o); try { p.kill('SIGTERM'); } catch {} } });
    setTimeout(() => { try { p.kill('SIGTERM'); } catch {} }, 20000);
  } catch {}
}
