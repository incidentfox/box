// DeepSeek engine — wraps `codex exec` pointed at DeepSeek's OpenAI-compatible API.
// Codex supports any OpenAI-compatible endpoint via OPENAI_BASE_URL + OPENAI_API_KEY.
// We reuse buildCodexArgs / the full codex exec protocol (JSON stream, session resume,
// tool chips, context meter) and just swap the environment to point at DeepSeek.
//
// buildOwnerCodexEnv strips OPENAI_API_KEY to keep the owner's ChatGPT credits safe —
// we bypass that here (intentional) since DeepSeek IS the target provider.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { buildChildEnv } from './child-env.mjs';
import {
  buildCodexArgs,
  terminateCodexProcess,
  reasoningHeartbeat,
  buildOwnerCodexScript,
} from './codex-exec-engine.mjs';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export class DeepSeekExecEngine {
  constructor({ spawnImpl = spawn } = {}) {
    this.spawnImpl = spawnImpl;
  }

  run({ sessionId, cwd, prompt, images = [], settings = {}, apiKey = '', onEvent }) {
    const args = buildCodexArgs({ sessionId, cwd, prompt, images, settings });
    const envFile = process.env.CODEX_ENV_FILE;
    const script = buildOwnerCodexScript(envFile);

    // Inject DeepSeek credentials. OPENAI_BASE_URL redirects codex to DeepSeek's
    // endpoint; OPENAI_API_KEY carries the DeepSeek secret. We explicitly set both
    // so they win over anything inherited from the shell or CODEX_ENV_FILE.
    const env = buildChildEnv(process.env, {
      extra: {
        OPENAI_BASE_URL: DEEPSEEK_BASE_URL,
        OPENAI_API_KEY: String(apiKey || ''),
      },
    });

    const child = this.spawnImpl('bash', ['-lc', script, 'codex-deepseek', ...args], {
      cwd: cwd || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    child.killTree = (signal = 'SIGTERM') => terminateCodexProcess(child, signal);

    const rl = createInterface({ input: child.stdout });
    const seenTools = new Set();
    const TOOL_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);
    const emit = (ev) => { try { onEvent?.(ev); } catch {} };

    const basename = (p) => String(p || '').split('/').filter(Boolean).pop() || String(p || '');
    function toolFromItem(item) {
      switch (item && item.type) {
        case 'command_execution':
          return { name: 'Bash', input: String(item.command || '').replace(/\s+/g, ' ').slice(0, 120), detail: { command: item.command || '' } };
        case 'file_change': {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          const paths = changes.map((c) => c && c.path).filter(Boolean);
          const label = paths.length ? basename(paths[0]) + (paths.length > 1 ? ` +${paths.length - 1}` : '') : 'files';
          return { name: 'ApplyPatch', input: label, detail: { files: paths, changes } };
        }
        case 'mcp_tool_call':
          return { name: 'MCP', input: [item.server, item.tool].filter(Boolean).join('.') || item.name || 'tool', detail: item };
        case 'web_search':
          return { name: 'WebSearch', input: item.query || '', detail: item };
        default:
          return null;
      }
    }

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let o;
      try { o = JSON.parse(line); } catch { return; }

      if (o.type === 'thread.started' && o.thread_id) { emit({ type: 'session', id: o.thread_id }); return; }

      const tc = o.type === 'token_count' ? o : (o.type === 'event_msg' && o.payload && o.payload.type === 'token_count' ? o.payload : null);
      if (tc && tc.info) { emit({ type: 'context', info: tc.info }); return; }

      if (o.type === 'turn.completed') {
        if (o.usage) emit({ type: 'context', info: { last_token_usage: { input_tokens: Number(o.usage.input_tokens) || 0, output_tokens: Number(o.usage.output_tokens) || 0 } } });
        emit({ type: 'turn_end', status: o.status || 'completed' });
        return;
      }

      if (o.type === 'event_msg' && o.payload && o.payload.type === 'agent_message') {
        const text = String(o.payload.message || '').trim();
        if (text) emit({ type: 'notice', text });
        return;
      }

      const heartbeat = reasoningHeartbeat(o);
      if (heartbeat) { emit(heartbeat); return; }

      const item = o.item;
      if (o.type === 'item.started' && item && TOOL_ITEMS.has(item.type)) {
        const t = toolFromItem(item);
        if (!t) return;
        const id = item.id || `tool-${seenTools.size + 1}`;
        seenTools.add(id);
        emit({ type: 'tool', id, name: t.name, input: t.input, detail: t.detail });
        return;
      }

      if (o.type === 'item.completed' && item) {
        if (item.type === 'agent_message') { if (item.text) emit({ type: 'text', delta: item.text }); return; }
        if (item.type === 'error') {
          if (item.message && !/dangerously-bypass-hook-trust/.test(item.message)) emit({ type: 'notice', text: item.message });
          return;
        }
        if (TOOL_ITEMS.has(item.type)) {
          const t = toolFromItem(item);
          if (!t) return;
          const id = item.id || `tool-${seenTools.size || 1}`;
          if (!seenTools.has(id)) { seenTools.add(id); emit({ type: 'tool', id, name: t.name, input: t.input, detail: t.detail }); }
          const result = item.aggregated_output != null ? item.aggregated_output : (item.status ? `(${item.status})` : '');
          emit({ type: 'tool_result', id, content: result });
          return;
        }
        return;
      }

      if (o.type === 'turn.failed' || o.type === 'error') {
        emit({ type: 'error', msg: o.message || (o.error && o.error.message) || 'DeepSeek turn failed' });
      }
    });

    child.stderr.on('data', (d) => {
      const text = d.toString().trim();
      if (/^Reading additional input from stdin/.test(text)) return;
      if (text) emit({ type: 'notice', text: text.slice(0, 300) });
    });

    return child;
  }
}
