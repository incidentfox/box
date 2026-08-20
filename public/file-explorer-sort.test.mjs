import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = app.indexOf('function explorerSortMode');
const end = app.indexOf('\nfunction openJumpPath', start);
assert.ok(start >= 0 && end > start, 'locate explorer sorting helper');

const context = {
  expandBoxPath: (path) => path.replace(/^~/, '/home/factory'),
  result: null,
};
vm.runInNewContext(`${app.slice(start, end)}\nresult = { explorerSortMode };`, context);

assert.equal(context.result.explorerSortMode('/home/factory/.cc-mobile/uploads'), 'mtime');
assert.equal(context.result.explorerSortMode('/home/factory/.cc-mobile/uploads/'), 'mtime');
assert.equal(context.result.explorerSortMode('/home/factory/development'), 'name');

console.log('uploads explorer sort selection ok');
