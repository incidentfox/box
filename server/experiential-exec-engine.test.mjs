import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ExperientialExecEngine, experientialProvider } from './experiential-exec-engine.mjs';
import { turnAdmissionQid } from './turn-limiter.mjs';

for (const sessionId of [null, 'synthetic-thread']) {
  let invocation;
  const engine = new ExperientialExecEngine({ spawnImpl: (...args) => {
    invocation = args;
    return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 999999 });
  } });
  const events = [];
  const child = engine.run({ apiKey: 'synthetic-secret', sessionId, cwd: '/tmp', prompt: 'hello', settings: { model: 'other', reasoningEffort: 'ultra' }, onEvent: e => events.push(e) });
  const [command, args, options] = invocation;
  assert.equal(command, 'bash');
  assert.ok(args.includes('model_provider="explabs"'));
  assert.ok(args.includes('gpt-6-astra'));
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.equal(args.includes('resume'), !!sessionId);
  assert.ok(!JSON.stringify(args).includes('synthetic-secret'));
  assert.equal(options.env.BOX_EXPLABS_API_KEY, 'synthetic-secret');
  assert.equal(options.detached, true);
  child.stdout.end(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-thread' }) + '\n' + JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 42 } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.map(e => e.type), ['session', 'context', 'turn_end']);
}
const engine = new ExperientialExecEngine();
for (const options of [{}, { apiKey: 'x', guest: true }, { apiKey: 'x', team: true }]) assert.throws(() => engine.run(options));
assert.equal(turnAdmissionQid({ agent: 'experiential', queue: [{ qid: 'q' }] }), 'q');
assert.equal(turnAdmissionQid({ agent: 'experiential', queue: [{ qid: 'q', mode: 'bash' }] }), null);

const dir = mkdtempSync(join(tmpdir(), 'explabs-provider-'));
try {
  const envFile = join(dir, "shared ' env");
  writeFileSync(envFile, `export EXPLABS_API_KEY=wrong OPENAI_API_KEY=wrong CODEX_API_KEY=wrong\ncodex() { [ "$EXPLABS_API_KEY" = 'selected' ] && [ -z "$OPENAI_API_KEY$CODEX_API_KEY$BOX_EXPLABS_API_KEY" ]; }\n`);
  // Functions cannot be exec'ed, so replace only the final exec in this credential boundary check.
  const script = experientialProvider('selected').buildScript(envFile).replace('exec codex', 'codex');
  const result = spawnSync('bash', ['-c', script], { env: { PATH: '/usr/bin:/bin', BOX_EXPLABS_API_KEY: 'selected' } });
  assert.equal(result.status, 0, result.stderr.toString());
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('Experiential provider, resume, credential isolation, and recovery admission tests passed');
