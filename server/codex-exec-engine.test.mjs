import { codexCreditExhausted, armTaskFinisher, stopTaskFinisher, recordTaskFinisherFailure, clearTaskFinisherFailureCount } from './session-scheduler.mjs';
// Tests for buildCodexArgs — guards the variadic `-i/--image` ordering bug, where images placed
// before the positional prompt made codex's variadic `-i` swallow the prompt (and the session id
// on resume), so an image message silently vanished. Run: node server/codex-exec-engine.test.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  buildCodexArgs,
  buildOwnerCodexConfigArgs,
  buildOwnerCodexEnv,
  buildOwnerCodexScript,
  CodexExecEngine,
  reasoningHeartbeat,
  terminateCodexProcess,
} from './codex-exec-engine.mjs';

// Helper: index of the LAST `-i` flag, and the positions of the positionals.
const lastImageFlagIdx = (a) => a.lastIndexOf('-i');

// Box owner turns suppress the redundant global sessiongrep MCP by default without changing
// terminal Codex or isolated team sandboxes. Operators can explicitly opt it back in.
assert.deepEqual(buildOwnerCodexConfigArgs({}), ['-c', 'mcp_servers.sessiongrep.enabled=false']);
assert.deepEqual(buildOwnerCodexConfigArgs({ BOX_SESSIONGREP_MCP: 'on' }), []);

// 1. NEW turn with a prompt + images: the prompt must come BEFORE every `-i`, and the trailing
//    `-i …` must be the end of the argv (nothing after the last image to be eaten).
{
  const a = buildCodexArgs({ cwd: '/work', prompt: 'fix the UI', images: ['/a.png', '/b.png'] });
  const promptIdx = a.indexOf('fix the UI');
  assert.ok(promptIdx >= 0, 'prompt is present as a positional');
  assert.ok(promptIdx < lastImageFlagIdx(a), 'prompt must come before the last -i (else -i eats it)');
  assert.equal(a[a.length - 1], '/b.png', 'last arg is the final image (variadic terminated by end-of-args)');
  assert.equal(a[a.length - 2], '-i');
  // -C cwd still present and intact
  assert.equal(a[a.indexOf('-C') + 1], '/work');
}

// 2. RESUME turn with a prompt + image: order must be … <sessionId> <prompt> -i <img>, so neither
//    the session id nor the prompt is consumed by the variadic image flag.
{
  const sid = '019f1082-bce1-7902-89e5-cd093946e566';
  const a = buildCodexArgs({ sessionId: sid, prompt: 'and this too', images: ['/c.png'] });
  const sidIdx = a.indexOf(sid);
  const promptIdx = a.indexOf('and this too');
  assert.ok(sidIdx >= 0 && promptIdx >= 0, 'session id and prompt both present');
  assert.ok(sidIdx < promptIdx, 'session id precedes prompt (codex resume positionals: <SESSION_ID> [PROMPT])');
  assert.ok(promptIdx < lastImageFlagIdx(a), 'prompt precedes the image flag');
  assert.equal(a[a.length - 1], '/c.png');
  assert.ok(a.includes('resume'));
}

// 3. No images: argv ends with the prompt, no stray -i.
{
  const a = buildCodexArgs({ cwd: '/work', prompt: 'just text' });
  assert.equal(a[a.length - 1], 'just text');
  assert.ok(!a.includes('-i'));
}

// 4. Images present but empty prompt (image-only message): the empty positional is still passed so
//    codex doesn't fall back to (empty) stdin, and the image flag is last.
{
  const a = buildCodexArgs({ cwd: '/work', prompt: '', images: ['/d.png'] });
  const cIdx = a.indexOf('-C');
  // the positional after `-C /work` is the empty prompt string, then `-i /d.png`
  assert.equal(a[cIdx + 2], '', 'empty prompt positional is present');
  assert.equal(a[cIdx + 3], '-i');
  assert.equal(a[a.length - 1], '/d.png');
}

