/**
 * Composite merge across md lines (BUS-05) — ARCHITECTURE §6.2 step 4.
 *
 * A subject's `QuoteState.lines[]` keeps one {@link LineState} per md line (Cboe priority 10, Yahoo
 * priority 20, from `md_lines.priority`). `mergeComposite` recomposes the composite fields from
 * those lines; the per-line contributions stay in `lines[]` untouched, which is how per-field
 * provenance is retained (the QM per-venue view reads them directly).
 *
 * Ordering. A line's time is `ts.src ?? ts.cap` ({@link lineTime}). "Freshest" means the greatest
 * line time, then — the tie rule of ARCHITECTURE §6.2 step 4 — the **lowest** priority number, then
 * (within one `sourceId`, where the counters are comparable) the greatest `srcSeq`, then the lowest
 * `mdLineId` — total, so the result is deterministic. "Primary" means the lowest priority number,
 * then freshest.
 *
 * Rules, per field group:
 *
 *   - `PX_LAST`, `LAST_SIZE`, `LAST_TRADE_TIME` — from the freshest line that carries `PX_LAST`,
 *     taken together: the size and time of a trade never come from a different line than its price.
 *   - `PX_BID`, `PX_ASK`, `BID_SIZE`, `ASK_SIZE` — only from lines whose kind is `venue` or
 *     `composite` **and** that publish a book (carry `PX_BID` or `PX_ASK`); the freshest such line,
 *     all four fields together. A Yahoo line (`reference`, no book) never contributes a bid.
 *   - `PX_VOLUME` = max, `PX_HIGH` = max, `PX_LOW` = min across lines of the composite's session
 *     date. Every reachable source reports consolidated volume, so among lines observing the same
 *     session the largest is the most complete count; a line still reporting the previous session
 *     is excluded from all three, or it would publish yesterday's totals as today's.
 *   - `PX_OPEN`, `PX_CLOSE_1D`, `PX_OFFICIAL_CLOSE` — from the primary line; when the primary line
 *     does not carry the field, from the next line in primary order that does.
 *   - `IVOL_30D` — only from a line that publishes implied volatility (`publishesIvol`, default:
 *     `sourceId` starting with `cboe`); the freshest such line.
 *   - `CHG_NET_1D`, `CHG_PCT_1D`, `TICK_DIR` — never taken from a line (`core/quote/derive.ts`
 *     computes them from the composite); a provider value is dropped here.
 *   - Everything else (rates, options, `VWAP`, `SESSION_STATE`) — field-level last-writer-wins by
 *     line time, i.e. the freshest line carrying the field.
 *
 * The composite's session date is `sessionDateOf(winner)`; the default reads the UTC calendar day
 * of the line time, which equals the local day for a US regular session. The plant passes the
 * instrument calendar's local day (`session.ts#localClock`) so post-market prints after 20:00 ET
 * (00:00 UTC in summer) stay on the right session.
 *
 * Data-quality flags:
 *   - `CROSS_SOURCE_DIVERGENCE` when two lines disagree on `PX_LAST` by **more than** 0.5 % (of the
 *     larger absolute price) with line times within 60 s of each other (OPS-03, QA-03).
 *   - `MISSING_CLOSE` when the composite has a `PX_LAST` but no `PX_CLOSE_1D` (no change can be
 *     derived — the screen shows a blank change, never a change against zero).
 *
 * `fieldTs[f]` is the line time of the line that supplied `f`.
 */

import { fromEpochDay } from '../calendars/calendar.js';
import type { DataQualityFlag, LineState, QuoteFieldId, QuoteFields } from '../types/quote.js';
import { DERIVED_QUOTE_FIELD_IDS } from './derive.js';

export type LineKind = 'composite' | 'venue' | 'derived' | 'reference';

export interface MergeOptions {
  lineKindOf: (mdLineId: number) => LineKind;
  /** The primary line; default: the line with the lowest priority number. */
  primaryMdLineId?: number;
  /** Session date ('YYYY-MM-DD') a line's values belong to; default: the UTC day of {@link lineTime}. */
  sessionDateOf?: (line: LineState) => string;
  /** Whether a line may supply `IVOL_30D`; default: `sourceId` starts with `cboe`. */
  publishesIvol?: (line: LineState) => boolean;
  /** Divergence threshold as a fraction; default 0.005 (0.5 %). */
  divergenceFraction?: number;
  /** Divergence comparison window in ms; default 60 000. */
  divergenceWindowMs?: number;
}

