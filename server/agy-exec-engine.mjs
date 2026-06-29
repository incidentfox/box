import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function messageText(msg) {
  return (msg?.parts || [])
    .filter((p) => p && p.t === 'text' && p.text)
    .map((p) => String(p.text))
    .join('\n')
    .trim();
}

function compactTranscript(history = [], maxChars = 12000) {
  const rows = [];
  for (const msg of (history || []).slice(-24)) {
    const text = messageText(msg);
    if (!text) continue;
    rows.push(`${msg.role === 'assistant' ? 'Assistant' : 'User'}:\n${text}`);
  }
  let out = rows.join('\n\n---\n\n');
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  return out;
}

function buildPrompt(prompt, images, history) {
  const attachments = (images || []).map((p) => `[Image attached at ${p}]`).join('\n');
  const transcript = compactTranscript(history);
  const parts = [];
  if (transcript) {
    parts.push(`Use this prior Box conversation context:\n\n${transcript}`);
  }
  if (attachments) parts.push(attachments);
  parts.push(String(prompt || '').trim());
  return parts.filter(Boolean).join('\n\n---\n\n');
}

export class AgyExecEngine {
  run({ sessionId, cwd, prompt, images = [], settings = {}, history = [], command = 'agy', onEvent }) {
    const sid = sessionId || randomUUID();
    const args = [];
    if (settings.model) args.push('--model', settings.model);
    args.push('--print', buildPrompt(prompt, images, history));
    const child = spawn(command, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, PATH: `${process.env.HOME || ''}/.local/bin:${process.env.PATH || ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      const text = stdout.trim();
      if (code === 0 && text) onEvent?.({ type: 'text', delta: text });
      else onEvent?.({ type: 'error', msg: (stderr || stdout || `agy exited ${code}`).trim().slice(-800) });
    });
    return {
      sessionId: sid,
      on(event, cb) {
        if (event === 'close') child.on('close', cb);
        else if (event === 'error') child.on('error', cb);
        return this;
      },
      kill(signal = 'SIGTERM') {
        try { child.kill(signal); } catch {}
      },
    };
  }
}
