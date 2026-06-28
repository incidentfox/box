// Claude Code subscription OAuth (PKCE) — the manual/headless flow, driven from
// the box server so the phone UI can do `/login` without a terminal.
//
// Constants + flow mirror the official Claude Code client (pinned source:
// repos/reference/claude-code-source-code/src/constants/oauth.ts + services/oauth/*).
// We reimplement only the stable, small parts (authorize URL + token exchange);
// credential *format* matches what Claude Code writes to <CONFIG_DIR>/.credentials.json.
import crypto from 'node:crypto';

export const OAUTH = {
  CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  // claude.com/cai/* bounces (307) to claude.ai/oauth/authorize — for sign-in.
  AUTHORIZE_URL: 'https://claude.com/cai/oauth/authorize',
  TOKEN_URL: 'https://platform.claude.com/v1/oauth/token',
  MANUAL_REDIRECT_URL: 'https://platform.claude.com/oauth/code/callback',
  PROFILE_URL: 'https://api.anthropic.com/api/oauth/profile',
  // ALL_OAUTH_SCOPES, deduped, request order matters for console→claude.ai redirect.
  SCOPES: ['org:create_api_key', 'user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'],
  // Where the user creates an API key (for the API-key login option).
  CONSOLE_KEYS_URL: 'https://console.anthropic.com/settings/keys',
};

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function genPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}
export const genState = () => b64url(crypto.randomBytes(32));

export function buildAuthUrl({ challenge, state, loginHint }) {
  const u = new URL(OAUTH.AUTHORIZE_URL);
  u.searchParams.set('code', 'true'); // tells the page to show the manual code
  u.searchParams.set('client_id', OAUTH.CLIENT_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', OAUTH.MANUAL_REDIRECT_URL);
  u.searchParams.set('scope', OAUTH.SCOPES.join(' '));
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  if (loginHint) u.searchParams.set('login_hint', loginHint);
  return u.toString();
}

// The user may paste: "code#state", a full redirect URL, a bare "code=…&state=…"
// query, or just the code. We already hold the real state server-side, so the
// code is the only thing we truly need.
export function parsePasted(raw, fallbackState) {
  const v = (raw || '').trim();
  if (!v) return null;
  if (v.includes('code=')) {
    try {
      const u = new URL(v.includes('://') ? v : 'https://x/?' + v.replace(/^\?/, ''));
      const code = u.searchParams.get('code');
      if (code) return { code, state: u.searchParams.get('state') || fallbackState };
    } catch { /* fall through */ }
  }
  if (v.includes('#')) { const [code, st] = v.split('#'); return { code: code.trim(), state: (st || fallbackState || '').trim() }; }
  return { code: v, state: fallbackState };
}

export async function exchangeCode({ code, state, verifier }) {
  const res = await fetch(OAUTH.TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code', code, redirect_uri: OAUTH.MANUAL_REDIRECT_URL,
      client_id: OAUTH.CLIENT_ID, code_verifier: verifier, state,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(res.status === 401 ? 'Authentication failed: invalid or expired authorization code' : `Token exchange failed (${res.status}) ${t.slice(0, 200)}`);
  }
  return res.json(); // {access_token, refresh_token, expires_in, scope, account?:{uuid,email_address}, organization?:{uuid}}
}

export async function fetchProfile(accessToken) {
  try {
    const res = await fetch(OAUTH.PROFILE_URL, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export function subscriptionFromProfile(p) {
  return ({ claude_max: 'max', claude_pro: 'pro', claude_enterprise: 'enterprise', claude_team: 'team' })[p?.organization?.organization_type] || null;
}

// Exactly the shape Claude Code persists on Linux (plaintext .credentials.json).
export function credentialsJson(tok, subscriptionType) {
  return {
    claudeAiOauth: {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + (tok.expires_in || 0) * 1000,
      scopes: (tok.scope || OAUTH.SCOPES.join(' ')).split(' ').filter(Boolean),
      subscriptionType: subscriptionType || null,
      rateLimitTier: null,
    },
  };
}