// 5. settings → --model and reasoning effort are threaded through.
{
  const a = buildCodexArgs({ cwd: '/work', prompt: 'x', settings: { model: 'gpt-5.5', reasoningEffort: 'high' } });
  assert.equal(a[a.indexOf('--model') + 1], 'gpt-5.5');
  assert.ok(a.includes('-c') && a.includes('model_reasoning_effort="high"'));
}

// 6. Sandbox DEFAULT = off: no `--sandbox` anywhere; bypass flags present; resume positionals intact.
//    (Guards the #40 regression where `--sandbox` was emitted AFTER the `resume` subcommand, which
//    `codex exec resume` rejects: "error: unexpected argument '--sandbox' found".)
{
  const saved = process.env.CODEX_SANDBOX;
  delete process.env.CODEX_SANDBOX;
  try {
    const sid = '019f1082-bce1-7902-89e5-cd093946e566';
    const resume = buildCodexArgs({ sessionId: sid, prompt: 'go' });
    assert.ok(!resume.includes('--sandbox'), 'default: no --sandbox on resume');
    assert.ok(resume.includes('--dangerously-bypass-approvals-and-sandbox'), 'default: bypass on resume');
    assert.ok(resume.indexOf(sid) < resume.indexOf('go'), 'resume: session id precedes prompt');
    const fresh = buildCodexArgs({ cwd: '/work', prompt: 'go' });
    assert.ok(!fresh.includes('--sandbox'), 'default: no --sandbox on new turn');
    assert.ok(fresh.includes('--dangerously-bypass-approvals-and-sandbox'), 'default: bypass on new turn');
  } finally {
    if (saved === undefined) delete process.env.CODEX_SANDBOX; else process.env.CODEX_SANDBOX = saved;
  }
}

// Per-thread TUI preferences are forwarded on every exec/resume turn.
{
  const a = buildCodexArgs({ cwd: '/work', prompt: 'x', settings: { serviceTier: 'fast', personality: 'pragmatic' } });
  assert.ok(a.includes('service_tier="fast"'));
  assert.ok(a.includes('features.fast_mode=true'));
  assert.ok(a.includes('personality="pragmatic"'));
}

// 7. Opt-in sandbox (settings.sandbox / CODEX_SANDBOX): `--sandbox <mode>` is present and — crucially
//    for resume — comes BEFORE the `resume` token (it's a `codex exec` option, not a `resume` one),
//    and no bypass flags leak in.
{
  const sid = '019f1082-bce1-7902-89e5-cd093946e566';
  const resume = buildCodexArgs({ sessionId: sid, prompt: 'go', settings: { sandbox: 'workspace-write' } });
  const sbIdx = resume.indexOf('--sandbox');
  assert.ok(sbIdx >= 0, 'opt-in: --sandbox present on resume');
  assert.equal(resume[sbIdx + 1], 'workspace-write', 'opt-in: mode follows --sandbox');
  assert.ok(sbIdx < resume.indexOf('resume'), 'opt-in: --sandbox precedes the resume subcommand');
  assert.ok(!resume.includes('--dangerously-bypass-approvals-and-sandbox'), 'opt-in: no bypass when sandboxed');
  const fresh = buildCodexArgs({ cwd: '/work', prompt: 'go', settings: { sandbox: 'read-only' } });
  assert.equal(fresh[fresh.indexOf('--sandbox') + 1], 'read-only', 'opt-in: new turn honors mode');
  assert.equal(fresh[fresh.indexOf('-C') + 1], '/work', 'opt-in: -C cwd still intact');
}

// 8. CODEX_SANDBOX env honored, and `off` keeps it off.
{
  const saved = process.env.CODEX_SANDBOX;
  try {
    process.env.CODEX_SANDBOX = 'workspace-write';
    assert.ok(buildCodexArgs({ cwd: '/work', prompt: 'x' }).includes('--sandbox'), 'env on → --sandbox');
    process.env.CODEX_SANDBOX = 'off';
    assert.ok(!buildCodexArgs({ cwd: '/work', prompt: 'x' }).includes('--sandbox'), 'env off → no --sandbox');
  } finally {
    if (saved === undefined) delete process.env.CODEX_SANDBOX; else process.env.CODEX_SANDBOX = saved;
  }
}

