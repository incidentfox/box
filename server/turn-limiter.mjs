export function normalizeTurnLimit(value, fallback = 3) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Raw bash commands inherit the session agent for display/routing, but they do not
// launch Codex and therefore must not occupy a Codex turn slot.
export function turnAdmissionQid(state) {
  const message = state?.queue?.[0];
  if (!message || message.mode === 'bash') return null;
  return (message.agent || state.agent || 'claude') === 'codex' ? message.qid || null : null;
}

// A worker may coalesce rapid messages from one sender, but only when they use the
// same execution path. Mixing bash/chat or different agents would make the head
// message's admission decision apply to work that requires a different runner.
export function queuedTurnBatchSize(state) {
  const queue = state?.queue;
  if (!Array.isArray(queue) || !queue.length) return 0;
  const head = queue[0];
  const headAuthor = head.author?.id || null;
  const headMode = head.mode || 'normal';
  const headAgent = head.agent || state.agent || 'claude';
  let take = 1;
  while (take < queue.length) {
    const message = queue[take];
    if ((message.author?.id || null) !== headAuthor) break;
    if ((message.mode || 'normal') !== headMode) break;
    if ((message.agent || state.agent || 'claude') !== headAgent) break;
    take++;
  }
  return take;
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
