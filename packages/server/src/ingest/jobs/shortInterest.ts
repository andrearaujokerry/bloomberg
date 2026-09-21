/**
 * `ingest/jobs/shortInterest.ts` — FINRA consolidated short interest (PROVIDERS §12).
 *
 * FINRA publishes two settlement dates a month (the 15th and the month end), roughly eight
 * business days in arrears. The job walks `?limit=1000&offset=n` until a short page, resolves each
 * `symbolCode` through `identifiers(TICKER_EXCH, …, 'US')`, and upserts `short_interest` on its
 * natural key `(instrument_id, settlement_date)` — a revision *overwrites* the row for that date,
 * which is the intended semantics: FINRA republishes corrected figures under the same date.
 *
 * Three published numbers are recomputed rather than trusted, because a vendor-computed field that
 * nobody checks is a field that silently rots (PROVIDERS §14 `reconcile_mismatch`):
 *
 *  - `daysToCoverQuantity` against `short_qty / avg_daily_volume` — divergence over 1 %;
 *  - `changePreviousNumber` against `current − previous` — any disagreement;
 *  - `changePercent` against the same pair, as a percentage.
 *
 * A `daysToCoverQuantity` above 100 is dropped and the quantities kept — `out_of_range` is a
 * `NormaliseProblem` kind, not a `dq_events` kind, so it is reported on the result and in the
 * dropped-field count rather than forced into a CHECK constraint it does not belong in.
 *
 * **Note on the fixture.** `finra-trace` is named after TRACE but its columns are consolidated
 * short interest (FIXTURES.md), and it holds a single smoke row. PROVIDERS §12's "fewer than
 * 5 000 rows across the whole walk → `poll_anomaly`, nothing written" floor would therefore reject
 * it, so the floor is a request option with the documented default — a replay harness lowers it,
 * production never does.
 *
 * The RFC 4180 reader and the row shape belong in WP-05's `providers/finra/parse.ts`; they live
 * here, exported, until that lands.
 */

import { and, eq, sql } from 'drizzle-orm';

import { shortInterest } from '../../db/schema/timeseries.js';
import { identifiers, instruments, listings } from '../../db/schema/reference.js';
import { insertProvenance } from '../../providers/provenance.js';
import { asOf } from '../../db/bitemporal.js';
import { btIdentifiers } from '../../refdata/identifiers.js';
import { btInstruments, btListings } from '../../refdata/master.js';
import { fetchRaw, provenanceMeta, recordDqEvent } from './secNport.js';

import type { Tx } from '../../db/client.js';
import type { AsOf } from '../../db/bitemporal.js';
import type { ProviderId } from '../../providers/types.js';
import type { JobResult, RefIngestContext, UpsertCounts } from './secNport.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// RFC 4180
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A CSV reader: quoted fields, `""` as an escaped quote inside one, `\r\n` or `\n` as the record
 * separator, and a trailing newline that does not produce an empty record.
 *
 * Deliberately not `split(',')`: `issueName` is `Agilent Technologies Inc.` today and will be
 * `Smith, Kline & Co.` the day a comma appears in an issuer name.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.length === 0) {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === ',') {
      endField();
      started = true;
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      endRow();
      continue;
    }
    field += ch;
    started = true;
  }
  if (started || field.length > 0 || row.length > 0) endRow();
  return rows;
}

/** A CSV with a header row → objects keyed by the published column names. */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  const header = rows[0];
  if (header === undefined) return [];
  const out: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.length === 1 && row[0] === '') continue;
    const record: Record<string, string> = {};
    header.forEach((name, column) => {
      record[name] = row[column] ?? '';
    });
    out.push(record);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// FINRA
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const FINRA_SOURCE_ID = 'finra.shortInterest' satisfies ProviderId;
export const FINRA_ADAPTER_VERSION = 'finra/1.0.0';

export const FINRA_BASE_URL =
  'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest';

/** One page of the walk. `limit=1000`, capped at 20 pages (PROVIDERS §12). */
export const FINRA_PAGE_SIZE = 1000;
export const FINRA_MAX_PAGES = 20;

/** PROVIDERS §12: fewer than this across the whole walk means a truncated feed. */
export const FINRA_MIN_ROWS = 5000;

/** Above this the published `daysToCoverQuantity` is nonsense; the field is dropped. */
export const MAX_DAYS_TO_COVER = 100;

