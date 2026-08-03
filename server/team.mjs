// team.mjs — shared workspace: invite codes, guest identity, session sharing.
//
// WHY THIS EXISTS
// Box is single-user by design: one `CC_AUTH_TOKEN` is the whole security model, and
// anyone holding it owns the host (arbitrary bash as the box user, every credential in
// the environment, the entire filesystem). That is fine for one person. It is NOT a
// thing you can hand to a teammate.
//
// So a teammate gets a SECOND kind of credential: a guest token, minted by redeeming a
// short-lived invite code. A guest is a named principal with a much smaller surface:
//   - chat in sessions the owner explicitly shared,
//   - start their own sessions, forced into the shared workspace directory,
//   - browse files under that workspace root and nowhere else.
// Everything else on the box (settings, provider logins, account pooling, arbitrary
// paths, other people's sessions) is owner-only. The route allowlist in index.mjs is
// DEFAULT-DENY — a new endpoint is owner-only until someone opts it into GUEST_ROUTES.
//
// HONEST LIMIT, STATED OUT LOUD: a guest steering a shared agent session can still make
// that agent run commands as the box user. This is trust-scoped access for a teammate,
// not a sandbox for someone you don't trust. The isolation here is about blast radius
// and attribution, not containment.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const HOME = homedir();
const STATE_DIR = join(HOME, '.cc-mobile');
const TEAM_PATH = join(STATE_DIR, 'team.json');

// Ambiguous glyphs removed (0/O, 1/I/L) — these codes get read aloud and retyped on a phone.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // a week to accept; then it's dead
const GUEST_TOKEN_PREFIX = 'boxg_';

// Stable per-member accent so presence dots / author badges stay recognizable across clients.
const MEMBER_COLORS = ['#e0567a', '#3f9d6d', '#4a7fd4', '#c9803a', '#8a63c9', '#2f9aa8', '#b8553f', '#5c7a3f'];

const EMPTY_TEAM = () => ({
  version: 1,
  workspaceRoot: '',
  members: [],
  invites: [],
  shared: {},     // sessionId -> { sharedAt, sharedBy, cwd }
  owned: {},      // sessionId -> memberId (guest-created sessions)
  roots: {},      // absPath -> { addedAt, addedBy, auto } — directories the team may reach
});

// No hyphen in the default name, deliberately. Claude records a session's cwd only as
// its project-directory NAME, which encodes "/" as "-"; index.mjs's decodeCwd() therefore
// replays "team-shared" as "team/shared". That lossiness is a pre-existing Box wart (it
// already mangles any hyphenated repo path) — a hyphen-free default just avoids walking
// every guest straight into it.
export function defaultWorkspaceRoot() {
  return process.env.BOX_TEAM_WORKSPACE || join(HOME, 'development', 'shared');
}

// Team is available unless explicitly switched off. This is safe by default because
// nothing can be redeemed until the owner mints an invite: no invites, no guests.
export const teamDisabled = () => String(process.env.BOX_TEAM || '') === '0';

let cache = null;
let diskEnabled = true;
export function loadTeam() {
  if (cache) return cache;
  let t = EMPTY_TEAM();
  try { t = { ...EMPTY_TEAM(), ...JSON.parse(readFileSync(TEAM_PATH, 'utf8')) }; } catch {}
  if (!t.workspaceRoot) t.workspaceRoot = defaultWorkspaceRoot();
  cache = t;
  return cache;
}

export function saveTeam(t) {
  cache = t;
  if (!diskEnabled) return t;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = TEAM_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(t, null, 2));
    renameSync(tmp, TEAM_PATH);   // atomic: a torn team.json would lock everyone out
  } catch {}
  return t;
}

// Test seam — drives a fresh in-memory team and detaches from disk, so running the
// unit tests can never clobber a real team.json (and its live guest tokens).
export function _setTeamForTest(t) {
  cache = { ...EMPTY_TEAM(), workspaceRoot: defaultWorkspaceRoot(), ...(t || {}) };
  diskEnabled = false;
  secretsCache = { version: 1, secrets: {} };   // never read a real team-secrets.json in tests
  return cache;
}

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

