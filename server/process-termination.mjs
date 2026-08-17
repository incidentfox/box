const escalationTimers = new WeakMap();

export function terminateProcessWithEscalation(proc, {
  graceMs = 2_000,
  signalProcess = (child, signal) => child.kill(signal),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!proc) return false;

  let signaled = false;
  try { signaled = !!signalProcess(proc, 'SIGTERM'); } catch {}
  if (!signaled) return false;

  // Repeated Stop clicks should not accumulate kill timers for the same child.
  if (escalationTimers.has(proc)) return true;

  let timer = null;
  const settled = () => {
    if (timer) clearTimer(timer);
    escalationTimers.delete(proc);
  };
  if (typeof proc.once === 'function') proc.once('close', settled);

  timer = setTimer(() => {
    escalationTimers.delete(proc);
    if (proc.exitCode != null || proc.signalCode != null) return;
    try { signalProcess(proc, 'SIGKILL'); } catch {}
  }, graceMs);
  timer?.unref?.();
  return true;
}
