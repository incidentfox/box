import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

function childEnv() {
  return { ...process.env };
}

function summarizeCommand(command) {
  return String(command || '').replace(/\s+/g, ' ').slice(0, 120);
}

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

      if (o.type === 'item.started' && o.item && o.item.type === 'command_execution') {
        const id = o.item.id || `cmd-${seenTools.size + 1}`;
        seenTools.add(id);
        emit({
          type: 'tool',
          id,
          name: 'Bash',
          input: summarizeCommand(o.item.command),
          detail: { command: o.item.command || '' },
        });
        return;
      }

      if (o.type === 'item.completed' && o.item) {
        const item = o.item;
        if (item.type === 'agent_message' && item.text) {
          emit({ type: 'text', delta: item.text });
        } else if (item.type === 'command_execution') {
          const id = item.id || `cmd-${seenTools.size || 1}`;
          if (!seenTools.has(id)) {
            seenTools.add(id);
            emit({
              type: 'tool',
              id,
              name: 'Bash',
              input: summarizeCommand(item.command),
              detail: { command: item.command || '' },
            });
          }
          emit({ type: 'tool_result', id, content: item.aggregated_output || '' });
        } else if (item.type === 'error' && item.message && !/dangerously-bypass-hook-trust/.test(item.message)) {
          emit({ type: 'notice', text: item.message });
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
