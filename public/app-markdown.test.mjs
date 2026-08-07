import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = app.indexOf('function md(src) {');
const end = app.indexOf('\n\n/* ---------- login ---------- */', start);
assert.ok(start >= 0 && end > start, 'locate Markdown renderer');

function render(input) {
  const context = {
    input, result: '', cur: null,
    esc: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    LOCAL_PATH_RE: /^\//, ABS_PATH_RE: /$^/g, REL_FILE_RE: /$^/g,
    verifiedPath: () => null, rawFileUrl: () => '', localPathLinkHtml: () => null,
    pathPreviewHtml: (value) => value, filePreviewChip: () => '', lonePathChip: () => null,
  };
  vm.runInNewContext(`${app.slice(start, end)}\nresult = md(input);`, context);
  return context.result;
}

function renderResolvedDestination(input) {
  const markdownStart = app.indexOf('/* ---------- markdown');
  const context = {
    input, result: '', cur: { cwd: '' }, CFG: { home: '/home/factory' }, live: null,
    document: { querySelectorAll: () => [] },
    esc: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    LOCAL_PATH_RE: /^(~|\/(?:tmp|home|opt|var|run|mnt|Volumes|Users))(?:\/|$)/,
    ABS_PATH_RE: /$^/g, REL_FILE_RE: /$^/g, REL_FILE_LONE_RE: /$^/g,
    verifiedPath: () => null, rawFileUrl: () => '', localPathLinkHtml: null,
    pathPreviewHtml: (value) => value, filePreviewChip: () => '', lonePathChip: () => null,
    ICONS: { file: '' }, api: async () => ({ json: async () => ({ results: {} }) }),
    setTimeout: () => 0, clearTimeout: () => {},
  };
  vm.runInNewContext(`${app.slice(markdownStart, end)}\nresult = md(input);`, context);
  return context.result;
}

const flow = render([
  '1. Check preflight', '', 'Before the call:', '', '- Review the record', '- Confirm the route', '',
  '1. Launch the call', '', 'The call runs.', '', '1. Review the result',
].join('\n'));
assert.match(flow, /<ol><li>Check preflight<\/li><\/ol>/);
assert.match(flow, /<ol start="2"><li>Launch the call<\/li><\/ol>/);
assert.match(flow, /<ol start="3"><li>Review the result<\/li><\/ol>/);

const reset = render('# A new section\n\n1. Fresh start');
assert.match(reset, /<h1>A new section<\/h1><ol><li>Fresh start<\/li><\/ol>/);
assert.doesNotMatch(reset, /<ol start=/);

const absolutePathLink = renderResolvedDestination('[Download](</home/factory/.codex/generated_images/result.png>)');
assert.equal(absolutePathLink, '<p>Download</p>');
assert.doesNotMatch(absolutePathLink, /href|&lt;|&gt;/);

console.log('app markdown ok');
