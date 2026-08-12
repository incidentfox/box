import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstVobRequestIdInRollout } from './vob-rollout-link.mjs';

const first = 'rise4_11111111111111111111111111111111';
const second = 'rise4_22222222222222222222222222222222';
const root = mkdtempSync(join(tmpdir(), 'box-vob-rollout-link-'));

try {
  const ordinary = join(root, 'ordinary.jsonl');
  writeFileSync(ordinary, `${'x'.repeat(128)}\n${second}\n`);
  assert.equal(firstVobRequestIdInRollout(ordinary, { maxBytes: 64, chunkBytes: 16 }), null);
  assert.equal(firstVobRequestIdInRollout(ordinary, { maxBytes: 256, chunkBytes: 16 }), second);

  const linked = join(root, 'linked.jsonl');
  writeFileSync(linked, `${'x'.repeat(29)}\n${first}\n${second}\n`);
  assert.equal(firstVobRequestIdInRollout(linked, { maxBytes: 256, chunkBytes: 32 }), first);

  // A request id split across read chunks must still resolve without widening
  // the bounded scan or falling back to a whole-file read.
  const split = join(root, 'split.jsonl');
  writeFileSync(split, `${'x'.repeat(30)}\n${first}\n`);
  assert.equal(firstVobRequestIdInRollout(split, { maxBytes: 128, chunkBytes: 32 }), first);

  assert.equal(firstVobRequestIdInRollout(join(root, 'missing.jsonl')), null);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('vob rollout link ok');
