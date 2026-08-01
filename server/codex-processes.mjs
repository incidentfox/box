const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Return only actual `codex exec resume <thread>` processes. pgrep output can also
// include the scanner itself because its command line contains the thread id; requiring
// both the Codex executable token and the resume argv keeps cancellation narrowly scoped.
export function codexResumeProcessPids(procText, threadId) {
  const wanted = String(threadId || '').toLowerCase();
  if (!UUID_RE.test(wanted)) return [];
  const pids = new Set();
  for (const raw of String(procText || '').split('\n')) {
    const line = raw.trim();
    const split = line.indexOf(' ');
    if (split < 1) continue;
    const pid = Number(line.slice(0, split));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const argv = line.slice(split + 1).trim().split(/\s+/);
    const resume = argv.indexOf('resume');
    if (resume < 0) continue;
    const hasCodexExecutable = argv.slice(0, resume).some((arg) => /(?:^|\/)codex(?:$|-linux-|\.exe$)/i.test(arg));
    if (!hasCodexExecutable) continue;
    const id = argv.slice(resume + 1).find((arg) => UUID_RE.test(arg));
    if (id && id.toLowerCase() === wanted) pids.add(pid);
  }
  return [...pids].sort((a, b) => b - a);
}

export function codexResumeThreadActive(procText, threadId) {
  return codexResumeProcessPids(procText, threadId).length > 0;
}

export function terminateCodexThreadProcesses(threadId, signal = 'SIGTERM', {
  procText = '',
  killImpl = process.kill,
} = {}) {
  const killed = [];
  for (const pid of codexResumeProcessPids(procText, threadId)) {
    try { killImpl(pid, signal); killed.push(pid); } catch {}
  }
  return killed;
}
