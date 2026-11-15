import assert from 'node:assert/strict';
import {
  QUICK_ALLOWED_BASH, QUICK_DENIED_READS, createQuickLookupRunner, parseQuickResult, quickLookupArgs,
  quickLookupConfig, quickLookupPrompt,
} from './voice-quick-lookup.mjs';

const cfgOf = (env) => (k, d = '') => (env[k] == null || env[k] === '' ? d : env[k]);
const tick = () => new Promise((r) => setImmediate(r));

// config: defaults, '' = unset (INC-1088 lesson), clamps, kill switch
{
  const c = quickLookupConfig(cfgOf({ VOICE_QUICK_WAIT_MS: '' }));
  assert.equal(c.enabled, true);
  assert.equal(c.model, 'haiku');
  assert.equal(c.waitMs, 22000);
  assert.equal(c.maxConcurrent, 3);
  assert.equal(quickLookupConfig(cfgOf({ VOICE_QUICK_WAIT_MS: '5' })).waitMs, 2000);
  assert.equal(quickLookupConfig(cfgOf({ VOICE_QUICK_LOOKUP: '0' })).enabled, false);
  assert.equal(quickLookupConfig(cfgOf({ VOICE_QUICK_MODEL: 'sonnet' })).model, 'sonnet');
}

// CLI args: sandboxed read-only — restricted, no MCP, no persisted session, dontAsk,
// only read tools, read-only Bash prefixes, secrets files denied, prompt after `--`
{
  const a = quickLookupArgs({ model: 'haiku', prompt: '--looks-like-a-flag what changed?' });
  for (const f of ['-p', '--restricted', '--strict-mcp-config', '--no-session-persistence']) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(a[a.indexOf('--tools') + 1], 'Read,Grep,Glob,Bash');
  assert.ok(!a.includes('bypassPermissions'));
  assert.ok(!/Edit|Write|NotebookEdit|WebFetch/.test(a[a.indexOf('--tools') + 1]));
  assert.equal(a[a.length - 2], '--');
  assert.equal(a[a.length - 1], '--looks-like-a-flag what changed?');
  const allowed = a.filter((x) => x.startsWith('Bash('));
  assert.equal(allowed.length, QUICK_ALLOWED_BASH.length);
  for (const x of allowed) assert.match(x, /^Bash\((git (log|show|diff|status|blame|ls-files|rev-parse)|gh (pr (view|list|checks|diff)|run (list|view))):\*\)$/);
  // nothing that mutates: no push/commit/checkout/branch/merge/api/rm
  assert.ok(!allowed.some((x) => /push|commit|checkout|branch|merge|reset|gh api|rm /.test(x)));
  const denied = a.filter((x) => x.startsWith('Read('));
  assert.equal(denied.length, QUICK_DENIED_READS.length);
  assert.ok(denied.includes('Read(./.env)') && denied.includes('Read(./**/.env.*)'));
}

// prompt: context appended and clipped
{
  assert.equal(quickLookupPrompt('  q  '), 'q');
  const p = quickLookupPrompt('q', 'c'.repeat(9000));
  assert.ok(p.startsWith('q\n\nContext') && p.length < 3200);
}

// result parsing
{
  const ok = parseQuickResult({ code: 0, out: 'some stderr warning\n' + JSON.stringify({ type: 'result', result: 'The default is gpt-6-luna.', total_cost_usd: 0.03, num_turns: 3, permission_denials: [{}] }) });
  assert.deepEqual(ok, { answer: 'The default is gpt-6-luna.', costUsd: 0.03, turns: 3, denied: 1 });
  assert.match(parseQuickResult({ code: 1, out: 'boom' }).error, /lookup failed: boom/);
  assert.match(parseQuickResult({ code: 1, out: '' }).error, /exit 1/);
  assert.match(parseQuickResult({ code: 0, out: JSON.stringify({ is_error: true, result: 'x' }) }).error, /failed/);
  assert.match(parseQuickResult({ code: 0, out: JSON.stringify({ result: 'Claude AI usage limit reached' }) }).error, /unavailable/);
}

// runner: inline answer, redaction, cwd passed through
{
  const calls = [];
  const runner = createQuickLookupRunner({
    config: { enabled: true, model: 'haiku', waitMs: 1000, timeoutMs: 5000, maxConcurrent: 2 },
    run: async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { code: 0, out: JSON.stringify({ result: 'key sk-SECRET here' }) }; },
    redact: (s) => s.replace(/sk-\w+/g, '[redacted]'),
  });
  const r = await runner.lookup({ question: 'what?', cwd: '/repo', id: 'j1' });
  assert.equal(r.answer, 'key [redacted] here');
  assert.match(r.engine, /read-only/);
  assert.equal(calls[0].cmd, 'claude');
  assert.equal(calls[0].opts.cwd, '/repo');
  assert.equal(runner.active, 0);
  assert.match((await runner.lookup({ question: '  ', cwd: '/repo' })).error, /what should I look up/);
}

// runner: slow lookup returns "running" at once (nonblocking), then reports via onBackgroundDone
{
  let release;
  const gate = new Promise((r) => { release = r; });
  let sleepRelease;
  const done = [];
  const runner = createQuickLookupRunner({
    config: { enabled: true, model: 'haiku', waitMs: 10, timeoutMs: 5000, maxConcurrent: 1 },
    run: async () => { await gate; return { code: 0, out: JSON.stringify({ result: 'late answer' }) }; },
    sleep: () => new Promise((r) => { sleepRelease = r; }),
    onBackgroundDone: (job, result) => done.push({ job, result }),
  });
  const p = runner.lookup({ question: 'slow?', cwd: '/repo', id: 'j2' });
  await tick();
  sleepRelease();
  const r = await p;
  assert.equal(r.status, 'running');
  assert.equal(r.id, 'j2');
  assert.equal(done.length, 0);
  // concurrency cap: a second lookup is refused while the first still runs
  assert.match((await runner.lookup({ question: 'another', cwd: '/repo', id: 'j3' })).error, /already running/);
  release();
  await tick(); await tick();
  assert.equal(done.length, 1);
  assert.equal(done[0].job.id, 'j2');
  assert.equal(done[0].result.answer, 'late answer');
  assert.equal(runner.active, 0);
}

// runner: a crashing spawn becomes an error result, kill switch refuses
{
  const runner = createQuickLookupRunner({
    config: { enabled: true, model: 'haiku', waitMs: 1000, timeoutMs: 5000, maxConcurrent: 1 },
    run: async () => { throw new Error('spawn ENOENT'); },
  });
  assert.match((await runner.lookup({ question: 'q', cwd: '/r' })).error, /spawn ENOENT/);
  const off = createQuickLookupRunner({ config: { enabled: false }, run: async () => ({}) });
  assert.match((await off.lookup({ question: 'q' })).error, /turned off/);
}

console.log('voice-quick-lookup tests ok');