// Owner turns always use the file-backed Codex login. Non-interactive Codex otherwise
// prefers either API-key variable, including one introduced by CODEX_ENV_FILE after the
// child environment was built. Other integration credentials remain available.
{
  const env = buildOwnerCodexEnv({
    PATH: '/usr/bin:/bin',
    OPENAI_API_KEY: 'sk-metered-openai',
    CODEX_API_KEY: 'sk-metered-codex',
    AWS_ACCESS_KEY_ID: 'still-needed',
  });
  assert.equal('OPENAI_API_KEY' in env, false);
  assert.equal('CODEX_API_KEY' in env, false);
  assert.equal(env.AWS_ACCESS_KEY_ID, 'still-needed');

  const script = buildOwnerCodexScript('/run/box/codex.env');
  assert.ok(script.includes('. "/run/box/codex.env"'), 'optional env file is still sourced');
  assert.ok(script.indexOf('. "/run/box/codex.env"') < script.indexOf('unset OPENAI_API_KEY CODEX_API_KEY'));
  assert.ok(script.indexOf('unset OPENAI_API_KEY CODEX_API_KEY') < script.indexOf('exec codex "$@"'));
}

// Reasoning stays private, but its start/completion envelopes keep the Box activity
// clock fresh. Unrelated item events must not create false heartbeats.
assert.deepEqual(reasoningHeartbeat({ type: 'item.started', item: { type: 'reasoning' } }), { type: 'thinking', delta: '' });
assert.deepEqual(reasoningHeartbeat({ type: 'item.completed', item: { type: 'reasoning_summary' } }), { type: 'thinking', delta: '' });
assert.equal(reasoningHeartbeat({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }), null);