// Constant-time compare that doesn't leak length. Both sides are hex digests of the
// same width, but hash first anyway so a caller passing raw input can't shortcut it.
function safeEqual(a, b) {
  const ba = Buffer.from(sha256(a), 'hex');
  const bb = Buffer.from(sha256(b), 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function randomFrom(alphabet, n) {
  // Rejection-sample so the modulo doesn't bias short codes toward early letters.
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = '';
  while (out.length < n) {
    for (const byte of randomBytes(n * 2)) {
      if (byte >= max) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === n) break;
    }
  }
  return out;
}

export const formatInviteCode = (raw) => {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = s.startsWith('BOX') ? s.slice(3) : s;
  if (body.length !== 8) return '';
  // Reject anything outside the mint alphabet. The excluded glyphs (0/O, 1/I/L) have no
  // safe canonical form — a typo'd "0" is better surfaced as "bad code" than silently
  // matched against something else.
  if (![...body].every((ch) => CODE_ALPHABET.includes(ch))) return '';
  return `BOX-${body.slice(0, 4)}-${body.slice(4)}`;
};
// Accept whatever the human pasted: "box 7k2m 9qx4", "BOX-7K2M-9QX4", "7K2M9QX4".
export const normalizeInviteCode = (raw) => formatInviteCode(raw);

const memberColor = (id) => {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return MEMBER_COLORS[h % MEMBER_COLORS.length];
};

export const cleanName = (raw, fallback = 'Teammate') =>
  String(raw || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || fallback;

// ---- invites ---------------------------------------------------------------

export function createInvite({ name = '', ttlMs = INVITE_TTL_MS, note = '' } = {}) {
  const t = loadTeam();
  const code = `BOX-${randomFrom(CODE_ALPHABET, 4)}-${randomFrom(CODE_ALPHABET, 4)}`;
  const invite = {
    code,
    name: cleanName(name, ''),
    note: String(note || '').slice(0, 120),
    createdAt: Date.now(),
    expiresAt: Date.now() + Math.max(60_000, ttlMs),
    usedAt: null,
    usedBy: null,
  };
  t.invites.push(invite);
  // Keep the ledger from growing without bound; spent/expired codes are audit trail only.
  if (t.invites.length > 100) t.invites = t.invites.slice(-100);
  saveTeam(t);
  return invite;
}

export const inviteLive = (inv, now = Date.now()) => !!inv && !inv.usedAt && !inv.revokedAt && inv.expiresAt > now;

export function listInvites() {
  const now = Date.now();
  return loadTeam().invites.map((inv) => ({
    code: inv.code, name: inv.name, note: inv.note,
    createdAt: inv.createdAt, expiresAt: inv.expiresAt,
    usedAt: inv.usedAt || null, usedBy: inv.usedBy || null,
    revokedAt: inv.revokedAt || null,
    live: inviteLive(inv, now),
  }));
}

export function revokeInvite(code) {
  const t = loadTeam();
  const inv = t.invites.find((i) => i.code === normalizeInviteCode(code));
  if (!inv || inv.usedAt) return false;
  inv.revokedAt = Date.now();
  saveTeam(t);
  return true;
}

// Redeem a code into a durable guest token. Single use: the code dies here, and from
// now on the teammate's app authenticates with the token, never the code again.
export function redeemInvite(rawCode, { name = '' } = {}) {
  const code = normalizeInviteCode(rawCode);
  if (!code) return { error: 'bad code' };
  const t = loadTeam();
  const inv = t.invites.find((i) => safeEqual(i.code, code));
  if (!inv) return { error: 'bad code' };
  if (inv.revokedAt) return { error: 'code revoked' };
  if (inv.usedAt) return { error: 'code already used' };
  if (inv.expiresAt <= Date.now()) return { error: 'code expired' };

  const token = GUEST_TOKEN_PREFIX + randomBytes(24).toString('hex');
  const id = 'm_' + randomBytes(6).toString('hex');
  const member = {
    id,
    name: cleanName(name || inv.name),
    role: 'guest',
    tokenHash: sha256(token),     // the raw token is shown exactly once, at redemption
    color: memberColor(id),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    revokedAt: null,
  };
  t.members.push(member);
  inv.usedAt = Date.now();
  inv.usedBy = member.id;
  saveTeam(t);
  return { member: publicMember(member), token };
}

// ---- members / principals --------------------------------------------------

export const publicMember = (m) => m && ({
  id: m.id, name: m.name, role: m.role, color: m.color,
  createdAt: m.createdAt, lastSeenAt: m.lastSeenAt || null, revoked: !!m.revokedAt,
});

export const listMembers = () => loadTeam().members.map(publicMember);

export function revokeMember(id) {
  const t = loadTeam();
  const m = t.members.find((x) => x.id === id);
  if (!m || m.revokedAt) return false;
  m.revokedAt = Date.now();
  m.tokenHash = '';   // hard kill: the token can never resolve again
  saveTeam(t);
  return true;
}

export function renameMember(id, name) {
  const t = loadTeam();
  const m = t.members.find((x) => x.id === id);
  if (!m) return false;
  m.name = cleanName(name, m.name);
  saveTeam(t);
  return true;
}

export const OWNER = { kind: 'owner', id: 'owner', name: 'Owner', role: 'owner', color: '#6b7280' };
// The host sets this at boot so the owner's own messages badge with a real name in a
// shared session, instead of the useless "Owner".
export function setOwnerName(name) { OWNER.name = cleanName(name, 'Owner'); return OWNER.name; }

// Resolve a bearer token to a principal. Returns null for anything unrecognized —
// callers MUST treat null as unauthenticated, never as "guest".
export function resolveGuest(token) {
  if (teamDisabled()) return null;
  const raw = String(token || '');
  if (!raw.startsWith(GUEST_TOKEN_PREFIX)) return null;   // cheap reject before hashing
  const hash = sha256(raw);
  const m = loadTeam().members.find((x) => x.tokenHash && x.tokenHash.length === hash.length
    && timingSafeEqual(Buffer.from(x.tokenHash, 'hex'), Buffer.from(hash, 'hex')));
  if (!m || m.revokedAt) return null;
  return { kind: 'guest', id: m.id, name: m.name, role: 'guest', color: m.color };
}

// Cheap, throttled last-seen bookkeeping — this runs on every authenticated request.
let lastSeenFlush = 0;
export function touchMember(id) {
  const t = loadTeam();
  const m = t.members.find((x) => x.id === id);
  if (!m) return;
  m.lastSeenAt = Date.now();
  if (Date.now() - lastSeenFlush > 60_000) { lastSeenFlush = Date.now(); saveTeam(t); }
}

// ---- session sharing -------------------------------------------------------

// Sharing a chat also decides whether the team can reach the DIRECTORY that chat works in.
// Without that, the owner and a guest sit in the same conversation running turns in two
// different folders (the guest gets clamped to the scratch root), which looks like the
// agent going mad rather than a permissions boundary.
//
// The session's cwd is recorded on the share record so unsharing can withdraw the root
// again without index.mjs having to hand us a session list.
export function setShared(sessionId, on, by = 'owner', cwd = '') {
  const t = loadTeam();
  const id = String(sessionId || '');
  if (!id) return false;
  if (on) {
    t.shared[id] = { sharedAt: Date.now(), sharedBy: by, cwd: String(cwd || '') };
    saveTeam(t);
    if (cwd) addRoot(cwd, by, true);
  } else {
    const was = t.shared[id];
    delete t.shared[id];
    saveTeam(t);
    // Withdraw the directory only if no OTHER shared chat still works there. A root the
    // owner added by hand (auto === false) is left alone — they asked for it explicitly.
    if (was && was.cwd) {
      const stillUsed = Object.values(loadTeam().shared).some((r) => r && r.cwd === was.cwd);
      if (!stillUsed) removeRoot(was.cwd, { autoOnly: true });
    }
  }
  return true;
}

export const isShared = (sessionId) => !!loadTeam().shared[String(sessionId || '')];
export const sharedIds = () => Object.keys(loadTeam().shared);

// Record that a guest started this session so they keep access to their own work
// without the owner having to share it back to them.
export function claimSession(sessionId, memberId) {
  const id = String(sessionId || '');
  if (!id || !memberId) return;
  const t = loadTeam();
  if (t.owned[id] === memberId) return;
  t.owned[id] = memberId;
  saveTeam(t);
}

export const sessionOwner = (sessionId) => loadTeam().owned[String(sessionId || '')] || null;

// The single authorization question for session access.
export function canAccessSession(principal, sessionId) {
  if (!principal) return false;
  if (principal.kind === 'owner') return true;
  const id = String(sessionId || '');
  if (!id) return false;
  return isShared(id) || sessionOwner(id) === principal.id;
}

// ---- shared workspace ------------------------------------------------------

export function workspaceRoot() {
  const t = loadTeam();
  return t.workspaceRoot || defaultWorkspaceRoot();
}

export function ensureWorkspace() {
  const root = workspaceRoot();
  try {
    mkdirSync(root, { recursive: true });
    const readme = join(root, 'README.md');
    if (!existsSync(readme)) {
      writeFileSync(readme, [
        '# Team shared workspace',
        '',
        'Sessions started by teammates through the Box **Team** tab are confined to this',
        'directory. Files here are readable and writable by everyone on the team.',
        '',
        'Anything outside this directory is owner-only.',
        '',
      ].join('\n'));
    }
  } catch {}
  return root;
}

export function setWorkspaceRoot(dir) {
  const t = loadTeam();
  t.workspaceRoot = resolve(String(dir || '').trim() || defaultWorkspaceRoot());
  saveTeam(t);
  ensureWorkspace();
  return t.workspaceRoot;
}

// Containment check against ONE root. Resolves symlinks on both sides so a symlink
// planted inside the workspace can't be used to walk out to ~/.aws or a repo.
// Non-existent paths fall back to lexical containment of the nearest existing parent,
// so "create a new file here" still works without opening an escape hatch.
function containedBy(p, root) {
  const target = resolve(String(p || ''));
  let realRoot = root;
  try { realRoot = realpathSync(root); } catch {}
  const contains = (child) => child === realRoot || child.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
  try { return contains(realpathSync(target)); } catch {}
  // Path doesn't exist yet — walk up to the closest ancestor that does and check that.
  let probe = target;
  for (let i = 0; i < 40; i++) {
    const parent = resolve(probe, '..');
    if (parent === probe) break;
    try { return contains(realpathSync(parent)) && contains(resolve(realpathSync(parent), target.slice(parent.length + 1))); } catch {}
    probe = parent;
  }
  return false;
}

// ---- team roots ------------------------------------------------------------
//
// The team can reach the scratch workspace plus any directory a shared chat works in.
// This replaces "move your files into the shared folder to collaborate": nothing is
// relocated, the directory is simply admitted. Repos stay where every worktree, script
// and other session already expects them.

// Directories that must never become a team root, because admitting them would hand over
// the credentials the guest env filter just took away. HOME is rejected too: a root at
// $HOME contains .ssh, .aws, .claude and the box's own state, so it's the whole machine
// wearing a workspace costume.
const FORBIDDEN_ROOTS = () => [
  '/', '/etc', '/root', '/run', '/proc', '/sys', '/var', '/boot', '/dev',
  HOME,
  join(HOME, '.ssh'), join(HOME, '.aws'), join(HOME, '.gnupg'), join(HOME, '.config'),
  join(HOME, '.claude'), join(HOME, '.cc-mobile'), join(HOME, '.local'),
];

// Returns '' if the directory is acceptable, else a human-readable reason.
export function rootRejection(dir) {
  const abs = resolve(String(dir || '').trim());
  if (!abs || abs === '.') return 'not a directory';
  if (!existsSync(abs)) return 'that directory does not exist';
  let real = abs;
  try { real = realpathSync(abs); } catch {}
  for (const bad of FORBIDDEN_ROOTS()) {
    let realBad = bad;
    try { realBad = realpathSync(bad); } catch {}
    if (real === realBad) return real === HOME ? 'your home directory holds every credential on this box' : `${bad} is off limits`;
    // An ancestor of a forbidden path is worse than the path itself.
    if (realBad.startsWith(real.endsWith(sep) ? real : real + sep)) return `that would also expose ${bad}`;
  }
  return '';
}

export const teamRoots = () => {
  const t = loadTeam();
  const out = [workspaceRoot(), ...Object.keys(t.roots || {})];
  return [...new Set(out.filter(Boolean))];
};

export function listRoots() {
  const t = loadTeam();
  return Object.entries(t.roots || {}).map(([path, meta]) => ({ path, ...meta }));
}

export function addRoot(dir, by = 'owner', auto = false) {
  const abs = resolve(String(dir || '').trim());
  if (!abs) return { ok: false, error: 'not a directory' };
  // The scratch workspace is always reachable; recording it again would be noise.
  if (containedBy(abs, workspaceRoot())) return { ok: true, root: null };
  const why = rootRejection(abs);
  if (why) return { ok: false, error: why };
  const t = loadTeam();
  t.roots = t.roots || {};
  if (!t.roots[abs]) t.roots[abs] = { addedAt: Date.now(), addedBy: by, auto: !!auto };
  else if (!auto) t.roots[abs].auto = false;   // a manual add pins a previously automatic root
  saveTeam(t);
  return { ok: true, root: abs };
}

export function removeRoot(dir, { autoOnly = false } = {}) {
  const abs = resolve(String(dir || '').trim());
  const t = loadTeam();
  if (!t.roots || !t.roots[abs]) return false;
  if (autoOnly && !t.roots[abs].auto) return false;
  delete t.roots[abs];
  saveTeam(t);
  return true;
}

// Containment against the whole team space. Pass an explicit root to check just that one.
export function withinWorkspace(p, root = null) {
  const roots = root ? [root] : teamRoots();
  return roots.some((r) => containedBy(p, r));
}

// A guest's effective cwd: whatever they asked for if it's inside the team space,
// otherwise the scratch workspace root. Never throws, never leaks the reason.
export function guestCwd(requested) {
  const root = ensureWorkspace();
  const want = String(requested || '').trim();
  if (!want) return root;
  const abs = resolve(want.startsWith('~') ? want.replace(/^~/, HOME) : want);
  return withinWorkspace(abs) ? abs : root;
}

// ---- team secrets ----------------------------------------------------------
//
// Keys someone has deliberately published to the team, kept out of team.json so the file
// holding credentials can be 0600 and is never the file we hand to a client. Values leave
// this module in exactly one direction: into a spawned agent's environment. Nothing
// returns them over HTTP, and nothing logs them.
const SECRETS_PATH = join(STATE_DIR, 'team-secrets.json');
const VALID_KEY = /^[A-Z][A-Z0-9_]{1,63}$/;

// Refusing these is not paranoia about the value — it's that team secrets are injected
// into the OWNER's sessions too, so a guest who could set PATH or NODE_OPTIONS could run
// their own code inside the owner's agent.
const RESERVED_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'TMPDIR', 'IFS',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS',
  'BASH_ENV', 'ENV', 'PYTHONPATH', 'PYTHONSTARTUP', 'PERL5LIB', 'GIT_SSH_COMMAND',
  'CC_AUTH_TOKEN', 'BOX_TEAM', 'BOX_TEAM_WORKSPACE', 'EXTRA_ENV_FILE',
]);

