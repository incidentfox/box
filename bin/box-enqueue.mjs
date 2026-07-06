#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnvFile(path) {
  const out = {};
  if (!path || !existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const localEnv = loadEnvFile(join(ROOT, '.env'));
const cfg = (k, d = '') => process.env[k] || localEnv[k] || d;

function usage(code = 0) {
  const out = `Usage:
  node bin/box-enqueue.mjs --agent mac --title "Do browser task" --text "..."
  echo "task" | node bin/box-enqueue.mjs --agent codex --title "Background task"

Options:
  --agent claude|codex|gemini|agy|mac   default: configured app default
  --title "..."
  --cwd /path
  --key new-custom
  --text "..."                          defaults to stdin
  --base http://127.0.0.1:7321
  --dry-run
`;
  (code ? console.error : console.log)(out.trim());
  process.exit(code);
}

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') usage(0);
  if (!a.startsWith('--')) usage(1);
  const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (key === 'dryRun') opt.dryRun = true;
  else opt[key] = args[++i] || '';
}

let text = opt.text || '';
if (!text && !process.stdin.isTTY) {
  text = await new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf.trim()));
  });
}
if (!text) usage(1);

const token = cfg('CC_AUTH_TOKEN');
if (!token) throw new Error('CC_AUTH_TOKEN missing (set env or run from a Box checkout with .env)');
const base = String(opt.base || cfg('BOX_BASE_URL') || `http://127.0.0.1:${cfg('PORT', 7321)}`).replace(/\/$/, '');
const body = {
  text,
  agent: opt.agent,
  title: opt.title,
  cwd: opt.cwd,
  key: opt.key,
  dry_run: !!opt.dryRun,
};
for (const k of Object.keys(body)) if (body[k] == null || body[k] === '') delete body[k];

const r = await fetch(`${base}/api/agent/enqueue`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const j = await r.json().catch(() => ({}));
if (!r.ok) {
  console.error(JSON.stringify(j, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(j, null, 2));
