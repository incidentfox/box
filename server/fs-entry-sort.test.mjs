import assert from 'node:assert/strict';
import { sortFsEntries } from './fs-entry-sort.mjs';

const entries = [
  { name: 'older.pdf', dir: false, mtime: 10 },
  { name: 'z-folder', dir: true, mtime: 20 },
  { name: 'newer.pdf', dir: false, mtime: 30 },
  { name: 'a-folder', dir: true, mtime: 40 },
  { name: 'same-b.pdf', dir: false, mtime: 25 },
  { name: 'same-a.pdf', dir: false, mtime: 25 },
];

assert.deepEqual(
  sortFsEntries(entries, 'mtime').map((entry) => entry.name),
  ['a-folder', 'z-folder', 'newer.pdf', 'same-a.pdf', 'same-b.pdf', 'older.pdf'],
  'newest-first sorting keeps folders first and uses names to break timestamp ties',
);
assert.deepEqual(
  sortFsEntries(entries).map((entry) => entry.name),
  ['a-folder', 'z-folder', 'newer.pdf', 'older.pdf', 'same-a.pdf', 'same-b.pdf'],
  'ordinary folder listings stay alphabetical',
);
assert.equal(entries[0].name, 'older.pdf', 'sorting does not mutate the source listing');

console.log('filesystem entry sorting ok');