export interface MergeResult {
  fields: QuoteFields;
  fieldTs: Partial<Record<QuoteFieldId, number>>;
  /** The line that supplied `PX_LAST`, else the freshest line; `undefined` with no lines. */
  winner: LineState | undefined;
  dq: DataQualityFlag[];
}

export const DIVERGENCE_FRACTION_DEFAULT = 0.005;
export const DIVERGENCE_WINDOW_MS_DEFAULT = 60_000;

const TRADE_FIELDS = ['PX_LAST', 'LAST_SIZE', 'LAST_TRADE_TIME'] as const;
const BOOK_FIELDS = ['PX_BID', 'PX_ASK', 'BID_SIZE', 'ASK_SIZE'] as const;
const PRIMARY_FIELDS = ['PX_OPEN', 'PX_CLOSE_1D', 'PX_OFFICIAL_CLOSE'] as const;
const GROUPED: ReadonlySet<string> = new Set<string>([
  ...TRADE_FIELDS,
  ...BOOK_FIELDS,
  ...PRIMARY_FIELDS,
  'PX_VOLUME',
  'PX_HIGH',
  'PX_LOW',
  'IVOL_30D',
  ...DERIVED_QUOTE_FIELD_IDS,
]);

/** `ts.src ?? ts.cap`: the time a line's values are as of. */
export function lineTime(line: LineState): number {
  return line.ts.src ?? line.ts.cap;
}

