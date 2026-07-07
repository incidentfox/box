// Live Codex context occupancy — read from the session's rollout file, not the
// streamed `turn.completed.usage`.
//
// Why: codex `exec --json` only reports CUMULATIVE token usage on `turn.completed`
// (`usage.input_tokens` sums every model request across the whole session). Treating
// that as the live context size made the meter balloon — a long session showed
// "Context 999% before compact" (e.g. 15M / 258k) because it divided the lifetime
// total by the window. The number we actually want is the LAST request's input — the
// live window occupancy, exactly what Codex's own TUI shows. Codex persists that in the
// rollout JSONL as a `token_count` event's `last_token_usage`, so we read it from there.
//
// Verified (2026-06-28): across 4 trivial turns the cumulative input grew
// 33k → 66k → 99k → 133k while `last_token_usage` stayed flat at ~33k. The rollout's
// `last_token_usage` is the correct live figure; `total_token_usage` is the lifetime sum.

import { createReadStream, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// thread id -> resolved rollout path (resolving walks the sessions tree; cache the hit).
const _rolloutCache = new Map();

// Resolve the rollout JSONL for a Codex thread id. Codex lays them out under
// <codexHome>/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<threadId>.jsonl. We walk the tree
// newest-date-first (dir names sort lexically == chronologically) and match the id in
// the filename; the file is created at session start and appended for the session's life,
// so matching by id is correct regardless of which day we're searching.
export function findCodexRollout(codexHome, id) {
  if (!codexHome || !id) return null;
  const cacheKey = `${codexHome}:${id}`;
  const cached = _rolloutCache.get(cacheKey);
  if (cached && existsSync(cached)) return cached;
  const hit = walk(join(codexHome, 'sessions'), id);
  if (hit) _rolloutCache.set(cacheKey, hit);
  return hit;
}

function walk(dir, id) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const dirs = [];
  let match = null;
  for (const e of entries) {
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile() && e.name.includes(id) && e.name.endsWith('.jsonl')) {
      // Prefer the lexically-greatest filename (newest timestamp prefix) if several match.
      if (!match || e.name > match) match = e.name;
    }
  }
  if (match) return join(dir, match);
  for (const name of dirs.sort().reverse()) {
    const found = walk(join(dir, name), id);
    if (found) return found;
  }
  return null;
}

// Read the most recent `token_count` info object from the tail of a rollout file. Shape:
//   { last_token_usage: {input_tokens, output_tokens, total_tokens, ...},
//     total_token_usage: {...}, model_context_window: <int> }
// Returns that `info` (the exact shape contextFromCodexInfo() already understands), or
// null if the file is missing / has no token_count yet. Caller turns it into a context.
export function readCodexTokenInfo(file) {
  if (!file) return null;
  try {
    const st = statSync(file);
    const len = Math.min(st.size, 256 * 1024);
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || !line.includes('token_count')) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; } // a truncated first line just gets skipped
      const info = o && o.payload && o.payload.type === 'token_count' ? o.payload.info
        : (o && o.type === 'token_count' ? o.info : null);
      if (info && (info.last_token_usage || info.total_token_usage)) return info;
    }
  } catch {}
  return null;
}

const DEFAULT_HISTORY_LIMIT = 120;
const DEFAULT_PROMPT_CHARS = 1800;

function compactText(s, n = DEFAULT_PROMPT_CHARS) {
  const text = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return text.length > n ? text.slice(0, Math.max(0, n - 1)) + '…' : text;
}

export function codexMessageText(m) {
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

function attachmentCountsFromParts(parts = []) {
  const counts = { images: 0, files: 0 };
  for (const p of parts || []) {
    if (!p || typeof p !== 'object') continue;
    const t = p.t || p.type;
    if (t === 'image' || t === 'input_image') counts.images++;
    else if (t === 'file' || t === 'input_file') counts.files++;
  }
  return counts.images || counts.files ? counts : null;
}

function messageContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => {
    if (!p || typeof p !== 'object') return '';
    if (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') return p.text || '';
    return '';
  }).filter(Boolean).join('\n').trim();
}

function historyOptions(opts = {}) {
  return {
    limit: Math.max(1, Math.min(500, Number(opts.limit || opts.maxPrompts || DEFAULT_HISTORY_LIMIT) || DEFAULT_HISTORY_LIMIT)),
    maxCharsPerPrompt: Math.max(80, Math.min(10000, Number(opts.maxCharsPerPrompt || DEFAULT_PROMPT_CHARS) || DEFAULT_PROMPT_CHARS)),
  };
}

