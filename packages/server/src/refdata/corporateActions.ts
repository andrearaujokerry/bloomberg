/**
 * Corporate actions — the bitemporal repository, the REF-10 dual-key review desk, and the glue
 * that hands rows to `@terminal/core`'s `adjustmentFactors` (REF-09).
 *
 * DATA_MODEL §6 L957-1003 (the table), §6.1 L1004-1030 (the adjustment policy), API.md §4 L380
 * and §12.1 L1414-1433 (the worked read), PROVIDERS §5.5 L959 and API.md §7 L802-803 (the review
 * queue).
 *
 * ## Three things live here, and they are one thing
 *
 * 1. **The repository.** `corporate_actions` carries two keys at once (hence the header of
 *    `db/schema/corporateActions.ts`): the surrogate `ca_id`, which `corporate_actions_bt_excl`
 *    versions, and the natural tuple `(instrument_id, ca_type, ex_date, source_id)`, which
 *    `corporate_actions_natural_excl` keeps unique among *current* rows. A job that re-parses
 *    yesterday's Yahoo `events` block must land on the **same** `ca_id` or the second write is a
 *    `23P01`, so `recordAction()` looks the natural key up first and only then allocates from
 *    `ca_id_seq`.
 *
 * 2. **The dual key (REF-10).** A dividend or split parsed from a feed lands `review_state
 *    'queued'` and **never adjusts a price until a data-ops user reviews it** (PROVIDERS L959).
 *    `'auto'` and `'reviewed'` are the states an adjustment may use; `'queued'` and `'rejected'`
 *    are not, and `loadAdjustment()` reports what it left out rather than silently dropping it.
 *    Two people are required: whoever entered a manual action is recorded in
 *    `details.enteredBy`, and `reviewAction()` refuses a review by that same user
 *    (`CaReviewError` with `code 'ca_dual_key'`). A review is a *correction* on the
 *    transaction-time axis — same valid range, later `tx_from` — so a backtest replayed as of
 *    before the review still sees the unreviewed action and still refuses to adjust with it.
 *
 * 3. **The adjustment glue (REF-09).** `adjustmentFactors` takes three arguments and the third
 *    one is the reason this module touches `bars_daily` at all: a cash dividend's factor is
 *    `1 − amount / closeBeforeEx`, where `closeBeforeEx` is the **unadjusted** close of the last
 *    session *strictly before* the ex-date. For the first action in a window that close lies
 *    before `start`, so `loadCloses()` loads `[start − 1 session, end]` — the lead-in is found by
 *    `ORDER BY session_date DESC LIMIT 1`, never by guessing a calendar — and `loadAdjustment()`
 *    **drops that extra session again** before returning, so the caller gets exactly the window
 *    it asked for with factors that are nonetheless right at its first bar.
 *
 * ## Which actions take part
 *
 * Actions with `ex_date > start` (an action on or before the first bar changes nothing: factors
 * apply *strictly before* their ex-date) and `ex_date <= actionsThrough`, which defaults to the
 * as-of *valid* date — the CRSP/Yahoo convention of quoting a historical window in today's
 * terms, and what makes API.md §12.1 come out right: `AAPL` 2020-08-28 close 499.23 under policy
 * `price` is 124.8075 because the 4:1 split of 2020-08-31 applies to it even though it is past
 * the requested window, while the same request `knownAt 2020-07-30` returns 499.23 and an empty
 * `adjustments` array because the split was not yet recorded then (REF-03 doing the work).
 *
 * Under `total_return` a cash action past `end` needs its own prior close, so the close load is
 * extended to that ex-date and the extra sessions are trimmed off the returned series too.
 */

