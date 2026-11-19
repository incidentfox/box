import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { buildChildEnv } from './child-env.mjs';

const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };

// The SDK initialize response is Claude Code's own selector catalog. In particular,
// use its resolvedModel instead of pinning moving aliases such as "opus" ourselves.
export function normalizeClaudeModels(models) {
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  return models.flatMap((model) => {
    if (!model || typeof model !== 'object') return [];
    const resolved = model.resolvedModel || model.value;
    if (typeof resolved !== 'string' || !/^claude-[a-z0-9-]+(?:\[1m\])?$/.test(resolved)) return [];
    const id = resolved.replace(/\[1m\]$/, '') + (/\[1m\]$/.test(resolved) || /\[1m\]$/.test(model.value || '') ? '[1m]' : '');
    // Default and named aliases often resolve to the same concrete model.
    if (seen.has(id)) return [];
    seen.add(id);
    const version = id.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
    const label = version ? `Claude ${version[1][0].toUpperCase()}${version[1].slice(1)} ${version[2]}.${version[3]}${id.endsWith('[1m]') ? ' (1M)' : ''}` : String(model.displayName || id);
    const efforts = model.supportsEffort === false ? [] : [...new Set(Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels : [])]
      .filter((effort) => typeof effort === 'string' && /^[a-z][a-z0-9_-]{0,30}$/.test(effort))
      .map((effort) => ({ id: effort, label: EFFORT_LABELS[effort] || effort, desc: '' }));
    const preferred = model.defaultEffort ?? model.defaultEffortLevel;
    const defaultEffort = efforts.some((effort) => effort.id === preferred) ? preferred
      : efforts.some((effort) => effort.id === 'medium') ? 'medium' : efforts[0]?.id || '';
    return [{ id, label, desc: typeof model.description === 'string' ? model.description : '', efforts, defaultEffort }];
  });
}

// Initialize the control channel only: never send a user message or start a paid
// model turn. Bare mode skips hooks, plugins, MCP and project instructions.
export function discoverClaudeModels({ spawnImpl = spawn, env = process.env, timeoutMs = 15000, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let buffer = '';
    let bytes = 0;
    let timer;
    const finish = (error, models) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.stdin?.end();
      child?.kill('SIGTERM');
      if (child) {
        const killTimer = setTimeout(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); }, 1000);
        killTimer.unref?.();
        child.once('close', () => clearTimeout(killTimer));
      }
      if (error) reject(error); else resolve(models);
    };
    try {
      child = spawnImpl('claude', ['--bare', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '-p'], {
        cwd: tmpdir(), env: { ...buildChildEnv(env), CLAUDECODE: '' }, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { finish(new Error('Claude model discovery could not start')); return; }
    timer = setTimeout(() => finish(new Error('Claude model discovery timed out')), timeoutMs);
    child.on('error', () => finish(new Error('Claude model discovery could not start')));
    child.on('close', () => finish(new Error('Claude model discovery exited before returning a catalog')));
    child.stdin.on('error', () => finish(new Error('Claude model discovery input closed')));
    child.stderr.on('data', () => {}); // Never forward account or configuration diagnostics.
    child.stdout.on('data', (data) => {
      if (settled) return;
      bytes += Buffer.byteLength(data);
      if (bytes > maxBytes) { finish(new Error('Claude model discovery output limit exceeded')); return; }
      buffer += data.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0 && !settled) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.type !== 'control_response' || message.response?.request_id !== 'box-model-catalog') continue;
        const models = normalizeClaudeModels(message.response?.response?.models);
        if (message.response?.subtype === 'error' || !models.length) finish(new Error('Claude model discovery returned no supported models'));
        else finish(null, models);
      }
    });
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'box-model-catalog', request: { subtype: 'initialize', hooks: {} } })}\n`);
  });
}
