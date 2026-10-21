import assert from 'node:assert/strict';
import { mkdtempSync, openSync, closeSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import vm from 'node:vm';
import { isCompactSummaryEntry } from './rc-engine.mjs';

const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
const historyCode = source.slice(source.indexOf('const HIST_MSG_LIMIT ='), source.indexOf('function mergeCodexIncompleteNotices('));
const context = {
  Buffer, basename, dirname, join, closeSync, openSync, readFileSync, readSync, statSync,
  decodeCwd: () => '/synthetic',
  team: { splitAuthorTag: () => ({ author: null }) },
  summarizeToolInput: () => '', normalizeSettings: () => ({}), contextForSession: () => ({}),
  isCompactSummaryEntry,
};
vm.createContext(context);
vm.runInContext(historyCode, context);

const dir = mkdtempSync(join(tmpdir(), 'box-claude-history-'));
try {
  for (const [count, padding] of [[450, 0], [1200, 7000]]) {
    const file = join(dir, `${count}.jsonl`);
    const lines = Array.from({ length: count }, (_, i) => JSON.stringify({
      type: 'user', timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: `message ${i} 😀${'x'.repeat(padding)}` },
    }));
    writeFileSync(file, `${lines.join('\n')}\n`);
    const seen = [];
    let before = null;
    let pages = 0;
    do {
      const page = context.claudeSessionHistory(String(count), file, before);
      assert.ok(page.messages.length > 0 && page.messages.length <= 400);
      seen.unshift(...page.messages.map((row) => Number(row.parts[0].text.match(/^message (\d+)/)[1])));
      pages++;
      if (!page.hasMore) break;
      assert.ok(page.cursor > 0 && (before === null || page.cursor < before), 'cursor moves backward');
      before = page.cursor;
      assert.ok(pages < 10, 'pagination terminates');
    } while (true);
    assert.deepEqual(seen, Array.from({ length: count }, (_, i) => i), `${count} messages are reachable in order`);
    assert.equal(pages, Math.ceil(count / 400));
  }
  // A compaction summary keeps its slot (forks/exports still carry it) but is flagged so
  // the UI renders a divider instead of a user turn.
  const compacted = join(dir, 'compacted.jsonl');
  writeFileSync(compacted, [
    { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'real request' } },
    { type: 'user', isCompactSummary: true, timestamp: '2026-01-01T01:00:00Z', message: { role: 'user', content: 'This session is being continued from a previous conversation. Summary: ...' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const flagged = context.claudeSessionHistory('compacted', compacted).messages;
  assert.deepEqual(Array.from(flagged, (m) => !!m.compacted), [false, true]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('✅ claude-history-pagination.test.mjs passed');
