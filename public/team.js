'use strict';
/* ---------- Box — Team / shared workspace UI ----------
   Loaded right after app.js as a plain classic script, so it shares app.js's top-level
   bindings ($, api, show, navTo, toast, esc, paintIcons, openChat, showSheet, closeSheet,
   ICONS, CFG, cur, ws, TEAM/saveTeam/teamEp/teamApiEp/isGuestHere, renderPresence, relTime,
   MEDIA). Same convention as voice.js. app.js only ever calls in through
   `typeof openTeam === 'function'` guards, so a box without this file still boots.

   Two directions of "team" meet on this one screen:
     • you joined SOMEONE ELSE's box with an invite code   → a remote endpoint (TEAM)
     • you host a team on THIS box                          → the owner admin panel
   A guest logged into this box directly sees only the first, scoped to what's shared. */

const TEAM_POLL_MS = 15000;
let teamRenderSeq = 0;
let teamPollTimer = null;

const normalizeHost = (h) => {
  const s = String(h || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : 'https://' + s;
};
const hostLabel = (h) => normalizeHost(h).replace(/^https?:\/\//i, '') || 'this box';

// Every team request is best-effort: a host that's asleep or a revoked token should
// degrade the card, never throw into the render and blank the whole screen.
async function teamGet(path, ep, init) {
  try {
    const r = await api(path, { ep, ...(init || {}) });
    return await r.json();
  } catch { return { error: 'unreachable' }; }
}

/* ---------- tiny DOM builders (textContent everywhere — names/paths are user data) ---------- */
const tEl = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
function tBtn(label, cls, fn) {
  const b = tEl('button', 'tBtn' + (cls ? ' ' + cls : ''), label);
  b.type = 'button';
  b.onclick = (e) => { e.stopPropagation(); fn(e); };
  return b;
}
function tCard(title, sub) {
  const c = tEl('div', 'tCard');
  const h = tEl('div', 'tCardHead');
  h.appendChild(tEl('div', 'tCardTitle', title));
  if (sub) h.appendChild(tEl('div', 'tCardSub', sub));
  c.appendChild(h);
  return c;
}
function tSub(card, label) { card.appendChild(tEl('div', 'tSubHead', label)); return card; }
function tDot(color, online) {
  const d = tEl('span', 'tDot' + (online ? ' on' : ''));
  if (color) d.style.background = color;
  return d;
}
function tNote(text) { return tEl('div', 'tNote', text); }

/* ---------- the Team screen ---------- */
function openTeam() {
  show('team');
  navTo({ view: 'team' });
  paintIcons($('team'));
  renderTeam();
}

async function renderTeam() {
  const body = $('teamBody');
  if (!body) return;
  const seq = ++teamRenderSeq;
  if (!body.children.length) body.appendChild(tNote('Loading…'));

  const guestHere = isGuestHere();
  const remote = teamEp();
  const frag = document.createDocumentFragment();

  // A guest is *on* the host box: local endpoint, but only the shared slice of it.
  if (guestHere) {
    const [me, list] = await Promise.all([
      teamGet('/api/team/me', LOCAL_EP),
      teamGet('/api/team/sessions', LOCAL_EP),
    ]);
    if (seq !== teamRenderSeq) return;
    frag.appendChild(hostCard({ ep: LOCAL_EP, remote: false, me, list, host: '' }));
  }

  // An owner of their own box who redeemed an invite elsewhere: everything here is remote.
  if (remote) {
    const [me, list] = await Promise.all([
      teamGet('/api/team/me', remote),
      teamGet('/api/team/sessions', remote),
    ]);
    if (seq !== teamRenderSeq) return;
    frag.appendChild(hostCard({ ep: remote, remote: true, me, list, host: TEAM && TEAM.host }));
  }

  // Hosting side. Guests can't call /api/team at all (owner-only), so don't try.
  if (!guestHere) {
    const [admin, list] = await Promise.all([
      teamGet('/api/team', LOCAL_EP),
      teamGet('/api/team/sessions', LOCAL_EP),
    ]);
    if (seq !== teamRenderSeq) return;
    frag.appendChild(ownerCard(admin, list));
  }

  if (seq !== teamRenderSeq) return;
  body.innerHTML = '';
  body.appendChild(frag);
  paintIcons(body);
  $('teamBack').style.display = guestHere ? 'none' : '';
  startTeamPoll();
}

// One team you belong to but don't run: its shared chats, its workspace, who's around.
function hostCard({ ep, remote, me, list, host }) {
  const ownerName = (me && me.ownerName) || (remote && TEAM && TEAM.ownerName) || 'the host';
  const card = tCard(`${ownerName}'s team`, remote ? hostLabel(host) : 'this box');

  if (me && me.error) {
    card.appendChild(tNote(me.error === 'unreachable'
      ? `Can't reach ${hostLabel(host)} right now.`
      : String(me.error)));
    if (remote) card.appendChild(tBtn('Leave team', 'danger', () => confirmLeaveRemote()));
    return card;
  }

  const meName = (me && me.member && me.member.name) || (remote && TEAM && TEAM.member && TEAM.member.name) || 'you';
  const root = (me && me.workspaceRoot) || (remote && TEAM && TEAM.workspaceRoot) || '';

  const idRow = tEl('div', 'tRow');
  idRow.appendChild(tDot(me && me.member && me.member.color, true));
  idRow.appendChild(tEl('div', 'tRowName', `${meName} (you)`));
  idRow.appendChild(tEl('div', 'spacer'));
  idRow.appendChild(tBtn('Leave', 'ghost', () => (remote ? confirmLeaveRemote() : confirmLeaveHere())));
  card.appendChild(idRow);

  if (root) card.appendChild(workspaceRow(root, ep, null));

  const startBtn = tBtn('New chat in shared workspace', 'primary', () => openChat({
    id: null, title: 'New chat', cwd: root,
    agent: configuredDefaultAgent(),
    ep: remote ? ep : null, shared: true,
  }));
  card.appendChild(startBtn);

  const sessions = (list && list.sessions) || [];
  tSub(card, sessions.length ? 'Shared chats' : 'Shared chats');
  if (!sessions.length) card.appendChild(tNote(`Nothing shared yet — ${ownerName} shares a chat from its ⋯ menu.`));
  for (const s of sessions) card.appendChild(teamSessionRow(s, remote ? ep : null, { remote }));

  const members = (me && me.members) || [];
  const online = new Set((me && me.online) || []);
  if (members.length) {
    tSub(card, 'Members');
    card.appendChild(peopleStrip(members, online, me && me.member && me.member.id, ownerName));
  }
  return card;
}

// The team you run: invites, members, workspace root, what you've shared out.
function ownerCard(admin, list) {
  const hasTeam = admin && !admin.error && ((admin.members || []).some((m) => !m.revoked) || (admin.invites || []).some((i) => i.live));
  const card = tCard('Your team', hasTeam ? 'people you invited to this box' : null);

  if (admin && admin.error) { card.appendChild(tNote(String(admin.error))); return card; }
  if (admin && admin.enabled === false) {
    card.appendChild(tNote('Team access is disabled on this box (BOX_TEAM=off).'));
    return card;
  }

  if (!hasTeam) {
    card.appendChild(tNote('Invite a teammate and they get a code to enter once — from their own Box, or straight from this URL. They can open the chats you share and work in the shared folder, and nothing else.'));
  }

  const root = (admin && admin.workspaceRoot) || '';
  card.appendChild(workspaceRow(root || '(not set)', LOCAL_EP, () => openWorkspaceSheet(root)));

  card.appendChild(tBtn('Invite a teammate', 'primary', openInviteSheet));

  const invites = (admin.invites || []).filter((i) => i.live);
  if (invites.length) {
    tSub(card, 'Unused invite codes');
    for (const inv of invites) card.appendChild(inviteRow(inv));
  }

  const members = (admin.members || []).filter((m) => !m.revoked);
  const online = new Set(admin.online || []);
  if (members.length) {
    tSub(card, `Members (${members.length})`);
    for (const m of members) card.appendChild(memberRow(m, online.has(m.id)));
  }

  const shared = ((list && list.sessions) || []).filter((s) => s.shared);
  tSub(card, `Chats you've shared (${shared.length})`);
  if (!shared.length) card.appendChild(tNote('Open a chat → tap its title → Share with team.'));
  for (const s of shared) card.appendChild(teamSessionRow(s, null, { owner: true }));

  const join = tEl('div', 'tFoot');
  join.appendChild(tBtn(teamEp() ? 'Join a different team' : 'Join someone else’s team', 'ghost', openJoinTeam));
  card.appendChild(join);
  return card;
}

function workspaceRow(root, ep, onChange) {
  const row = tEl('div', 'tRow');
  const ic = tEl('span', 'tRowIc'); ic.innerHTML = ICONS.folder; row.appendChild(ic);
  row.appendChild(tEl('div', 'tRowName tMono', root));
  row.appendChild(tEl('div', 'spacer'));
  row.appendChild(tBtn('Browse', 'ghost', () => openTeamFiles(ep)));
  if (onChange) row.appendChild(tBtn('Change', 'ghost', onChange));
  return row;
}

function peopleStrip(members, online, meId, ownerName) {
  const strip = tEl('div', 'tPeople');
  const host = tEl('span', 'tPerson');
  host.appendChild(tDot('#f0b429', online.has('owner')));
  host.appendChild(tEl('span', null, `${ownerName} · host`));
  strip.appendChild(host);
  for (const m of members) {
    const p = tEl('span', 'tPerson');
    p.appendChild(tDot(m.color, online.has(m.id)));
    p.appendChild(tEl('span', null, m.id === meId ? `${m.name} (you)` : m.name));
    strip.appendChild(p);
  }
  return strip;
}

function teamSessionRow(s, ep, { remote = false, owner = false } = {}) {
  const row = tEl('div', 'tRow tRowTap');
  const av = tEl('span', 'tRowIc' + (s.live ? ' live' : ''));
  av.innerHTML = s.live ? ICONS.laptop : ICONS.chat;
  row.appendChild(av);

  const hd = tEl('div', 'tRowHd');
  hd.appendChild(tEl('div', 'tRowName', s.title || 'Untitled chat'));
  const meta = tEl('div', 'tRowMeta');
  if (s.agent && s.agent !== 'claude') meta.appendChild(tEl('span', 'agentTag ' + s.agent, agentLabel(s.agent)));
  if (s.mine) meta.appendChild(tEl('span', 'tTag', 'yours'));
  if (owner && !s.shared) meta.appendChild(tEl('span', 'tTag', 'private'));
  const when = tEl('span', null, relTime(s.mtime));
  meta.appendChild(when);
  for (const v of s.viewers || []) {
    const d = tDot(v.color, true); d.title = v.name; meta.appendChild(d);
  }
  hd.appendChild(meta);
  row.appendChild(hd);

  if (owner) {
    row.appendChild(tEl('div', 'spacer'));
    row.appendChild(tBtn('Stop sharing', 'ghost', async () => {
      await setSessionShared(s.id, false);
      renderTeam();
    }));
  }
  row.onclick = () => openChat({ id: s.id, title: s.title, agent: s.agent, cwd: s.cwd || '', ep, shared: true });
  return row;
}

/* ---------- owner actions ---------- */
function sheetForm(title, fields, submitLabel, onSubmit, extra) {
  const inner = $('sheetInner');
  inner.innerHTML = '';
  inner.appendChild(tEl('h3', null, title));
  const form = tEl('form', 'tForm');
  const inputs = {};
  for (const f of fields) {
    const wrap = tEl('label', 'tField');
    wrap.appendChild(tEl('span', 'tFieldLabel', f.label));
    const i = tEl('input');
    i.autocomplete = 'off'; i.spellcheck = false;
    if (f.placeholder) i.placeholder = f.placeholder;
    if (f.value) i.value = f.value;
    if (f.autocap === false) { i.autocapitalize = 'none'; }
    inputs[f.name] = i;
    wrap.appendChild(i);
    if (f.hint) wrap.appendChild(tEl('span', 'tFieldHint', f.hint));
    form.appendChild(wrap);
  }
  const err = tEl('div', 'tFormErr');
  form.appendChild(err);
  const go = tEl('button', 'tBtn primary', submitLabel); go.type = 'submit';
  form.appendChild(go);
  form.onsubmit = async (e) => {
    e.preventDefault();
    go.disabled = true; err.textContent = '';
    const vals = {};
    for (const k of Object.keys(inputs)) vals[k] = inputs[k].value.trim();
    try {
      const msg = await onSubmit(vals);
      if (msg) { err.textContent = msg; go.disabled = false; return; }
    } catch { err.textContent = 'Something went wrong'; go.disabled = false; return; }
  };
  inner.appendChild(form);
  if (extra) inner.appendChild(extra);
  showSheet();
  setTimeout(() => { try { inputs[fields[0].name].focus(); } catch {} }, 60);
}

function openInviteSheet() {
  sheetForm('Invite a teammate', [
    { name: 'name', label: 'Their name', placeholder: 'Long', hint: 'Shown on every message they send.' },
    { name: 'ttlHours', label: 'Code expires in (hours)', value: '168', hint: 'Unused codes die on their own. Max 720.' },
  ], 'Create code', async (v) => {
    if (!v.name) return 'Give them a name so their messages are attributable.';
    const r = await api('/api/team/invites', { method: 'POST', body: JSON.stringify({ name: v.name, ttlHours: Number(v.ttlHours) || 168 }) });
    const d = await r.json();
    if (d.error) return d.error;
    closeSheet();
    showInviteCode(d.invite);
    renderTeam();
  });
}

// The code is the credential, so it's shown once here in big type and copyable —
// after this it's just a row in the list (still copyable; it's single-use and TTL'd).
function showInviteCode(inv) {
  const inner = $('sheetInner');
  inner.innerHTML = '';
  inner.appendChild(tEl('h3', null, `Invite for ${inv.name || 'your teammate'}`));
  inner.appendChild(tEl('div', 'tCodeBig', inv.code));
  inner.appendChild(tNote('Single use. They enter it once — in their own Box under Team → Join, or straight from this box’s login screen — and stay connected after that.'));
  const row = tEl('div', 'tRow');
  row.appendChild(tBtn('Copy code', 'primary', () => writeClipboardText(inv.code, 'Code copied')));
  row.appendChild(tBtn('Copy invite text', 'ghost', () => writeClipboardText(inviteText(inv), 'Invite copied')));
  inner.appendChild(row);
  showSheet();
}
const inviteText = (inv) =>
  `You're invited to my Box.\n\nOpen ${location.origin} and tap "Have an invite code? Join a team".\nCode: ${inv.code}\n\n(Or, if you run your own Box: Team → Join someone else's team, host ${location.origin}.)`;

function inviteRow(inv) {
  const row = tEl('div', 'tRow');
  row.appendChild(tEl('code', 'tCode', inv.code));
  const hd = tEl('div', 'tRowHd');
  hd.appendChild(tEl('div', 'tRowName', inv.name || 'unnamed'));
  const left = Math.max(0, inv.expiresAt - Date.now());
  hd.appendChild(tEl('div', 'tRowMeta', left > 864e5 ? `expires in ${Math.round(left / 864e5)}d` : `expires in ${Math.max(1, Math.round(left / 36e5))}h`));
  row.appendChild(hd);
  row.appendChild(tEl('div', 'spacer'));
  row.appendChild(tBtn('Copy', 'ghost', () => writeClipboardText(inv.code, 'Code copied')));
  row.appendChild(tBtn('Revoke', 'ghost danger', async () => {
    await api(`/api/team/invites/${encodeURIComponent(inv.code)}/revoke`, { method: 'POST' });
    toast('Code revoked');
    renderTeam();
  }));
  return row;
}

function memberRow(m, online) {
  const row = tEl('div', 'tRow');
  row.appendChild(tDot(m.color, online));
  const hd = tEl('div', 'tRowHd');
  hd.appendChild(tEl('div', 'tRowName', m.name));
  hd.appendChild(tEl('div', 'tRowMeta', online ? 'online now' : (m.lastSeenAt ? `last seen ${relTime(m.lastSeenAt)}` : `joined ${relTime(m.createdAt)}`)));
  row.appendChild(hd);
  row.appendChild(tEl('div', 'spacer'));
  row.appendChild(tBtn('Rename', 'ghost', () => sheetForm(`Rename ${m.name}`, [
    { name: 'name', label: 'Name', value: m.name },
  ], 'Save', async (v) => {
    if (!v.name) return 'Pick a name.';
    await api(`/api/team/members/${encodeURIComponent(m.id)}/rename`, { method: 'POST', body: JSON.stringify({ name: v.name }) });
    closeSheet(); renderTeam();
  })));
  row.appendChild(tBtn('Remove', 'ghost danger', () => confirmSheet(
    `Remove ${m.name}?`,
    'Their code stops working immediately and any live session of theirs is disconnected. This cannot be undone — send a new invite to let them back in.',
    'Remove', async () => {
      await api(`/api/team/members/${encodeURIComponent(m.id)}/revoke`, { method: 'POST' });
      toast(`${m.name} removed`);
      renderTeam();
    })));
  return row;
}

function openWorkspaceSheet(current) {
  sheetForm('Shared workspace', [
    { name: 'path', label: 'Folder on this box', value: current, placeholder: '~/development/team-shared', autocap: false },
  ], 'Save', async (v) => {
    if (!v.path) return 'Enter a path.';
    const r = await api('/api/team/workspace', { method: 'POST', body: JSON.stringify({ path: v.path }) });
    const d = await r.json();
    if (d.error) return d.error;
    closeSheet(); toast('Shared workspace updated'); renderTeam();
  }, tNote('Guests can read and write anything under this folder, and nothing outside it. Their own chats start here too.'));
}

function confirmSheet(title, body, label, fn) {
  const inner = $('sheetInner');
  inner.innerHTML = '';
  inner.appendChild(tEl('h3', null, title));
  inner.appendChild(tNote(body));
  const row = tEl('div', 'tRow');
  row.appendChild(tBtn(label, 'danger', async () => { closeSheet(); await fn(); }));
  row.appendChild(tBtn('Cancel', 'ghost', () => closeSheet()));
  inner.appendChild(row);
  showSheet();
}

/* ---------- sharing the open chat ---------- */
async function setSessionShared(id, on) {
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(id)}/share`, { method: 'POST', body: JSON.stringify({ shared: !!on }) });
    const d = await r.json();
    if (d.error) { toast(d.error); return null; }
    return d;
  } catch { toast('Could not update sharing'); return null; }
}

async function toggleShareCurrentChat(on) {
  if (!cur || !cur.id) return toast('Send a message first — an empty chat has nothing to share');
  if (cur.ep && cur.ep.remote) return toast('Only the host can share this chat');
  const d = await setSessionShared(cur.id, on);
  if (!d) return;
  cur.shared = !!d.shared;
  renderPresence();
  // The server broadcasts `share` to every subscriber (us included) and app.js toasts
  // on that. Only toast here if we're not actually listening.
  if (!ws || ws.readyState !== 1) toast(d.shared ? 'Shared with your team' : 'No longer shared');
}

/* ---------- joining ---------- */
// From this box's login screen: the code IS the login. Redeeming hands back a guest
// token, which this same origin accepts as a credential, so we just log in with it.
function openJoinHere() {
  sheetForm('Join a team', [
    { name: 'code', label: 'Invite code', placeholder: 'BOX-XXXX-XXXX', autocap: false },
    { name: 'name', label: 'Your name (optional)', placeholder: 'Long', hint: 'Shown next to every message you send.' },
  ], 'Join', async (v) => {
    if (!v.code) return 'Enter the code you were sent.';
    const r = await fetch('/api/team/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: v.code, name: v.name }),
    });
    const d = await r.json().catch(() => ({ error: 'bad response' }));
    if (!r.ok || d.error) return d.error || 'That code did not work';
    closeSheet();
    TOKEN = d.token; LS.setItem('cc_token', d.token);
    const route = { view: 'team' };
    navTo(route, { replace: true });
    loadConfig(); renderRoute(route);
    toast(`Welcome, ${d.member.name}`);
  });
}

// From your OWN box: you stay logged in here and gain a second, remote endpoint.
function openJoinTeam() {
  sheetForm('Join someone else’s team', [
    { name: 'host', label: 'Their Box address', placeholder: 'box.example.com', value: (TEAM && TEAM.host) || '', autocap: false },
    { name: 'code', label: 'Invite code', placeholder: 'BOX-XXXX-XXXX', autocap: false },
    { name: 'name', label: 'Your name (optional)', placeholder: 'Long' },
  ], 'Join', async (v) => {
    if (!v.code) return 'Enter the code you were sent.';
    const host = normalizeHost(v.host);
    if (!host) return 'Enter the address of their Box.';
    let d;
    try {
      const r = await fetch(host + '/api/team/join', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: v.code, name: v.name }),
      });
      d = await r.json().catch(() => ({ error: 'bad response' }));
      if (!r.ok && !d.error) d = { error: r.status === 404 ? 'that box has team access turned off' : 'that code did not work' };
    } catch { return `Can't reach ${hostLabel(host)} — check the address.`; }
    if (d.error) return d.error;
    saveTeam({ host, token: d.token, member: d.member, ownerName: d.ownerName, workspaceRoot: d.workspaceRoot, joinedAt: Date.now() });
    closeSheet();
    toast(`Joined ${d.ownerName || hostLabel(host)}’s team`);
    applyTeamChrome();
    openTeam();
  }, tNote('You keep your own Box. Their shared chats and workspace show up here as a second team.'));
}

