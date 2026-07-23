// cc-mobile — personal mobile CHAT app for box-side Claude Code.
// Native-style chat UI backed by `claude` headless stream-json (per-turn resume),
// so every box session is listable/resumable, with bash mode, @files, /skills,
// bilingual voice, and image attach. Token-gated; sits behind a Cloudflare tunnel.
import express from 'express';
import { WebSocketServer, WebSocket as WSClient } from 'ws';
import { createServer } from 'node:http';
import { spawn, execSync, execFile } from 'node:child_process';
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, statSync, readdirSync, mkdirSync, unlinkSync,
  openSync, readSync, closeSync, renameSync, chmodSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { join, resolve, dirname, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import multer from 'multer';
import { RCEngine, tail as tailJsonl, readAll as readJsonl, projectsBases, pgrepFull, pidCwd } from './rc-engine.mjs';
import * as accounts from './accounts.mjs';
import * as providerLogin from './provider-login.mjs';
import { promptFromBuffer } from './tui-prompt.mjs';
import { CodexExecEngine } from './codex-exec-engine.mjs';
import {
  codexRolloutHistory, codexRolloutMeta, codexRolloutState, tailCodexRollout,
} from './codex-rollout-history.mjs';
import { prepareRecoveredCodexMessage, recoverPersistedQueue } from './queue-state.mjs';
import { findCodexRollout, readCodexTokenInfo } from './codex-context.mjs';
import { GeminiExecEngine } from './gemini-exec-engine.mjs';
import { AgyExecEngine } from './agy-exec-engine.mjs';
import { MacExecEngine, macAvailable, macScreenshotStream } from './mac-exec-engine.mjs';
import { renderMeetingContextForIssue } from './meeting-context.mjs';
import { registerVoiceAssistant } from './voice-assistant.mjs';
import { slackConfigured } from './slack-context.mjs';
import { cleanPathToken, createLocalFileResolver, FILE_SEARCH_EXT_RE } from './local-file-resolver.mjs';

// One engine drives every session as `claude --remote-control` over node-pty, so
// a session driven from Box is simultaneously live on desktop + the official app
// (three-way sync). Input = injected keystrokes; rendering = the JSONL tail.
const rcEngine = new RCEngine();
const codexEngine = new CodexExecEngine();
const geminiEngine = new GeminiExecEngine();
const agyEngine = new AgyExecEngine();
const macEngine = new MacExecEngine();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PUBLIC = join(ROOT, 'public');
const HOME = homedir();
const PROJECTS = join(HOME, '.claude', 'projects'); // primary; for fallbacks only — scans must use eachProjectDir()
const CODEX_HOME = process.env.CODEX_HOME || join(HOME, '.codex'); // where Codex writes session rollouts
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
mkdirSync(STATE_DIR, { recursive: true });
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

const localFileResolver = () => createLocalFileResolver({ HOME, STATE_DIR, UPLOAD_DIR, defaultCwd: DEFAULT_CWD });
const expandLocalPathToken = (raw, cwd = DEFAULT_CWD) => localFileResolver().expandLocalPathToken(raw, cwd);
const resolveLocalFileReference = (raw, cwd = DEFAULT_CWD) => localFileResolver().resolveLocalFileReference(raw, cwd);

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
const localEnv = process.env.BOX_IGNORE_LOCAL_ENV === '1' ? {} : loadEnvFile(join(ROOT, '.env'));
// Optional: point EXTRA_ENV_FILE at a shared secrets file (e.g. one your harness
// already maintains) to source keys from there instead of duplicating them in .env.
const extraEnv = loadEnvFile(process.env.EXTRA_ENV_FILE || localEnv.EXTRA_ENV_FILE || '');
// Resolve a config value from (in order) the process env, .env, then the extra env file.
const cfg = (k, d = '') => process.env[k] || localEnv[k] || extraEnv[k] || d;

const PORT = Number(cfg('PORT', 7321));
// Default working directory for new chats / where /skills are scanned. Defaults to $HOME;
// set CC_WORKSPACE to your main code dir (e.g. ~/code) for a nicer default.
const ENV_DEFAULT_CWD = cfg('CC_WORKSPACE') || HOME;
const APP_SETTINGS_FILE = join(STATE_DIR, 'app-settings.json');
const VALID_APP_AGENTS = new Set(['claude', 'codex', 'gemini', 'agy', 'mac']);
const VALID_CODEX_SANDBOX = new Set(['off', 'read-only', 'workspace-write']);
const expandUserPath = (p) => {
  const s = String(p || '').trim();
  if (!s) return '';
  return resolve(s === '~' ? HOME : s.startsWith('~/') ? join(HOME, s.slice(2)) : s);
};
function normalizeAppSettings(raw = {}) {
  const out = {};
  const defaultCwd = expandUserPath(raw.defaultCwd);
  if (defaultCwd) out.defaultCwd = defaultCwd;
  const agent = String(raw.defaultAgent || '').trim().toLowerCase();
  if (VALID_APP_AGENTS.has(agent)) out.defaultAgent = agent;
  const sandbox = String(raw.codexSandbox || '').trim().toLowerCase();
  if (VALID_CODEX_SANDBOX.has(sandbox)) out.codexSandbox = sandbox;
  return out;
}
function loadAppSettings() {
  try { return normalizeAppSettings(JSON.parse(readFileSync(APP_SETTINGS_FILE, 'utf8'))); }
  catch { return {}; }
}
let APP_SETTINGS = loadAppSettings();
const appDefaultCwd = () => (APP_SETTINGS.defaultCwd && validateDirectory(APP_SETTINGS.defaultCwd)) ? APP_SETTINGS.defaultCwd : ENV_DEFAULT_CWD;
const appDefaultAgent = () => APP_SETTINGS.defaultAgent || 'claude';
const appCodexSandbox = () => APP_SETTINGS.codexSandbox || String(cfg('CODEX_SANDBOX') || 'off').trim().toLowerCase() || 'off';
let DEFAULT_CWD = appDefaultCwd();
const PROMPT_OVERRIDES_FILE = join(STATE_DIR, 'prompt-overrides.json');
const PROMPT_TEMPLATES = {
  'linear-delegation': {
    title: 'Linear delegation',
    desc: 'Seed prompt for a fresh agent dispatched from a Linear issue.',
    vars: ['issueId', 'issueTitle', 'issueContext', 'branchSlug', 'agentBranch'],
    default: `Work the Linear issue {{issueId}}: "{{issueTitle}}".

Everything the Box app already knows about this ticket is below: title, state, priority, assignee, labels, dates, links, description, attachments, meeting-source artifacts/transcript if this came from a meeting, every non-delegation comment, and agents that already touched it. Read it before re-deriving anything. Do not re-fetch the Linear ticket unless you need fresh data beyond this snapshot.

{{issueContext}}

How to work it:
- Do not edit a shared clone. Create an isolated git worktree for your branch off the latest default branch. Use a unique branch name for this ticket, for example:
  git worktree add ../{{branchSlug}} -b {{agentBranch}}/{{branchSlug}} && cd ../{{branchSlug}}
- Implement and verify the change, open or refresh the PR, and post the PR link as a comment on {{issueId}}.
- When done, set {{issueId}} to In Review, or comment your status and blockers.`,
  },
  'linear-resume': {
    title: 'Linear resume',
    desc: 'Prompt sent when resuming an existing session from a Linear issue.',
    vars: ['issueId', 'issueTitle', 'issueContext', 'branchSlug', 'agentBranch'],
    default: `Continue working on {{issueId}}: "{{issueTitle}}".

You worked on this earlier — pick up where you left off. The full CURRENT ticket context (description, meeting-source artifacts/transcript if this came from a meeting, every comment, and who else touched it) is included below so you don't need to re-fetch the Linear ticket:

{{issueContext}}

How to continue:
- If you already have a worktree/branch for it, keep using it; otherwise create one off the latest default branch:
  git worktree add ../{{branchSlug}} -b {{agentBranch}}/{{branchSlug}} && cd ../{{branchSlug}}
- Finish the work, open/refresh the PR, and post the PR link + a status comment on {{issueId}}.`,
  },
  'fork-thread': {
    title: 'Fork thread',
    desc: 'Seed prompt for a child agent thread forked from a parent chat.',
    vars: ['parentTitle', 'parentId', 'workspace', 'transcript'],
    default: `You are a forked child agent thread created in the Box mobile app.

Parent thread: {{parentTitle}}
Parent id: {{parentId}}
Workspace: {{workspace}}

Use the transcript below as prior context for this child branch. Treat this as a separate branch: do not assume future parent-thread messages are visible here, and do not write back to the parent. Do not run commands or edit files in this seed turn.

Parent transcript:
{{transcript}}

For this seed turn, briefly acknowledge that the fork is ready and mention the parent thread title. Wait for the next user instruction.`,
  },
  'switch-agent': {
    title: 'Switch agent',
    desc: 'Seed prompt when continuing a chat in another agent.',
    vars: ['targetAgent', 'sourceAgent', 'sourceTitle', 'sourceId', 'workspace', 'transcript'],
    default: `You are continuing a Box mobile conversation in {{targetAgent}} after switching from {{sourceAgent}}.

Source thread: {{sourceTitle}}
Source id: {{sourceId}}
Workspace: {{workspace}}

Use the transcript below as prior context. Continue as the same working conversation, but do not assume future messages in the source thread are visible here unless they are pasted later.

Source transcript:
{{transcript}}

For this first turn, briefly acknowledge that {{targetAgent}} has the prior context and is ready to continue. Do not run commands or edit files until the next user instruction.`,
  },
  'review-current': {
    title: 'Review command',
    desc: 'Prompt inserted by the built-in /review command.',
    vars: [],
    default: 'Review the current working tree. Prioritize bugs, behavioral regressions, security risks, and missing tests. Lead with findings ordered by severity and include file/line references where possible.',
  },
  'attention-status': {
    title: 'Morning brief status',
    desc: 'Server-side prompt used to update per-session Needs input / In progress / Done briefs.',
    vars: ['ownerName', 'existingDocBlock', 'imageSection', 'recentTurns', 'imageRule', 'doneImageHint'],
    default: `You are maintaining a morning-briefing status doc for {{ownerName}} so {{ownerName}} can orient after being away, without reading the full chat.

{{existingDocBlock}}{{imageSection}}RECENT CONVERSATION (last 20 turns — use this to update the doc):
{{recentTurns}}

Output ONLY the updated markdown — no preamble, no commentary. Rules:
- KEEP existing "Needs your input" items unless the new conversation clearly resolves them
- REMOVE or move to "Done recently" any item explicitly completed in the new turns
- ADD new blocking items or decisions discovered in the new turns
- If the new turns are just idle checks / heartbeats with no new information, output the existing doc mostly unchanged
- Omit a section only if it genuinely has nothing to say
{{imageRule}}

## Needs your input
For each open decision or question blocking progress, write:

**[Topic label]**
- *Question:* Exactly what needs to be decided or answered — specific, not vague
- *Context:* 1–2 sentences: what's already done, what's at stake, what options exist if relevant
- *Why now:* why it's blocking (skip if obvious)

## In progress
- [item] — [what specifically is happening and current state]

## Done recently
- [item] — [what was completed and its outcome]{{doneImageHint}}

Be specific enough that {{ownerName}} can act or reply without reading the chat. List all sub-questions under a topic, not just the topic label.`,
  },
};
function loadPromptOverrides() {
  try {
    const o = JSON.parse(readFileSync(PROMPT_OVERRIDES_FILE, 'utf8'));
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch { return {}; }
}
let PROMPT_OVERRIDES = loadPromptOverrides();
function promptTemplateList() {
  return Object.entries(PROMPT_TEMPLATES).map(([id, tpl]) => ({
    id,
    title: tpl.title,
    desc: tpl.desc,
    vars: tpl.vars,
    default: tpl.default,
    value: typeof PROMPT_OVERRIDES[id] === 'string' ? PROMPT_OVERRIDES[id] : tpl.default,
    overridden: typeof PROMPT_OVERRIDES[id] === 'string',
  }));
}
function renderTemplate(id, vars = {}) {
  const tpl = PROMPT_TEMPLATES[id];
  const raw = (tpl && typeof PROMPT_OVERRIDES[id] === 'string') ? PROMPT_OVERRIDES[id] : (tpl && tpl.default) || '';
  return raw.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => String(vars[key] ?? ''));
}
const HOOK_SPECS = [
  { id: 'inject-time', title: 'Inject current time', file: 'inject-time.sh', event: 'UserPromptSubmit' },
  { id: 'surface-attention', title: 'Surface needs-you items', file: 'surface-attention.sh', event: 'SessionStart' },
  { id: 'surface-slack', title: 'Surface recent Slack context', file: 'surface-slack.sh', event: 'SessionStart' },
  { id: 'skip-automated', title: 'Skip automated sessions helper', file: '_skip-automated.sh', event: 'helper' },
];
const hookSpec = (id) => HOOK_SPECS.find((h) => h.id === id || h.file === id);
const defaultHookPath = (spec) => join(ROOT, 'harness', 'hooks', spec.file);
const liveHookPath = (spec) => join(HOME, '.claude', 'hooks', spec.file);
function hookPayload(spec) {
  const live = liveHookPath(spec);
  const fallback = defaultHookPath(spec);
  const path = existsSync(live) ? live : fallback;
  let content = ''; try { content = readFileSync(path, 'utf8'); } catch {}
  let defaultContent = ''; try { defaultContent = readFileSync(fallback, 'utf8'); } catch {}
  return { id: spec.id, title: spec.title, file: spec.file, event: spec.event, path, livePath: live, defaultPath: fallback, source: existsSync(live) ? 'live' : 'repo-default', content, defaultContent, overridden: existsSync(live) && content !== defaultContent };
}
const STT_MODELS = cfg('STT_MODEL', 'scribe_v2,scribe_v1').split(',');
// Voice (speech-to-text) is OPTIONAL. ElevenLabs Scribe is the zero-friction pick;
// Deepgram nova-3 is the higher-quality batch transcriber. Leave both unset to disable voice.
const ELEVEN_KEY = cfg('ELEVENLABS_API_KEY');
const DEEPGRAM_KEY = cfg('DEEPGRAM_API_KEY');
const DG_MODEL = cfg('DG_STT_MODEL', 'nova-3');

// ---- personalization + optional integrations ------------------------------
// Your name, used in the morning-brief status doc the app keeps per session.
const OWNER_NAME = cfg('OWNER_NAME', 'you');
// Linear: the in-app Board + "needs you" inbox. Two modes:
//   • REAL Linear  — set LINEAR_API_KEY (+ LINEAR_TEAM_ID / LINEAR_TEAM_KEY) to drive a real
//     Linear workspace.
//   • LOCAL clone  — with NO key, the box runs a built-in, account-free clone of Linear backed
//     by a SQLite file (~/.cc-mobile/linear-lite.db). The Board + inbox work out of the box; if
//     you later connect a real Linear, `node bin/linear-lite.mjs import` pushes everything up.
// NEEDS_LABEL = the label that flags an issue as needing your personal decision.
// Set LINEAR_LOCAL=off to fully disable the Board instead of falling back to the local clone.
const NEEDS_LABEL = cfg('NEEDS_LABEL', 'needs-me');
const LINEAR_KEY_RAW = cfg('LINEAR_API_KEY');
const LINEAR_LOCAL = !LINEAR_KEY_RAW && cfg('LINEAR_LOCAL') !== 'off';
let linearLite = null;
if (LINEAR_LOCAL) {
  try {
    const { createLinearLite } = await import('../lib/linear-lite/index.mjs');
    linearLite = createLinearLite({
      dbPath: join(STATE_DIR, 'linear-lite.db'),
      teamKey: cfg('LINEAR_TEAM_KEY') || 'TASK',
      teamName: cfg('LINEAR_TEAM_NAME') || 'Tasks',
      needsLabel: NEEDS_LABEL,
    });
    console.log(`[box] Linear (local clone) ready — ${join(STATE_DIR, 'linear-lite.db')}, team ${linearLite.teamKey}. Connect real Linear later: node bin/linear-lite.mjs import`);
  } catch (e) { console.error('[box] linear-lite init failed (Board disabled):', e && e.message); }
}
// In local mode the team id/key come from the embedded clone; otherwise from config.
const LINEAR_TEAM_ID = linearLite ? linearLite.teamId : cfg('LINEAR_TEAM_ID');
const LINEAR_TEAM_KEY = linearLite ? linearLite.teamKey : cfg('LINEAR_TEAM_KEY');
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
const saveNames = (n) => { writeFileSync(NAMES_FILE, JSON.stringify(n, null, 2)); invalidateSessionLists(); };

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
  // Archived = "I'm done with this chat" → it must NOT keep a `claude --remote-control`
  // process burning RAM. Reap any bridge belonging to an archived session here instead of
  // re-binding it as live. Because this runs on startup AND every 30s, a bridge that leaked
  // (archived before this reaper shipped, archived while the server was down, or somehow
  // respawned) is torn down within one tick — the chronic memory pressure / OOM crash-restart
  // loop behind INC-980. Resuming a chat un-archives it (see runWorker → unarchiveOnResume),
  // so an actively used session is never reaped.
  let archived; try { archived = loadArchived(); } catch { archived = new Set(); }
  let reaped = 0;
  const out = pgrepFull('--remote-control');
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
    if (archived.has(sessionId)) {
      // Tear the archived bridge down — unless a turn is mid-flight (RUNNING), since resuming
      // unarchives, this only guards a sub-tick race — and never bind an archived session as
      // "live". killSessionBridge is idempotent, so once reaped it won't be re-found next tick.
      if (!RUNNING.has(sessionId)) { try { killSessionBridge(sessionId); reaped++; } catch {} }
      continue;
    }
    const rcm = cmd.match(/--remote-control\s+(\S+)/);
    const cwd = pidCwd(pid);
    next.set(sessionId, { rcName: rcm ? rcm[1] : null, cwd: cwd || DEFAULT_CWD, pid });
  }
  LIVE_BRIDGES.clear();
  for (const [k, v] of next) LIVE_BRIDGES.set(k, v);
  if (reaped) console.log(`reaped ${reaped} archived RC bridge(s)`);
  return LIVE_BRIDGES.size;
}

// Tear down the remote-control bridge for a session. Archiving a chat means "I'm done
// with this" — there's no reason to keep a `claude --remote-control` process (and its
// dtach master) burning memory + re-running heartbeats/auto-update for it. We (1) drop
// it from the supervisor registry so the 2-min keeper tick won't relaunch it, (2) kill
// the dtach master + claude child (both carry the session id in argv — curated bridges
// live at /tmp/cc-rc-<rcName>.dtach, box-local ones at /tmp/cc-box-<id>.dtach), and
// (3) remove the now-stale sockets. Idempotent + best-effort: missing pieces are fine.
function killSessionBridge(id) {
  if (!id || !/^[0-9a-fA-F-]{8,}$/.test(id)) return { killed: 0 };
  let rcName = null;
  try { const rc = readRcRegistry(); if (rc[id]) rcName = rc[id].rcName; } catch {}
  try {
    if (existsSync(RC_REGISTRY)) {
      const lines = readFileSync(RC_REGISTRY, 'utf8').split('\n');
      const kept = lines.filter((l) => { const c = l.split('\t'); return !(c[2] && c[2].trim() === id); });
      if (kept.length !== lines.length) {
        // atomic rewrite (tmp + rename) — external scripts (cnew/boxsesh) append rows
        // concurrently; a torn write would silently drop curated sessions.
        const tmp = `${RC_REGISTRY}.tmp.${process.pid}`;
        try { writeFileSync(tmp, kept.join('\n')); renameSync(tmp, RC_REGISTRY); } catch { try { unlinkSync(tmp); } catch {} }
      }
    }
  } catch {}
  // Match ONLY real bridge processes: the line must carry both this id AND the
  // `--remote-control` flag (both the dtach master and the claude child have it). We do
  // NOT match on socket-path substrings (cc-rc-/cc-box-) — those show up in routine
  // operator commands (`ls /tmp/cc-rc-*`, greps), and matching them would let an archive
  // POST SIGKILL an unrelated shell that merely mentions a session. claude ignores a
  // lone SIGTERM, so escalate to SIGKILL after a grace period (the supervisor does the
  // same); the registry row is already gone, so nothing relaunches it.
  const pids = [];
  try {
    const out = pgrepFull(id);
    for (const line of out.split('\n')) {
      if (!line.trim() || !/--remote-control(\s|$)/.test(line)) continue;
      const pid = parseInt(line, 10);
      if (pid && pid !== process.pid) pids.push(pid);
    }
  } catch {}
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  if (pids.length) setTimeout(() => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} } }, 3000).unref?.();
  // Box-local sockets are keyed by the FIRST 8 hex chars of the id (rc-engine rcSockPath:
  // /tmp/cc-box-<id8>.dtach), NOT the full uuid — use the engine's own path so the stale
  // socket is actually removed (the old full-id path never matched, leaving a dead socket
  // that `dtach -A` would later reattach to).
  for (const sock of [rcEngine.sockPath(id), rcName ? `/tmp/cc-rc-${rcName}.dtach` : null]) {
    if (sock) { try { unlinkSync(sock); } catch {} }
  }
  LIVE_BRIDGES.delete(id);
  return { killed: pids.length };
}

