import { createReadStream, openSync, readSync, closeSync, statSync, watch } from 'node:fs';
import { isAbsolute } from 'node:path';

// Most history opens only need the recent conversation.  Keep the first disk read small:
// long-lived Codex sessions contain huge world-state rows that otherwise make opening a
// chat block on a 160MB scan.  If the tail happens to contain only one of those rows, the
// reader expands below until it finds renderable conversation data.
const HISTORY_WINDOW_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_WINDOW_BYTES = 160 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;
const MAX_JSONL_RECORD_BYTES = 2 * 1024 * 1024;

const textOutput = (value) => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => part && (part.text || part.input_text) || '').join('');
  return value == null ? '' : JSON.stringify(value);
};

// Recent Codex versions persist visible text as response_item/message without the
// older event_msg mirror. Normalize both formats, excluding injected/private context.
function conversationMessage(row) {
  const p = row?.payload || {};
  let role, text;
  if (row?.type === 'event_msg' && ['user_message', 'agent_message'].includes(p.type)) {
    role = p.type === 'user_message' ? 'user' : 'assistant';
    text = String(p.message || '').trim();
  } else if (row?.type === 'response_item' && p.type === 'message'
    && ['user', 'assistant'].includes(p.role)) {
    role = p.role;
    if (['analysis', 'summary'].includes(p.channel || p.phase)
      || (p.recipient && p.recipient !== 'all')) return null;
    text = (Array.isArray(p.content) ? p.content : [])
      .filter((part) => ['input_text', 'output_text', 'text'].includes(part?.type))
      .map((part) => String(part.text || ''))
      .filter((text) => role !== 'user' || !isContext(text.trim()))
      .join('\n').trim();
  } else return null;
  if (role === 'user' && (!text || isContext(text))) return null;
  return { role, text, phase: p.phase || p.channel || '', paths: [...(p.local_images || []), ...(p.local_files || [])] };
}

function isContext(text) {
  return text.startsWith('<') || text.startsWith('Caveat:') || text.startsWith('# AGENTS.md instructions for ');
}

// Older rollouts contain both representations, in either order. Match only a
// neighboring cross-format pair; repeated messages in later turns remain visible.
function isMirror(message, row, state) {
  const previous = state.last;
  const time = Date.parse(row.timestamp || '');
  if (previous && previous.source !== row.type && previous.role === message.role
    && previous.text === message.text && previous.phase === message.phase
    && Number.isFinite(time) && Math.abs(time - previous.time) < 1000) {
    state.last = null;
    return true;
  }
  state.last = { ...message, source: row.type, time };
  return false;
}

const GENERATED_IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp|svg|bmp|heic|heif|avif|tiff?)$/i;

// Codex persists generated images to disk and also places a large base64 result in the
// rollout. Keep only the absolute saved path: Box already serves local files through its
// authenticated raw-file route, and retaining the base64 would bloat history/websocket data.
export function codexGeneratedImage(payload) {
  const path = typeof payload?.saved_path === 'string' ? payload.saved_path.trim() : '';
  if (payload?.type !== 'image_generation_end' || payload.status !== 'completed'
    || !isAbsolute(path) || !GENERATED_IMAGE_PATH_RE.test(path)) return null;
  return { path, alt: path.split('/').filter(Boolean).pop() || 'Generated image' };
}

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
  const conversationState = {};
  let assistant = null;
  const ensureAssistant = (ts) => {
    if (!assistant) { assistant = { role: 'assistant', parts: [], ts: ts || null }; messages.push(assistant); }
    return assistant;
  };
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const p = row.payload || {};
    const generatedImage = row.type === 'event_msg' ? codexGeneratedImage(p) : null;
    if (generatedImage) {
      ensureAssistant(row.timestamp).parts.push({ t: 'image', ...generatedImage });
      continue;
    }
    const message = conversationMessage(row);
    if (message) {
      const mirrored = isMirror(message, row, conversationState);
      if (message.role === 'user') {
        const parts = [{ t: 'text', text: message.text }];
        for (const path of message.paths) parts.push({ t: /\.(png|jpe?g|gif|webp)$/i.test(path) ? 'image' : 'file', path });
        if (!mirrored) messages.push({ role: 'user', parts, ts: row.timestamp || null });
        else {
          const previous = messages[messages.length - 1];
          if (previous?.role === 'user') for (const part of parts.slice(1)) {
            if (!previous.parts.some((existing) => existing.path === part.path)) previous.parts.push(part);
          }
        }
        assistant = null;
      } else if (!mirrored && message.text) ensureAssistant(row.timestamp).parts.push({ t: 'text', text: message.text });
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
    return line.includes('"type":"user_message"') || line.includes('"type":"agent_message"')
      || line.includes('"type":"image_generation_end"');
  }
  if (!line.includes('"type":"response_item"')) return false;
  return line.includes('"type":"message"')
    || line.includes('"type":"custom_tool_call"')
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