/** UTC calendar day of a line's time — the default `sessionDateOf`. */
export function utcSessionDate(line: LineState): string {
  return fromEpochDay(Math.floor(lineTime(line) / 86_400_000));
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function has(line: LineState, field: string): boolean {
  return (line.fields as Record<string, unknown>)[field] !== undefined;
}

/**
 * Freshest first: line time desc, priority asc, then — only between lines of the **same source** —
 * srcSeq desc, then mdLineId asc.
 *
 * ARCHITECTURE §6.2 step 4 gives the tie rule as "ties: lowest priority", so priority is consulted
 * before srcSeq. A srcSeq is a provider's own counter (a Cboe `seqno`); two providers' counters are
 * not in one number space, so ordering two different sources by them is not well founded. Grouping
 * by `sourceId` before srcSeq keeps the comparison inside one source and keeps the order total.
 */
function compareFreshest(priorityOf: (id: number) => number) {
  return (a: LineState, b: LineState): number => {
    const dt = lineTime(b) - lineTime(a);
    if (dt !== 0) return dt;
    const dp = priorityOf(a.mdLineId) - priorityOf(b.mdLineId);
    if (dp !== 0) return dp;
    if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
    const ds = (b.srcSeq ?? Number.NEGATIVE_INFINITY) - (a.srcSeq ?? Number.NEGATIVE_INFINITY);
    if (ds !== 0 && !Number.isNaN(ds)) return ds;
    return a.mdLineId - b.mdLineId;
  };
}

/** Primary first: priority asc, then freshest. */
function comparePrimary(priorityOf: (id: number) => number, primaryMdLineId: number | undefined) {
  const freshest = compareFreshest(priorityOf);
  return (a: LineState, b: LineState): number => {
    if (primaryMdLineId !== undefined) {
      if (a.mdLineId === primaryMdLineId && b.mdLineId !== primaryMdLineId) return -1;
      if (b.mdLineId === primaryMdLineId && a.mdLineId !== primaryMdLineId) return 1;
    }
    const dp = priorityOf(a.mdLineId) - priorityOf(b.mdLineId);
    if (dp !== 0) return dp;
    return freshest(a, b);
  };
}

export function mergeComposite(
  lines: Readonly<Record<number, LineState>>,
  priorityOf: (mdLineId: number) => number,
  opts: MergeOptions,
): MergeResult {
  const all = Object.values(lines);
  const fields: Record<string, unknown> = {};
  const fieldTs: Partial<Record<QuoteFieldId, number>> = {};
  const dq: DataQualityFlag[] = [];
  if (all.length === 0) return { fields, fieldTs, winner: undefined, dq };

  const byFreshest = [...all].sort(compareFreshest(priorityOf));
  const byPrimary = [...all].sort(comparePrimary(priorityOf, opts.primaryMdLineId));
  const sessionDateOf = opts.sessionDateOf ?? utcSessionDate;
  const publishesIvol = opts.publishesIvol ?? ((line: LineState): boolean => line.sourceId.startsWith('cboe'));

  const take = (line: LineState, field: string): void => {
    const v = (line.fields as Record<string, unknown>)[field];
    if (v === undefined) return;
    fields[field] = v;
    fieldTs[field as QuoteFieldId] = lineTime(line);
  };

  // Trade block: one line, atomically.
  const tradeLine = byFreshest.find((l) => has(l, 'PX_LAST'));
  const winner = tradeLine ?? byFreshest[0];
  if (tradeLine !== undefined) for (const f of TRADE_FIELDS) take(tradeLine, f);

  // Book: venue/composite lines that publish one.
  const bookLine = byFreshest.find((l) => {
    const kind = opts.lineKindOf(l.mdLineId);
    return (kind === 'venue' || kind === 'composite') && (has(l, 'PX_BID') || has(l, 'PX_ASK'));
  });
  if (bookLine !== undefined) for (const f of BOOK_FIELDS) take(bookLine, f);

  // Session aggregates: volume max, high max and low min, all across the lines of the composite's
  // session date.
  //
  // ARCHITECTURE §6.2 step 4 writes the volume bullet as a plain "PX_VOLUME = max(line volumes)"
  // and puts the "same session date" qualifier only on high/low. Taken literally that is wrong at
  // the open: a line still reporting yesterday carries a full session's volume, so the max would
  // publish yesterday's count as today's — and stamp `fieldTs.PX_VOLUME` a day in the past, which
  // then reads as a stale quote. The parenthetical that follows the bullet ("every reachable source
  // reports consolidated volume, so the largest is the most complete count") is the actual
  // reasoning, and it only holds among lines observing the SAME session. So the qualifier applies
  // here too; the document's volume bullet has been amended to say so.
  const sessionDate = winner === undefined ? undefined : sessionDateOf(winner);
  const inSession = byFreshest.filter((l) => sessionDateOf(l) === sessionDate);
  let volLine: LineState | undefined;
  let highLine: LineState | undefined;
  let lowLine: LineState | undefined;
  for (const l of inSession) {
    const { PX_VOLUME } = l.fields;
    if (isNum(PX_VOLUME) && (volLine === undefined || PX_VOLUME > (volLine.fields.PX_VOLUME!))) volLine = l;
  }
  for (const l of inSession) {
    const { PX_HIGH, PX_LOW } = l.fields;
    if (isNum(PX_HIGH) && (highLine === undefined || PX_HIGH > (highLine.fields.PX_HIGH!))) highLine = l;
    if (isNum(PX_LOW) && (lowLine === undefined || PX_LOW < (lowLine.fields.PX_LOW!))) lowLine = l;
  }
  if (volLine !== undefined) take(volLine, 'PX_VOLUME');
  if (highLine !== undefined) take(highLine, 'PX_HIGH');
  if (lowLine !== undefined) take(lowLine, 'PX_LOW');

  // Primary-line fields, falling back down the primary order.
  for (const f of PRIMARY_FIELDS) {
    const src = byPrimary.find((l) => has(l, f));
    if (src !== undefined) take(src, f);
  }

  // Implied vol: Cboe only.
  const ivolLine = byFreshest.find((l) => publishesIvol(l) && has(l, 'IVOL_30D'));
  if (ivolLine !== undefined) take(ivolLine, 'IVOL_30D');

  // Everything else: field-level last-writer-wins (freshest line carrying the field).
  for (const l of byFreshest) {
    for (const f of Object.keys(l.fields)) {
      if (GROUPED.has(f) || fields[f] !== undefined) continue;
      take(l, f);
    }
  }

  // Divergence: any two lines within the window disagreeing on PX_LAST by more than the fraction.
  const fraction = opts.divergenceFraction ?? DIVERGENCE_FRACTION_DEFAULT;
  const windowMs = opts.divergenceWindowMs ?? DIVERGENCE_WINDOW_MS_DEFAULT;
  const priced = all.filter((l) => isNum(l.fields.PX_LAST));
  outer: for (let i = 0; i < priced.length; i += 1) {
    for (let j = i + 1; j < priced.length; j += 1) {
      const a = priced[i]!;
      const b = priced[j]!;
      if (Math.abs(lineTime(a) - lineTime(b)) > windowMs) continue;
      const pa = a.fields.PX_LAST!;
      const pb = b.fields.PX_LAST!;
      const scale = Math.max(Math.abs(pa), Math.abs(pb));
      if (scale > 0 && Math.abs(pa - pb) > fraction * scale) {
        dq.push('CROSS_SOURCE_DIVERGENCE');
        break outer;
      }
    }
  }
  if (fields.PX_LAST !== undefined && fields.PX_CLOSE_1D === undefined) dq.push('MISSING_CLOSE');

  return { fields, fieldTs, winner, dq };
}
