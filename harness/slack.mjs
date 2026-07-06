#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSlackContext, slackEventForMessage, slackRecent, slackSearch } from '../server/slack-context.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HOME = homedir();

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
const extraEnv = loadEnvFile(process.env.EXTRA_ENV_FILE || localEnv.EXTRA_ENV_FILE || '');
const vaultEnv = loadEnvFile('/run/software-factory/secrets.env');
const cfg = (k, d = '') => process.env[k] || localEnv[k] || extraEnv[k] || vaultEnv[k] || d;

function usage(code = 0) {
  const out = `Usage:
  node harness/slack.mjs context [--json]
  node harness/slack.mjs recent [limit] [--json]
  node harness/slack.mjs search <query> [--json]
  node harness/slack.mjs emit-recent [--emit-existing]

Env:
  SLACK_USER_TOKEN or SLACK_BOT_TOKEN or SLACK_TOKEN
  SLACK_CHANNELS="#ops,C123..."          optional scope
  SLACK_CONTEXT_MAX_MESSAGES=12          optional
`;
  (code ? console.error : console.log)(out.trim());
  process.exit(code);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function printMaybeJson(data) {
  if (hasFlag('--json')) console.log(JSON.stringify(data, null, 2));
  else if (typeof data === 'string') console.log(data);
  else console.log(JSON.stringify(data, null, 2));
}

function cap(text) {
  const max = Number(cfg('SLACK_CONTEXT_MAX_CHARS', 5000)) || 5000;
  return String(text || '').length > max ? String(text).slice(0, max) + '\n[TRUNCATED Slack context]' : text;
}

function readSeen(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return new Set(Array.isArray(parsed.seen) ? parsed.seen : []);
  } catch {
    return new Set();
  }
}

function saveSeen(file, seen) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ seen: [...seen].slice(-1000), updatedAt: new Date().toISOString() }, null, 1));
}

async function emitRecent() {
  const r = await slackRecent({ cfg });
  if (!r.configured || r.error) {
    if (r.error) console.error(r.error);
    process.exit(r.configured ? 1 : 0);
  }
  const stateFile = join(HOME, '.cc-mobile', 'slack-events.json');
  const eventsFile = join(HOME, '.factory', 'events.jsonl');
  const seen = readSeen(stateFile);
  const firstRun = seen.size === 0 && !hasFlag('--emit-existing');
  const max = Number(cfg('SLACK_EVENT_MAX_PER_RUN', 10)) || 10;
  let emitted = 0;
  mkdirSync(dirname(eventsFile), { recursive: true });
  for (const msg of (r.messages || []).slice().reverse()) {
    const key = `${msg.channel_id || msg.channel}:${msg.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (firstRun || emitted >= max) continue;
    appendFileSync(eventsFile, JSON.stringify(slackEventForMessage(msg)) + '\n');
    emitted++;
  }
  saveSeen(stateFile, seen);
  console.log(firstRun ? `seeded ${seen.size} Slack message cursor(s)` : `emitted ${emitted} Slack event(s)`);
}

const cmd = process.argv[2] || 'context';
if (cmd === '-h' || cmd === '--help') usage(0);

if (cmd === 'context') {
  const out = await renderSlackContext({ cfg, includeErrors: hasFlag('--show-errors'), includeEmpty: false });
  if (out) printMaybeJson(hasFlag('--json') ? { context: out } : cap(out));
} else if (cmd === 'recent') {
  const limit = Number(process.argv.find((a, i) => i > 2 && /^\d+$/.test(a)) || 0);
  const r = await slackRecent({ cfg });
  if (limit && Array.isArray(r.messages)) r.messages = r.messages.slice(0, limit);
  printMaybeJson(r);
} else if (cmd === 'search') {
  const q = process.argv.slice(3).filter((a) => a !== '--json').join(' ').trim();
  if (!q) usage(1);
  printMaybeJson(await slackSearch({ query: q, cfg }));
} else if (cmd === 'emit-recent') {
  await emitRecent();
} else {
  usage(1);
}