function confirmLeaveRemote() {
  const name = (TEAM && TEAM.ownerName) || 'that team';
  confirmSheet(`Leave ${name}?`, 'Your access is given back and this device forgets the code. You would need a new invite to return.', 'Leave', async () => {
    const ep = teamEp();
    if (ep) { try { await api('/api/team/leave', { method: 'POST', ep }); } catch {} }
    saveTeam(null);
    toast('Left the team');
    applyTeamChrome();
    renderTeam();
  });
}

// A guest leaving the box they're logged into: this burns their token, so it ends
// the session entirely.
function confirmLeaveHere() {
  const name = (CFG && CFG.ownerName) || 'this team';
  confirmSheet(`Leave ${name}?`, 'Your invite is revoked and you are signed out. You would need a new code to come back.', 'Leave', async () => {
    try { await api('/api/team/leave', { method: 'POST' }); } catch {}
    logout();
  });
}

/* ---------- shared-workspace file browser ---------- */
let tfEp = LOCAL_EP;
let tfPathCur = '';
let tfRoot = '';

function openTeamFiles(ep) {
  const next = ep || teamApiEp();
  // Two boxes can be in play. A path from one is meaningless (and misleading) on the
  // other, so switching endpoints re-enters at that host's own workspace root.
  if (!tfEp || next.base !== tfEp.base) { tfPathCur = ''; tfRoot = ''; }
  tfEp = next;
  const pane = $('teamFiles');
  if (!pane) return;
  pane.classList.remove('hidden');
  paintIcons(pane);
  browseTeamFiles(tfPathCur);
}

