/**
 * Composition of one subject's md lines into its composite fields — ARCHITECTURE §6.2 step 4.
 *
 * This module is the plant's half of the merge: `core/quote/merge.ts` is the pure BUS-05 rule set
 * (which line supplies which field), `core/quote/derive.ts` computes the three derived fields, and
 * `recompose()` is what puts them together and turns the divergence the merge detected into the
 * `dq_events` row OPS-03 asks for.
 *
 * Three things live here rather than in `core`:
 *
 *  1. **Line metadata.** `mergeComposite` asks for a `priority` and a `lineKind` per `mdLineId`;
 *     those come from `md_lines` (`priority`, `line_kind`, `intrinsic_delay_min`,
 *     `expected_interval_ms`). The plant injects a {@link LineMetaSource} that reads them; with no
 *     lookup wired the defaults of {@link defaultLineMeta} apply — Cboe priority 10 (a composite
 *     line that publishes a book), Yahoo priority 20 (a reference line that does not), the
 *     simulated feed in between, and `md_lines`' own column default of 100 for anything else.
 *  2. **`derive()`.** `mergeComposite` deliberately strips a provider's `CHG_*` / `TICK_DIR`; the
 *     composite's own values are derived here from `PX_LAST` vs `PX_CLOSE_1D` and from the previous
 *     composite's `PX_LAST`, and are stamped with the trade line's time.
 *  3. **The DQ event.** The merge flags `CROSS_SOURCE_DIVERGENCE` on the state; the row that makes
 *     it visible in `Ctrl+I` and in the DQ console is written through `observability/dq.ts`, which
 *     needs a database. {@link dbDivergenceSink} writes it when one is wired and is a no-op — never
 *     a throw — when it is not, so the plant runs identically in a unit test with no database.
 *
 * Nothing here invents a value: a field no line carries is absent from the result, and a change
 * that cannot be derived (no previous close) is absent rather than computed against zero.
 */

import {
  derive,
  lineTime,
  localClock,
  mergeComposite,
  utcSessionDate,
} from '@terminal/core';
import type {
  DataQualityFlag,
  LineKind,
  LineState,
  QuoteFieldId,
  QuoteFields,
  Tier,
} from '@terminal/core';

import { currentTx, type Db, type Tx } from '../db/client.js';
import { checkCrossSourceDivergence } from '../observability/dq.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Line metadata
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What the composition needs to know about an md line — the `md_lines` columns it reads. */
export interface LineMeta {
  /** `md_lines.priority`; lower wins. Cboe 10, Yahoo 20, column default 100. */
  priority: number;
  /** `md_lines.line_kind`; only `venue`/`composite` lines may supply a book. */
  lineKind: LineKind;
  /** `md_lines.intrinsic_delay_min` — the delay already in the source (FEED-05). */
  intrinsicDelayMin: number;
  /** `md_lines.expected_interval_ms` — the staleness limit's basis (TERM-12). */
  expectedIntervalMs: number;
}

/**
 * A lookup over `md_lines`, by id. Returning `undefined` (or a partial record) falls back to
 * {@link defaultLineMeta} for the missing members, so a plant can be wired with a lookup that only
 * knows the lines it has loaded.
 */
export type LineMetaSource = (mdLineId: number) => Partial<LineMeta> | undefined;

/** The Cboe delayed cadence (ARCHITECTURE §6.2: `jobs/cboeQuotes.ts` every 10 s). */
export const DEFAULT_EXPECTED_INTERVAL_MS = 10_000;

/** `md_lines.priority`'s column default. */
export const DEFAULT_LINE_PRIORITY = 100;

/**
 * Metadata for a line whose `md_lines` row is not loaded, from its `source_id`.
 *
 * The three sources v1 can produce a quote from are spelled out; everything else takes the column
 * defaults and the `venue` kind (a line that publishes a book is the general case — a line that
 * does not simply carries no `PX_BID`, and the merge then skips it anyway).
 */
export function defaultLineMeta(sourceId: string): LineMeta {
  if (sourceId.startsWith('cboe')) {
    return {
      priority: 10,
      lineKind: 'composite',
      intrinsicDelayMin: 15,
      expectedIntervalMs: DEFAULT_EXPECTED_INTERVAL_MS,
    };
  }
  if (sourceId.startsWith('yahoo')) {
    return { priority: 20, lineKind: 'reference', intrinsicDelayMin: 15, expectedIntervalMs: 15_000 };
  }
  if (sourceId === 'internal.derived' || sourceId.startsWith('sim')) {
    return { priority: 30, lineKind: 'venue', intrinsicDelayMin: 0, expectedIntervalMs: 1_000 };
  }
  return {
    priority: DEFAULT_LINE_PRIORITY,
    lineKind: 'venue',
    intrinsicDelayMin: 0,
    expectedIntervalMs: DEFAULT_EXPECTED_INTERVAL_MS,
  };
}

