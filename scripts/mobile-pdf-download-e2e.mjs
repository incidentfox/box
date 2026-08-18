#!/usr/bin/env node
// Mobile-WebKit regression for viewing, rotating, and saving a multi-page PDF
// through Box's real authenticated server routes.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'mobile-pdf-e2e-token';
const PAGE_COUNT = 12;

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

async function getFreePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => reservation.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function loadPlaywright() {
  try {
    return await import('@playwright/test');
  } catch {
    const playwrightDir = process.env.PW_DIR || join(homedir(), 'development', 'tools', 'playwright');
    return createRequire(join(playwrightDir, 'package.json'))('@playwright/test');
  }
}

async function waitForServer(origin, child, logs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Box test server exited early (${child.exitCode}):\n${logs.join('')}`);
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Box test server did not become ready:\n${logs.join('')}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

const tempHome = mkdtempSync(join(tmpdir(), 'box-mobile-pdf-e2e-'));
const pdfPath = join(tempHome, 'mobile-save-test.pdf');
const pdf = createPdf(PAGE_COUNT);
writeFileSync(pdfPath, pdf);
const port = await getFreePort();
const origin = `http://127.0.0.1:${port}`;
const logs = [];
const server = spawn(process.execPath, [join(ROOT, 'server/index.mjs')], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH,
    HOME: tempHome,
    USER: process.env.USER || 'factory',
    LOGNAME: process.env.LOGNAME || process.env.USER || 'factory',
    LANG: process.env.LANG || 'C.UTF-8',
    PORT: String(port),
    CC_AUTH_TOKEN: TOKEN,
    CC_WORKSPACE: ROOT,
    BOX_IGNORE_LOCAL_ENV: '1',
    BOX_SKIP_META_PROBE: '1',
    BOX_HOST_SECRETS_FILE: join(tempHome, 'missing-secrets.env'),
    LINEAR_LOCAL: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => logs.push(chunk.toString()));
server.stderr.on('data', (chunk) => logs.push(chunk.toString()));

let browser;
try {
  await waitForServer(origin, server, logs);

  const rawPath = `/api/raw?path=${encodeURIComponent(pdfPath)}`;
  const [unauthorized, wrongToken, authorized, pdfJs, pdfWorker] = await Promise.all([
    fetch(`${origin}${rawPath}`),
    fetch(`${origin}${rawPath}&token=wrong-token`),
    fetch(`${origin}${rawPath}&token=${encodeURIComponent(TOKEN)}`),
    fetch(`${origin}/vendor/pdfjs/pdf.mjs`),
    fetch(`${origin}/vendor/pdfjs/pdf.worker.mjs`),
  ]);
  if (unauthorized.status !== 401 || wrongToken.status !== 401) {
    throw new Error(`Raw PDF route did not enforce authentication (${unauthorized.status}/${wrongToken.status})`);
  }
  const authorizedPdf = Buffer.from(await authorized.arrayBuffer());
  if (!authorized.ok || authorized.headers.get('content-type') !== 'application/pdf' || !authorizedPdf.equals(pdf)) {
    throw new Error(`Authenticated raw PDF response was incorrect (${authorized.status}, ${authorized.headers.get('content-type')})`);
  }
  if (!pdfJs.ok || !pdfWorker.ok || !pdfJs.headers.get('content-type')?.startsWith('text/javascript') || !pdfWorker.headers.get('content-type')?.startsWith('text/javascript')) {
    throw new Error('PDF.js compatibility bundles were not served by the production routes');
  }

  const playwright = await loadPlaywright();
  const browserName = process.env.PDF_E2E_BROWSER || 'webkit';
  const browserType = playwright[browserName];
  if (!browserType) throw new Error(`Unsupported PDF_E2E_BROWSER: ${browserName}`);
  browser = await browserType.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
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

  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.evaluate((path) => openFile(path), pdfPath);
  await page.waitForSelector('#expReader:not(.hidden)');
  await page.waitForFunction((count) => document.querySelectorAll('.pdfPage').length === count, PAGE_COUNT);
  await page.waitForFunction(() => document.querySelectorAll('.pdfPage.rendered').length > 0);
  await page.waitForFunction(() => typeof Promise.withResolvers === 'function');

  const portrait = await page.locator('.pdfPage').first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction((oldWidth) => document.querySelector('.pdfPage').getBoundingClientRect().width > oldWidth + 100, portrait.width);
  const landscape = await page.locator('.pdfPage').first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const canvas = element.querySelector('canvas');
    return { width: rect.width, height: rect.height, canvasWidth: canvas?.getBoundingClientRect().width || 0 };
  });
  const expectedRatio = 612 / 792;
  if (Math.abs(landscape.width / landscape.height - expectedRatio) > 0.01 || Math.abs(landscape.canvasWidth - landscape.width) > 1) {
    throw new Error(`PDF geometry did not relayout after rotation: ${JSON.stringify({ portrait, landscape })}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction((oldWidth) => document.querySelector('.pdfPage').getBoundingClientRect().width < oldWidth - 100, landscape.width);

  const initiallyRendered = await page.locator('.pdfPage.rendered').count();
  if (initiallyRendered >= PAGE_COUNT) throw new Error(`PDF eagerly rendered every page (${initiallyRendered}/${PAGE_COUNT})`);

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

  if (process.env.PDF_E2E_SCREENSHOT) await page.screenshot({ path: process.env.PDF_E2E_SCREENSHOT, fullPage: false });

  const before = page.url();
  await page.locator('#readerDownload').click();
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
  if (await page.locator('#explorer').evaluate((element) => !element.classList.contains('hidden'))) {
    throw new Error('Back did not close the PDF reader');
  }
  console.log(`PASS ${browserName} mobile PDF uses authenticated routes, relayouts on rotation, exposes all pages, lazily renders, saves/shares, and Back exits`);
} finally {
  if (browser) await browser.close();
  await stopServer(server);
  rmSync(tempHome, { recursive: true, force: true });
}