// A real Codex turn boundary is authoritative even when /goal keeps the process open. The engine
// must emit turn_end without waiting for child close, and the child must live in its own group so a
// genuine timeout can terminate both the Node launcher and native binary.
{
  const child = new EventEmitter();
  child.pid = 4321;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  let spawnArgs = null;
  let spawnOptions = null;
  const events = [];
  const engine = new CodexExecEngine({ spawnImpl: (_cmd, args, options) => { spawnArgs = args; spawnOptions = options; return child; } });
  engine.run({ cwd: '/work', prompt: 'finish once', onEvent: (event) => events.push(event) });
  child.stdout.write(`${JSON.stringify({ type: 'event_msg', payload: { type: 'image_generation_end', status: 'completed', saved_path: '/tmp/generated/concept.png', result: 'secret-base64' } })}\n`);
  child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })}\n`);
  child.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map((event) => event.type), ['image', 'text', 'context', 'turn_end']);
  assert.deepEqual(events[0], { type: 'image', path: '/tmp/generated/concept.png', alt: 'concept.png' });
  assert.ok(!JSON.stringify(events).includes('secret-base64'));
  assert.equal(events.at(-1).status, 'completed');
  assert.equal(spawnOptions.detached, process.platform !== 'win32');
  assert.ok(spawnArgs.includes('mcp_servers.sessiongrep.enabled=false'), 'owner turn disables sessiongrep MCP');
  child.stdout.write(`${JSON.stringify({ type: 'turn.failed', error: { code: 'insufficient_quota', message: 'Account unavailable' } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.at(-1), { type: 'error', code: 'insufficient_quota', msg: 'Account unavailable' });
}

{
  const calls = [];
  const child = { pid: 9876, kill: () => { calls.push(['fallback']); return true; } };
  assert.equal(terminateCodexProcess(child, 'SIGKILL', { platform: 'linux', killImpl: (...args) => calls.push(args) }), true);
  assert.deepEqual(calls, [[-9876, 'SIGKILL']], 'POSIX termination targets the whole process group');
}

// Exercise a real OS pipe with a multibyte prompt larger than Linux's argv limit,
// for both new and resumed turns with attachments. Never invoke a paid model.
for (const sessionId of [undefined, 'test-resumed-session']) {
  const prompt = '測試🙂\n'.repeat(20000);
  const events = [];
  const engine = new CodexExecEngine({ spawnImpl: (_command, args, options) => {
    assert.ok(!args.includes(prompt));
    assert.ok(args.indexOf('-') < args.indexOf('-i'));
    if (sessionId) assert.ok(args.indexOf(sessionId) < args.indexOf('-'));
    assert.equal(options.stdio[0], 'pipe');
    return spawn(process.execPath, ['-e', `
      const chunks = [];
      process.stdin.on('data', chunk => chunks.push(chunk));
      process.stdin.on('end', () => console.log(JSON.stringify({
        type: 'item.completed', item: { type: 'agent_message',
          text: require('node:crypto').createHash('sha256').update(Buffer.concat(chunks)).digest('hex') }
      })));
    `], { ...options, cwd: process.cwd() });
  } });
  const child = engine.run({ sessionId, prompt, images: ['/test.png'], onEvent: event => events.push(event) });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`))); });
  assert.equal(events.find(event => event.type === 'text')?.delta, createHash('sha256').update(prompt).digest('hex'));
}

// Execute the actual server turn handler with a failing launcher. Synchronous
// spawn failures must resolve the worker and clear its timer instead of escaping.
{
  const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('function runCodexTurn('), source.indexOf('// Team Claude is intentionally separate'));
  const events = [];
  const notes = [];
  const context = {
    CODEX_TURN_SEQ: 0, CODEX_TURN_TIMEOUT_MS: 1000, DEFAULT_SETTINGS: { codex: {} },
    setTimeout, clearTimeout, sessionUsesTeamSandbox: () => false, sessionInTeamWorkspaceOf: () => false,
    stopTail() {}, codexUserParts: () => [], sessionIsGuest: () => false,
    codexEngine: { run() { throw Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' }); } },
    stopTaskFinisherOnCodexCreditError: () => false, cleanCodexError: String, codexAssistantParts: () => [], flushCodexAssistant() {},
    appendCodexMessage: (...args) => notes.push(args), ensureTail() {}, triggerAttentionUpdate() {},
    bcast: (_session, event) => events.push(event),
  };
  vm.createContext(context);
  vm.runInContext(handler, context);
  const session = { sessionId: 'test-existing', cwd: '/tmp', curParts: [] };
  let resolved = 0;
  context.runCodexTurn(session, { text: 'test', qid: 'test-qid' }, () => resolved++);
  assert.equal(resolved, 1);
  assert.equal(session.proc, null);
  assert.equal(session.lastTurnError, 'spawn E2BIG');
  assert.deepEqual(events.map(event => event.type), ['error', 'done']);
  assert.ok(notes[0][2].includes('spawn E2BIG'));
}


// Drive the real turn callback and worker completion branch with account errors.
// In particular, /goal can fail AFTER finish() has already resolved the worker.
{
  const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('function runCodexTurn('), source.indexOf('// Team Claude is intentionally separate'));
  const guard = source.match(/function stopTaskFinisherOnCodexCreditError\(s, error\) \{[\s\S]*?\n\}/)[0];
  const appendHistory = source.slice(source.indexOf('function appendCodexMessage('), source.indexOf('function ensureTeamClaudeSession('));
  const flushHistory = source.slice(source.indexOf('function flushCodexAssistant('), source.indexOf('function ensureGeminiSession('));
  const completionStart = source.indexOf('    if (s.sessionId && !s.canceled && !s.codexCreditBlocked)');
  assert.ok(completionStart > 0);
  const completion = source.slice(completionStart, source.indexOf('    s.inflight = null;', completionStart));
  for (const event of [
    { type: 'error', msg: "You've hit your usage limit" },
    { type: 'notice', text: 'Insufficient credits' },
    { type: 'error', code: 'insufficient_quota', msg: 'Account unavailable' },
  ]) for (const lateGoal of [false, true]) {
    let policy = armTaskFinisher();
    let onEvent;
    let persisted = 0;
    let resolved = 0;
    const child = new EventEmitter();
    child.exitCode = null; child.signalCode = null;
    const manual = { qid: 'manual', text: 'Preserve this exact user message' };
    const session = { sessionId: 'test-existing', agent: 'codex', cwd: '/tmp', curParts: [], queue: [
      { qid: 'automatic', taskFinisherContinuation: true }, manual,
    ] };
    const context = {
      CODEX_TURN_SEQ: 0, CODEX_TURN_TIMEOUT_MS: 1000, DEFAULT_SETTINGS: { codex: {} },
      setTimeout, clearTimeout, sessionUsesTeamSandbox: () => false, sessionInTeamWorkspaceOf: () => false,
      stopTail() {}, codexUserParts: () => [], sessionIsGuest: () => false,
      codexEngine: { run(options) { onEvent = options.onEvent; return child; } },
      cleanCodexError: String, codexAssistantParts: () => [], flushCodexAssistant() {},
      appendCodexMessage() {}, ensureTail() {}, triggerAttentionUpdate() {}, bcast() {},
      persist() { persisted++; }, queueView: s => s.queue,
      codexCreditExhausted,
      stopTaskFinisherForSession: (_id, state, reason) => { policy = stopTaskFinisher(policy, state, reason); },
      armTaskFinisherForSession: () => { policy = armTaskFinisher(policy); },
      handleTaskFinisherFailureForSession: () => { policy = recordTaskFinisherFailure(policy); },
      taskFinisherStopRequested: () => false,
      requestScheduleTick() {}, runWorker() {},
      s: session, msg: { taskFinisherArm: true, taskFinisherContinuation: true }, completedText: '',
    };
    vm.createContext(context);
    vm.runInContext(guard + '\n' + handler, context);
    context.runCodexTurn(session, { text: 'test', qid: 'test' }, () => resolved++);
    if (lateGoal) {
      onEvent({ type: 'turn_end' });
      vm.runInContext(completion, context);
      assert.equal(policy.armed, true, 'a successful first goal turn can arm');
    }
    onEvent(event);
    child.emit('close');
    vm.runInContext(completion, context);
    assert.equal(resolved, 1);
    assert.equal(policy.armed, false, 'credit errors cannot re-arm or retry');
    assert.equal(policy.state, 'error');
    assert.equal(policy.failoverModel, null, 'no model failover on account exhaustion');
    assert.equal(policy.consecutiveFailureCount, 0, 'stops on the first error');
    assert.equal(session.queue.length, 1);
    assert.equal(session.queue[0], manual, 'manual messages are preserved exactly');
    assert.equal(persisted, 1, 'automatic queue removal is durable');
    // Provisional startup failures also stop their schedule; ordinary transient
    // errors and other providers do not activate this Codex account guard.
    session.sessionId = null; session.provKey = 'new-test';
    assert.equal(context.stopTaskFinisherOnCodexCreditError(session, event), true);
    assert.equal(context.stopTaskFinisherOnCodexCreditError(session, '429 Too many requests'), false);
    session.agent = 'claude';
    assert.equal(context.stopTaskFinisherOnCodexCreditError(session, event), false);
  }
}

// An incomplete process exit must reach the same bounded continuation retry policy as
// an explicit error. Exercise the real handler and worker completion branch so
// persisted warning text alone cannot accidentally count as a successful turn.
{
  const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('function runCodexTurn('), source.indexOf('// Team Claude is intentionally separate'));
  const appendHistory = source.slice(source.indexOf('function appendCodexMessage('), source.indexOf('function ensureTeamClaudeSession('));
  const flushHistory = source.slice(source.indexOf('function flushCodexAssistant('), source.indexOf('function ensureGeminiSession('));
  const completionStart = source.indexOf('    if (s.sessionId && !s.canceled && !s.codexCreditBlocked)');
  const completion = source.slice(completionStart, source.indexOf('    s.inflight = null;', completionStart));
  function run({ policy = armTaskFinisher(), outcome = 'empty', canceled = false, manual = false, partial = false } = {}) {
    const child = new EventEmitter();
    child.exitCode = null; child.signalCode = null;
    let onEvent, timeout;
    let now = 0;
    let resolved = 0;
    const notes = [];
    const finalized = [];
    const events = [];
    let registry = JSON.stringify({ sessions: { 'test-existing': { id: 'test-existing', title: 'Test' } } });
    let history = '[]';
    const partialParts = [{ t: 'text', text: 'Partial progress' }, { t: 'tool', name: 'shell', output: 'Synthetic tool output' }];
    const queued = { qid: 'manual-queued', text: 'Keep this queued message' };
    const session = { sessionId: 'test-existing', agent: 'codex', cwd: '/tmp', canceled, lastTurnError: '',
      curParts: partial ? partialParts : [], queue: [queued] };
    const terminated = [];
    const context = {
      CODEX_TURN_SEQ: 0, CODEX_TURN_TIMEOUT_MS: 1000, DEFAULT_SETTINGS: { codex: {} },
      Date: { now: () => now },
      setTimeout: callback => { timeout = callback; return 1; }, clearTimeout() {},
      sessionUsesTeamSandbox: () => false, sessionInTeamWorkspaceOf: () => false,
      stopTail() {}, codexUserParts: () => [], sessionIsGuest: () => false,
      codexEngine: { run(options) { onEvent = options.onEvent; return child; } },
      stopTaskFinisherOnCodexCreditError: () => false, cleanCodexError: String,
      codexAssistantParts: parts => parts,
      loadCodex: () => JSON.parse(registry), saveCodex: state => { registry = JSON.stringify(state); },
      loadCodexMessages: () => JSON.parse(history), saveCodexMessages: (_id, rows) => { history = JSON.stringify(rows); },
      ensureTail() {}, triggerAttentionUpdate() {}, bcast: (_s, event) => events.push(event),
      killAgentProcess(_proc, signal) { terminated.push(signal); return true; },
      terminateProcessWithEscalation(proc, options) { options.signalProcess(proc, 'SIGTERM'); },
      requestScheduleTick() {}, runWorker() {},
      taskFinisherStopRequested: () => false,
      armTaskFinisherForSession: () => { policy = armTaskFinisher(policy); },
      handleTaskFinisherFailureForSession: () => { policy = recordTaskFinisherFailure(policy); },
      updateTaskFinisher: (_id, update) => { policy = update(policy); },
      clearTaskFinisherFailureCount, noteTaskFinisherActivityForSession() {},
      s: session, msg: manual ? { taskFinisherArm: true } : { taskFinisherContinuation: true }, completedText: '',
    };
    vm.createContext(context);
    vm.runInContext(appendHistory + flushHistory + handler, context);
    const persistAppend = context.appendCodexMessage;
    const persistFlush = context.flushCodexAssistant;
    context.appendCodexMessage = (...args) => { notes.push(args); return persistAppend(...args); };
    context.flushCodexAssistant = (s, options) => {
      if (options.finalize) finalized.push(s.curParts);
      return persistFlush(s, options);
    };
    context.runCodexTurn(session, { text: 'test', qid: 'test' }, () => resolved++);
    if (partial) context.flushCodexAssistant(session, { finalize: false });
    if (outcome === 'completed') onEvent({ type: 'turn_end' });
    else if (outcome === 'timeout') { now = 1000; timeout(); }
    child.emit('close');
    assert.equal(resolved, 1, 'late close must not complete the same turn twice');
    vm.runInContext(completion, context);
    assert.equal(session.queue[0], queued, 'failure accounting preserves queued user work');
    assert.equal(session.queue.length, 1);
    if (partial) assert.deepEqual(finalized, [partialParts], 'partial text and tool output still reach history finalization unchanged');
    const reloaded = JSON.parse(history);
    if (partial) {
      assert.deepEqual(reloaded[0].parts, partialParts, 'reloaded history preserves exact partial text and tool output');
      assert.equal(reloaded[0].live, undefined, 'the original live row is finalized in place');
    }
    assert.equal(reloaded.length, Number(partial) + notes.length, 'warnings persist separately without duplicating partial output');
    if (notes.length) {
      assert.equal(reloaded.at(-1).parts[0].text, notes[0][2], 'the warning survives history reload');
      assert.equal(reloaded.at(-1).boxNotice, 'codex-incomplete');
    }
    return { policy, session, notes, events, terminated };
  }
  const first = run();
  assert.equal(first.session.lastTurnError, 'Codex exited without a response');
  assert.equal(first.notes[0][2], '⚠️ Codex exited without a response. Send again to retry.');
  assert.equal(first.policy.armed, true);
  assert.equal(first.policy.consecutiveFailureCount, 1);
  assert.equal(first.policy.failoverModel, 'gpt-5.6-sol');
  const second = run({ policy: first.policy });
  assert.equal(second.policy.armed, false, 'repeated empty exits stop automatic continuation');
  assert.equal(second.policy.state, 'error');
  for (const partial of [false, true]) {
    const timedOut = run({ outcome: 'timeout', partial, policy: first.policy });
    assert.equal(timedOut.session.lastTurnError, 'Codex turn timed out');
    assert.equal(timedOut.policy.armed, false, 'timeouts count even after partial progress');
    assert.deepEqual(timedOut.terminated, ['SIGTERM'], 'idle timeout uses process-group termination with escalation');
    assert.equal(timedOut.notes.length, 1);
    assert.equal(timedOut.notes[0][2], `⚠️ ${timedOut.events.find(event => event.type === 'error').msg}`, 'live and persisted warnings agree');
    if (partial) assert.match(timedOut.notes[0][2], /before completing its response\. Partial output was saved/);
  }
  {
    let now = 0;
    let timeout;
    let delay;
    let onEvent;
    let resolved = 0;
    const child = new EventEmitter();
    child.exitCode = null; child.signalCode = null;
    const context = {
      CODEX_TURN_SEQ: 0, CODEX_TURN_TIMEOUT_MS: 1000, DEFAULT_SETTINGS: { codex: {} },
      Date: { now: () => now },
      setTimeout: (callback, ms) => { timeout = callback; delay = ms; return 1; }, clearTimeout() {},
      sessionUsesTeamSandbox: () => false, sessionInTeamWorkspaceOf: () => false,
      stopTail() {}, codexUserParts: () => [], sessionIsGuest: () => false,
      codexEngine: { run(options) { onEvent = options.onEvent; return child; } },
      stopTaskFinisherOnCodexCreditError: () => false, cleanCodexError: String,
      codexAssistantParts: () => [], flushCodexAssistant() {}, appendCodexMessage() {},
      ensureTail() {}, triggerAttentionUpdate() {}, bcast() {},
      killAgentProcess() { throw new Error('active turn must not be terminated'); },
      terminateProcessWithEscalation() { throw new Error('active turn must not be terminated'); },
    };
    vm.createContext(context);
    vm.runInContext(handler, context);
    const session = { sessionId: 'test-existing', cwd: '/tmp', curParts: [] };
    context.runCodexTurn(session, { text: 'test', qid: 'test' }, () => resolved++);
    now = 900;
    onEvent({ type: 'thinking' });
    now = 1000;
    timeout();
    assert.equal(resolved, 0, 'recent engine activity keeps the turn alive');
    assert.equal(delay, 900, 'watchdog reschedules for the remaining inactivity window');
    onEvent({ type: 'turn_end' });
    assert.equal(resolved, 1);
  }
  const partialExit = run({ partial: true, policy: first.policy });
  assert.equal(partialExit.session.lastTurnError, 'Codex exited before completing its response');
  assert.equal(partialExit.policy.armed, false, 'partial output without completion must not reset the retry bound');
  assert.equal(partialExit.notes[0][2], '⚠️ Codex exited before completing its response. Partial output was saved. Send again to retry.');
  assert.equal(partialExit.notes[0][2], `⚠️ ${partialExit.events.find(event => event.type === 'error').msg}`);
  const completed = run({ outcome: 'completed', policy: first.policy });
  assert.equal(completed.session.lastTurnError, '', 'explicit completion may have no assistant text');
  assert.equal(completed.policy.consecutiveFailureCount, 0);
  assert.equal(completed.policy.failoverModel, null);
  for (const partial of [false, true]) {
    const successful = run({ outcome: 'completed', partial });
    assert.equal(successful.notes.length, 0);
    assert.equal(successful.events.some(event => event.type === 'error'), false);
  }
  for (const outcome of ['empty', 'timeout']) {
    const canceled = run({ outcome, canceled: true, partial: true, policy: first.policy });
    assert.equal(canceled.session.lastTurnError, '');
    assert.equal(canceled.policy, first.policy, 'cancellation must not count as another failure');
    assert.equal(canceled.notes.length, 0);
    assert.equal(canceled.events.some(event => event.type === 'error'), false);
  }
  const manual = run({ manual: true, policy: second.policy });
  assert.equal(manual.policy.armed, true, 'manual retry retains existing arming behavior');
  assert.equal(manual.policy.consecutiveFailureCount, 0, 'manual retry starts with a fresh failure budget');
  assert.equal(manual.policy.failoverModel, null, 'manual retry starts on the selected model');
}

// Native rollout history must retain its authoritative output while exposing only
// explicitly tagged Box notices on the latest page, never mirrored sidecar rows.
{
  const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  const historyHandler = source.slice(source.indexOf('function mergeCodexIncompleteNotices('), source.indexOf('// ---- helpers: available skills/commands'));
  const native = [
    { role: 'user', parts: [{ t: 'text', text: 'Synthetic request' }], ts: '2026-09-16T12:00:00Z' },
    { role: 'assistant', parts: [{ t: 'text', text: 'Exact native partial output' }, { t: 'tool', name: 'shell', output: 'Exact native tool output' }], ts: '2026-09-16T12:00:01Z' },
  ];
  const notice = { role: 'assistant', parts: [{ t: 'text', text: 'Incomplete response warning' }], ts: Date.parse('2026-09-16T12:00:02Z'), boxNotice: 'codex-incomplete' };
  const sidecar = [
    { ...notice, ts: Date.parse('2026-09-15T12:00:00Z') },
    { role: 'assistant', parts: [{ t: 'text', text: 'Mirrored sidecar partial' }], ts: native[1].ts },
    notice,
  ];
  const context = {
    loadCodex: () => ({ sessions: { test: { cwd: '/tmp' } } }), CODEX_HOME: '/tmp',
    findCodexRollout: () => '/tmp/synthetic-rollout', codexRolloutHistory: async () => ({ messages: native, hasMore: true, cursor: 500, liveCursor: 1000 }),
    loadCodexMessages: () => sidecar, HIST_MSG_LIMIT: 100,
    enrichCodexHistory: (_id, rows) => rows, normalizeSettings: value => value,
    contextForSession: () => ({}), readCodexCompactionInfo: () => null,
  };
  vm.createContext(context);
  vm.runInContext(historyHandler, context);
  const latest = await context.sessionHistory('test');
  assert.deepEqual(Array.from(latest.messages), [...native, notice], 'latest native history includes a separate tagged notice without older or mirrored sidecar rows');
  assert.equal(latest.messages[1], native[1], 'native partial text and tool rows stay untouched');
  assert.equal(latest.cursor, 500);
  assert.equal(latest.hasMore, true);
  const older = await context.sessionHistory('test', { before: 500 });
  assert.deepEqual(Array.from(older.messages), native, 'loading older pages must not repeat latest sidecar notices');
  context.findCodexRollout = () => null;
  const sidecarOnly = await context.sessionHistory('test');
  assert.deepEqual(Array.from(sidecarOnly.messages), sidecar, 'sessions without native rollouts keep their existing sidecar history');
}

console.log('✅ codex-exec-engine.test.mjs passed');
