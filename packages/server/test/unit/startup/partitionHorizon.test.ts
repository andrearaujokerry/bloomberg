/**
 * `startup.ts#extendPartitionHorizon` — the startup half of DATA_MODEL §16's "keep the horizon
 * ahead", with the DDL injected. The DDL itself (`db/partitions.ts#ensurePartitions`) is covered
 * against a real database by `test/integration/ingest/partitions.test.ts`; this pins what the step
 * does with its answer, and that it refuses to guess when there is no maintenance connection.
 */

import { describe, expect, it, vi } from 'vitest';

import type { EnsurePartitionsResult } from '../../../src/db/partitions.js';
import { extendPartitionHorizon } from '../../../src/startup.js';

function result(
  table: EnsurePartitionsResult['table'],
  created: string[],
  blocked: string[] = [],
): EnsurePartitionsResult {
  return {
    table,
    created,
    existing: [],
    movedRows: 0,
    blocked: blocked.map((partition) => ({
      partition,
      lo: '',
      hi: '',
      rowsInDefault: 1,
      reason: 'worm_default_rows' as const,
    })),
    defaultRowsRemaining: blocked.length,
    dqId: null,
    deadlockRetries: 0,
  };
}

describe('extendPartitionHorizon', () => {
  it('skips — and says why — when there is no maintenance connection, without touching anything', async () => {
    const ensureAll = vi.fn(() => Promise.resolve([]));
    const report = await extendPartitionHorizon({ maintConfigured: false, ensureAll });
    expect(report.ran).toBe(false);
    expect(report.skipped).toMatch(/DATABASE_URL_MAINT/);
    expect(ensureAll).not.toHaveBeenCalled();
  });

  it('runs every plan once and names what it created, table first', async () => {
    const ensureAll = vi.fn(() =>
      Promise.resolve([
        result('access_log', ['access_log_m2026_12']),
        result('usage_events', ['usage_events_m2026_12']),
        result('bars_daily', []),
      ]),
    );
    const report = await extendPartitionHorizon({ maintConfigured: true, ensureAll });
    expect(ensureAll).toHaveBeenCalledOnce();
    expect(report).toEqual({
      ran: true,
      skipped: null,
      created: ['access_log.access_log_m2026_12', 'usage_events.usage_events_m2026_12'],
      blocked: [],
    });
  });

  it('reports a range stuck behind rows in an append-only default partition', async () => {
    const report = await extendPartitionHorizon({
      maintConfigured: true,
      ensureAll: () => Promise.resolve([result('access_log', [], ['access_log_m2026_12'])]),
    });
    expect(report.blocked).toEqual(['access_log.access_log_m2026_12']);
  });

  it('lets a failure through, for index.ts to log without stopping the server', async () => {
    await expect(
      extendPartitionHorizon({
        maintConfigured: true,
        ensureAll: () => Promise.reject(new Error('permission denied for schema public')),
      }),
    ).rejects.toThrow('permission denied');
  });
});
