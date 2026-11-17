// Google sign-in for the owner — an alternative to typing the shared access token.
//
// Server-side authorization-code flow with a poll handoff, so it works from a home-screen
// PWA too: the app opens Google in a separate browser context (popup / iOS Safari overlay),
// Google redirects to /api/auth/google/callback here, and the app — which kept a random
// flow id that never leaves this server and the app — polls once to claim a session token.
//
// The ID token comes straight from Google's token endpoint over TLS in exchange for our
// client secret, so per Google's docs its claims can be trusted without a JWKS check; we
// still pin iss/aud/email_verified and an email allowlist.
//
// Sessions are opaque random tokens (stored only as sha256 hashes) that resolve to the
// owner principal exactly like CC_AUTH_TOKEN, so every route and the WebSocket upgrade
// accept them unchanged. The access token keeps working as a fallback.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SESSION_PREFIX = 'gs_';
const FLOW_TTL_MS = 10 * 60 * 1000;
const MAX_FLOWS = 200;
const DEFAULT_SESSION_DAYS = 30;

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const rand = (n = 24) => randomBytes(n).toString('base64url');

export function parseAllowlist(raw) {
  return String(raw || '').split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
}

// Trust the ID token's claims only after pinning issuer, audience, verification and expiry.
export function checkIdClaims(claims, { clientId, allowed, now = Date.now() }) {
  if (!claims || typeof claims !== 'object') return { error: 'no identity returned' };
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) return { error: 'bad issuer' };
  if (claims.aud !== clientId) return { error: 'bad audience' };
  if (!claims.exp || Number(claims.exp) * 1000 < now) return { error: 'expired identity' };
  const email = String(claims.email || '').toLowerCase();
  if (!email || (claims.email_verified !== true && claims.email_verified !== 'true')) return { error: 'email not verified' };
  if (!allowed.includes(email)) return { error: 'this Google account is not allowed on this Box', email };
  return { email };
}

export function decodeJwtPayload(jwt) {
  const part = String(jwt || '').split('.')[1];
  if (!part) return null;
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
}

export function createGoogleAuth({ cfg, stateFile, fetchImpl = fetch, now = () => Date.now(), log = console }) {
  const clientId = () => cfg('BOX_GOOGLE_CLIENT_ID');
  const clientSecret = () => cfg('BOX_GOOGLE_CLIENT_SECRET');
  const allowed = () => parseAllowlist(cfg('BOX_GOOGLE_ALLOWED_EMAILS'));
  const sessionMs = () => Math.max(1, Number(cfg('BOX_GOOGLE_SESSION_DAYS')) || DEFAULT_SESSION_DAYS) * 86400_000;
  const enabled = () => !!(clientId() && clientSecret() && allowed().length);

  // flowId -> { state, redirectUri, createdAt, token?, error? }; stateHash -> flowId
  const flows = new Map();
  const byState = new Map();
  const prune = () => {
    const t = now();
    for (const [id, f] of flows) if (t - f.createdAt > FLOW_TTL_MS) { flows.delete(id); byState.delete(f.stateHash); }
    while (flows.size > MAX_FLOWS) { const [id, f] = flows.entries().next().value; flows.delete(id); byState.delete(f.stateHash); }
  };

  let sessions = null;   // [{ hash, email, createdAt, expiresAt }]
  const load = () => {
    if (sessions) return sessions;
    try { sessions = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')).sessions || [] : []; }
    catch { sessions = []; }
    return sessions;
  };
  const save = () => {
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ sessions }, null, 2), { mode: 0o600 });
      renameSync(tmp, stateFile);
    } catch (e) { log.error('[google-auth] save failed:', e && e.message); }
  };
  const live = () => {
    const t = now();
    const all = load();
    const kept = all.filter((s) => s.expiresAt > t);
    if (kept.length !== all.length) { sessions = kept; save(); }
    return sessions;
  };

  function mintSession(email) {
    const token = SESSION_PREFIX + rand(32);
    const t = now();
    live().push({ hash: sha(token), email, createdAt: t, expiresAt: t + sessionMs() });
    save();
    return token;
  }

  // Returns the signed-in email for a live session token, else null.
  function resolveSession(token) {
    const t = String(token || '');
    if (!t.startsWith(SESSION_PREFIX) || !enabled()) return null;
    const h = sha(t);
    const s = live().find((x) => x.hash === h);
    return s && allowed().includes(s.email) ? s.email : null;
  }

  function revokeSession(token) {
    const h = sha(token);
    const before = live().length;
    sessions = sessions.filter((s) => s.hash !== h);
    if (sessions.length !== before) save();
    return sessions.length !== before;
  }

  function start(redirectUri) {
    if (!enabled()) return { error: 'Google sign-in is not configured' };
    prune();
    const flowId = rand(24), state = rand(24);
    flows.set(flowId, { stateHash: sha(state), redirectUri, createdAt: now() });
    byState.set(sha(state), flowId);
    const q = new URLSearchParams({
      client_id: clientId(), redirect_uri: redirectUri, response_type: 'code',
      scope: 'openid email', state, prompt: 'select_account',
    });
    if (allowed().length === 1) q.set('login_hint', allowed()[0]);
    return { flowId, url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` };
  }

  // Completes the flow named by `state`. Never throws; records the outcome on the flow.
  async function callback({ state, code, error }) {
    prune();
    const flowId = byState.get(sha(state || ''));
    const flow = flowId && flows.get(flowId);
    if (!flow) return { error: 'sign-in link expired — start again from Box' };
    byState.delete(flow.stateHash);   // state is single-use
    const fail = (msg) => { flow.error = msg; return { error: msg }; };
    if (error) return fail(error === 'access_denied' ? 'sign-in cancelled' : `Google error: ${error}`);
    if (!code) return fail('no authorization code');
    let body;
    try {
      const r = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: clientId(), client_secret: clientSecret(),
          redirect_uri: flow.redirectUri, grant_type: 'authorization_code',
        }),
      });
      body = await r.json().catch(() => ({}));
      if (!r.ok) return fail(`token exchange failed (${body.error || r.status})`);
    } catch { return fail('could not reach Google'); }
    const claims = decodeJwtPayload(body.id_token);
    const out = checkIdClaims(claims, { clientId: clientId(), allowed: allowed(), now: now() });
    if (out.error) {
      log.warn(`[google-auth] rejected sign-in: ${out.error}`);
      return fail(out.error);
    }
    flow.token = mintSession(out.email);
    flow.email = out.email;
    log.log(`[google-auth] owner signed in with Google (${out.email})`);
    return { ok: true, email: out.email };
  }

  // One-time claim of a finished flow's session token.
  function poll(flowId) {
    prune();
    const flow = flows.get(String(flowId || ''));
    if (!flow) return { status: 'expired' };
    if (flow.error) { flows.delete(flowId); return { status: 'error', error: flow.error }; }
    if (!flow.token) return { status: 'pending' };
    flows.delete(flowId);
    return { status: 'ok', token: flow.token, email: flow.email };
  }

  return { enabled, start, callback, poll, resolveSession, revokeSession, allowed };
}
