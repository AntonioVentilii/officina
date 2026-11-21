/**
 * Runs `fn` at most once per `ms`, trailing, so bursts of events cost one request, and never while
 * its last run is still going: a call meanwhile runs it once more after that one ends. Each run
 * lets the loads it starts through `latestOnly` land; without the wait, events closer together
 * than a load takes (a running agent's log streams one per line) would start a newer load before
 * each answer came, and none would ever be shown.
 */
export const coalesce = (fn: () => unknown, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  const run = async () => {
    running = true;
    try {
      await fn();
    } finally {
      running = false;
      if (again) {
        again = false;
        soon();
      }
    }
  };
  const soon = () => {
    if (running) {
      again = true;
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, ms);
  };
  return soon;
};
