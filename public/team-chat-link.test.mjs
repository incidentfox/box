import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const style = readFileSync(new URL('./style.css', import.meta.url), 'utf8');

const routeStart = app.indexOf('const safeRoutePart =');
const routeEnd = app.indexOf('\nfunction routeFromLocation', routeStart);
const helperStart = app.indexOf('function teamChatShareUrl(');
const helperEnd = app.indexOf('\n// Client bootstrap', helperStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart, 'locate route URL helper');
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'locate team chat link helpers');

const copied = [];
const toasts = [];
const context = {
  URL,
  location: { origin: 'https://box.mindbill.org' },
  cur: null,
  copied,
  toasts,
  toast: (message) => toasts.push(message),
  writeClipboardText: async (text, label) => { copied.push({ text, label }); return true; },
  result: null,
};
vm.runInNewContext(
  `${app.slice(routeStart, routeEnd)}\n${app.slice(helperStart, helperEnd)}\nresult = { teamChatShareUrl, copyTeamChatLink };`,
  context,
);

const localChat = { id: 'thread/123', title: 'Website: Call Phones', shared: true, workspace: 'team', ep: null };
assert.equal(
  context.result.teamChatShareUrl(localChat),
  'https://box.mindbill.org/sessions/thread%2F123/website-call-phones?workspace=team',
);

const remoteChat = { ...localChat, id: 'remote-456', title: '', ep: { remote: true } };
assert.equal(
  context.result.teamChatShareUrl(remoteChat),
  'https://box.mindbill.org/team/sessions/remote-456/chat',
);

assert.equal(context.result.teamChatShareUrl({ ...localChat, shared: false, workspace: 'personal' }), '');
assert.equal(await context.result.copyTeamChatLink(localChat), true);
assert.deepEqual(copied[0], {
  text: 'https://box.mindbill.org/sessions/thread%2F123/website-call-phones?workspace=team',
  label: 'Team chat link copied',
});
assert.equal(new URL(copied[0].text).searchParams.has('token'), false, 'shared URL must not expose an access token');

assert.equal(await context.result.copyTeamChatLink({ ...localChat, shared: false, workspace: 'personal' }), false);
assert.equal(toasts.at(-1), 'Share this chat with your team first');

assert.match(app, /copyLink\.className = 'presCopyLink'/, 'shared presence strip exposes a copy-link control');
assert.match(app, /aria-label', 'Copy team chat link'/, 'copy-link control has an accessible name');
assert.match(app, /label: 'Copy team chat link'/, 'chat action sheet exposes the copy-link control');
assert.match(style, /\.presCopyLink\s*\{/, 'copy-link control is styled');

console.log('team chat share link ok');
