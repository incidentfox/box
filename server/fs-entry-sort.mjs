export function sortFsEntries(entries, mode = 'name') {
  return [...entries].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    if (mode === 'mtime') {
      const byModified = (Number(b.mtime) || 0) - (Number(a.mtime) || 0);
      if (byModified) return byModified;
    }
    return a.name.localeCompare(b.name);
  });
}
