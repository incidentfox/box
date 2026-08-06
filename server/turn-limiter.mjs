export function normalizeTurnLimit(value, fallback = 3) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createTurnLimiter(limit) {
  const max = normalizeTurnLimit(limit);
  let active = 0;
  const waiters = [];

  function acquire() {
    return new Promise((resolve) => {
      const grant = () => {
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
      else waiters.push(grant);
    });
  }

  return {
    acquire,
    get active() { return active; },
    get queued() { return waiters.length; },
    get limit() { return max; },
  };
}
