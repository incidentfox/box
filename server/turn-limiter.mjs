export function normalizeTurnLimit(value, fallback = 3) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createTurnLimiter(limit) {
  const max = normalizeTurnLimit(limit);
  let active = 0;
  const waiters = [];

  function acquire({ signal } = {}) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve(null);
      let queued = false;
      const cancel = () => {
        if (!queued) return;
        queued = false;
        const idx = waiters.indexOf(grant);
        if (idx >= 0) waiters.splice(idx, 1);
        resolve(null);
      };
      const grant = () => {
        if (signal?.aborted) return cancel();
        queued = false;
        signal?.removeEventListener('abort', cancel);
        active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          active--;
          const next = waiters.shift();
          if (next) next();
        });
      };

      if (active < max) grant();
      else {
        queued = true;
        waiters.push(grant);
        signal?.addEventListener('abort', cancel, { once: true });
      }
    });
  }

  return {
    acquire,
    get active() { return active; },
    get queued() { return waiters.length; },
    get limit() { return max; },
  };
}

// Cancel the exact durable message whose worker is waiting for an admission slot.
// Keeping the qid on the runtime state makes this safe if another queue mutation raced
// with Cancel: a newer head is never removed merely because an older waiter was aborted.
export function cancelWaitingTurnAdmission(state) {
  const qid = state?._admissionQid;
  if (!qid) return null;
  const index = Array.isArray(state.queue) ? state.queue.findIndex((message) => message?.qid === qid) : -1;
  const message = index >= 0 ? state.queue.splice(index, 1)[0] : null;
  try { state._admissionAbort?.abort(); } catch {}
  return message;
}
