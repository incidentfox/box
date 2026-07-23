import { createReadStream, openSync, readSync, closeSync, statSync, watch } from 'node:fs';

const HISTORY_WINDOW_BYTES = 160 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;
const MAX_JSONL_RECORD_BYTES = 2 * 1024 * 1024;

const textOutput = (value) => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => part && (part.text || part.input_text) || '').join('');
  return value == null ? '' : JSON.stringify(value);
};

function balancedObject(source, from) {
  const start = source.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0, quote = '', escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

function nestedTool(input) {
  const source = String(input || '');
  const hit = source.match(/tools\.([A-Za-z0-9_]+)\s*\(/);
  if (!hit) return { method: '', args: {}, raw: source };
  let args = {};
  const json = balancedObject(source, hit.index + hit[0].length);
  try { if (json) args = JSON.parse(json); } catch {}
  return { method: hit[1], args, raw: source };
}

function toolPart(payload) {
  let method = payload.name || '';
  let args = {};
  if (payload.type === 'custom_tool_call' && method === 'exec') {
    const nested = nestedTool(payload.input);
    method = nested.method || method;
    args = nested.args;
  } else {
    try { args = JSON.parse(payload.arguments || '{}'); } catch {}
  }
  const map = {
    exec_command: 'Bash', write_stdin: 'Bash', apply_patch: 'ApplyPatch',
    wait: 'Wait', view_image: 'Read', web__run: 'WebSearch',
  };
  const name = map[method] || method || 'Tool';
  let input = '';
  if (method === 'exec_command') input = args.cmd || '';
  else if (method === 'write_stdin') input = `Continue command ${args.session_id || ''}`.trim();
  else if (method === 'wait') input = 'Waiting for command output';
  else if (method === 'apply_patch') input = 'Editing files';
  else input = JSON.stringify(args || {});
  return { t: 'tool', id: payload.call_id || payload.id || '', name, input: String(input).slice(0, 240), detail: args };
}

export function parseCodexRollout(raw) {
  const messages = [];
  const pending = new Map();
  let assistant = null;
  const ensureAssistant = (ts) => {
    if (!assistant) { assistant = { role: 'assistant', parts: [], ts: ts || null }; messages.push(assistant); }
    return assistant;
  };
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const p = row.payload || {};
    if (row.type === 'event_msg' && p.type === 'user_message') {
      const text = String(p.message || '').trim();
      if (!text || text.startsWith('<') || text.startsWith('Caveat:')) continue;
      const parts = [{ t: 'text', text }];
      for (const path of [...(p.local_images || []), ...(p.local_files || [])]) parts.push({ t: /\.(png|jpe?g|gif|webp)$/i.test(path) ? 'image' : 'file', path });
      const prev = messages[messages.length - 1];
      const prevText = prev && prev.role === 'user' ? prev.parts.filter((x) => x.t === 'text').map((x) => x.text).join('\n') : '';
      if (prevText !== text) messages.push({ role: 'user', parts, ts: row.timestamp || null });
      assistant = null;
      continue;
    }
    if (row.type === 'event_msg' && p.type === 'agent_message') {
      const text = String(p.message || '').trim();
      if (text) ensureAssistant(row.timestamp).parts.push({ t: 'text', text });
      continue;
    }
    if (row.type !== 'response_item') continue;
    if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      const part = toolPart(p);
      ensureAssistant(row.timestamp).parts.push(part);
      if (p.call_id) pending.set(p.call_id, part);
    } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const part = pending.get(p.call_id);
      if (part) part.result = textOutput(p.output).slice(0, 6000);
    }
    // `reasoning` rows are deliberately ignored: their timestamps feed live status,
    // but private chain-of-thought is never rendered in conversation history.
  }
  return messages.filter((message) => message.parts && message.parts.length);
}

function relevantRolloutLine(line) {
  if (!line) return false;
  if (line.includes('"type":"event_msg"')) {
    return line.includes('"type":"user_message"') || line.includes('"type":"agent_message"');
  }
  if (!line.includes('"type":"response_item"')) return false;
  return line.includes('"type":"custom_tool_call"')
    || line.includes('"type":"custom_tool_call_output"')
    || line.includes('"type":"function_call"')
    || line.includes('"type":"function_call_output"');
}

