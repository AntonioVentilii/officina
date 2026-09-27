/** One shared clock for "3m ago" labels, ticking often enough for minutes and seconds of runs. */
class Clock {
  now = $state(Date.now());

  constructor() {
    setInterval(() => (this.now = Date.now()), 1000);
  }
}

export const clock = new Clock();
