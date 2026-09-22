/**
 * `ingest/jobs/cboeEuIndices.ts` — European index quotes for WEI (PROVIDERS §5.4, §13).
 *
 * The job ARCHITECTURE §7.1 does not have: §5.4 records it as an addition, because the European
 * endpoint's three timestamp rules differ from §5.1's enough to need their own adapter, and an
 * adapter with no job never runs. The target set is the WEI seed — the `cboe.euIndices` md lines
 * the always-on set holds (`BUK100P`, the Cboe UK 100) — and the cadence is 60 s inside the XLON
 * session, 15 min outside it.
 *
 * Two things happen here that `cboeQuotes` does not do:
 *
 *  - **`data.symbol` is minted as an identifier.** The payload carries both `data.index`
 *    (`BUK100P`, the join key to `indices.code` and to `md_lines.provider_symbol`) and
 *    `data.symbol` (`^BUK100P-SL`, the provider's own display form). The parser emits the latter as
 *    an `identifiers` row of scheme `PROVIDER_SYMBOL`, qualifier `cboe.euIndices`; the job writes it
 *    through `upsertIfValid`, so the second run writes no version at all.
 *  - **`data.status` is checked against the calendar.** `C`/`O`/`H` is a hint; XLON stays
 *    authoritative (§5.4), so a disagreement is a `dq_events` row of kind `poll_anomaly` and the
 *    quote is still published — the letter is the provider's opinion about a session, not a reason
 *    to blank WEI.
 *
 * The staleness tier is the same 15-minute delayed tier as every other Cboe source, read from
 * `licence_registry` by `lineTier` (see `cboeQuotes.ts`), never from a literal here.
 */

import { sql } from 'drizzle-orm';

import {
  cboeEuIndexUrl,
  cboeEuIndicesAdapter,
  CBOE_ADAPTER_VERSION,
} from '../../providers/cboe/adapter.js';
import { normaliseEuIndex } from '../../providers/cboe/parse.js';
import { identifierRepository } from '../../refdata/identifiers.js';
import {
  emptyResult,
  fetchError,
  fetchThrough,
  insertQuoteTicks,
  linesOf,
  normaliseWithProvenance,
  publish,
  requestEnvelope,
  resolveTargets,
  sessionAt,
  tally,
  withIngestRun,
} from './cboeQuotes.js';

import type { SessionState } from '@terminal/core';
import type { Tx } from '../../db/client.js';
import type { CboeEuIndexStatus, CboeIdentifierRow } from '../../providers/cboe/parse.js';
import type { ProviderId, RawRecord } from '../../providers/types.js';
import type { MarketJobContext, MarketJobResult } from './cboeQuotes.js';

export const CBOE_EU_SOURCE_ID = 'cboe.euIndices' satisfies ProviderId;

/** §13: `{everyMs: 60000, marketHoursOnly: true, offHoursEveryMs: 900000}`. */
export const CBOE_EU_SCHEDULE = {
  everyMs: 60_000,
  marketHoursOnly: true,
  offHoursEveryMs: 900_000,
} as const;

/** §5.4 — the calendar that remains authoritative over `data.status`. */
export const XLON_CALENDAR = 'XLON';

/**
 * Write the `identifiers` rows the parser minted for the provider's display symbol.
 *
 * `upsertIfValid` rather than `write`: a `PROVIDER_SYMBOL` that already says exactly this writes no
 * version and returns `versionId: null`, which is what makes the 60-second poll free. A rejected
 * value (a blank symbol, say) is an outcome, not an exception — it is counted and reported, and the
 * quote it came with is still published.
 *
 * @returns the number of identifier versions actually written.
 */
export async function writeEuIdentifiers(
  tx: Tx,
  rows: readonly CboeIdentifierRow[],
  args: { provenanceId: number; validFrom: Date },
): Promise<{ written: number; rejected: number }> {
  const repo = identifierRepository(tx);
  let written = 0;
  let rejected = 0;
  for (const row of rows) {
    const result = await repo.upsertIfValid(
      {
        entityKind: row.entityKind,
        entityId: row.entityId,
        scheme: row.scheme,
        value: row.value,
        qualifier: row.qualifier,
        isPrimary: row.isPrimary,
      },
      { validFrom: args.validFrom, provenanceId: args.provenanceId },
    );
    if (!result.ok) rejected += 1;
    else if (result.versionId !== null) written += 1;
  }
  return { written, rejected };
}

/**
 * §5.4: `data.status` is a hint and the XLON calendar is authoritative. A disagreement is recorded
 * once per `(index, capture instant)` and never suppresses the quote.
 *
 * @returns `1` when a `dq_events` row was written, `0` when one already existed or the two agree.
 */
