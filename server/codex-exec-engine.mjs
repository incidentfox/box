import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

function childEnv() {
  return { ...process.env };
}

function summarizeCommand(command) {
  return String(command || '').replace(/\s+/g, ' ').slice(0, 120);
}

const basename = (p) => String(p || '').split('/').filter(Boolean).pop() || String(p || '');

// Codex `exec --json` reports work as `item` events. Map the tool-bearing ones to the
// box's neutral tool-chip shape ({name,input,detail}) so the phone SEES what Codex is
// doing. Return null for non-tool items (text/reasoning/errors handled separately).
// Without file_change here, every code edit Codex makes is invisible — which made a
// hard-working delegated Codex agent look like it "did nothing".
function toolFromItem(item) {
  switch (item && item.type) {
    case 'command_execution':
      return { name: 'Bash', input: summarizeCommand(item.command), detail: { command: item.command || '' } };
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map((c) => c && c.path).filter(Boolean);
      const label = paths.length
        ? basename(paths[0]) + (paths.length > 1 ? ` +${paths.length - 1}` : '')
        : 'files';
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
const TOOL_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

export class CodexExecEngine {
  run({ sessionId, cwd, prompt, images = [], settings = {}, onEvent }) {
    const imageArgs = (images || []).flatMap((image) => ['-i', image]);
    const cfgArgs = [];
    if (settings.model) cfgArgs.push('--model', settings.model);
    if (settings.reasoningEffort) cfgArgs.push('-c', `model_reasoning_effort="${settings.reasoningEffort}"`);
    // Full-access, no-prompt mode (the `codex exec` equivalent of `--yolo`). The
    // box is itself the trust boundary, so we skip Codex's own sandbox — its
    // bubblewrap sandbox can't set up loopback networking here (bwrap: loopback
    // Failed RTM_NEWADDR) and blocks EVERY command otherwise. Applied to BOTH new
    // and resume turns (resume previously inherited no bypass → stayed sandboxed).
    const BYPASS = ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'];
    const args = sessionId
      ? ['exec', 'resume', '--json', ...cfgArgs, ...BYPASS, '--skip-git-repo-check', ...imageArgs, sessionId, prompt || '']
      : ['exec', '--json', ...cfgArgs, ...BYPASS, '--skip-git-repo-check', '-C', cwd || process.cwd(), ...imageArgs, prompt || ''];

    // Optionally source an env file before codex (set CODEX_ENV_FILE); otherwise just run codex.
    const envFile = process.env.CODEX_ENV_FILE;
    const script = (envFile ? `[ -f ${JSON.stringify(envFile)} ] && . ${JSON.stringify(envFile)}; ` : '') + 'exec codex "$@"';
    const child = spawn('bash', ['-lc', script, 'codex-mobile', ...args], {
      cwd: cwd || process.cwd(),
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const rl = createInterface({ input: child.stdout });
    const seenTools = new Set();

    const emit = (event) => {
      try { onEvent(event); } catch {}
    };

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let o;
      try { o = JSON.parse(line); } catch { return; }

      if (o.type === 'thread.started' && o.thread_id) {
        emit({ type: 'session', id: o.thread_id });
        return;
      }

      const tc = o.type === 'token_count' ? o : (o.type === 'event_msg' && o.payload && o.payload.type === 'token_count' ? o.payload : null);
      if (tc && tc.info) {
        emit({ type: 'context', info: tc.info });
        return;
      }

      // codex 0.135's `exec --json` no longer streams standalone token_count events on
      // stdout — per-turn token usage now rides on `turn.completed`. Without handling it
      // here the context meter is frozen at 0 / window for the whole Codex session (the
      // "0 / 258k" the phone showed). Synthesize the {last_token_usage} shape that
      // contextFromCodexInfo already understands so the meter just works.
      if (o.type === 'turn.completed' && o.usage) {
        emit({ type: 'context', info: { last_token_usage: {
          input_tokens: Number(o.usage.input_tokens) || 0,
          output_tokens: Number(o.usage.output_tokens) || 0,
        } } });
        return;
      }

      if (o.type === 'event_msg' && o.payload && o.payload.type === 'agent_message') {
        const text = String(o.payload.message || '').trim();
        if (text) emit({ type: 'notice', text });
        return;
      }

      const item = o.item;

      // A tool starts → open its chip immediately so progress is live, not retro.
      if (o.type === 'item.started' && item && TOOL_ITEMS.has(item.type)) {
        const t = toolFromItem(item);
        if (!t) return;
        const id = item.id || `tool-${seenTools.size + 1}`;
        seenTools.add(id);
        emit({ type: 'tool', id, name: t.name, input: t.input, detail: t.detail });
        return;
      }

      if (o.type === 'item.completed' && item) {
        if (item.type === 'agent_message') {
          if (item.text) emit({ type: 'text', delta: item.text });
          return;
        }
        if (item.type === 'error') {
          if (item.message && !/dangerously-bypass-hook-trust/.test(item.message)) emit({ type: 'notice', text: item.message });
          return;
        }
        if (TOOL_ITEMS.has(item.type)) {
          const t = toolFromItem(item);
          if (!t) return;
          const id = item.id || `tool-${seenTools.size || 1}`;
          // Items that never emitted item.started (or that we only see on completion) still
          // need their chip before the result lands.
          if (!seenTools.has(id)) {
            seenTools.add(id);
            emit({ type: 'tool', id, name: t.name, input: t.input, detail: t.detail });
          }
          const result = item.aggregated_output != null
            ? item.aggregated_output
            : (item.status ? `(${item.status})` : '');
          emit({ type: 'tool_result', id, content: result });
          return;
        }
        return;
      }

      if (o.type === 'turn.failed' || o.type === 'error') {
        emit({ type: 'error', msg: o.message || (o.error && o.error.message) || 'Codex turn failed' });
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