function restoreSessionBridge(id) {
  if (!id || !/^[0-9a-fA-F-]{8,}$/.test(id)) return { started: false, reason: 'bad-id' };
  try {
    if ((loadCodex().sessions || {})[id]) return { started: false, reason: 'codex-on-demand' };
  } catch {}
  const file = findSessionFile(id);
  if (!file) return { started: false, reason: 'history-not-found' };
  try {
    const s = rt(id);
    s.sessionId = id;
    s.agent = s.agent || 'claude';
    s.cwd = s.cwd || decodeCwd(dirname(file)) || DEFAULT_CWD;
    persist(s);
    const rec = rcEngine.open(id, rcName(s), { cwd: s.cwd, settings: (s.settings || {}).claude });
    if (rec && rec.blocked) return { started: false, reason: rec.reason || 'blocked' };
    ensureTail(s);
    LIVE_BRIDGES.set(id, { rcName: rcName(s), cwd: s.cwd, pid: rec && rec.pid ? rec.pid : null });
    return { started: true };
  } catch (e) {
    return { started: false, reason: String((e && e.message) || e).slice(-160) };
  }
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
// mtime+size-keyed caches for the per-file reads listSessions does on every rebuild.
// The feed scan tail-reads 130 files and head/tail-reads ~40 more; almost none change
// between rebuilds (the 5s list cache is invalidated constantly by RUNNING/archive/
// favorite churn), so without these every rebuild re-read ~7MB and blocked the event
// loop 150-250ms — stalling every request AND every open chat's WebSocket stream.
const FILE_READ_CACHES = [];
function cachedFileRead(cache, file, compute) {
  let st;
  try { st = statSync(file); } catch { return compute(); }
  const hit = cache.get(file);
  if (hit && hit.m === st.mtimeMs && hit.s === st.size) return hit.v;
  const v = compute();
  if (cache.size > 8000) cache.clear();
  cache.set(file, { m: st.mtimeMs, s: st.size, v });
  return v;
}
function makeFileReadCache(fn) {
  const cache = new Map();
  FILE_READ_CACHES.push(cache);
  return (file, ...rest) => cachedFileRead(cache, file, () => fn(file, ...rest));
}
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
const titleMeta = makeFileReadCache(titleMetaRead);
function titleMetaRead(file) {
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
const sessionPreview = makeFileReadCache(sessionPreviewRead);
function sessionPreviewRead(file) {
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
// tail-read a session: last meaningful message text (preview), whether the agent is
// waiting on the user (last turn was the assistant and it ended with a question), and
// `lastTs` = the newest real chat timestamp = true last-activity time.
//
// lastTs intentionally ignores records with no `timestamp` field. An idle
// remote-control bridge keeps appending control records (bridge-session,
// permission-mode, mode, ai-title, last-prompt, file-history-snapshot …) that carry NO
// timestamp; those writes bump the file mtime without any actual chat. Sorting/showing
// the feed by file mtime therefore floats days-old sessions to the top with a near-now
// time — exactly the "archived chats suddenly reappear as just-now" bug. lastTs reads
// the real conversation clock instead, so an idle heartbeat can't fake recency.
const tailInfo = makeFileReadCache(tailInfoRead);
function tailInfoRead(file) {
  try {
    const st = statSync(file); const len = Math.min(st.size, 48 * 1024); const start = st.size - len;
    const fd = openSync(file, 'r'); const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, start); closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    let lastTs = 0, preview = '', needsInput = false, gotMsg = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      if (!lastTs && o.timestamp) { const t = Date.parse(o.timestamp); if (t) lastTs = t; }
      if (!gotMsg && (o.type === 'assistant' || o.type === 'user') && o.message) {
        const c = o.message.content;
        let t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
        t = (t || '').trim();
        if (t && !t.startsWith('<') && !t.startsWith('Caveat:')) {
          const role = o.message.role || o.type;
          preview = t.replace(/\s+/g, ' ').slice(0, 100);
          needsInput = role === 'assistant' && /[?？]["'）)\]]*\s*$/.test(t);
          gotMsg = true;
        }
      }
      if (lastTs && gotMsg) break;
    }
    return { preview, needsInput, lastTs };
  } catch {}
  return { preview: '', needsInput: false, lastTs: 0 };
}
// session ids with a currently-running worker turn (set maintained by runWorker)
const RUNNING = new Set();
function addRunning(id) { if (id && !RUNNING.has(id)) { RUNNING.add(id); invalidateSessionLists(); } }
function deleteRunning(id) { if (id && RUNNING.delete(id)) invalidateSessionLists(); }

// Atomic JSON write: write a temp file then rename over the target, so a concurrent reader
// always sees either the old or the new COMPLETE file — never a half-written (torn) one.
// Without this, two box processes writing the same state file (e.g. an overlapping keeper
// restart) could let a reader catch a truncated file → JSON.parse throws → the loader's
// catch returns empty → the next save persists that emptiness and wipes the state.
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp.${process.pid}`;
  try { writeFileSync(tmp, JSON.stringify(data)); renameSync(tmp, file); }
  catch { try { writeFileSync(file, JSON.stringify(data)); } catch {} try { unlinkSync(tmp); } catch {} }
}
const ARCH_FILE = join(STATE_DIR, 'archived.json');
// archived.json stays a bare ARRAY of ids (membership) — never change its shape, so the
// `pickup` CLI and any older box build keep reading it. Archive *timestamps* live in a
// separate sidecar so the Archived view can sort most-recently-archived first.
const loadArchived = () => { try { return new Set(JSON.parse(readFileSync(ARCH_FILE, 'utf8'))); } catch { return new Set(); } };
const saveArchived = (set) => { writeJsonAtomic(ARCH_FILE, [...set]); invalidateSessionLists(); };
const ARCH_AT_FILE = join(STATE_DIR, 'archived-at.json');   // { sessionId: archivedAtMs } — additive sidecar
const loadArchivedAt = () => { try { const o = JSON.parse(readFileSync(ARCH_AT_FILE, 'utf8')); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch { return {}; } };
const saveArchivedAt = (m) => { writeJsonAtomic(ARCH_AT_FILE, m); invalidateSessionLists(); };
const FAVORITES_FILE = join(STATE_DIR, 'favorites.json');
const loadFavorites = () => { try { return new Set(JSON.parse(readFileSync(FAVORITES_FILE, 'utf8'))); } catch { return new Set(); } };
const saveFavorites = (set) => { writeJsonAtomic(FAVORITES_FILE, [...set]); invalidateSessionLists(); };
// Resuming an archived chat brings it back to life: when the user sends a new message we
// un-archive it so it rejoins the active feed AND the reconcile reaper (which tears down
// bridges for archived sessions, see reconcileLiveBridges) leaves its freshly-spawned bridge
// alone. No-op (no disk write) when the session isn't archived, so it's cheap to call on every
// turn. Mirrors the archive endpoint's two-file update (archived.json + the archived-at sidecar).
function unarchiveOnResume(id) {
  if (!id) return false;
  try {
    const set = loadArchived();
    if (!set.has(id)) return false;
    set.delete(id); saveArchived(set);
    const at = loadArchivedAt(); if (id in at) { delete at[id]; saveArchivedAt(at); }
    return true;
  } catch { return false; }
}

// ---- full-text session search via the `sessiongrep` CLI (Rust). It self-reindexes
// incrementally before each search, so results stay fresh. We parse its text output and
// only surface sessions THIS box can actually open (claude jsonl on disk / known codex).
const SESSIONGREP_BIN = (() => {
  const c = cfg('SESSIONGREP_BIN'); if (c) return c;
  const cargo = join(HOME, '.cargo', 'bin', 'sessiongrep');
  return existsSync(cargo) ? cargo : 'sessiongrep';
})();
const SG_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SG_HDR = new RegExp(`^(.+?)\\s+(claude|codex|cursor|antigravity|pi)\\s+(${SG_UUID})\\s+(.*?)\\s+match=(\\S+)\\s+score=(\\d+)\\s*$`, 'i');
const sgStrip = (s) => String(s || '').replace(/\[\[|\]\]/g, '');   // sessiongrep marks matched terms with [[ ]]
function parseSessiongrep(out) {
  const results = []; let cur = null;
  for (const line of String(out || '').split('\n')) {
    const h = line.match(SG_HDR);
    if (h) { cur = { age: h[1].trim(), provider: h[2].toLowerCase(), id: h[3], title: sgStrip(h[4]).trim(), match: h[5], score: +h[6], cwd: '', preview: '', snippet: '' }; results.push(cur); continue; }
    if (!cur) continue;
    const cw = line.match(/^\s+cwd=(.*?)\s+preview=(.*)$/);
    if (cw) { cur.cwd = cw[1].trim(); cur.preview = sgStrip(cw[2]).trim(); continue; }
    const hit = line.match(/^\s+hit\[[^\]]*\]:\s*(.*)$/);
    if (hit) { cur.snippet = sgStrip(hit[1]).trim(); continue; }
  }
  return results;
}
const SESSION_SEARCH_STOP = new Set([
  'a', 'an', 'and', 'are', 'about', 'all', 'can', 'chat', 'chats', 'find', 'for', 'from', 'i',
  'im', 'in', 'it', 'like', 'looking', 'me', 'my', 'of', 'on', 'or', 'past', 'session', 'sessions',
  'stuff', 'talk', 'talking', 'that', 'the', 'this', 'to', 'was', 'were', 'with', 'you',
]);
const SESSION_SEARCH_EXPANSIONS = [
  {
    terms: ['visa', 'immigration', 'rfe', 'uscis', 'h1b', 'h-1b', 'o1', 'o-1', 'opt', 'lawyer', 'attorney'],
    queries: [
      'immigration visa RFE USCIS O-1 H-1B OPT',
      'Request for Evidence petition attorney lawyer immigration',
      'status change visa petition denial USCIS',
    ],
  },
  {
    terms: ['linear', 'ticket', 'issue', 'needs-jimmy', 'inc'],
    queries: ['Linear issue ticket INC needs-jimmy', 'work queue in progress Linear'],
  },
  {
    terms: ['email', 'gmail', 'inbox', 'mail'],
    queries: ['email Gmail inbox message thread', 'AgentMail sent received email'],
  },
  {
    terms: ['meeting', 'call', 'transcript', 'recording'],
    queries: ['meeting transcript recording Circleback Deepgram', 'call notes action items'],
  },
];
function sessionSearchTokens(q) {
  return String(q || '').toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)?/g) || [];
}
function addSearchQuery(list, seen, query, kind = 'query') {
  const clean = String(query || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 2) return;
  const key = clean.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  list.push({ query: clean, kind });
}
function buildSessionSearchQueries(q) {
  const tokens = sessionSearchTokens(q);
  const tok = new Set(tokens);
  const queries = []; const seen = new Set();
  addSearchQuery(queries, seen, q, 'exact');
  const meaningful = tokens.filter((t) => !SESSION_SEARCH_STOP.has(t));
  if (meaningful.length) addSearchQuery(queries, seen, meaningful.join(' '), 'keywords');
  for (const intent of SESSION_SEARCH_EXPANSIONS) {
    if (!intent.terms.some((t) => tok.has(t))) continue;
    const intentTerms = meaningful.filter((t) => intent.terms.includes(t));
    if (intentTerms.length && intentTerms.length !== meaningful.length) addSearchQuery(queries, seen, intentTerms.join(' '), 'intent');
    for (const query of intent.queries) addSearchQuery(queries, seen, query, 'expanded');
  }
  return queries.slice(0, 8);
}
function runSessiongrepSearch(query, limit = 40) {
  return new Promise((resolve) => {
    execFile(SESSIONGREP_BIN, ['search', query, '--limit', String(limit)], { timeout: 9000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve({ error: 'search unavailable', results: [] });
      resolve({ results: parseSessiongrep(stdout) });
    });
  });
}
function usableSearchText(s) {
  const text = sgStrip(s).replace(/https?:\/\/\S+/g, '[link]').replace(/\bX-Amz-[A-Za-z]+=\S+/g, '').replace(/\s+/g, ' ').trim();
  if (!text || text === '[link]') return '';
  if (!/[a-z0-9]{3}/i.test(text)) return '';
  if (text.length > 60 && /[?&]X-Amz-|%2Faws4_request|X-Amz-Signature/i.test(text)) return '';
  return text;
}
function sessionSearchPreview(r) {
  return usableSearchText(r.snippet) || usableSearchText(r.preview);
}
function sessionSearchRank(r, variant, queryTokens) {
  const hay = `${r.title} ${r.cwd} ${r.preview} ${r.snippet}`.toLowerCase();
  let overlap = 0;
  for (const t of queryTokens) if (t.length > 2 && hay.includes(t)) overlap += 1;
  const kindBoost = ({ exact: 24, keywords: 32, intent: 46, expanded: 38 })[variant.kind] || 0;
  const fieldBoost = r.match === 'title' ? 18 : r.match === 'cwd' ? 8 : 0;
  return (Number(r.score) || 0) + kindBoost + fieldBoost + (overlap * 12);
}
const JSON_FILE_CACHE = new Map();
function loadJsonCached(file, fallback) {
  let st = null;
  try { st = statSync(file); } catch { return fallback(); }
  const cached = JSON_FILE_CACHE.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.value;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    JSON_FILE_CACHE.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch {
    return fallback();
  }
}
function rememberJsonCache(file, value) {
  try {
    const st = statSync(file);
    JSON_FILE_CACHE.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  } catch {
    JSON_FILE_CACHE.set(file, { mtimeMs: 0, size: 0, value });
  }
}
const CODEX_FILE = join(STATE_DIR, 'codex-sessions.json');
const loadCodex = () => loadJsonCached(CODEX_FILE, () => ({ sessions: {} }));
const saveCodex = (state) => { writeJsonAtomic(CODEX_FILE, state); rememberJsonCache(CODEX_FILE, state); invalidateSessionLists(); };
// Codex transcripts live in per-session sidecar files, NOT inline in codex-sessions.json.
// Inline transcripts grew that file to ~90MB, and saveCodex() re-stringified + rewrote ALL
// of it on EVERY message append / streaming flush — ~1s of event-loop blockage that froze
// every request and every open chat's WebSocket stream. The sidecar makes a codex message
// write O(one session) instead of O(all sessions ever).
const CODEX_MSG_DIR = join(STATE_DIR, 'codex-messages');
const CODEX_MSG_LIMIT = 160;
const codexMsgFile = (id) => join(CODEX_MSG_DIR, String(id).replace(/[^\w.-]/g, '_') + '.json');
// `session` lets a legacy inline `messages` array (written by an old build) win until
// the next save migrates it out.
function loadCodexMessages(id, session = null) {
  if (session && Array.isArray(session.messages) && session.messages.length) return session.messages;
  if (!id) return [];
  const v = loadJsonCached(codexMsgFile(id), () => []);
  return Array.isArray(v) ? v : [];
}
function saveCodexMessages(id, msgs) {
  if (!id) return;
  try { mkdirSync(CODEX_MSG_DIR, { recursive: true }); } catch {}
  const f = codexMsgFile(id);
  const v = (msgs || []).slice(-CODEX_MSG_LIMIT);
  writeJsonAtomic(f, v);
  rememberJsonCache(f, v);
}
// One-time boot migration: split any inline transcripts out to sidecars and shrink the
// main state file to metadata only. Runs before the server accepts connections.
(function splitInlineCodexMessages() {
  try {
    const state = loadCodex();
    const sessions = state.sessions || {};
    const inline = Object.keys(sessions).filter((k) => Array.isArray(sessions[k] && sessions[k].messages) && sessions[k].messages.length);
    if (!inline.length) return;
    for (const k of inline) saveCodexMessages(k, sessions[k].messages);
    for (const k of Object.keys(sessions)) { if (sessions[k]) delete sessions[k].messages; }
    saveCodex(state);
    console.log(`[codex] split ${inline.length} inline transcripts into ${CODEX_MSG_DIR}`);
  } catch (e) { console.error('[codex] transcript split failed:', e); }
})();
const GEMINI_FILE = join(STATE_DIR, 'gemini-sessions.json');
const loadGemini = () => loadJsonCached(GEMINI_FILE, () => ({ sessions: {} }));
const saveGemini = (state) => { writeJsonAtomic(GEMINI_FILE, state); rememberJsonCache(GEMINI_FILE, state); invalidateSessionLists(); };
const AGY_FILE = join(STATE_DIR, 'agy-sessions.json');
const loadAgy = () => loadJsonCached(AGY_FILE, () => ({ sessions: {} }));
const saveAgy = (state) => { writeJsonAtomic(AGY_FILE, state); rememberJsonCache(AGY_FILE, state); invalidateSessionLists(); };
// Mac "Computer Use" sessions run codex on the user's Mac (via cu-bridge) — same on-disk
// transcript shape as Codex/Gemini so the list + reopen "just work".
const MAC_FILE = join(STATE_DIR, 'mac-sessions.json');
const loadMac = () => loadJsonCached(MAC_FILE, () => ({ sessions: {} }));
const saveMac = (state) => { writeJsonAtomic(MAC_FILE, state); rememberJsonCache(MAC_FILE, state); invalidateSessionLists(); };
function codexMessageText(m) {
  if (!m) return '';
  const out = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) out.push(v); };
  push(m.text);
  if (typeof m.content === 'string') push(m.content);
  else if (Array.isArray(m.content)) {
    for (const p of m.content) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') push(p.text);
    }
  }
  if (Array.isArray(m.parts)) {
    for (const p of m.parts) {
      if (!p || typeof p !== 'object') continue;
      if (p.t === 'text' || p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') push(p.text);
    }
  }
  return out.join('\n').trim();
}
function codexMessageTs(m) {
  return m && (m.ts || m.timestamp || m.createdAt || m.created || null);
}
function codexUserMessagesFromSession(session) {
  const messages = [];
  for (const m of loadCodexMessages(session && session.id, session)) {
    if (!m || m.role !== 'user') continue;
    const text = codexMessageText(m);
    if (!text) continue;
    messages.push({ text, ts: codexMessageTs(m) });
  }
  return messages;
}
function conversationMarkdown({ title, agent = 'Claude', messages = [] }) {
  const safeTitle = title || 'conversation';
  const header = `# ${safeTitle}\n\nExported ${messages.length} messages\n\n`;
  const assistantName = agent === 'codex' ? 'Codex' : agent === 'gemini' ? 'Gemini' : agent === 'agy' ? 'Antigravity' : agent === 'mac' ? 'Computer Use' : 'Claude';
  const body = messages.map((m) => {
    const role = m.role === 'user' ? '**You**' : `**${assistantName}**`;
    const text = (m.parts || []).filter((p) => p.t === 'text').map((p) => p.text).join('\n').trim();
    const tools = (m.parts || []).filter((p) => p.t === 'tool').map((p) => `\`[${p.name}]\``).join(' ');
    return `${role}\n\n${text || ''}${tools ? (text ? '\n\n' : '') + tools : ''}`.trim();
  }).filter((s) => s.length > 10).join('\n\n---\n\n');
  return header + body;
}
const SESSION_STORES = [
  { agent: 'codex', load: loadCodex, save: saveCodex },
  { agent: 'gemini', load: loadGemini, save: saveGemini },
  { agent: 'agy', load: loadAgy, save: saveAgy },
  { agent: 'mac', load: loadMac, save: saveMac },
];
function storedSession(id) {
  for (const spec of SESSION_STORES) {
    const state = spec.load();
    const rec = state.sessions && state.sessions[id];
    if (rec) return { ...spec, state, rec };
  }
  return null;
}
function fullSessionHistory(id) {
  const stored = storedSession(id);
  if (stored) {
    const rec = stored.rec;
    return {
      id,
      title: rec.title || `${agentDisplayName(stored.agent)} chat`,
      cwd: rec.cwd || DEFAULT_CWD,
      agent: stored.agent,
      settings: normalizeSettings(rec.settings || {}),
      parentId: rec.parentId || null,
      parentTitle: rec.parentTitle || '',
      context: stored.agent === 'codex' ? contextForSession(id, { agent: 'codex', codex: rec }) : normalizeContext(rec.context || { agent: stored.agent }),
      messages: rec.messages || [],
      mutable: true,
    };
  }
  const file = findSessionFile(id);
  if (!file) return { id, title: id.slice(0, 8), cwd: DEFAULT_CWD, agent: 'claude', settings: normalizeSettings({}), messages: [], mutable: false };
  const MAX = 50 * 1024 * 1024;
  const { size } = statSync(file);
  let raw;
  if (size <= MAX) raw = readFileSync(file, 'utf8');
  else {
    const buf = Buffer.allocUnsafe(MAX);
    const fd = openSync(file, 'r'); readSync(fd, buf, 0, MAX, size - MAX); closeSync(fd);
    const s = buf.toString('utf8'); const nl = s.indexOf('\n'); raw = nl >= 0 ? s.slice(nl + 1) : s;
  }
  return {
    id,
    title: sessionTitle(file) || id.slice(0, 8),
    cwd: decodeCwd(dirname(file)),
    agent: 'claude',
    settings: normalizeSettings({}),
    context: contextForSession(id, { agent: 'claude', file }),
    messages: parseJsonlMessages(raw),
    mutable: false,
  };
}
function codexSessionMentionCount(session, issueId) {
  let n = 0;
  for (const m of loadCodexMessages(session && session.id, session)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const txt = codexMessageText(m);
    if (!txt) continue;
    n += (txt.match(new RegExp(issueId, 'g')) || []).length;
  }
  return n;
}
function codexSessionMtime(session) {
  const v = session && (session.lastUsed || session.updatedAt || session.created);
  if (typeof v === 'number') return v;
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? t : 0;
}
// Delegation ledger: INC-id (e.g. "INC-917") -> array of delegation records, oldest→newest.
// The LAST entry is the current/primary delegation (the session the user delegated to most
// recently); the history is kept so a re-delegated ticket still shows every owner.
const DELEG_FILE = join(STATE_DIR, 'delegations.json');
const loadDelegations = () => { try { return JSON.parse(readFileSync(DELEG_FILE, 'utf8')); } catch { return {}; } };
const saveDelegations = (d) => { try { writeFileSync(DELEG_FILE, JSON.stringify(d, null, 2)); } catch {} };
const latestDelegation = (arr) => (Array.isArray(arr) && arr.length) ? arr[arr.length - 1] : null;
const DEFAULT_SETTINGS = {
  codex: { model: 'gpt-5.6-sol', reasoningEffort: 'high', sandbox: appCodexSandbox() },
  gemini: { model: 'gemini-3.5-flash' },
  agy: { model: '' },
  mac: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
  claude: { model: 'opus', effort: 'xhigh' },
};
const refreshRuntimeDefaults = () => {
  DEFAULT_CWD = appDefaultCwd();
  DEFAULT_SETTINGS.codex.sandbox = appCodexSandbox();
};
function normalizeSettings(settings = {}) {
  return {
    codex: { ...DEFAULT_SETTINGS.codex, ...((settings && settings.codex) || {}) },
    gemini: { ...DEFAULT_SETTINGS.gemini, ...((settings && settings.gemini) || {}) },
    agy: { ...DEFAULT_SETTINGS.agy, ...((settings && settings.agy) || {}) },
    mac: { ...DEFAULT_SETTINGS.mac, ...((settings && settings.mac) || {}) },
    claude: { ...DEFAULT_SETTINGS.claude, ...((settings && settings.claude) || {}) },
  };
}
function appSettingsPayload() {
  return {
    defaultCwd: DEFAULT_CWD,
    envDefaultCwd: ENV_DEFAULT_CWD,
    defaultAgent: appDefaultAgent(),
    codexSandbox: appCodexSandbox(),
    settingsFile: APP_SETTINGS_FILE,
  };
}
function validateDirectory(dir) {
  try {
    const st = statSync(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}
const DEFAULT_CONTEXT_WINDOWS = {
  codex: 258400,
  claude: 1000000,
  gemini: 1000000,   // Gemini 2.5 / 3.x all expose a ~1M-token context window
  mac: 258400,       // Computer Use = codex on the Mac
};
function modelContextWindow(agent, model) {
  const m = String(model || '').toLowerCase();
  if (agent === 'codex' || agent === 'mac') {
    if (!m || m.startsWith('gpt-5.6')) return 1050000;
    return DEFAULT_CONTEXT_WINDOWS.codex;
  }
  if (agent === 'gemini') return DEFAULT_CONTEXT_WINDOWS.gemini;
  if (!m) return DEFAULT_CONTEXT_WINDOWS.claude;
  if (m.includes('opus-4-8') || m.includes('opus')) return 1000000;
  return 200000;
}
const sumNums = (...vals) => vals.reduce((n, v) => n + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
function normalizeContext({ agent, model, usedTokens, windowTokens, source = 'estimated', updatedAt = Date.now() } = {}) {
  const win = Number(windowTokens) || modelContextWindow(agent, model);
  const used = Math.max(0, Math.round(Number(usedTokens) || 0));
  return {
    agent: agent || 'claude',
    model: model || '',
    usedTokens: used,
    windowTokens: win,
    percent: win ? Math.min(999, Math.round((used / win) * 100)) : 0,
    source,
    updatedAt,
  };
}
function contextFromCodexInfo(info, prev = {}) {
  const last = (info && info.last_token_usage) || {};
  const total = (info && info.total_token_usage) || {};
  const used = sumNums(last.input_tokens, last.output_tokens) || Number(last.total_tokens) || Number(total.total_tokens) || 0;
  return normalizeContext({
    agent: 'codex',
    model: prev.model || '',
    usedTokens: used,
    windowTokens: info && info.model_context_window,
    source: info && info.model_context_window ? 'reported' : 'estimated',
  });
}
function contextFromClaudeUsage(usage, model) {
  const used = sumNums(
    usage && usage.input_tokens,
    usage && usage.cache_creation_input_tokens,
    usage && usage.cache_read_input_tokens,
    usage && usage.output_tokens,
  );
  return normalizeContext({ agent: 'claude', model, usedTokens: used, source: 'reported-usage-estimated-window' });
}
function claudeContext(file) {
  if (!file) return null;
  try {
    const st = statSync(file); const len = Math.min(st.size, 4 * 1024 * 1024); const start = st.size - len;
    const fd = openSync(file, 'r'); const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, start); closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      const msg = o && o.message;
      if (msg && msg.usage) return contextFromClaudeUsage(msg.usage, msg.model || '');
    }
  } catch {}
  return null;
}
// Live Codex context from the session's rollout file (authoritative — it's what Codex's
// own TUI shows). See codex-context.mjs for why the streamed turn.completed usage can't be
// used. Returns null if no rollout / no token_count yet, so callers can fall back.
function codexContext(id, model = '') {
  const info = readCodexTokenInfo(findCodexRollout(CODEX_HOME, id));
  return info ? contextFromCodexInfo(info, { model }) : null;
}
function contextForSession(id, { agent = null, file = null, codex = null } = {}) {
  const cx = codex || ((loadCodex().sessions || {})[id]);
  if ((agent === 'codex' || cx) && cx) {
    const model = ((cx.settings || {}).codex || {}).model || (cx.context || {}).model || '';
    const stored = cx.context;
    // Trust the stored value unless it's missing or impossible (usedTokens > windowTokens —
    // the symptom of the old cumulative-usage bug). Then re-read the live figure from the
    // rollout so reopening a chat self-heals a stale "999%" meter without a fresh turn.
    const bogus = !stored || !(stored.windowTokens > 0) || stored.usedTokens > stored.windowTokens;
    return (bogus && codexContext(id, model)) || stored || normalizeContext({ agent: 'codex', model });
  }
  const f = file || findSessionFile(id);
  return claudeContext(f) || normalizeContext({ agent: 'claude' });
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
    ...prev,
    id,
    agent: 'codex',
    title: established || attrs.title || prev.title || 'Codex chat',
    cwd: attrs.cwd || prev.cwd || DEFAULT_CWD,
    created: prev.created || attrs.created || now,
    lastUsed: attrs.lastUsed || now,
    preview: attrs.preview != null ? attrs.preview : (prev.preview || ''),
    settings: normalizeSettings(attrs.settings || prev.settings || {}),
    parentId: attrs.parentId || prev.parentId || null,
    parentTitle: attrs.parentTitle || prev.parentTitle || '',
    context: attrs.context || prev.context || null,
    source: attrs.source || prev.source || '',
    transcriptPath: attrs.transcriptPath || prev.transcriptPath || '',
    dtachSock: attrs.dtachSock || prev.dtachSock || '',
  };
  saveCodex(state);
  return state.sessions[id];
}
function updateCodexContext(id, info, precomputed = null) {
  if (!id || (!info && !precomputed)) return null;
  const state = loadCodex();
  const prev = state.sessions[id] || { id, agent: 'codex', title: 'Codex chat', cwd: DEFAULT_CWD };
  // Prefer the rollout-derived live context (precomputed) over the streamed turn.completed
  // usage, which is cumulative and would inflate the meter (the "999%" bug).
  prev.context = precomputed || contextFromCodexInfo(info, prev.context || {});
  prev.lastUsed = Date.now();
  state.sessions[id] = prev;
  saveCodex(state);
  return prev.context;
}
function appendCodexMessage(id, role, text, extra = {}) {
  if (!id || (!text && !extra.parts)) return;
  const state = loadCodex();
  const now = Date.now();
  const prev = state.sessions[id] || { id, agent: 'codex', title: 'Codex chat', cwd: DEFAULT_CWD, created: now };
  const parts = extra.parts || [{ t: 'text', text: String(text || '') }];
  const message = { role, parts, ts: extra.ts || now };
  if (extra.qid) message.qid = extra.qid;
  if (extra.recovered) message.recovered = true;
  saveCodexMessages(id, [...loadCodexMessages(id, prev), message]);
  delete prev.messages;
  const plain = String(text || parts.filter((p) => p.t === 'text').map((p) => p.text).join(' ')).trim();
  if (role === 'user' && (!prev.title || prev.title === 'Codex chat')) prev.title = plain.slice(0, 80) || 'Codex chat';
  if (role === 'assistant' && plain) prev.preview = plain.replace(/\s+/g, ' ').slice(0, 160);
  prev.lastUsed = now;
  state.sessions[id] = prev;
  saveCodex(state);
}
const codexAttachmentIsImage = (p) => /\.(png|jpe?g|gif|webp|svg|bmp|heic|heif|avif|tiff?)$/i.test(p || '');
function codexUserParts(text, attachments = []) {
  const parts = [];
  if (text) parts.push({ t: 'text', text: String(text) });
  for (const p of attachments || []) {
    if (!p) continue;
    parts.push({ t: codexAttachmentIsImage(p) ? 'image' : 'file', path: String(p) });
  }
  return parts.length ? parts : [{ t: 'text', text: '' }];
}
function codexRolloutUserAttachments(id) {
  const file = findCodexRollout(CODEX_HOME, id);
  if (!file) return [];
  const out = [];
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const p = o && o.type === 'event_msg' ? o.payload : null;
      if (!p || p.type !== 'user_message') continue;
      const attachments = [...(p.local_images || []), ...(p.local_files || [])].filter(Boolean);
      if (attachments.length) out.push({ text: String(p.message || '').trim(), attachments });
    }
  } catch {}
  return out;
}
function enrichCodexUserAttachments(id, messages) {
  const rows = codexRolloutUserAttachments(id);
  if (!rows.length) return messages || [];
  let idx = 0;
  return (messages || []).map((m) => {
    if (!m || m.role !== 'user' || (m.parts || []).some((p) => p.t === 'image' || p.t === 'file')) return m;
    const text = (m.parts || []).filter((p) => p.t === 'text').map((p) => p.text || '').join('\n').trim();
    const hitAt = rows.findIndex((r, i) => i >= idx && (!r.text || r.text === text));
    if (hitAt < 0) return m;
    idx = hitAt + 1;
    return { ...m, parts: [...(m.parts || []), ...codexUserParts('', rows[hitAt].attachments)] };
  });
}
function codexRolloutToolResults(id) {
  const file = findCodexRollout(CODEX_HOME, id);
  if (!file) return [];
  const calls = new Map(), results = [];
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const p = o && o.type === 'response_item' ? o.payload : null;
      if (!p) continue;
      if (p.type === 'function_call') {
        let args = {};
        try { args = JSON.parse(p.arguments || '{}'); } catch {}
        calls.set(p.call_id, { name: p.name || '', args });
      } else if (p.type === 'function_call_output' && p.call_id) {
        const c = calls.get(p.call_id);
        if (!c) continue;
        if (c.name === 'exec_command' && c.args && c.args.cmd) {
          results.push({ kind: 'Bash', command: String(c.args.cmd), output: String(p.output || '').slice(0, 6000) });
        }
      }
    }
  } catch {}
  return results;
}
function enrichCodexToolResults(id, messages) {
  const rows = codexRolloutToolResults(id);
  if (!rows.length) return messages || [];
  const byCommand = new Map();
  const remaining = rows.map((r) => r.output);
  const index = (key, output) => {
    if (!key) return;
    const arr = byCommand.get(key) || [];
    arr.push(output);
    byCommand.set(key, arr);
  };
  for (const r of rows) {
    index(r.command, r.output);
    index(String(r.command || '').replace(/\s+/g, ' ').slice(0, 120), r.output);
  }
  return (messages || []).map((m) => {
    if (!m || m.role !== 'assistant') return m;
    let changed = false;
    const parts = (m.parts || []).map((p) => {
      if (!p || p.t !== 'tool' || p.result || p.name !== 'Bash') return p;
      const command = String((p.detail && p.detail.command) || p.input || '');
      const arr = byCommand.get(command);
      const result = arr && arr.length ? arr.shift() : remaining.shift();
      if (!result) return p;
      changed = true;
      return { ...p, detail: p.detail || { command }, result };
    });
    return changed ? { ...m, parts } : m;
  });
}
function enrichCodexHistory(id, messages, { attachments = false, toolResults = false } = {}) {
  let out = messages || [];
  if (attachments) out = enrichCodexUserAttachments(id, out);
  if (toolResults) out = enrichCodexToolResults(id, out);
  return out;
}
// codex hands errors back in several shapes (a plain string, or a JSON envelope like
// {error:{message}} / {message}). Pull out the human-readable bit before we persist it as a note,
// so a failed turn reads "model X does not exist" instead of a truncated JSON blob.
function cleanCodexError(raw) {
  let s = String(raw == null ? '' : raw).trim();
  try { const o = JSON.parse(s); s = (o && o.error && o.error.message) || (o && o.message) || s; } catch {}
  return s.replace(/\s+/g, ' ').slice(0, 200);
}
// A brand-new Codex chat has no thread id until codex emits `thread.started` — which can be a few
// seconds away, or NEVER (codex OOM/startup failure, or a malformed invocation). We register a
// PROVISIONAL entry keyed by the box's internal `new-…` key the instant the turn starts so the chat
// is visible + the first message is durable immediately; when the real thread id arrives we migrate
// the entry (with its messages/title/preview) onto it. Idempotent: a no-op if the source is gone.
function migrateCodexSession(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return null;
  const state = loadCodex();
  const prev = state.sessions[fromId];
  if (!prev) return null;
  const dest = state.sessions[toId] || {};
  // transcripts live in sidecar files: carry the provisional entry's messages onto the
  // real thread id unless the destination already has its own
  const destMsgs = loadCodexMessages(toId, dest);
  if (!destMsgs.length) saveCodexMessages(toId, loadCodexMessages(fromId, prev));
  try { unlinkSync(codexMsgFile(fromId)); } catch {}
  state.sessions[toId] = {
    ...prev, ...dest,
    id: toId,
    title: (dest.title && dest.title !== 'Codex chat') ? dest.title : (prev.title || dest.title || 'Codex chat'),
    preview: dest.preview || prev.preview || '',
    created: prev.created || dest.created || Date.now(),
  };
  delete state.sessions[toId].messages;
  delete state.sessions[fromId];
  saveCodex(state);
  try {
    const fav = loadFavorites();
    if (fav.has(fromId)) {
      fav.delete(fromId);
      fav.add(toId);
      saveFavorites(fav);
    }
  } catch {}
  return state.sessions[toId];
}