/** Recomputed vs published: more than this is a `reconcile_mismatch`. */
export const DAYS_TO_COVER_TOLERANCE = 0.01;

export function finraPageUrl(offset: number, limit = FINRA_PAGE_SIZE): string {
  return `${FINRA_BASE_URL}?limit=${String(limit)}&offset=${String(offset)}`;
}

/** One CSV record, typed. Numbers are `null` when the column is blank — never `0`. */
export interface FinraShortInterestRow {
  symbolCode: string;
  issueName: string;
  /** `'NYSE'`, `'NASDAQ'`, … — cross-checked against `listings.mic`. */
  marketClassCode: string | null;
  /** The **settlement** date, not the publication date. */
  settlementDate: string;
  shortQty: number | null;
  prevShortQty: number | null;
  avgDailyVolume: number | null;
  /** As published; `null` once dropped for being above {@link MAX_DAYS_TO_COVER}. */
  daysToCover: number | null;
  changePct: number | null;
  /** Dropped (no column), but asserted equal to `current − previous`. */
  changePreviousNumber: number | null;
  revision: boolean;
  /** A split makes the change figures incomparable; surfaced in `dq_events.details`. */
  stockSplit: boolean;
}

export interface FinraProblem {
  kind: 'parse_error' | 'out_of_range' | 'field_dropped' | 'schema_drift' | 'unknown_symbol';
  detail: string;
  symbolCode?: string;
}

export interface FinraParse {
  rows: FinraShortInterestRow[];
  problems: FinraProblem[];
}

const REQUIRED_COLUMNS = ['symbolCode', 'settlementDate', 'currentShortPositionQuantity'] as const;

function intOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

function floatOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** `'Y'`, `'y'`, `'1'`, `'true'` → `true`; blank → `false`. */
function flag(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'y' || value === '1' || value === 'true' || value === 'yes';
}

