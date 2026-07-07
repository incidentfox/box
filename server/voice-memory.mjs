// Voice session memory — cross-session recall for the realtime voice copilot.
//
// The realtime assistant already keeps a per-session transcript (for seamless
// reconnects mid-drive). This module layers *durable, cross-session* memory on top:
// it indexes finished sessions into compact records, retrieves the relevant ones to
// preload into a future session's instructions, optionally stores the raw audio (for
// re-transcription when a transcript comes back garbled), and enforces the privacy
// controls that make all of the above safe — consent gating, retention/purge, and an
// append-only audit log.
//
// Design constraints (deliberate):
//   • Privacy-safe defaults. Nothing is remembered until the owner grants consent;
//     audio is a SEPARATE, off-by-default opt-in (it's the most sensitive artifact).
//   • Single-owner, box-local. This box serves exactly one person (token-gated), so
//     "scoped retrieval" means: only this box's own memory dir, capped in count and
//     size, never audio bytes — just short text summaries.
//   • No PHI/verbatim text in the audit log — only counts, ids, and config values.
//   • Dependency-free and storage-agnostic: callers hand in transcript *turns*; the
//     module owns the memory records, audio files, config, retention, and audit.
//
// State layout under `dir` (default <STATE_DIR>/voice-assistant/memory):
//   config.json            — consent + retention settings
//   sessions/<vsid>.json   — one compact memory record per indexed session
//   audio/<vsid>/<clip>    — stored audio clips (only when audio opt-in is on)
//   audit.jsonl            — append-only privacy audit trail

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

// Privacy-safe defaults: memory OFF until consent; audio a separate opt-in.
const DEFAULTS = {
  version: 1,
  consent: 'unset',        // unset | granted | denied
  consentAt: null,
  consentActor: null,
  storeTranscripts: true,  // effective only while consent === 'granted'
  storeAudio: false,       // extra-sensitive → separate opt-in, off by default
  retrievalEnabled: true,  // preload prior context into new sessions
  retentionDays: 30,       // everything older is purged
  maxRetrievalSessions: 4, // cap what a new session preloads
  maxAudioClipsPerSession: 60,
};