/** `defaultLineMeta(sourceId)` overridden by whatever the lookup knows. */
export function resolveLineMeta(
  mdLineId: number,
  sourceId: string,
  lookup?: LineMetaSource,
): LineMeta {
  const base = defaultLineMeta(sourceId);
  const found = lookup?.(mdLineId);
  if (found === undefined) return base;
  return {
    priority: found.priority ?? base.priority,
    lineKind: found.lineKind ?? base.lineKind,
    intrinsicDelayMin: found.intrinsicDelayMin ?? base.intrinsicDelayMin,
    expectedIntervalMs: found.expectedIntervalMs ?? base.expectedIntervalMs,
  };
}

/** A delayed-tier line with no metadata is 15 minutes behind at source; a realtime one is not. */
export function delayMinFor(meta: LineMeta, tier: Tier): number {
  return meta.intrinsicDelayMin > 0 ? meta.intrinsicDelayMin : tier === 'delayed' ? 15 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Divergence
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The two lines whose `PX_LAST` disagree — what the `cross_source_divergence` row reports. */
export interface DivergencePair {
  /** The line we trust more: the lower `priority` of the pair (the primary). */
  expected: LineState;
  actual: LineState;
  /** `|expected − actual| / max(|expected|,|actual|)`, as a fraction. */
  fraction: number;
}

export interface DivergenceEvent {
  subject: string;
  instrumentId: number;
  /** `source_id` of the line we trust more. */
  sourceId: string;
  expected: number;
  actual: number;
  /** Tolerance in **percent** — `0.5` for the BUS-05 threshold. */
  tolerancePct: number;
  expectedMdLineId: number;
  actualMdLineId: number;
}

/** Where a divergence is reported. The plant injects one; `core` never sees it. */
export type CompositeDqSink = (event: DivergenceEvent) => void;

/** A sink that drops the event — the default when no database is wired. */
export const NOOP_DQ_SINK: CompositeDqSink = () => undefined;

/** A `Tx` carries drizzle's `rollback`; a pooled `Db` handle does not. */
function isTx(handle: Db | Tx): handle is Tx {
  return typeof (handle as { rollback?: unknown }).rollback === 'function';
}

/**
 * A sink that writes the `dq_events` row (OPS-03 `cross_source_divergence`).
 *
 * The write is fire-and-forget: `plant.apply` is synchronous and must not be slowed by, or fail
 * because of, a monitoring row. Failures go to `onError` (the plant logs them) and are never
 * rethrown. With `db` undefined the sink is {@link NOOP_DQ_SINK}, so a unit-test plant raises
 * nothing and still never throws.
 */
export function dbDivergenceSink(
  db: Db | Tx | undefined,
  onError?: (err: unknown) => void,
): CompositeDqSink {
  if (db === undefined) return NOOP_DQ_SINK;
  return (event: DivergenceEvent): void => {
    // An explicit transaction handle (a job's, or the test harness's) is joined rather than
    // nested; otherwise `raiseDq` opens its own through `withTx`.
    const tx = isTx(db) ? db : currentTx();
    void checkCrossSourceDivergence(
      {
        sourceId: event.sourceId,
        subject: event.subject,
        instrumentId: event.instrumentId,
        expected: event.expected,
        actual: event.actual,
        tolerancePct: event.tolerancePct,
        key: `${event.subject}:cross_source_divergence`,
        details: {
          expectedMdLineId: event.expectedMdLineId,
          actualMdLineId: event.actualMdLineId,
          field: 'PX_LAST',
        },
      },
      tx === undefined ? undefined : { tx },
    ).catch((err: unknown) => {
      onError?.(err);
    });
  };
}

/**
 * The first pair of lines that disagree on `PX_LAST` by more than `fraction` within `windowMs` —
 * the same rule `mergeComposite` flags with `CROSS_SOURCE_DIVERGENCE`, reported as the pair so the
 * DQ row can name both sides. `null` when nothing diverges.
 */
export function divergentPair(
  lines: Readonly<Record<number, LineState>>,
  priorityOf: (mdLineId: number) => number,
  fraction: number,
  windowMs: number,
): DivergencePair | null {
  const priced = Object.values(lines).filter(
    (l) => typeof l.fields.PX_LAST === 'number' && Number.isFinite(l.fields.PX_LAST),
  );
  for (let i = 0; i < priced.length; i += 1) {
    for (let j = i + 1; j < priced.length; j += 1) {
      const a = priced[i]!;
      const b = priced[j]!;
      if (Math.abs(lineTime(a) - lineTime(b)) > windowMs) continue;
      const pa = a.fields.PX_LAST!;
      const pb = b.fields.PX_LAST!;
      const scale = Math.max(Math.abs(pa), Math.abs(pb));
      if (scale <= 0 || Math.abs(pa - pb) <= fraction * scale) continue;
      const [expected, actual] =
        priorityOf(a.mdLineId) <= priorityOf(b.mdLineId) ? [a, b] : [b, a];
      return { expected, actual, fraction: Math.abs(pa - pb) / scale };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Recomposition
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface RecomposeInput {
  /** The subject's lines, keyed by `mdLineId` (`QuoteState.lines`). */
  lines: Readonly<Record<number, LineState>>;
  /** The previous composite's fields — `TICK_DIR` needs the previous `PX_LAST`. */
  prev?: QuoteFields | undefined;
  /** Resolved metadata per line. */
  meta: (mdLineId: number) => LineMeta;
  /** The primary line; default: the lowest `priority`. */
  primaryMdLineId?: number | undefined;
  /**
   * IANA zone of the instrument's calendar. The session date a line's values belong to is read in
   * that zone, so a post-market print after 20:00 ET (00:00 UTC) stays on its own session. With no
   * zone (or an unsupported one) the UTC day is used, which is `mergeComposite`'s own default.
   */
  tz?: string | undefined;
  /** Divergence threshold as a fraction; default `DIVERGENCE_FRACTION_DEFAULT` (0.5 %). */
  divergenceFraction?: number | undefined;
  /** Divergence comparison window; default `DIVERGENCE_WINDOW_MS_DEFAULT` (60 s). */
  divergenceWindowMs?: number | undefined;
}

export interface CompositeResult {
  /** The composite fields, including the derived `CHG_NET_1D` / `CHG_PCT_1D` / `TICK_DIR`. */
  fields: QuoteFields;
  /** Line time per field; the derived fields carry the trade line's time. */
  fieldTs: Partial<Record<QuoteFieldId, number>>;
  /** The line that supplied `PX_LAST`, else the freshest; `undefined` with no lines. */
  winner: LineState | undefined;
  dq: DataQualityFlag[];
  /** The diverging pair when `dq` carries `CROSS_SOURCE_DIVERGENCE`, else `null`. */
  divergence: DivergencePair | null;
}

/** The fraction `mergeComposite` uses, as a percentage — what the DQ row reports as its tolerance. */
export const DIVERGENCE_TOLERANCE_PCT = 0.5;

/**
 * Recompose one subject: the BUS-05 merge over its lines, plus the derived block.
 *
 * `fieldTs` for a derived field is the time of the value it was derived from (the trade line's
 * time), so a screen showing `CHG_PCT_1D` reports the same as-of instant as the `PX_LAST` it was
 * computed from.
 */
export function recompose(input: RecomposeInput): CompositeResult {
  const priorityOf = (mdLineId: number): number => input.meta(mdLineId).priority;
  const lineKindOf = (mdLineId: number): LineKind => input.meta(mdLineId).lineKind;
  const sessionDateOf =
    input.tz === undefined
      ? utcSessionDate
      : (line: LineState): string => localClock(input.tz!, lineTime(line))?.date ?? utcSessionDate(line);

  const merged = mergeComposite(input.lines, priorityOf, {
    lineKindOf,
    sessionDateOf,
    ...(input.primaryMdLineId === undefined ? {} : { primaryMdLineId: input.primaryMdLineId }),
    ...(input.divergenceFraction === undefined ? {} : { divergenceFraction: input.divergenceFraction }),
    ...(input.divergenceWindowMs === undefined ? {} : { divergenceWindowMs: input.divergenceWindowMs }),
  });

  const derived = derive(merged.fields, input.prev);
  const fields: QuoteFields = { ...merged.fields, ...derived };
  const fieldTs = { ...merged.fieldTs };
  // The derived block is as of the price it came from.
  const derivedTs = merged.fieldTs.PX_LAST;
  if (derivedTs !== undefined) {
    for (const id of ['CHG_NET_1D', 'CHG_PCT_1D', 'TICK_DIR'] as const) {
      if (fields[id] !== undefined) fieldTs[id] = derivedTs;
    }
  }

  const divergence = merged.dq.includes('CROSS_SOURCE_DIVERGENCE')
    ? divergentPair(
        input.lines,
        priorityOf,
        input.divergenceFraction ?? DIVERGENCE_TOLERANCE_PCT / 100,
        input.divergenceWindowMs ?? 60_000,
      )
    : null;

  return { fields, fieldTs, winner: merged.winner, dq: merged.dq, divergence };
}