// Build the ordered parts a history reload renders from the live turn's curParts.
function codexAssistantParts(curParts) {
  return (curParts || [])
    .filter((p) => (p.t === 'text' ? !!(p.text && p.text.trim()) : p.t === 'tool'))
    .map((p) => (p.t === 'tool'
      ? { t: 'tool', id: p.id, name: p.name, input: compactString(p.input || '', 240), detail: compactToolDetail(p.name, p.detail || null, p.input), result: p.result ? compactString(p.result, HIST_TOOL_RESULT_LIMIT) : p.result }
      : { t: 'text', text: p.text }));
}
// Persist the in-flight Codex assistant turn AS IT STREAMS, not only at finish(). Codex
// turns run long (a delegated ticket is 200+ tool calls / many minutes) and this box is
// OOM-prone, so it restarts mid-turn — which used to lose the ENTIRE reply: the turn lived
// only in memory until finish(), so a killed turn left the user message with no answer
// (and context stuck at 0). We upsert a single "live" assistant row keyed by the turn id;
// finalize() drops the live flag once the turn ends cleanly. A reload after a crash then
// shows whatever the agent had produced so far instead of nothing.
let CODEX_TURN_SEQ = 0;
function flushCodexAssistant(s, { finalize = false } = {}) {
  if (!s || !s.sessionId) return;
  const parts = codexAssistantParts(s.curParts);
  if (!parts.length) return;
  const state = loadCodex();
  const prev = state.sessions[s.sessionId];
  if (!prev) return;
  const msgs = [...loadCodexMessages(s.sessionId, prev)];
  const last = msgs[msgs.length - 1];
  const row = { role: 'assistant', parts, turnId: s.cxTurnId, ts: (last && last.live && last.turnId === s.cxTurnId && last.ts) || Date.now() };
  if (!finalize) row.live = true;
  if (last && last.role === 'assistant' && last.live && last.turnId === s.cxTurnId) msgs[msgs.length - 1] = row;
  else msgs.push(row);
  saveCodexMessages(s.sessionId, msgs);
  delete prev.messages;
  const text = parts.filter((p) => p.t === 'text').map((p) => p.text).join('\n\n').trim();
  if (text) prev.preview = text.replace(/\s+/g, ' ').slice(0, 160);
  prev.lastUsed = Date.now();
  state.sessions[s.sessionId] = prev;
  saveCodex(state);
}
function ensureGeminiSession(id, attrs = {}) {
  if (!id) return null;
  const state = loadGemini();
  const now = Date.now();
  const prev = state.sessions[id] || {};
  const established = prev.title && prev.title !== 'Gemini chat' ? prev.title : '';
  state.sessions[id] = {
    id,
    agent: 'gemini',
    title: established || attrs.title || prev.title || 'Gemini chat',
    cwd: attrs.cwd || prev.cwd || DEFAULT_CWD,
    created: prev.created || attrs.created || now,
    lastUsed: attrs.lastUsed || now,
    updatedAt: attrs.updatedAt || now,
    preview: attrs.preview != null ? attrs.preview : (prev.preview || ''),
    messages: attrs.messages || prev.messages || [],
    settings: normalizeSettings(attrs.settings || prev.settings || {}),
    parentId: attrs.parentId || prev.parentId || null,
    parentTitle: attrs.parentTitle || prev.parentTitle || '',
    context: attrs.context != null ? attrs.context : (prev.context || null),
  };
  saveGemini(state);
  return state.sessions[id];
}
function appendGeminiMessage(id, role, text, extra = {}) {
  if (!id || (!text && !extra.parts)) return;
  const state = loadGemini();
  const now = Date.now();
  const prev = state.sessions[id] || { id, agent: 'gemini', title: 'Gemini chat', cwd: DEFAULT_CWD, created: now, messages: [] };
  const parts = extra.parts || [{ t: 'text', text: String(text || '') }];
  prev.messages = [...(prev.messages || []), { role, parts }].slice(-160);
  const plain = String(text || parts.filter((p) => p.t === 'text').map((p) => p.text).join(' ')).trim();
  if (role === 'user' && (!prev.title || prev.title === 'Gemini chat')) prev.title = plain.slice(0, 80) || 'Gemini chat';
  if (role === 'assistant' && plain) prev.preview = plain.replace(/\s+/g, ' ').slice(0, 160);
  prev.lastUsed = now;
  prev.updatedAt = now;
  state.sessions[id] = prev;
  saveGemini(state);
}
// Persist the in-flight Gemini assistant turn AS IT STREAMS (same crash-safety as Codex's
// flushCodexAssistant): upsert ONE "live" assistant row keyed by the turn id, carrying the
// ordered {text|tool} parts so a reload renders tools too; finalize drops the live flag.
let GEMINI_TURN_SEQ = 0;
function flushGeminiAssistant(s, { finalize = false } = {}) {
  if (!s || !s.sessionId) return;
  const parts = codexAssistantParts(s.curParts);
  if (!parts.length) return;
  const state = loadGemini();
  const prev = state.sessions[s.sessionId];
  if (!prev) return;
  const msgs = prev.messages ? [...prev.messages] : [];
  const last = msgs[msgs.length - 1];
  const row = { role: 'assistant', parts, turnId: s.gmTurnId, ts: (last && last.live && last.turnId === s.gmTurnId && last.ts) || Date.now() };
  if (!finalize) row.live = true;
  if (last && last.role === 'assistant' && last.live && last.turnId === s.gmTurnId) msgs[msgs.length - 1] = row;
  else msgs.push(row);
  prev.messages = msgs.slice(-160);
  const text = parts.filter((p) => p.t === 'text').map((p) => p.text).join('\n\n').trim();
  if (text) prev.preview = text.replace(/\s+/g, ' ').slice(0, 160);
  prev.lastUsed = Date.now();
  prev.updatedAt = Date.now();
  state.sessions[s.sessionId] = prev;
  saveGemini(state);
}
// Live context occupancy from the CLI's per-turn `result` stats (input_tokens = the last
// request's input, the figure the meter wants). Persist it so a reload keeps the meter.
function updateGeminiContext(id, info) {
  const used = (info && Number(info.input_tokens)) || 0;
  const ctx = normalizeContext({ agent: 'gemini', model: (info && info.model) || '', usedTokens: used, source: used ? 'reported' : 'estimated' });
  if (id) {
    const state = loadGemini();
    const prev = state.sessions[id];
    if (prev) { prev.context = ctx; prev.lastUsed = Date.now(); state.sessions[id] = prev; saveGemini(state); }
  }
  return ctx;
}
function ensureAgySession(id, attrs = {}) {
  if (!id) return null;
  const state = loadAgy();
  const now = Date.now();
  const prev = state.sessions[id] || {};
  const established = prev.title && prev.title !== 'Antigravity chat' ? prev.title : '';
  state.sessions[id] = {
    id,
    agent: 'agy',
    title: established || attrs.title || prev.title || 'Antigravity chat',
    cwd: attrs.cwd || prev.cwd || DEFAULT_CWD,
    created: prev.created || attrs.created || now,
    lastUsed: attrs.lastUsed || now,
    updatedAt: attrs.updatedAt || now,
    preview: attrs.preview != null ? attrs.preview : (prev.preview || ''),
    messages: attrs.messages || prev.messages || [],
    settings: normalizeSettings(attrs.settings || prev.settings || {}),
    parentId: attrs.parentId || prev.parentId || null,
    parentTitle: attrs.parentTitle || prev.parentTitle || '',
  };
  saveAgy(state);
  return state.sessions[id];
}
function appendAgyMessage(id, role, text, extra = {}) {
  if (!id || (!text && !extra.parts)) return;
  const state = loadAgy();
  const now = Date.now();
  const prev = state.sessions[id] || { id, agent: 'agy', title: 'Antigravity chat', cwd: DEFAULT_CWD, created: now, messages: [] };
  const parts = extra.parts || [{ t: 'text', text: String(text || '') }];
  prev.messages = [...(prev.messages || []), { role, parts }].slice(-160);
  const plain = String(text || parts.filter((p) => p.t === 'text').map((p) => p.text).join(' ')).trim();
  if (role === 'user' && (!prev.title || prev.title === 'Antigravity chat')) prev.title = plain.slice(0, 80) || 'Antigravity chat';
  if (role === 'assistant' && plain) prev.preview = plain.replace(/\s+/g, ' ').slice(0, 160);
  prev.lastUsed = now;
  prev.updatedAt = now;
  state.sessions[id] = prev;
  saveAgy(state);
}
// ---- Mac "Computer Use" session store (mirrors Gemini: streamed {text|tool} transcript) ----
function ensureMacSession(id, attrs = {}) {
  if (!id) return null;
  const state = loadMac();
  const now = Date.now();
  const prev = state.sessions[id] || {};
  const established = prev.title && prev.title !== 'Computer Use chat' ? prev.title : '';
  state.sessions[id] = {
    id,
    agent: 'mac',
    title: established || attrs.title || prev.title || 'Computer Use chat',
    cwd: attrs.cwd || prev.cwd || DEFAULT_CWD,
    created: prev.created || attrs.created || now,
    lastUsed: attrs.lastUsed || now,
    updatedAt: attrs.updatedAt || now,
    preview: attrs.preview != null ? attrs.preview : (prev.preview || ''),
    messages: attrs.messages || prev.messages || [],
    settings: normalizeSettings(attrs.settings || prev.settings || {}),
    parentId: attrs.parentId || prev.parentId || null,
    parentTitle: attrs.parentTitle || prev.parentTitle || '',
    context: attrs.context != null ? attrs.context : (prev.context || null),
  };
  saveMac(state);
  return state.sessions[id];
}
function appendMacMessage(id, role, text, extra = {}) {
  if (!id || (!text && !extra.parts)) return;
  const state = loadMac();
  const now = Date.now();
  const prev = state.sessions[id] || { id, agent: 'mac', title: 'Computer Use chat', cwd: DEFAULT_CWD, created: now, messages: [] };
  const parts = extra.parts || [{ t: 'text', text: String(text || '') }];
  prev.messages = [...(prev.messages || []), { role, parts }].slice(-160);
  const plain = String(text || parts.filter((p) => p.t === 'text').map((p) => p.text).join(' ')).trim();
  if (role === 'user' && (!prev.title || prev.title === 'Computer Use chat')) prev.title = plain.slice(0, 80) || 'Computer Use chat';
  if (role === 'assistant' && plain) prev.preview = plain.replace(/\s+/g, ' ').slice(0, 160);
  prev.lastUsed = now;
  prev.updatedAt = now;
  state.sessions[id] = prev;
  saveMac(state);
}
let MAC_TURN_SEQ = 0;
function flushMacAssistant(s, { finalize = false } = {}) {
  if (!s || !s.sessionId) return;
  const parts = codexAssistantParts(s.curParts);
  if (!parts.length) return;
  const state = loadMac();
  const prev = state.sessions[s.sessionId];
  if (!prev) return;
  const msgs = prev.messages ? [...prev.messages] : [];
  const last = msgs[msgs.length - 1];
  const row = { role: 'assistant', parts, turnId: s.macTurnId, ts: (last && last.live && last.turnId === s.macTurnId && last.ts) || Date.now() };
  if (!finalize) row.live = true;
  if (last && last.role === 'assistant' && last.live && last.turnId === s.macTurnId) msgs[msgs.length - 1] = row;
  else msgs.push(row);
  prev.messages = msgs.slice(-160);
  const text = parts.filter((p) => p.t === 'text').map((p) => p.text).join('\n\n').trim();
  if (text) prev.preview = text.replace(/\s+/g, ' ').slice(0, 160);
  prev.lastUsed = Date.now();
  prev.updatedAt = Date.now();
  state.sessions[s.sessionId] = prev;
  saveMac(state);
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

let CODEX_LIVE_CACHE = { ts: 0, ids: new Set() };
function runningCodexThreadIds() {
  const now = Date.now();
  if (now - CODEX_LIVE_CACHE.ts < 2500) return new Set(CODEX_LIVE_CACHE.ids);
  const ids = new Set();
  const procText = pgrepFull('codex');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const line of procText.split('\n')) {
    const argv = line.trim().split(/\s+/);
    const resume = argv.indexOf('resume');
    if (resume < 0) continue;
    const id = argv.slice(resume + 1).find((arg) => uuid.test(arg));
    if (id) ids.add(id.toLowerCase());
  }
  CODEX_LIVE_CACHE = { ts: now, ids: new Set(ids) };
  return ids;
}