async function browseTeamFiles(path) {
  $('tfReader').classList.add('hidden');
  $('tfList').classList.remove('hidden');
  const d = await teamGet('/api/team/fs?path=' + encodeURIComponent(path || ''), tfEp);
  if (d.error) return toast(d.error);
  if (d.type === 'file') return showTeamFile(d);
  tfPathCur = d.path; tfRoot = d.root;
  $('tfPath').textContent = tfShort(d.path);
  $('tfUp').style.visibility = d.parent ? '' : 'hidden';
  $('tfUp').onclick = () => browseTeamFiles(d.parent);
  const list = $('tfList'); list.innerHTML = '';
  if (!d.entries.length) list.appendChild(tNote('This folder is empty.'));
  for (const e of d.entries) {
    const full = (d.path.endsWith('/') ? d.path : d.path + '/') + e.name;
    const row = tEl('div', 'row');
    const ic = tEl('span', 'ic'); ic.innerHTML = e.dir ? ICONS.fold : ICONS.file; row.appendChild(ic);
    row.appendChild(tEl('span', 'nm', e.name));
    row.onclick = () => browseTeamFiles(full);
    if (!e.dir) {
      const at = tEl('span', 'at'); at.innerHTML = ICONS.at;
      at.onclick = (ev) => { ev.stopPropagation(); tfInsertRef(full); };
      row.appendChild(at);
    }
    list.appendChild(row);
  }
}

