// quick_lookup — a fast, sandboxed, READ-ONLY helper agent for the voice assistant.
//
// Why: in thread voice, every question about the thread's work used to go to the thread's
// own Claude Code/Codex agent — a full turn that takes minutes and queues behind whatever
// it is already doing. Most of those questions ("what changed in the last commit?", "is the
// PR green?", "where is the retry logic?") are lookups a small model answers in seconds.
//
// How: a one-shot `claude -p` on a fast model (default haiku) in the project directory,
// boxed in by the CLI itself rather than by prompt wording:
//   --restricted            ignores user/project settings (so the box's bypassPermissions
//                           default and its hooks don't apply), confines file tools to the
//                           working directory, refuses bypassPermissions
//   --tools …               only Read/Grep/Glob/Bash exist
//   --permission-mode dontAsk + --allowedTools   Bash runs ONLY the read-only git/gh
//                           prefixes below (compound commands are denied); anything else is
//                           denied without a prompt
//   --disallowedTools Read(.env…)  secrets files inside the repo stay unreadable
//   --strict-mcp-config     no MCP servers
//   --no-session-persistence  no transcript lands in ~/.claude/projects, so the box feed
//                           doesn't fill with lookup chats
// Output is secret-scrubbed by the caller before it reaches the voice model.
//
// The runner waits a short while for the answer (most come back in 5–20s). If a lookup
// takes longer, the tool call returns "still looking" at once and the finished answer is
// announced to the call that asked — the voice conversation never sits blocked on it.

export const QUICK_ALLOWED_BASH = Object.freeze([
  'git log', 'git show', 'git diff', 'git status', 'git blame', 'git ls-files', 'git rev-parse',
  'gh pr view', 'gh pr list', 'gh pr checks', 'gh pr diff', 'gh run list', 'gh run view',
]);

export const QUICK_DENIED_READS = Object.freeze([
  './.env', './.env.*', './**/.env', './**/.env.*',
  './**/*.pem', './**/*.key', './**/secrets.env', './**/credentials.json', './**/.credentials.json',
]);

export const QUICK_FRAMING = 'You answer quick lookup questions for a live VOICE conversation with Jimmy (the founder). You are READ-ONLY: never try to change files, run builds/tests, or take actions — if the question needs that, say in one sentence that it needs a working agent. Look things up with your tools (Read/Grep/Glob, read-only git and gh), then answer in at most four short plain sentences that will be spoken aloud: the concrete facts and numbers, no markdown, no code blocks, no URLs, no long file paths (name things by what they are). If you could not find it, say so plainly instead of guessing. Never reveal secret values.';

export function quickLookupConfig(cfg) {
  const num = (k, d, lo, hi) => {
    const raw = cfg(k, '');
    const n = raw === '' || raw == null ? d : Number(raw);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return {
    enabled: !/^(0|false|no|off)$/i.test(String(cfg('VOICE_QUICK_LOOKUP', '1') || '1')),
    model: cfg('VOICE_QUICK_MODEL', 'haiku') || 'haiku',
    waitMs: num('VOICE_QUICK_WAIT_MS', 22000, 2000, 60000),     // how long the tool call waits inline
    timeoutMs: num('VOICE_QUICK_TIMEOUT_MS', 150000, 20000, 600000), // hard kill
    maxConcurrent: num('VOICE_QUICK_MAX_CONCURRENT', 3, 1, 8),
    // Lookup engines, in preference order (first = default). Codex's read-only sandbox needs
    // bubblewrap user namespaces; on Ubuntu 24.04 that takes a per-binary AppArmor userns
    // profile for /usr/bin/bwrap (installed on the box as /etc/apparmor.d/bwrap). Without it
    // Codex can't run even read-only git — set VOICE_QUICK_ENGINES=claude on such hosts.
    engines: String(cfg('VOICE_QUICK_ENGINES', 'claude,codex') || 'claude,codex').split(',').map((s) => s.trim().toLowerCase()).filter((e) => e === 'claude' || e === 'codex'),
    codexModel: cfg('VOICE_QUICK_CODEX_MODEL', 'gpt-6-luna') || 'gpt-6-luna',
  };
}

// Engines actually usable here (configured AND the CLI is installed), default first.
export function quickLookupEngines(config, { hasBin = () => true } = {}) {
  const list = (config.engines && config.engines.length ? config.engines : ['claude']).filter((e) => hasBin(e));
  return [...new Set(list)];
}

// Codex engine: `codex exec` in its read-only sandbox, ephemeral (no saved session), the
// final message written to outFile. Same framing as the Claude engine.
export function codexLookupArgs({ model = '', prompt = '', outFile } = {}) {
  return [
    'exec', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '-c', 'model_reasoning_effort="low"',
    ...(model ? ['-m', model] : []),
    '-o', outFile,
    '--', `${QUICK_FRAMING}\n\nQuestion: ${prompt}`,
  ];
}

export function quickLookupPrompt(question, context = '') {
  const q = String(question || '').trim();
  const c = String(context || '').trim();
  return c ? `${q}\n\nContext from the conversation (for orientation; verify against the repo):\n${c.slice(0, 3000)}` : q;
}

export function quickLookupArgs({ model = 'haiku', prompt = '' } = {}) {
  return [
    '-p', '--model', model,
    '--restricted', '--strict-mcp-config', '--no-session-persistence',
    '--permission-mode', 'dontAsk',
    '--tools', 'Read,Grep,Glob,Bash',
    '--allowedTools', ...QUICK_ALLOWED_BASH.map((p) => `Bash(${p}:*)`),
    '--disallowedTools', ...QUICK_DENIED_READS.map((p) => `Read(${p})`),
    '--append-system-prompt', QUICK_FRAMING,
    '--output-format', 'json',
    '--', prompt,
  ];
}

// `claude -p --output-format json` → { answer, costUsd, turns, denied } or { error }.
export function parseQuickResult({ code, out } = {}) {
  const text = String(out || '');
  let j = null;
  // stderr is merged into out; the JSON result is the last {...} line.
  for (const line of text.split('\n').reverse()) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try { j = JSON.parse(l); break; } catch {}
  }
  if (!j) {
    const head = text.trim().slice(0, 200);
    return { error: head ? `lookup failed: ${head}` : `lookup failed (exit ${code})` };
  }
  const answer = String(j.result || '').trim();
  if (j.is_error || !answer) return { error: `lookup failed: ${answer.slice(0, 200) || j.subtype || 'no answer'}` };
  if (/usage limit|out of credits|rate.?limit|run \/login|unauthorized|invalid api key/i.test(answer.slice(0, 300))) {
    return { error: `lookup unavailable: ${answer.slice(0, 160)}` };
  }
  return {
    answer,
    costUsd: Number(j.total_cost_usd) || 0,
    turns: Number(j.num_turns) || 0,
    denied: Array.isArray(j.permission_denials) ? j.permission_denials.length : 0,
  };
}