let secretsCache = null;
function loadSecrets() {
  if (secretsCache) return secretsCache;
  let s = { version: 1, secrets: {} };
  try { s = { version: 1, secrets: {}, ...JSON.parse(readFileSync(SECRETS_PATH, 'utf8')) }; } catch {}
  secretsCache = s;
  return s;
}

function saveSecrets(s) {
  secretsCache = s;
  if (!diskEnabled) return s;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = SECRETS_PATH + '.tmp';
    // 0600 at create time, not chmod-after-write: a world-readable window, however short,
    // defeats the point on a box that other agents run on.
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, SECRETS_PATH);
  } catch {}
  return s;
}

export function secretKeyRejection(key) {
  const k = String(key || '').trim();
  if (!VALID_KEY.test(k)) return 'use an environment-variable name: A-Z, 0-9 and _';
  if (RESERVED_KEYS.has(k)) return `${k} controls how programs run and can't be a team secret`;
  return '';
}

// Metadata only — never the value. This is what the Team screen renders.
export function listSecrets() {
  const { secrets } = loadSecrets();
  return Object.entries(secrets).map(([key, m]) => ({
    key, addedAt: m.addedAt || 0, addedBy: m.addedBy || '', note: m.note || '', hint: m.hint || '',
  })).sort((a, b) => a.key.localeCompare(b.key));
}

