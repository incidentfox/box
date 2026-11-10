// Voice-screen tools: brain_save, gmail_search, gmail_read, calendar_add, needs_jimmy_resolve.
// Pure helpers + the real handlers driven through POST /api/voice/tool against a temp HOME
// with a fake `google` CLI and a fake needs-jimmy script — nothing touches real Gmail,
// Calendar, Linear, or the company brain.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  brainQueueEntry, describePacificRange, needsJimmyId, normalizeGoogleAccount, pacificIso,
  parseGmailList, resolveEventTimes, screenBrainFact, senderName,
} from './voice-extra-tools.mjs';
import { redactSecrets, registerVoiceAssistant } from './voice-assistant.mjs';
import { liveBackendTools } from './live-voice.mjs';

// ---- pure helpers ------------------------------------------------------------------
{
  const ok = (t) => screenBrainFact(t, { redact: redactSecrets });
  assert.equal(ok('Spectrum agreed to pilot the fax-reduction workflow starting December 1.').ok, true);
  assert.equal(ok('Monaco campaign reply rate was 4% on the October 20 send.').ok, true);
  assert.equal(ok('short').ok, false);
  assert.match(ok('The deploy token is ghp_ABCDEFabcdef0123456789ABCDEFabcdef01 for now').reason, /secret/);
  assert.match(ok('Patient John Smith had his QME on 10/3 with Dr. Lee').reason, /PHI/);
  assert.match(ok('the applicant Maria Lopez DOB 4/5/1980 was rebilled').reason, /PHI|birth/);
  assert.match(ok('SSN 123-45-6789 on the bill').reason, /PHI|Social/);
  assert.match(ok('Jimmy got an RFE on his H-1B and needs to reply by Dec').reason, /immigration/);
  assert.match(ok('my therapist moved our sessions to Friday mornings').reason, /medical/);
  assert.equal(ok('Ali Omid is the President of Spectrum').ok, true); // a business contact is fine
}
{
  const e = brainQueueEntry({ fact: 'Spectrum wants\nweekly reports.', entity: 'Spectrum Medical Evaluators', entityType: 'company', now: new Date('2026-11-10T18:00:00Z') });
  assert.match(e, /^## 2026-11-10T18:00:00\.000Z — company:spectrum-medical-evaluators\n/);
  assert.match(e, /\n- Spectrum wants weekly reports\.\n$/);
  assert.match(brainQueueEntry({ fact: 'x y z fact' }), /— general\n/);
}
{
  assert.equal(normalizeGoogleAccount('personal'), 'me');
  assert.equal(normalizeGoogleAccount('work'), 'work');
  assert.equal(normalizeGoogleAccount('both', 'work'), 'both');
  assert.equal(normalizeGoogleAccount('', 'work'), 'work');
  const rows = parseGmailList('1a1c60b991d2b363\tTue, 10 Nov 2026 09:20:07 -0600\tFedEx <fedex@message.fedex.com>\tKeep\tit\nnoise line\n', 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'Keep it');
  assert.deepEqual(senderName(rows[0].from), { name: 'FedEx', email: 'fedex@message.fedex.com' });
  assert.equal(senderName('a@b.com').name, 'a@b.com');
}
{
  assert.equal(pacificIso('2026-11-12T15:00'), '2026-11-12T15:00:00-08:00'); // PST
  assert.equal(pacificIso('2026-07-01T09:30'), '2026-07-01T09:30:00-07:00'); // PDT
  assert.equal(pacificIso('2026-11-12T15:00:00Z'), '2026-11-12T15:00:00Z');
  assert.equal(pacificIso('next tuesday'), '');
  const t = resolveEventTimes({ start: '2026-11-12T15:00' });
  assert.deepEqual(t, { start: '2026-11-12T15:00:00-08:00', end: '2026-11-12T15:30:00-08:00' });
  assert.equal(resolveEventTimes({ start: '2026-11-12T15:00', duration_minutes: 90 }).end, '2026-11-12T16:30:00-08:00');
  assert.match(resolveEventTimes({ start: '2026-11-12T15:00', end: '2026-11-12T14:00' }).error, /after/);
  assert.equal(describePacificRange(t.start, t.end), 'Thursday, November 12, 3:00 PM to 3:30 PM Pacific');
  assert.equal(needsJimmyId('inc twenty 2410'), 'INC-2410');
  assert.equal(needsJimmyId('INC-2410'), 'INC-2410');
  assert.equal(needsJimmyId('none'), '');
}

// ---- handlers through /api/voice/tool ----------------------------------------------
function makeApp() {
  const routes = new Map();
  const add = (method) => (path, ...handlers) => routes.set(`${method} ${path}`, handlers[handlers.length - 1]);
  return {
    use() {}, all() {}, set() {},
    get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'),
    async call(method, path, body = {}) {
      const h = routes.get(`${method} ${path}`);
      let payload;
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(o) { payload = o; return this; }, send(o) { payload = o; return this; }, setHeader() {}, end() { return this; } };
      await h({ body, params: {}, query: {} }, res);
      return payload;
    },
  };
}

