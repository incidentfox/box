import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const socketCode = app.slice(app.indexOf('function connectWS() {'), app.indexOf('\nfunction setNewChatIntro(', app.indexOf('function connectWS() {')));
const enqueueCode = app.slice(app.indexOf('function enqueueText('), app.indexOf('\nfunction clearComposerInput(', app.indexOf('function enqueueText(')));
assert.ok(socketCode.startsWith('function connectWS()'));
assert.ok(enqueueCode.startsWith('function enqueueText('));

const sockets = [];
class FakeSocket {
  constructor() { this.readyState = 0; this.sent = []; this.listeners = new Map(); sockets.push(this); }
  addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
  emit(type, event = {}) {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    this[`on${type}`]?.(event);
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
  send(data) { if (this.readyState !== 1) throw Error('socket is closed'); this.sent.push(JSON.parse(data)); }
  close() { this.emit('close'); }
}
const drafts = new Map();
const received = [];
const context = {
  WebSocket: FakeSocket, ws: null, wsWatchdog: null, cur: { key: 'bay', mode: 'normal', agent: 'codex', cwd: '/tmp', workspace: 'personal' },
  chatEp: () => ({ token: '' }), epWsUrl: () => '/ws', resetWsWatchdog: () => {},
  subscribeCurrentWS() { context.ws.send(JSON.stringify({ type: 'subscribe', key: context.cur.key })); },
  onServer: (event) => received.push(event), pendingTeamChat: null,
  $: () => ({ classList: { contains: () => true } }), clearInterval, setTimeout,
  loadDraft: (key) => drafts.get(key) || '', saveDraft: (key, value) => drafts.set(key, value),
  sendTyping: () => {}, refreshButton: () => {}, scrollBottom: () => {},
};
vm.createContext(context);
vm.runInContext(`${socketCode}\n${enqueueCode}`, context);

context.connectWS();
const oldSocket = sockets[0];
context.enqueueText('Bay prompt'); // waits for socket open
context.disconnectChatWS();
context.cur.key = 'unused';
context.connectWS();
const newSocket = sockets[1];
oldSocket.emit('open'); // a late open callback must not send Bay's prompt through Unused Page
oldSocket.emit('message', { data: JSON.stringify({ type: 'text', delta: 'Bay response' }) });
newSocket.emit('open');
assert.deepEqual(oldSocket.sent, []);
assert.deepEqual(newSocket.sent.map((m) => m.type + ':' + m.key), ['subscribe:unused']);
assert.equal(drafts.get('bay'), 'Bay prompt');
assert.deepEqual(received, []);

context.enqueueText('Unused prompt');
assert.deepEqual(newSocket.sent.map((m) => m.type + ':' + m.key), ['subscribe:unused', 'subscribe:unused', 'enqueue:unused']);
newSocket.emit('message', { data: JSON.stringify({ type: 'text', delta: 'Unused response' }) });
assert.equal(received.length, 1);
console.log('chat socket isolation ok');