// The runner. Dependencies are injected so it is unit-testable without spawning claude.
//   run(cmd, args, {cwd, timeoutMs}) → Promise<{code, out}>
//   onBackgroundDone(job, result) — called when a lookup outlived the inline wait
//   tmpFile(id) / readText(path) / codexEnv() — only needed for the codex engine
//   codexCommand(args) → {cmd, args} — how to launch codex (default: `codex` on PATH)
export function createQuickLookupRunner({ run, config, redact = (s) => s, onBackgroundDone = () => {}, now = () => Date.now(), sleep, tmpFile, readText, codexEnv, codexCommand = (args) => ({ cmd: 'codex', args }), engines = ['claude'] } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref && t.unref(); }));
  const active = new Set();

  async function execute(job) {
    let parsed;
    if (job.engine === 'codex') {
      if (!tmpFile || !readText) return { error: 'codex lookup is not wired on this box' };
      const outFile = tmpFile(job.id);
      const launch = codexCommand(codexLookupArgs({ model: config.codexModel, prompt: job.prompt, outFile }));
      const r = await run(launch.cmd, launch.args, { cwd: job.cwd, timeoutMs: config.timeoutMs, env: codexEnv ? codexEnv() : undefined });
      const answer = String(readText(outFile) || '').trim();
      parsed = answer && r.code === 0 ? { answer, costUsd: 0, turns: 0, denied: 0 } : { error: `codex lookup failed: ${String(r.out || '').split('\n').filter((l) => /error/i.test(l)).slice(-1)[0] || `exit ${r.code}`}`.slice(0, 220) };
    } else {
      const r = await run('claude', quickLookupArgs({ model: config.model, prompt: job.prompt }), { cwd: job.cwd, timeoutMs: config.timeoutMs });
      parsed = parseQuickResult(r);
    }
    if (parsed.answer) parsed.answer = redact(parsed.answer);
    if (parsed.error) parsed.error = redact(parsed.error);
    return parsed;
  }

  // → { answer, ms, engine } | { status:'running', id } | { error }
  async function lookup({ question, context = '', cwd, id, engine = '' }) {
    if (!config.enabled) return { error: 'quick lookup is turned off on this box' };
    const eng = engine ? String(engine).toLowerCase() : engines[0] || 'claude';
    if (!engines.includes(eng)) return { error: `${eng} lookups are not available here; available: ${engines.join(', ')}` };
    if (!String(question || '').trim()) return { error: 'what should I look up?' };
    if (active.size >= config.maxConcurrent) return { error: `${active.size} lookups are already running; wait for one to finish` };
    const job = { id, engine: eng, question: String(question).trim(), prompt: quickLookupPrompt(question, context), cwd, startedAt: now(), inline: true };
    active.add(job);
    const p = execute(job)
      .catch((e) => ({ error: `lookup failed: ${String((e && e.message) || e).slice(0, 160)}` }))
      .finally(() => { active.delete(job); });
    const raced = await Promise.race([p, wait(config.waitMs).then(() => null)]);
    if (raced) return { ...raced, ms: now() - job.startedAt, engine: eng === 'codex' ? `codex (${config.codexModel || 'default model'}, read-only sandbox)` : `claude (${config.model}, read-only)` };
    // Outlived the inline wait: hand back now, announce the answer when it lands.
    job.inline = false;
    p.then((result) => { try { onBackgroundDone(job, { ...result, ms: now() - job.startedAt }); } catch {} });
    return { status: 'running', id: job.id, note: 'Still looking; the answer will be announced in this call when it lands.' };
  }

  return { lookup, get active() { return active.size; } };
}
