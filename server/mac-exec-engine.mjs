// Mac "Computer Use" engine. Runs `codex exec --json` ON THE USER'S MAC (in its GUI/Aqua
// login session, where Codex Computer Use can reach the display) via the cu-bridge worker,
// and streams the SAME event format the local Codex engine parses — so a Computer Use chat
// gets live tool chips + streamed text + multi-turn resume, just like Codex.
//
// Transport: the Mac holds a reverse SSH tunnel to this box; the worker's streaming /chat
// endpoint is reachable at MAC_BRIDGE_URL (default http://127.0.0.1:8781). This deliberately
// BYPASSES OpenAI's cloud remote-control relay (which 401s under apikey auth — the real cause
// of the flaky official bridge). Bearer-token gated (~/.cu-bridge/token).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { buildCodexArgs } from './codex-exec-engine.mjs';

export const MAC_BRIDGE_URL = process.env.MAC_BRIDGE_URL || 'http://127.0.0.1:8781';
export function macBridgeToken() {
  if (process.env.MAC_BRIDGE_TOKEN) return process.env.MAC_BRIDGE_TOKEN.trim();
  try { return fs.readFileSync(`${os.homedir()}/.cu-bridge/token`, 'utf8').trim(); } catch { return ''; }
}

// ---- bridge liveness (cached) — the Computer Use agent only shows when the Mac is reachable ----
let _macAvail = false;
export function macAvailable() { return _macAvail; }
function pollHealth() {
  try {
    const u = new URL(MAC_BRIDGE_URL.replace(/\/$/, '') + '/health');
    const req = http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname, timeout: 2500,
      headers: { Authorization: `Bearer ${macBridgeToken()}` } },
      (res) => { _macAvail = res.statusCode === 200; res.resume(); });
    req.on('error', () => { _macAvail = false; });
    req.on('timeout', () => { _macAvail = false; try { req.destroy(); } catch {} });
  } catch { _macAvail = false; }
}
pollHealth();
try { setInterval(pollHealth, 20000).unref(); } catch {}

// Proxy a live screenshot from the Mac (the "View screen" button — no agent, no cost).
export function macScreenshotStream(onRes, onErr) {
  try {
    const u = new URL(MAC_BRIDGE_URL.replace(/\/$/, '') + '/screenshot');
    const req = http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname, timeout: 15000,
      headers: { Authorization: `Bearer ${macBridgeToken()}` } }, onRes);
    req.on('error', onErr);
    req.on('timeout', () => { try { req.destroy(); } catch {} onErr(new Error('mac screenshot timeout')); });
  } catch (e) { onErr(e); }
}

const basename = (p) => String(p || '').split('/').filter(Boolean).pop() || String(p || '');
function summarizeCommand(c) { return String(c || '').replace(/\s+/g, ' ').slice(0, 120); }

// (copied from codex-exec-engine.mjs — kept local so the Codex path is untouched)
function toolFromItem(item) {
  switch (item && item.type) {
    case 'command_execution':
      return { name: 'Bash', input: summarizeCommand(item.command), detail: { command: item.command || '' } };
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map((c) => c && c.path).filter(Boolean);
      const label = paths.length ? basename(paths[0]) + (paths.length > 1 ? ` +${paths.length - 1}` : '') : 'files';
      return { name: 'ApplyPatch', input: label, detail: { files: paths, changes } };
    }
    case 'mcp_tool_call':
      // Computer Use surfaces as computer-use.* MCP calls — relabel so the chip reads "Computer Use".
      return { name: /computer/i.test(String(item.server || '')) ? 'ComputerUse' : 'MCP', input: [item.server, item.tool].filter(Boolean).join('.') || item.name || 'tool', detail: item };
    case 'web_search':
      return { name: 'WebSearch', input: item.query || '', detail: item };
    default:
      return null;
  }
}
const TOOL_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

