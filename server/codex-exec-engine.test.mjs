// Tests for buildCodexArgs — guards the variadic `-i/--image` ordering bug, where images placed
// before the positional prompt made codex's variadic `-i` swallow the prompt (and the session id
// on resume), so an image message silently vanished. Run: node server/codex-exec-engine.test.mjs
import assert from 'node:assert/strict';
import { buildCodexArgs } from './codex-exec-engine.mjs';

// Helper: index of the LAST `-i` flag, and the positions of the positionals.
const lastImageFlagIdx = (a) => a.lastIndexOf('-i');

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

console.log('✅ codex-exec-engine.test.mjs passed');
