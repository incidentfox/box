import { readFileSync } from 'node:fs';

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

export function codexRolloutHistory(file) {
  if (!file) return [];
  try { return parseCodexRollout(readFileSync(file, 'utf8')); } catch { return []; }
}
