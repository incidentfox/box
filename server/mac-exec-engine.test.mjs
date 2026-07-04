// Tests for the Mac Computer Use bridge request. The Mac worker runs on a different
// filesystem, so box-uploaded attachments must be sent as bytes and referenced in argv.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMacBridgeRequest } from './mac-exec-engine.mjs';

const dir = mkdtempSync(join(tmpdir(), 'box-mac-image-'));
try {
  const img = join(dir, 'screen.png');
  writeFileSync(img, Buffer.from('image-bytes'));

  const req = buildMacBridgeRequest({
    cwd: '/box/path/that/does/not/exist/on/mac',
    prompt: 'look at this',
    images: [img],
    settings: { model: 'gpt-5.5', reasoningEffort: 'high' },
  });

  assert.equal(req.timeout, 40 * 60);
  assert.ok(Array.isArray(req.argv), 'argv is present');
  assert.ok(!req.argv.includes('-C'), 'box cwd is stripped before sending to Mac');

  const promptIdx = req.argv.indexOf('look at this');
  const imageFlagIdx = req.argv.lastIndexOf('-i');
  assert.ok(promptIdx >= 0, 'prompt is included');
  assert.ok(imageFlagIdx > promptIdx, 'image flag comes after prompt for codex variadic parsing');
  assert.equal(req.argv[imageFlagIdx + 1], img, 'argv references the box path for bridge rewrite');

  assert.deepEqual(req.files, [{
    path: img,
    name: 'screen.png',
    dataBase64: Buffer.from('image-bytes').toString('base64'),
  }]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('✅ mac-exec-engine.test.mjs passed');
