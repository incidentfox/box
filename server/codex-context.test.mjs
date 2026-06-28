// Hermetic test for codex-context.mjs — builds a fake rollout tree in a temp dir, so it
// has NO dependency on a real ~/.codex (safe in CI). Run: node server/codex-context.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { findCodexRollout, readCodexTokenInfo } from './codex-context.mjs';

const root = mkdtempSync(join(tmpdir(), 'codex-ctx-'));
try {
  const id = '019f1059-6b3c-7922-959d-a4c5d4e86f9c';
  const day = join(root, 'sessions', '2026', '06', '28');
  mkdirSync(day, { recursive: true });
  const file = join(day, `rollout-2026-06-28T22-28-43-${id}.jsonl`);

  // Mimic a real session: cumulative input climbs each turn, but last_token_usage
  // (the live window occupancy) stays roughly flat — this is the whole point.
  const tc = (lastIn, totalIn) => JSON.stringify({
    timestamp: '2026-06-28T22:29:34.818Z', type: 'event_msg',
    payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: totalIn, cached_input_tokens: totalIn - 30000, output_tokens: 35, reasoning_output_tokens: 13, total_tokens: totalIn + 35 },
      last_token_usage: { input_tokens: lastIn, cached_input_tokens: lastIn - 380, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: lastIn + 5 },
      model_context_window: 258400,
    }, rate_limits: null },
  });
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id } }),
    tc(32992, 32992),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'one' } }),
    tc(33182, 66174),
    tc(33357, 99531),
    tc(33532, 133063), // newest — this is the live figure we must read
  ];
  writeFileSync(file, lines.join('\n') + '\n');

  // 1. locate the rollout by thread id
  const resolved = findCodexRollout(root, id);
  assert.equal(resolved, file, 'findCodexRollout should locate the rollout under sessions/YYYY/MM/DD');

  // 2. read the LAST token_count info (not an earlier one)
  const info = readCodexTokenInfo(resolved);
  assert.ok(info, 'readCodexTokenInfo should return an info object');
  assert.equal(info.last_token_usage.total_tokens, 33537, 'must read the live (last) usage, ~33k');
  assert.equal(info.model_context_window, 258400, 'must carry the real context window');

  // 3. the bug invariant: live (last) is far below the cumulative total — if we read the
  //    cumulative we would have shown ~133k (→ inflated %); reading last gives the truth.
  assert.ok(
    info.last_token_usage.input_tokens < info.total_token_usage.input_tokens / 3,
    'live last_token_usage must be far below the cumulative total (regression guard for the 999% bug)',
  );

  // 4. missing id / file → null, never throws
  assert.equal(findCodexRollout(root, 'does-not-exist'), null);
  assert.equal(readCodexTokenInfo(null), null);
  assert.equal(readCodexTokenInfo(join(day, 'nope.jsonl')), null);

  console.log('✅ codex-context.test.mjs passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
