/**
 * The only source of "now" anywhere in the system (ARCHITECTURE L49, L123).
 *
 * Every module that needs the time takes a `Clock`; nothing in `packages/core` may read the
 * platform clock directly (`Date` and `performance` are banned globals in the core ESLint zone).
 * `SystemClock` is the single adapter over the platform clock; `VirtualClock` is what tests and the
 * replay harness drive.
 */

/** Epoch milliseconds, UTC. */
export interface Clock {
  now(): number;
}

/** The one place in `packages/core` that is allowed to read the platform clock. */
export class SystemClock implements Clock {
  now(): number {
    // SystemClock IS the adapter over the platform clock; every other module in packages/core
    // injects a Clock instead, which is what the banned-global rule protects (ARCHITECTURE L49).
    // eslint-disable-next-line no-restricted-globals, no-restricted-properties
    return Date.now();
  }
}

/**
 * A clock that only moves when a test moves it. Deterministic by construction: no timers, no
 * platform clock, no wall-clock drift, so a replayed plant session produces byte-identical output.
 */
export class VirtualClock implements Clock {
  #t: number;

  /** @param startMs epoch ms the clock starts at (default 0). */
  constructor(startMs = 0) {
    if (!Number.isFinite(startMs)) throw new RangeError('VirtualClock: startMs must be finite');
    this.#t = startMs;
  }

  now(): number {
    return this.#t;
  }

  /** Move the clock forward by `ms`. Time never runs backwards. */
  advance(ms: number): void {
    if (!Number.isFinite(ms)) throw new RangeError('VirtualClock: ms must be finite');
    if (ms < 0) throw new RangeError('VirtualClock: cannot advance by a negative duration');
    this.#t += ms;
  }

  /** Jump to an absolute epoch-ms instant. Must not be earlier than the current instant. */
  advanceTo(epochMs: number): void {
    if (!Number.isFinite(epochMs)) throw new RangeError('VirtualClock: epochMs must be finite');
    if (epochMs < this.#t) throw new RangeError('VirtualClock: cannot move time backwards');
    this.#t = epochMs;
  }

  /**
   * Reset the clock to an arbitrary instant, including one in the past. Only for test setup
   * between cases; use `advance`/`advanceTo` inside a case.
   */
  set(epochMs: number): void {
    if (!Number.isFinite(epochMs)) throw new RangeError('VirtualClock: epochMs must be finite');
    this.#t = epochMs;
  }
}
