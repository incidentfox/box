import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const team = readFileSync(new URL('./team.js', import.meta.url), 'utf8');
const style = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
const bundleUrl = new URL('./vendor/docx-renderer.bundle.js', import.meta.url);
const bundle = readFileSync(bundleUrl, 'utf8');

assert.match(app, /script\.src = '\/vendor\/docx-renderer\.bundle\.js'/, 'Word renderer is lazy-loaded from Box');
assert.match(app, /else if \(ext === 'docx'\) renderDocxPreview/, 'personal files use the Word preview');
assert.match(app, /stripCachedDocxPageBreaks\(new Uint8Array\(buffer\)\)/, 'preview strips stale cached page breaks');
assert.match(app, /ignoreLastRenderedPageBreak: true/, 'renderer ignores cached page breaks');
assert.match(app, /ignoreTableWrap: true/, 'renderer uses the validated table layout option');
assert.match(app, /renderHeaders: true/, 'headers are rendered');
assert.match(app, /renderFooters: true/, 'footers are rendered');
assert.match(app, /DOCX_MAX_BYTES = 30 \* 1024 \* 1024/, 'large files are bounded');
assert.ok(team.indexOf("if (ext === 'docx')") < team.indexOf('if (d.tooBig)'), 'shared Word files preview before text-size handling');
assert.match(team, /if \(ext === 'docx'\) \{\s*renderDocxPreview\(body, sourceUrl/, 'shared Word files use the same local preview renderer');
assert.match(style, /#readerBody\.docxBody, #tfReaderBody\.docxBody/, 'both file viewers have paginated Word styling');
assert.ok(statSync(bundleUrl).size > 100_000, 'vendored renderer bundle is present');
assert.ok(statSync(bundleUrl).size < 750_000, 'vendored renderer bundle remains reasonably sized');
assert.doesNotMatch(bundle, /(?:cdn\.jsdelivr\.net|unpkg\.com|esm\.sh)/, 'renderer has no runtime CDN dependency');

console.log('local DOCX preview wiring ok');
