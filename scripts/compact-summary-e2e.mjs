#!/usr/bin/env node
// Claude writes its compaction summary (including the idle compaction it runs before the
// prompt cache expires) as a user-role JSONL row. Box must show it as a collapsed divider:
// not as a user bubble, not as a turn that never answers, and not as fresh chat activity.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempHome = mkdtempSync(join(tmpdir(), 'box-compact-summary-e2e-'));
const workspace = join(tempHome, 'workspace');
const id = '00000000-0000-4000-8000-000000000317';
const title = 'Synthetic compacted session';
const token = 'compact-summary-test-token';
const project = join(tempHome, '.claude', 'projects', '-synthetic');
const file = join(project, `${id}.jsonl`);
const SUMMARY = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\nSYNTHETIC_SUMMARY_BODY';
const answeredAt = '2026-10-20T22:36:00.000Z';
const compactedAt = '2026-10-20T23:31:02.000Z';
const compactionRows = (ts) => [
  { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: ts, compactMetadata: { trigger: 'manual' } },
  { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: ts, message: { role: 'user', content: SUMMARY } },
  { type: 'attachment', timestamp: ts, attachment: { type: 'hook_success', hookName: 'SessionStart:compact' } },
  { type: 'system', subtype: 'informational', content: 'Compacted while idle, before the prompt cache expired', timestamp: ts },
];
mkdirSync(project, { recursive: true });
mkdirSync(workspace, { recursive: true });
const rows = [
  { type: 'user', timestamp: '2026-10-20T22:35:00.000Z', message: { role: 'user', content: 'SYNTHETIC_REQUEST' } },
  { type: 'assistant', timestamp: answeredAt, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'SYNTHETIC_FINAL_ANSWER' }] } },
  { type: 'custom-title', customTitle: title, sessionId: id },
  ...compactionRows(compactedAt),
];
writeFileSync(file, `${rows.map(JSON.stringify).join('\n')}\n`);
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)); });
});
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT, env: {
  PATH: process.env.PATH, HOME: tempHome, PORT: String(port), CC_AUTH_TOKEN: token,
  CC_WORKSPACE: workspace, BOX_IGNORE_LOCAL_ENV: '1', BOX_HOST_SECRETS_FILE: '/dev/null',
  BOX_SKIP_META_PROBE: '1', BOX_TEAM: '0', LINEAR_LOCAL: 'off',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  const deadline = Date.now() + 20_000;
  while (true) {
    if (child.exitCode !== null) throw Error(`server exited: ${child.exitCode}`);
    try { if ((await fetch(base)).ok) break; } catch {}
    if (Date.now() > deadline) throw Error('server startup timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
  const headers = { Authorization: `Bearer ${token}` };
  const list = await (await fetch(`${base}/api/sessions`, { headers })).json();
  const row = (Array.isArray(list) ? list : list.sessions || []).find((s) => s.id === id);
  assert.ok(row, 'synthetic session is listed');
  assert.equal(row.preview, 'SYNTHETIC_FINAL_ANSWER', 'preview is the last real message, not the summary');
  assert.equal(new Date(row.lastTs || row.mtime).toISOString(), answeredAt, 'idle compaction is not chat activity');

  const history = await (await fetch(`${base}/api/sessions/${id}/history`, { headers })).json();
  const summary = history.messages.find((m) => m.compacted);
  assert.ok(summary, 'history marks the summary row as compacted');
  assert.equal(summary.role, 'user');

  const require = createRequire(import.meta.url);
  let playwright;
  try { playwright = require('@playwright/test'); } catch { playwright = require('/home/factory/development/tools/playwright/node_modules/@playwright/test'); }
  browser = await playwright.webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#tokenInput').fill(token);
  await page.locator('#loginBtn').click();
  await page.locator('#sessions:not(.hidden)').waitFor();
  await page.getByText(title, { exact: true }).first().click();
  await page.locator('#chat').getByText('SYNTHETIC_FINAL_ANSWER', { exact: true }).waitFor();
  await page.locator('.compactDivider').first().waitFor();
  assert.equal(await page.locator('.msg.user', { hasText: 'being continued' }).count(), 0, 'no summary user bubble');
  assert.equal(await page.locator('.compactDivider .compactText').first().isVisible(), false, 'summary is collapsed');

  // Live: a new idle compaction lands while the chat is open.
  await page.waitForTimeout(1500);
  appendFileSync(file, `${compactionRows(new Date().toISOString()).map(JSON.stringify).join('\n')}\n`);
  await page.locator('.compactDivider').nth(1).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.msg.user', { hasText: 'being continued' }).count(), 0, 'live summary is not a user bubble');
  assert.equal(await page.locator('#sendBtn').getAttribute('data-act'), 'send', 'no never-ending turn spinner');
  await page.locator('.compactDivider summary').nth(1).click();
  await page.locator('.compactDivider .compactText').nth(1).waitFor();
  await page.screenshot({ path: '/tmp/box-compact-summary.png', fullPage: false });
  console.log(JSON.stringify({ ok: true, screenshot: '/tmp/box-compact-summary.png' }));
} finally {
  await browser?.close().catch(() => {});
  child.kill('SIGTERM');
  await new Promise((r) => child.once('exit', r));
  rmSync(tempHome, { recursive: true, force: true });
}