export async function codexRolloutHistory(file, { before = null, maxBytes } = {}) {
  if (!file) return { messages: [], hasMore: false, cursor: 0, liveCursor: 0 };
  try {
    const size = statSync(file).size;
    const end = before == null ? size : Math.max(0, Math.min(Number(before) || 0, size));
    const explicitWindow = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0;
    let windowBytes = Math.max(1024 * 1024, explicitWindow ? Number(maxBytes) : HISTORY_WINDOW_BYTES);
    const maxWindowBytes = explicitWindow ? windowBytes : MAX_HISTORY_WINDOW_BYTES;

    // The normal path returns after one small tail scan.  Expand only for a trailing
    // oversized/non-conversation row so the user sees history instead of a blank chat.
    while (true) {
      const start = Math.max(0, end - windowBytes);
      const { lines, cursor } = await relevantLinesInRange(file, start, end);
      const messages = parseCodexRollout(lines.join('\n'));
      if (messages.length || start === 0 || windowBytes >= maxWindowBytes) {
        return {
          messages,
          hasMore: start > 0,
          cursor: start > 0 ? cursor : 0,
          liveCursor: end,
        };
      }
      windowBytes = Math.min(maxWindowBytes, windowBytes * 2);
    }
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
      const message = conversationMessage(row);
      if (!opening && message?.role === 'user') opening = message.text.replace(/\s+/g, ' ').slice(0, 100);
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
    // A partial tail can start after the last interactive event (large world-state
    // rows are common).  "Unknown" must not be rendered as "Working": the process
    // and dtach checks in the caller still surface a connected terminal as live.
    let phase = '', preview = '', ts = 0, busy = false;
    for (const line of raw.split('\n')) {
      if (!relevantRolloutLine(line)) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      const message = conversationMessage(row);
      if (!message) continue;
      ts = Date.parse(row.timestamp || '') || ts;
      if (message.role === 'user') {
        phase = ''; preview = ''; busy = true;
      } else {
        phase = message.phase;
        preview = message.text.replace(/\s+/g, ' ').slice(0, 160);
        busy = !['final_answer', 'final'].includes(phase);
      }
    }
    // Terminal task/goal records often append after final_answer. They are not a new turn;
    // only a real user message or a later non-final assistant phase can make this busy again.
    return { phase, busy, preview, ts, mtimeMs: st.mtimeMs };
  } catch { return { phase: '', busy: false, preview: '', ts: 0, mtimeMs: 0 }; }
}

export function parseCodexLiveEntry(row, conversationState = {}) {
  const p = row && row.payload || {};
  const generatedImage = row && row.type === 'event_msg' ? codexGeneratedImage(p) : null;
  if (generatedImage) return [{ kind: 'image', ...generatedImage, ts: row.timestamp }];
  const message = conversationMessage(row);
  if (message) {
    if (isMirror(message, row, conversationState)) return [];
    if (message.role === 'user') return [{ kind: 'user', text: message.text, ts: row.timestamp }];
    const out = message.text ? [{ kind: 'text', text: message.text, phase: message.phase, ts: row.timestamp }] : [];
    if (['final_answer', 'final'].includes(message.phase)) out.push({ kind: 'turn_end', ts: row.timestamp });
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
  let activeStream = null, stopped = false;
  const conversationState = {};

  const consume = (chunk) => {
    if (stopped) return;
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
            try { for (const ev of parseCodexLiveEntry(JSON.parse(text), conversationState)) onEvent(ev); } catch {}
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
    if (stopped) return;
    if (reading) { dirty = true; return; }
    let size = 0; try { size = statSync(file).size; } catch { return; }
    if (size < offset) { offset = 0; pending = Buffer.alloc(0); droppingOversize = false; }
    if (size === offset) return;
    const end = size;
    reading = true; dirty = false;
    const stream = createReadStream(file, { start: offset, end: end - 1, highWaterMark: STREAM_CHUNK_BYTES });
    activeStream = stream;
    stream.on('data', consume);
    stream.on('error', () => { if (activeStream === stream) activeStream = null; reading = false; });
    stream.on('end', () => {
      if (activeStream === stream) activeStream = null;
      if (!stopped) offset = end;
      reading = false;
      if (!stopped && dirty) pump();
    });
  };
  let watcher = null;
  try { watcher = watch(file, { persistent: false }, pump); } catch {}
  const poll = setInterval(pump, 1000);
  return () => {
    stopped = true;
    try { watcher && watcher.close(); } catch {}
    clearInterval(poll);
    try { activeStream && activeStream.destroy(); } catch {}
    activeStream = null;
  };
}
