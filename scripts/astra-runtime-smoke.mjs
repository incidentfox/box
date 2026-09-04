#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_BIN = process.env.BOX_CODEX_BIN || 'codex';
const EXPECTED = 'ASTRA_BOX_OK';

const version = spawnSync(CODEX_BIN, ['--version'], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 30_000,
});
if (version.error || version.status !== 0) {
  throw new Error(`Unable to run ${CODEX_BIN}: ${version.error?.message || version.stderr.trim()}`);
}

const result = spawnSync(CODEX_BIN, [
  'exec',
  '--json',
  '--model', 'gpt-6-astra',
  '-c', 'model_reasoning_effort="low"',
  '--skip-git-repo-check',
  `Respond with exactly ${EXPECTED}`,
], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 180_000,
  maxBuffer: 10 * 1024 * 1024,
});

if (result.error || result.status !== 0) {
  throw new Error(`Astra smoke failed: ${result.error?.message || result.stderr.trim()}`);
}

const messages = result.stdout
  .split('\n')
  .filter(Boolean)
  .flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return event.type === 'item.completed' && event.item?.type === 'agent_message'
        ? [event.item.text]
        : [];
    } catch {
      return [];
    }
  });

if (messages.at(-1) !== EXPECTED) {
  throw new Error(`Astra returned ${JSON.stringify(messages.at(-1) || null)} instead of ${EXPECTED}`);
}

console.log(JSON.stringify({
  ok: true,
  model: 'gpt-6-astra',
  response: EXPECTED,
  codex: version.stdout.trim(),
  binary: CODEX_BIN,
}, null, 2));