export function codexUserPromptsFromMessages(messages = [], opts = {}) {
  const { limit, maxCharsPerPrompt } = historyOptions(opts);
  const prompts = [];
  for (const m of messages || []) {
    if (!m || m.role !== 'user') continue;
    const text = compactText(codexMessageText(m), maxCharsPerPrompt);
    if (!text) continue;
    prompts.push({
      index: prompts.length + 1,
      ts: codexMessageTs(m),
      text,
      source: 'box_sidecar',
      attachments: attachmentCountsFromParts(m.parts || m.content || []),
    });
  }
  return {
    prompts: prompts.slice(-limit).map((p, i) => ({ ...p, index: i + 1 })),
    total: prompts.length,
    truncated: prompts.length > limit,
  };
}

export async function codexUserPromptsFromRollout(file, opts = {}) {
  const { limit, maxCharsPerPrompt } = historyOptions(opts);
  if (!file) return { prompts: [], total: 0, truncated: false };
  const prompts = [];
  try {
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const p = o && o.type === 'event_msg' ? o.payload : (o && o.type === 'response_item' ? o.payload : null);
      let text = '', attachments = null;
      if (p && p.type === 'user_message') {
        text = p.message || '';
        const images = (p.local_images || []).filter(Boolean).length;
        const files = (p.local_files || []).filter(Boolean).length;
        attachments = images || files ? { images, files } : null;
      } else if (p && p.type === 'message' && p.role === 'user') {
        text = messageContentText(p.content);
        attachments = attachmentCountsFromParts(p.content || []);
      }
      text = compactText(text, maxCharsPerPrompt);
      if (!text) continue;
      prompts.push({ index: prompts.length + 1, ts: o.timestamp || p.timestamp || null, text, source: 'codex_rollout', attachments });
    }
  } catch {
    return { prompts: [], total: 0, truncated: false };
  }
  return {
    prompts: prompts.slice(-limit).map((p, i) => ({ ...p, index: i + 1 })),
    total: prompts.length,
    truncated: prompts.length > limit,
  };
}

function auditPath(path, purpose) {
  const row = { path, purpose, readable: false };
  if (!path) return row;
  try {
    const st = statSync(path);
    row.readable = true;
    row.bytes = st.size;
    row.mtimeMs = st.mtimeMs;
  } catch {}
  return row;
}

// Read-only helper for voice/agent surfaces that need ordered user prompts from a
// Codex session without launching a write-capable agent or exposing raw tool output.
export async function readCodexSessionHistory({ sessionId, query = '', codexHome = '', messages = [], sidecarPath = '', limit, maxCharsPerPrompt } = {}) {
  const audit = {
    generated_at: new Date().toISOString(),
    permission: { mode: 'read-only', writes: false, allowed_sources: ['codex_rollout_jsonl', 'box_codex_sidecar'] },
    queries: [],
    paths: [],
  };
  const id = String(sessionId || '').trim();
  if (!id) return { source: 'unavailable', prompts: [], count: 0, total: 0, truncated: false, audit, unavailable: 'sessionId required' };

  const root = codexHome ? join(codexHome, 'sessions') : '';
  audit.queries.push({ source: 'codex_rollout', root, predicate: `filename contains ${id} and ends with .jsonl`, query: query || id });
  const rollout = findCodexRollout(codexHome, id);
  audit.paths.push(auditPath(rollout || root, rollout ? 'codex rollout jsonl' : 'codex rollout search root'));
  if (rollout) {
    const fromRollout = await codexUserPromptsFromRollout(rollout, { limit, maxCharsPerPrompt });
    if (fromRollout.total > 0) {
      return { session_id: id, source: 'codex_rollout', ...fromRollout, count: fromRollout.prompts.length, audit };
    }
  }

  audit.queries.push({ source: 'box_sidecar', predicate: `stored messages for ${id}`, query: query || id });
  audit.paths.push(auditPath(sidecarPath, 'box codex message sidecar'));
  const fromMessages = codexUserPromptsFromMessages(messages, { limit, maxCharsPerPrompt });
  if (fromMessages.total > 0) {
    return { session_id: id, source: 'box_sidecar', ...fromMessages, count: fromMessages.prompts.length, audit };
  }

  return {
    session_id: id,
    source: 'unavailable',
    prompts: [],
    count: 0,
    total: 0,
    truncated: false,
    audit,
    unavailable: 'no readable Codex rollout or Box sidecar prompts',
  };
}
