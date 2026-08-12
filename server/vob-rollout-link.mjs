import { closeSync, openSync, readSync } from 'node:fs';

export const VOB_ROLLOUT_SCAN_BYTES = 8 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 64 * 1024;
const REQUEST_ID_RE = /\brise4_[a-f0-9]{32}\b/i;
const REQUEST_ID_CHARS = 'rise4_'.length + 32;

// Legacy VOB sessions may only carry their case link in the rollout. Scan the
// beginning incrementally because the launch request id is part of the opening
// context. Never read an entire long-lived rollout: ordinary Box chat opens call
// this resolver too, and some Codex rollouts grow to multiple gigabytes.
export function firstVobRequestIdInRollout(file, {
  maxBytes = VOB_ROLLOUT_SCAN_BYTES,
  chunkBytes = DEFAULT_CHUNK_BYTES,
} = {}) {
  if (!file) return null;
  const limit = Math.max(0, Number(maxBytes) || 0);
  const chunkSize = Math.max(REQUEST_ID_CHARS, Number(chunkBytes) || DEFAULT_CHUNK_BYTES);
  if (!limit) return null;

  let fd;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(Math.min(chunkSize, limit));
    let position = 0;
    let overlap = '';
    while (position < limit) {
      const bytesToRead = Math.min(buffer.length, limit - position);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      if (!bytesRead) break;
      const text = overlap + buffer.subarray(0, bytesRead).toString('utf8');
      const match = text.match(REQUEST_ID_RE);
      if (match) return match[0];
      overlap = text.slice(-(REQUEST_ID_CHARS - 1));
      position += bytesRead;
    }
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try { closeSync(fd); } catch {}
    }
  }
  return null;
}
