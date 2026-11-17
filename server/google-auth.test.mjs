import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoogleAuth, checkIdClaims, parseAllowlist } from './google-auth.mjs';

const CID = 'cid.apps.googleusercontent.com';
const env = { BOX_GOOGLE_CLIENT_ID: CID, BOX_GOOGLE_CLIENT_SECRET: 'sec', BOX_GOOGLE_ALLOWED_EMAILS: 'Owner@Example.com, other@example.com' };
const cfg = (k) => env[k] || '';
const quiet = { log() {}, warn() {}, error() {} };
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const good = (over = {}) => ({ iss: 'https://accounts.google.com', aud: CID, exp: Math.floor(Date.now() / 1000) + 600, email: 'owner@example.com', email_verified: true, ...over });

assert.deepEqual(parseAllowlist(' A@x.com,b@x.com  c@x.com'), ['a@x.com', 'b@x.com', 'c@x.com']);
const allowed = ['owner@example.com'];
assert.deepEqual(checkIdClaims(good(), { clientId: CID, allowed }), { email: 'owner@example.com' });
assert.equal(checkIdClaims(good({ aud: 'other' }), { clientId: CID, allowed }).error, 'bad audience');
assert.equal(checkIdClaims(good({ iss: 'evil' }), { clientId: CID, allowed }).error, 'bad issuer');
assert.equal(checkIdClaims(good({ email_verified: false }), { clientId: CID, allowed }).error, 'email not verified');
assert.equal(checkIdClaims(good({ exp: 1 }), { clientId: CID, allowed }).error, 'expired identity');
assert.match(checkIdClaims(good({ email: 'x@example.com' }), { clientId: CID, allowed }).error, /not allowed/);

const dir = mkdtempSync(join(tmpdir(), 'gauth-'));
const stateFile = join(dir, 'google-sessions.json');
let idClaims = good();
const fetchImpl = async (url, opts) => {
  assert.equal(url, 'https://oauth2.googleapis.com/token');
  const p = new URLSearchParams(opts.body);
  assert.equal(p.get('redirect_uri'), 'https://box.test/api/auth/google/callback');
  return { ok: true, json: async () => ({ id_token: jwt(idClaims) }) };
};
const ga = createGoogleAuth({ cfg, stateFile, fetchImpl, log: quiet });
assert.equal(ga.enabled(), true);

// Happy path: start -> callback -> one-time poll -> session resolves.
const s = ga.start('https://box.test/api/auth/google/callback');
const state = new URL(s.url).searchParams.get('state');
assert.ok(!s.url.includes(s.flowId), 'flow id never goes to Google');
assert.equal(ga.poll(s.flowId).status, 'pending');
assert.deepEqual(await ga.callback({ state, code: 'c' }), { ok: true, email: 'owner@example.com' });
assert.equal((await ga.callback({ state, code: 'c' })).error.includes('expired'), true, 'state is single-use');
const claim = ga.poll(s.flowId);
assert.equal(claim.status, 'ok');
assert.ok(claim.token.startsWith('gs_'));
assert.equal(ga.poll(s.flowId).status, 'expired', 'token is claimable once');
assert.equal(ga.resolveSession(claim.token), 'owner@example.com');
assert.equal(ga.resolveSession('gs_nope'), null);
assert.ok(!readFileSync(stateFile, 'utf8').includes(claim.token), 'only hashes are stored');
assert.equal(statSync(stateFile).mode & 0o777, 0o600);

// Sessions survive a restart, and stop working when the email leaves the allowlist.
const ga2 = createGoogleAuth({ cfg, stateFile, fetchImpl, log: quiet });
assert.equal(ga2.resolveSession(claim.token), 'owner@example.com');
env.BOX_GOOGLE_ALLOWED_EMAILS = 'other@example.com';
assert.equal(ga2.resolveSession(claim.token), null);
env.BOX_GOOGLE_ALLOWED_EMAILS = 'owner@example.com';
assert.equal(ga2.revokeSession(claim.token), true);
assert.equal(ga2.resolveSession(claim.token), null);

// A disallowed account mints nothing.
idClaims = good({ email: 'intruder@example.com' });
const s2 = ga.start('https://box.test/api/auth/google/callback');
await ga.callback({ state: new URL(s2.url).searchParams.get('state'), code: 'c' });
const bad = ga.poll(s2.flowId);
assert.equal(bad.status, 'error'); assert.match(bad.error, /not allowed/); assert.equal(bad.token, undefined);

// Expiry.
let t = Date.now();
const ga3 = createGoogleAuth({ cfg, stateFile: join(dir, 'g3.json'), fetchImpl, log: quiet, now: () => t });
idClaims = good();
const s3 = ga3.start('https://box.test/api/auth/google/callback');
await ga3.callback({ state: new URL(s3.url).searchParams.get('state'), code: 'c' });
const tok3 = ga3.poll(s3.flowId).token;
t += 31 * 86400_000;
assert.equal(ga3.resolveSession(tok3), null);

// Unconfigured = disabled, and session tokens are inert.
const off = createGoogleAuth({ cfg: () => '', stateFile: join(dir, 'off.json'), log: quiet });
assert.equal(off.enabled(), false);
assert.ok(off.start('x').error);
console.log('google-auth ok');
