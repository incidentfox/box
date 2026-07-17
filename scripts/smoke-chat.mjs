#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';

const { values: v } = parseArgs({
  options: {
    root: { type: 'string' },
    port: { type: 'string' },
    token: { type: 'string' },
    timeout: { type: 'string' },
    agent: { type: 'string' },
    model: { type: 'string' },
    prompt: { type: 'string' },
    expect: { type: 'string' },
    'fake-codex': { type: 'boolean' },
    keep: { type: 'boolean' },
  },
});

const ROOT = resolve(v.root || process.cwd());
const TIMEOUT_MS = Number(v.timeout || process.env.BOX_SMOKE_TIMEOUT_MS || 120000);
const TOKEN = v.token || `smoke-${process.pid}-${Date.now()}`;
const AGENT = v.agent || process.env.BOX_SMOKE_AGENT || 'codex';
const MODEL = v.model || process.env.BOX_SMOKE_MODEL || 'gpt-4.1-mini';
const EXPECT = v.expect || 'BOX_SMOKE_OK';
const PROMPT = v.prompt || `Respond with exactly ${EXPECT} and nothing else.`;
const REAL_HOME = process.env.HOME || homedir();
const REAL_CODEX_HOME = process.env.CODEX_HOME || join(REAL_HOME, '.codex');

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolvePort(addr.port));
    });
    srv.on('error', reject);
  });
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function waitForConfig(base, token, deadline) {
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/config`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) return await r.json();
      last = `${r.status} ${await r.text().catch(() => '')}`.trim();
    } catch (e) {
      last = String(e && e.message || e);
    }
    await wait(400);
  }
  throw new Error(`server did not become ready: ${last}`);
}

function writeFakeCodex(dir) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'codex');
  writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-smoke-stub 1.0.0'); process.exit(0); }
if (args[0] !== 'exec') { console.error('codex smoke stub only supports exec'); process.exit(2); }
const thread = '00000000-0000-4000-8000-' + String(process.pid).padStart(12, '0').slice(-12);
console.log(JSON.stringify({ type: 'thread.started', thread_id: thread }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: process.env.BOX_FAKE_CODEX_RESPONSE || 'BOX_SMOKE_OK' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`, 'utf8');
  chmodSync(bin, 0o755);
  return dir;
}

function startServer({ port, home, fakeBin }) {
  const workspace = join(home, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    CC_AUTH_TOKEN: TOKEN,
    PORT: String(port),
    CC_WORKSPACE: workspace,
    LINEAR_API_KEY: '',
    LINEAR_TEAM_ID: '',
    LINEAR_TEAM_KEY: 'TASK',
    EXTRA_ENV_FILE: '',
    BOX_IGNORE_LOCAL_ENV: '1',
    BOX_SKIP_META_PROBE: '1',
    BOX_OVERLAY: join(home, '.config', 'box', 'box.local.mjs'),
    CODEX_HOME: REAL_CODEX_HOME,
    PATH: fakeBin ? `${fakeBin}:${process.env.PATH || ''}` : process.env.PATH || '',
  };
  try { symlinkSync(REAL_CODEX_HOME, join(home, '.codex'), 'dir'); } catch {}
  return spawn(process.execPath, [join(ROOT, 'server', 'index.mjs')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function smokeTurn(base, token, { key, cwd, agent, model, deadline }) {
  return new Promise((resolveTurn, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
    let text = '';
    let sessionId = '';
    let sawSync = false;
    const activity = [];
    let finished = false;
    const timer = setInterval(() => {
      if (Date.now() < deadline || finished) return;
      finished = true;
      try { ws.close(); } catch {}
      reject(new Error(`smoke timed out; session=${sessionId || '(none)'} text=${JSON.stringify(text.slice(-240))}`));
    }, 500);
    const done = (value) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      try { ws.close(); } catch {}
      resolveTurn(value);
    };
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', key }));
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.activityAt && msg.activityLabel) activity.push({ type: msg.type, at: msg.activityAt, label: msg.activityLabel });
      if (msg.type === 'sync' && !sawSync) {
        sawSync = true;
        ws.send(JSON.stringify({
          type: 'settings',
          key,
          cwd,
          settings: { codex: { model, reasoningEffort: 'low', sandbox: 'off' } },
        }));
        ws.send(JSON.stringify({
          type: 'enqueue',
          key,
          agent,
          cwd,
          title: 'Box smoke',
          text: PROMPT,
          displayText: PROMPT,
        }));
      } else if (msg.type === 'session' && msg.id) {
        sessionId = msg.id;
      } else if (msg.type === 'text') {
        text += msg.delta || '';
      } else if (msg.type === 'error') {
        done({ ok: false, error: msg.msg || 'server emitted error', sessionId, text });
      } else if (msg.type === 'done') {
        sessionId = msg.sessionId || sessionId;
        const ok = text.includes(EXPECT) && activity.length > 0;
        done({ ok, sessionId, text, activity, error: ok ? '' : activity.length ? `expected ${EXPECT}, got ${JSON.stringify(text.slice(-500))}` : 'turn emitted no live activity metadata' });
      }
    });
    ws.on('error', (e) => done({ ok: false, error: String(e && e.message || e), sessionId, text }));
  });
}

const tmp = mkdtempSync(join(tmpdir(), 'box-smoke-'));
let server = null;
let stderr = '';
let stdout = '';
try {
  const fakeBin = v['fake-codex'] ? writeFakeCodex(join(tmp, 'bin')) : '';
  const port = v.port ? Number(v.port) : await freePort();
  const home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  server = startServer({ port, home, fakeBin });
  server.stdout.on('data', (d) => { stdout += d.toString(); });
  server.stderr.on('data', (d) => { stderr += d.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + TIMEOUT_MS;
  const config = await waitForConfig(base, TOKEN, deadline);
  if (AGENT === 'codex' && !config.features?.codex) throw new Error('server reports Codex unavailable');
  const result = await smokeTurn(base, TOKEN, {
    key: `new-smoke-${process.pid}-${Date.now()}`,
    cwd: join(home, 'workspace'),
    agent: AGENT,
    model: MODEL,
    deadline,
  });
  if (!result.ok) throw new Error(result.error || 'smoke failed');
  console.log(JSON.stringify({
    ok: true,
    agent: AGENT,
    model: AGENT === 'codex' ? MODEL : '',
    fakeCodex: !!v['fake-codex'],
    sessionId: result.sessionId,
    activity: result.activity.slice(0, 8),
    response: result.text.trim().slice(0, 500),
  }, null, 2));
} catch (e) {
  const err = String(e && e.stack || e);
  console.error(JSON.stringify({
    ok: false,
    error: err,
    stdout: stdout.slice(-2000),
    stderr: stderr.slice(-2000),
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (server) {
    try { server.kill('SIGTERM'); } catch {}
    await wait(300);
    if (server.exitCode == null && server.signalCode == null) { try { server.kill('SIGKILL'); } catch {} }
  }
  if (!v.keep) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  } else {
    console.error(`kept ${tmp}`);
  }
}