// Stream a bounded byte window instead of readFileSync()ing the whole rollout. A long-lived
// Codex thread can exceed multiple GB because every turn persists context/world-state rows.
// Those rows can themselves be ~100MB, so the reader also drops oversized JSONL records while
// streaming rather than buffering them. Conversation/tool rows are small and retained.
async function relevantLinesInRange(file, start, end) {
  if (end <= start) return { lines: [], cursor: start };
  const lines = [];
  let pending = Buffer.alloc(0);
  let droppingOversize = false;
  let discardFirstPartial = start > 0;
  let firstBoundary = start;
  let absolute = start;

  const processLine = (buf, boundaryAfter) => {
    if (discardFirstPartial) {
      discardFirstPartial = false;
      firstBoundary = boundaryAfter;
      return;
    }
    if (!buf.length || buf.length > MAX_JSONL_RECORD_BYTES) return;
    const line = buf.toString('utf8');
    if (relevantRolloutLine(line)) lines.push(line);
  };

  await new Promise((resolve, reject) => {
    const stream = createReadStream(file, { start, end: end - 1, highWaterMark: STREAM_CHUNK_BYTES });
    stream.on('data', (chunk) => {
      let segmentStart = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 10) continue;
        const segment = chunk.subarray(segmentStart, i);
        const boundaryAfter = absolute + i + 1;
        if (droppingOversize) {
          droppingOversize = false;
          pending = Buffer.alloc(0);
          if (discardFirstPartial) { discardFirstPartial = false; firstBoundary = boundaryAfter; }
        } else {
          const line = pending.length ? Buffer.concat([pending, segment]) : segment;
          processLine(line, boundaryAfter);
          pending = Buffer.alloc(0);
        }
        segmentStart = i + 1;
      }
      const tail = chunk.subarray(segmentStart);
      if (!droppingOversize && tail.length) {
        if (pending.length + tail.length > MAX_JSONL_RECORD_BYTES) {
          pending = Buffer.alloc(0);
          droppingOversize = true;
        } else {
          pending = pending.length ? Buffer.concat([pending, tail]) : Buffer.from(tail);
        }
      }
      absolute += chunk.length;
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  // An unterminated final row may still be in the middle of an append. Ignore it; the next
  // history request/live-tail pump will pick it up after its newline lands.
  return { lines, cursor: firstBoundary };
}

export async function codexRolloutHistory(file, { before = null, maxBytes = HISTORY_WINDOW_BYTES } = {}) {
  if (!file) return { messages: [], hasMore: false, cursor: 0, liveCursor: 0 };
  try {
    const size = statSync(file).size;
    const end = before == null ? size : Math.max(0, Math.min(Number(before) || 0, size));
    const start = Math.max(0, end - Math.max(1024 * 1024, Number(maxBytes) || HISTORY_WINDOW_BYTES));
    const { lines, cursor } = await relevantLinesInRange(file, start, end);
    return {
      messages: parseCodexRollout(lines.join('\n')),
      hasMore: start > 0,
      cursor: start > 0 ? cursor : 0,
      liveCursor: end,
    };
  } catch {
    return { messages: [], hasMore: false, cursor: 0, liveCursor: 0 };
  }
}

function readRangeSync(file, start, length) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function codexRolloutMeta(file) {
  if (!file) return null;
  try {
    const size = statSync(file).size;
    const raw = readRangeSync(file, 0, Math.min(size, 4 * 1024 * 1024));
    let meta = null, opening = '';
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      const p = row.payload || {};
      if (!meta && row.type === 'session_meta') {
        meta = {
          id: p.id || p.session_id || '', cwd: p.cwd || '', created: p.timestamp || row.timestamp || '',
          source: p.source || p.originator || 'native',
        };
      }
      if (!opening && row.type === 'event_msg' && p.type === 'user_message') {
        const text = String(p.message || '').replace(/\s+/g, ' ').trim();
        if (text && !text.startsWith('<') && !text.startsWith('Caveat:')) opening = text.slice(0, 100);
      }
      if (meta && opening) break;
    }
    return meta ? { ...meta, opening, size } : null;
  } catch { return null; }
}

// Lightweight tail state for list/status and steering safety. This never reads more than 4MB.
export function codexRolloutState(file) {
  if (!file) return { phase: '', busy: false, preview: '', ts: 0, mtimeMs: 0 };
  try {
    const st = statSync(file);
    const len = Math.min(st.size, 4 * 1024 * 1024);
    const raw = readRangeSync(file, st.size - len, len);
    let phase = '', preview = '', ts = 0;
    for (const line of raw.split('\n')) {
      if (!line.includes('"type":"agent_message"')) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      const p = row.payload || {};
      if (row.type !== 'event_msg' || p.type !== 'agent_message') continue;
      phase = p.phase || '';
      preview = String(p.message || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      ts = Date.parse(row.timestamp || '') || ts;
    }
    // A final answer is idle only when no later context/tool append has begun a new turn.
    const busy = phase !== 'final_answer' || (ts > 0 && st.mtimeMs - ts > 2500);
    return { phase, busy, preview, ts, mtimeMs: st.mtimeMs };
  } catch { return { phase: '', busy: false, preview: '', ts: 0, mtimeMs: 0 }; }
}

export function parseCodexLiveEntry(row) {
  const p = row && row.payload || {};
  if (row && row.type === 'event_msg' && p.type === 'user_message') {
    const text = String(p.message || '').trim();
    return text && !text.startsWith('<') && !text.startsWith('Caveat:') ? [{ kind: 'user', text, ts: row.timestamp }] : [];
  }
  if (row && row.type === 'event_msg' && p.type === 'agent_message') {
    const text = String(p.message || '').trim();
    const out = text ? [{ kind: 'text', text, phase: p.phase || '', ts: row.timestamp }] : [];
    if (p.phase === 'final_answer') out.push({ kind: 'turn_end', ts: row.timestamp });
    return out;
  }
  if (!row || row.type !== 'response_item') return [];
  if (p.type === 'reasoning') return [{ kind: 'thinking', text: '', ts: row.timestamp }];
  if (p.type === 'custom_tool_call' || p.type === 'function_call') {
    const t = toolPart(p);
    return [{ kind: 'tool', id: t.id, name: t.name, input: t.detail || t.input, ts: row.timestamp }];
  }
  if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
    return [{ kind: 'tool_result', id: p.call_id || p.id || '', content: textOutput(p.output).slice(0, 6000), ts: row.timestamp }];
  }
  return [];
}

// Follow only newly-appended bytes. Oversized context/world-state rows are discarded without
// buffering; small conversation/tool rows are normalized for the existing WebSocket renderer.
export function tailCodexRollout(file, onEvent, { fromOffset = null } = {}) {
  let offset = 0;
  try {
    const size = statSync(file).size;
    offset = fromOffset == null ? size : Math.max(0, Math.min(Number(fromOffset) || 0, size));
  } catch {}
  let pending = Buffer.alloc(0), droppingOversize = false, reading = false, dirty = false;

  const consume = (chunk) => {
    let segmentStart = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      const segment = chunk.subarray(segmentStart, i);
      if (droppingOversize) {
        droppingOversize = false; pending = Buffer.alloc(0);
      } else {
        const line = pending.length ? Buffer.concat([pending, segment]) : segment;
        pending = Buffer.alloc(0);
        if (line.length && line.length <= MAX_JSONL_RECORD_BYTES) {
          const text = line.toString('utf8');
          if (relevantRolloutLine(text) || text.includes('"type":"reasoning"')) {
            try { for (const ev of parseCodexLiveEntry(JSON.parse(text))) onEvent(ev); } catch {}
          }
        }
      }
      segmentStart = i + 1;
    }
    const tail = chunk.subarray(segmentStart);
    if (!droppingOversize && tail.length) {
      if (pending.length + tail.length > MAX_JSONL_RECORD_BYTES) { pending = Buffer.alloc(0); droppingOversize = true; }
      else pending = pending.length ? Buffer.concat([pending, tail]) : Buffer.from(tail);
    }
  };

  const pump = () => {
    if (reading) { dirty = true; return; }
    let size = 0; try { size = statSync(file).size; } catch { return; }
    if (size < offset) { offset = 0; pending = Buffer.alloc(0); droppingOversize = false; }
    if (size === offset) return;
    const end = size;
    reading = true; dirty = false;
    const stream = createReadStream(file, { start: offset, end: end - 1, highWaterMark: STREAM_CHUNK_BYTES });
    stream.on('data', consume);
    stream.on('error', () => { reading = false; });
    stream.on('end', () => { offset = end; reading = false; if (dirty) pump(); });
  };
  let watcher = null;
  try { watcher = watch(file, { persistent: false }, pump); } catch {}
  const poll = setInterval(pump, 1000);
  return () => { try { watcher && watcher.close(); } catch {}; clearInterval(poll); };
}