function handleCodexEvent(o, seenTools, emit) {
  if (o.type === 'thread.started' && o.thread_id) { emit({ type: 'session', id: o.thread_id }); return; }
  if (o.type === 'turn.completed' && o.usage) {
    emit({ type: 'context', info: { last_token_usage: { input_tokens: Number(o.usage.input_tokens) || 0, output_tokens: Number(o.usage.output_tokens) || 0 } } });
    return;
  }
  if (o.type === 'event_msg' && o.payload && o.payload.type === 'agent_message') {
    const text = String(o.payload.message || '').trim(); if (text) emit({ type: 'notice', text }); return;
  }
  const item = o.item;
  if (o.type === 'item.started' && item && TOOL_ITEMS.has(item.type)) {
    const t = toolFromItem(item); if (!t) return;
    const id = item.id || `tool-${seenTools.size + 1}`; seenTools.add(id);
    emit({ type: 'tool', id, name: t.name, input: t.input, detail: t.detail }); return;
  }
  if (o.type === 'item.completed' && item) {
    if (item.type === 'agent_message') { if (item.text) emit({ type: 'text', delta: item.text }); return; }
    if (item.type === 'error') { if (item.message && !/dangerously-bypass-hook-trust/.test(item.message)) emit({ type: 'notice', text: item.message }); return; }
    if (TOOL_ITEMS.has(item.type)) {
      const t = toolFromItem(item); if (!t) return;
      const id = item.id || `tool-${seenTools.size || 1}`;
      if (!seenTools.has(id)) { seenTools.add(id); emit({ type: 'tool', id, name: t.name, input: t.input, detail: t.detail }); }
      const result = item.aggregated_output != null ? item.aggregated_output : (item.status ? `(${item.status})` : '');
      emit({ type: 'tool_result', id, content: result }); return;
    }
    return;
  }
  if (o.type === 'turn.failed' || o.type === 'error') emit({ type: 'error', msg: o.message || (o.error && o.error.message) || 'Computer Use turn failed' });
}

// Strip the box-side `-C <cwd>` pair — that path doesn't exist on the Mac; the worker runs
// codex in the Mac's own working dir.
function stripCwd(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === '-C') { i++; continue; } out.push(args[i]); }
  return out;
}

export class MacExecEngine {
  run({ sessionId, cwd, prompt, images = [], settings = {}, onEvent }) {
    const args = stripCwd(buildCodexArgs({ sessionId, cwd, prompt, images: [], settings }));
    const body = JSON.stringify({ argv: args, timeout: 40 * 60 });
    const u = new URL(MAC_BRIDGE_URL.replace(/\/$/, '') + '/chat');
    const seenTools = new Set();
    const emit = (e) => { try { onEvent && onEvent(e); } catch {} };
    const listeners = { close: [], error: [] };
    let closed = false;
    const fireClose = (code = 0) => { if (closed) return; closed = true; listeners.close.forEach((cb) => { try { cb(code); } catch {} }); };
    const fireError = (err) => { listeners.error.forEach((cb) => { try { cb(err); } catch {} }); };

    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${macBridgeToken()}`, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      if (res.statusCode !== 200) {
        emit({ type: 'error', msg: `Mac bridge HTTP ${res.statusCode} — is your Mac connected? (cu-bridge)` });
        res.resume(); fireClose(1); return;
      }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          let ev = null; let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '');
          }
          if (ev === 'stderr') { try { const d = JSON.parse(data); if (d.text) emit({ type: 'notice', text: d.text }); } catch {} continue; }
          if (ev === 'error') { try { const d = JSON.parse(data); emit({ type: 'error', msg: d.error || 'mac bridge error' }); } catch {} continue; }
          if (ev === 'done') { continue; } // end-state screenshot ignored for now; use the View-screen button
          if (data && data[0] === '{') { let o; try { o = JSON.parse(data); } catch { continue; } handleCodexEvent(o, seenTools, emit); }
        }
      });
      res.on('end', () => fireClose(0));
      res.on('close', () => fireClose(0));
    });
    req.on('error', (e) => { emit({ type: 'error', msg: `Mac bridge unreachable: ${e.message}` }); fireError(e); fireClose(1); });
    req.write(body); req.end();

    return {
      sessionId,
      on(event, cb) { if (listeners[event]) listeners[event].push(cb); return this; },
      kill() { try { req.destroy(); } catch {} fireClose(1); },
    };
  }
}