const tfShort = (p) => {
  const r = String(tfRoot || '').replace(/\/$/, '');
  const s = String(p || '');
  if (r && s === r) return s.split('/').pop() || s;
  if (r && s.startsWith(r + '/')) return s.slice(r.length + 1);
  return s;
};

function showTeamFile(d) {
  $('tfList').classList.add('hidden');
  $('tfReader').classList.remove('hidden');
  paintIcons($('tfReader'));
  const path = d.path;
  $('tfReaderName').textContent = path.split('/').pop();
  $('tfPath').textContent = tfShort(path);
  $('tfReaderAt').onclick = () => tfInsertRef(path);
  $('tfReaderBack').onclick = () => browseTeamFiles(path.replace(/\/[^/]+$/, '') || tfRoot);
  const body = $('tfReaderBody'); body.innerHTML = '';
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (MEDIA.img.includes(ext)) {
    const im = tEl('img', 'mediaimg');
    im.src = epUrl(tfEp, '/api/raw?path=' + encodeURIComponent(path) + '&token=' + encodeURIComponent(tfEp.token));
    body.appendChild(im);
    return;
  }
  if (d.tooBig) { body.appendChild(tNote(`Too large to preview (${Math.round((d.size || 0) / 1e6)} MB). @-mention it and ask the agent to read it.`)); return; }
  const pre = tEl('pre', 'codeblk', d.content == null ? '' : d.content);
  body.appendChild(pre);
}