const root = mkdtempSync(join(tmpdir(), 'vxt-'));
const HOME = join(root, 'home');
const STATE_DIR = join(HOME, '.cc-mobile');
const QDIR = join(root, 'brain-queue');
const CALLS = join(root, 'calls.log');
mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
mkdirSync(join(HOME, 'development', 'software-factory', 'harness'), { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

// Fake `google` CLI: records argv, answers list/get/api/cal add like the real one.
const SECRET = 'ghp_ABCDEFabcdef0123456789ABCDEFabcdef01';
writeFileSync(join(HOME, '.local', 'bin', 'google'), `#!/usr/bin/env node
const a = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(a) + '\\n');
const [acct, svc, cmd] = a;
if (svc === 'gmail' && cmd === 'list') { console.log(acct === 'work' ? 'aaaa1111bbbb2222\\tTue, 10 Nov 2026 09:20:07 -0800\\tAli Omid <ali@spectrum.example>\\tJune invoice' : 'cccc3333dddd4444\\tMon, 9 Nov 2026 08:00:00 -0800\\tFedEx <fedex@fedex.example>\\tYour package'); }
else if (svc === 'api') { console.log(JSON.stringify({ id: 'x', snippet: 'Looks good, we&#39;ll pay Friday', labelIds: ['UNREAD', 'INBOX'] })); }
else if (svc === 'gmail' && cmd === 'get') { console.log('From: Ali Omid\\nSubject: June invoice\\n\\nHi Jimmy, key ${SECRET} and ' + 'x'.repeat(6000)); }
else if (svc === 'cal' && cmd === 'add') { console.log(JSON.stringify({ id: 'evt123', summary: a[3] })); }
else { console.error('unexpected'); process.exit(2); }
`);
chmodSync(join(HOME, '.local', 'bin', 'google'), 0o755);
// Fake needs-jimmy harness: records argv, prints what the real one prints.
writeFileSync(join(HOME, 'development', 'software-factory', 'harness', 'needs-jimmy.mjs'),
  `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(['needs-jimmy', ...process.argv.slice(2)]) + '\\n'); console.log('resolved ' + process.argv[3]);\n`);

// Loopback stand-in for the box's /api/needs-attention.
const srv = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/needs-attention') return res.end(JSON.stringify({ open: 1, items: [{ identifier: 'INC-2410', title: 'Medata line dead for 12 payers — switch to fax?', ask: '' }] }));
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;

function buildApp(env) {
  const ctx = {
    requireAuth: (_q, _s, next) => (typeof next === 'function' ? next() : undefined),
    cfg: (k, d) => (env[k] != null ? env[k] : (d != null ? d : '')),
    HOME, STATE_DIR, PORT, authToken: 'test', ownerName: 'Jimmy',
    defaultCwd: () => HOME,
    listSessions: () => ({ sessions: [], counts: {} }),
    findSessionFile: () => null, tailInfo: () => ({}), enqueue: () => {}, rt: () => ({}), RUNNING: new Map(),
    childEnv: () => ({ ...process.env }), macAvailable: () => false,
    loadCodexMessages: () => [], codexHome: join(root, 'codex'), codexMessagePath: () => '', transcribe: null,
  };
  const app = makeApp();
  registerVoiceAssistant(app, ctx);
  return app;
}
const live = buildApp({ VOICE_BRAIN_QUEUE_DIR: QDIR });
const dry = buildApp({ VOICE_TOOLS_DRYRUN: '1', VOICE_BRAIN_QUEUE_DIR: QDIR });
const tool = async (app, name, args) => JSON.parse((await app.call('POST', '/api/voice/tool', { name, args })).output);
const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

try {
  // brain_save: refusals never write; a clean fact lands atomically in the queue dir.
  {
    const r = await tool(live, 'brain_save', { fact: 'Patient John Smith was rebilled on 11/2.' });
    assert.equal(r.saved, false); assert.equal(r.refused, true);
    assert.ok(!existsSync(QDIR) || readdirSync(QDIR).length === 0);
    const d = await tool(dry, 'brain_save', { fact: 'Spectrum wants weekly status reports every Monday.', entity: 'Spectrum', entity_type: 'company' });
    assert.equal(d.dry_run, true); assert.match(d.entry, /company:spectrum/);
    assert.ok(!existsSync(QDIR) || readdirSync(QDIR).length === 0, 'dry run must not write');
    const s = await tool(live, 'brain_save', { fact: 'Spectrum wants weekly status reports every Monday.', entity: 'Spectrum', entity_type: 'company' });
    assert.equal(s.saved, true);
    const files = readdirSync(QDIR);
    assert.equal(files.length, 1); assert.match(files[0], /^voice-\d+-\d+-[0-9a-f]{6}\.md$/);
    assert.match(readFileSync(join(QDIR, files[0]), 'utf8'), /- Spectrum wants weekly status reports every Monday\.\n$/);
  }

  // gmail_search: both accounts, compact rows, snippet decoded.
  {
    const r = await tool(live, 'gmail_search', { query: 'in:inbox', max: 3 });
    assert.equal(r.results.length, 2);
    const work = r.results.find((x) => x.account === 'work');
    assert.equal(work.messages[0].from, 'Ali Omid');
    assert.equal(work.messages[0].subject, 'June invoice');
    assert.equal(work.messages[0].snippet, "Looks good, we'll pay Friday");
    assert.equal(work.messages[0].unread, true);
    assert.ok(calls().some((c) => c[0] === 'me' && c[2] === 'list'));
    const one = await tool(live, 'gmail_search', { account: 'work', max: 1 });
    assert.equal(one.results.length, 1);
  }

  // gmail_read: redacted + trimmed; bad ids rejected before shelling out.
  {
    const r = await tool(live, 'gmail_read', { id: 'aaaa1111bbbb2222', account: 'work' });
    assert.ok(!r.content.includes(SECRET)); assert.ok(r.secrets_redacted >= 1);
    assert.equal(r.truncated, true); assert.ok(r.content.length < 4100);
    assert.match((await tool(live, 'gmail_read', { id: '../etc', account: 'work' })).error, /id/);
  }

  // calendar_add: unconfirmed → read-back only; dry run never shells; confirmed creates.
  {
    const before = calls().filter((c) => c[1] === 'cal').length;
    const a = await tool(live, 'calendar_add', { summary: 'Lunch with Ali', start: '2026-11-12T12:00', duration_minutes: 60 });
    assert.equal(a.created, false); assert.equal(a.needs_confirmation, true);
    assert.equal(a.read_back, 'Add "Lunch with Ali", Thursday, November 12, 12:00 PM to 1:00 PM Pacific, on your work calendar?');
    const d = await tool(dry, 'calendar_add', { summary: 'Lunch with Ali', start: '2026-11-12T12:00', duration_minutes: 60, confirmed: true });
    assert.equal(d.dry_run, true);
    assert.equal(calls().filter((c) => c[1] === 'cal').length, before, 'no cal call before confirmation / in dry run');
    const c = await tool(live, 'calendar_add', { summary: 'Lunch with Ali', start: '2026-11-12T12:00', duration_minutes: 60, confirmed: true, account: 'personal' });
    assert.equal(c.created, true); assert.equal(c.event_id, 'evt123'); assert.equal(c.account, 'personal');
    assert.deepEqual(calls().filter((x) => x[1] === 'cal').pop(), ['me', 'cal', 'add', 'Lunch with Ali', '2026-11-12T12:00:00-08:00', '2026-11-12T13:00:00-08:00']);
  }

  // needs_jimmy_resolve: only open needs-Jimmy items; dry run doesn't shell; live calls the harness.
  {
    const nope = await tool(live, 'needs_jimmy_resolve', { id: 'INC-1', decision: 'Do it.' });
    assert.equal(nope.resolved, false); assert.equal(nope.open[0].id, 'INC-2410');
    const d = await tool(dry, 'needs_jimmy_resolve', { id: 'inc 2410', decision: 'Switch those 12 payers to fax.' });
    assert.equal(d.dry_run, true); assert.equal(d.id, 'INC-2410');
    assert.equal(calls().filter((c) => c[0] === 'needs-jimmy').length, 0);
    const r = await tool(live, 'needs_jimmy_resolve', { id: 'INC-2410', decision: 'Switch those 12 payers to fax.' });
    assert.equal(r.resolved, true);
    assert.deepEqual(calls().filter((c) => c[0] === 'needs-jimmy').pop(), ['needs-jimmy', '--resolve', 'INC-2410', '--note', 'Switch those 12 payers to fax. (decided by voice)']);
  }
} finally {
  srv.close();
  rmSync(root, { recursive: true, force: true });
}

// The GPT-Live backend gets the new tools (only voice-only + Parallel tools are dropped).
{
  const names = liveBackendTools(['brain_save', 'gmail_search', 'gmail_read', 'calendar_add', 'needs_jimmy_resolve', 'wait_for_user'].map((name) => ({ name }))).map((t) => t.name || t.type);
  assert.deepEqual(names, ['web_search', 'brain_save', 'gmail_search', 'gmail_read', 'calendar_add', 'needs_jimmy_resolve']);
}

console.log('voice extra tools: ok');
