// Voice assistant — a realtime, hands-free voice layer over the whole Box.
//
// Architecture: the browser talks WebRTC directly to OpenAI's Realtime API (lowest
// latency, survives flaky cellular), and every function/tool call the model makes is
// relayed by the client to POST /api/voice/tool here, where it executes with the box
// server's own powers: list/steer/start agent sessions, the Linear board, web search +
// deep research (Parallel), the company brain, notes, email, calendar.
//
// This server never proxies audio. It does three things:
//   1. POST /api/voice/token   — mints an ephemeral OpenAI client secret whose session
//      config carries instructions (with a live snapshot of the box) + tool schemas.
//   2. POST /api/voice/tool    — executes one tool call, returns the JSON result.
//   3. GET  /api/voice/updates — long-running work (deep research, delegated agents)
//      completes in the background; the client polls this and injects the completion
//      into the live conversation so the assistant announces it proactively.
//
// Realtime sessions hard-cap at 60 minutes and cannot be resumed, so the client
// reconnects with a fresh token; we keep a transcript log per voice session
// (POST /api/voice/event) and fold the recent turns into the new session's
// instructions so a reconnect mid-drive feels seamless.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync,
  readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const nowIso = () => new Date().toISOString();
const short = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const ago = (ms) => {
  if (!ms) return 'unknown';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

export function registerVoiceAssistant(app, ctx) {
  const {
    requireAuth, cfg, HOME, STATE_DIR, PORT, authToken, ownerName,
    defaultCwd, listSessions, findSessionFile, tailInfo, enqueue, rt, RUNNING, childEnv,
  } = ctx;

  const OPENAI_KEY = cfg('OPENAI_API_KEY');
  const MODEL = cfg('VOICE_ASSISTANT_MODEL', 'gpt-realtime-2');
  const VOICE = cfg('VOICE_ASSISTANT_VOICE', 'marin');
  const VOICE_DIR = join(STATE_DIR, 'voice-assistant');
  for (const d of [VOICE_DIR, join(VOICE_DIR, 'transcripts'), join(VOICE_DIR, 'research'), join(VOICE_DIR, 'notes')]) {
    try { mkdirSync(d, { recursive: true }); } catch {}
  }
  const BRIEFING_FILE = join(VOICE_DIR, 'briefing.md');
  const TASKS_FILE = join(VOICE_DIR, 'tasks.json');

  const enabled = () => !!OPENAI_KEY;

  // ---- small helpers --------------------------------------------------------

  // Reuse existing box endpoints (Linear board/create/comment, needs-attention…)
  // instead of re-implementing them: call ourselves over loopback with the app token.
  async function selfFetch(path, { method = 'GET', body } = {}) {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method,
      headers: { Authorization: `Bearer ${authToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${path} → HTTP ${r.status}`);
    return j;
  }

  function run(cmd, args, { timeoutMs = 30000, env, cwd, input } = {}) {
    return new Promise((resolve) => {
      let out = '', done = false;
      const p = spawn(cmd, args, { cwd: cwd || HOME, env: env || childEnv() });
      const t = setTimeout(() => { if (!done) { try { p.kill('SIGKILL'); } catch {} } }, timeoutMs);
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { out += d; });
      if (input) { try { p.stdin.write(input); } catch {} }
      try { p.stdin.end(); } catch {}
      p.on('error', (e) => { if (!done) { done = true; clearTimeout(t); resolve({ code: -1, out: String(e.message || e) }); } });
      p.on('close', (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code, out }); } });
    });
  }

  function parallelKey() {
    const k = cfg('PARALLEL_API_KEY');
    if (k) return k;
    try {
      const auth = JSON.parse(readFileSync(join(HOME, '.config', 'parallel-web-tools', 'auth.json'), 'utf8'));
      for (const org of Object.values(auth.orgs || {})) {
        for (const [key, val] of Object.entries(org)) {
          if (/key/i.test(key) && typeof val === 'string' && val.length > 12) return val;
        }
      }
    } catch {}
    return '';
  }

  const brainDir = () => {
    const candidates = [cfg('BRAIN_DIR'), '/opt/software-factory/company-brain', join(HOME, 'brain')];
    for (const d of candidates) { try { if (d && existsSync(d)) return d; } catch {} }
    return null;
  };

  // Last real assistant/user text from a session JSONL tail (bigger sibling of tailInfo).
  function lastAssistantText(sessionId, chars = 500) {
    try {
      const file = findSessionFile(sessionId);
      if (!file) return '';
      const st = statSync(file); const len = Math.min(st.size, 256 * 1024);
      const buf = Buffer.alloc(len);
      const f = openSync(file, 'r'); readSync(f, buf, 0, len, st.size - len); closeSync(f);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        let o; try { o = JSON.parse(lines[i]); } catch { continue; }
        if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
          const t = o.message.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
          if (t) return short(t, chars);
        }
      }
    } catch {}
    return '';
  }

  // ---- background tasks + proactive updates ---------------------------------

  let seq = 1;
  const EVENTS = [];       // { seq, ts, kind, title, speak } — polled by the client
  const TASKS = new Map(); // id -> { id, kind, title, status, startedAt, doneAt, summary, file, runId }

  function pushEvent(kind, title, speak) {
    EVENTS.push({ seq: seq++, ts: Date.now(), kind, title, speak: short(speak, 2400) });
    if (EVENTS.length > 200) EVENTS.splice(0, EVENTS.length - 200);
  }
  function saveTasks() {
    try { writeFileSync(TASKS_FILE, JSON.stringify([...TASKS.values()].slice(-100), null, 1)); } catch {}
  }
  function newTask(kind, title, extra = {}) {
    const id = kind.slice(0, 3) + '-' + randomBytes(3).toString('hex');
    const t = { id, kind, title, status: 'running', startedAt: Date.now(), doneAt: 0, summary: '', ...extra };
    TASKS.set(id, t); saveTasks();
    return t;
  }
  function finishTask(t, status, summary, speak) {
    t.status = status; t.doneAt = Date.now(); t.summary = short(summary, 4000); saveTasks();
    pushEvent('task_' + status, t.title, speak);
  }

  // Deep research runs REMOTELY on Parallel; we poll its run id, so an app restart
  // mid-run can pick the poller back up from tasks.json.
  function armResearchPoller(t) {
    const key = parallelKey();
    let ticks = 0;
    const iv = setInterval(async () => {
      ticks++;
      if (ticks > 360) { clearInterval(iv); finishTask(t, 'failed', 'timed out after 2h', `The deep research on "${t.title}" timed out — that almost never happens; worth retrying.`); return; }
      try {
        const r = await fetch(`https://api.parallel.ai/v1/tasks/runs/${t.runId}`, { headers: { 'x-api-key': key } });
        const j = await r.json();
        if (j.status === 'completed') {
          clearInterval(iv);
          const rr = await fetch(`https://api.parallel.ai/v1/tasks/runs/${t.runId}/result`, { headers: { 'x-api-key': key } });
          const jr = await rr.json();
          let content = '';
          const o = jr && jr.output;
          if (o) content = typeof o.content === 'string' ? o.content : JSON.stringify(o.content, null, 2);
          const fname = join(VOICE_DIR, 'research', `${new Date().toISOString().slice(0, 10)}-${t.id}.md`);
          const md = `# ${t.title}\n\n_${t.kind} · Parallel run ${t.runId} · finished ${nowIso()}_\n\n${content}\n`;
          try { writeFileSync(fname, md); } catch {}
          t.file = fname;
          // Full report goes to Jimmy's inbox so it's waiting after the drive.
          emailJimmy(`Research: ${short(t.title, 70)}`, md).catch(() => {});
          finishTask(t, 'done', content, `Deep research finished on: ${t.title}. I emailed you the full report. Highlights: ${short(content, 1500)}`);
        } else if (j.status === 'failed' || j.status === 'cancelled' || j.is_active === false && j.status !== 'completed') {
          clearInterval(iv);
          finishTask(t, 'failed', JSON.stringify(j).slice(0, 400), `The deep research on "${t.title}" failed. I can retry it or run a quick search instead.`);
        }
      } catch { /* transient — keep polling */ }
    }, 20000);
    iv.unref && iv.unref();
  }
  // Re-arm pollers for research that was in flight when the server restarted.
  try {
    for (const t of JSON.parse(readFileSync(TASKS_FILE, 'utf8'))) {
      TASKS.set(t.id, t);
      if (t.status === 'running' && t.kind === 'research' && t.runId) armResearchPoller(t);
    }
  } catch {}

  // Watch a box chat (key) until its current work settles, then announce the outcome.
  function watchSession(key, label) {
    const started = Date.now();
    let sawRunning = false;
    const iv = setInterval(() => {
      let s; try { s = rt(key); } catch { clearInterval(iv); return; }
      const busy = s.running || (s.queue && s.queue.length) || (s.sessionId && RUNNING.has(s.sessionId));
      if (busy) sawRunning = true;
      if (sawRunning && !busy) {
        clearInterval(iv);
        const tail = s.sessionId ? lastAssistantText(s.sessionId, 700) : '';
        pushEvent('agent_done', label, `The agent working on "${label}" just finished its turn.${tail ? ' It reported: ' + tail : ''} You can send it a follow-up or leave it.`);
        return;
      }
      if (Date.now() - started > 50 * 60 * 1000) {
        clearInterval(iv);
        pushEvent('agent_slow', label, `Heads up — the agent on "${label}" has been running for 50 minutes and isn't done yet. Want me to check on it?`);
      }
    }, 8000);
    iv.unref && iv.unref();
  }

  async function emailJimmy(subject, bodyText) {
    const sf = join(HOME, 'development', 'software-factory');
    const env = { ...childEnv(), AGENTMAIL_API_KEY: cfg('AGENTMAIL_API_KEY'), AGENTMAIL_INBOX: cfg('AGENTMAIL_INBOX') };
    const tmp = join(VOICE_DIR, `email-${Date.now()}.txt`);
    writeFileSync(tmp, bodyText);
    const r = await run('node', [join(sf, 'lib', 'agentmail-send.mjs'), '--to', 'icewing1996@gmail.com', '--subject', subject, '--text-file', tmp], { timeoutMs: 45000, env, cwd: sf });
    try { unlinkSync(tmp); } catch {}
    return r;
  }

  // ---- fuzzy session resolution ---------------------------------------------

  function sessionsSnapshot(limit = 60) {
    try { return listSessions({ limit, filter: 'all' }).sessions || []; } catch { return []; }
  }
  function matchSession(query) {
    const q = String(query || '').toLowerCase().trim();
    const all = sessionsSnapshot(80);
    if (!q) return { all, hits: [] };
    if (/^[0-9a-f-]{36}$/.test(q)) return { all, hits: all.filter((s) => s.id === q) };
    const words = q.split(/\s+/).filter(Boolean);
    const scored = all.map((s) => {
      const hay = `${s.title} ${s.preview} ${basename(s.cwd || '')} ${s.agent}`.toLowerCase();
      let score = 0;
      if (hay.includes(q)) score += 5;
      for (const w of words) if (hay.includes(w)) score += 1;
      if (s.status === 'working' || s.status === 'needs_input') score += 0.5; // active ones are likelier targets
      return { s, score };
    }).filter((x) => x.score >= Math.min(2, words.length)).sort((a, b) => b.score - a.score);
    return { all, hits: scored.map((x) => x.s) };
  }
  const sessBrief = (s) => ({
    id: s.id, title: short(s.title, 60), agent: s.agent, status: s.status,
    project: basename(s.cwd || ''), last_activity: ago(s.mtime), preview: short(s.preview, 90),
  });

  function resolveProjectDir(project) {
    if (!project) return defaultCwd();
    const p = String(project).trim().replace(/^~\//, '');
    if (p.startsWith('/')) return existsSync(p) ? p : defaultCwd();
    const roots = [join(HOME, 'development', 'repos'), join(HOME, 'development'), HOME];
    const lc = p.toLowerCase();
    for (const root of roots) { const d = join(root, p); if (existsSync(d)) return d; }
    for (const root of roots) {
      try {
        for (const name of readdirSync(root)) {
          if (name.toLowerCase().includes(lc)) { const d = join(root, name); try { if (statSync(d).isDirectory()) return d; } catch {} }
        }
      } catch {}
    }
    return defaultCwd();
  }

  // ---- tools ------------------------------------------------------------------

  const TOOLS = [
    {
      name: 'get_overview',
      description: 'Snapshot of everything: agent sessions (working / needs input / idle), Linear board counts, open needs-Jimmy decisions, running background tasks. Call when asked "what\'s going on" or at the start of an ops discussion.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const { sessions } = (() => { try { return listSessions({ limit: 30, filter: 'all' }); } catch { return { sessions: [] }; } })();
        const active = sessions.filter((s) => s.status === 'working' || s.status === 'needs_input').slice(0, 8);
        let board = null, needs = null;
        try { board = await selfFetch('/api/linear-board'); } catch {}
        try { needs = await selfFetch('/api/needs-attention'); } catch {}
        const cols = {};
        for (const c of (board && board.columns) || []) cols[c.name] = (c.issues || []).length;
        return {
          working_now: active.map(sessBrief),
          recent_sessions: sessions.slice(0, 8).map(sessBrief),
          board_counts: cols,
          needs_jimmy: ((needs && needs.items) || []).slice(0, 6).map((i) => `${i.status} ${i.title}`),
          background_tasks: [...TASKS.values()].filter((t) => t.status === 'running').map((t) => `${t.kind}: ${t.title} (${ago(t.startedAt)})`),
        };
      },
    },
    {
      name: 'list_sessions',
      description: 'List recent agent chat sessions on the box. filter: all | working | needs_input | live | idle.',
      parameters: { type: 'object', properties: { filter: { type: 'string', enum: ['all', 'working', 'needs_input', 'live', 'idle'] } } },
      handler: async ({ filter = 'all' } = {}) => {
        const { sessions, counts } = listSessions({ limit: 14, filter });
        return { counts, sessions: sessions.map(sessBrief) };
      },
    },
    {
      name: 'check_session',
      description: 'Find one session by name/topic and report what it is doing right now, including its latest reply. Use before sending a message to it.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Words from the session title, project, or topic' } }, required: ['query'] },
      handler: async ({ query }) => {
        const { hits } = matchSession(query);
        if (!hits.length) return { error: `no session matches "${query}"` };
        if (hits.length > 1 && hits[1] && hits[0].title === hits[1].title) hits.length = 1;
        const s = hits[0];
        const others = hits.slice(1, 4).map((x) => short(x.title, 50));
        return {
          match: sessBrief(s),
          latest_reply: lastAssistantText(s.id, 800) || short(s.preview, 200),
          ...(others.length ? { other_candidates: others } : {}),
        };
      },
    },
    {
      name: 'send_to_session',
      description: 'Send a message/instruction into an existing agent session (it resumes and works in the background; you will be told when it finishes its turn). Identify the session by query words.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, message: { type: 'string' } }, required: ['query', 'message'] },
      handler: async ({ query, message }) => {
        const { hits } = matchSession(query);
        if (!hits.length) return { error: `no session matches "${query}"` };
        const ambiguous = hits.length > 1 && hits[0].title !== hits[1].title;
        if (ambiguous && hits[0].status === hits[1].status) {
          return { need_disambiguation: hits.slice(0, 3).map(sessBrief) };
        }
        const s = hits[0];
        enqueue(s.id, { text: message, mode: 'normal', agent: s.agent || 'claude', cwd: s.cwd });
        watchSession(s.id, s.title);
        return { sent: true, to: sessBrief(s) };
      },
    },
    {
      name: 'start_agent',
      description: 'Start a NEW agent session on the box with a task. agent: claude (default, full harness) or codex (good for mechanical coding, runs on OpenAI credits). Runs in the background; you are told when the first turn completes. Give a descriptive short title.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Full instruction for the agent — context, what to do, what done looks like' },
          project: { type: 'string', description: 'Repo/dir name, e.g. mindbill, software-factory, forta. Omit for the default workspace.' },
          agent: { type: 'string', enum: ['claude', 'codex'] },
          title: { type: 'string', description: 'Short human title, e.g. "Fix invoice rounding"' },
        },
        required: ['task'],
      },
      handler: async ({ task, project, agent = 'claude', title }) => {
        const key = 'new-' + randomBytes(4).toString('hex');
        const cwd = resolveProjectDir(project);
        const t = title || short(task, 48);
        enqueue(key, { text: task, mode: 'normal', agent, cwd, title: t });
        watchSession(key, t);
        return { started: true, title: t, agent, project_dir: cwd, note: 'running in background; completion will be announced' };
      },
    },
    {
      name: 'delegate_ticket',
      description: 'Put a fresh agent on an existing Linear ticket (e.g. "INC-950"): the agent claims it, works it per repo conventions, and posts a PR. Announced when its first pass completes.',
      parameters: { type: 'object', properties: { ticket: { type: 'string', description: 'Issue id like INC-950' }, extra: { type: 'string', description: 'Optional extra guidance' }, agent: { type: 'string', enum: ['claude', 'codex'] } }, required: ['ticket'] },
      handler: async ({ ticket, extra = '', agent = 'claude' }) => {
        const id = String(ticket).toUpperCase().replace(/[^A-Z0-9-]/g, '');
        let detail = null;
        try { detail = await selfFetch(`/api/linear/${id}`); } catch {}
        if (!detail) return { error: `ticket ${id} not found` };
        const title = `${id}: ${short(detail.title, 60)}`;
        const task = `Work the Linear issue ${id}: "${detail.title}".\n\nClaim it (move to In Progress), read the full ticket + comments via the Linear API (LINEAR_API_KEY in the env), do the work following the repo's conventions (isolated git worktree, PR, post the PR link as a comment on ${id}), then set it to In Review.${extra ? `\n\nExtra guidance from ${ownerName} (dictated while driving): ${extra}` : ''}`;
        const key = 'new-' + randomBytes(4).toString('hex');
        enqueue(key, { text: task, mode: 'normal', agent, cwd: defaultCwd(), title });
        watchSession(key, title);
        selfFetch(`/api/linear/${id}/delegation`, { method: 'POST', body: { sessionTitle: title, agent, kind: 'new' } }).catch(() => {});
        return { delegated: id, issue_title: detail.title, agent };
      },
    },
    {
      name: 'linear_board',
      description: 'Current Linear board: columns with their issues (In Progress and Todo first).',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const b = await selfFetch('/api/linear-board');
        const out = {};
        for (const c of (b.columns || [])) {
          out[c.name] = (c.issues || []).slice(0, 10).map((i) => `${i.id} ${short(i.title, 70)}${i.labels && i.labels.length ? ' [' + i.labels.join(',') + ']' : ''}`);
        }
        return out;
      },
    },
    {
      name: 'linear_create',
      description: 'Create a Linear issue (lands in Todo). Use for real to-dos decided in conversation. needs_jimmy=true only for decisions ONLY Jimmy-the-human can make.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          urgent: { type: 'boolean' },
          needs_jimmy: { type: 'boolean' },
        },
        required: ['title'],
      },
      handler: async ({ title, description = '', urgent = false, needs_jimmy = false }) => {
        const body = { title, description: description + `\n\n_Filed by voice assistant while ${ownerName} was driving, ${nowIso().slice(0, 16)}Z_` };
        if (urgent) body.priority = 2;
        if (needs_jimmy) {
          try {
            const meta = await selfFetch('/api/linear-meta');
            const lbl = (meta.labels || []).find((l) => l.name === (cfg('NEEDS_LABEL') || 'needs-jimmy'));
            if (lbl) body.labelIds = [lbl.id];
          } catch {}
        }
        const r = await selfFetch('/api/linear/issue', { method: 'POST', body });
        return { created: r.identifier, url: r.url };
      },
    },
    {
      name: 'linear_update',
      description: 'Comment on a Linear issue and/or move its state (todo | in_progress | in_review | done | canceled).',
      parameters: { type: 'object', properties: { ticket: { type: 'string' }, comment: { type: 'string' }, state: { type: 'string', enum: ['todo', 'in_progress', 'in_review', 'done', 'canceled'] } }, required: ['ticket'] },
      handler: async ({ ticket, comment, state }) => {
        const id = String(ticket).toUpperCase().replace(/[^A-Z0-9-]/g, '');
        const out = { ticket: id };
        if (comment) { await selfFetch(`/api/linear/${id}/comment`, { method: 'POST', body: { body: comment + '\n\n_(via voice)_' } }); out.commented = true; }
        if (state) {
          const meta = await selfFetch('/api/linear-meta');
          const want = { todo: 'unstarted', in_progress: 'started', in_review: 'started', done: 'completed', canceled: 'canceled' }[state];
          const named = (meta.states || []).find((s) => s.name.toLowerCase().replace(/\s+/g, '_') === state);
          const typed = (meta.states || []).filter((s) => s.type === want);
          const st = named || (state === 'in_review' ? typed[typed.length - 1] : typed[0]);
          if (!st) return { ...out, error: `no workflow state for ${state}` };
          const r = await selfFetch(`/api/linear/${id}/state`, { method: 'POST', body: { stateId: st.id } });
          out.state = r.state;
        }
        return out;
      },
    },
    {
      name: 'needs_jimmy',
      description: 'Open needs-Jimmy items — decisions only he can make. Read these out when he asks "what needs me".',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const n = await selfFetch('/api/needs-attention');
        return { open: n.open, items: (n.items || []).slice(0, 8).map((i) => ({ id: i.identifier, title: i.title, ask: short(i.ask, 200) })) };
      },
    },
    {
      name: 'web_search',
      description: 'Fast web search (a few seconds) for current facts, people, companies, news. Use freely. For big open-ended questions use deep_research instead.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, objective: { type: 'string', description: 'Optional: what you are really trying to find out' } }, required: ['query'] },
      handler: async ({ query, objective }) => {
        const key = parallelKey();
        if (!key) return { error: 'no Parallel API key configured' };
        const r = await fetch('https://api.parallel.ai/v1beta/search', {
          method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ objective: objective || query, search_queries: [query], processor: 'base', max_results: 6, max_chars_per_result: 900 }),
        });
        const j = await r.json();
        if (!r.ok) return { error: JSON.stringify(j).slice(0, 200) };
        return {
          results: (j.results || []).slice(0, 6).map((x) => ({ title: short(x.title, 90), url: x.url, excerpt: short((x.excerpts || []).join(' '), 350) })),
        };
      },
    },
    {
      name: 'deep_research',
      description: 'Kick off REAL research (market sizing, competitor analysis, prospect lists) that runs 5–25 minutes in the background on live web data. Result is announced when ready and the full report is emailed to Jimmy. depth: standard (~5-10 min) | deep (~15-25 min, most thorough).',
      parameters: { type: 'object', properties: { question: { type: 'string', description: 'The research question, with all context worth including' }, depth: { type: 'string', enum: ['standard', 'deep'] } }, required: ['question'] },
      handler: async ({ question, depth = 'standard' }) => {
        const key = parallelKey();
        if (!key) return { error: 'no Parallel API key configured' };
        const processor = depth === 'deep' ? 'pro' : 'core';
        const input = `${question}\n\nContext: this research is for the founder of MindBill (mindbill.org), a California workers'-comp medical-legal billing SaaS competing with daisyBill. Anchor customer: a QME billing company doing ~3,000 bills/month. Be specific and quantitative; name names (companies, people, sources); prefer recent data.`;
        const r = await fetch('https://api.parallel.ai/v1/tasks/runs', {
          method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ input, processor }),
        });
        const j = await r.json();
        if (!r.ok || !j.run_id) return { error: JSON.stringify(j).slice(0, 200) };
        const t = newTask('research', short(question, 100), { runId: j.run_id, processor });
        armResearchPoller(t);
        return { started: true, task_id: t.id, eta_minutes: depth === 'deep' ? '15-25' : '5-10', note: 'will be announced when done; full report emailed' };
      },
    },
    {
      name: 'check_tasks',
      description: 'Status of background tasks (deep research, delegated agents).',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({
        running: [...TASKS.values()].filter((t) => t.status === 'running').map((t) => `${t.kind} "${t.title}" started ${ago(t.startedAt)}`),
        recent: [...TASKS.values()].filter((t) => t.status !== 'running').slice(-5).map((t) => `${t.status}: ${t.title} — ${short(t.summary, 120)}`),
      }),
    },
    {
      name: 'brain_search',
      description: 'Search the company brain (meetings, deals, people, companies, learnings) — everything the company knows about its own history. Use for "what do we know about X / what did Y say".',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      handler: async ({ query }) => {
        const dir = brainDir();
        if (!dir) return { error: 'no company brain on this box' };
        const r = await run('rg', ['-i', '-m', '2', '--max-count', '2', '-g', '*.md', '--max-filesize', '2M', '-C', '1', '--heading', '-n', query, dir], { timeoutMs: 15000 });
        const lines = (r.out || '').split('\n').slice(0, 80);
        // group by file header lines rg prints in --heading mode
        const out = []; let cur = null;
        for (const ln of lines) {
          if (!ln.trim()) continue;
          if (ln.startsWith(dir)) { if (out.length >= 8) break; cur = { file: ln.replace(dir + '/', ''), snippets: [] }; out.push(cur); }
          else if (cur && cur.snippets.length < 4) cur.snippets.push(short(ln.replace(/^\d+[-:]/, ''), 160));
        }
        return out.length ? { matches: out } : { matches: [], note: 'nothing found — try different words' };
      },
    },
    {
      name: 'brain_read',
      description: 'Read one file from the company brain (path as returned by brain_search).',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: async ({ path }) => {
        const dir = brainDir();
        if (!dir) return { error: 'no company brain' };
        const clean = String(path).replace(/\.\./g, '');
        const full = clean.startsWith('/') ? clean : join(dir, clean);
        if (!full.startsWith(dir)) return { error: 'path outside brain' };
        try { return { path: clean, content: short(readFileSync(full, 'utf8'), 6000) }; }
        catch { return { error: 'cannot read ' + clean }; }
      },
    },
    {
      name: 'get_briefing',
      description: `The prepared drive briefing: market research, prospect targets, conference + Monaco meeting prep, strategy questions. section: pass a heading fragment to read one section, omit for the table of contents. Offer this when ${'the user'} asks what to work on or discuss.`,
      parameters: { type: 'object', properties: { section: { type: 'string' } } },
      handler: async ({ section } = {}) => {
        if (!existsSync(BRIEFING_FILE)) return { error: 'no briefing prepared yet' };
        const md = readFileSync(BRIEFING_FILE, 'utf8');
        const heads = md.split('\n').filter((l) => /^##\s/.test(l)).map((l) => l.replace(/^##\s*/, ''));
        if (!section) return { sections: heads, intro: short(md.split(/\n## /)[0], 900) };
        const lc = section.toLowerCase();
        const idx = heads.findIndex((h) => h.toLowerCase().includes(lc));
        if (idx < 0) return { sections: heads, error: `no section matching "${section}"` };
        const body = md.split(/\n## /)[idx + 1] || '';
        return { section: heads[idx], content: short(body, 7000) };
      },
    },
    {
      name: 'take_note',
      description: 'Save a note (idea, decision, follow-up, journal thought) to the drive notes. Do this proactively whenever something worth keeping is said; confirm briefly.',
      parameters: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['idea', 'decision', 'todo', 'thought'] } }, required: ['text'] },
      handler: async ({ text, kind = 'thought' }) => {
        const f = join(VOICE_DIR, 'notes', `notes-${new Date().toISOString().slice(0, 10)}.md`);
        const stamp = new Date().toISOString().slice(11, 16);
        appendFileSync(f, `- **${stamp}Z** _[${kind}]_ ${text.replace(/\n/g, ' ')}\n`);
        return { saved: true, kind };
      },
    },
    {
      name: 'read_notes',
      description: "Read back today's saved notes (or a given date YYYY-MM-DD).",
      parameters: { type: 'object', properties: { date: { type: 'string' } } },
      handler: async ({ date } = {}) => {
        const d = date || new Date().toISOString().slice(0, 10);
        const f = join(VOICE_DIR, 'notes', `notes-${d}.md`);
        try { return { date: d, notes: short(readFileSync(f, 'utf8'), 5000) }; }
        catch { return { date: d, notes: '', note: 'no notes that day' }; }
      },
    },
    {
      name: 'email_jimmy',
      description: "Email Jimmy's own inbox (safe, internal). Use for anything longer than a couple sentences: summaries, research, lists, links — so it's waiting for him after the drive.",
      parameters: { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string', description: 'Plain text or markdown' } }, required: ['subject', 'body'] },
      handler: async ({ subject, body }) => {
        const r = await emailJimmy(subject, body);
        return r.code === 0 ? { sent: true } : { error: short(r.out, 300) };
      },
    },
    {
      name: 'calendar',
      description: "Jimmy's upcoming calendar events (personal + work accounts).",
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const g = join(HOME, '.local', 'bin', 'google');
        const [me, work] = await Promise.all([
          run(g, ['me', 'cal', 'list', '10'], { timeoutMs: 20000 }),
          run(g, ['work', 'cal', 'list', '10'], { timeoutMs: 20000 }),
        ]);
        return { personal: short(me.out, 1400), work: short(work.out, 1400) };
      },
    },
  ];

  const toolSchemas = TOOLS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
  const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

  // ---- instructions -----------------------------------------------------------

  function staticPersona() {
    return `You are "Box" — ${ownerName}'s realtime voice copilot, the voice layer of his agent-fleet control app. You run on his always-on dev server and you can actually DO things through tools: see and steer coding-agent sessions (Claude Code, Codex), start new agents, drive the Linear board, run web search and deep research, search the company brain, take notes, send email, read his calendar.

WHO YOU'RE TALKING TO: Jimmy Wei — founder/CEO of IncidentFox (YC W26), running solo. The business is MindBill (mindbill.org): a California workers'-comp medical-legal billing SaaS competing head-on with daisyBill. Anchor customer: Spectrum Medical Evaluators (~200 doctors, ~3,000 bills/month, signed June 11 at $3/bill with a $999/month minimum). Strategy: win more billing companies off daisyBill — a workers'-comp conference and a Monaco outbound-sales meeting are imminent. Side line (lower priority): psychiatry automation — Rise4 voice VOB, Bay Area Psychiatric Spravato forms. He is usually DRIVING (hands-free) when he talks to you.

VOICE STYLE — this is spoken conversation, not chat:
- Default to short: one to three sentences. Go deep only when he asks or the moment clearly calls for it.
- Natural spoken English. No markdown, no bullet lists, no reading URLs aloud (say "I'll email the link" or "it's in your notes").
- Round numbers when speaking. Say "about three thousand bills a month", not "3,012".
- Never read out more than three items — summarize and offer the rest.
- Be a sharp thought partner, not a yes-man: have opinions, push back with reasons, quantify. He explicitly wants this.
- Don't claim knowledge of live state you haven't checked this session — call a tool first.

DOING WORK — the point of you is execution, not just talk:
- Long tasks run in the background while you keep talking: start_agent (coding/repo work), delegate_ticket (put an agent on a Linear issue), deep_research (real research, minutes), send_to_session (steer an agent already running).
- When a [TASK UPDATE] system message arrives, work it into conversation naturally — lead with what finished and the one-line result, offer detail.
- take_note proactively whenever a real idea, decision, or follow-up comes up — then say "noted" briefly. At the end of a good discussion, offer to email a summary (email_jimmy) and create Linear issues for the action items (linear_create).
- Quick facts: web_search (seconds). Real questions: deep_research (background). Company history/deals/people: brain_search first.
- get_briefing holds his prepared drive agenda: market numbers, daisyBill displacement targets, conference + Monaco meeting prep, strategy questions. If he asks "what should we talk about", or wants the plan, start there.
- If a tool errors, say so plainly and move on. Never invent results.

DRIVING SAFETY: keep him hands-free — never ask him to look at the screen, read, or type. Anything visual goes to email or notes.

MODES to recognize and flow between:
1. Ops — "what's going on / check X / start Y": tools, crisp reports.
2. Research — market/industry questions: search, research, then DISCUSS the findings like a smart colleague.
3. Strategy — where to take the company, pricing, path to $1M ARR, personal decisions. Ask one sharp question at a time. Use real numbers from the briefing or research. Capture decisions in notes. The goal: he leaves the drive with clarity and queued-up execution.`;
  }

  async function liveSnapshot() {
    const parts = [];
    parts.push(`Now: ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })} Pacific.`);
    try {
      const { sessions } = listSessions({ limit: 25, filter: 'all' });
      const act = sessions.filter((s) => s.status === 'working' || s.status === 'needs_input').slice(0, 8);
      const rec = sessions.filter((s) => !act.includes(s)).slice(0, 6);
      if (act.length) parts.push('Agents active right now: ' + act.map((s) => `"${short(s.title, 45)}" (${s.status}${s.agent !== 'claude' ? ', ' + s.agent : ''})`).join('; ') + '.');
      if (rec.length) parts.push('Recent sessions: ' + rec.map((s) => `"${short(s.title, 40)}"`).join(', ') + '.');
    } catch {}
    try {
      const b = await selfFetch('/api/linear-board');
      const prog = ((b.columns || []).find((c) => /progress/i.test(c.name)) || {}).issues || [];
      const todo = ((b.columns || []).find((c) => /todo/i.test(c.name)) || {}).issues || [];
      if (prog.length) parts.push('Linear in progress: ' + prog.slice(0, 6).map((i) => `${i.id} ${short(i.title, 50)}`).join('; ') + '.');
      if (todo.length) parts.push(`Todo column has ${todo.length} items.`);
    } catch {}
    try {
      const n = await selfFetch('/api/needs-attention');
      if (n.open) parts.push(`Open needs-Jimmy decisions (${n.open}): ` + (n.items || []).slice(0, 4).map((i) => short(i.title, 60)).join('; ') + '.');
    } catch {}
    const running = [...TASKS.values()].filter((t) => t.status === 'running');
    if (running.length) parts.push('Background tasks running: ' + running.map((t) => `${t.kind} "${short(t.title, 50)}"`).join('; ') + '.');
    try {
      if (existsSync(BRIEFING_FILE)) {
        const heads = readFileSync(BRIEFING_FILE, 'utf8').split('\n').filter((l) => /^##\s/.test(l)).map((l) => l.replace(/^##\s*/, ''));
        if (heads.length) parts.push('Drive briefing prepared, sections: ' + heads.join(' · ') + '. (get_briefing)');
      }
    } catch {}
    return parts.join('\n');
  }

  function transcriptPath(vsid) { return join(VOICE_DIR, 'transcripts', `${String(vsid).replace(/[^\w.-]/g, '_')}.jsonl`); }
  function recentTranscript(vsid, maxLines = 36) {
    try {
      const lines = readFileSync(transcriptPath(vsid), 'utf8').trim().split('\n').slice(-maxLines);
      return lines.map((l) => {
        try {
          const o = JSON.parse(l);
          if (o.kind === 'user') return `Jimmy: ${short(o.text, 260)}`;
          if (o.kind === 'assistant') return `You: ${short(o.text, 260)}`;
          if (o.kind === 'tool') return `(you called ${o.name})`;
          return null;
        } catch { return null; }
      }).filter(Boolean).join('\n');
    } catch { return ''; }
  }

  // ---- routes -------------------------------------------------------------------

  app.post('/api/voice/token', requireAuth, async (req, res) => {
    if (!enabled()) return res.status(500).json({ error: 'OPENAI_API_KEY not configured on the box' });
    try {
      const reconnectVsid = (req.body && req.body.vsid) || null;
      const vsid = reconnectVsid || `${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`;
      let instructions = staticPersona() + '\n\nCURRENT CONTEXT SNAPSHOT:\n' + await liveSnapshot();
      if (reconnectVsid) {
        const t = recentTranscript(vsid);
        if (t) instructions += `\n\nRECONNECT: the previous realtime connection dropped (cell coverage or the 60-minute session cap) and this is a seamless continuation of the SAME conversation. Do NOT greet again or recap unless asked — just pick up where it left off. Recent turns:\n${t}`;
      }
      const sessionCfg = {
        type: 'realtime',
        model: MODEL,
        instructions,
        tools: toolSchemas,
        tool_choice: 'auto',
        output_modalities: ['audio'],
        audio: {
          input: {
            transcription: { model: 'gpt-realtime-whisper', language: 'en' },
            turn_detection: cfg('VOICE_ASSISTANT_VAD', 'semantic') === 'server'
              ? { type: 'server_vad', threshold: 0.6, silence_duration_ms: 700, create_response: true, interrupt_response: true }
              : { type: 'semantic_vad', eagerness: 'auto', create_response: true, interrupt_response: true },
          },
          output: { voice: VOICE, speed: 1.0 },
        },
      };
      const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 600 }, session: sessionCfg }),
      });
      const j = await r.json();
      if (!r.ok || !j.value) return res.status(502).json({ error: (j.error && j.error.message) || 'client_secret mint failed' });
      appendFileSync(transcriptPath(vsid), JSON.stringify({ ts: Date.now(), kind: 'meta', text: reconnectVsid ? 'reconnected' : 'session started', model: MODEL }) + '\n');
      res.json({ clientSecret: j.value, expiresAt: j.expires_at, model: MODEL, voice: VOICE, vsid, cursor: seq - 1 });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  app.post('/api/voice/tool', requireAuth, async (req, res) => {
    const { name, args, call_id, vsid } = req.body || {};
    const tool = toolByName.get(String(name || ''));
    if (!tool) return res.json({ output: JSON.stringify({ error: `unknown tool ${name}` }) });
    let parsed = args;
    if (typeof args === 'string') { try { parsed = JSON.parse(args || '{}'); } catch { parsed = {}; } }
    const t0 = Date.now();
    let result;
    try { result = await tool.handler(parsed || {}); }
    catch (e) { result = { error: String((e && e.message) || e).slice(0, 400) }; }
    try { if (vsid) appendFileSync(transcriptPath(vsid), JSON.stringify({ ts: Date.now(), kind: 'tool', name, args: parsed, ms: Date.now() - t0, ok: !(result && result.error) }) + '\n'); } catch {}
    res.json({ call_id, output: JSON.stringify(result) });
  });

  app.get('/api/voice/updates', requireAuth, (req, res) => {
    const cursor = Number(req.query.cursor || 0);
    const events = EVENTS.filter((e) => e.seq > cursor);
    res.json({ cursor: seq - 1, events });
  });

  app.post('/api/voice/event', requireAuth, (req, res) => {
    const { vsid, events } = req.body || {};
    if (vsid && Array.isArray(events)) {
      try {
        const lines = events.slice(0, 50).map((e) => JSON.stringify({ ts: e.ts || Date.now(), kind: String(e.kind || 'meta').slice(0, 12), text: short(e.text, 2000), name: e.name ? String(e.name).slice(0, 40) : undefined }));
        if (lines.length) appendFileSync(transcriptPath(vsid), lines.join('\n') + '\n');
      } catch {}
    }
    res.json({ ok: true });
  });

  app.get('/api/voice/status', requireAuth, (req, res) => {
    res.json({
      enabled: enabled(), model: MODEL, voice: VOICE,
      briefing: existsSync(BRIEFING_FILE),
      tasks: [...TASKS.values()].slice(-20),
      tools: TOOLS.map((t) => t.name),
    });
  });

  console.log(`[box] voice assistant: ${enabled() ? `ready (${MODEL}, voice=${VOICE}, ${TOOLS.length} tools)` : 'disabled (no OPENAI_API_KEY)'}`);
  return { enabled };
}