export async function checkEuSession(
  tx: Tx,
  args: {
    status: CboeEuIndexStatus;
    calendarSession: SessionState | undefined;
    providerSymbol: string;
    instrumentId: number;
    capturedAt: number;
  },
): Promise<number> {
  const claimed = args.status.session;
  const actual = args.calendarSession;
  if (claimed === null || actual === undefined || claimed === actual) return 0;

  const key = `${CBOE_EU_SOURCE_ID}:${args.providerSymbol}:${new Date(args.capturedAt).toISOString()}`;
  const details = {
    key,
    statusCode: args.status.code,
    claimed,
    calendar: actual,
    calendarId: XLON_CALENDAR,
    payloadTime: args.status.payloadTime,
    skewMs: args.status.skewMs,
  };
  const res = await tx.execute<{ dq_id: string }>(sql`
    INSERT INTO dq_events (kind, severity, instrument_id, source_id, subject, details)
    SELECT 'poll_anomaly', 'warn', ${args.instrumentId}::bigint, ${CBOE_EU_SOURCE_ID},
           ${`q:${String(args.instrumentId)}`}, ${JSON.stringify(details)}::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM dq_events
        WHERE kind = 'poll_anomaly'
          AND source_id = ${CBOE_EU_SOURCE_ID}
          AND details ->> 'key' = ${key})
    RETURNING dq_id`);
  return res.rows.length;
}

/** Poll the WEI seed through `cboe.euIndices` (§5.4). One request per index code. */
export async function runCboeEuIndices(ctx: MarketJobContext): Promise<MarketJobResult> {
  return withIngestRun(ctx, { id: 'cboeEuIndices', sourceId: CBOE_EU_SOURCE_ID }, async () => {
    const result = emptyResult();
    const targets = await resolveTargets(ctx, CBOE_EU_SOURCE_ID);
    if (targets.length === 0) {
      ctx.log?.info?.('cboeEuIndices.no_targets', { sourceId: CBOE_EU_SOURCE_ID });
      return result;
    }

    const lines = linesOf(targets);
    const calendarSession = sessionAt(ctx.clock.now(), XLON_CALENDAR);

    for (const target of targets) {
      const url = cboeEuIndexUrl(target.providerSymbol);
      let raw: RawRecord;
      try {
        raw = await fetchThrough(
          ctx,
          cboeEuIndicesAdapter,
          { indexCode: target.providerSymbol, ...requestEnvelope(ctx) },
          url,
        );
      } catch (err) {
        result.errors.push(fetchError(err, url));
        continue;
      }
      if (raw.status === 304) {
        result.skipped += 1;
        continue;
      }
      result.fetched += 1;

      const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
        raw,
        adapterVersion: CBOE_ADAPTER_VERSION,
        lines,
        // `normaliseEuIndex` directly rather than `adapter.normalise`: §5.4 publishes
        // `PX_OFFICIAL_CLOSE` only after the XLON close, and only the job knows the calendar.
        normalise: (r, nctx) =>
          normaliseEuIndex(r, nctx, {
            sourceId: CBOE_EU_SOURCE_ID,
            ...(calendarSession === undefined ? {} : { session: calendarSession }),
          }),
      });
      result.provenanceIds.push(provenanceId);
      result.problems.push(...norm.problems);

      result.published += publish(ctx, norm.updates, result.errors);
      tally(result, await insertQuoteTicks(ctx.tx, norm.rows.quoteTicks, provenanceId));

      const ids = await writeEuIdentifiers(ctx.tx, norm.rows.identifiers, {
        provenanceId,
        validFrom: new Date(raw.capturedAt),
      });
      result.inserted += ids.written;
      if (ids.rejected > 0) {
        result.problems.push({
          kind: 'field_dropped',
          detail: `${String(ids.rejected)} provider symbol(s) from ${target.providerSymbol} failed identifier validation`,
        });
      }

      await checkEuSession(ctx.tx, {
        status: norm.rows.status,
        calendarSession,
        providerSymbol: target.providerSymbol,
        instrumentId: target.instrumentId,
        capturedAt: raw.capturedAt,
      });
    }

    ctx.log?.info?.('cboeEuIndices.done', {
      targets: targets.length,
      fetched: result.fetched,
      inserted: result.inserted,
      calendarSession: calendarSession ?? 'unstated',
    });
    return result;
  });
}

/** The scheduler row (PROVIDERS §13). */
export const job = {
  id: 'cboeEuIndices',
  schedule: CBOE_EU_SCHEDULE,
  provider: CBOE_EU_SOURCE_ID,
  priority: 1 as const,
  timeoutMs: 10_000,
  run: (ctx: MarketJobContext): Promise<MarketJobResult> => runCboeEuIndices(ctx),
};
