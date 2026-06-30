// Provider login — sign in to Codex (OpenAI) and Gemini (Google) from the phone, the same
// way the Claude accounts flow works, so people can use their SUBSCRIPTION or an API KEY.
//
// Unlike Claude (multi-account, pooled via cc-account-broker), the codex/gemini CLIs are
// single-account: each reads ONE credential location. So this is a per-provider "who am I
// signed in as + sign in / out", not a pool.
//
//   Codex  → `codex login --device-auth` (device-code: URL + code, the CLI polls) writes
//            ~/.codex/auth.json (auth_mode=chatgpt). API key: `codex login --with-api-key`.
//   Gemini → no `login` command, so we drive the interactive picker over a PTY: NO_BROWSER +
//            "Sign in with Google" prints a Google OAuth URL and waits for the pasted code,
//            then writes ~/.gemini/oauth_creds.json. API key: ~/.gemini/.env (CLI reads it).
//
// Each flow lives in memory (it holds a live child process), keyed by a flowId the UI polls.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const HOME = process.env.HOME || os.homedir();
const CODEX_AUTH = path.join(HOME, '.codex', 'auth.json');
const GEMINI_DIR = path.join(HOME, '.gemini');
const GEMINI_ENV = path.join(GEMINI_DIR, '.env');
const GEMINI_OAUTH = path.join(GEMINI_DIR, 'oauth_creds.json');
const GEMINI_SETTINGS = path.join(GEMINI_DIR, 'settings.json');

const FLOW_TTL_MS = 16 * 60 * 1000;          // device/OAuth codes expire ~15 min
const flows = new Map();                      // flowId -> { provider, child, status, url, code, error, ts }

const newId = () => crypto.randomBytes(12).toString('hex');
const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][AB0]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pruneFlows() {
  const now = Date.now();
  for (const [k, f] of flows) {
    if (now - f.ts > FLOW_TTL_MS) { try { f.child?.kill?.(); } catch {} flows.delete(k); }
  }
}

// ---- status ---------------------------------------------------------------
function jsonRead(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function codexStatus() {
  const a = jsonRead(CODEX_AUTH);
  if (!a) return { mode: 'none' };
  if (a.auth_mode === 'apikey' || (a.OPENAI_API_KEY && !a.tokens)) return { mode: 'apikey', label: 'API key' };
  if (a.tokens || a.auth_mode === 'chatgpt' || a.id_token) {
    let email = '';
    try { email = a.tokens?.account_id ? '' : ''; } catch {}
    return { mode: 'subscription', label: email || 'ChatGPT account' };
  }
  return { mode: 'none' };
}

function geminiHasKey() {
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return true;
  try { return /(?:^|\n)\s*(GEMINI_API_KEY|GOOGLE_API_KEY)\s*=/.test(fs.readFileSync(GEMINI_ENV, 'utf8')); } catch { return false; }
}
function geminiStatus() {
  if (fs.existsSync(GEMINI_OAUTH)) {
    let email = '';
    try { email = jsonRead(path.join(GEMINI_DIR, 'google_accounts.json'))?.active || ''; } catch {}
    return { mode: 'subscription', label: email || 'Google account' };
  }
  if (geminiHasKey()) return { mode: 'apikey', label: 'API key' };
  return { mode: 'none' };
}

export function providerStatus() {
  pruneFlows();
  return { codex: codexStatus(), gemini: geminiStatus() };
}

// ---- shared: spawn a CLI, feed stdin, resolve on exit ---------------------
function runOnce(cmd, args, { input, env, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e.message || e) }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    if (input != null) { try { child.stdin.write(input); } catch {} }
    try { child.stdin.end(); } catch {}
  });
}

