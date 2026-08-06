import assert from 'node:assert';
import { procTableSnapshot, procLinesFor } from './proc-table.mjs';

const ID = '019fcde5-840c-7bc0-b7f7-9c5ab07a5233';
const OTHER = '019fd7a9-9ea9-7603-b1e8-da219005e3bb';

// ---- procLinesFor: a shared snapshot must be narrowed to ONE id ------------------
// This is the safety property. killSessionBridge kills every line in what it is given
// that carries --remote-control; handing it an unfiltered snapshot would kill every
// live bridge on the box, not just the archived session's.
{
  const snapshot = [
    `100 claude --remote-control box-a --session-id ${ID}`,
    `200 claude --remote-control box-b --session-id ${OTHER}`,
    `300 dtach -A /tmp/cc-box-x.dtach claude --remote-control box-c --resume ${ID}`,
  ].join('\n');

  const mine = procLinesFor(ID, snapshot);
  assert.equal(mine.split('\n').length, 2, 'only the two lines mentioning this id');
  assert.ok(mine.includes('100 '), 'keeps the claude bridge for this id');
  assert.ok(mine.includes('300 '), 'keeps the dtach master for this id');
  assert.ok(!mine.includes('200 '), 'MUST NOT leak another session\'s bridge');

  assert.equal(procLinesFor('nope-not-here', snapshot), '', 'unmatched id yields nothing');
}

// A null snapshot (no procfs) defers to the real pgrep, preserving old behaviour.
{
  let asked = null;
  const out = procLinesFor(ID, null, (id) => { asked = id; return `900 claude --resume ${id}`; });
  assert.equal(asked, ID, 'falls back to pgrep for exactly this id');
  assert.ok(out.includes('900 '));
  assert.equal(procLinesFor(ID, null, undefined), '', 'no snapshot and no fallback is empty, not a throw');
}

// ---- procTableSnapshot: shape + resilience ---------------------------------------
{
  const fakeFs = {
    readdirSync: () => ([
      { name: '1', isDirectory: () => true },
      { name: '2', isDirectory: () => true },
      { name: 'self', isDirectory: () => true },       // non-numeric -> skipped
      { name: 'gone', isDirectory: () => true },
      { name: '3', isDirectory: () => true },          // empty cmdline -> skipped
    ]),
    readFileSync: (p) => {
      if (p === '/proc/1/cmdline') return `claude\0--remote-control\0box-a\0--session-id\0${ID}\0`;
      if (p === '/proc/2/cmdline') return `codex\0exec\0resume\0${OTHER}\0`;
      if (p === '/proc/3/cmdline') return '';
      throw new Error('ESRCH');                        // exited between readdir and read
    },
  };
  const snap = procTableSnapshot({ fs: fakeFs });
  const lines = snap.split('\n');
  assert.equal(lines.length, 2, 'skips non-numeric, empty, and vanished processes');
  assert.equal(lines[0], `1 claude --remote-control box-a --session-id ${ID}`, 'NULs become spaces');
  assert.equal(lines[1], `2 codex exec resume ${OTHER}`);

  // and it composes with the filter
  assert.equal(procLinesFor(OTHER, snap), `2 codex exec resume ${OTHER}`);
}

// No procfs -> null, which is the signal to use the portable path.
{
  const noProc = { readdirSync: () => { throw new Error('ENOENT'); }, readFileSync: () => '' };
  assert.equal(procTableSnapshot({ fs: noProc }), null);
}

// ---- the real /proc, on this host -------------------------------------------------
{
  const snap = procTableSnapshot();
  if (snap !== null) {
    assert.ok(snap.length > 0, 'real snapshot is non-empty');
    assert.ok(snap.split('\n').every((l) => /^\d+ \S/.test(l)), 'every line is "<pid> <argv>"');
    const self = procLinesFor(String(process.pid), snap);
    assert.ok(self.includes(String(process.pid)), 'finds this very process');
  }
}

console.log('proc-table.test.mjs ok');
