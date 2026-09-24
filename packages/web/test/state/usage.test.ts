/**
 * packages/web/test/state/usage.test.ts — FUNCTIONS §1.10, API.md §5.13, CLIENT.md §8 L610-611.
 *
 * Telemetry is the one subsystem allowed to fail quietly, which is exactly why it needs tests: a
 * batch that is lost on a transient 503, or an order scrambled by a retry, is invisible until
 * somebody asks the usage tables a question they cannot answer.
 *
 * The 5 s cadence is driven through the injected scheduler; nothing here waits on wall time.
 */
import type { UsageEvent } from '@terminal/sdk/wire/rest/usage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BATCH_MAX,
  FLUSH_INTERVAL_MS,
  QUEUE_MAX,
  selectPending,
  useUsageStore,
} from '../../src/state/usage.js';
import type { Scheduler } from '../../src/state/workspace.js';

function clock(): { scheduler: Scheduler; advance(ms: number): void } {
  let now = 1_758_000_000_000; // 2025-09-16T05:20:00Z — a real epoch, so `ts` is a real ISO string
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    scheduler: {
      setTimer: (fn, ms) => {
        const handle = next++;
        timers.set(handle, { at: now + ms, fn });
        return handle;
      },
      clearTimer: (handle) => {
        timers.delete(handle);
      },
      now: () => now,
    },
    advance(ms) {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(handle);
          timer.fn();
        }
      }
    },
  };
}

let time: ReturnType<typeof clock>;

beforeEach(() => {
  useUsageStore.getState().reset();
  time = clock();
  useUsageStore.getState().configure({ scheduler: time.scheduler });
});

const launch = (code: string): Parameters<ReturnType<typeof useUsageStore.getState>['push']>[0] => ({
  kind: 'fn.launch',
  code,
  panelId: 'p1',
});

describe('usageStore', () => {
  it('stamps each event and posts the batch on the 5 s tick', async () => {
    const events = vi.fn().mockResolvedValue(undefined);
    useUsageStore.getState().configure({ api: { events } });
    useUsageStore.getState().start();

    useUsageStore.getState().push(launch('DES'));
    useUsageStore.getState().push({ kind: 'search.select', details: { rank: 0 } });
    expect(events).not.toHaveBeenCalled();
    expect(selectPending(useUsageStore.getState())).toBe(2);

    time.advance(FLUSH_INTERVAL_MS);
    await vi.waitFor(() => {
      expect(events).toHaveBeenCalledTimes(1);
    });

    const sent = events.mock.calls[0]?.[0].body.events as UsageEvent[];
    expect(sent.map((e) => e.kind)).toEqual(['fn.launch', 'search.select']);
    expect(sent[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // `details` defaults to {} — the wire schema requires it (API.md §5.13).
    expect(sent[0]?.details).toEqual({});
    expect(sent[1]?.details).toEqual({ rank: 0 });
    expect(selectPending(useUsageStore.getState())).toBe(0);

    useUsageStore.getState().stop();
  });

  it('keeps flushing on every tick while it is running', async () => {
    const events = vi.fn().mockResolvedValue(undefined);
    useUsageStore.getState().configure({ api: { events } });
    useUsageStore.getState().start();

    useUsageStore.getState().push(launch('DES'));
    time.advance(FLUSH_INTERVAL_MS);
    await vi.waitFor(() => {
      expect(events).toHaveBeenCalledTimes(1);
    });

    useUsageStore.getState().push(launch('GP'));
    time.advance(FLUSH_INTERVAL_MS);
    await vi.waitFor(() => {
      expect(events).toHaveBeenCalledTimes(2);
    });
    useUsageStore.getState().stop();
  });

  it('does not wait for the tick once a full batch has accumulated', async () => {
    const events = vi.fn().mockResolvedValue(undefined);
    useUsageStore.getState().configure({ api: { events } });

    for (let i = 0; i < BATCH_MAX; i += 1) useUsageStore.getState().push(launch(`F${String(i)}`));

    await vi.waitFor(() => {
      expect(events).toHaveBeenCalledTimes(1);
    });
    expect((events.mock.calls[0]?.[0].body.events as UsageEvent[]).length).toBe(BATCH_MAX);
  });

  it('puts a failed batch back at the front, in order', async () => {
    const events = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('unreachable'), { code: 'UPSTREAM_UNAVAILABLE' }))
      .mockResolvedValueOnce(undefined);
    useUsageStore.getState().configure({ api: { events } });

    useUsageStore.getState().push(launch('DES'));
    useUsageStore.getState().push(launch('GP'));
    await useUsageStore.getState().flush();

    expect(useUsageStore.getState().lastError?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(selectPending(useUsageStore.getState())).toBe(2);

    // A later event queues behind them; the retry sends the original two first.
    useUsageStore.getState().push(launch('HP'));
    await useUsageStore.getState().flush();

    const sent = events.mock.calls[1]?.[0].body.events as UsageEvent[];
    expect(sent.map((e) => e.code)).toEqual(['DES', 'GP', 'HP']);
    expect(useUsageStore.getState().lastError).toBeNull();
    expect(selectPending(useUsageStore.getState())).toBe(0);
  });

  it('bounds the backlog by dropping the oldest, and counts what it dropped', () => {
    useUsageStore.getState().configure({ api: null });
    for (let i = 0; i < QUEUE_MAX + 10; i += 1) useUsageStore.getState().push(launch(`F${String(i)}`));

    expect(selectPending(useUsageStore.getState())).toBe(QUEUE_MAX);
    expect(useUsageStore.getState().dropped).toBe(10);
    // The events kept are the most recent ones.
    expect(useUsageStore.getState().queue[0]?.code).toBe('F10');
  });

  it('is a no-op with no api attached, and never rejects', async () => {
    useUsageStore.getState().push(launch('DES'));
    await expect(useUsageStore.getState().flush()).resolves.toBeUndefined();
    expect(selectPending(useUsageStore.getState())).toBe(1);
  });
});
