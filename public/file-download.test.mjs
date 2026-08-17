import assert from 'node:assert/strict';
import { Blob } from 'node:buffer';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = app.indexOf('const preparedDownloadFiles =');
const end = app.indexOf('\nfunction fileDlBtn', start);
assert.ok(start >= 0 && end > start, 'locate mobile file download helpers');

class TestFile {
  constructor(parts, name, options = {}) {
    this.parts = parts;
    this.name = name;
    this.type = options.type || '';
  }
}

const anchors = [];
const toasts = [];
let fetchCount = 0;
const navigator = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
  platform: 'iPhone',
  maxTouchPoints: 5,
  canShare: ({ files }) => files.length === 1,
  share: async () => {},
};
const context = {
  Blob,
  Error,
  File: TestFile,
  Map,
  Promise,
  document: {
    body: { appendChild: () => {} },
    createElement: () => {
      const anchor = { style: {}, clickCalled: false, click() { this.clickCalled = true; }, remove() {} };
      anchors.push(anchor);
      return anchor;
    },
  },
  fetch: async () => {
    fetchCount += 1;
    return { ok: true, status: 200, blob: async () => new Blob(['pdf'], { type: 'application/pdf' }) };
  },
  navigator,
  rawFileUrl: (path, download = false) => `/api/raw?path=${encodeURIComponent(path)}${download ? '&dl=1' : ''}`,
  toast: (message) => toasts.push(message),
  result: null,
};
vm.runInNewContext(`${app.slice(start, end)}\nresult = { downloadFile };`, context);

let shared;
navigator.share = async (payload) => { shared = payload; };
await context.result.downloadFile('/tmp/report.pdf', 'report.pdf');
assert.equal(fetchCount, 1);
assert.equal(shared.files[0].name, 'report.pdf');
assert.equal(shared.files[0].type, 'application/pdf');
assert.equal(anchors.length, 0, 'native sharing does not navigate away from Box');

let shareAttempts = 0;
navigator.share = async () => {
  shareAttempts += 1;
  if (shareAttempts === 1) throw Object.assign(new Error('activation expired'), { name: 'NotAllowedError' });
};
await context.result.downloadFile('/tmp/slow.pdf', 'slow.pdf');
assert.match(toasts.at(-1), /tap Save \/ Share again/);
assert.equal(fetchCount, 2);
await context.result.downloadFile('/tmp/slow.pdf', 'slow.pdf');
assert.equal(fetchCount, 2, 'second tap reuses the prepared file and shares synchronously');

delete navigator.share;
delete navigator.canShare;
await context.result.downloadFile('/tmp/fallback.pdf', 'fallback.pdf');
assert.equal(anchors.at(-1).href, '/api/raw?path=%2Ftmp%2Ffallback.pdf');
assert.equal(anchors.at(-1).target, '_blank', 'mobile fallback opens outside the standalone PWA');
assert.equal(anchors.at(-1).clickCalled, true);

navigator.userAgent = 'Mozilla/5.0 (X11; Linux x86_64)';
navigator.platform = 'Linux x86_64';
await context.result.downloadFile('/tmp/desktop.pdf', 'desktop.pdf');
assert.equal(anchors.at(-1).href, '/api/raw?path=%2Ftmp%2Fdesktop.pdf&dl=1');
assert.equal(anchors.at(-1).download, 'desktop.pdf');
assert.equal(anchors.at(-1).target, undefined);

console.log('mobile file Save/Share behavior ok');