// ---- Codex: device-code subscription login --------------------------------
export async function codexDeviceStart() {
  pruneFlows();
  const flowId = newId();
  const child = spawn('codex', ['login', '--device-auth'], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const flow = { provider: 'codex', child, status: 'pending', url: '', code: '', error: '', ts: Date.now() };
  flows.set(flowId, flow);
  const scan = (buf) => {
    const s = stripAnsi(buf.toString());
    const url = s.match(/https?:\/\/\S*device\S*/i) || s.match(/https?:\/\/auth\.openai\.com\/\S+/i);
    if (url && !flow.url) flow.url = url[0].replace(/[)\].,]+$/, '');
    const code = s.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/);
    if (code && !flow.code) flow.code = code[0];
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('close', (code) => {
    if (flow.status === 'pending') {
      // exit 0 = the user completed the device flow and the CLI wrote auth.json.
      flow.status = code === 0 && codexStatus().mode === 'subscription' ? 'success' : 'error';
      if (flow.status === 'error' && !flow.error) flow.error = code === 0 ? 'Login did not complete' : 'Login canceled or timed out';
    }
  });
  // Wait briefly for the URL + code to be printed before answering the UI.
  for (let i = 0; i < 60 && (!flow.url || !flow.code); i++) await sleep(150);
  if (!flow.url) { try { child.kill(); } catch {} ; flows.delete(flowId); throw new Error('Codex did not return a device-login link. Is the codex CLI installed and reachable?'); }
  return { flowId, url: flow.url, code: flow.code, verb: 'enter this code at the link' };
}

export function loginPoll(flowId) {
  pruneFlows();
  const f = flows.get(flowId);
  if (!f) return { status: 'expired' };
  const out = { status: f.status, url: f.url, code: f.code, error: f.error };
  if (f.status === 'success') out.account = (f.provider === 'codex' ? codexStatus() : geminiStatus()).label;
  if (f.status !== 'pending') { /* keep until TTL so a late poll still sees the result */ }
  return out;
}

export async function codexApiKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (!/^sk-/.test(key)) throw new Error('That does not look like an OpenAI API key (expected sk-…).');
  const r = await runOnce('codex', ['login', '--with-api-key'], { input: key });
  if (r.code !== 0) throw new Error(`codex rejected the key: ${(stripAnsi(r.err) || stripAnsi(r.out) || `exit ${r.code}`).trim().slice(-200)}`);
  return { ok: true, status: codexStatus() };
}

// ---- Gemini: Google sign-in over a PTY ------------------------------------
function loadPty() {
  try { return require('node-pty'); } catch (e) { throw new Error('node-pty is not available (needed for Gemini Google sign-in). Use an API key instead.'); }
}

