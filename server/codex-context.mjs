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

import { readdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

// thread id -> resolved rollout path (resolving walks the sessions tree; cache the hit).
const _rolloutCache = new Map();

// Resolve the rollout JSONL for a Codex thread id. Codex lays them out under
// <codexHome>/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<threadId>.jsonl. We walk the tree
// newest-date-first (dir names sort lexically == chronologically) and match the id in
// the filename; the file is created at session start and appended for the session's life,
// so matching by id is correct regardless of which day we're searching.
export function findCodexRollout(codexHome, id) {
  if (!codexHome || !id) return null;
  const cached = _rolloutCache.get(id);
  if (cached && existsSync(cached)) return cached;
  const hit = walk(join(codexHome, 'sessions'), id);
  if (hit) _rolloutCache.set(id, hit);
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
