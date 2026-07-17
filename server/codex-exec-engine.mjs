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

// Codex emits reasoning items while it is actively thinking, but they intentionally
// contain no user-visible chain-of-thought. Preserve that privacy while still turning
// the envelope into a heartbeat so Box does not claim the process has been idle.
export function reasoningHeartbeat(o) {
  const item = o && o.item;
  if (!item || (item.type !== 'reasoning' && item.type !== 'reasoning_summary')) return null;
  if (o.type !== 'item.started' && o.type !== 'item.completed') return null;
  return { type: 'thinking', delta: '' };
}

// Build the `codex` argv for one turn. Pure (no spawn) so it's unit-testable.
//
// CRITICAL ordering rule: the variadic `-i, --image <FILE>...` option goes LAST, after the
// positional prompt (and the session id, for resume). Codex's `-i` greedily consumes every
// following arg as another image path, so if images come before the prompt the final `-i`
// swallows the prompt (and, on resume, the session id). Codex then sees NO prompt → "Reading
// prompt from stdin... No prompt provided via stdin", exits before emitting `thread.started`,
// and the box never learns the session id — so an image message silently disappears from the
// chat list. Positionals first, variadic `-i …` last (end-of-args terminates the list).
export function buildCodexArgs({ sessionId, cwd, prompt, images = [], settings = {} } = {}) {
  const imageArgs = (images || []).flatMap((image) => ['-i', image]);
  const cfgArgs = [];
  if (settings.model) cfgArgs.push('--model', settings.model);
  if (settings.reasoningEffort) cfgArgs.push('-c', `model_reasoning_effort="${settings.reasoningEffort}"`);
  // Sandbox policy. DEFAULT = OFF (full access, no prompts) — the box is a single-user trust
  // boundary, so confining Codex just gets in the owner's way. Self-hosters who DO want Codex
  // confined can set `CODEX_SANDBOX=workspace-write` (or `read-only`) in their .env; anything
  // falsy / `off` / `none` keeps it off. Off maps to `--dangerously-bypass-approvals-and-sandbox`
  // (the box runs unattended, so there's nothing to approve), exactly as it did before #40.
  //
  // FLAG PLACEMENT — the resume bug #40 introduced: `-s/--sandbox` is an option of `codex exec`
  // (the parent), NOT of the `resume` subcommand, so `codex exec resume … --sandbox …` dies with
  // "error: unexpected argument '--sandbox' found". When sandboxing it must therefore go BEFORE
  // the `resume` token (an exec-level option). The `--dangerously-bypass-*` flags ARE valid on
  // `resume`, so the default (off) path is uniform for new and resume turns. `--json` / `--model`
  // / `-c` / `--skip-git-repo-check` are all accepted on `resume` and stay after it.
  const mode = String(settings.sandbox || process.env.CODEX_SANDBOX || '').trim().toLowerCase();
  const sandboxed = mode && mode !== 'off' && mode !== 'none' && mode !== 'false';
  // Exec-level flags that must precede the `resume` subcommand:
  const PRE = sandboxed ? ['--sandbox', mode] : [];
  // Bypass flags (off path) — valid on both `exec` and `exec resume`:
  const BYPASS = sandboxed ? [] : ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'];
  return sessionId
    ? ['exec', ...PRE, 'resume', '--json', ...cfgArgs, ...BYPASS, '--skip-git-repo-check', sessionId, prompt || '', ...imageArgs]
    : ['exec', '--json', ...cfgArgs, ...PRE, ...BYPASS, '--skip-git-repo-check', '-C', cwd || process.cwd(), prompt || '', ...imageArgs];
}

export class CodexExecEngine {
  run({ sessionId, cwd, prompt, images = [], settings = {}, onEvent }) {
    const args = buildCodexArgs({ sessionId, cwd, prompt, images, settings });

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
      const heartbeat = reasoningHeartbeat(o);
      if (heartbeat) {
        emit(heartbeat);
        return;
      }

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
