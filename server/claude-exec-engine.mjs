import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { buildUnixTeamSandbox } from './team-sandbox.mjs';
import { terminateCodexProcess } from './codex-exec-engine.mjs';
import { normalizeClaudeModel } from './claude-model.mjs';

export function buildClaudeArgs({ sessionId, prompt, settings = {}, isNew = false } = {}) {
  const cfg = ['--model', normalizeClaudeModel(settings.model)];
  if (settings.reasoningEffort) cfg.push('--effort', settings.reasoningEffort);
  return ['--bare', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', ...cfg,
    ...(isNew ? ['--session-id', sessionId] : ['--resume', sessionId]), '-p', prompt || ''];
}

function emitRecord(o, emit) {
  if (o.type === 'system' && o.subtype === 'init' && o.session_id) emit({ type: 'session', id: o.session_id });
  if (o.type === 'assistant') for (const part of o.message && o.message.content || []) {
    if (part.type === 'text' && part.text) emit({ type: 'text', delta: part.text });
    if (part.type === 'tool_use') emit({ type: 'tool', id: part.id, name: part.name || 'Tool', input: JSON.stringify(part.input || {}), detail: part.input || {} });
  }
  if (o.type === 'result') {
    if (o.is_error) emit({ type: 'error', message: o.result || 'Claude failed' });
    emit({ type: 'turn_end', status: o.subtype || 'completed' });
  }
  if (o.type === 'error') emit({ type: 'error', message: o.error && o.error.message || o.message || 'Claude failed' });
}

export class ClaudeExecEngine {
  constructor({ spawnImpl = spawn } = {}) { this.spawnImpl = spawnImpl; }
  run({ sessionId, isNew, cwd, prompt, settings = {}, teamWorkspace, teamEnv = {}, teamUser = '', onEvent }) {
    const launch = buildUnixTeamSandbox({ runtime: 'claude', workspaceRoot: teamWorkspace, cwd,
      args: buildClaudeArgs({ sessionId, prompt, settings, isNew }), env: teamEnv, user: teamUser });
    const child = this.spawnImpl(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    child.stdin.end(launch.envInput);
    child.killTree = (signal = 'SIGTERM') => terminateCodexProcess(child, signal);
    const emit = (event) => { try { onEvent(event); } catch {} };
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => { try { emitRecord(JSON.parse(line), emit); } catch {} });
    child.stderr.on('data', (d) => emit({ type: 'stderr', text: d.toString() }));
    child.on('error', (e) => emit({ type: 'error', message: e.message }));
    child.on('close', (code) => emit({ type: 'close', code }));
    return child;
  }
}
