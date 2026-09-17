/**
 * `packages/web/test/setup.tsx` — the `web` vitest project's setup file (TESTING.md §2.1 L101,
 * §2.2 L108-122).
 *
 * jsdom is a DOM, not a browser: it does not lay out, does not animate, and ships none of the
 * observer APIs the terminal UI uses. This file installs the four shims the design names —
 * `matchMedia`, `ResizeObserver`, a canvas 2-D context (from the `canvas` package when it built,
 * skipped when it did not), and a **manual frame pump** — and registers React Testing Library's
 * `cleanup` after every test.
 *
 * The frame pump is the only timing source a web test may use (TESTING §2.2 L115-119):
 * `requestAnimationFrame` queues a callback instead of scheduling one, and `flushFrames(n)` runs
 * `n` frames, recording the synchronous duration of each via `performance.now()`. No web test waits
 * on `setTimeout`.
 */
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

import '@testing-library/jest-dom/vitest';

// ── matchMedia (jsdom has none) ───────────────────────────────────────────────────────────────
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    addListener: (): void => undefined,
    removeListener: (): void => undefined,
    dispatchEvent: (): boolean => false,
  });
}

// ── ResizeObserver (jsdom has none; the grid and the chart both observe their container) ───────
class TestResizeObserver implements ResizeObserver {
  observe(): void {
    /* jsdom never resizes: a test drives layout explicitly. */
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.ResizeObserver ??= TestResizeObserver;
globals.IntersectionObserver ??= class {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds: readonly number[] = [];
  observe(): void {
    /* no-op */
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
  takeRecords(): [] {
    return [];
  }
};

// ── The manual frame pump ─────────────────────────────────────────────────────────────────────

type FrameCallback = (time: number) => void;

let frameQueue: { handle: number; fn: FrameCallback }[] = [];
let nextHandle = 1;

/** Duration in milliseconds of every frame `flushFrames` has run since the last test started. */
export const frameDurations: number[] = [];

window.requestAnimationFrame = (fn: FrameCallback): number => {
  const handle = nextHandle++;
  frameQueue.push({ handle, fn });
  return handle;
};

window.cancelAnimationFrame = (handle: number): void => {
  frameQueue = frameQueue.filter((entry) => entry.handle !== handle);
};

/**
 * Run `count` animation frames. Callbacks queued *during* a frame run in the next one, exactly as a
 * browser would, and each frame's synchronous duration is appended to `frameDurations`.
 *
 * @returns the durations of the frames this call ran, in order.
 */
export function flushFrames(count = 1): number[] {
  const ran: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const due = frameQueue;
    frameQueue = [];
    if (due.length === 0) break;
    const startedAt = performance.now();
    for (const entry of due) entry.fn(startedAt);
    const elapsed = performance.now() - startedAt;
    frameDurations.push(elapsed);
    ran.push(elapsed);
  }
  return ran;
}

/** Frames queued but not yet run. */
export function pendingFrames(): number {
  return frameQueue.length;
}

beforeEach(() => {
  frameQueue = [];
  frameDurations.length = 0;
});

afterEach(() => {
  cleanup();
  frameQueue = [];
});
