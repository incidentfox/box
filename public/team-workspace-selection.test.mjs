import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const team = readFileSync(new URL('./team.js', import.meta.url), 'utf8');

const rootStart = app.indexOf('const teamWorkspaceRoot =');
const rootEnd = app.indexOf('\n', rootStart);
assert.ok(rootStart >= 0 && rootEnd > rootStart, 'locate team workspace root helper');

for (const [name, cfg, teamState, expected] of [
  ['owner', { team: { workspaceRoot: '/team/owner' } }, null, '/team/owner'],
  ['guest', { workspaceRoot: '/team/guest' }, null, '/team/guest'],
  ['remote', { team: { workspaceRoot: '/team/owner' } }, { workspaceRoot: '/team/remote' }, '/team/remote'],
]) {
  const context = { CFG: cfg, TEAM: teamState, result: null };
  vm.runInNewContext(`${app.slice(rootStart, rootEnd)}\nresult = teamWorkspaceRoot();`, context);
  assert.equal(context.result, expected, `${name} resolves the Team workspace root`);
}

const rememberStart = app.indexOf('function rememberWorkspace(');
const rememberEnd = app.indexOf('\nfunction setWorkspace', rememberStart);
assert.ok(rememberStart >= 0 && rememberEnd > rememberStart, 'locate workspace persistence helper');
const writes = [];
const context = {
  currentWorkspace: 'personal',
  LS: { setItem: (key, value) => writes.push([key, value]) },
  renderWorkspaceButton: () => writes.push(['render']),
  result: null,
};
vm.runInNewContext(`${app.slice(rememberStart, rememberEnd)}\nresult = rememberWorkspace('team');`, context);
assert.equal(context.result, 'team');
assert.deepEqual(writes, [['box_workspace', 'team'], ['render']]);

const openStart = app.indexOf('async function openChat(');
const openEnd = app.indexOf('\n  // A BRAND-NEW chat', openStart);
assert.match(app.slice(openStart, openEnd), /rememberWorkspace\(workspace\)/, 'opening a chat activates its workspace');
assert.match(team, /openChat\(\{[^\n]+workspace: 'team'[^\n]+team: true/, 'Team rows identify their workspace explicitly');

console.log('team workspace selection ok');
