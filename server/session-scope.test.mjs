import test from 'node:test';
import assert from 'node:assert/strict';
import { detachedMasterArgv, sessionScopeName } from './session-scope.mjs';

test('each session gets its own named scope outside the server unit', () => {
  assert.equal(sessionScopeName('/tmp/cc-box-3f81c6eb.dtach', 42), 'box-session-cc-box-3f81c6eb-42');
  const argv = detachedMasterArgv('/tmp/cc-box-3f81c6eb.dtach', ['claude', '--resume', 'abc'], { now: 42, memoryMax: '8G' });
  assert.deepEqual(argv.slice(0, 5), ['--user', '--scope', '--quiet', '--collect', '--unit=box-session-cc-box-3f81c6eb-42']);
  assert.deepEqual(argv.slice(5), ['-p', 'MemoryMax=8G', 'dtach', '-n', '/tmp/cc-box-3f81c6eb.dtach', '-z', 'claude', '--resume', 'abc']);
});

test('scope names stay valid unit names for odd socket paths', () => {
  assert.match(sessionScopeName('/tmp/weird name$(x).dtach', 1), /^box-session-[A-Za-z0-9_.-]+-1$/);
});
