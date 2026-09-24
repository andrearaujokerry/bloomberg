// packages/web/src/state/usage.ts — the client's own telemetry, batched (FUNCTIONS §1.10).
//
// CLIENT.md §8 L610-611, API.md §5.13. `fn.launch`, `search.select`, `cmd.parse_error`,
// `panel.switch`, `ticket.open` and the rest are enqueued by whoever causes them and posted to
// `POST /usage/events` every 5 s, at 100 events, or on `pagehide` — whichever comes first. The
// route is rate-limited to 1 req/s and capped at 100 events per body (API.md §5.13, §8).
//
// Two properties this file is responsible for, both invisible until they are wrong:
//
//   * **A failed post does not lose the events.** They go back at the FRONT of the queue, because
//     order is what makes `fn.launch` → `fn.param` → `fn.export` readable as one user's session.
//     The queue is bounded, and when it overflows the OLDEST events go — a client that has been
//     offline for an hour should report the last minute, not the first.
//   * **Telemetry never blocks the user.** Nothing here is awaited on the keystroke path, no error
//     is surfaced, and a flush already in flight is not started twice.
//
// The timer and the clock are the same injected `Scheduler` the workspace store takes, so a test
// drives the 5 s cadence without waiting on wall time (TESTING §2.2).
import type { UsageEvent } from '@terminal/sdk/wire/rest/usage';
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

import type { Scheduler } from './workspace.js';

/** The slice of `TerminalClient['usage']` this store calls. */
export interface UsageApi {
  events(args: { body: { events: UsageEvent[] } }): Promise<void>;
}

/** What a caller supplies; `ts` is stamped here and `details` defaults to `{}` (API.md §5.13). */
export type UsageEventInput = Omit<UsageEvent, 'ts' | 'details'> & {
  details?: Record<string, unknown>;
};

/** API.md §5.13: "batched every 5 s". */
export const FLUSH_INTERVAL_MS = 5_000;
/** `events: z.array(UsageEvent).max(100)` — one body may not carry more. */
export const BATCH_MAX = 100;
/** How much backlog an offline client keeps before dropping its oldest events. */
export const QUEUE_MAX = 500;

const defaultScheduler: Scheduler = {
  setTimer: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimer: (handle) => {
    globalThis.clearTimeout(handle);
  },
  now: () => Date.now(),
};

export interface UsageStore {
  queue: UsageEvent[];
  /** Events dropped because the backlog outgrew `QUEUE_MAX` — reported, never silent. */
  dropped: number;
  lastFlushedAt: number | null;
  lastError: { code: string; message: string } | null;
  running: boolean;

  configure(opts: { api?: UsageApi | null; scheduler?: Scheduler }): void;
  push(event: UsageEventInput): void;
  flush(): Promise<void>;
  /** Start the 5 s cadence (the shell mounts, `bootstrap/client.ts` has the api). */
  start(): void;
  stop(): void;
  reset(): void;
}

let api: UsageApi | null = null;
let scheduler: Scheduler = defaultScheduler;
let timer: number | null = null;
let inFlight = false;

function errorOf(err: unknown): { code: string; message: string } {
  if (typeof err === 'object' && err !== null) {
    const bag = err as { code?: unknown; message?: unknown };
    return {
      code: typeof bag.code === 'string' ? bag.code : 'UNKNOWN',
      message: typeof bag.message === 'string' ? bag.message : 'unknown error',
    };
  }
  return { code: 'UNKNOWN', message: typeof err === 'string' ? err : 'unknown error' };
}

export const useUsageStore = create<UsageStore>()(
  subscribeWithSelector((set, get) => {
    const schedule = (): void => {
      if (!get().running) return;
      if (timer !== null) scheduler.clearTimer(timer);
      timer = scheduler.setTimer(() => {
        // Re-arm BEFORE flushing, not in the flush's `finally`: the cadence is 5 s of wall clock,
        // not 5 s after whatever the last POST took, and a chain that re-arms itself only once the
        // request settles stops entirely the moment one request hangs.
        timer = null;
        schedule();
        void get().flush();
      }, FLUSH_INTERVAL_MS);
    };

    return {
      queue: [],
      dropped: 0,
      lastFlushedAt: null,
      lastError: null,
      running: false,

      configure(opts) {
        if (opts.api !== undefined) api = opts.api;
        if (opts.scheduler !== undefined) {
          if (timer !== null) {
            scheduler.clearTimer(timer);
            timer = null;
          }
          scheduler = opts.scheduler;
          if (get().running) schedule();
        }
      },

      push(event) {
        const stamped: UsageEvent = {
          ...event,
          details: event.details ?? {},
          ts: new Date(scheduler.now()).toISOString(),
        };
        const queue = [...get().queue, stamped];
        let dropped = get().dropped;
        if (queue.length > QUEUE_MAX) {
          dropped += queue.length - QUEUE_MAX;
          queue.splice(0, queue.length - QUEUE_MAX);
        }
        set({ queue, dropped });
        // A full batch does not wait for the next tick.
        if (queue.length >= BATCH_MAX) void get().flush();
      },

      async flush() {
        const client = api;
        if (client === null || inFlight) return;
        const batch = get().queue.slice(0, BATCH_MAX);
        if (batch.length === 0) return;
        inFlight = true;
        set({ queue: get().queue.slice(batch.length) });
        try {
          await client.events({ body: { events: batch } });
          set({ lastFlushedAt: scheduler.now(), lastError: null });
        } catch (err) {
          // Back at the front, oldest-first order intact. Overflow drops from the front, the same
          // rule `push` uses: a client that has been failing for an hour reports the last minute.
          const queue = [...batch, ...get().queue];
          let dropped = get().dropped;
          if (queue.length > QUEUE_MAX) {
            dropped += queue.length - QUEUE_MAX;
            queue.splice(0, queue.length - QUEUE_MAX);
          }
          set({ queue, dropped, lastError: errorOf(err) });
        } finally {
          inFlight = false;
        }
      },

      start() {
        if (get().running) return;
        set({ running: true });
        schedule();
      },

      stop() {
        if (timer !== null) {
          scheduler.clearTimer(timer);
          timer = null;
        }
        set({ running: false });
      },

      reset() {
        if (timer !== null) {
          scheduler.clearTimer(timer);
          timer = null;
        }
        api = null;
        scheduler = defaultScheduler;
        inFlight = false;
        set({ queue: [], dropped: 0, lastFlushedAt: null, lastError: null, running: false });
      },
    };
  }),
);

/* ---------------------------------------------------------------------------------------------- */
/* Selectors                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

export const selectPending = (s: UsageStore): number => s.queue.length;
export const selectLastError = (s: UsageStore): UsageStore['lastError'] => s.lastError;