function adoptLiveCodexSessions(liveThreadIds) {
  if (!liveThreadIds.size) return;
  const state = loadCodex();
  let changed = false;
  for (const id of liveThreadIds) {
    if ((state.sessions || {})[id]) continue;
    const transcriptPath = findCodexRollout(CODEX_HOME, id);
    const meta = codexRolloutMeta(transcriptPath);
    if (!transcriptPath || !meta || meta.id !== id) continue;
    let mtime = Date.now(); try { mtime = statSync(transcriptPath).mtimeMs; } catch {}
    const created = Date.parse(meta.created || '') || mtime;
    const live = codexRolloutState(transcriptPath);
    state.sessions[id] = {
      id, agent: 'codex', title: meta.opening || `Codex ${id.slice(0, 8)}`,
      cwd: meta.cwd || DEFAULT_CWD, created, lastUsed: mtime, preview: live.preview || '',
      settings: normalizeSettings({}), parentId: null, parentTitle: '', context: null,
      source: 'native', transcriptPath,
    };
    changed = true;
  }
  if (changed) saveCodex(state);
}

function liveCodexSessionIds(sessions, processIds = runningCodexThreadIds()) {
  const ids = new Set(processIds);
  for (const s of sessions || []) {
    if (!s || !s.id) continue;
    if (s.dtachSock) {
      try { if (existsSync(s.dtachSock)) ids.add(s.id); } catch {}
    }
  }
  return ids;
}

function listSessions({ limit = 40, filter = 'all' } = {}) {
  const rc = readRcRegistry();
  const names = loadNames();
  const archived = loadArchived();
  const archivedAt = loadArchivedAt();
  const favorites = loadFavorites();
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
  const codexProcessIds = runningCodexThreadIds();
  adoptLiveCodexSessions(codexProcessIds);
  const codexBusyIds = new Set();
  const codexSessions = Object.values(loadCodex().sessions || {}).map((s) => {
    let rollout = null, liveState = null;
    if (codexProcessIds.has(s.id) || s.source === 'native') {
      rollout = s.transcriptPath || findCodexRollout(CODEX_HOME, s.id);
      liveState = codexRolloutState(rollout);
      if (codexProcessIds.has(s.id) && liveState.busy) codexBusyIds.add(s.id);
    }
    return ({
      ...s,
      id: s.id, agent: 'codex', file: null, mtime: Math.max(s.lastUsed || s.created || 0, (liveState && liveState.mtimeMs) || 0),
      title: s.title || 'Codex chat', cwd: s.cwd || DEFAULT_CWD, preview: (liveState && liveState.preview) || s.preview || '',
      parentId: s.parentId || null, parentTitle: s.parentTitle || '',
      settings: s.settings || {}, context: s.context || null,
    });
  });
  const geminiSessions = Object.values(loadGemini().sessions || {}).map((s) => ({
    id: s.id, agent: 'gemini', file: null, mtime: s.lastUsed || s.created || 0,
    title: s.title || 'Gemini chat', cwd: s.cwd || DEFAULT_CWD, preview: s.preview || '',
    parentId: s.parentId || null, parentTitle: s.parentTitle || '',
  }));
  const agySessions = Object.values(loadAgy().sessions || {}).map((s) => ({
    id: s.id, agent: 'agy', file: null, mtime: s.lastUsed || s.created || 0,
    title: s.title || 'Antigravity chat', cwd: s.cwd || DEFAULT_CWD, preview: s.preview || '',
    parentId: s.parentId || null, parentTitle: s.parentTitle || '',
  }));
  const macSessions = Object.values(loadMac().sessions || {}).map((s) => ({
    id: s.id, agent: 'mac', file: null, mtime: s.lastUsed || s.created || 0,
    title: s.title || 'Computer Use chat', cwd: s.cwd || DEFAULT_CWD, preview: s.preview || '',
    parentId: s.parentId || null, parentTitle: s.parentTitle || '',
  }));
  files.sort((a, b) => b.mtime - a.mtime);
  const items = files.concat(codexSessions, geminiSessions, agySessions, macSessions).sort((a, b) => b.mtime - a.mtime);
  const now = Date.now();
  const rcIds = new Set(Object.keys(rc));
  const codexLiveIds = liveCodexSessionIds(codexSessions, codexProcessIds);
  // Live = Claude remote-control bridges plus Codex sessions with an active exec process,
  // a registered terminal dtach socket, or another running local agent turn.
  const liveIds = new Set([...rcIds, ...LIVE_BRIDGES.keys(), ...codexLiveIds, ...RUNNING]);
  // tail-scan the most-recent non-archived sessions for preview + needs-input + lastTs
  const scan = new Map();
  for (const f of files) { if (scan.size >= 130) break; if (!archived.has(f.id)) scan.set(f.id, tailInfo(f.file)); }
  // Effective "last activity" = the newest real chat timestamp from the scan, NOT the
  // file mtime (an idle remote-control bridge bumps mtime with no actual chat — see
  // tailInfo). Fall back to mtime for sessions older than the scan window (their mtime
  // is honest — nothing has touched them) or with no timestamped message. actTime is
  // always ≤ mtime, so every bridge-bumped session lands inside the top-mtime scan and
  // gets corrected; unscanned ones keep their truthful mtime. Re-sort by it so the
  // recency window + ordering reflect real conversation, not heartbeat writes.
  const actTime = (f) => { const s = f && scan.get(f.id); return (s && s.lastTs) ? s.lastTs : (f ? f.mtime : 0); };
  items.sort((a, b) => actTime(b) - actTime(a));
  const statusOf = (id) => archived.has(id) ? 'archived' : (RUNNING.has(id) || codexBusyIds.has(id)) ? 'working' : (scan.get(id) && scan.get(id).needsInput) ? 'needs_input' : liveIds.has(id) ? 'live' : 'idle';
  const byId = new Map(items.map((f) => [f.id, f]));
  const isAuto = (id) => isAutoFile((byId.get(id) || {}).file);
  // counts over ALL sessions. Auto sessions are tallied only under `auto` (and
  // `archived` if archived) so they never inflate All/Working/Needs input/Live.
  // autoSub breaks the auto total into subcategories for the Automated sub-tabs.
  const counts = { all: 0, favorites: 0, working: 0, needs_input: 0, live: 0, idle: 0, archived: 0, auto: 0 };
  const autoSub = {};
  for (const f of items) {
    if (archived.has(f.id)) { counts.archived++; continue; }
    if (f.file && isAutoFile(f.file)) { counts.auto++; const sk = autoSubcat(f.id, f.file); autoSub[sk] = (autoSub[sk] || 0) + 1; continue; }
    if (favorites.has(f.id)) counts.favorites++;
    const st = statusOf(f.id); counts[st]++; counts.all++;
  }
  saveAutoCat();
  // candidate set for the requested filter. `auto` shows all auto sessions;
  // `auto:<subkey>` narrows to one subcategory.
  const [fbase, fsub] = String(filter || 'all').split(':');
  let cand;
  if (filter === 'archived') cand = items.filter((f) => archived.has(f.id));
  else if (filter === 'favorites') cand = items.filter((f) => !archived.has(f.id) && !(f.file && isAutoFile(f.file)) && favorites.has(f.id));
  else if (fbase === 'auto') cand = items.filter((f) => !archived.has(f.id) && f.file && isAutoFile(f.file) && (!fsub || autoSubcat(f.id, f.file) === fsub));
  else if (filter && filter !== 'all') cand = items.filter((f) => !(f.file && isAutoFile(f.file)) && statusOf(f.id) === filter);
  else cand = items.filter((f) => !archived.has(f.id) && !(f.file && isAutoFile(f.file)));
  const chosen = [], seen = new Set();
  if (!filter || filter === 'all') { for (const id of liveIds) if (!archived.has(id) && !isAuto(id)) { chosen.push(byId.get(id) || { id, file: null, mtime: 0 }); seen.add(id); } }
  for (const f of cand) { if (chosen.length >= limit) break; if (!seen.has(f.id)) { chosen.push(f); seen.add(f.id); } }
  const out = chosen.map((s) => {
    const r = rc[s.id];
    const lb = !r ? LIVE_BRIDGES.get(s.id) : null; // discovered box-local live bridge (not in TSV)
    const cxLive = codexLiveIds.has(s.id);
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
      live: !!r || !!lb || cxLive, rcName: r ? r.rcName : (lb ? lb.rcName : null), note: r ? r.note : null, archived: archived.has(s.id),
      favorite: favorites.has(s.id),
      status: statusOf(s.id), category: s.file && isAutoFile(s.file) ? 'auto' : 'main',
      subcat: s.file && isAutoFile(s.file) ? autoSubcat(s.id, s.file) : null,
      pinned: (!!r || !!lb || cxLive) && !archived.has(s.id), mtime: actTime(s), renamed: !!(tm.custom || names[s.id]),
      archivedAt: archivedAt[s.id] || 0,
      hasAttention,
    };
  });
  // Archived view sorts most-recently-archived first (so a chat you JUST archived is
  // right at the top), falling back to last-activity for legacy archives with no
  // recorded archive time. Every other view keeps live-pinned-then-recent order.
  if (filter === 'archived') out.sort((a, b) => (b.archivedAt - a.archivedAt) || (b.mtime - a.mtime));
  else out.sort((a, b) => (b.favorite - a.favorite) || (b.pinned - a.pinned) || (b.mtime - a.mtime));
  counts.autoSub = autoSub;
  return { sessions: out, counts };
}
const SESSION_LIST_CACHE = new Map();
function invalidateSessionLists() { try { SESSION_LIST_CACHE.clear(); } catch {} }
function cachedListSessions(filter) {
  const key = String(filter || 'all');
  const now = Date.now();
  const cached = SESSION_LIST_CACHE.get(key);
  if (cached && now - cached.ts < 5000) return cached.value;
  const value = listSessions({ filter: key });
  SESSION_LIST_CACHE.set(key, { ts: now, value });
  return value;
}
// project dir name "-home-user-code" -> "/home/user/code"
function decodeCwd(dir) {
  const base = basename(dir);
  if (base === '-') return '/';
  return base.replace(/^-/, '/').replace(/-/g, '/');
}

