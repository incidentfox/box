import assert from 'node:assert/strict';
import { buildChildEnv, GUEST_ENV_ALLOWLIST, NEVER_INHERITED } from './child-env.mjs';

// A realistic slice of this box's environment: the interesting entries are the ones that
// are NOT obviously secret-shaped, because those are what a denylist would keep missing.
const BASE = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/factory',
  USER: 'factory',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  XDG_RUNTIME_DIR: '/run/user/1000',
  TERM: 'xterm-256color',

  CC_AUTH_TOKEN: 'owner-login-token',
  ANTHROPIC_API_KEY: 'sk-ant-metered',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  CLAUDE_CODE_SESSION_ID: 'parent-session',

  SSH_AUTH_SOCK: '/run/user/1000/ssh-agent',
  AWS_ACCESS_KEY_ID: 'AKIA…',
  LINEAR_API_KEY: 'lin_api_…',
  EXTRA_ENV_FILE: '/run/software-factory/secrets.env',
  SOME_FUTURE_INTEGRATION_KEY: 'not-invented-yet',
};

// ---- every process, owner included -----------------------------------------
const owner = buildChildEnv(BASE);
for (const k of NEVER_INHERITED) {
  assert.equal(k in owner, false, `${k} reached an agent process`);
}
// CC_AUTH_TOKEN is the one that matters: an agent holding it can authenticate to this
// server AS the owner. It was inherited by every session before this module existed.
assert.equal('CC_AUTH_TOKEN' in owner, false);
// The owner is trusted and their agent has real work to do — nothing else is taken away.
assert.equal(owner.AWS_ACCESS_KEY_ID, 'AKIA…');
assert.equal(owner.SSH_AUTH_SOCK, '/run/user/1000/ssh-agent');
// The caller's own env is never mutated in place; several callers pass process.env.
assert.equal(BASE.CC_AUTH_TOKEN, 'owner-login-token');

// ---- a guest's process ------------------------------------------------------
const guest = buildChildEnv(BASE, { guest: true });
assert.equal(guest.PATH, '/usr/bin:/bin');
assert.equal(guest.HOME, '/home/factory');
assert.equal(guest.LANG, 'en_US.UTF-8');
assert.equal(guest.LC_ALL, 'en_US.UTF-8');            // LC_* prefix
assert.equal(guest.XDG_RUNTIME_DIR, '/run/user/1000'); // XDG_* prefix

// The allowlist's entire point: an integration key nobody thought about when writing this
// filter is excluded by default, rather than inherited until someone notices.
assert.equal('SOME_FUTURE_INTEGRATION_KEY' in guest, false);
for (const k of ['SSH_AUTH_SOCK', 'AWS_ACCESS_KEY_ID', 'LINEAR_API_KEY', 'EXTRA_ENV_FILE']) {
  assert.equal(k in guest, false, `${k} reached a guest agent`);
}
// SSH_AUTH_SOCK specifically: a live agent socket is push access to every repo the owner
// can push to, with no credential ever appearing in the environment to notice.
assert.equal('SSH_AUTH_SOCK' in guest, false);
for (const k of Object.keys(guest)) {
  const allowed = GUEST_ENV_ALLOWLIST.has(k) || k.startsWith('LC_') || k.startsWith('XDG_');
  assert.ok(allowed, `${k} survived the guest allowlist`);
}

// ---- extras ------------------------------------------------------------------
// Extras are how deliberately-shared team secrets get in — they are applied AFTER the
// filter, so a guest session can receive a key the owner published to the team even
// though no ambient key survives.
const withExtra = buildChildEnv(BASE, { guest: true, extra: { OPENAI_API_KEY: 'sk-team' } });
assert.equal(withExtra.OPENAI_API_KEY, 'sk-team');
assert.equal('LINEAR_API_KEY' in withExtra, false);

// Empty and null extras are dropped rather than exported as '', so a blank config value
// can't shadow something the agent would otherwise find on its own.
const blank = buildChildEnv(BASE, { extra: { A: '', B: null, C: undefined, D: 'ok' } });
assert.equal('A' in blank, false);
assert.equal('B' in blank, false);
assert.equal('C' in blank, false);
assert.equal(blank.D, 'ok');
assert.equal(buildChildEnv(BASE, { extra: { N: 5 } }).N, '5');

// An extra can re-add something NEVER strips. That is the caller's explicit choice made at
// a call site, not silent inheritance — but assert it so the ordering stays deliberate.
assert.equal(buildChildEnv(BASE, { extra: { ANTHROPIC_API_KEY: 'chosen' } }).ANTHROPIC_API_KEY, 'chosen');

console.log('child-env.test.mjs ok');
