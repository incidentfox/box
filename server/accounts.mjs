// Box ↔ cc-account-broker glue. Creates/logs-in account config dirs and
// registers them with the broker so the /usr/bin/claude wrapper can pool them.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { genPkce, genState, buildAuthUrl, parsePasted, exchangeCode, fetchProfile, subscriptionFromProfile, credentialsJson, OAUTH } from './oauth.mjs';

const execFileP = promisify(execFile);
const HOME = process.env.HOME || os.homedir();
const NODE = process.execPath;
const BROKER = process.env.CC_BROKER_JS || path.join(HOME, '.box', 'cc-account-broker', 'broker.mjs');
const PRIMARY_DIR = path.join(HOME, '.claude');
const ACCTS_DIR = path.join(HOME, '.cc-accounts');
const PENDING_FILE = path.join(ACCTS_DIR, 'pending-oauth.json');
const PENDING_TTL_MS = 15 * 60 * 1000;

export const brokerInstalled = () => fs.existsSync(BROKER);

async function broker(args) {
  const { stdout, stderr } = await execFileP(NODE, [BROKER, ...args], { timeout: 20000 });
  return (stdout || '').trim() || (stderr || '').trim();
}

// ---- account id / dir helpers --------------------------------------------
export function sanitizeId(raw) {
  const id = String(raw || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!id || id === 'mine') throw new Error('Pick a different account name (not empty, not "mine").');
  return id;
}
const dirForId = (id) => path.join(HOME, '.claude-' + id);

// Make a config dir behave like the primary: share read-mostly config, own creds.
function prepareDir(dir) {
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  for (const d of ['skills', 'commands', 'plugins', 'hooks']) {
    const src = path.join(PRIMARY_DIR, d), dst = path.join(dir, d);
    try { if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst); } catch { /* best effort */ }
  }
  for (const f of ['settings.json', 'CLAUDE.md']) {
    const src = path.join(PRIMARY_DIR, f), dst = path.join(dir, f);
    try { if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst); } catch { /* best effort */ }
  }
}

// ---- pending OAuth flows (survive a server restart mid-login) -------------
function loadPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch { return {}; }
}
function savePending(p) {
  fs.mkdirSync(ACCTS_DIR, { recursive: true });
  const tmp = PENDING_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p), { mode: 0o600 });
  fs.renameSync(tmp, PENDING_FILE);
}
function prunePending(p) {
  const now = Date.now();
  for (const [k, v] of Object.entries(p)) if (!v?.ts || now - v.ts > PENDING_TTL_MS) delete p[k];
  return p;
}

// ---- public operations ----------------------------------------------------
export async function listAccounts() {
  if (!brokerInstalled()) return { installed: false, accounts: [], primary: null };
  try { return { installed: true, ...JSON.parse(await broker(['list', '--json'])) }; }
  catch (e) { return { installed: true, error: String(e.message || e), accounts: [], primary: null }; }
}

export async function startOAuth({ id, label, email }) {
  const accountId = sanitizeId(id);
  const dir = dirForId(accountId);
  prepareDir(dir);
  const { verifier, challenge } = genPkce();
  const state = genState();
  const url = buildAuthUrl({ challenge, state, loginHint: email });
  const flowId = crypto.randomBytes(12).toString('hex');
  const p = prunePending(loadPending());
  p[flowId] = { id: accountId, label: label || accountId, dir, verifier, state, ts: Date.now() };
  savePending(p);
  return { flowId, url };
}

export async function completeOAuth({ flowId, code }) {
  const p = prunePending(loadPending());
  const f = p[flowId];
  if (!f) throw new Error('Login session expired — start the login again.');
  const parsed = parsePasted(code, f.state);
  if (!parsed?.code) throw new Error('No authorization code found in what you pasted.');
  const tok = await exchangeCode({ code: parsed.code, state: parsed.state, verifier: f.verifier });
  const profile = await fetchProfile(tok.access_token);
  const subscriptionType = subscriptionFromProfile(profile);
  const email = profile?.account?.email || tok.account?.email_address || null;

  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(path.join(f.dir, '.credentials.json'), JSON.stringify(credentialsJson(tok, subscriptionType)), { mode: 0o600 });

  await broker(['register', f.id, '--dir', f.dir, '--label', f.label, '--type', 'oauth', ...(email ? ['--email', email] : [])]);
  delete p[flowId]; savePending(p);
  return { ok: true, id: f.id, email, subscriptionType };
}

export async function saveApiKey({ id, label, apiKey }) {
  const accountId = sanitizeId(id);
  const key = String(apiKey || '').trim();
  if (!/^sk-ant-/.test(key)) throw new Error('That does not look like an Anthropic API key (expected sk-ant-…).');
  // Lightweight validation: a cheap authenticated call.
  let valid = null, vmsg = '';
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10000),
    });
    valid = res.ok; if (!res.ok) vmsg = `Anthropic API rejected the key (HTTP ${res.status}).`;
  } catch (e) { valid = null; vmsg = 'Could not reach Anthropic to validate the key (saved anyway).'; }
  if (valid === false) throw new Error(vmsg);

  const dir = dirForId(accountId);
  prepareDir(dir);
  fs.writeFileSync(path.join(dir, 'api-key'), key + '\n', { mode: 0o600 });
  await broker(['register', accountId, '--dir', dir, '--label', label || accountId, '--type', 'apikey']);
  return { ok: true, id: accountId, validated: valid === true, note: valid === null ? vmsg : '' };
}

// For operations on an EXISTING account (incl. "mine"): validate charset only —
// do NOT use sanitizeId (it's for NEW names and rejects the reserved "mine").
const existingId = (id) => { const s = String(id || '').trim(); if (!/^[a-z0-9_-]+$/i.test(s)) throw new Error('bad account id'); return s; };

export async function removeAccount(id) { await broker(['remove', existingId(id)]); return { ok: true }; }
export async function setPrimary(id) { await broker(['primary', existingId(id)]); return { ok: true }; }
export async function cooldown(id, minutes) { await broker(['cooldown', existingId(id), '--minutes', String(minutes || 90), '--reason', 'manual']); return { ok: true }; }
export async function clearCooldown(id) { await broker(['clear', existingId(id)]); return { ok: true }; }

// Move a live session onto another account (transcript relocation + affinity in the
// broker). The HTTP layer stops the old bridge first so the transcript isn't mid-write.
export async function switchSession(sessionId, accountId) {
  if (!sessionId) throw new Error('sessionId required');
  const out = await broker(['switch', String(sessionId), existingId(accountId)]);
  try { return JSON.parse(out.trim().split('\n').pop()); } catch { return { ok: true, accountId }; }
}

export const consoleKeysUrl = OAUTH.CONSOLE_KEYS_URL;

// Where the user manages/buys usage (payment is Anthropic-hosted; we just deep-link).
export const manageUsageUrls = {
  subscription: 'https://claude.ai/settings/usage',   // enable/cap extra usage on a Max/Pro plan
  console: 'https://console.anthropic.com/settings/billing', // API/console credits
};

// Trigger a one-shot usage poll (refresh utilization for the dialog), then re-list.
export async function refreshUsage() {
  const POLL = path.join(path.dirname(BROKER), 'usage-poll.mjs');
  if (fs.existsSync(POLL)) { try { await execFileP(NODE, [POLL, '--once'], { timeout: 30000 }); } catch { /* best effort */ } }
  return listAccounts();
}
