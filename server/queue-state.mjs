// Restore a message that was already removed from the pending queue when the
// previous Box process died. Keep the same qid so a partially-written state
// file cannot enqueue it twice.
export function recoverPersistedQueue(state = {}) {
  const queue = Array.isArray(state.queue) ? [...state.queue] : [];
  const inflight = state.inflight && typeof state.inflight === 'object' ? state.inflight : null;
  if (inflight && !queue.some((msg) => msg && msg.qid && msg.qid === inflight.qid)) queue.unshift(inflight);
  return queue;
}
