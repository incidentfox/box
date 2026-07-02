#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: v } = parseArgs({
  options: {
    repo: { type: 'string' },
    root: { type: 'string' },
    once: { type: 'boolean' },
    interval: { type: 'string' },
    'work-dir': { type: 'string' },
    'state-file': { type: 'string' },
    'auto-merge': { type: 'string' },
    'real-model': { type: 'string' },
    'review-model': { type: 'string' },
    'smoke-model': { type: 'string' },
    'trusted-authors': { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
});

const ROOT = resolve(v.root || process.cwd());
const WORK_DIR = resolve(v['work-dir'] || process.env.BOX_PR_WORK_DIR || join(homedir(), '.cache', 'box-pr-autopilot'));
const STATE_FILE = resolve(v['state-file'] || process.env.BOX_PR_STATE_FILE || join(homedir(), '.cc-mobile', 'box-pr-autopilot.json'));
const AUTO_MERGE = String(v['auto-merge'] || process.env.BOX_PR_AUTO_MERGE || '1') !== '0';
const REAL_MODEL_POLICY = String(v['real-model'] || process.env.BOX_PR_REAL_MODEL || 'trusted');
const REVIEW_MODEL = v['review-model'] || process.env.BOX_PR_REVIEW_MODEL || 'gpt-4.1-mini';
const SMOKE_MODEL = v['smoke-model'] || process.env.BOX_PR_SMOKE_MODEL || REVIEW_MODEL;
const TRUSTED_AUTHORS = new Set(String(v['trusted-authors'] || process.env.BOX_PR_TRUSTED_AUTHORS || '').split(',').map((s) => s.trim()).filter(Boolean));
const EVENT_EMITTER = process.env.BOX_PR_EVENT_EMITTER || '/home/factory/development/software-factory/harness/emit-event.mjs';
const DRY_RUN = !!v['dry-run'] || process.env.BOX_PR_DRY_RUN === '1';
const LOOP = !v.once;
const INTERVAL_MS = Number(v.interval || process.env.BOX_PR_INTERVAL_MS || 180000);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    env: opts.env || process.env,
    encoding: 'utf8',
    maxBuffer: opts.maxBuffer || 20 * 1024 * 1024,
    timeout: opts.timeout || 10 * 60 * 1000,
  });
  const status = r.status == null ? (r.signal ? 128 : 1) : r.status;
  return {
    ok: status === 0,
    status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    text: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

function must(cmd, args, opts = {}) {
  const r = run(cmd, args, opts);
  if (!r.ok) throw new Error(`${cmd} ${args.join(' ')} failed\n${r.text.slice(-4000)}`);
  return r.stdout.trim();
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return { prs: {} }; }
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function repoSlug() {
  if (v.repo || process.env.BOX_PR_REPO) return v.repo || process.env.BOX_PR_REPO;
  const out = must('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  return out;
}

function listPrs(repo) {
  const json = must('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--base', 'main', '--json',
    'number,title,url,isDraft,headRefOid,headRefName,headRepositoryOwner,author,mergeStateStatus,isCrossRepository,labels']);
  return JSON.parse(json);
}

function status(repo, sha, state, description, context = 'box-pr-autopilot', targetUrl = '') {
  if (DRY_RUN) { console.log(`[dry-run] status ${state} ${context}: ${description}`); return; }
  run('gh', ['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`,
    '-f', `state=${state}`,
    '-f', `context=${context}`,
    '-f', `description=${description.slice(0, 140)}`,
    ...(targetUrl ? ['-f', `target_url=${targetUrl}`] : []),
  ]);
}

function prLabels(pr) {
  return new Set((pr.labels || []).map((l) => l.name || l).filter(Boolean));
}

function shouldUseRealModel(pr, repo) {
  if (REAL_MODEL_POLICY === '0' || REAL_MODEL_POLICY === 'false' || REAL_MODEL_POLICY === 'never') return false;
  if (REAL_MODEL_POLICY === '1' || REAL_MODEL_POLICY === 'true' || REAL_MODEL_POLICY === 'always') return true;
  const owner = repo.split('/')[0];
  const headOwner = pr.headRepositoryOwner && pr.headRepositoryOwner.login;
  const author = pr.author && pr.author.login;
  return !pr.isCrossRepository || headOwner === owner || TRUSTED_AUTHORS.has(author) || TRUSTED_AUTHORS.has(headOwner);
}

function checkoutPr(repo, pr) {
  const dir = join(WORK_DIR, `pr-${pr.number}-${pr.headRefOid.slice(0, 12)}`);
  if (existsSync(dir)) return dir;
  mkdirSync(WORK_DIR, { recursive: true });
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  must('gh', ['repo', 'clone', repo, tmp, '--', '--filter=blob:none'], { cwd: WORK_DIR, timeout: 180000 });
  must('gh', ['pr', 'checkout', String(pr.number), '--repo', repo], { cwd: tmp, timeout: 120000 });
  const sharedNodeModules = join(ROOT, 'node_modules');
  if (!existsSync(join(tmp, 'node_modules')) && existsSync(sharedNodeModules)) {
    symlinkSync(sharedNodeModules, join(tmp, 'node_modules'), 'dir');
    appendFileSync(join(tmp, '.git', 'info', 'exclude'), '\nnode_modules\n');
  }
  renameSync(tmp, dir);
  return dir;
}

function runChecks(dir, realModel) {
  const out = [];
  const env = {
    ...process.env,
    BOX_SMOKE_MODEL: SMOKE_MODEL,
    BOX_PR_AUTOPILOT: '1',
  };
  const unit = run('npm', ['test'], { cwd: dir, env, timeout: 180000 });
  out.push(['npm test', unit]);
  if (!unit.ok) return { ok: false, phase: 'tests', out };

  const smokeArgs = [join(ROOT, 'scripts', 'smoke-chat.mjs'), '--root', dir, '--model', SMOKE_MODEL];
  if (!realModel) smokeArgs.push('--fake-codex');
  const smoke = run(process.execPath, smokeArgs, { cwd: dir, env, maxBuffer: 10 * 1024 * 1024, timeout: Number(process.env.BOX_PR_SMOKE_TIMEOUT_MS || 180000) + 15000 });
  out.push([realModel ? 'smoke chat (real Codex)' : 'smoke chat (fake Codex)', smoke]);
  if (!smoke.ok) return { ok: false, phase: 'smoke', out };

  return { ok: true, out };
}

function reviewPr(dir, pr) {
  const prompt = `Review this Box pull request read-only.

PR #${pr.number}: ${pr.title}

Run only inspection commands. Do not edit files. Focus on bugs, regressions, auth/security issues, broken startup/chat behavior, and missing tests. If it is safe to merge, output JSON only:
{"decision":"pass","summary":"...","findings":[]}

If it should not merge, output:
{"decision":"fail","summary":"...","findings":["..."]}`;
  const args = ['exec', '--json', '--model', REVIEW_MODEL, '--sandbox', 'read-only', '--skip-git-repo-check', '-C', dir, prompt];
  const r = run('codex', args, { cwd: dir, maxBuffer: 20 * 1024 * 1024, timeout: Number(process.env.BOX_PR_REVIEW_TIMEOUT_MS || 300000) });
  if (!r.ok) return { ok: false, decision: 'fail', summary: 'Codex review command failed', raw: r.text.slice(-6000) };
  const raw = r.stdout.split('\n').map((line) => {
    try {
      const o = JSON.parse(line);
      return o.item?.text || o.payload?.message || '';
    } catch { return ''; }
  }).filter(Boolean).join('\n').trim() || r.stdout;
  const m = raw.match(/\{[\s\S]*"decision"[\s\S]*\}/);
  try {
    const parsed = JSON.parse(m ? m[0] : raw);
    return { ok: parsed.decision === 'pass', decision: parsed.decision || 'fail', summary: parsed.summary || '', findings: parsed.findings || [], raw };
  } catch {
    return { ok: false, decision: 'fail', summary: 'Codex review did not return parseable JSON', raw: raw.slice(-6000) };
  }
}

function comment(repo, pr, body) {
  if (DRY_RUN) { console.log(`[dry-run] comment PR #${pr.number}:\n${body.slice(0, 1200)}\n`); return; }
  run('gh', ['pr', 'comment', String(pr.number), '--repo', repo, '--body', body]);
}

function summarizeOutputs(checks) {
  return checks.out.map(([name, r]) => `### ${name}\n\nExit: ${r.status}\n\n\`\`\`\n${r.text.slice(-3000).trim() || '(no output)'}\n\`\`\``).join('\n\n');
}

function emitMergedEvent(repo, pr) {
  if (DRY_RUN) { console.log(`[dry-run] emit merged event for PR #${pr.number}`); return; }
  if (!existsSync(EVENT_EMITTER)) return;
  run(process.execPath, [EVENT_EMITTER,
    '--type', 'code_update',
    '--title', `Box PR #${pr.number} merged to main`,
    '--summary', `${pr.title}\n\n${pr.url}\n\nMain changed. Active Box agents should fetch/rebase or fast-forward their own worktree when ready; no shared checkout was force-pulled by autopilot.`,
    '--projects', 'box',
    '--url', pr.url,
    '--source', 'box-pr-autopilot',
    '--id', `box-pr-merged-${pr.number}-${pr.headRefOid}`,
  ]);
}

function mergePr(repo, pr) {
  if (DRY_RUN) return { ok: true, output: '[dry-run] merge skipped' };
  const r = run('gh', ['pr', 'merge', String(pr.number), '--repo', repo, '--squash', '--delete-branch']);
  return r.ok ? { ok: true, output: r.text } : { ok: false, output: r.text };
}

async function passOnce() {
  const repo = repoSlug();
  const state = loadState();
  const prs = listPrs(repo);
  for (const pr of prs) {
    const key = `${pr.number}:${pr.headRefOid}`;
    if (state.prs[key]?.merged || state.prs[key]?.blocked) continue;
    const labels = prLabels(pr);
    if (pr.isDraft || labels.has('no-automerge') || labels.has('do-not-merge')) {
      state.prs[key] = { skipped: true, reason: pr.isDraft ? 'draft' : 'label', at: new Date().toISOString() };
      saveState(state);
      continue;
    }
    status(repo, pr.headRefOid, 'pending', 'Box local checks running', 'box/local-autopilot', pr.url);
    try {
      const realModel = shouldUseRealModel(pr, repo);
      const dir = checkoutPr(repo, pr);
      const checks = runChecks(dir, realModel);
      if (!checks.ok) {
        status(repo, pr.headRefOid, 'failure', `Box ${checks.phase} failed`, 'box/local-autopilot', pr.url);
        comment(repo, pr, `Box autopilot failed during **${checks.phase}**.\n\n${summarizeOutputs(checks)}`);
        state.prs[key] = { blocked: true, phase: checks.phase, at: new Date().toISOString() };
        saveState(state);
        continue;
      }
      const review = reviewPr(dir, pr);
      if (!review.ok) {
        status(repo, pr.headRefOid, 'failure', 'Agent review did not approve merge', 'box/local-autopilot', pr.url);
        comment(repo, pr, `Box autopilot checks passed, but agent review did not approve merge.\n\nSummary: ${review.summary || '(none)'}\n\nFindings:\n${(review.findings || []).map((f) => `- ${f}`).join('\n') || '(none)'}\n\n<details><summary>Raw review</summary>\n\n\`\`\`\n${String(review.raw || '').slice(-6000)}\n\`\`\`\n</details>`);
        state.prs[key] = { blocked: true, phase: 'review', at: new Date().toISOString() };
        saveState(state);
        continue;
      }
      status(repo, pr.headRefOid, 'success', 'Box checks and agent review passed', 'box/local-autopilot', pr.url);
      comment(repo, pr, `Box autopilot passed.\n\n- npm test: passed\n- chat smoke: passed (${realModel ? `real Codex, ${SMOKE_MODEL}` : 'fake Codex fallback'})\n- agent review: ${review.summary || 'passed'}\n\n${AUTO_MERGE ? 'Auto-merge is enabled; merging now.' : 'Auto-merge is disabled.'}`);
      if (AUTO_MERGE) {
        const merged = mergePr(repo, pr);
        if (merged.ok) {
          emitMergedEvent(repo, pr);
          state.prs[key] = { merged: true, at: new Date().toISOString() };
        } else {
          state.prs[key] = { blocked: true, phase: 'merge', at: new Date().toISOString(), output: merged.output.slice(-3000) };
          comment(repo, pr, `Box autopilot could not merge after passing checks.\n\n\`\`\`\n${merged.output.slice(-3000)}\n\`\`\``);
        }
      } else {
        state.prs[key] = { passed: true, at: new Date().toISOString() };
      }
      saveState(state);
    } catch (e) {
      status(repo, pr.headRefOid, 'error', 'Box autopilot crashed', 'box/local-autopilot', pr.url);
      comment(repo, pr, `Box autopilot crashed.\n\n\`\`\`\n${String(e && e.stack || e).slice(-6000)}\n\`\`\``);
      state.prs[key] = { blocked: true, phase: 'crash', at: new Date().toISOString() };
      saveState(state);
    }
  }
}

do {
  await passOnce();
  if (LOOP) await new Promise((resolveLoop) => setTimeout(resolveLoop, INTERVAL_MS));
} while (LOOP);