/** The CSV page → typed rows. Pure; a bad row is a problem, never a throw. */
export function parseFinraShortInterest(csv: string): FinraParse {
  const records = parseCsvRecords(csv);
  const problems: FinraProblem[] = [];
  const rows: FinraShortInterestRow[] = [];
  const first = records[0];
  if (first !== undefined) {
    for (const column of REQUIRED_COLUMNS) {
      if (!(column in first)) {
        problems.push({ kind: 'schema_drift', detail: `no ${column} column in the response` });
      }
    }
  }

  for (const record of records) {
    const symbolCode = (record.symbolCode ?? '').trim().toUpperCase();
    const settlementDate = (record.settlementDate ?? '').trim();
    if (symbolCode.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(settlementDate)) {
      problems.push({
        kind: 'parse_error',
        detail: `row has no symbolCode or no ISO settlementDate (${JSON.stringify(settlementDate)})`,
        symbolCode,
      });
      continue;
    }

    let daysToCover = floatOrNull(record.daysToCoverQuantity);
    if (daysToCover !== null && daysToCover > MAX_DAYS_TO_COVER) {
      problems.push({
        kind: 'out_of_range',
        detail: `daysToCoverQuantity ${String(daysToCover)} above ${String(MAX_DAYS_TO_COVER)}; field dropped, quantities kept`,
        symbolCode,
      });
      daysToCover = null;
    }

    rows.push({
      symbolCode,
      issueName: (record.issueName ?? '').trim(),
      marketClassCode: (record.marketClassCode ?? '').trim() || null,
      settlementDate,
      shortQty: intOrNull(record.currentShortPositionQuantity),
      prevShortQty: intOrNull(record.previousShortPositionQuantity),
      avgDailyVolume: intOrNull(record.averageDailyVolumeQuantity),
      daysToCover,
      changePct: floatOrNull(record.changePercent),
      changePreviousNumber: intOrNull(record.changePreviousNumber),
      revision: flag(record.revisionFlag),
      stockSplit: flag(record.stockSplitFlag),
    });
  }

  return { rows, problems };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resolution and writes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `symbolCode` → `instrument_id` through `identifiers(TICKER_EXCH, value, 'US')`. */
export async function resolveSymbol(
  tx: Tx,
  symbolCode: string,
  at: AsOf,
): Promise<{ instrumentId: number; mic: string | null } | null> {
  const rows = await tx
    .select({ instrumentId: identifiers.entityId })
    .from(identifiers)
    .where(
      and(
        eq(identifiers.scheme, 'TICKER_EXCH'),
        eq(identifiers.value, symbolCode),
        eq(identifiers.qualifier, 'US'),
        eq(identifiers.entityKind, 'instrument'),
        asOf(btIdentifiers, at),
      ),
    );
  const hit = rows[0];
  if (hit === undefined || rows.length > 1) {
    // More than one is impossible for a current read (`identifiers_bt_excl`); treating it as a
    // miss rather than a guess is REF-02 either way.
    return await resolveByTicker(tx, symbolCode, at);
  }
  return { instrumentId: hit.instrumentId, mic: await primaryMic(tx, hit.instrumentId, at) };
}

/** Fallback: the composite row's own `(ticker, exch_code)`, which a bare universe seed has. */
async function resolveByTicker(
  tx: Tx,
  symbolCode: string,
  at: AsOf,
): Promise<{ instrumentId: number; mic: string | null } | null> {
  const rows = await tx
    .select({ instrumentId: instruments.instrumentId })
    .from(instruments)
    .where(
      and(
        sql`upper(${instruments.ticker}) = ${symbolCode}`,
        eq(instruments.exchCode, 'US'),
        asOf(btInstruments, at),
      ),
    );
  if (rows.length !== 1) return null;
  const only = rows[0]!;
  return { instrumentId: only.instrumentId, mic: await primaryMic(tx, only.instrumentId, at) };
}

async function primaryMic(tx: Tx, instrumentId: number, at: AsOf): Promise<string | null> {
  const rows = await tx
    .select({ mic: listings.mic })
    .from(listings)
    .innerJoin(
      instruments,
      and(eq(instruments.primaryListingId, listings.listingId), asOf(btInstruments, at)),
    )
    .where(and(eq(instruments.instrumentId, instrumentId), asOf(btListings, at)));
  return rows[0]?.mic ?? null;
}

/** One `short_interest` row, ready to write. */
export interface ShortInterestWrite {
  instrumentId: number;
  settlementDate: string;
  shortQty: number | null;
  prevShortQty: number | null;
  avgDailyVolume: number | null;
  daysToCover: string | null;
  changePct: string | null;
  revision: boolean;
  provenanceId: number;
}

const WRITE_CHUNK = 500;

/**
 * Upsert on `(instrument_id, settlement_date)`, counting rows.
 *
 * A revision genuinely overwrites — that is the table's semantics — but a re-run of the *same*
 * figures must write nothing, so `DO UPDATE … WHERE` compares every data column except
 * `provenance_id`, and a row the `WHERE` rejects is never returned. `xmax = 0` separates the
 * insert branch from the update branch.
 */
export async function upsertShortInterest(
  tx: Tx,
  rows: readonly ShortInterestWrite[],
): Promise<UpsertCounts> {
  const counts: UpsertCounts = { inserted: 0, updated: 0, unchanged: 0 };
  for (let offset = 0; offset < rows.length; offset += WRITE_CHUNK) {
    const chunk = rows.slice(offset, offset + WRITE_CHUNK);
    const returned = await tx
      .insert(shortInterest)
      .values(chunk.map((r) => ({ ...r })))
      .onConflictDoUpdate({
        target: [shortInterest.instrumentId, shortInterest.settlementDate],
        set: {
          shortQty: sql`excluded.short_qty`,
          prevShortQty: sql`excluded.prev_short_qty`,
          avgDailyVolume: sql`excluded.avg_daily_volume`,
          daysToCover: sql`excluded.days_to_cover`,
          changePct: sql`excluded.change_pct`,
          revision: sql`excluded.revision`,
          provenanceId: sql`excluded.provenance_id`,
        },
        setWhere: sql`(short_interest.short_qty, short_interest.prev_short_qty,
                       short_interest.avg_daily_volume, short_interest.days_to_cover,
                       short_interest.change_pct, short_interest.revision)
                      IS DISTINCT FROM
                      (excluded.short_qty, excluded.prev_short_qty,
                       excluded.avg_daily_volume, excluded.days_to_cover,
                       excluded.change_pct, excluded.revision)`,
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });

    for (const row of returned) {
      if (row.inserted) counts.inserted += 1;
      else counts.updated += 1;
    }
    counts.unchanged += chunk.length - returned.length;
  }
  return counts;
}

/** An unresolvable `symbolCode`: a `data_exceptions` row and no `short_interest` row. */
export async function recordUnresolvedSymbol(
  tx: Tx,
  args: {
    provenanceId: number;
    symbolCode: string;
    issueName: string;
    settlementDate: string;
    marketClassCode: string | null;
  },
): Promise<number> {
  const key = `${FINRA_SOURCE_ID}:${args.settlementDate}:${args.symbolCode}`;
  const candidates = [
    {
      sourceId: FINRA_SOURCE_ID,
      provenanceId: args.provenanceId,
      value: {
        key,
        symbolCode: args.symbolCode,
        issueName: args.issueName,
        marketClassCode: args.marketClassCode,
        settlementDate: args.settlementDate,
      },
    },
  ];
  const rows = await tx.execute<{ exception_id: string }>(sql`
    INSERT INTO data_exceptions (kind, entity_kind, entity_id, field, candidates, status)
    SELECT 'unresolved_identifier', NULL, NULL, 'instrument_id',
           ${JSON.stringify(candidates)}::jsonb, 'open'
     WHERE NOT EXISTS (
       SELECT 1 FROM data_exceptions
        WHERE kind = 'unresolved_identifier'
          AND field = 'instrument_id'
          AND candidates -> 0 -> 'value' ->> 'key' = ${key})
    RETURNING exception_id`);
  return rows.rows.length;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ShortInterestRequest {
  /** Overrides the paged URL builder — a fixed page, for a replay harness. */
  url?: string;
  /** Page size; the endpoint's own maximum is 1 000. */
  limit?: number;
  /** PROVIDERS §12's 5 000-row floor. Lowered only by a harness reading a smoke fixture. */
  minRows?: number;
  /** Re-apply a file whose newest `settlementDate` is not newer than the stored maximum. */
  force?: boolean;
}

export interface ShortInterestResult extends JobResult {
  status: 'ok' | 'skipped' | 'failed';
  provenanceId: number | null;
  pages: number;
  /** CSV records read across the whole walk. */
  rows: number;
  resolved: number;
  unresolved: number;
  /** The newest `settlementDate` in the response. */
  latestSettlementDate: string | null;
  shortInterest: UpsertCounts;
  exceptionsWritten: number;
  dqEventsWritten: number;
  /** `daysToCoverQuantity` values above 100, dropped with the quantities kept. */
  daysToCoverDropped: number;
  problems: FinraProblem[];
}

function emptyResult(): ShortInterestResult {
  return {
    fetched: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    provenanceIds: [],
    status: 'ok',
    provenanceId: null,
    pages: 0,
    rows: 0,
    resolved: 0,
    unresolved: 0,
    latestSettlementDate: null,
    shortInterest: { inserted: 0, updated: 0, unchanged: 0 },
    exceptionsWritten: 0,
    dqEventsWritten: 0,
    daysToCoverDropped: 0,
    problems: [],
  };
}

/** `numeric` bind value at the column's own scale, from a float we never re-format elsewhere. */
function numericIn(value: number | null, scale: number): string | null {
  return value === null ? null : value.toFixed(scale);
}

/**
 * Run the job inside `ctx.tx`.
 *
 * The walk is paged and the pages are parsed before anything is written, so a file that fails its
 * own row floor leaves nothing behind but a `dq_events` row (PROVIDERS §12).
 */
export async function runShortInterest(
  ctx: RefIngestContext,
  req: ShortInterestRequest = {},
): Promise<ShortInterestResult> {
  const result = emptyResult();
  const limit = req.limit ?? FINRA_PAGE_SIZE;
  const minRows = req.minRows ?? FINRA_MIN_ROWS;

  // ── the walk ───────────────────────────────────────────────────────────────────────────────
  const parsed: FinraShortInterestRow[] = [];
  let lastRaw: Awaited<ReturnType<typeof fetchRaw>> | null = null;
  for (let page = 0; page < FINRA_MAX_PAGES; page += 1) {
    const url = req.url ?? finraPageUrl(page * limit, limit);
    const raw = await fetchRaw(ctx, {
      providerId: FINRA_SOURCE_ID,
      url,
      timeoutMs: 300_000,
    });
    lastRaw = raw;
    result.fetched += 1;
    result.pages += 1;

    const pageParse = parseFinraShortInterest(raw.body.toString('utf8'));
    result.problems.push(...pageParse.problems);
    result.daysToCoverDropped += pageParse.problems.filter((p) => p.kind === 'out_of_range').length;
    parsed.push(...pageParse.rows);

    // A short page ends the walk; a fixed `url` is one page by construction.
    if (req.url !== undefined || pageParse.rows.length < limit) break;
  }
  result.rows = parsed.length;

  if (lastRaw === null) {
    result.status = 'failed';
    result.errors.push({ code: 'NO_RESPONSE', message: 'the walk fetched no pages' });
    return result;
  }

  const settlementDates = parsed.map((r) => r.settlementDate).sort();
  const latest = settlementDates[settlementDates.length - 1] ?? null;
  result.latestSettlementDate = latest;

  if (result.rows < minRows) {
    result.dqEventsWritten += await recordDqEvent(ctx.tx, {
      kind: 'poll_anomaly',
      severity: 'error',
      sourceId: FINRA_SOURCE_ID,
      subject: 'short_interest',
      key: `${FINRA_SOURCE_ID}:${latest ?? 'unknown'}:row-floor`,
      details: { actual: result.rows, expectedMin: minRows, pages: result.pages },
    });
    result.status = 'skipped';
    result.skipped = result.rows;
    result.errors.push({
      code: 'POLL_ANOMALY',
      message: `only ${String(result.rows)} rows across ${String(result.pages)} pages; floor is ${String(minRows)}`,
    });
    return result;
  }

  if (latest === null) {
    result.status = 'skipped';
    return result;
  }

  // ── freshness: an early or late publication costs one request, not a rewrite ────────────────
  if (req.force !== true) {
    const stored = await latestSettlementDate(ctx.tx);
    if (stored !== null && stored >= latest) {
      result.status = 'skipped';
      result.skipped = result.rows;
      ctx.log?.info?.('shortInterest.skipped', { latest, stored });
      return result;
    }
  }

  const knownAt = new Date(lastRaw.capturedAt);
  const at: AsOf = { validAt: knownAt, knownAt };
  const provenanceId = await insertProvenance(
    ctx.tx,
    lastRaw,
    provenanceMeta(ctx, FINRA_ADAPTER_VERSION, null),
  );
  result.provenanceId = provenanceId;
  result.provenanceIds.push(provenanceId);

  const writes: ShortInterestWrite[] = [];
  const seen = new Set<string>();

  for (const row of parsed) {
    const hit = await resolveSymbol(ctx.tx, row.symbolCode, at);
    if (hit === null) {
      result.unresolved += 1;
      result.exceptionsWritten += await recordUnresolvedSymbol(ctx.tx, {
        provenanceId,
        symbolCode: row.symbolCode,
        issueName: row.issueName,
        settlementDate: row.settlementDate,
        marketClassCode: row.marketClassCode,
      });
      continue;
    }
    result.resolved += 1;

    // `(instrument_id, settlement_date)` is the primary key; two rows for one pair in one response
    // would abort the statement, so the later one is reported and dropped.
    const key = `${String(hit.instrumentId)}:${row.settlementDate}`;
    if (seen.has(key)) {
      result.dqEventsWritten += await recordDqEvent(ctx.tx, {
        kind: 'poll_anomaly',
        severity: 'warn',
        sourceId: FINRA_SOURCE_ID,
        subject: 'short_interest',
        key: `${FINRA_SOURCE_ID}:${key}:duplicate`,
        instrumentId: hit.instrumentId,
        details: { symbolCode: row.symbolCode, settlementDate: row.settlementDate },
      });
      continue;
    }
    seen.add(key);

    result.dqEventsWritten += await crossChecks(ctx.tx, row, hit);

    writes.push({
      instrumentId: hit.instrumentId,
      settlementDate: row.settlementDate,
      shortQty: row.shortQty,
      prevShortQty: row.prevShortQty,
      avgDailyVolume: row.avgDailyVolume,
      daysToCover: numericIn(row.daysToCover, 2),
      changePct: numericIn(row.changePct, 4),
      revision: row.revision,
      provenanceId,
    });
  }

  result.shortInterest = await upsertShortInterest(ctx.tx, writes);
  result.inserted = result.shortInterest.inserted;
  result.updated = result.shortInterest.updated;
  result.skipped = result.shortInterest.unchanged;
  ctx.log?.info?.('shortInterest.ok', {
    latest,
    rows: result.rows,
    resolved: result.resolved,
    unresolved: result.unresolved,
  });
  return result;
}

/** The three recomputations, plus the split flag and the market-class cross-check. */
async function crossChecks(
  tx: Tx,
  row: FinraShortInterestRow,
  hit: { instrumentId: number; mic: string | null },
): Promise<number> {
  let written = 0;
  const base = {
    sourceId: FINRA_SOURCE_ID,
    subject: 'short_interest',
    instrumentId: hit.instrumentId,
  } as const;

  if (
    row.daysToCover !== null &&
    row.avgDailyVolume !== null &&
    row.avgDailyVolume > 0 &&
    row.shortQty !== null
  ) {
    const recomputed = row.shortQty / row.avgDailyVolume;
    const diff = Math.abs(recomputed - row.daysToCover) / Math.max(row.daysToCover, 1e-9);
    if (diff > DAYS_TO_COVER_TOLERANCE) {
      written += await recordDqEvent(tx, {
        ...base,
        kind: 'reconcile_mismatch',
        severity: 'warn',
        key: `${FINRA_SOURCE_ID}:${row.settlementDate}:${row.symbolCode}:daysToCover`,
        details: { expected: recomputed, actual: row.daysToCover, diffPct: diff * 100 },
      });
    }
  }

  if (row.changePreviousNumber !== null && row.shortQty !== null && row.prevShortQty !== null) {
    const recomputed = row.shortQty - row.prevShortQty;
    if (recomputed !== row.changePreviousNumber) {
      written += await recordDqEvent(tx, {
        ...base,
        kind: 'reconcile_mismatch',
        severity: 'warn',
        key: `${FINRA_SOURCE_ID}:${row.settlementDate}:${row.symbolCode}:changePrevious`,
        details: { expected: recomputed, actual: row.changePreviousNumber },
      });
    }
  }

  if (row.stockSplit) {
    // A split makes the change figures incomparable; the quantities stay, the reader is told.
    written += await recordDqEvent(tx, {
      ...base,
      kind: 'field_population',
      severity: 'info',
      key: `${FINRA_SOURCE_ID}:${row.settlementDate}:${row.symbolCode}:stockSplit`,
      details: { stockSplitFlag: true, symbolCode: row.symbolCode },
    });
  }

  if (
    row.marketClassCode !== null &&
    hit.mic !== null &&
    !micAgrees(row.marketClassCode, hit.mic)
  ) {
    written += await recordDqEvent(tx, {
      ...base,
      kind: 'reconcile_mismatch',
      severity: 'info',
      key: `${FINRA_SOURCE_ID}:${row.settlementDate}:${row.symbolCode}:marketClass`,
      details: { expected: hit.mic, actual: row.marketClassCode },
    });
  }
  return written;
}

/** FINRA publishes a venue *name*; `listings.mic` is an ISO 10383 code. */
const MARKET_CLASS_TO_MIC: Readonly<Record<string, readonly string[]>> = {
  NYSE: ['XNYS'],
  NASDAQ: ['XNAS'],
  NNM: ['XNAS'],
  AMEX: ['XASE'],
  NYSEAMERICAN: ['XASE'],
  ARCA: ['ARCX'],
  BATS: ['BATS'],
  OTC: ['OTCM', 'OOTC'],
};

function micAgrees(marketClassCode: string, mic: string): boolean {
  const expected = MARKET_CLASS_TO_MIC[marketClassCode.replaceAll(' ', '').toUpperCase()];
  // An unmapped venue name is not a disagreement — it is a venue this table does not know yet.
  return expected === undefined || expected.includes(mic.toUpperCase());
}

/** The newest `settlement_date` we hold — the freshness gate. */
export async function latestSettlementDate(tx: Tx): Promise<string | null> {
  const rows = await tx
    .select({ settlementDate: sql<string | null>`max(${shortInterest.settlementDate})` })
    .from(shortInterest);
  return rows[0]?.settlementDate ?? null;
}

/** The scheduler row (PROVIDERS §13): 20:00 ET on the 10th and the 26th. */
export const job = {
  id: 'shortInterest',
  schedule: '0 20 10,26 * *',
  provider: FINRA_SOURCE_ID,
  priority: 3 as const,
  timeoutMs: 300_000,
  run: (ctx: RefIngestContext): Promise<ShortInterestResult> => runShortInterest(ctx),
};