export function setSecret(key, value, by = 'owner', note = '') {
  const k = String(key || '').trim();
  const why = secretKeyRejection(k);
  if (why) return { ok: false, error: why };
  const v = String(value == null ? '' : value);
  if (!v) return { ok: false, error: 'value is empty' };
  const s = loadSecrets();
  s.secrets[k] = {
    value: v,
    addedAt: Date.now(),
    addedBy: String(by || ''),
    note: String(note || '').slice(0, 200),
    // Enough to recognise a key you already pasted, too little to reconstruct it.
    hint: v.length <= 8 ? '•'.repeat(v.length) : v.slice(0, 3) + '…' + v.slice(-2),
  };
  saveSecrets(s);
  return { ok: true, key: k };
}

export function deleteSecret(key) {
  const s = loadSecrets();
  const k = String(key || '').trim();
  if (!s.secrets[k]) return false;
  delete s.secrets[k];
  saveSecrets(s);
  return true;
}

// The only path values take out of this module.
export function secretsEnv() {
  const { secrets } = loadSecrets();
  const out = {};
  for (const [k, m] of Object.entries(secrets)) if (m && m.value) out[k] = m.value;
  return out;
}

// ---- attribution -----------------------------------------------------------

// Every message carries who sent it, in two deliberately different ways:
//   - authorTag()  goes INTO the prompt, so the agent knows who it's talking to AND the
//                  durable transcript (Claude's own JSONL) records authorship — readable
//                  months later from the CLI, outside Box entirely.
//   - authorOf()   rides the WS event, so the UI can badge a bubble without parsing text.
//
// Tagging is applied ONLY in shared sessions (see the caller). A solo session's prompts
// stay byte-for-byte what they are today — no behavior change for a single-user box.
export const authorTag = (principal) =>
  principal && principal.name ? `[${principal.name}]` : '';

export function attributePrompt(text, principal) {
  const tag = authorTag(principal);
  if (!tag) return String(text || '');
  return `${tag} ${String(text || '')}`;
}

export const authorOf = (principal) => principal
  ? { id: principal.id, name: principal.name, role: principal.role, color: principal.color }
  : null;

// Strip a leading "[Name] " tag off a persisted transcript line and hand back both
// halves, so replayed history renders an author badge instead of literal brackets.
// Only names we actually know resolve — an unknown "[TODO]" or a spoofed name is left
// as plain text rather than inventing an identity from user-controlled content.
export function splitAuthorTag(text) {
  const m = /^\[([^\]\n]{1,40})\]\s([\s\S]*)$/.exec(String(text || ''));
  if (!m) return { author: null, text: String(text || '') };
  const name = m[1].trim();
  if (name === OWNER.name) return { author: { ...authorOf(OWNER) }, text: m[2] };
  const known = loadTeam().members.find((x) => x.name === name);
  if (!known) return { author: null, text: String(text || '') };
  return { author: { id: known.id, name: known.name, role: known.role, color: known.color }, text: m[2] };
}