// @-mention a shared file into the composer. Only useful with a chat open behind the
// overlay — but that's the normal case (you opened it from the chat's files button).
function tfInsertRef(path) {
  const t = $('input');
  t.value += (t.value && !t.value.endsWith(' ') ? ' ' : '') + '@' + path + ' ';
  autoGrow(); updateSend();
  $('teamFiles').classList.add('hidden');
  toast('✓ @' + path.split('/').pop());
}

/* ---------- wiring ---------- */
// Presence dots and "live" flags go stale fast. renderTeam() re-arms this itself, so
// the loop runs exactly as long as the screen is up and stops the moment it isn't.
function startTeamPoll() {
  clearTimeout(teamPollTimer);
  teamPollTimer = setTimeout(() => {
    if (document.body.dataset.view === 'team' && !document.hidden) renderTeam();
  }, TEAM_POLL_MS);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && document.body.dataset.view === 'team') renderTeam();
});

if ($('joinTeamLink')) $('joinTeamLink').onclick = openJoinHere;
if ($('teamBtn')) $('teamBtn').onclick = openTeam;
if ($('teamBack')) $('teamBack').onclick = () => (isGuestHere() ? null : openSessions(curFilter || 'all'));
if ($('teamRefresh')) $('teamRefresh').onclick = () => renderTeam();
if ($('teamFilesBtn')) $('teamFilesBtn').onclick = () => openTeamFiles();
if ($('tfClose')) $('tfClose').onclick = () => {
  if (!$('tfReader').classList.contains('hidden')) { $('tfReader').classList.add('hidden'); $('tfList').classList.remove('hidden'); return; }
  $('teamFiles').classList.add('hidden');
};
