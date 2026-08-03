// Single source of truth for the environment a spawned agent process inherits.
//
// This logic previously existed as three separate copies (server/index.mjs,
// server/rc-engine.mjs, server/codex-exec-engine.mjs) that had drifted apart. A
// security-relevant filter is exactly the wrong thing to keep three copies of: the
// owner-token leak below was present in all three precisely because fixing one wouldn't
// have fixed the others.

// Stripped for EVERY agent process, owner and guest alike.
//
// CC_AUTH_TOKEN is the box's own login token. An agent that can read it can authenticate
// to this server as the owner — so a guest typing "echo $CC_AUTH_TOKEN" into a shared
// chat was a complete privilege escalation. No agent has any reason to want it.
//
// The CLAUDE_*/CODEX_* entries are the pre-existing reasons this function existed: force
// the Max subscription (OAuth credentials file) rather than a metered API key, and strip
// session-inheritance vars so a spawned claude is a top-level session rather than a child
// of whatever session the box server itself runs under.
const NEVER = [
  'CC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CODEX_COMPANION_SESSION_ID',
];

// A guest's process gets an ALLOWLIST rather than a denylist. A denylist is wrong here by
// construction: this box's env carries integration keys, brain paths and an ssh-agent
// socket today, and whatever gets added next month would be inherited silently. Anything
// not named here simply doesn't reach a guest-started agent.
//
// Read this as "what a shell needs to function", nothing more.
const GUEST_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'SHLVL', 'TMPDIR',
  'LANG', 'TERM', 'COLORTERM', 'TZ', '_',
]);
const GUEST_ALLOW_PREFIX = ['LC_', 'XDG_'];

// Honest scope note: this closes credential leakage through the ENVIRONMENT. It is not a
// sandbox. A guest-started agent still runs as the box's unix user with the owner's HOME,
// so it can read files the owner can read. Isolating that requires a separate unix user
// or a container — a deliberate, documented trade-off (see docs/TEAM.md), not an oversight.
export function buildChildEnv(base, { guest = false, extra = null } = {}) {
  const env = { ...base };
  for (const k of NEVER) delete env[k];
  if (guest) {
    for (const k of Object.keys(env)) {
      if (GUEST_ALLOW.has(k)) continue;
      if (GUEST_ALLOW_PREFIX.some((p) => k.startsWith(p))) continue;
      delete env[k];
    }
  }
  if (extra) for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') env[k] = String(v);
  return env;
}

export const GUEST_ENV_ALLOWLIST = GUEST_ALLOW;
export const NEVER_INHERITED = NEVER;
