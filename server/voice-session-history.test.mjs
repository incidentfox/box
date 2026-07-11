// Handler-level integration test for the voice session-history / transcript read tools
// (INC-1134). Registers the real voice assistant against a fake express app + a minimal
// ctx pointing at a temp Claude session JSONL, then drives the actual tools through the
// same POST /api/voice/tool dispatch the realtime client uses. Verifies:
//   • read_session_history include:full  → whole ordered conversation, paginated, redacted
//   • read_session_history include:prompts → just the user asks
//   • read_session_output                → latest artifact, redacted, with a transcript_ref
//   • request_full_artifact transcript:true → emails the full conversation (redacted, dry-run)
// so voice can reach full conversation context WITHOUT asking the agent to summarize itself.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerVoiceAssistant } from './voice-assistant.mjs';

// Minimal express double: capture the final handler for each "METHOD path" and let us
// invoke it with a fake req/res (auth middleware args are ignored — we call the handler).
function makeApp() {
  const routes = new Map();
  const add = (method) => (path, ...handlers) => routes.set(`${method} ${path}`, handlers[handlers.length - 1]);
  return {
    use() {}, all() {}, set() {},
    get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'),
    async call(method, path, body = {}) {
      const h = routes.get(`${method} ${path}`);
      if (!h) throw new Error(`no route ${method} ${path}`);
      let payload;
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(o) { payload = o; return this; },
        send(o) { payload = o; return this; },
        setHeader() {}, end() { return this; },
      };
      await h({ body, params: {}, query: {} }, res);
      return payload;
    },
  };
}
async function callTool(app, name, args) {
  const r = await app.call('POST', '/api/voice/tool', { name, args });
  return JSON.parse(r.output);
}

// ---- temp session fixture ---------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'vsh-'));
const HOME = join(root, 'home');
const STATE_DIR = join(HOME, '.cc-mobile');
const projectDir = join(HOME, 'projects', 'proj');
mkdirSync(projectDir, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const SECRET = 'ghp_ABCDEFabcdef0123456789ABCDEFabcdef01';
const jsonlPath = join(projectDir, `${SESSION_ID}.jsonl`);
writeFileSync(jsonlPath, [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'rank the daisyBill prospects' }, timestamp: 't1' }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Working on it — deploy token ${SECRET} in play.` }] }, timestamp: 't2' }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'noise' }] } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'give me the full list' }, timestamp: 't3' }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '1. Acme\n2. Globex\n3. Initech' }] }, timestamp: 't4' }),
].join('\n') + '\n');

const session = { id: SESSION_ID, title: 'daisyBill prospects', preview: 'ranking prospects', cwd: projectDir, agent: 'claude', status: 'idle', mtime: Date.now() };

const ctx = {
  requireAuth: (_req, _res, next) => (typeof next === 'function' ? next() : undefined),
  // DRYRUN so request_full_artifact simulates the email instead of shelling out.
  cfg: (k, d) => (k === 'VOICE_TOOLS_DRYRUN' ? '1' : (d != null ? d : '')),
  HOME, STATE_DIR, PORT: 0, authToken: 'test', ownerName: 'Jimmy',
  defaultCwd: () => HOME,
  listSessions: ({ filter } = {}) => ({ sessions: filter === 'archived' ? [] : [session], counts: {} }),
  findSessionFile: (id) => (id === SESSION_ID ? jsonlPath : null),
  tailInfo: () => ({}), enqueue: () => {}, rt: () => ({}), RUNNING: new Map(),
  childEnv: () => ({ ...process.env }), macAvailable: () => false,
  loadCodexMessages: () => [], codexHome: join(root, 'codex'), codexMessagePath: () => '', transcribe: null,
};

const app = makeApp();
registerVoiceAssistant(app, ctx);

async function main() {
  // 1) Full conversation — every turn, in order, secret scrubbed, with a transcript_ref.
  {
    const r = await callTool(app, 'read_session_history', { query: 'daisyBill prospects', include: 'full' });
    assert.equal(r.mode, 'full', JSON.stringify(r));
    assert.equal(r.turn_count, 4); // 2 user + 2 assistant; the tool-result-only turn is dropped
    assert.equal(r.match.id, SESSION_ID);
    assert.equal(r.transcript_ref.session_id, SESSION_ID);
    assert.equal(r.transcript_ref.export_path, `/api/sessions/${SESSION_ID}/export`);
    assert.match(r.text, /user: rank the daisyBill prospects/);
    assert.match(r.text, /assistant: 1\. Acme/);
    assert.ok(!r.text.includes(SECRET), 'secret leaked into transcript');
    assert.ok(r.secrets_redacted >= 1, 'expected a redaction count');
  }
  // Also resolvable by raw session id.
  {
    const r = await callTool(app, 'read_session_history', { query: SESSION_ID, include: 'full' });
    assert.equal(r.match.id, SESSION_ID);
    assert.equal(r.mode, 'full');
  }
  // 2) Prompts-only recall — just what Jimmy asked, in order.
  {
    const r = await callTool(app, 'read_session_history', { query: 'daisyBill prospects', include: 'prompts' });
    assert.equal(r.mode, 'prompts');
    assert.equal(r.prompt_count, 2);
    assert.equal(r.prompts[0].text, 'rank the daisyBill prospects');
    assert.equal(r.prompts[1].text, 'give me the full list');
    assert.equal(r.transcript_ref.session_id, SESSION_ID);
  }
  // 3) Latest output — list detected, redacted, carries a transcript_ref back to the thread.
  {
    const r = await callTool(app, 'read_session_output', { query: 'daisyBill prospects', mode: 'summary' });
    assert.equal(r.kind, 'list');
    assert.equal(r.item_count, 3);
    assert.equal(r.transcript_ref.session_id, SESSION_ID);
  }
  // 4) Email the FULL conversation (dry-run) — redacted, labelled as a transcript.
  {
    const r = await callTool(app, 'request_full_artifact', { ref: 'daisyBill prospects', transcript: true });
    assert.equal(r.emailed, true);
    assert.equal(r.dry_run, true);
    assert.equal(r.kind, 'transcript');
    assert.equal(r.session_id, SESSION_ID);
    assert.ok(r.secrets_redacted >= 1, 'transcript email should have scrubbed the token');
  }
  // 5) Email just the latest artifact (dry-run) — redacted, labelled as output.
  {
    const r = await callTool(app, 'request_full_artifact', { ref: 'daisyBill prospects' });
    assert.equal(r.emailed, true);
    assert.equal(r.kind, 'output');
  }
  // 6) The read was audited (read-only trail).
  {
    const auditFile = join(STATE_DIR, 'voice-assistant', 'session-history-audit.jsonl');
    assert.ok(existsSync(auditFile), 'expected a session-history audit log');
    const rows = readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.tool === 'read_session_history' && r.include === 'full'));
  }
  // 7) A miss is a graceful suggestion, not a crash.
  {
    const r = await callTool(app, 'read_session_history', { query: 'nonexistent zzzzz topic' });
    assert.ok(r.error, 'expected a no-match error');
  }

  console.log('voice-session-history integration ok');
}

main()
  .then(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} process.exit(0); })
  .catch((e) => { console.error(e); try { rmSync(root, { recursive: true, force: true }); } catch {} process.exit(1); });
