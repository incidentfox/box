#!/usr/bin/env node
// Mobile-browser regression for saving a PDF without navigating away from Box.

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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

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
  const file = url.pathname === '/' || !extname(url.pathname)
    ? join(PUBLIC, 'index.html')
    : join(PUBLIC, url.pathname);
  if (!existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});

const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const PW_DIR = process.env.PW_DIR || join(homedir(), 'development', 'tools', 'playwright');
const { chromium } = createRequire(join(PW_DIR, 'package.json'))('@playwright/test');
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
});
await page.addInitScript((token) => {
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

  const before = page.url();
  const save = page.getByRole('button', { name: 'Save / Share PDF' });
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
  console.log('PASS mobile PDF Save/Share preserves Box and Back exits the reader');
} finally {
  await browser.close();
  server.close();
}
