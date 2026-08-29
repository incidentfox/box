#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const localRequire = createRequire(import.meta.url);
const fallbackRequire = createRequire(join(process.env.PW_DIR || join(homedir(), 'development', 'tools', 'playwright'), 'package.json'));

function resolveModule(id) {
  try { return localRequire.resolve(id); } catch { return fallbackRequire.resolve(id); }
}

const { webkit } = (() => {
  try { return localRequire('@playwright/test'); } catch { return fallbackRequire('@playwright/test'); }
})();
if (existsSync(webkit.executablePath())) process.exit(0);

// Playwright 1.61 stopped exporting `playwright/cli`, although its documented
// `playwright` bin still points at cli.js. Resolve that public package root so
// the pretest works with both older and current Playwright releases.
const playwrightRoot = dirname(resolveModule('playwright/package.json'));
const child = spawn(process.execPath, [join(playwrightRoot, 'cli.js'), 'install', 'webkit'], { stdio: 'inherit' });
const [code] = await once(child, 'exit');
process.exit(code ?? 1);
