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
    ICONS: { copy: '<svg></svg>' },
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

const fenced = render('Run this:\n\n```bash\n! echo "<ok>"\n```\n\nDone.');
assert.match(fenced, /<div class="codeWrap"><button type="button" class="codeCopy" aria-label="Copy code"><svg><\/svg><span>Copy<\/span><\/button><pre><code class="language-bash">! echo &quot;&lt;ok&gt;&quot;<\/code><\/pre><\/div>/);
assert.equal(fenced.match(/class="codeCopy"/g).length, 1);

// Clicking the button copies the block verbatim, through the clipboard API or the textarea fallback.
async function clickCodeCopy(text, { clipboard }) {
  const copyStart = app.indexOf('function cleanCopyText(text) {');
  const copyEnd = app.indexOf('\nfunction ', app.indexOf('async function writeClipboardText('));
  assert.ok(copyStart >= 0 && copyEnd > copyStart, 'locate copy helpers');
  const written = []; const toasts = []; const fallback = []; let listener = null; let prevented = 0;
  const context = {
    toast: (label) => toasts.push(label),
    navigator: clipboard ? { clipboard: { writeText: async (value) => { written.push(value); } } } : {},
    document: {
      addEventListener: (type, fn) => { if (type === 'click') listener = fn; },
      createElement: () => ({ setAttribute() {}, style: {}, select() {}, remove() {}, set value(v) { fallback.push(v); } }),
      body: { appendChild() {} }, execCommand: () => true,
    },
  };
  vm.runInNewContext(app.slice(copyStart, copyEnd), context);
  const wrap = { querySelector: (sel) => (sel === 'pre code' ? { textContent: text } : null) };
  const button = { parentElement: wrap, closest: (sel) => (sel === '.codeCopy' ? button : null) };
  const handled = listener({ target: button, preventDefault: () => { prevented++; }, stopPropagation() {} });
  const ignored = listener({ target: { closest: () => null }, preventDefault: () => { prevented++; }, stopPropagation() {} });
  await new Promise((resolve) => setImmediate(resolve));
  return { written, fallback, toasts, handled, ignored, prevented };
}
const indented = '    if x:\n        return 1\n\n';
const viaClipboard = await clickCodeCopy(indented, { clipboard: true });
assert.deepEqual(viaClipboard.written, [indented]);
assert.deepEqual(viaClipboard.toasts, ['Copied']);
assert.equal(viaClipboard.handled, true);
assert.equal(viaClipboard.ignored, false);
assert.equal(viaClipboard.prevented, 1);
const viaFallback = await clickCodeCopy(indented, { clipboard: false });
assert.deepEqual(viaFallback.fallback, [indented]);
assert.deepEqual(viaFallback.toasts, ['Copied']);

console.log('app markdown ok');