import { adjustmentFactors } from '@terminal/core/adjust/corporateActions';
import { and, asc, desc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';

import { asOf, bitemporal, upsertVersion, writeVersion } from '../db/bitemporal.js';
import { barsDaily, corporateActions } from '../db/schema/index.js';

import type { AdjustPolicy } from '@terminal/core';
import type {
  CaForAdjust,
  CaStatus,
  CaType,
  FactorStep,
} from '@terminal/core/adjust/corporateActions';
import type { SQL } from 'drizzle-orm';
import type { AsOf, BitemporalTable, VersionWrite } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';

/** `corporate_actions`, tagged with its `corporate_actions_bt_excl` key column. */
export const btCorporateActions: BitemporalTable<typeof corporateActions.$inferSelect> = bitemporal(
  corporateActions,
  'caId',
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `corporate_actions.review_state` (DATA_MODEL L982) — the REF-10 dual key. */
export type ReviewState = 'auto' | 'queued' | 'reviewed' | 'rejected';

/**
 * The review states an adjustment may use. `'queued'` is a feed's unreviewed claim and
 * `'rejected'` is a claim a human threw out; neither may move a price (PROVIDERS §5.5 L959).
 */
export const ADJUSTING_REVIEW_STATES: ReadonlySet<ReviewState> = new Set<ReviewState>([
  'auto',
  'reviewed',
]);

/** One version of one corporate action, as of the pair of instants the read was made with. */
export interface CorporateActionRecord {
  versionId: number;
  caId: number;
  instrumentId: number;
  caType: CaType;
  status: CaStatus;
  declaredDate: string | null;
  exDate: string;
  recordDate: string | null;
  payDate: string | null;
  effectiveDate: string | null;
  /** Cash per share, in `currency`. */
  amount: number | null;
  currency: string | null;
  /** 4:1 split → `ratioNew = 4`, `ratioOld = 1`. */
  ratioNew: number | null;
  ratioOld: number | null;
  newInstrumentId: number | null;
  frequency: string | null;
  grossOrNet: 'gross' | 'net';
  details: Record<string, unknown>;
  note: string | null;
  sourceId: string;
  reviewState: ReviewState;
  reviewedBy: number | null;
  reviewedAt: string | null;
  provenanceId: number;
  /** Valid range as text, so the `'infinity'` sentinel survives. */
  validFrom: string;
  validTo: string;
}

/** What `actionsAsOf` filters on. Every bound is on `ex_date`. */
export interface ActionQuery {
  instrumentId?: number;
  instrumentIds?: readonly number[];
  /** `ex_date >= from`. */
  from?: string;
  /** `ex_date <= to`. */
  to?: string;
  /** `ex_date > after` — the adjustment's bound: an action at or before the first bar is inert. */
  after?: string;
  caTypes?: readonly CaType[];
  reviewStates?: readonly ReviewState[];
  statuses?: readonly CaStatus[];
}

/** One unadjusted daily close, with the provenance row that supplied the bar. */
export interface CloseRow {
  date: string;
  close: number;
  provenanceId: number;
}

/** A historical-window adjustment request (REF-09). */
export interface AdjustmentRequest {
  instrumentId: number;
  /** `YYYY-MM-DD`, inclusive. */
  start: string;
  /** `YYYY-MM-DD`, inclusive. */
  end: string;
  policy: AdjustPolicy;
  asOf: AsOf;
  /**
   * Actions with `ex_date <= actionsThrough` take part. Default: the UTC date of `asOf.validAt`,
   * i.e. the window is quoted in as-of-date terms. Pass `end` for a window quoted in its own
   * terms.
   */
  actionsThrough?: string;
}

/** Everything the historical read needs, with the lead-in session already dropped. */
export interface AdjustmentContext {
  /** Ascending by `beforeDate`; `[]` under `unadjusted`. Echoed as `meta.adjustments`. */
  steps: FactorStep[];
  /** The actions that produced the steps — `auto` and `reviewed` only. */
  applied: CorporateActionRecord[];
  /** The actions in the window that were **not** applied because of their review state (REF-10). */
  skipped: CorporateActionRecord[];
  /** Unadjusted closes for `[start, end]` exactly: the lead-in session is gone. */
  closes: CloseRow[];
  /** The close of the last session strictly before `start`, or `null` when there is none. */
  leadIn: CloseRow | null;
  /** Distinct provenance ids behind `closes` and `applied`, for `PayloadMeta.provenance[]`. */
  provenanceIds: number[];
}

/** A refused review (REF-10). `code` is what `POST /admin/ca-queue/:caId/review` maps to a 4xx. */
export class CaReviewError extends Error {
  readonly code: 'ca_not_found' | 'ca_not_queued' | 'ca_dual_key';
  constructor(code: 'ca_not_found' | 'ca_not_queued' | 'ca_dual_key', message: string) {
    super(message);
    this.name = 'CaReviewError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(date: string, what: string): string {
  if (!DATE_RE.test(date)) {
    throw new RangeError(
      `corporateActions: ${what} must be YYYY-MM-DD, got ${JSON.stringify(date)}`,
    );
  }
  return date;
}

/** `'2020-08-31'` → the UTC midnight a valid range starts at. */
function instantOfDate(date: string): Date {
  return new Date(`${assertDate(date, 'date')}T00:00:00.000Z`);
}

/** The UTC calendar date of an instant — sessions and `ex_date` are dates, not instants. */
function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function numericIn(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) {
    throw new RangeError(`corporateActions: ${String(value)} is not a finite numeric value`);
  }
  return String(value);
}

const REVIEW_STATES: ReadonlySet<string> = new Set(['auto', 'queued', 'reviewed', 'rejected']);

function asReviewState(value: string): ReviewState {
  if (!REVIEW_STATES.has(value)) {
    throw new Error(`corporateActions: unknown review_state ${JSON.stringify(value)}`);
  }
  return value as ReviewState;
}

/** Exactly what `select(ACTION_FIELDS)` yields. */
interface ActionRow {
  versionId: number;
  caId: number;
  instrumentId: number;
  caType: string;
  status: string;
  declaredDate: string | null;
  exDate: string;
  recordDate: string | null;
  payDate: string | null;
  effectiveDate: string | null;
  amount: string | null;
  currency: string | null;
  ratioNew: string | null;
  ratioOld: string | null;
  newInstrumentId: number | null;
  frequency: string | null;
  grossOrNet: string;
  details: unknown;
  note: string | null;
  sourceId: string;
  reviewState: string;
  reviewedBy: number | null;
  reviewedAt: string | null;
  provenanceId: number;
  validFrom: string;
  validTo: string;
}

const ACTION_FIELDS = {
  versionId: corporateActions.versionId,
  caId: corporateActions.caId,
  instrumentId: corporateActions.instrumentId,
  caType: corporateActions.caType,
  status: corporateActions.status,
  declaredDate: corporateActions.declaredDate,
  exDate: corporateActions.exDate,
  recordDate: corporateActions.recordDate,
  payDate: corporateActions.payDate,
  effectiveDate: corporateActions.effectiveDate,
  amount: corporateActions.amount,
  currency: corporateActions.currency,
  ratioNew: corporateActions.ratioNew,
  ratioOld: corporateActions.ratioOld,
  newInstrumentId: corporateActions.newInstrumentId,
  frequency: corporateActions.frequency,
  grossOrNet: corporateActions.grossOrNet,
  details: corporateActions.details,
  note: corporateActions.note,
  sourceId: corporateActions.sourceId,
  reviewState: corporateActions.reviewState,
  reviewedBy: corporateActions.reviewedBy,
  reviewedAt: corporateActions.reviewedAt,
  provenanceId: corporateActions.provenanceId,
  validFrom: corporateActions.validFrom,
  validTo: corporateActions.validTo,
} as const;

function toRecord(row: ActionRow): CorporateActionRecord {
  return {
    versionId: row.versionId,
    caId: row.caId,
    instrumentId: row.instrumentId,
    caType: row.caType as CaType,
    status: row.status as CaStatus,
    declaredDate: row.declaredDate,
    exDate: row.exDate,
    recordDate: row.recordDate,
    payDate: row.payDate,
    effectiveDate: row.effectiveDate,
    amount: num(row.amount),
    currency: row.currency,
    ratioNew: num(row.ratioNew),
    ratioOld: num(row.ratioOld),
    newInstrumentId: row.newInstrumentId,
    frequency: row.frequency,
    grossOrNet: row.grossOrNet === 'net' ? 'net' : 'gross',
    details:
      typeof row.details === 'object' && row.details !== null
        ? (row.details as Record<string, unknown>)
        : {},
    note: row.note,
    sourceId: row.sourceId,
    reviewState: asReviewState(row.reviewState),
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    provenanceId: row.provenanceId,
    validFrom: row.validFrom,
    validTo: row.validTo,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Corporate actions valid at `at.validAt` as known at `at.knownAt`, ascending by ex-date.
 *
 * This is the read API.md §4 L380 means by "`corporate_actions` **as-of `asOf.knownAt`**": a
 * backtest run as of 2020-07-30 does not see a split recorded on 2020-07-31.
 */
export async function actionsAsOf(
  tx: Tx,
  q: ActionQuery,
  at: AsOf,
): Promise<CorporateActionRecord[]> {
  const conditions: SQL[] = [asOf(btCorporateActions, at)];
  if (q.instrumentId !== undefined) {
    conditions.push(eq(corporateActions.instrumentId, q.instrumentId));
  }
  if (q.instrumentIds !== undefined) {
    if (q.instrumentIds.length === 0) return [];
    conditions.push(inArray(corporateActions.instrumentId, [...q.instrumentIds]));
  }
  if (q.from !== undefined) {
    conditions.push(gte(corporateActions.exDate, assertDate(q.from, 'from')));
  }
  if (q.to !== undefined) conditions.push(lte(corporateActions.exDate, assertDate(q.to, 'to')));
  if (q.after !== undefined) {
    conditions.push(gt(corporateActions.exDate, assertDate(q.after, 'after')));
  }
  if (q.caTypes !== undefined) {
    if (q.caTypes.length === 0) return [];
    conditions.push(inArray(corporateActions.caType, [...q.caTypes]));
  }
  if (q.statuses !== undefined) {
    if (q.statuses.length === 0) return [];
    conditions.push(inArray(corporateActions.status, [...q.statuses]));
  }
  if (q.reviewStates !== undefined) {
    if (q.reviewStates.length === 0) return [];
    conditions.push(inArray(corporateActions.reviewState, [...q.reviewStates]));
  }

  const rows = await tx
    .select(ACTION_FIELDS)
    .from(corporateActions)
    .where(and(...conditions))
    .orderBy(asc(corporateActions.exDate), asc(corporateActions.caId));
  return rows.map(toRecord);
}

/** One action by its surrogate key, or `null`. */
export async function actionAsOf(
  tx: Tx,
  caId: number,
  at: AsOf,
): Promise<CorporateActionRecord | null> {
  const rows = await tx
    .select(ACTION_FIELDS)
    .from(corporateActions)
    .where(and(eq(corporateActions.caId, caId), asOf(btCorporateActions, at)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

/** The currently-believed, currently-valid version of one action, or `null`. */
async function currentVersion(tx: Tx, caId: number): Promise<CorporateActionRecord | null> {
  const rows = await tx
    .select(ACTION_FIELDS)
    .from(corporateActions)
    .where(and(eq(corporateActions.caId, caId), sql`${corporateActions.txTo} = 'infinity'`))
    // An action with several valid ranges (a status that moved) is reviewed on its latest one.
    .orderBy(desc(corporateActions.validFrom))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

/** The REF-10 queue behind `GET /admin/ca-queue` (API.md L802). */
export async function reviewQueue(
  tx: Tx,
  at: AsOf,
  q: Omit<ActionQuery, 'reviewStates'> = {},
): Promise<CorporateActionRecord[]> {
  return actionsAsOf(tx, { ...q, reviewStates: ['queued'] }, at);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The WP-02 hand-off (REF-09)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Whether this version may move a price at all (REF-10; `cancelled`/`estimated` are core's job). */
export function isAdjusting(action: CorporateActionRecord): boolean {
  return ADJUSTING_REVIEW_STATES.has(action.reviewState);
}

/** One row in the shape `@terminal/core`'s `adjustmentFactors` takes. */
export function toCaForAdjust(action: CorporateActionRecord): CaForAdjust {
  const out: CaForAdjust = {
    caType: action.caType,
    status: action.status,
    exDate: action.exDate,
  };
  if (action.amount !== null) out.amount = action.amount;
  if (action.ratioNew !== null) out.ratioNew = action.ratioNew;
  if (action.ratioOld !== null) out.ratioOld = action.ratioOld;
  return out;
}

/**
 * Unadjusted daily closes for `[start, end]`, **plus the last session strictly before `start`**
 * when `withLeadIn` (the default): `adjustmentFactors` needs that close for a cash action whose
 * ex-date is the first session of the window, and there is no calendar arithmetic that can find
 * it reliably across holidays — the database knows which session was last.
 *
 * Ascending by date. `bars_daily` is always unadjusted (DATA_MODEL §7.2); `src_adj_close` is
 * never read here, or anywhere.
 */
export async function loadCloses(
  tx: Tx,
  instrumentId: number,
  start: string,
  end: string,
  withLeadIn = true,
): Promise<CloseRow[]> {
  assertDate(start, 'start');
  assertDate(end, 'end');
  const window = await tx
    .select({
      date: barsDaily.sessionDate,
      close: barsDaily.close,
      provenanceId: barsDaily.provenanceId,
    })
    .from(barsDaily)
    .where(
      and(
        eq(barsDaily.instrumentId, instrumentId),
        gte(barsDaily.sessionDate, start),
        lte(barsDaily.sessionDate, end),
      ),
    )
    .orderBy(asc(barsDaily.sessionDate));

  const rows: CloseRow[] = [];
  if (withLeadIn) {
    const lead = await tx
      .select({
        date: barsDaily.sessionDate,
        close: barsDaily.close,
        provenanceId: barsDaily.provenanceId,
      })
      .from(barsDaily)
      .where(
        and(eq(barsDaily.instrumentId, instrumentId), sql`${barsDaily.sessionDate} < ${start}`),
      )
      .orderBy(sql`${barsDaily.sessionDate} DESC`)
      .limit(1);
    const row = lead[0];
    if (row !== undefined) {
      rows.push({ date: row.date, close: Number(row.close), provenanceId: row.provenanceId });
    }
  }
  for (const row of window) {
    rows.push({ date: row.date, close: Number(row.close), provenanceId: row.provenanceId });
  }
  return rows;
}

const CASH_TYPES: ReadonlySet<CaType> = new Set<CaType>([
  'cash_dividend',
  'special_dividend',
  'capital_return',
]);

/**
 * The whole REF-09 read path short of applying the factors: the actions as-of the request, the
 * `FactorStep[]` WP-02 computes from them, and the unadjusted closes for the requested window —
 * with the lead-in session used for the factors and then dropped, which is the entire point of
 * loading `[start − 1 session, end]`.
 *
 * `data/historical.ts` calls this, applies `applyAdjustment` to its bars and echoes `steps` as
 * `meta.adjustments`.
 */
export async function loadAdjustment(tx: Tx, req: AdjustmentRequest): Promise<AdjustmentContext> {
  assertDate(req.start, 'start');
  assertDate(req.end, 'end');
  const through = req.actionsThrough ?? utcDate(req.asOf.validAt);

  const actions =
    req.policy === 'unadjusted'
      ? []
      : await actionsAsOf(
          tx,
          { instrumentId: req.instrumentId, after: req.start, to: through },
          req.asOf,
        );
  const applied = actions.filter(isAdjusting);
  const skipped = actions.filter((a) => !isAdjusting(a));

  // A cash action after `end` still needs the close before ITS ex-date, so the load is stretched
  // to reach it; the stretch is trimmed off `closes` again below. Only `total_return` uses cash
  // factors at all, so nothing else ever pays for the extra rows.
  let closeEnd = req.end;
  if (req.policy === 'total_return') {
    for (const action of applied) {
      if (CASH_TYPES.has(action.caType) && action.exDate > closeEnd) closeEnd = action.exDate;
    }
  }

  const loaded = await loadCloses(tx, req.instrumentId, req.start, closeEnd);
  const steps = adjustmentFactors(applied.map(toCaForAdjust), loaded, req.policy);

  const closes = loaded.filter((row) => row.date >= req.start && row.date <= req.end);
  const leadIn = loaded.find((row) => row.date < req.start) ?? null;

  const provenanceIds = [
    ...new Set([...closes.map((c) => c.provenanceId), ...applied.map((a) => a.provenanceId)]),
  ].sort((a, b) => a - b);

  return { steps, applied, skipped, closes, leadIn, provenanceIds };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One corporate action to record. Everything not given keeps the column default. */
export interface ActionWrite {
  /** Force a `ca_id`; otherwise the natural key decides between reuse and `ca_id_seq`. */
  caId?: number;
  instrumentId: number;
  caType: CaType;
  status: CaStatus;
  exDate: string;
  declaredDate?: string | null;
  recordDate?: string | null;
  payDate?: string | null;
  effectiveDate?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  ratioNew?: number | string | null;
  ratioOld?: number | string | null;
  newInstrumentId?: number | null;
  frequency?: string | null;
  grossOrNet?: 'gross' | 'net';
  details?: Record<string, unknown>;
  note?: string | null;
  /** `'yahoo.chart'` | `'sec.atom'` | `'internal.user'` — part of the natural key. */
  sourceId: string;
  /** Default `'auto'`. A feed parse passes `'queued'` (PROVIDERS §5.5 L959). */
  reviewState?: ReviewState;
  reviewedBy?: number | null;
  reviewedAt?: string | null;
  provenanceId: number;
  /** Valid from: when the action became a fact in the world. Default `declaredDate ?? exDate`. */
  validFrom?: Date;
  /** Known at: the Yahoo event date, the filing's `acceptanceDateTime`. Default `clock_timestamp()`. */
  txFrom?: Date;
}

/** What a write did. `versionId` is `null` when the row already said exactly this. */
export interface ActionWriteResult {
  caId: number;
  versionId: number | null;
}

/** The `ca_id` of the current version with this natural key, or `null`. */
async function caIdOfNaturalKey(
  tx: Tx,
  key: { instrumentId: number; caType: CaType; exDate: string; sourceId: string },
): Promise<number | null> {
  const rows = await tx
    .select({ caId: corporateActions.caId })
    .from(corporateActions)
    .where(
      and(
        eq(corporateActions.instrumentId, key.instrumentId),
        eq(corporateActions.caType, key.caType),
        eq(corporateActions.exDate, key.exDate),
        eq(corporateActions.sourceId, key.sourceId),
        sql`${corporateActions.txTo} = 'infinity'`,
      ),
    )
    .limit(1);
  return rows[0]?.caId ?? null;
}

/** Every non-bitemporal column, so a write always states the whole action. */
function actionData(
  caId: number,
  w: ActionWrite,
): Omit<
  typeof corporateActions.$inferSelect,
  'versionId' | 'validFrom' | 'validTo' | 'txFrom' | 'txTo' | 'provenanceId'
> {
  return {
    caId,
    instrumentId: w.instrumentId,
    caType: w.caType,
    status: w.status,
    declaredDate: w.declaredDate ?? null,
    exDate: assertDate(w.exDate, 'exDate'),
    recordDate: w.recordDate ?? null,
    payDate: w.payDate ?? null,
    effectiveDate: w.effectiveDate ?? null,
    amount: numericIn(w.amount),
    currency: w.currency ?? null,
    ratioNew: numericIn(w.ratioNew),
    ratioOld: numericIn(w.ratioOld),
    newInstrumentId: w.newInstrumentId ?? null,
    frequency: w.frequency ?? null,
    grossOrNet: w.grossOrNet ?? 'gross',
    details: w.details ?? {},
    note: w.note ?? null,
    sourceId: w.sourceId,
    reviewState: w.reviewState ?? 'auto',
    reviewedBy: w.reviewedBy ?? null,
    reviewedAt: w.reviewedAt ?? null,
  };
}

/**
 * Record one corporate action: reuse the `ca_id` of the current version with the same natural
 * key `(instrument_id, ca_type, ex_date, source_id)` if there is one, allocate from `ca_id_seq`
 * otherwise, and write a version through `upsertVersion` — so a re-run writes nothing at all
 * (`versionId: null`) when the feed repeats itself.
 *
 * Reuse is not an optimisation. Allocating a fresh `ca_id` for an action the feed has already
 * reported violates `corporate_actions_natural_excl` (`23P01`) and takes the ingest run down with
 * it, so every re-parse of the same `events` block must land on the same surrogate key.
 *
 * @throws RangeError when `ratioNew` and `ratioOld` are not both present or both absent
 *         (`corporate_actions_ratio_chk` would reject it anyway; this says so in TypeScript terms).
 */
export async function recordAction(tx: Tx, w: ActionWrite): Promise<ActionWriteResult> {
  const ratioNew = numericIn(w.ratioNew);
  const ratioOld = numericIn(w.ratioOld);
  if ((ratioNew === null) !== (ratioOld === null)) {
    throw new RangeError(
      `recordAction(${w.caType} ${w.exDate}): ratioNew and ratioOld must both be set or both be null`,
    );
  }

  const existing =
    w.caId ??
    (await caIdOfNaturalKey(tx, {
      instrumentId: w.instrumentId,
      caType: w.caType,
      exDate: w.exDate,
      sourceId: w.sourceId,
    }));
  const caId = existing ?? (await nextCaId(tx));

  const validFrom = w.validFrom ?? instantOfDate(w.declaredDate ?? w.exDate);
  const write: VersionWrite<typeof corporateActions.$inferSelect> = {
    entityKey: { caId },
    validFrom,
    data: actionData(caId, w),
    provenanceId: w.provenanceId,
    reason: existing === undefined || existing === null ? 'initial' : 'change',
  };
  if (w.txFrom !== undefined) write.txFrom = w.txFrom;
  // `upsertVersion`, not `writeVersion`: re-parsing yesterday's `events` block must write
  // nothing at all (QA-02), and "nothing changed" is the ordinary outcome of an ingest re-run.
  return { caId, versionId: await upsertVersion(tx, btCorporateActions, write) };
}

/** A fresh surrogate key from `ca_id_seq` (migration 0003 L3). */
export async function nextCaId(tx: Tx): Promise<number> {
  const res = await tx.execute<{ ca_id: string }>(sql`SELECT nextval('ca_id_seq') AS ca_id`);
  const row = res.rows[0];
  if (row === undefined) throw new Error("nextval('ca_id_seq') returned no row");
  return Number(row.ca_id);
}

/**
 * Enter a corporate action by hand (REF-10, first key): `review_state 'queued'`, the entering
 * user recorded in `details.enteredBy`, and no effect on any price until a **different** data-ops
 * user reviews it.
 */
export async function enterAction(
  tx: Tx,
  w: ActionWrite & { enteredByUserId: number },
): Promise<ActionWriteResult> {
  const { enteredByUserId, ...rest } = w;
  return recordAction(tx, {
    ...rest,
    reviewState: 'queued',
    details: { ...(w.details ?? {}), enteredBy: enteredByUserId },
    reviewedBy: null,
    reviewedAt: null,
  });
}

/** One review decision (REF-10, second key) — `POST /admin/ca-queue/:caId/review`. */
export interface ReviewDecision {
  caId: number;
  decision: 'reviewed' | 'rejected';
  /** The data-ops user deciding. Must not be the user who entered the action. */
  reviewerUserId: number;
  /** The provenance row for the review itself (`internal.user`). */
  provenanceId: number;
  note?: string;
  /** Default: `txFrom`, or the database clock. */
  reviewedAt?: Date;
  /** The knowledge instant of the review. Default `clock_timestamp()`. */
  txFrom?: Date;
}

/**
 * Apply a review decision (REF-10 dual key).
 *
 * The decision is a **correction** on the transaction-time axis: the same valid range, every
 * other column carried over verbatim from the version being reviewed, a later `tx_from`. A read
 * as of before the review therefore still returns `'queued'` — and `loadAdjustment` still refuses
 * to move a price with it — which is what makes the audit trail worth keeping.
 *
 * @throws CaReviewError `'ca_not_found'` when no current version exists, `'ca_not_queued'` when
 *         the action is not awaiting review (an `'auto'` feed row, or one already decided), and
 *         `'ca_dual_key'` when the reviewer is the user who entered it.
 */
export async function reviewAction(
  tx: Tx,
  decision: ReviewDecision,
): Promise<CorporateActionRecord> {
  const currentRow = await currentVersion(tx, decision.caId);
  if (currentRow === null) {
    throw new CaReviewError(
      'ca_not_found',
      `corporate action ${decision.caId} has no current version`,
    );
  }
  if (currentRow.reviewState !== 'queued') {
    throw new CaReviewError(
      'ca_not_queued',
      `corporate action ${decision.caId} is '${currentRow.reviewState}', not 'queued'`,
    );
  }
  const enteredBy = currentRow.details.enteredBy;
  if (typeof enteredBy === 'number' && enteredBy === decision.reviewerUserId) {
    throw new CaReviewError(
      'ca_dual_key',
      `user ${decision.reviewerUserId} entered corporate action ${decision.caId} and may not ` +
        'review it: REF-10 requires a second pair of eyes',
    );
  }

  const txFrom = decision.txFrom ?? (await clockInstant(tx));
  const reviewedAt = decision.reviewedAt ?? txFrom;

  const write: VersionWrite<typeof corporateActions.$inferSelect> = {
    entityKey: { caId: decision.caId },
    validFrom: new Date(currentRow.validFrom),
    data: {
      ...actionData(decision.caId, {
        instrumentId: currentRow.instrumentId,
        caType: currentRow.caType,
        status: currentRow.status,
        exDate: currentRow.exDate,
        declaredDate: currentRow.declaredDate,
        recordDate: currentRow.recordDate,
        payDate: currentRow.payDate,
        effectiveDate: currentRow.effectiveDate,
        amount: currentRow.amount,
        currency: currentRow.currency,
        ratioNew: currentRow.ratioNew,
        ratioOld: currentRow.ratioOld,
        newInstrumentId: currentRow.newInstrumentId,
        frequency: currentRow.frequency,
        grossOrNet: currentRow.grossOrNet,
        details: currentRow.details,
        note: decision.note ?? currentRow.note,
        sourceId: currentRow.sourceId,
        provenanceId: decision.provenanceId,
      }),
      reviewState: decision.decision,
      reviewedBy: decision.reviewerUserId,
      reviewedAt: reviewedAt.toISOString(),
    },
    provenanceId: decision.provenanceId,
    reason: 'correction',
    txFrom,
  };
  if (currentRow.validTo !== 'infinity') write.validTo = new Date(currentRow.validTo);

  await writeVersion(tx, btCorporateActions, write);
  const reviewed = await actionAsOf(tx, decision.caId, {
    validAt: new Date(currentRow.validFrom),
    knownAt: txFrom,
  });
  if (reviewed === null) {
    throw new Error(`reviewAction(${decision.caId}): the new version could not be read back`);
  }
  return reviewed;
}

/** One `clock_timestamp()`, read once so a close and its successor share an instant. */
async function clockInstant(tx: Tx): Promise<Date> {
  const res = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
  const row = res.rows[0];
  if (row === undefined) throw new Error('clock_timestamp() returned no row');
  return row.now;
}
