import test from 'node:test';
import assert from 'node:assert/strict';
import { detachedMasterArgv, sessionScopeName, unsafeSessionCgroup } from './session-scope.mjs';

test('each session gets its own named scope outside the server unit', () => {
  assert.equal(sessionScopeName('/tmp/cc-box-3f81c6eb.dtach', 42), 'box-session-cc-box-3f81c6eb-42');
  const argv = detachedMasterArgv('/tmp/cc-box-3f81c6eb.dtach', ['claude', '--resume', 'abc'], { now: 42, memoryMax: '8G' });
  assert.deepEqual(argv.slice(0, 5), ['--user', '--scope', '--quiet', '--collect', '--unit=box-session-cc-box-3f81c6eb-42']);
  assert.deepEqual(argv.slice(5), ['-p', 'MemoryMax=8G', '-p', 'OOMPolicy=continue', 'dtach', '-n', '/tmp/cc-box-3f81c6eb.dtach', '-z', 'claude', '--resume', 'abc']);
});

test('scope names stay valid unit names for odd socket paths', () => {
  assert.match(sessionScopeName('/tmp/weird name$(x).dtach', 1), /^box-session-[A-Za-z0-9_.-]+-1$/);
});

test('an OOM kill of one child must not stop the whole session scope', () => {
  const argv = detachedMasterArgv('/tmp/cc-box-1.dtach', ['claude'], { now: 1 });
  assert.ok(argv.includes('OOMPolicy=continue'));
});

test('legacy OOMPolicy=stop scopes and the server cgroup are flagged for migration', () => {
  const base = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/';
  const policies = { 'box-session-cc-box-a-1.scope': 'stop', 'box-session-cc-box-b-2-oomsafe.scope': 'continue' };
  const policyOf = (u) => policies[u] || '';
  assert.equal(unsafeSessionCgroup(`${base}box-app-server-1-2.service\n`, policyOf), 'server-cgroup');
  assert.equal(unsafeSessionCgroup(`${base}box-session-cc-box-a-1.scope\n`, policyOf), 'oom-stop-scope');
  assert.equal(unsafeSessionCgroup(`${base}box-session-cc-box-b-2-oomsafe.scope\n`, policyOf), null);
  assert.equal(unsafeSessionCgroup(`${base}some-other.scope\n`, policyOf), null);
});