export async function geminiGoogleStart() {
  pruneFlows();
  const pty = loadPty();
  const flowId = newId();
  // Force the interactive Google-OAuth path: no API key in env, NO_BROWSER so the CLI prints
  // the URL + waits for a pasted code, GCA = the Code Assist (subscription/free) login.
  const env = { ...process.env, NO_BROWSER: '1', GOOGLE_GENAI_USE_GCA: 'true', TERM: 'xterm-256color' };
  delete env.GEMINI_API_KEY; delete env.GOOGLE_API_KEY; delete env.GOOGLE_AI_STUDIO_API_KEY;
  const child = pty.spawn('gemini', ['--skip-trust'], { name: 'xterm-256color', cols: 100, rows: 30, cwd: HOME, env });
  const flow = { provider: 'gemini', child, status: 'pending', url: '', code: '', error: '', ts: Date.now(), promptedForCode: false, buf: '' };
  flows.set(flowId, flow);
  let pickedGoogle = false;
  child.onData((d) => {
    flow.buf = (flow.buf + d).slice(-8000);
    const clean = stripAnsi(flow.buf);
    // The auth picker defaults to "1. Sign in with Google" — Enter selects it.
    if (!pickedGoogle && /Sign in with Google/i.test(clean)) { pickedGoogle = true; setTimeout(() => { try { child.write('\r'); } catch {} }, 400); }
    const m = clean.match(/https?:\/\/accounts\.google\.com\/[^\s'")]+/);
    if (m && !flow.url) flow.url = m[0];
    if (/Enter the authorization code/i.test(clean)) flow.promptedForCode = true;
  });
  child.onExit(({ exitCode }) => {
    if (flow.status === 'pending') {
      flow.status = fs.existsSync(GEMINI_OAUTH) ? 'success' : 'error';
      if (flow.status === 'error' && !flow.error) flow.error = `Gemini sign-in exited (${exitCode})`;
    }
  });
  for (let i = 0; i < 80 && !(flow.url && flow.promptedForCode); i++) await sleep(150);
  if (!flow.url) { try { child.kill(); } catch {} ; flows.delete(flowId); throw new Error('Gemini did not produce a Google sign-in link.'); }
  return { flowId, url: flow.url, verb: 'sign in, then paste the code Google gives you' };
}

export async function geminiGoogleComplete(flowId, code) {
  const f = flows.get(flowId);
  if (!f || f.provider !== 'gemini') throw new Error('Sign-in session expired — start again.');
  const c = String(code || '').trim();
  if (!c) throw new Error('Paste the authorization code from Google.');
  try { f.child.write(c + '\r'); } catch { throw new Error('Sign-in session is no longer active — start again.'); }
  // The CLI exchanges the code, writes oauth_creds.json, then "restarts" — watch for the creds file.
  for (let i = 0; i < 80; i++) {
    if (fs.existsSync(GEMINI_OAUTH)) { f.status = 'success'; setGeminiAuthType('oauth-personal'); try { f.child.kill(); } catch {} return { ok: true, status: geminiStatus() }; }
    if (f.status === 'error') break;
    await sleep(250);
  }
  const tail = stripAnsi(f.buf).split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' ');
  throw new Error(`Sign-in didn't complete${tail ? ': ' + tail.slice(-180) : ''}. Double-check the code and try again.`);
}

// ---- Gemini: API key ------------------------------------------------------
function setGeminiAuthType(type) {
  // Persist the chosen auth method so the CLI doesn't re-prompt. (gemini-api-key | oauth-personal)
  let s = jsonRead(GEMINI_SETTINGS) || {};
  s.security = s.security || {};
  s.security.auth = { ...(s.security.auth || {}), selectedType: type };
  try { fs.mkdirSync(GEMINI_DIR, { recursive: true }); fs.writeFileSync(GEMINI_SETTINGS, JSON.stringify(s, null, 2) + '\n'); } catch {}
}

export async function geminiApiKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (key.length < 20 || /\s/.test(key)) throw new Error('That does not look like a Google AI / Gemini API key.');
  // Validate against the models endpoint.
  let ok = null, msg = '';
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10000) });
    ok = res.ok; if (!res.ok) msg = `Google rejected the key (HTTP ${res.status}).`;
  } catch { ok = null; msg = 'Could not reach Google to validate the key (saved anyway).'; }
  if (ok === false) throw new Error(msg);
  // The gemini CLI reads ~/.gemini/.env natively; the box engine also picks it up.
  fs.mkdirSync(GEMINI_DIR, { recursive: true });
  let env = '';
  try { env = fs.readFileSync(GEMINI_ENV, 'utf8'); } catch {}
  env = env.split('\n').filter((l) => !/^\s*(GEMINI_API_KEY|GOOGLE_API_KEY)\s*=/.test(l)).join('\n').trim();
  env = (env ? env + '\n' : '') + `GEMINI_API_KEY=${key}\n`;
  fs.writeFileSync(GEMINI_ENV, env, { mode: 0o600 });
  // Drop any stale Google OAuth creds so status reflects api-key, and pin the auth type.
  try { fs.rmSync(GEMINI_OAUTH, { force: true }); } catch {}
  setGeminiAuthType('gemini-api-key');
  return { ok: true, validated: ok === true, note: ok === null ? msg : '', status: geminiStatus() };
}

// ---- logout ---------------------------------------------------------------
export async function providerLogout(provider) {
  if (provider === 'codex') {
    try { await runOnce('codex', ['logout'], { timeout: 15000 }); } catch {}
    try { fs.rmSync(CODEX_AUTH, { force: true }); } catch {}
    return { ok: true, status: codexStatus() };
  }
  if (provider === 'gemini') {
    try { fs.rmSync(GEMINI_OAUTH, { force: true }); } catch {}
    try {
      let env = fs.readFileSync(GEMINI_ENV, 'utf8');
      env = env.split('\n').filter((l) => !/^\s*(GEMINI_API_KEY|GOOGLE_API_KEY)\s*=/.test(l)).join('\n');
      fs.writeFileSync(GEMINI_ENV, env, { mode: 0o600 });
    } catch {}
    setGeminiAuthType('');
    return { ok: true, status: geminiStatus() };
  }
  throw new Error('unknown provider');
}

export const providerMeta = {
  codex: { label: 'Codex (OpenAI)', keysUrl: 'https://platform.openai.com/api-keys', sub: 'ChatGPT Plus/Pro' },
  gemini: { label: 'Gemini (Google)', keysUrl: 'https://aistudio.google.com/apikey', sub: 'Google / Code Assist' },
};
