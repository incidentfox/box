#!/usr/bin/env node
// Mobile-browser regression for viewing and saving a multi-page PDF without
// navigating away from Box.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const TOKEN = 'mobile-pdf-e2e-token';
const PDF_PATH = '/tmp/mobile-save-test.pdf';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function createPdf(pageCount) {
  const pageRefs = Array.from({ length: pageCount }, (_, index) => `${3 + index * 2} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageRefs}] /Count ${pageCount} >>`,
  ];
  for (let index = 0; index < pageCount; index++) {
    const contentRef = 4 + index * 2;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentRef} 0 R /Resources << >> >>`);
    objects.push('<< /Length 0 >>\nstream\n\nendstream');
  }

  let output = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(output, 'binary'));
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(output, 'binary');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, 'binary');
}

const PAGE_COUNT = 12;
const PDF = createPdf(PAGE_COUNT);

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://box-e2e');
  const send = (value) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === '/api/raw') {
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': PDF.length });
    return res.end(PDF);
  }
  if (url.pathname === '/api/sessions') return send({ sessions: [], counts: { all: 0 }, defaultCwd: ROOT, defaultAgent: 'codex' });
  if (url.pathname.startsWith('/api/')) return send({});
  const file = url.pathname.startsWith('/vendor/pdfjs/')
    ? join(ROOT, 'node_modules', 'pdfjs-dist', 'legacy', 'build', url.pathname.split('/').pop())
    : url.pathname === '/' || !extname(url.pathname)
      ? join(PUBLIC, 'index.html')
      : join(PUBLIC, url.pathname);
  if (!existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});

const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const PW_DIR = process.env.PW_DIR || join(homedir(), 'development', 'tools', 'playwright');
const playwright = createRequire(join(PW_DIR, 'package.json'))('@playwright/test');
const browserName = process.env.PDF_E2E_BROWSER || 'chromium';
const browserType = playwright[browserName];
if (!browserType) throw new Error(`Unsupported PDF_E2E_BROWSER: ${browserName}`);
const browser = await browserType.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
});
await page.addInitScript((token) => {
  // Safari versions before 17.4 do not provide this API. The PDF.js legacy
  // bundle must install its compatibility implementation before opening a PDF.
  Object.defineProperty(Promise, 'withResolvers', { configurable: true, writable: true, value: undefined });
  localStorage.setItem('cc_token', token);
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: ({ files }) => Boolean(files && files.length) });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async ({ files }) => { window.__boxSharedName = files[0].name; },
  });
}, TOKEN);

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.evaluate((path) => openFile(path), PDF_PATH);
  await page.waitForSelector('#expReader:not(.hidden)');
  await page.waitForFunction((count) => document.querySelectorAll('.pdfPage').length === count, PAGE_COUNT);
  await page.waitForFunction(() => document.querySelectorAll('.pdfPage.rendered').length > 0);
  await page.waitForFunction(() => typeof Promise.withResolvers === 'function');

  const initiallyRendered = await page.locator('.pdfPage.rendered').count();
  if (initiallyRendered >= PAGE_COUNT) {
    throw new Error(`PDF eagerly rendered every page (${initiallyRendered}/${PAGE_COUNT})`);
  }

  await page.evaluate(() => document.querySelector('.pdfPage:last-child').scrollIntoView({ block: 'end' }));
  await page.waitForFunction(() => document.querySelector('.pdfPage:last-child').classList.contains('rendered'));
  await page.waitForFunction(() => !document.querySelector('.pdfPage:first-child canvas'));

  const pageState = await page.evaluate((count) => {
    const reader = document.querySelector('#readerBody');
    const last = document.querySelector('.pdfPage:last-child');
    return {
      pageCount: document.querySelectorAll('.pdfPage').length,
      lastLabel: last.getAttribute('aria-label'),
      scrollable: reader.scrollHeight > reader.clientHeight,
      scrollTop: reader.scrollTop,
      renderedAfterScroll: document.querySelectorAll('.pdfPage.rendered').length,
      firstPageReleased: !document.querySelector('.pdfPage:first-child canvas'),
      expectedLastLabel: `Page ${count} of ${count}`,
    };
  }, PAGE_COUNT);
  if (pageState.pageCount !== PAGE_COUNT || pageState.lastLabel !== pageState.expectedLastLabel || !pageState.scrollable || pageState.scrollTop <= 0 || !pageState.firstPageReleased || pageState.renderedAfterScroll >= PAGE_COUNT) {
    throw new Error(`PDF pages are not fully scrollable: ${JSON.stringify(pageState)}`);
  }

  if (process.env.PDF_E2E_SCREENSHOT) {
    await page.screenshot({ path: process.env.PDF_E2E_SCREENSHOT, fullPage: false });
  }

  const before = page.url();
  const save = page.locator('#readerDownload');
  await save.click();
  await page.waitForFunction(() => window.__boxSharedName === 'mobile-save-test.pdf');

  const state = await page.evaluate(() => ({
    url: location.href,
    readerVisible: !document.querySelector('#expReader').classList.contains('hidden'),
    explorerVisible: !document.querySelector('#explorer').classList.contains('hidden'),
    backLabel: document.querySelector('#readerBack').getAttribute('aria-label'),
  }));
  if (state.url !== before || !state.readerVisible || !state.explorerVisible || state.backLabel !== 'Back') {
    throw new Error(`PDF save changed reader state: ${JSON.stringify({ before, state })}`);
  }

  await page.getByRole('button', { name: 'Back' }).click();
  if (await page.locator('#explorer').evaluate((el) => !el.classList.contains('hidden'))) {
    throw new Error('Back did not close the PDF reader');
  }
  console.log(`PASS ${browserName} mobile PDF exposes all pages, lazily renders while scrolling, releases distant canvases, saves/shares, and Back exits the reader`);
} finally {
  await browser.close();
  server.close();
}
