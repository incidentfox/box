import { readdirSync, readFileSync } from 'node:fs';

// One "<pid> <argv>" snapshot of every process, read straight from /proc with no
// subprocess spawn.
//
// The archived-runtime reaper matches MANY session ids per tick. Doing that with
// pgrepFull(id) per session spawned 4 subprocesses (2x pgrep + 2x ps) per candidate and
// blocked the event loop ~230ms each — over 13s per tick with 60 candidates, which
// stalled every HTTP request AND every open chat's WebSocket stream. Callers take one
// snapshot and filter it in memory instead.
//
// Returns null where there's no procfs (macOS/BSD) so those hosts keep the portable
// per-id pgrep path.
export function procTableSnapshot({ fs = { readdirSync, readFileSync } } = {}) {
  let entries;
  try { entries = fs.readdirSync('/proc', { withFileTypes: true }); } catch { return null; }
  const lines = [];
  for (const entry of entries) {
    const name = entry && entry.name;
    if (!name || !/^\d+$/.test(name) || (entry.isDirectory && !entry.isDirectory())) continue;
    try {
      // Collapse NULs *and* any embedded newline: argv legitimately contains them
      // (services launched with a multi-line `bash -lc "…"`), and a stray newline
      // would split one process across several lines, breaking the "<pid> <argv>"
      // invariant every caller parses by.
      const argv = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/[\0\r\n]+/g, ' ').trim();
      if (argv) lines.push(`${name} ${argv}`);
    } catch {}   // process exited between readdir and read — normal, skip it
  }
  return lines.join('\n');
}

// Narrow a snapshot to the lines mentioning one id, so downstream matchers see exactly
// what `pgrepFull(id)` would have returned. Without the id filter a shared snapshot
// would let bridge-matching kill EVERY --remote-control process, not just this one's.
// With no snapshot (null) it defers to onMiss — the real pgrep — so single-session
// callers keep their existing behaviour on every platform.
export function procLinesFor(id, procText, onMiss) {
  if (procText == null) return onMiss ? onMiss(id) : '';
  const needle = String(id);
  if (!needle) return '';
  return procText.split('\n').filter((line) => line.includes(needle)).join('\n');
}
