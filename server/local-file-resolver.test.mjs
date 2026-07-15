import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanPathToken, createLocalFileResolver, FILE_SEARCH_EXT_RE } from './local-file-resolver.mjs';

const root = mkdtempSync(join(tmpdir(), 'box-file-resolver-'));
try {
  const state = join(root, '.cc-mobile');
  const uploads = join(state, 'uploads');
  const cwd = join(root, 'work');
  const extra = join(root, 'extra');
  mkdirSync(uploads, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(extra, { recursive: true });
  writeFileSync(join(cwd, 'attendees.csv'), 'name,company\nA,C\n');
  writeFileSync(join(extra, 'prospects.xlsx'), 'fake');

  const resolver = createLocalFileResolver({
    HOME: root,
    STATE_DIR: state,
    UPLOAD_DIR: uploads,
    defaultCwd: cwd,
    searchRoots: [extra],
  });

  assert.equal(cleanPathToken('"./attendees.csv,"'), './attendees.csv');
  for (const name of ['book.xls', 'book.xlsx', 'book.xlsm', 'book.xlsb', 'book.ods']) assert.equal(FILE_SEARCH_EXT_RE.test(name), true, name);
  const exact = resolver.resolveLocalFileReference('./attendees.csv', cwd);
  assert.equal(exact.found, true);
  assert.equal(exact.path, join(cwd, 'attendees.csv'));

  const searched = resolver.resolveLocalFileReference('prospects.xlsx', cwd);
  assert.equal(searched.found, true);
  assert.equal(searched.path, join(extra, 'prospects.xlsx'));

  const missing = resolver.resolveLocalFileReference('missing.xlsx', cwd);
  assert.equal(missing.found, false);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('local-file-resolver tests passed');
