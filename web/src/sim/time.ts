export const JD_UNIX_EPOCH = 2440587.5;
export const MS_PER_DAY = 86_400_000;

export const msToJd = (ms: number) => ms / MS_PER_DAY + JD_UNIX_EPOCH;
export const jdToMs = (jd: number) => (jd - JD_UNIX_EPOCH) * MS_PER_DAY;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function formatUtc(ms: number, withDate = true): string {
  const d = new Date(ms);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return withDate ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${time}` : time;
}

/** Simulation clock. Time is kept as Unix milliseconds (exact in float64). */
export class SimClock {
  timeMs: number;
  rate = 1;
  paused = false;
  /** Bumped on every discontinuity so caches keyed on time can invalidate. */
  generation = 0;

  constructor(startMs = Date.now()) {
    this.timeMs = startMs;
  }

  tick(realDtMs: number) {
    if (!this.paused) this.timeMs += realDtMs * this.rate;
  }

  jump(ms: number) {
    this.timeMs = ms;
    this.generation++;
  }

  get jd() {
    return msToJd(this.timeMs);
  }
}
