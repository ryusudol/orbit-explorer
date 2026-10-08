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

/**
 * Simulation clock. Time is kept as Unix milliseconds (exact in float64).
 *
 * Sim time is measured from a wall-clock anchor, never summed from frame
 * deltas: the browser stops animation frames while the tab is hidden or the
 * window is covered, and a summed clock would silently lose that time.
 */
export class SimClock {
  /** Sim time at the last tick, so everything drawn in one frame agrees. */
  timeMs: number;
  /** Bumped on every discontinuity so caches keyed on time can invalidate. */
  generation = 0;
  private _rate = 1;
  private _paused = false;
  private baseSim: number;
  /** performance.now() at the anchor: smooth and sub-millisecond */
  private basePerf = 0;
  /** Date.now() at the anchor: keeps counting while the machine sleeps */
  private baseWall = 0;

  constructor(startMs = Date.now()) {
    this.timeMs = this.baseSim = startMs;
    this.rebase(startMs);
  }

  get rate() {
    return this._rate;
  }
  set rate(r: number) {
    if (r === this._rate) return;
    this.rebase(this.now());
    this._rate = r;
  }

  get paused() {
    return this._paused;
  }
  set paused(p: boolean) {
    if (p === this._paused) return;
    this.rebase(this.now());
    this._paused = p;
  }

  /** Advance to the present instant. Call once per frame. */
  tick() {
    this.timeMs = this.now();
  }

  jump(ms: number) {
    this.rebase(ms);
    this.generation++;
  }

  get jd() {
    return msToJd(this.timeMs);
  }

  private now(): number {
    if (this._paused) return this.baseSim;
    const perf = performance.now(), wall = Date.now();
    let elapsed = perf - this.basePerf;
    if (Math.abs(wall - this.baseWall - elapsed) > 1000) {
      // the monotonic clock stops during system sleep: follow the wall clock
      elapsed = wall - this.baseWall;
      this.basePerf = perf - elapsed;
    }
    return this.baseSim + elapsed * this._rate;
  }

  private rebase(simMs: number) {
    this.timeMs = this.baseSim = simMs;
    this.basePerf = performance.now();
    this.baseWall = Date.now();
  }
}