const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt;
};
const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const cut = (s, n) => { s = collapse(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const safeName = (v) => String(v || '').replace(/[^\w.-]/g, '_').slice(0, 120);

// Small, deliberately-boring stopword list so keyword extraction favours real topics.
const STOP = new Set(('a an the and or but if then of to in on for with at by from as is are was were be been ' +
  'been being do does did done have has had will would can could should may might must i you he she it we they ' +
  'me him her us them my your his its our their this that these those there here what which who whom whose how ' +
  'when where why not no yes so just like get got go going about into out up down over under again more most ' +
  'some any all one two okay ok yeah yep nope uh um hmm gonna wanna kind sort really very want need lets let ' +
  'know think thing things stuff say said tell told talk right good great sure thanks thank please').split(' '));

const tokenize = (s) => collapse(s).toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/)
  .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
  .filter((w) => w.length >= 3 && !STOP.has(w));

export function createVoiceMemory({ dir, transcriptsDir = null, now = () => Date.now(), transcribe = null } = {}) {
  if (!dir) throw new Error('voice-memory: dir is required');
  const SESSIONS_DIR = join(dir, 'sessions');
  const AUDIO_DIR = join(dir, 'audio');
  const CONFIG_FILE = join(dir, 'config.json');
  const AUDIT_FILE = join(dir, 'audit.jsonl');
  for (const d of [dir, SESSIONS_DIR, AUDIO_DIR]) { try { mkdirSync(d, { recursive: true }); } catch {} }

  // ---- config / consent -----------------------------------------------------

  function loadConfig() {
    let c = {};
    try { c = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch {}
    return { ...DEFAULTS, ...c };
  }
  function writeConfig(c) {
    const tmp = CONFIG_FILE + '.' + randomBytes(3).toString('hex') + '.tmp';
    try { writeFileSync(tmp, JSON.stringify(c, null, 2)); renameSync(tmp, CONFIG_FILE); }
    catch { try { unlinkSync(tmp); } catch {} }
  }

  const getConfig = () => loadConfig();
  const memoryOn = () => { const c = loadConfig(); return c.consent === 'granted' && c.storeTranscripts !== false; };
  const audioOn = () => { const c = loadConfig(); return c.consent === 'granted' && c.storeAudio === true; };
  const retrievalOn = () => { const c = loadConfig(); return c.consent === 'granted' && c.retrievalEnabled !== false; };

  function setConsent(state, actor = 'unknown') {
    const c = loadConfig();
    const next = ['granted', 'denied', 'unset'].includes(state) ? state : c.consent;
    c.consent = next;
    if (next === 'granted') { c.consentAt = now(); c.consentActor = String(actor).slice(0, 40); }
    if (next === 'denied' || next === 'unset') { c.consentActor = String(actor).slice(0, 40); }
    writeConfig(c);
    audit('consent', { state: next, actor });
    return c;
  }

  const WRITABLE = {
    storeTranscripts: (v) => v === true || v === false ? v : undefined,
    storeAudio: (v) => v === true || v === false ? v : undefined,
    retrievalEnabled: (v) => v === true || v === false ? v : undefined,
    retentionDays: (v) => clamp(v, 1, 365, undefined),
    maxRetrievalSessions: (v) => clamp(v, 1, 10, undefined),
    maxAudioClipsPerSession: (v) => clamp(v, 1, 500, undefined),
  };
  function updateConfig(patch = {}, actor = 'unknown') {
    const c = loadConfig();
    const changed = {};
    for (const [k, coerce] of Object.entries(WRITABLE)) {
      if (patch[k] === undefined) continue;
      const v = coerce(patch[k]);
      if (v !== undefined && v !== c[k]) { c[k] = v; changed[k] = v; }
    }
    if (Object.keys(changed).length) { writeConfig(c); audit('config', { changed, actor }); }
    return c;
  }

  // ---- audit (append-only; NO verbatim text, only counts/ids/config) ---------

  function audit(event, fields = {}) {
    try { appendFileSync(AUDIT_FILE, JSON.stringify({ ts: now(), event, ...fields }) + '\n'); } catch {}
  }
  function readAudit(limit = 50) {
    try {
      const lines = readFileSync(AUDIT_FILE, 'utf8').trim().split('\n');
      return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  // ---- indexing -------------------------------------------------------------

  const recordPath = (vsid) => join(SESSIONS_DIR, safeName(vsid) + '.json');

  function readRecord(vsid) {
    try { return JSON.parse(readFileSync(recordPath(vsid), 'utf8')); } catch { return null; }
  }
  // True when this vsid has no record yet, or its transcript changed since we indexed it.
  function needsIndex(vsid, sourceMtime = 0) {
    const rec = readRecord(vsid);
    if (!rec) return true;
    return sourceMtime > (rec.indexedAt || 0);
  }

  // Build a compact, retrieval-friendly record from a session's turns. We deliberately
  // do NOT store the full verbatim transcript here — the raw text lives (under retention)
  // in transcriptsDir; the memory record is a lean summary so retrieval stays cheap and
  // preloading a few of them can't blow the instruction budget.
  function buildRecord(vsid, turns, meta = {}) {
    const clean = (turns || [])
      .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && collapse(t.text))
      .map((t) => ({ role: t.role, text: collapse(t.text), ts: Number(t.ts) || 0 }));
    const users = clean.filter((t) => t.role === 'user');
    const tsList = clean.map((t) => t.ts).filter(Boolean);
    const startedAt = meta.startedAt || (tsList.length ? Math.min(...tsList) : now());
    const endedAt = meta.endedAt || (tsList.length ? Math.max(...tsList) : now());

    // keyword frequency over the whole conversation
    const freq = new Map();
    for (const t of clean) for (const w of tokenize(t.text)) freq.set(w, (freq.get(w) || 0) + 1);
    const keywords = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([w]) => w);

    // extractive summary: the opening ask + the most substantive later user turns
    const decisionRe = /\b(decide|decided|let'?s|we should|action item|to-?do|remember|remind|follow up|plan to|going to|next step)\b/i;
    const decisions = users.filter((t) => decisionRe.test(t.text)).map((t) => cut(t.text, 180)).slice(0, 6);
    const notable = [...users].sort((a, b) => b.text.length - a.text.length).slice(0, 4).map((t) => t.text);
    const summaryParts = [];
    if (users[0]) summaryParts.push(cut(users[0].text, 200));
    for (const n of notable) { if (summaryParts.length >= 5) break; const c = cut(n, 160); if (!summaryParts.includes(c)) summaryParts.push(c); }

    return {
      vsid: String(vsid),
      startedAt, endedAt,
      turnCount: clean.length,
      userTurns: users.length,
      summary: cut(summaryParts.join(' · '), 700),
      topics: keywords.slice(0, 8),
      keywords,
      decisions,
      indexedAt: now(),
      source: meta.source || 'transcript',
    };
  }

  // Index one session. No-op (returns {skipped}) unless consent+transcripts are on.
  function indexSession(vsid, turns, meta = {}) {
    if (!memoryOn()) return { skipped: 'consent' };
    const clean = (turns || []).filter((t) => t && collapse(t.text));
    if (!clean.length) return { skipped: 'empty' };
    const rec = buildRecord(vsid, turns, meta);
    if (rec.turnCount < 2) return { skipped: 'too_short' };
    const tmp = recordPath(vsid) + '.tmp';
    try { writeFileSync(tmp, JSON.stringify(rec)); renameSync(tmp, recordPath(vsid)); }
    catch { try { unlinkSync(tmp); } catch {} return { skipped: 'write_failed' }; }
    audit('index', { vsid: String(vsid), turns: rec.turnCount, keywords: rec.keywords.length, chars: rec.summary.length });
    return { indexed: true, vsid: String(vsid), turnCount: rec.turnCount };
  }

  function allRecords() {
    let files = [];
    try { files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch {}
    return files.map((f) => { try { return JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8')); } catch { return null; } }).filter(Boolean);
  }

  // ---- retrieval (scoped + capped + text-only) ------------------------------

  // Return the most relevant prior-session records, scored by keyword overlap with the
  // query plus a recency nudge. Always: within the retention window, excluding the
  // current session, capped to maxRetrievalSessions. Never returns audio.
  function retrieve({ query = '', excludeVsid = null, limit = null } = {}) {
    if (!retrievalOn()) return [];
    const c = loadConfig();
    const cutoff = now() - c.retentionDays * DAY_MS;
    const cap = clamp(limit ?? c.maxRetrievalSessions, 1, 10, DEFAULTS.maxRetrievalSessions);
    const qTerms = new Set(tokenize(query));
    const recent = allRecords().filter((r) => r.vsid !== excludeVsid && (r.endedAt || 0) >= cutoff);

    const scored = recent.map((r) => {
      let score = 0;
      const kw = new Set(r.keywords || []);
      for (const t of qTerms) if (kw.has(t)) score += 2;
      // light substring credit so a query term inside the summary still counts
      if (qTerms.size) { const sl = (r.summary || '').toLowerCase(); for (const t of qTerms) if (sl.includes(t)) score += 1; }
      const ageDays = Math.max(0, (now() - (r.endedAt || 0)) / DAY_MS);
      const recency = Math.max(0, 1.5 - ageDays / Math.max(1, c.retentionDays) * 1.5); // 0..1.5
      return { r, score: score + recency };
    });
    // With no query terms we still surface the most recent sessions (recency-only) so a
    // fresh drive gets "here's where we left off" context.
    const ranked = scored
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.r.endedAt || 0) - (a.r.endedAt || 0))
      .slice(0, cap)
      .map((x) => x.r);
    if (ranked.length) audit('retrieve', { count: ranked.length, vsids: ranked.map((r) => r.vsid), query_terms: qTerms.size });
    return ranked;
  }

  // Compact text block to fold into a new session's instructions. Bounded length; text
  // only. Returns '' when nothing to preload.
  function renderPreload(records, maxChars = 1800) {
    if (!records || !records.length) return '';
    const lines = ['MEMORY FROM PRIOR VOICE SESSIONS (recall these only if relevant; do not recap them unprompted):'];
    for (const r of records) {
      const when = new Date(r.endedAt || r.startedAt || now()).toISOString().slice(0, 10);
      let line = `- [${when}] ${r.summary || (r.topics || []).join(', ')}`;
      if (r.decisions && r.decisions.length) line += ` — noted: ${r.decisions.slice(0, 2).join('; ')}`;
      lines.push(cut(line, 400));
    }
    return cut(lines.join('\n'), maxChars);
  }

  // ---- audio store (opt-in) + re-transcription ------------------------------

  const extForMime = (m = '') =>
    /wav/.test(m) ? '.wav' : /mp4|m4a|aac/.test(m) ? '.m4a' : /ogg|opus/.test(m) ? '.ogg' :
    /mpeg|mp3/.test(m) ? '.mp3' : '.webm';
  const mimeForClip = (name = '') =>
    name.endsWith('.wav') ? 'audio/wav' : name.endsWith('.m4a') ? 'audio/mp4' :
    name.endsWith('.ogg') ? 'audio/ogg' : name.endsWith('.mp3') ? 'audio/mpeg' : 'audio/webm';
  const clipDir = (vsid) => join(AUDIO_DIR, safeName(vsid));

  function pruneClips(vsid) {
    const c = loadConfig();
    let files = [];
    try {
      files = readdirSync(clipDir(vsid)).map((f) => ({ f, t: statSync(join(clipDir(vsid), f)).mtimeMs })).sort((a, b) => b.t - a.t);
    } catch { return; }
    for (const { f } of files.slice(c.maxAudioClipsPerSession)) { try { unlinkSync(join(clipDir(vsid), f)); } catch {} }
  }

  function storeAudioClip(vsid, buffer, mimetype, meta = {}) {
    if (!audioOn()) return { skipped: 'audio_consent' };
    if (!buffer || !buffer.length) return { skipped: 'empty' };
    try { mkdirSync(clipDir(vsid), { recursive: true }); } catch {}
    const id = new Date(now()).toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
    const name = id + extForMime(mimetype);
    try { writeFileSync(join(clipDir(vsid), name), buffer); } catch { return { skipped: 'write_failed' }; }
    pruneClips(vsid);
    audit('audio_store', { vsid: safeName(vsid), clip: name, bytes: buffer.length, ...(meta.seq != null ? { seq: meta.seq } : {}) });
    return { stored: true, clip: name, bytes: buffer.length };
  }

  function listAudioClips(vsid) {
    try {
      return readdirSync(clipDir(vsid)).map((f) => ({ clip: f, bytes: statSync(join(clipDir(vsid), f)).size }))
        .sort((a, b) => a.clip.localeCompare(b.clip));
    } catch { return []; }
  }

  // Re-transcribe a stored clip — the "recover a garbled transcript from audio" path.
  // Requires a transcribe(buffer, mimetype, name) => {text, model} injected by the host.
  async function retranscribeClip(vsid, clip, engine = null) {
    if (typeof transcribe !== 'function') return { error: 'no transcriber wired' };
    const name = safeName(clip);
    const full = join(clipDir(vsid), name);
    if (!existsSync(full)) return { error: 'clip not found' };
    let buffer; try { buffer = readFileSync(full); } catch { return { error: 'read failed' }; }
    try {
      const r = await transcribe(buffer, mimeForClip(name), name, engine);
      audit('retranscribe', { vsid: safeName(vsid), clip: name, model: r && r.model, chars: (r && r.text || '').length });
      return { text: (r && r.text) || '', model: r && r.model, clip: name };
    } catch (e) { return { error: String((e && e.message) || e).slice(0, 200) }; }
  }

  // ---- retention / purge ----------------------------------------------------

  function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); return true; } catch { return false; } }

  // Delete everything older than the retention window: memory records, audio clip
  // directories, and (if wired) the raw transcript files. Safe to call on startup and
  // on a timer. Returns counts.
  function purgeExpired() {
    const c = loadConfig();
    const cutoff = now() - c.retentionDays * DAY_MS;
    let sessions = 0, audioDirs = 0, transcripts = 0;

    for (const rec of allRecords()) {
      if ((rec.endedAt || 0) < cutoff) { if (rmTree(recordPath(rec.vsid))) sessions++; }
    }
    try {
      for (const d of readdirSync(AUDIO_DIR)) {
        const p = join(AUDIO_DIR, d);
        let mt = 0; try { mt = statSync(p).mtimeMs; } catch {}
        if (mt && mt < cutoff) { if (rmTree(p)) audioDirs++; }
      }
    } catch {}
    if (transcriptsDir) {
      try {
        for (const f of readdirSync(transcriptsDir)) {
          const p = join(transcriptsDir, f);
          let mt = 0; try { mt = statSync(p).mtimeMs; } catch {}
          if (mt && mt < cutoff) { try { unlinkSync(p); transcripts++; } catch {} }
        }
      } catch {}
    }
    if (sessions || audioDirs || transcripts) audit('purge_expired', { sessions, audioDirs, transcripts, retentionDays: c.retentionDays });
    return { sessions, audioDirs, transcripts };
  }

  // Wipe ALL stored voice data (the "forget everything" / disable-and-purge path).
  // Config (incl. consent choice) is preserved; only the data is destroyed.
  function purgeAll(actor = 'unknown') {
    const before = stats();
    for (const rec of allRecords()) rmTree(recordPath(rec.vsid));
    try { for (const d of readdirSync(AUDIO_DIR)) rmTree(join(AUDIO_DIR, d)); } catch {}
    let transcripts = 0;
    if (transcriptsDir) {
      try { for (const f of readdirSync(transcriptsDir)) { try { unlinkSync(join(transcriptsDir, f)); transcripts++; } catch {} } } catch {}
    }
    try { mkdirSync(SESSIONS_DIR, { recursive: true }); mkdirSync(AUDIO_DIR, { recursive: true }); } catch {}
    audit('purge_all', { actor, sessions: before.sessions, audioClips: before.audioClips, transcripts });
    return { sessions: before.sessions, audioClips: before.audioClips, transcripts };
  }

  // ---- stats (for the status endpoint) --------------------------------------

  function stats() {
    const recs = allRecords();
    let audioClips = 0;
    try { for (const d of readdirSync(AUDIO_DIR)) { try { audioClips += readdirSync(join(AUDIO_DIR, d)).length; } catch {} } } catch {}
    let transcripts = 0;
    if (transcriptsDir) { try { transcripts = readdirSync(transcriptsDir).length; } catch {} }
    const oldest = recs.reduce((m, r) => Math.min(m, r.endedAt || Infinity), Infinity);
    return {
      sessions: recs.length,
      audioClips,
      transcripts,
      oldestSessionAt: Number.isFinite(oldest) ? oldest : null,
    };
  }

  return {
    // config / consent
    getConfig, setConsent, updateConfig, memoryOn, audioOn, retrievalOn,
    // indexing + retrieval
    needsIndex, indexSession, retrieve, renderPreload, readRecord, allRecords,
    // audio
    storeAudioClip, listAudioClips, retranscribeClip,
    // retention
    purgeExpired, purgeAll,
    // introspection
    stats, readAudit,
    // exposed for tests
    _internal: { tokenize, buildRecord, DEFAULTS },
  };
}