const HIST_MSG_LIMIT = 400;
const HIST_TAIL_BYTES = 6 * 1024 * 1024; // read last 6MB for large files
const HIST_TOOL_RESULT_LIMIT = 1200;
const HIST_TOOL_INPUT_LIMIT = 2200;
const HISTORY_CACHE_LIMIT = 48;
const HISTORY_CACHE = new Map();
function getHistoryCache(key) {
  const hit = HISTORY_CACHE.get(key);
  if (!hit) return null;
  HISTORY_CACHE.delete(key);
  HISTORY_CACHE.set(key, hit);
  return { ...hit, messages: hit.messages || [] };
}
function setHistoryCache(key, value) {
  HISTORY_CACHE.set(key, { ...value, messages: value.messages || [] });
  while (HISTORY_CACHE.size > HISTORY_CACHE_LIMIT) HISTORY_CACHE.delete(HISTORY_CACHE.keys().next().value);
  return value;
}
function compactString(s, limit) {
  s = String(s == null ? '' : s);
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n\n[truncated ${s.length - limit} chars]`;
}
function compactToolDetail(name, detail, fallbackInput) {
  if (!detail || typeof detail !== 'object') return fallbackInput || '';
  if (name === 'Bash') {
    const out = {};
    if (detail.command) out.command = compactString(detail.command, HIST_TOOL_INPUT_LIMIT);
    if (detail.description) out.description = compactString(detail.description, 240);
    if (detail.timeout_ms) out.timeout_ms = detail.timeout_ms;
    return out;
  }
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const out = {};
    for (const k of ['file_path', 'notebook_path', 'old_string', 'new_string', 'content']) {
      if (detail[k] != null) out[k] = compactString(detail[k], k.endsWith('path') ? 500 : HIST_TOOL_INPUT_LIMIT);
    }
    return out;
  }
  if (['Grep', 'Glob'].includes(name)) {
    const out = {};
    for (const k of ['pattern', 'path', 'glob', 'type']) if (detail[k] != null) out[k] = compactString(detail[k], 500);
    return out;
  }
  const raw = JSON.stringify(detail);
  return raw.length <= HIST_TOOL_INPUT_LIMIT ? detail : { summary: compactString(raw, HIST_TOOL_INPUT_LIMIT) };
}
function compactHistoryMessages(messages) {
  return (messages || []).map((m) => ({
    ...m,
    parts: (m.parts || []).map((p) => {
      if (!p || p.t !== 'tool') return p;
      const detail = compactToolDetail(p.name, p.detail || null, p.input);
      return {
        ...p,
        input: compactString(p.input || summarizeToolInput(p.name, detail), 240),
        detail,
        result: p.result ? compactString(p.result, HIST_TOOL_RESULT_LIMIT) : p.result,
      };
    }),
  }));
}
function parseJsonlMessages(raw) {
  const messages = [];
  const pendingTools = new Map();
  const toolResultText = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((x) => (x && x.type === 'text' ? x.text : '')).join('');
    return content == null ? '' : String(content);
  };
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
          else if (b.type === 'tool_use') {
            const part = { t: 'tool', id: b.id, name: b.name, input: summarizeToolInput(b.name, b.input), detail: b.input };
            parts.push(part);
            if (b.id) pendingTools.set(b.id, part);
          } else if (b.type === 'tool_result') {
            const part = b.tool_use_id ? pendingTools.get(b.tool_use_id) : null;
            if (part) part.result = toolResultText(b.content).slice(0, 6000);
          } else if (b.type === 'thinking') { /* skip */ }
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
function claudeSessionHistory(id, file, before = null) {
  const st = statSync(file);
  const end = before != null ? Math.min(before, st.size) : st.size;
  const key = `${id}:${end}:${st.size}:${st.mtimeMs}`;
  const cached = getHistoryCache(key);
  if (cached) return cached;
  const { raw, startOffset } = readJsonlChunk(file, end);
  const messages = parseJsonlMessages(raw).slice(-HIST_MSG_LIMIT);
  return setHistoryCache(key, { messages, hasMore: startOffset > 0, cursor: startOffset, cwd: decodeCwd(dirname(file)), agent: 'claude', settings: normalizeSettings({}), context: contextForSession(id, { agent: 'claude', file }) });
}
async function sessionHistory(id, { before = null } = {}) {
  const codex = (loadCodex().sessions || {})[id];
  if (codex) {
    const rolloutFile = codex.transcriptPath || findCodexRollout(CODEX_HOME, id);
    const rollout = await codexRolloutHistory(rolloutFile, { before });
    const messages = rolloutFile ? rollout.messages : loadCodexMessages(id, codex);
    return { messages: enrichCodexHistory(id, messages.slice(-HIST_MSG_LIMIT)), hasMore: rollout.hasMore, cursor: rollout.cursor, liveCursor: rollout.liveCursor, cwd: codex.cwd || DEFAULT_CWD, agent: 'codex', settings: normalizeSettings(codex.settings || {}), parentId: codex.parentId || null, parentTitle: codex.parentTitle || '', context: contextForSession(id, { agent: 'codex', codex }) };
  }
  const gemini = (loadGemini().sessions || {})[id];
  if (gemini) return { messages: (gemini.messages || []).slice(-HIST_MSG_LIMIT), hasMore: false, cursor: 0, cwd: gemini.cwd || DEFAULT_CWD, agent: 'gemini', settings: normalizeSettings(gemini.settings || {}), parentId: gemini.parentId || null, parentTitle: gemini.parentTitle || '', context: normalizeContext(gemini.context || { agent: 'gemini' }) };
  const agy = (loadAgy().sessions || {})[id];
  if (agy) return { messages: (agy.messages || []).slice(-HIST_MSG_LIMIT), hasMore: false, cursor: 0, cwd: agy.cwd || DEFAULT_CWD, agent: 'agy', settings: normalizeSettings(agy.settings || {}), parentId: agy.parentId || null, parentTitle: agy.parentTitle || '', context: normalizeContext({ agent: 'agy' }) };
  const mac = (loadMac().sessions || {})[id];
  if (mac) return { messages: enrichCodexHistory(id, (mac.messages || []).slice(-HIST_MSG_LIMIT)), hasMore: false, cursor: 0, cwd: mac.cwd || DEFAULT_CWD, agent: 'mac', settings: normalizeSettings(mac.settings || {}), parentId: mac.parentId || null, parentTitle: mac.parentTitle || '', context: normalizeContext(mac.context || { agent: 'mac' }) };
  const file = findSessionFile(id);
  if (!file) return { messages: [], hasMore: false, cursor: 0, cwd: DEFAULT_CWD, context: normalizeContext({ agent: 'claude' }) };
  return claudeSessionHistory(id, file, before);
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
// gzip JSON API responses. The phone pulls 100s-of-KB feed/history payloads over
// cellular and neither Caddy (bare reverse_proxy) nor Express compresses by default;
// JSON shrinks 5-10x. Only bodies >2KB, only when the client advertises gzip.
app.use('/api', (req, res, next) => {
  const orig = res.json.bind(res);
  res.json = (body) => {
    let str;
    try { str = JSON.stringify(body); } catch { return orig(body); }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (str && str.length > 2048 && /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) {
      try {
        const buf = gzipSync(Buffer.from(str), { level: 5 });
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        return res.send(buf);
      } catch {}
    }
    return res.send(str);
  };
  next();
});
const authOk = (req) => {
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;
  return (bearer || req.query.token) === AUTH_TOKEN;
};
const requireAuth = (req, res, next) => (authOk(req) ? next() : res.status(401).json({ error: 'unauthorized' }));

app.post('/api/login', (req, res) =>
  (req.body && req.body.token) === AUTH_TOKEN ? res.json({ ok: true }) : res.status(401).json({ error: 'bad token' }));

app.get('/api/sessions', requireAuth, (req, res) => { const r = cachedListSessions(req.query.filter || 'all'); res.json({ sessions: r.sessions, counts: r.counts, defaultCwd: DEFAULT_CWD, defaultAgent: appDefaultAgent() }); });
app.post('/api/sessions/bulk-archive', requireAuth, (req, res) => {
  const body = req.body || {};
  const on = !(body.archived === false);
  const preserve = new Set(Array.isArray(body.preserveIds) ? body.preserveIds.map(String) : []);
  const explicitIds = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : null;
  const filter = String(body.filter || 'all');
  const fullList = listSessions({ filter, limit: 10000 }).sessions;
  const sessionById = new Map(fullList.map((s) => [s.id, s]));
  const candidates = explicitIds || fullList.map((s) => s.id);
  const set = loadArchived(); const at = loadArchivedAt(); const now = Date.now();
  let changed = 0, killed = 0;
  for (const raw of candidates) {
    const id = String(raw || '').trim();
    if (!id || preserve.has(id)) continue;
    const s = sessionById.get(id);
    if (body.preserveActive && s && (s.live || s.status === 'working' || s.status === 'needs_input' || s.status === 'live')) continue;
    if (body.preserveLive && s && s.live) continue;
    if (body.preserveFavorites && s && s.favorite) continue;
    const had = set.has(id);
    if (on) { if (!had) { set.add(id); at[id] = now; changed++; } }
    else { if (had) { set.delete(id); delete at[id]; changed++; } }
    if (on) { try { killed += killSessionBridge(id).killed || 0; } catch {} }
  }
  saveArchived(set); saveArchivedAt(at);
  res.json({ ok: true, archived: on, changed, killed });
});
app.post('/api/sessions/:id/archive', requireAuth, (req, res) => {
  const set = loadArchived(); const at = loadArchivedAt();
  const id = req.params.id; const on = !(req.body && req.body.archived === false);
  if (on) { set.add(id); at[id] = Date.now(); } else { set.delete(id); delete at[id]; }
  saveArchived(set); saveArchivedAt(at);
  // Archiving = done with it → kill its remote-control bridge so it stops consuming a
  // claude process + heartbeating. Unarchiving explicitly warms a fresh bridge below.
  let killed = 0;
  if (on) { try { killed = killSessionBridge(id).killed; } catch {} }
  const restored = on ? null : restoreSessionBridge(id);
  res.json({ ok: true, archived: on, killed, restored });
});
app.post('/api/sessions/:id/favorite', requireAuth, (req, res) => {
  const set = loadFavorites();
  const id = req.params.id;
  const on = !(req.body && req.body.favorite === false);
  if (on) set.add(id); else set.delete(id);
  saveFavorites(set);
  res.json({ ok: true, favorite: on });
});
// Full-text search across ALL session history (title, summary, cwd, transcript) via sessiongrep.
// Natural-language queries are expanded into a few targeted searches, then merged and reranked.
app.get('/api/session-search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const exclude = new Set(String(req.query.exclude || '').split(',').map((s) => s.trim()).filter(Boolean));
  const variants = buildSessionSearchQueries(q);
  const queryTokens = sessionSearchTokens(q).filter((t) => !SESSION_SEARCH_STOP.has(t));
  const searches = await Promise.all(variants.map(async (variant) => ({ variant, ...(await runSessiongrepSearch(variant.query, 45)) })));
  if (searches.every((s) => s.error && !s.results.length)) return res.json({ results: [], error: 'search unavailable' });
  try {
    const codexIds = new Set(Object.values(loadCodex().sessions || {}).map((s) => s.id));
    const archived = loadArchived();
    const byId = new Map();
    for (const search of searches) {
      for (const r of search.results) {
        if (r.provider !== 'claude' && r.provider !== 'codex') continue;   // box can only open these
        if (exclude.has(r.id) || exclude.has(`${r.provider}:${r.id}`)) continue;
        const openable = r.provider === 'codex' ? codexIds.has(r.id) : !!findSessionFile(r.id);
        if (!openable) continue;                                           // skip laptop-only / unindexed hits
        const rank = sessionSearchRank(r, search.variant, queryTokens);
        const prev = byId.get(r.id);
        if (!prev || rank > prev.rank) byId.set(r.id, { ...r, rank, matchedQuery: search.variant.query, matchKind: search.variant.kind });
      }
    }
    const results = [...byId.values()].sort((a, b) => (b.rank - a.rank) || (b.score - a.score)).slice(0, 30).map((r) => ({
      id: r.id, agent: r.provider,
      title: r.title || r.snippet || r.preview || 'session',
      cwd: r.cwd, preview: sessionSearchPreview(r), age: r.age,
      match: r.match, matchedQuery: r.matchedQuery, matchKind: r.matchKind,
      archived: archived.has(r.id),
    }));
    res.json({ results, searched: variants.map((v) => v.query) });
  } catch (e) {
    res.status(500).json({ results: [], error: String(e.message || e) });
  }
});
app.get('/api/sessions/:id/history', requireAuth, async (req, res) => {
  try {
    const before = req.query.before != null ? parseInt(req.query.before, 10) : null;
    const h = await sessionHistory(req.params.id, { before });
    h.messages = compactHistoryMessages(h.messages || []);
    h.archived = loadArchived().has(req.params.id);
    h.favorite = loadFavorites().has(req.params.id);
    res.json(h);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});
app.get('/api/sessions/:id/snapshot', requireAuth, (req, res) => {
  try {
    const h = fullSessionHistory(req.params.id);
    let messages = h.messages || [];
    if (req.query.through != null) {
      const idx = Math.max(-1, Math.min(messages.length - 1, parseInt(req.query.through, 10)));
      messages = idx >= 0 ? messages.slice(0, idx + 1) : [];
    }
    res.json({ ...h, messages: compactHistoryMessages(messages), archived: loadArchived().has(req.params.id), favorite: loadFavorites().has(req.params.id) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
// All user messages from the full JSONL (for the "my messages" browser)
app.get('/api/sessions/:id/user-messages', requireAuth, async (req, res) => {
  const stored = (loadCodex().sessions || {})[req.params.id] || (loadGemini().sessions || {})[req.params.id] || (loadAgy().sessions || {})[req.params.id] || (loadMac().sessions || {})[req.params.id];
  if (stored) return res.json({ messages: codexUserMessagesFromSession(stored) });
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
  const codex = (loadCodex().sessions || {})[req.params.id];
  if (codex) {
    const title = codex.title || 'Codex chat';
    const messages = enrichCodexHistory(req.params.id, loadCodexMessages(req.params.id, codex), { attachments: true, toolResults: true });
    const fname = title.replace(/[^a-z0-9]/gi, '-').slice(0, 50).replace(/-+$/, '') + '.md';
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(conversationMarkdown({ title, agent: 'codex', messages }));
  }
  const gemini = (loadGemini().sessions || {})[req.params.id];
  if (gemini) {
    const title = gemini.title || 'Gemini chat';
    const fname = title.replace(/[^a-z0-9]/gi, '-').slice(0, 50).replace(/-+$/, '') + '.md';
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(conversationMarkdown({ title, agent: 'gemini', messages: gemini.messages || [] }));
  }
  const agy = (loadAgy().sessions || {})[req.params.id];
  if (agy) {
    const title = agy.title || 'Antigravity chat';
    const fname = title.replace(/[^a-z0-9]/gi, '-').slice(0, 50).replace(/-+$/, '') + '.md';
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(conversationMarkdown({ title, agent: 'agy', messages: agy.messages || [] }));
  }
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
    const fname = title.replace(/[^a-z0-9]/gi, '-').slice(0, 50).replace(/-+$/, '') + '.md';
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(conversationMarkdown({ title, agent: 'claude', messages }));
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
  // Codex/Gemini sessions have no Claude JSONL → keep the box-local JSON stores.
  const id = req.params.id;
  const name = String((req.body && req.body.name) || '').slice(0, 80);
  const isCodex = !!(loadCodex().sessions || {})[id];
  const isGemini = !!(loadGemini().sessions || {})[id];
  const isAgy = !!(loadAgy().sessions || {})[id];
  const isMac = !!(loadMac().sessions || {})[id];
  let wrote = false;
  if (isGemini) { ensureGeminiSession(id, { title: name, lastUsed: Date.now() }); wrote = true; }
  else if (isAgy) { ensureAgySession(id, { title: name, lastUsed: Date.now() }); wrote = true; }
  else if (isMac) { ensureMacSession(id, { title: name, lastUsed: Date.now() }); wrote = true; }
  else wrote = isCodex ? false : writeCustomTitle(id, name);
  const names = loadNames();
  if (wrote) { if (names[id] != null) { delete names[id]; saveNames(names); } } // drop legacy shadow
  else { names[id] = name; saveNames(names); }                                 // claude / no-jsonl-yet fallback
  res.json({ ok: true, synced: wrote });
});
app.get('/api/commands', requireAuth, (req, res) => res.json({
  commands: req.query.agent === 'codex' ? scanCodexCommands() : (req.query.agent === 'gemini' || req.query.agent === 'agy' || req.query.agent === 'mac') ? [] : scanCommands(),
}));

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

// --- Codex (OpenAI) + Gemini (Google) login: subscription OR API key, from the phone ---
app.get('/api/providers', ...acctRoute(async () => ({ providers: providerLogin.providerStatus(), meta: providerLogin.providerMeta })));
app.post('/api/providers/codex/device/start', ...acctRoute(() => providerLogin.codexDeviceStart()));
app.post('/api/providers/codex/apikey', ...acctRoute((req) => providerLogin.codexApiKey((req.body || {}).apiKey)));
app.post('/api/providers/gemini/google/start', ...acctRoute(() => providerLogin.geminiGoogleStart()));
app.post('/api/providers/gemini/google/complete', ...acctRoute((req) => providerLogin.geminiGoogleComplete((req.body || {}).flowId, (req.body || {}).code)));
app.post('/api/providers/gemini/apikey', ...acctRoute((req) => providerLogin.geminiApiKey((req.body || {}).apiKey)));
app.get('/api/providers/poll', ...acctRoute((req) => providerLogin.loginPoll(req.query.flowId)));
app.post('/api/providers/logout', ...acctRoute((req) => providerLogin.providerLogout((req.body || {}).provider)));

// Move a LIVE session to another account: stop its bridge on the old account, relocate
// its transcript into the new account's config dir, pin affinity. It resumes on the new
// account on the next message (the wrapper routes by affinity). The in-flight turn, if
// any, restarts — history is preserved. Credentials are never touched.
app.post('/api/sessions/:id/switch-account', ...acctRoute(async (req) => {
  const id = req.params.id;
  const accountId = (req.body || {}).accountId;
  if (!/^[a-f0-9-]{8,}$/i.test(id)) throw new Error('bad session id');
  if (!accountId) throw new Error('accountId required');
  // 1) stop the live bridge on the old account: rcEngine.destroy clears in-memory +
  //    kills the box dtach socket; the precise pkills catch a supervisor-owned bridge.
  //    Match only the claude RC process (uuid as a --resume/--session-id ARG) — never a
  //    bare uuid mention, which could hit unrelated processes.
  try { rcEngine.destroy(id); } catch {}
  for (const pat of [`--resume ${id}`, `--session-id ${id}`]) {
    try { execSync(`pkill -TERM -f -- ${JSON.stringify(pat)}`, { stdio: 'ignore', timeout: 4000 }); } catch {}
  }
  // 2) let it die + release the transcript file, then relocate + set affinity
  await new Promise((r) => setTimeout(r, 700));
  return { ...(await accounts.switchSession(id, accountId)), id };
}));

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
// In local mode there's no API key, but the feature is on — use a sentinel so the many
// `if (!LINEAR_KEY) return 500` guards below still pass; linearGql() routes to the clone.
const LINEAR_KEY = LINEAR_KEY_RAW || (linearLite ? 'local' : '');
// GitHub token: explicit env/.env first, else fall back to the authenticated `gh` CLI
// (the box logs into GitHub via `gh`, so a bare GITHUB_TOKEN is usually unset). Lazy + cached
// so we don't shell out on every request.
let _ghToken;
function ghToken() {
  if (_ghToken !== undefined) return _ghToken;
  let t = cfg('GITHUB_TOKEN') || cfg('GH_TOKEN');
  if (!t) { try { t = execSync('gh auth token', { encoding: 'utf8', timeout: 4000 }).trim(); } catch {} }
  _ghToken = t || '';
  return _ghToken;
}
// OpenAI — used (optionally) for the cheap per-session morning-brief refresh.
const OPENAI_KEY = cfg('OPENAI_API_KEY');
const OPENAI_ENDPOINT = (cfg('OPENAI_ENDPOINT', 'https://api.openai.com/v1')).replace(/\/$/, '');
const BOX_ATTENTION_MODEL = cfg('BOX_ATTENTION_MODEL', 'gpt-4o-mini'); // cheap; override via env
const BOX_TITLE_MODEL = cfg('BOX_TITLE_MODEL', BOX_ATTENTION_MODEL); // same cheap path, shorter output
const GEMINI_KEY = cfg('GEMINI_API_KEY') || cfg('GOOGLE_AI_STUDIO_API_KEY') || cfg('GOOGLE_API_KEY');
const AGY_CMD = cfg('AGY_CMD') || (existsSync(join(HOME, '.local', 'bin', 'agy')) ? join(HOME, '.local', 'bin', 'agy') : 'agy');

function isPlaceholderTitle(title) {
  return /^(New (Claude |Codex |Gemini |Antigravity )?chat|Claude chat|Codex chat|Gemini chat|Antigravity chat)$/i.test(String(title || '').trim());
}
function sanitizeTitle(title, max = 60) {
  let s = String(title || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^["'`]+|["'`.!?]+$/g, '').replace(/^title:\s*/i, '').trim();
  if (!s || isPlaceholderTitle(s)) return '';
  return s.slice(0, max).trim();
}
const TITLE_STOP = new Set('a an and are as at be but by can could do does for from get have how i if in into is it like make me of on or our please should so that the this to we when with you your'.split(' '));
function fallbackTitleFromPrompt(prompt) {
  let s = String(prompt || '')
    .replace(/^\[(Image|File) attached at .+?\]\s*/gmi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#>*_`~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s
    .replace(/^(please\s+)?(can|could|would)\s+you\s+/i, '')
    .replace(/^i\s+(think|guess|want|wanna|would like)\s+/i, '')
    .replace(/^let'?s\s+/i, '')
    .trim();
  const words = s.split(/\s+/)
    .map((w) => w.replace(/^[^\w-]+|[^\w-]+$/g, ''))
    .filter((w) => w && !TITLE_STOP.has(w.toLowerCase()));
  const picked = (words.length ? words : s.split(/\s+/)).slice(0, 5);
  const out = picked.map((w) => w ? w[0].toUpperCase() + w.slice(1) : '').join(' ');
  return sanitizeTitle(out || 'Codex chat');
}
async function aiTitleFromPrompt(prompt) {
  if (!OPENAI_KEY || !String(prompt || '').trim()) return '';
  try {
    const r = await fetch(`${OPENAI_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        model: BOX_TITLE_MODEL,
        temperature: 0.2,
        max_tokens: 24,
        messages: [
          { role: 'system', content: 'Write a concise 2-5 word chat title. Output only the title, no quotes or punctuation.' },
          { role: 'user', content: String(prompt || '').slice(0, 4000) },
        ],
      }),
    });
    if (!r.ok) return '';
    const j = await r.json();
    return sanitizeTitle(j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content);
  } catch { return ''; }
}
function setCodexGeneratedTitle(id, title) {
  const clean = sanitizeTitle(title);
  if (!id || !clean) return false;
  const names = loadNames();
  if (names[id]) return false; // manual rename wins
  const state = loadCodex();
  const prev = state.sessions && state.sessions[id];
  if (!prev) return false;
  prev.title = clean;
  prev.titleGeneratedAt = Date.now();
  prev.updatedAt = new Date().toISOString();
  state.sessions[id] = prev;
  saveCodex(state);
  return true;
}
function refreshCodexTitle(s, prompt, initialTitle) {
  const fallback = sanitizeTitle(initialTitle) || fallbackTitleFromPrompt(prompt);
  (async () => {
    const title = (await aiTitleFromPrompt(prompt)) || fallback;
    if (!title || title === fallback) return;
    const apply = () => {
      const realId = s.sessionId || null;
      const id = realId || s.provKey || s.key;
      if (!id || !setCodexGeneratedTitle(id, title)) return false;
      s.title = title;
      if (realId) bcast(s, { type: 'session', id: realId, agent: 'codex', parentId: s.parentId || null, parentTitle: s.parentTitle || '', title });
      return true;
    };
    if (!apply()) setTimeout(apply, 1000);
  })();
}

// Is the `codex` CLI installed? (Codex chats are optional.) Cached after first probe.
let _codexAvail = null;
function codexAvailable() {
  if (_codexAvail !== null) return _codexAvail;
  try { execSync('command -v codex', { stdio: 'ignore' }); _codexAvail = true; }
  catch { _codexAvail = false; }
  return _codexAvail;
}
let _geminiAvail = null;
function geminiAvailable() {
  if (_geminiAvail !== null) return _geminiAvail;
  try { execSync('command -v gemini', { stdio: 'ignore' }); _geminiAvail = true; }
  catch { _geminiAvail = false; }
  return _geminiAvail;
}
let _agyAvail = null;
function agyAvailable() {
  if (_agyAvail !== null) return _agyAvail;
  try { execSync(`${JSON.stringify(AGY_CMD)} --help`, { stdio: 'ignore' }); _agyAvail = true; }
  catch { _agyAvail = false; }
  return _agyAvail;
}

// Lightweight client bootstrap: lets the frontend learn $HOME (for path shortening),
// the owner name, and which optional integrations are wired so it can hide the Board /
// brain UI when they aren't configured. Safe to expose (no secrets).
const LINEAR_ENABLED = !!((LINEAR_KEY_RAW || linearLite) && LINEAR_TEAM_ID);
app.get('/api/config', requireAuth, (req, res) => res.json({
  home: HOME,
  ownerName: OWNER_NAME,
  defaultCwd: DEFAULT_CWD,
  appSettings: appSettingsPayload(),
  features: {
    linear: LINEAR_ENABLED,
    brain: !!findBrainDir(),
    voice: !!(ELEVEN_KEY || DEEPGRAM_KEY),
    voiceAssistant: !!OPENAI_KEY,
    slack: slackConfigured(cfg),
    codex: codexAvailable(),
    gemini: geminiAvailable(),
    agy: agyAvailable(),
    mac: macAvailable(),
  },
  // Display names for Automated-tab sub-buckets; a private overlay can add its own.
  subLabels: overlay.subLabels || {},
}));

// Live screenshot of the user's Mac (the composer "View screen" button) — proxies the
// cu-bridge worker's /screenshot over the reverse tunnel; no agent, no cost. Only useful
// when features.mac is on (bridge reachable).
app.get('/api/mac/screenshot', requireAuth, (req, res) => {
  macScreenshotStream((up) => {
    if (up.statusCode !== 200) { res.status(502).json({ error: 'mac screenshot failed' }); up.resume(); return; }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    up.pipe(res);
  }, (e) => res.status(502).json({ error: String((e && e.message) || e) }));
});
app.get('/api/app-settings', requireAuth, (req, res) => res.json(appSettingsPayload()));
app.post('/api/app-settings', requireAuth, (req, res) => {
  const body = req.body || {};
  const next = { ...APP_SETTINGS };
  if (Object.prototype.hasOwnProperty.call(body, 'defaultCwd')) {
    const dir = expandUserPath(body.defaultCwd);
    if (!dir) delete next.defaultCwd;
    else {
      if (!validateDirectory(dir)) return res.status(400).json({ error: 'directory not found' });
      next.defaultCwd = dir;
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'defaultAgent')) {
    const agent = String(body.defaultAgent || '').trim().toLowerCase();
    if (!agent) delete next.defaultAgent;
    else if (VALID_APP_AGENTS.has(agent)) next.defaultAgent = agent;
    else return res.status(400).json({ error: 'invalid default agent' });
  }
  if (Object.prototype.hasOwnProperty.call(body, 'codexSandbox')) {
    const sandbox = String(body.codexSandbox || '').trim().toLowerCase();
    if (!sandbox) delete next.codexSandbox;
    else if (VALID_CODEX_SANDBOX.has(sandbox)) next.codexSandbox = sandbox;
    else return res.status(400).json({ error: 'invalid Codex sandbox' });
  }
  APP_SETTINGS = normalizeAppSettings(next);
  refreshRuntimeDefaults();
  writeJsonAtomic(APP_SETTINGS_FILE, APP_SETTINGS);
  res.json(appSettingsPayload());
});
app.get('/api/prompt-templates', requireAuth, (req, res) => res.json({ templates: promptTemplateList(), overridesFile: PROMPT_OVERRIDES_FILE }));
app.post('/api/prompt-templates/:id', requireAuth, (req, res) => {
  const id = String(req.params.id || '');
  if (!PROMPT_TEMPLATES[id]) return res.status(404).json({ error: 'unknown prompt template' });
  const value = String((req.body && req.body.value) || '').replace(/\r\n/g, '\n').trimEnd();
  if (!value.trim()) return res.status(400).json({ error: 'template cannot be blank' });
  PROMPT_OVERRIDES = { ...PROMPT_OVERRIDES, [id]: value };
  writeJsonAtomic(PROMPT_OVERRIDES_FILE, PROMPT_OVERRIDES);
  res.json({ ok: true, template: promptTemplateList().find((t) => t.id === id) });
});
app.post('/api/prompt-templates/:id/reset', requireAuth, (req, res) => {
  const id = String(req.params.id || '');
  if (!PROMPT_TEMPLATES[id]) return res.status(404).json({ error: 'unknown prompt template' });
  if (Object.prototype.hasOwnProperty.call(PROMPT_OVERRIDES, id)) {
    const next = { ...PROMPT_OVERRIDES }; delete next[id]; PROMPT_OVERRIDES = next;
    writeJsonAtomic(PROMPT_OVERRIDES_FILE, PROMPT_OVERRIDES);
  }
  res.json({ ok: true, template: promptTemplateList().find((t) => t.id === id) });
});
app.get('/api/hooks', requireAuth, (req, res) => res.json({ hooks: HOOK_SPECS.map(hookPayload) }));
app.post('/api/hooks/:id', requireAuth, (req, res) => {
  const spec = hookSpec(String(req.params.id || ''));
  if (!spec) return res.status(404).json({ error: 'unknown hook' });
  const value = String((req.body && req.body.content) || '').replace(/\r\n/g, '\n').trimEnd() + '\n';
  if (!value.trim()) return res.status(400).json({ error: 'hook cannot be blank' });
  const live = liveHookPath(spec);
  mkdirSync(dirname(live), { recursive: true });
  writeFileSync(live, value);
  try { chmodSync(live, 0o755); } catch {}
  res.json({ ok: true, hook: hookPayload(spec) });
});
app.post('/api/hooks/:id/reset', requireAuth, (req, res) => {
  const spec = hookSpec(String(req.params.id || ''));
  if (!spec) return res.status(404).json({ error: 'unknown hook' });
  const fallback = defaultHookPath(spec);
  if (!existsSync(fallback)) return res.status(404).json({ error: 'default hook missing' });
  const live = liveHookPath(spec);
  mkdirSync(dirname(live), { recursive: true });
  writeFileSync(live, readFileSync(fallback, 'utf8'));
  try { chmodSync(live, 0o755); } catch {}
  res.json({ ok: true, hook: hookPayload(spec) });
});

// Let a private overlay register extra routes / run init (business endpoints, etc.).
if (overlay.routes) { try { overlay.routes(app, { requireAuth, HOME, DEFAULT_CWD }); } catch (e) { console.error('[box] overlay.routes failed:', e && e.message); } }
if (overlay.onReady) { try { overlay.onReady({ HOME, DEFAULT_CWD }); } catch (e) { console.error('[box] overlay.onReady failed:', e && e.message); } }

// Realtime voice assistant: browser ↔ OpenAI Realtime over WebRTC; every tool call the
// model makes executes HERE with the box's own powers (sessions, Linear, research, brain…).
try {
  registerVoiceAssistant(app, {
    requireAuth, cfg, HOME, STATE_DIR, PORT, authToken: AUTH_TOKEN, ownerName: OWNER_NAME,
    defaultCwd: () => DEFAULT_CWD, listSessions, findSessionFile, tailInfo, enqueue, rt, RUNNING, childEnv,
    macAvailable, loadCodexMessages, codexHome: CODEX_HOME, codexMessagePath: codexMsgFile,
    transcribe: transcribeBuffer, // for voice-memory re-transcription (recover a garbled clip)
    voiceSttEnabled: !!(ELEVEN_KEY || DEEPGRAM_KEY),
    runAdapterTurn: runVoiceAdapterTurn,
    adapterSessionInfo: (key, sessionId = '') => {
      // `sessionId` is the durable Codex id recovered from the voice transcript.
      // It is required after a Box restart, when the in-memory call-id alias is gone.
      const s = rt(sessionId || key);
      return { sessionId: s.sessionId || '', agent: s.agent || '', busy: !!s.running || s.queue.length > 0 };
    },
  });
} catch (e) { console.error('[box] voice assistant init failed:', e && e.message); }

async function linearGql(query, variables) {
  if (linearLite) return linearLite.gql(query, variables); // local SQLite-backed clone
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
  if (pr && ghToken()) {
    try { const r = await fetch(`https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, { headers: { Authorization: `token ${ghToken()}`, Accept: 'application/vnd.github+json' } }); if (r.ok) { const p = await r.json(); pr.state = p.merged ? 'merged' : p.state; pr.title = p.title; pr.mergeable = p.mergeable; } } catch {}
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
// sortOrder drives the manual drag-reorder within a column (and across columns).
const BOARD_FIELDS = 'identifier title url priority sortOrder updatedAt state { id name type position } labels { nodes { name } } assignee { displayName }';
const BOARD_RANK = { triage: 0, backlog: 1, unstarted: 2, started: 3, completed: 4 };
// Tiny in-memory cache so rapid re-opens / multiple phone clients don't each re-hit Linear.
// Invalidated immediately by any board-mutating endpoint (move/state/done/create/delegate);
// the refresh button bypasses it with ?fresh=1.
let _boardCache = null;            // { at: ms, payload }
const BOARD_TTL = 8000;
const invalidateBoard = () => { _boardCache = null; };
app.get('/api/linear-board', requireAuth, async (req, res) => {
  if (!LINEAR_KEY) return res.status(500).json({ error: 'no LINEAR_API_KEY' });
  const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
  if (!fresh && _boardCache && (Date.now() - _boardCache.at) < BOARD_TTL) {
    return res.json({ ..._boardCache.payload, cached: true });
  }
  try {
    // ONE round-trip instead of three: states + active + recent-done, aliased in a single
    // GraphQL query. Cuts board load latency ~3x (was three sequential awaits to Linear).
    const d = await linearGql(`{
      team(id:"${BOARD_TEAM}"){ states{ nodes{ id name type position } } }
      active: issues(first: 250, orderBy: updatedAt, filter: {
        team: { id: { eq: "${BOARD_TEAM}" } }, state: { type: { in: ["triage","backlog","unstarted","started"] } }
      }) { nodes { ${BOARD_FIELDS} } }
      recentDone: issues(first: 30, orderBy: updatedAt, filter: {
        team: { id: { eq: "${BOARD_TEAM}" } }, state: { type: { eq: "completed" } }
      }) { nodes { ${BOARD_FIELDS} } }
    }`);
    const states = ((d.team && d.team.states && d.team.states.nodes) || [])
      .filter((s) => s.type in BOARD_RANK)                       // drop canceled/duplicate
      .sort((a, b) => (BOARD_RANK[a.type] - BOARD_RANK[b.type]) || (a.position - b.position));
    const activeNodes = (d.active && d.active.nodes) || [];
    const doneNodes = (d.recentDone && d.recentDone.nodes) || [];
    const delg = loadDelegations();           // box-local delegation ledger → board badge
    const byState = new Map();
    for (const n of [...activeNodes, ...doneNodes]) {
      if (!byState.has(n.state.name)) byState.set(n.state.name, []);
      const dl = latestDelegation(delg[n.identifier]);
      byState.get(n.state.name).push({
        id: n.identifier, title: n.title, url: n.url, priority: n.priority || 0,
        sortOrder: (n.sortOrder == null ? 0 : n.sortOrder), stateId: n.state.id,
        updatedAt: n.updatedAt, labels: ((n.labels && n.labels.nodes) || []).map((l) => l.name),
        assignee: (n.assignee && n.assignee.displayName) || null,
        delegation: dl ? { sessionId: dl.sessionId, sessionTitle: dl.sessionTitle, agent: dl.agent, kind: dl.kind, ts: dl.ts } : null,
      });
    }
    // Order each column by Linear's manual sortOrder (ascending = top) so drag-reorder
    // persists; tie-break by most-recently-updated.
    for (const arr of byState.values()) {
      arr.sort((a, b) => (a.sortOrder - b.sortOrder) || (Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
    }
    // Seed a column per workflow state (in order) so empty columns still show the
    // board's structure. Done is labeled "recent" (capped) — it isn't "open" work.
    const columns = states.map((s) => ({
      name: s.name, type: s.type, stateId: s.id, recent: s.type === 'completed',
      issues: byState.get(s.name) || [], count: (byState.get(s.name) || []).length,
    }));
    const payload = { columns, total: activeNodes.length, generatedAt: new Date().toISOString() };
    _boardCache = { at: Date.now(), payload };
    res.json(payload);
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});
app.post('/api/linear/:id/done', requireAuth, async (req, res) => {
  try {
    const it = await fetchLinearIssue(req.params.id); if (!it) return res.status(404).json({ error: 'not found' });
    const ws = await linearGql(`{ team(id:"${it.teamId}"){ states{ nodes{ id name type } } } }`);
    const done = ws.team.states.nodes.find((s) => s.type === 'completed');
    await linearGql(`mutation{ issueUpdate(id:"${it.id}", input:{ stateId:"${done.id}" }){ success } }`);
    invalidateBoard();
    res.json({ ok: true, state: done.name });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/linear/:id/merge', requireAuth, async (req, res) => {
  if (!ghToken()) return res.status(500).json({ error: 'no GitHub auth — set GITHUB_TOKEN or run `gh auth login`' });
  try {
    const it = await fetchLinearIssue(req.params.id); if (!it || !it.pr) return res.status(404).json({ error: 'no PR linked' });
    const { owner, repo, number } = it.pr;
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}/merge`, { method: 'PUT', headers: { Authorization: `token ${ghToken()}`, Accept: 'application/vnd.github+json' }, body: JSON.stringify({ merge_method: 'squash' }) });
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
    if (pr && ghToken()) {
      try { const r = await fetch(`https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, { headers: { Authorization: `token ${ghToken()}`, Accept: 'application/vnd.github+json' } }); if (r.ok) { const p = await r.json(); pr.state = p.merged ? 'merged' : p.state; pr.title = p.title; } } catch {}
    }
    res.json({
      id: it.id, identifier: it.identifier, title: it.title, description: it.description || '',
      priority: it.priority || 0, url: it.url, createdAt: it.createdAt, updatedAt: it.updatedAt,
      state: it.state, assignee: it.assignee ? it.assignee.displayName : null,
      labels: (it.labels.nodes || []).map((l) => ({ name: l.name, color: l.color })),
      comments: (it.comments.nodes || []).map((c) => ({ body: c.body, createdAt: c.createdAt, user: c.user ? c.user.displayName : 'someone' })),
      attachments: (it.attachments.nodes || []).map((a) => ({ url: a.url, title: a.title })),
      delegations: loadDelegations()[it.identifier] || [],
      meetingContext: renderMeetingContextForIssue(it),
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
    invalidateBoard();
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
    agent: VALID_APP_AGENTS.has(String(b.agent || '')) ? String(b.agent) : 'claude',
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
        const agentName = rec.agent === 'codex' ? 'Codex' : rec.agent === 'gemini' ? 'Gemini' : rec.agent === 'agy' ? 'Antigravity' : rec.agent === 'mac' ? 'Computer Use' : 'Claude';
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
  if (claimed) invalidateBoard();   // the claim moved state + added a label → board changed
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
    invalidateBoard();
    res.json({ ok: !!(d.issueUpdate && d.issueUpdate.success), state: d.issueUpdate && d.issueUpdate.issue && d.issueUpdate.issue.state && d.issueUpdate.issue.state.name });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Board drag-and-drop: move an issue to a column (stateId) and/or reposition it within a
// column (sortOrder), in a single issueUpdate. Both fields are optional but at least one is
// required. sortOrder is a float; the client picks the midpoint of the drop neighbours.
app.post('/api/linear/:id/move', requireAuth, async (req, res) => {
  if (!LINEAR_KEY) return res.status(500).json({ error: 'no LINEAR_API_KEY' });
  const b = req.body || {};
  const input = {};
  if (b.stateId) input.stateId = String(b.stateId);
  if (b.sortOrder != null && b.sortOrder !== '' && Number.isFinite(Number(b.sortOrder))) input.sortOrder = Number(b.sortOrder);
  if (!Object.keys(input).length) return res.status(400).json({ error: 'stateId or sortOrder required' });
  try {
    const gid = await linearGid(req.params.id); if (!gid) return res.status(404).json({ error: 'not found' });
    const d = await linearGql(`mutation Move($id: String!, $input: IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success issue{ state{ name } sortOrder } } }`, { id: gid, input });
    invalidateBoard();
    const iss = d.issueUpdate && d.issueUpdate.issue;
    res.json({ ok: !!(d.issueUpdate && d.issueUpdate.success), state: iss && iss.state && iss.state.name, sortOrder: iss && iss.sortOrder });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Search the team's issues (all states, incl. closed/old that aren't on the board) by title
// or issue number. Powers the board search box's "found in Linear" results beyond what's
// already loaded on the board.
app.get('/api/linear-search', requireAuth, async (req, res) => {
  if (!LINEAR_KEY) return res.status(500).json({ error: 'no LINEAR_API_KEY' });
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ issues: [] });
  try {
    const num = q.replace(/[^0-9]/g, '');
    const ors = [`{ title: { containsIgnoreCase: ${JSON.stringify(q)} } }`];
    if (num) ors.push(`{ number: { eq: ${num} } }`);
    const d = await linearGql(`{ issues(first: 25, orderBy: updatedAt, filter: {
      team: { id: { eq: "${BOARD_TEAM}" } }, or: [ ${ors.join(', ')} ]
    }) { nodes { identifier title url priority updatedAt state { name type } labels { nodes { name } } assignee { displayName } } } }`);
    const nodes = (d.issues && d.issues.nodes) || [];
    res.json({ issues: nodes.map((n) => ({
      id: n.identifier, title: n.title, url: n.url, priority: n.priority || 0, updatedAt: n.updatedAt,
      state: n.state ? n.state.name : '', type: n.state ? n.state.type : '',
      labels: ((n.labels && n.labels.nodes) || []).map((l) => l.name),
      assignee: (n.assignee && n.assignee.displayName) || null,
    })) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
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
      const n = codexSessionMentionCount(s, id);
      if (n) counts[sid] = (counts[sid] || 0) + n;
    }
  } catch {}
  // gemini sessions live in one JSON store keyed by id
  try {
    for (const [sid, s] of Object.entries(loadGemini().sessions || {})) {
      const n = (JSON.stringify(s.messages || '').match(new RegExp(id, 'g')) || []).length;
      if (n) counts[sid] = (counts[sid] || 0) + n;
    }
  } catch {}
  // antigravity sessions live in one JSON store keyed by id
  try {
    for (const [sid, s] of Object.entries(loadAgy().sessions || {})) {
      const n = (JSON.stringify(s.messages || '').match(new RegExp(id, 'g')) || []).length;
      if (n) counts[sid] = (counts[sid] || 0) + n;
    }
  } catch {}
  const names = loadNames();
  const codex = loadCodex().sessions || {};
  const gemini = loadGemini().sessions || {};
  const agy = loadAgy().sessions || {};
  const sessions = [];
  for (const sid of Object.keys(counts)) {
    if (sid === exclude) continue;
    if (codex[sid]) {
      const c = codex[sid];
      sessions.push({ id: sid, title: names[sid] || c.title || 'Codex session', agent: 'codex', cwd: c.cwd || DEFAULT_CWD, category: 'main', subcat: null, mtime: codexSessionMtime(c), mentions: counts[sid] });
      continue;
    }
    if (gemini[sid]) {
      const g = gemini[sid];
      sessions.push({ id: sid, title: names[sid] || g.title || 'Gemini session', agent: 'gemini', cwd: g.cwd || DEFAULT_CWD, category: 'main', subcat: null, mtime: g.updatedAt ? Date.parse(g.updatedAt) : (g.lastUsed || g.created || 0), mentions: counts[sid] });
      continue;
    }
    if (agy[sid]) {
      const a = agy[sid];
      sessions.push({ id: sid, title: names[sid] || a.title || 'Antigravity session', agent: 'agy', cwd: a.cwd || DEFAULT_CWD, category: 'main', subcat: null, mtime: a.updatedAt ? Date.parse(a.updatedAt) : (a.lastUsed || a.created || 0), mentions: counts[sid] });
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
function sessionIssueCountsFromMessages(messages, counts) {
  for (const m of messages || []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = codexMessageText(m);
    if (m.role === 'user' && (INC_INJECT_RE.test(text) || /New since your last turn|Needs your input/.test(text))) continue;
    if (text) tallyIssues(text, counts);
  }
}
app.get('/api/sessions/:id/linear', requireAuth, async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9-]+$/.test(id)) return res.json({ issues: [] });
  const counts = {};                                   // issue number -> mention count (dialogue only)
  try { const file = jsonlPath(id); if (file && existsSync(file)) Object.assign(counts, sessionIssueCounts(file)); } catch {}
  try {                                                // codex dialogue (user/assistant text only)
    const c = (loadCodex().sessions || {})[id];
    if (c) sessionIssueCountsFromMessages(c.messages || [], counts);
  } catch {}
  try {
    const g = (loadGemini().sessions || {})[id];
    if (g) sessionIssueCountsFromMessages(g.messages || [], counts);
  } catch {}
  try {
    const a = (loadAgy().sessions || {})[id];
    if (a) sessionIssueCountsFromMessages(a.messages || [], counts);
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

app.post('/api/resolve-paths', requireAuth, (req, res) => {
  const cwd = expandUserPath(req.body && req.body.cwd) || DEFAULT_CWD;
  const paths = Array.isArray(req.body && req.body.paths) ? req.body.paths.slice(0, 80) : [];
  const results = {};
  for (const raw of paths) {
    const token = cleanPathToken(raw);
    if (!token) continue;
    const expanded = expandLocalPathToken(token, cwd);
    if (!expanded && !FILE_SEARCH_EXT_RE.test(token)) {
      results[token] = { found: false };
      continue;
    }
    results[token] = resolveLocalFileReference(token, cwd);
  }
  res.json({ results });
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
  // uploads get a random-prefixed filename at write time → content-addressed enough to
  // cache hard; without this every chat re-open re-downloaded every attachment in full
  res.sendFile(p, { maxAge: 7 * 24 * 3600 * 1000, immutable: true }, (e) => { if (e && !res.headersSent) res.status(404).end(); });
});

// serve any file on the box (token-gated, personal use) — for the media viewer
app.get('/api/raw', requireAuth, (req, res) => {
  const p = resolve(req.query.path || '');
  try { if (!statSync(p).isFile()) return res.status(404).end(); } catch { return res.status(404).end(); }
  if (req.query.dl) res.setHeader('Content-Disposition', `attachment; filename="${basename(p)}"`);
  // short freshness window + ETag revalidation after: chat re-renders re-request the same
  // inline previews many times; without any Cache-Control each one was a full re-download
  res.sendFile(p, { maxAge: 5 * 60 * 1000 }, (e) => { if (e && !res.headersSent) res.status(404).end(); });
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

// LiveKit's browser SDK is served from the pinned npm dependency rather than a CDN so
// voice mode keeps working through poor cellular coverage and has a reproducible build.
app.get('/vendor/livekit-client.umd.js', (_req, res) => {
  res.sendFile(join(ROOT, 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js'), {
    maxAge: '7d', immutable: true,
  });
});
app.use(express.static(PUBLIC));
// Box is a client-side app, but its screens use real pathname routes so chats and
// issues can be bookmarked/shared and browser navigation reads naturally. Serve the
// shell for those route URLs; API and static-file requests retain normal 404 behavior.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || extname(req.path)) return next();
  res.sendFile(join(PUBLIC, 'index.html'));
});

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
    const codex = isUuid(key) ? (loadCodex().sessions || {})[key] : null;
    RT.set(key, { key, sessionId: p.sessionId || (isUuid(key) ? key : null), cwd: p.cwd || (codex && codex.cwd) || null, agent: p.agent || (codex ? 'codex' : null),
      parentId: p.parentId || null, parentTitle: p.parentTitle || '', title: p.title || '',
      settings: normalizeSettings(p.settings || (codex && codex.settings) || {}),
      context: p.context || null,
      queue: recoverPersistedQueue(p), inflight: null, running: false, curText: '', curTools: [], curParts: [], lastActivityAt: 0, activityLabel: '', subs: new Set(), proc: null, canceled: false });
  }
  return RT.get(key);
}
function persist(s) { try { writeFileSync(qpath(s.sessionId || s.key), JSON.stringify({ sessionId: s.sessionId, cwd: s.cwd, agent: s.agent, parentId: s.parentId || null, parentTitle: s.parentTitle || '', title: s.title || '', settings: normalizeSettings(s.settings || {}), context: s.context || null, queue: s.queue, inflight: s.inflight || null })); } catch {} }
function activityLabelForEvent(o, previous = '') {
  if (!o || !o.type) return '';
  if (o.type === 'turn_start') return 'Starting';
  if (o.type === 'thinking') return 'Thinking';
  if (o.type === 'text') return 'Writing response';
  if (o.type === 'bash_out') return 'Running command';
  if (o.type === 'notice') return previous || 'Working';
  if (o.type === 'tool_result') return previous || 'Processing result';
  if (o.type !== 'tool') return '';
  if (o.name === 'Bash' || o.name === 'SlashCommand') return 'Running command';
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'ApplyPatch'].includes(o.name)) return 'Editing files';
  if (['Read'].includes(o.name)) return 'Reading files';
  if (['Grep', 'Glob'].includes(o.name)) return 'Searching code';
  if (['WebFetch', 'WebSearch'].includes(o.name)) return 'Searching web';
  if (o.name === 'Task') return 'Delegating work';
  if (o.name === 'MCP') return 'Using connected tool';
  return o.name ? `Using ${o.name}` : 'Using tool';
}
function bcast(s, event) {
  let o = event;
  const activityLabel = activityLabelForEvent(event, s.activityLabel);
  if (activityLabel) {
    s.lastActivityAt = Date.now();
    s.activityLabel = activityLabel;
    o = { ...event, activityAt: s.lastActivityAt, activityLabel };
  }
  for (const ws of s.subs) { try { ws.send(JSON.stringify(o)); } catch {} }
}
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
  // A Box-owned Codex turn is already rendered from `codex exec --json`. Its rollout is
  // written at the same time, so consuming both streams would replay the same user/text/tool
  // events and visibly duplicate the turn. The rollout tail owns only external/native turns.
  if (s.agent === 'codex' && s.proc) return;
  if (ev.kind === 'user') {
    // our own injected message echoes back as a user entry; skip one per inject.
    if (s.expectUserEcho > 0) { s.expectUserEcho--; return; }
    if (ev.text && !ev.text.startsWith('<') && !ev.text.startsWith('Caveat:')) {
      s.curText = ''; s.curTools = []; s.curParts = [];
      bcast(s, { type: 'remote_user', text: ev.text });
    }
    return;
  }
  if (ev.kind === 'text') {
    const last = s.curParts[s.curParts.length - 1];
    const delta = s.agent === 'codex' && last && last.t === 'text' && last.text ? `\n\n${ev.text}` : ev.text;
    s.curText += delta; pushTextPart(s, delta); bcast(s, { type: 'text', delta });
  }
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
    else if (s.agent === 'codex') bcast(s, { type: 'done', sessionId: s.sessionId, external: true });
    s.turnCount = (s.turnCount || 0) + 1;
    if (s.sessionId) {
      s.context = contextForSession(s.sessionId, { agent: s.agent || 'claude' });
      bcast(s, { type: 'context', context: s.context });
      persist(s);
    }
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
function agentDisplayName(agent) {
  return agent === 'codex' ? 'Codex' : agent === 'gemini' ? 'Gemini' : agent === 'agy' ? 'Antigravity' : agent === 'mac' ? 'Computer Use' : 'Claude';
}
function recentImagesForHistory(sessionId, hist) {
  if (!hist || hist.agent === 'claude' || !hist.agent) return scanRecentImages(sessionId);
  const out = [];
  const IMG_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
  for (const m of [...(hist.messages || [])].reverse()) {
    const paths = (m.parts || []).filter((p) => p && (p.t === 'image' || p.t === 'file') && IMG_RE.test(p.path || '') && existsSync(p.path)).map((p) => p.path);
    if (paths.length) out.push({ paths, caption: '' });
    if (out.length >= 8) break;
  }
  return out.reverse();
}

async function triggerAttentionUpdate(s) {
  if (!s.sessionId || s._attnUpdating) return;
  // Never run for automated / headless `claude -p` sessions the box app merely
  // tracks (dream-cycle, linear-dispatch, healer, brain, career-ops, box-attention).
  // Morning-brief docs are only for real interactive sessions the user started.
  if (AUTO_DIR_RE.test(s.cwd || '') || isAutoFile(jsonlPath(s.sessionId))) return;
  s._attnUpdating = true;
  let hist;
  try { hist = await sessionHistory(s.sessionId); }
  catch { s._attnUpdating = false; return; }
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
  const recentImgs = recentImagesForHistory(s.sessionId, hist);
  const assistantName = agentDisplayName(hist.agent || s.agent || 'claude').toUpperCase();
  const turns = hist.messages.slice(-20).map((m) => {
    const text = m.parts.filter((p) => p.t === 'text').map((p) => p.text).join(' ').slice(0, 2000);
    return `[${m.role === 'user' ? 'USER' : assistantName}]: ${text}`;
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
  const prompt = renderTemplate('attention-status', {
    ownerName: OWNER_NAME,
    existingDocBlock: existing ? `EXISTING STATUS DOC (current best knowledge — refine it, don't discard it):\n${existing}\n\n` : '',
    imageSection: imgSection,
    recentTurns: turns,
    imageRule: imgRule,
    doneImageHint: allowedImgPaths.length ? '\n  ![description](exact path copied from the screenshots list above — omit this line entirely if none fits)' : '',
  });
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
function ensureTail(s, fromLine, codexFromOffset = null) {
  if (!s.sessionId || s.tailStop || s._tailWait) return;
  if (s.agent === 'codex' || (loadCodex().sessions || {})[s.sessionId]) {
    const rec = (loadCodex().sessions || {})[s.sessionId] || {};
    const rollout = rec.transcriptPath || findCodexRollout(CODEX_HOME, s.sessionId);
    if (rollout) s.tailStop = tailCodexRollout(rollout, (ev) => onTailEvent(s, ev), { fromOffset: codexFromOffset });
    return;
  }
  const begin = (jf) => {
    if (s.tailStop) return;
    const start = fromLine != null ? fromLine : readJsonl(jf).lines;
    s.tailStop = tailJsonl(jf, start, (ev) => onTailEvent(s, ev));
  };
  // For a brand-new chat the pre-minted session id makes session_p resolve at SPAWN —
  // before claude has created the JSONL — and we don't yet know which account/cwd it'll
  // land under (the broker may route it to ~/.claude-<id>). jsonlPath() would then return
  // its fallback path and we'd tail a file that never gets written → no output rendered.
  // So: tail immediately if the file already exists, else poll across all config dirs
  // (findSessionFile) until it appears, then tail THAT real path.
  const existing = findSessionFile(s.sessionId);
  if (existing) { begin(existing); return; }
  let tries = 0;
  s._tailWait = setInterval(() => {
    if (s.tailStop || !s.sessionId) { clearInterval(s._tailWait); s._tailWait = null; return; }
    const f = findSessionFile(s.sessionId);
    if (f) { clearInterval(s._tailWait); s._tailWait = null; begin(f); }
    else if (++tries > 75) { clearInterval(s._tailWait); s._tailWait = null; } // ~30s: give up quietly
  }, 400);
}
function stopTail(s) {
  if (s._tailWait) { clearInterval(s._tailWait); s._tailWait = null; }
  if (s._promptRetry) { clearTimeout(s._promptRetry); s._promptRetry = null; }
  if (s.tailStop) { try { s.tailStop(); } catch {} s.tailStop = null; }
}
// A freshly-spawned claude TUI can silently DROP the first injected prompt if it's still
// settling when sendRecord pastes (observed reliably for new chats in ~/ — claude is loading
// home-dir context, so the input box isn't live yet even though PTY output has gone quiet).
// The box would then wait forever for a turn that never starts. claude writes the user turn to
// its JSONL the instant it RECEIVES the prompt, so if no transcript appears within a few
// seconds the paste was dropped → re-inject. A dropped paste leaves NO entry, so re-injecting
// can't double-submit (verified). Stops as soon as the transcript exists. New chats only —
// existing sessions are already booted and land reliably.
function ensureFirstPromptLanded(s, rec, prompt, attempt = 0) {
  if (attempt >= 4 || !s || !s.sessionId) return;
  s._promptRetry = setTimeout(() => {
    s._promptRetry = null;
    if (s.canceled || !s.sessionId || s.agent === 'codex') return;
    if (findSessionFile(s.sessionId)) return;            // claude received it (transcript created)
    rcEngine.sendRecord(rec, prompt).catch(() => {});    // dropped by a settling TUI → re-inject
    ensureFirstPromptLanded(s, rec, prompt, attempt + 1);
  }, 4500);
}

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

function nativeCodexTurnActive(s) {
  if (!s || !s.sessionId || (s.agent && s.agent !== 'codex')) return false;
  const rec = (loadCodex().sessions || {})[s.sessionId];
  if (!rec || rec.source !== 'native' || !runningCodexThreadIds().has(s.sessionId)) return false;
  return codexRolloutState(rec.transcriptPath || findCodexRollout(CODEX_HOME, s.sessionId)).busy;
}

function waitForNativeCodexTurn(s) {
  if (s._nativeWait || !s.queue.length) return;
  s._nativeWait = setInterval(() => {
    if (!s.queue.length) { clearInterval(s._nativeWait); s._nativeWait = null; return; }
    if (nativeCodexTurnActive(s)) return;
    clearInterval(s._nativeWait); s._nativeWait = null;
    runWorker(s);
  }, 1000);
  bcast(s, { type: 'native_wait', sessionId: s.sessionId, msg: 'Queued — waiting for the terminal Codex turn to finish.' });
}

// A synchronous facade over the normal Box queue for the experimental voice adapter.
// It deliberately uses the existing Claude/Codex turn runners: context, tool streaming,
// sandbox settings, remote-control ownership, and session persistence stay identical to
// a phone chat. Adapter callers may have only one outstanding spoken turn per session.
function runVoiceAdapterTurn({ key, sessionId = '', text, agent = 'claude', cwd = DEFAULT_CWD, title = 'Voice adapter', interrupt = false, codexSettings = null, onStart, onSession, onText } = {}) {
  // A call id is intentionally not the Codex session id.  The call may survive a
  // Box deploy/restart, which clears RT/ALIAS, so resume from the durable Codex id
  // recorded by the voice layer whenever it has one.
  const s = rt(sessionId || key);
  if (s.sessionId && s.agent && s.agent !== agent) return Promise.reject(new Error(`voice adapter session belongs to ${s.agent}; start a new call before switching agents`));
  // A voice call owns a persistent thread, but its first turn should use the
  // voice-specific latency profile. Do not silently change an already-running
  // or resumed Codex session's model mid-conversation.
  if (!s.sessionId && agent === 'codex' && codexSettings) {
    s.settings = normalizeSettings({ ...s.settings, codex: { ...(s.settings || {}).codex, ...codexSettings } });
  }
  const busy = s.running || s.queue.length;
  if (busy && !interrupt) return Promise.reject(new Error('voice adapter session is busy — wait for the current reply'));
  // Codex CLI turns are atomic.  To accept a caller barge-in, end the current
  // process and place the new instruction directly behind it in the SAME queue.
  // The next resume retains its thread/tool context; it never creates a new chat.
  if (busy && interrupt) cancelCurrent(s.key);
  return new Promise((resolve) => {
    enqueue(s.key, {
      text, displayText: text, mode: 'normal', agent, cwd, title, voiceOnly: true, onStart, onSession, onText,
      // A Codex turn can emit a progress note followed by its final answer.
      // The Box chat retains both, but the voice bridge must speak only the
      // final substantive agent message.
      onComplete: (result) => resolve(result),
    });
  });
}
app.post('/api/agent/enqueue', requireAuth, (req, res) => {
  const body = req.body || {};
  const text = String(body.text || body.prompt || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const agent = String(body.agent || appDefaultAgent() || 'claude').trim().toLowerCase();
  if (!VALID_APP_AGENTS.has(agent)) return res.status(400).json({ error: `unknown agent ${agent}` });
  const rawKey = String(body.key || `new-${randomBytes(4).toString('hex')}`).trim();
  const key = rawKey.replace(/[^\w.-]/g, '').slice(0, 80) || `new-${randomBytes(4).toString('hex')}`;
  const cwd = validateDirectory(expandUserPath(body.cwd || '')) ? expandUserPath(body.cwd) : DEFAULT_CWD;
  const title = sanitizeTitle(body.title || '') || text.replace(/\s+/g, ' ').slice(0, 72);
  if (body.dryRun || body.dry_run) return res.json({ ok: true, dry_run: true, key, agent, cwd, title });
  if (agent === 'mac' && !macAvailable()) return res.status(409).json({ error: 'mac bridge unavailable' });
  const qid = enqueue(key, {
    text,
    displayText: body.displayText,
    images: Array.isArray(body.images) ? body.images : [],
    mode: body.mode === 'bash' ? 'bash' : 'normal',
    agent,
    cwd,
    title,
    parentId: body.parentId || null,
    parentTitle: body.parentTitle || '',
    force: !!body.force,
  });
  res.json({ ok: true, key, qid, agent, cwd, title });
});
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

function codexUserQidPersisted(sessionId, qid) {
  if (!sessionId || !qid) return false;
  const rec = (loadCodex().sessions || {})[sessionId] || null;
  return loadCodexMessages(sessionId, rec).some((message) => message && message.role === 'user' && message.qid === qid);
}

function prepareRecoveredMessage(s, message) {
  if (!message || !message.recovered || message.agent !== 'codex') return message;
  // If the original user row made it to durable history, replaying its exact text after a
  // service restart creates a duplicate user turn and may repeat completed writes. Resume with
  // an explicit continuation instead. If it never landed, retain the original text so a crash
  // between queue persistence and Codex startup cannot lose the request.
  return prepareRecoveredCodexMessage(message, { originalLanded: codexUserQidPersisted(s.sessionId, message.qid) });
}

async function runWorker(s) {
  if (s.running) return;
  // A directly-launched Codex TUI and `codex exec resume` are separate clients. Starting
  // the latter while the TUI is mid-turn can race/fork the same thread. Keep the Box message
  // durably queued and launch it against the same id immediately after the terminal emits its
  // final answer (or exits).
  if (nativeCodexTurnActive(s)) { waitForNativeCodexTurn(s); return; }
  s.running = true;
  while (s.queue.length) {
    const batch = s.queue.splice(0, s.queue.length);   // drain ALL currently queued
    const msg = combineQueued(batch.map((message) => prepareRecoveredMessage(s, message)));
    // Removing a message from `queue` must not remove it from durable state. A deploy or
    // crash can happen before Codex emits anything; retain the active turn separately so
    // the replacement Box process puts it back at the front of the queue on startup.
    s.inflight = msg;
    s.agent = msg.agent || s.agent || 'claude';
    if (msg.parentId) s.parentId = msg.parentId;
    if (msg.parentTitle) s.parentTitle = msg.parentTitle;
    if (msg.title) s.title = msg.title;
    s.curText = ''; s.curTools = []; s.curParts = []; s.voiceFinalText = ''; s.canceled = false; s.lastTurnError = ''; s.lastActivityAt = Date.now(); s.activityLabel = 'Starting'; s.curUser = msg.displayText != null ? msg.displayText : msg.text; s.curUserImages = msg.images || [];
    if (s.sessionId) { addRunning(s.sessionId); unarchiveOnResume(s.sessionId); } // a new message resumes the chat → bring it out of the archive (and out of the reaper's reach)
    bcast(s, { type: 'turn_start', qid: msg.qid, text: msg.displayText != null ? msg.displayText : msg.text, mode: msg.mode, agent: s.agent, images: msg.images || [] });
    persist(s);
    bcast(s, { type: 'queue', queue: queueView(s) });  // emptied — chips clear
    if (typeof msg.onStart === 'function') { try { msg.onStart({ sessionId: s.sessionId || '', agent: s.agent || msg.agent || 'claude' }); } catch {} }
    await runTurn(s, msg);
    if (typeof msg.onComplete === 'function') {
      const allText = s.curParts.filter((part) => part && part.t === 'text').map((part) => part.text).join('').trim() || String(s.curText || '').trim();
      const text = msg.voiceOnly && s.voiceFinalText.trim() ? s.voiceFinalText.trim() : allText;
      try { msg.onComplete({ text, sessionId: s.sessionId || '', agent: s.agent || msg.agent || 'claude', error: s.lastTurnError || '', canceled: !!s.canceled }); } catch {}
    }
    s.inflight = null;
    persist(s);
    bcast(s, { type: 'queue', queue: queueView(s) });
  }
  s.running = false; s.curText = ''; s.curParts = []; s.curUser = ''; s.curUserImages = []; s.lastActivityAt = 0; s.activityLabel = ''; if (s.sessionId) deleteRunning(s.sessionId); bcast(s, { type: 'idle' });
}
const TURN_TIMEOUT_MS = 12 * 60 * 1000; // safety: never block the worker forever
// Codex `exec` runs a whole task autonomously in ONE turn (a delegated ticket can be
// 200+ tool calls / many minutes). 12 min would SIGTERM it mid-work and make a
// hard-working agent look like it stalled — give Codex turns a much longer safety net.
const CODEX_TURN_TIMEOUT_MS = 45 * 60 * 1000;
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
    if ((msg.agent || s.agent) === 'gemini') return runGeminiTurn(s, msg, resolve);
    if ((msg.agent || s.agent) === 'agy') return runAgyTurn(s, msg, resolve);
    if ((msg.agent || s.agent) === 'mac') return runMacTurn(s, msg, resolve);
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
          ALIAS.set(s.sessionId, s.key); addRunning(s.sessionId);
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
          ensureFirstPromptLanded(s, rec, prompt); // re-inject if a still-settling TUI dropped the first paste
        }
      } catch (e) {
        s.lastTurnError = String(e && e.message || e).slice(-400);
        bcast(s, { type: 'error', msg: s.lastTurnError });
        finish();
      }
    })();
	  });
	}
function runCodexTurn(s, msg, resolve) {
  if (!s.cwd) s.cwd = msg.cwd || DEFAULT_CWD;
  // Existing/native chats may already have a rollout watcher. Pause it while this Box-owned
  // turn runs; codexEngine is the single live source until the child exits, then finish()
  // restarts the watcher from the new EOF for future terminal-driven activity.
  if (s.sessionId) stopTail(s);
  let done = false;
  // Unique per turn so flushCodexAssistant upserts ONE live row and never collides with a
  // stale live row left by a turn the box was restarted out of (time + seq survives a
  // counter reset on restart).
  s.cxTurnId = `${Date.now()}-${++CODEX_TURN_SEQ}`;
  s.cxLastFlush = 0;
  let lastError = '';
  const userText = msg.displayText != null ? msg.displayText : (msg.text || '');
  const userParts = codexUserParts(userText, msg.images || []);
  const isNewCodexSession = !s.sessionId;
  const explicitTitle = isNewCodexSession ? sanitizeTitle(msg.title) : '';
  const initialTitle = explicitTitle || (isNewCodexSession ? fallbackTitleFromPrompt(msg.text || userText) : '');
  if (isNewCodexSession && initialTitle) s.title = initialTitle;
  // PROVISIONAL REGISTRATION — make a brand-new Codex chat durable + visible the instant the user
  // hits send, before (or even if never) codex emits `thread.started`. Keyed by the box's internal
  // `new-…` key, carrying the user's message and shown as "working" (RUNNING). On `thread.started`
  // it's migrated onto the real thread id; if codex dies first the entry stays as a recoverable,
  // retry-in-place chat instead of vanishing with the message. Only for a brand-new chat (no id yet);
  // a resume already has s.sessionId, so it's untouched.
  if (!s.sessionId) {
    s.provKey = s.key;
    ensureCodexSession(s.provKey, { cwd: s.cwd, title: initialTitle || msg.title || (msg.text || '').slice(0, 80), lastUsed: Date.now(), settings: s.settings, parentId: msg.parentId || s.parentId || null, parentTitle: msg.parentTitle || s.parentTitle || '', context: s.context || null });
    appendCodexMessage(s.provKey, 'user', userText, { parts: userParts, qid: msg.qid, recovered: !!msg.recovered });
    addRunning(s.provKey);
    if (!explicitTitle) refreshCodexTitle(s, msg.text || userText, initialTitle);
  }
  const finish = () => {
    if (done) return; done = true;
    clearTimeout(s.turnTimer); s.proc = null;
    // Finalize the streamed assistant row (same ordered {text|tool} shape Claude history
    // uses, so a reload renders like the live view). The row was already being written
    // incrementally below; this just clears the `live` flag — or writes it once for a
    // turn so short nothing flushed mid-stream.
    if (s.sessionId) {
      const assistantParts = codexAssistantParts(s.curParts);
      flushCodexAssistant(s, { finalize: true });
      // A turn that errored out (e.g. model_not_found, rate limit) only ever bcast the error to the
      // live view — reopening the chat later showed silence. Persist a short note so the failure is
      // visible in history too.
      if (lastError && !s.canceled) appendCodexMessage(s.sessionId, 'assistant', `⚠️ Codex error: ${lastError}`);
      else if (!s.canceled && !assistantParts.length) appendCodexMessage(s.sessionId, 'assistant', "⚠️ Codex exited without a response. Send again to retry.");
    } else if (s.provKey) {
      // codex never produced a thread id (startup failure / OOM / bad invocation). The provisional
      // entry already holds the user's message, so the chat stays in the list and is retryable in
      // place; clear its "working" state and leave a note explaining what happened.
      deleteRunning(s.provKey);
      if (!s.canceled) appendCodexMessage(s.provKey, 'assistant', lastError ? `⚠️ Codex didn't start: ${lastError}` : "⚠️ Codex didn't start — send again to retry.");
    }
    if (s.sessionId) ensureTail(s);
    if (s.sessionId && !s.canceled) triggerAttentionUpdate(s);
    bcast(s, { type: 'done', qid: msg.qid, sessionId: s.sessionId, canceled: s.canceled });
    resolve();
  };
  s.turnTimer = setTimeout(() => {
    if (s.proc) { try { s.proc.kill('SIGTERM'); } catch {} }
    finish();
  }, CODEX_TURN_TIMEOUT_MS);
  s.proc = codexEngine.run({
    sessionId: s.sessionId,
    cwd: s.cwd,
    prompt: msg.text || '',
    images: msg.images || [],
    settings: (s.settings || {}).codex || DEFAULT_SETTINGS.codex,
    onEvent: (ev) => {
      if (ev.type === 'session' && ev.id) {
        const provKey = s.provKey || null;
        s.sessionId = ev.id; s.agent = 'codex';
        ALIAS.set(s.sessionId, s.key); addRunning(s.sessionId);
        // Migrate the provisional entry (and its already-appended user message) onto the real
        // thread id, then drop its working marker. provKey is cleared so finish() treats this as a
        // normal (registered) turn.
        if (provKey && provKey !== s.sessionId) { deleteRunning(provKey); migrateCodexSession(provKey, s.sessionId); }
        s.provKey = null;
        if (s.key !== s.sessionId) { try { unlinkSync(qpath(s.key)); } catch {} }
        ensureCodexSession(s.sessionId, { cwd: s.cwd, title: s.title || initialTitle || msg.title || (msg.text || '').slice(0, 80), lastUsed: Date.now(), settings: s.settings, parentId: msg.parentId || s.parentId || null, parentTitle: msg.parentTitle || s.parentTitle || '', context: s.context || null });
        if (!provKey) appendCodexMessage(s.sessionId, 'user', userText, { parts: userParts, qid: msg.qid, recovered: !!msg.recovered }); // provisional path already appended it
        persist(s);
        if (typeof msg.onSession === 'function') { try { msg.onSession({ sessionId: s.sessionId, agent: 'codex' }); } catch {} }
        bcast(s, { type: 'session', id: s.sessionId, agent: 'codex', parentId: s.parentId || null, parentTitle: s.parentTitle || '', title: s.title || initialTitle || '' });
      } else if (ev.type === 'text') {
        // Codex streams each agent_message as a complete, self-contained chunk. When
        // two arrive back-to-back (no tool between) we must separate them with a blank
        // line, or the markdown renderer runs them into one block ("...worktree.The
        // company-brain skill..."). Gate the separator on the previous part already
        // being text — right after a tool the client opens a fresh text element, so a
        // leading separator there would render a stray empty paragraph.
        const raw = ev.delta || '';
        if (msg.voiceOnly && raw.trim()) s.voiceFinalText = raw;
        if (msg.voiceOnly && typeof msg.onText === 'function' && raw.trim()) {
          try { msg.onText(raw); } catch {}
        }
        const last = s.curParts[s.curParts.length - 1];
        const delta = ((last && last.t === 'text' && last.text) ? '\n\n' : '') + raw;
        pushTextPart(s, delta);
        // Persist each agent message the moment it lands — agent messages are bounded
        // (~tens per turn), so a crash never loses one.
        if (s.sessionId) { s.cxLastFlush = Date.now(); flushCodexAssistant(s); }
        bcast(s, { type: 'text', delta });
      } else if (ev.type === 'thinking') {
        // Reasoning content stays hidden; this is only a liveness heartbeat used by the
        // activity clock so a healthy, quiet Codex turn does not look frozen.
        bcast(s, { type: 'thinking', delta: '' });
      } else if (ev.type === 'context') {
        // The context event is our cue that a turn settled; read the LIVE occupancy from
        // the rollout (codexContext) rather than ev.info, which is the cumulative session
        // total and would inflate the meter to "999%". Fall back to ev.info if the rollout
        // isn't readable yet (e.g. brand-new session before its first token_count flush).
        if (s.sessionId) s.context = updateCodexContext(s.sessionId, ev.info, codexContext(s.sessionId, (s.context || {}).model || ''));
        else s.context = contextFromCodexInfo(ev.info, s.context || {});
        persist(s);
        bcast(s, { type: 'context', context: s.context });
      } else if (ev.type === 'tool') {
        s.curTools.push(ev);
        s.curParts.push({ t: 'tool', id: ev.id, name: ev.name, input: ev.input, detail: ev.detail });
        // A tool-heavy turn can fire hundreds of these — persist the growing turn at most
        // every ~2s so an all-tools stretch still survives a crash without thrashing disk.
        const now = Date.now();
        if (s.sessionId && (!s.cxLastFlush || now - s.cxLastFlush > 2000)) { s.cxLastFlush = now; flushCodexAssistant(s); }
        bcast(s, ev);
      } else if (ev.type === 'tool_result') {
        const t = s.curTools.find((x) => x.id === ev.id); if (t) t.result = ev.content;
        const tp = s.curParts.find((p) => p.t === 'tool' && p.id === ev.id); if (tp) tp.result = ev.content;
        bcast(s, ev);
      } else if (ev.type === 'notice' || ev.type === 'error') {
      if (ev.type === 'error') { lastError = cleanCodexError(ev.msg); s.lastTurnError = lastError; }
        bcast(s, ev);
      }
    },
  });
s.proc.on('close', finish);
  s.proc.on('error', (e) => { lastError = cleanCodexError(e && e.message || e); s.lastTurnError = lastError; bcast(s, { type: 'error', msg: lastError }); finish(); });
}
// Gemini now runs as a REAL agent via the `gemini` CLI (see gemini-exec-engine.mjs), so a
// turn streams the same {session,text,tool,tool_result,context} events Codex does — handle
// them the same way (live tool chips + persisted {text|tool} parts + a live context meter).
// Session continuity is the CLI's: the box mints the id and the engine does --session-id /
// --resume, so we no longer replay box-side history into the prompt.
function runGeminiTurn(s, msg, resolve) {
  if (!s.cwd) s.cwd = msg.cwd || DEFAULT_CWD;
  let done = false;
  let lastError = '';
  s.gmTurnId = `${Date.now()}-${++GEMINI_TURN_SEQ}`;
  s.gmLastFlush = 0;
  const userText = msg.displayText != null ? msg.displayText : (msg.text || '');
  const userParts = codexUserParts(userText, msg.images || []);
  const isNew = !s.sessionId;
  const sid = s.sessionId || randomUUID();
  const explicitTitle = isNew ? sanitizeTitle(msg.title) : '';
  const initialTitle = explicitTitle || (isNew ? fallbackTitleFromPrompt(msg.text || userText) : '');
  if (isNew && initialTitle) s.title = initialTitle;
  const session = ensureGeminiSession(sid, {
    cwd: s.cwd,
    title: s.title || initialTitle || msg.title || (msg.text || '').slice(0, 80),
    lastUsed: Date.now(),
    settings: s.settings,
    parentId: msg.parentId || s.parentId || null,
    parentTitle: msg.parentTitle || s.parentTitle || '',
  });
  appendGeminiMessage(sid, 'user', userText, { parts: userParts });
  s.sessionId = sid;
  s.agent = 'gemini';
  ALIAS.set(s.sessionId, s.key); addRunning(s.sessionId);
  if (s.key !== s.sessionId) { try { unlinkSync(qpath(s.key)); } catch {} }
  persist(s);

  const finish = () => {
    if (done) return; done = true;
    clearTimeout(s.turnTimer); s.proc = null;
    if (s.sessionId) {
      flushGeminiAssistant(s, { finalize: true });
      // Persist a terminal error so reopening the chat shows the failure, not silence.
      if (lastError && !s.canceled) appendGeminiMessage(s.sessionId, 'assistant', `⚠️ Gemini error: ${lastError}`);
    }
    bcast(s, { type: 'done', qid: msg.qid, sessionId: s.sessionId, canceled: s.canceled });
    resolve();
  };
  // Agentic Gemini turns can run long (tool loops / many minutes) like Codex — give them the
  // same generous safety net rather than the short chat timeout.
  s.turnTimer = setTimeout(() => {
    if (s.proc && typeof s.proc.kill === 'function') { try { s.proc.kill('SIGTERM'); } catch {} }
    finish();
  }, CODEX_TURN_TIMEOUT_MS);
  bcast(s, { type: 'session', id: s.sessionId, agent: 'gemini', parentId: s.parentId || null, parentTitle: s.parentTitle || '', title: s.title || session.title || '' });
  s.proc = geminiEngine.run({
    sessionId: s.sessionId,
    isNew,
    cwd: s.cwd,
    prompt: msg.text || '',
    images: msg.images || [],
    settings: (s.settings || {}).gemini || DEFAULT_SETTINGS.gemini,
    apiKey: GEMINI_KEY,
    onEvent: (ev) => {
      if (ev.type === 'session') {
        // gemini echoes the id we minted; we already registered it, so nothing to migrate.
        return;
      } else if (ev.type === 'text') {
        pushTextPart(s, ev.delta || '');
        if (s.sessionId) { s.gmLastFlush = Date.now(); flushGeminiAssistant(s); }
        bcast(s, { type: 'text', delta: ev.delta || '' });
      } else if (ev.type === 'context') {
        s.context = updateGeminiContext(s.sessionId, ev.info);
        persist(s);
        bcast(s, { type: 'context', context: s.context });
      } else if (ev.type === 'tool') {
        s.curParts.push({ t: 'tool', id: ev.id, name: ev.name, input: ev.input, detail: ev.detail });
        const now = Date.now();
        if (s.sessionId && (!s.gmLastFlush || now - s.gmLastFlush > 2000)) { s.gmLastFlush = now; flushGeminiAssistant(s); }
        bcast(s, ev);
      } else if (ev.type === 'tool_result') {
        const tp = s.curParts.find((p) => p.t === 'tool' && p.id === ev.id); if (tp) tp.result = ev.content;
        bcast(s, ev);
      } else if (ev.type === 'notice' || ev.type === 'error') {
        if (ev.type === 'error') lastError = String(ev.msg || '').slice(0, 300);
        bcast(s, ev);
      }
    },
  });
  s.proc.on('close', finish);
  s.proc.on('error', (e) => { lastError = String((e && e.message) || e).slice(0, 300); bcast(s, { type: 'error', msg: lastError }); finish(); });
}
function runAgyTurn(s, msg, resolve) {
  if (!s.cwd) s.cwd = msg.cwd || DEFAULT_CWD;
  const sid = s.sessionId || randomUUID();
  const isNew = !s.sessionId;
  const session = ensureAgySession(sid, {
    cwd: s.cwd,
    title: msg.title || (msg.text || '').slice(0, 80),
    lastUsed: Date.now(),
    settings: s.settings,
    parentId: msg.parentId || s.parentId || null,
    parentTitle: msg.parentTitle || s.parentTitle || '',
  });
  const history = [...(session.messages || [])];
  appendAgyMessage(sid, 'user', msg.displayText != null ? msg.displayText : (msg.text || ''));
  s.sessionId = sid;
  s.agent = 'agy';
  ALIAS.set(s.sessionId, s.key); addRunning(s.sessionId);
  if (s.key !== s.sessionId) { try { unlinkSync(qpath(s.key)); } catch {} }
  if (isNew) persist(s);

  let done = false;
  let assistantText = '';
  const finish = () => {
    if (done) return; done = true;
    clearTimeout(s.turnTimer); s.proc = null;
    if (assistantText.trim()) appendAgyMessage(s.sessionId, 'assistant', assistantText);
    bcast(s, { type: 'done', qid: msg.qid, sessionId: s.sessionId, canceled: s.canceled });
    resolve();
  };
  s.turnTimer = setTimeout(() => {
    if (s.proc && typeof s.proc.kill === 'function') { try { s.proc.kill('SIGTERM'); } catch {} }
    finish();
  }, TURN_TIMEOUT_MS);
  bcast(s, { type: 'session', id: s.sessionId, agent: 'agy', parentId: s.parentId || null, parentTitle: s.parentTitle || '', title: s.title || session.title || '' });
  s.proc = agyEngine.run({
    sessionId: s.sessionId,
    cwd: s.cwd,
    prompt: msg.text || '',
    images: msg.images || [],
    history,
    settings: (s.settings || {}).agy || DEFAULT_SETTINGS.agy,
    command: AGY_CMD,
    onEvent: (ev) => {
      if (ev.type === 'text') {
        assistantText += (assistantText ? '\n\n' : '') + (ev.delta || '');
        bcast(s, { type: 'text', delta: ev.delta || '' });
      } else if (ev.type === 'notice' || ev.type === 'error') {
        bcast(s, ev);
      }
    },
  });
  s.proc.on('close', finish);
  s.proc.on('error', (e) => { bcast(s, { type: 'error', msg: String(e.message || e) }); finish(); });
}
// Computer Use turn: runs codex ON THE MAC (cu-bridge) with the SAME streamed {session,text,
// tool,tool_result} events Codex emits — so tool chips + live text + multi-turn resume all
// work. Modeled on runCodexTurn (id arrives via `session`), persisted in the Mac store.
function runMacTurn(s, msg, resolve) {
  if (!s.cwd) s.cwd = msg.cwd || DEFAULT_CWD;
  let done = false;
  s.macTurnId = `${Date.now()}-${++MAC_TURN_SEQ}`;
  let lastError = '';
  const userText = msg.displayText != null ? msg.displayText : (msg.text || '');
  const userParts = codexUserParts(userText, msg.images || []);
  const isNew = !s.sessionId;
  const explicitTitle = isNew ? sanitizeTitle(msg.title) : '';
  const initialTitle = explicitTitle || (isNew ? fallbackTitleFromPrompt(msg.text || userText) : '');
  if (isNew && initialTitle) s.title = initialTitle;
  // Provisional registration (like Codex): show the chat + hold the user's message the instant
  // they hit send, keyed by the box's internal `new-…` key; migrate onto the real codex thread
  // id when `session` arrives. If the Mac never answers, the message stays as a retryable chat.
  if (isNew) {
    s.provKey = s.key;
    ensureMacSession(s.provKey, { cwd: s.cwd, title: initialTitle || (msg.text || '').slice(0, 80), lastUsed: Date.now(), settings: s.settings, parentId: msg.parentId || s.parentId || null, parentTitle: msg.parentTitle || s.parentTitle || '' });
    appendMacMessage(s.provKey, 'user', userText, { parts: userParts });
    addRunning(s.provKey);
  }
  const finish = () => {
    if (done) return; done = true;
    clearTimeout(s.turnTimer); s.proc = null;
    if (s.sessionId) {
      flushMacAssistant(s, { finalize: true });
      if (lastError && !s.canceled) appendMacMessage(s.sessionId, 'assistant', `⚠️ Computer Use error: ${lastError}`);
    } else if (s.provKey) {
      deleteRunning(s.provKey);
      if (!s.canceled) appendMacMessage(s.provKey, 'assistant', lastError ? `⚠️ Computer Use didn't start: ${lastError}` : "⚠️ Computer Use didn't start — is your Mac connected (cu-bridge)? Send again to retry.");
    }
    bcast(s, { type: 'done', qid: msg.qid, sessionId: s.sessionId, canceled: s.canceled });
    resolve();
  };
  s.turnTimer = setTimeout(() => {
    if (s.proc && typeof s.proc.kill === 'function') { try { s.proc.kill('SIGTERM'); } catch {} }
    finish();
  }, CODEX_TURN_TIMEOUT_MS);
  s.proc = macEngine.run({
    sessionId: s.sessionId,
    cwd: s.cwd,
    prompt: msg.text || '',
    images: msg.images || [],
    settings: (s.settings || {}).mac || DEFAULT_SETTINGS.mac,
    onEvent: (ev) => {
      if (ev.type === 'session' && ev.id) {
        const provKey = s.provKey || null;
        s.sessionId = ev.id; s.agent = 'mac';
        ALIAS.set(s.sessionId, s.key); addRunning(s.sessionId);
        if (provKey && provKey !== s.sessionId) {
          const st = loadMac(); const rec = st.sessions[provKey];
          if (rec) { rec.id = s.sessionId; st.sessions[s.sessionId] = rec; delete st.sessions[provKey]; saveMac(st); }
          deleteRunning(provKey);
        }
        s.provKey = null;
        if (s.key !== s.sessionId) { try { unlinkSync(qpath(s.key)); } catch {} }
        ensureMacSession(s.sessionId, { cwd: s.cwd, title: s.title || initialTitle || (msg.text || '').slice(0, 80), lastUsed: Date.now(), settings: s.settings, parentId: msg.parentId || s.parentId || null, parentTitle: msg.parentTitle || s.parentTitle || '' });
        if (!provKey) appendMacMessage(s.sessionId, 'user', userText, { parts: userParts });
        persist(s);
        bcast(s, { type: 'session', id: s.sessionId, agent: 'mac', parentId: s.parentId || null, parentTitle: s.parentTitle || '', title: s.title || initialTitle || '' });
      } else if (ev.type === 'text') {
        const raw = ev.delta || '';
        const last = s.curParts[s.curParts.length - 1];
        const delta = ((last && last.t === 'text' && last.text) ? '\n\n' : '') + raw;
        pushTextPart(s, delta);
        if (s.sessionId) flushMacAssistant(s);
        bcast(s, { type: 'text', delta });
      } else if (ev.type === 'tool') {
        s.curTools.push(ev);
        s.curParts.push({ t: 'tool', id: ev.id, name: ev.name, input: ev.input, detail: ev.detail });
        if (s.sessionId) flushMacAssistant(s);
        bcast(s, ev);
      } else if (ev.type === 'tool_result') {
        const t = s.curTools.find((x) => x.id === ev.id); if (t) t.result = ev.content;
        const tp = s.curParts.find((p) => p.t === 'tool' && p.id === ev.id); if (tp) tp.result = ev.content;
        bcast(s, ev);
      } else if (ev.type === 'notice' || ev.type === 'error') {
        if (ev.type === 'error') lastError = String(ev.msg || '').slice(0, 300);
        bcast(s, ev);
      }
      // 'context' events are ignored for Computer Use v1 (codex rollout lives on the Mac).
    },
  });
  s.proc.on('close', finish);
  s.proc.on('error', (e) => { lastError = String((e && e.message) || e).slice(0, 300); bcast(s, { type: 'error', msg: lastError }); finish(); });
}
// resume persisted, non-empty queues on startup (after a restart) so a queued message is never
// lost. Covers both an existing session (keyed by sessionId) AND a brand-new chat whose first
// message was queued before its session was created (keyed by the filename, e.g. `new-abc123`) —
// the latter would otherwise be stranded across a restart.
(function resumePersisted() {
  let files = []; try { files = readdirSync(QDIR).filter((f) => f.endsWith('.json')); } catch {}
  for (const f of files) {
    try {
      const p = JSON.parse(readFileSync(join(QDIR, f), 'utf8'));
      if (!recoverPersistedQueue(p).length) continue;
      const key = p.sessionId || f.replace(/\.json$/, '');
      runWorker(rt(key));
    } catch {}
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
// messages flush/close. `is_final` seals an STT segment; `speech_final` is Deepgram's
// actual end-of-speech signal, forwarded separately so voice-adapter can hand one
// complete transcript to a CLI agent instead of guessing from browser volume.
function sttDeepgram(client, rate) {
  const dgUrl = `wss://api.deepgram.com/v1/listen?model=${encodeURIComponent(DG_MODEL)}&language=multi`
    + `&encoding=linear16&sample_rate=${rate}&channels=1&interim_results=true&smart_format=true&punctuate=true`
    + `&endpointing=500&utterance_end_ms=1000`;
  const dg = new WSClient(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_KEY}` } });
  let dgOpen = false; const queue = [];
  // keep the stream alive across short pauses (Deepgram closes after ~10s of silence)
  const keepAlive = setInterval(() => { try { if (dgOpen) dg.send(JSON.stringify({ type: 'KeepAlive' })); } catch {} }, 7000);
  dg.on('open', () => { dgOpen = true; for (const b of queue) { try { dg.send(b); } catch {} } queue.length = 0; try { client.send(JSON.stringify({ type: 'ready' })); } catch {} });
  dg.on('message', (data) => {
    let o; try { o = JSON.parse(data.toString()); } catch { return; }
    if (o.type === 'UtteranceEnd') { try { client.send(JSON.stringify({ type: 'endpoint' })); } catch {} return; }
    if (o.type !== 'Results') return;
    const text = (o.channel && o.channel.alternatives && o.channel.alternatives[0] && o.channel.alternatives[0].transcript || '').trim();
    if (text) { try { client.send(JSON.stringify({ type: o.is_final ? 'committed' : 'partial', text })); } catch {} }
    if (o.speech_final) { try { client.send(JSON.stringify({ type: 'endpoint', text })); } catch {} }
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
      if (s.sessionId) { ensureTail(s, undefined, m.liveCursor); triggerAttentionUpdate(s); } // stream live turns + refresh status snapshot (the global waiting-watch poller handles pending prompts)
      if (s.sessionId && !s.context) s.context = contextForSession(s.sessionId, { agent: s.agent || null });
      ws.send(JSON.stringify({ type: 'sync', sessionId: s.sessionId, agent: s.agent || 'claude', cwd: s.cwd || null, archived: s.sessionId ? loadArchived().has(s.sessionId) : false, favorite: s.sessionId ? loadFavorites().has(s.sessionId) : false, parentId: s.parentId || null, parentTitle: s.parentTitle || '', title: s.title || '', settings: normalizeSettings(s.settings || {}), context: s.context || null, running: s.running, activityAt: s.lastActivityAt || null, activityLabel: s.activityLabel || '', curUser: s.curUser || '', curUserImages: s.curUserImages || [], curText: s.curText, curTools: s.curTools, curParts: s.curParts, queue: queueView(s) }));
      if (s.waitingActive && s.waitingPayload) { try { ws.send(JSON.stringify(s.waitingPayload)); } catch {} } // replay a pending prompt to a (re)subscriber
    } else if (m.type === 'enqueue') {
      enqueue(m.key, { text: m.text || '', displayText: m.displayText, images: m.images || [], mode: m.mode || 'normal', agent: m.agent || 'claude', cwd: m.cwd, force: !!m.force, parentId: m.parentId || null, parentTitle: m.parentTitle || '', title: m.title || '' });
    } else if (m.type === 'settings') {
      const s = rt(m.key);
      s.settings = normalizeSettings(m.settings || s.settings || {});
      const nextCwd = expandUserPath(m.cwd);
      if (nextCwd && validateDirectory(nextCwd)) s.cwd = nextCwd;
      persist(s);
      if (s.sessionId && s.agent === 'codex') ensureCodexSession(s.sessionId, { cwd: s.cwd, settings: s.settings, lastUsed: Date.now() });
      if (s.sessionId && s.agent === 'gemini') ensureGeminiSession(s.sessionId, { cwd: s.cwd, settings: s.settings, lastUsed: Date.now() });
      if (s.sessionId && s.agent === 'agy') ensureAgySession(s.sessionId, { cwd: s.cwd, settings: s.settings, lastUsed: Date.now() });
      if (s.sessionId && s.agent === 'mac') ensureMacSession(s.sessionId, { cwd: s.cwd, settings: s.settings, lastUsed: Date.now() });
      bcast(s, { type: 'settings', settings: s.settings, cwd: s.cwd || null });
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

function killAllProcs() {
  for (const s of RT.values()) {
    if (s.bashProc) { try { s.bashProc.kill('SIGKILL'); } catch {} }
    // Codex/Gemini/Mac turns live in `proc`, not `bashProc`. Leaving these alive across
    // a Box restart creates an orphan worker while the new server recovers the turn.
    if (s.proc) { try { s.proc.kill('SIGKILL'); } catch {} }
  }
  try { rcEngine.closeAll(); } catch {}
}
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
if (process.env.BOX_SKIP_META_PROBE !== '1' && (!META.skills || !META.skills.length)) {
  try {
    execSync('command -v claude', { stdio: 'ignore' });
    const p = spawn('claude', ['-p', 'hi', '--output-format', 'stream-json', '--verbose'], { cwd: DEFAULT_CWD, env: childEnv() });
    p.on('error', () => {});
    const rl2 = createInterface({ input: p.stdout });
    rl2.on('line', (line) => { let o; try { o = JSON.parse(line); } catch { return; } if (o.type === 'system' && o.subtype === 'init') { captureMeta(o); try { p.kill('SIGTERM'); } catch {} } });
    setTimeout(() => { try { p.kill('SIGTERM'); } catch {} }, 20000);
  } catch {}
}
