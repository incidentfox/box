import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = app.indexOf('function preservedChatScrollTop(');
const end = app.indexOf('\nfunction captureChatViewport', start);
assert.ok(start >= 0 && end > start, 'locate chat scroll preservation helper');

const context = { result: null };
vm.runInNewContext(`${app.slice(start, end)}\nresult = preservedChatScrollTop;`, context);
const preserved = context.result;

assert.equal(preserved({ top: 420, height: 3000, follow: false }, 3600), 420);
assert.equal(preserved({ top: 420, height: 3000, follow: false }, 3600, true), 1020);
assert.equal(preserved({ top: 420, height: 3000, follow: true }, 3600), 3600);

console.log('chat scroll ok');
