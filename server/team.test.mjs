import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _setTeamForTest, attributePrompt, authorTag, canAccessSession, claimSession, createInvite,
  formatInviteCode, guestCwd, isShared, listInvites, listMembers, normalizeInviteCode,
  OWNER, redeemInvite, renameMember, resolveGuest, revokeInvite, revokeMember, setOwnerName,
  setShared, setWorkspaceRoot, splitAuthorTag, withinWorkspace,
} from './team.mjs';

// _setTeamForTest also detaches the module from disk — nothing below touches a real team.json.
_setTeamForTest();

// ---- invite codes ----------------------------------------------------------
const inv = createInvite({ name: 'Long', note: 'cofounder' });
assert.match(inv.code, /^BOX-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
assert.equal(inv.usedAt, null);
assert.ok(inv.expiresAt > Date.now());
// Ambiguous glyphs must never appear — these get read aloud and retyped on a phone.
assert.equal(/[01OIL]/.test(inv.code.slice(4)), false);

// Humans paste these in every shape; all of them must land on the same code.
const body = inv.code.replace(/-/g, '').slice(3);
assert.equal(normalizeInviteCode(inv.code.toLowerCase()), inv.code);
assert.equal(normalizeInviteCode(body), inv.code);
assert.equal(normalizeInviteCode(`box ${body.slice(0, 4)} ${body.slice(4)}`), inv.code);
assert.equal(formatInviteCode('nonsense'), '');          // 'O' is not in the mint alphabet
assert.equal(formatInviteCode('short'), '');
assert.equal(formatInviteCode(''), '');
// Glyphs excluded to avoid ambiguity have no safe canonical form — reject, don't guess.
assert.equal(formatInviteCode('BOX-0000-1111'), '');

// ---- redemption ------------------------------------------------------------
assert.deepEqual(redeemInvite('BOX-ZZZZ-ZZZZ'), { error: 'bad code' });

const { member, token } = redeemInvite(inv.code, { name: 'Long Yi' });
assert.equal(member.name, 'Long Yi');
assert.equal(member.role, 'guest');
assert.match(token, /^boxg_[0-9a-f]{48}$/);
assert.equal(member.revoked, false);
// The raw token is never persisted — only its hash.
assert.equal(JSON.stringify(listMembers()).includes(token), false);

// Single use: the same code cannot mint a second identity.
assert.deepEqual(redeemInvite(inv.code, { name: 'Impostor' }), { error: 'code already used' });
assert.equal(listMembers().length, 1);
assert.equal(listInvites()[0].live, false);
assert.equal(listInvites()[0].usedBy, member.id);

// Expired and revoked codes are dead.
const expired = createInvite({ name: 'Stale', ttlMs: 60_000 });
_setTeamForTest({ invites: [{ ...expired, expiresAt: Date.now() - 1 }] });
assert.deepEqual(redeemInvite(expired.code), { error: 'code expired' });

_setTeamForTest();
const revocable = createInvite({ name: 'Oops' });
assert.equal(revokeInvite(revocable.code), true);
assert.deepEqual(redeemInvite(revocable.code), { error: 'code revoked' });

// ---- principal resolution --------------------------------------------------
_setTeamForTest();
const live = redeemInvite(createInvite({}).code, { name: 'Dana' });
const dana = resolveGuest(live.token);
assert.equal(dana.kind, 'guest');
assert.equal(dana.name, 'Dana');
assert.equal(dana.id, live.member.id);

// Anything unrecognized resolves to null — callers must read that as unauthenticated,
// never as "some guest".
assert.equal(resolveGuest(''), null);
assert.equal(resolveGuest(null), null);
assert.equal(resolveGuest('boxg_' + 'f'.repeat(48)), null);
assert.equal(resolveGuest('deadbeef'), null);          // an owner token must not resolve as a guest
assert.equal(resolveGuest(live.token.slice(0, -1)), null);
assert.equal(resolveGuest(live.token + 'a'), null);

// Revoking is a hard kill — the token can never resolve again.
assert.equal(revokeMember(live.member.id), true);
assert.equal(resolveGuest(live.token), null);
assert.equal(revokeMember(live.member.id), false);     // idempotent

// ---- session authorization -------------------------------------------------
_setTeamForTest();
const bob = redeemInvite(createInvite({}).code, { name: 'Bob' });
const carol = redeemInvite(createInvite({}).code, { name: 'Carol' });
const bobP = resolveGuest(bob.token);
const carolP = resolveGuest(carol.token);
const OWNER_P = { kind: 'owner', id: 'owner', name: 'You', role: 'owner' };

// Default deny: an unshared session is invisible to guests but always open to the owner.
assert.equal(canAccessSession(bobP, 'sess-private'), false);
assert.equal(canAccessSession(OWNER_P, 'sess-private'), true);
assert.equal(canAccessSession(null, 'sess-private'), false);
assert.equal(canAccessSession(bobP, ''), false);

setShared('sess-shared', true, 'owner');
assert.equal(isShared('sess-shared'), true);
assert.equal(canAccessSession(bobP, 'sess-shared'), true);
assert.equal(canAccessSession(carolP, 'sess-shared'), true);

// Unsharing revokes access immediately.
setShared('sess-shared', false);
assert.equal(canAccessSession(bobP, 'sess-shared'), false);

// A guest keeps access to sessions they started, without the owner sharing them back —
// but that does NOT leak them to other guests.
claimSession('sess-bob', bobP.id);
assert.equal(canAccessSession(bobP, 'sess-bob'), true);
assert.equal(canAccessSession(carolP, 'sess-bob'), false);
assert.equal(canAccessSession(OWNER_P, 'sess-bob'), true);

// ---- workspace containment -------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'box-team-'));
const outside = mkdtempSync(join(tmpdir(), 'box-secret-'));
writeFileSync(join(outside, 'creds'), 'super secret');
mkdirSync(join(root, 'proj', 'sub'), { recursive: true });
setWorkspaceRoot(root);

assert.equal(withinWorkspace(root), true);
assert.equal(withinWorkspace(join(root, 'proj')), true);
assert.equal(withinWorkspace(join(root, 'proj', 'sub')), true);
assert.equal(withinWorkspace(join(root, 'does-not-exist-yet.txt')), true);       // new files are fine
assert.equal(withinWorkspace(join(root, 'proj', 'new', 'deep.txt')), true);
assert.equal(withinWorkspace(outside), false);
assert.equal(withinWorkspace('/etc/passwd'), false);
assert.equal(withinWorkspace(join(root, '..')), false);
assert.equal(withinWorkspace(join(root, '..', 'etc')), false);
assert.equal(withinWorkspace(join(root, 'proj', '..', '..', 'etc')), false);     // traversal
assert.equal(withinWorkspace(''), false);
// A sibling directory sharing the root's name prefix must not be treated as inside it.
assert.equal(withinWorkspace(root + '-evil'), false);

// A symlink planted inside the workspace cannot be used to walk out of it.
symlinkSync(outside, join(root, 'escape'));
assert.equal(withinWorkspace(join(root, 'escape')), false);
assert.equal(withinWorkspace(join(root, 'escape', 'creds')), false);

// guestCwd never throws and never escapes — it silently clamps to the root.
assert.equal(guestCwd(join(root, 'proj')), join(root, 'proj'));
assert.equal(guestCwd(outside), root);
assert.equal(guestCwd('/etc'), root);
assert.equal(guestCwd(''), root);
assert.equal(guestCwd(null), root);
assert.equal(guestCwd('~'), root);

// ---- attribution -----------------------------------------------------------
_setTeamForTest();
const ada = resolveGuest(redeemInvite(createInvite({}).code, { name: 'Ada' }).token);

assert.equal(authorTag(ada), '[Ada]');
assert.equal(authorTag(null), '');
assert.equal(attributePrompt('ship it', ada), '[Ada] ship it');
assert.equal(attributePrompt('ship it', null), 'ship it');             // solo sessions stay untagged

// The owner badges by real name once the host sets it, so a guest reading a shared
// session sees "Jimmy" rather than an anonymous bubble.
setOwnerName('Jimmy');
assert.equal(attributePrompt('ship it', OWNER), '[Jimmy] ship it');
assert.deepEqual(splitAuthorTag('[Jimmy] ship it').author, { id: 'owner', name: 'Jimmy', role: 'owner', color: OWNER.color });

// Replayed transcript lines render as a badge + clean text, not literal brackets.
assert.deepEqual(splitAuthorTag('[Ada] ship it'), { author: { id: ada.id, name: 'Ada', role: 'guest', color: ada.color }, text: 'ship it' });
// An unknown or spoofed name is left alone — we never invent a member from text.
assert.deepEqual(splitAuthorTag('[Nobody] hi'), { author: null, text: '[Nobody] hi' });
assert.deepEqual(splitAuthorTag('[TODO] fix the parser'), { author: null, text: '[TODO] fix the parser' });
assert.deepEqual(splitAuthorTag('plain message'), { author: null, text: 'plain message' });
assert.deepEqual(splitAuthorTag(''), { author: null, text: '' });

// Names are sanitized at the boundary so they can't forge a tag or break the prompt.
_setTeamForTest();
const sneaky = redeemInvite(createInvite({}).code, { name: 'Eve]\n[Owner' });
assert.equal(sneaky.member.name, 'Eve] [Owner');
assert.equal(sneaky.member.name.includes('\n'), false);
assert.equal(splitAuthorTag(attributePrompt('hi', resolveGuest(sneaky.token))).author, null);

assert.equal(renameMember(sneaky.member.id, '  Eve  '), true);
assert.equal(listMembers()[0].name, 'Eve');
assert.equal(renameMember('nope', 'x'), false);
// An empty rename keeps the previous name rather than blanking the badge.
renameMember(sneaky.member.id, '');
assert.equal(listMembers()[0].name, 'Eve');

console.log('team.test.mjs ok');
