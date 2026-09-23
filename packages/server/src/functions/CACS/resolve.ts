/**
 * `functions/CACS/resolve.ts` — the corporate-action timeline (FUNCTIONS_TIER2.md §CACS L897-916).
 *
 * ## DATA-08's ladder, reported rather than completed
 *
 * `estimated → announced → confirmed → paid` is a claim about what was publicly known when. The
 * reachable event feed publishes an action only *after* its ex-date, so the first two rungs exist
 * for real only where data operations entered a row by hand (`internal.user`). Rather than leave
 * that as a silence the screen cannot distinguish from "nothing was announced", every run emits
 * `ESTIMATED_CA_UNAVAILABLE`, and the seven `ca_type` values no source publishes each get their
 * own `unavailable` entry. What the resolver *does* contribute forward of today is one **projected**
 * row: `caId: null`, `status: 'estimated'`, `sourceId: 'internal.derived'`, `projected: true`, and
 * a `projectionBasis` naming the cadence it came from. It is never written to `corporate_actions`.
 *
 * ## One adjustment implementation (REF-09)
 *
 * `adjFactor` is not computed here. Each row is handed to `core/adjust/corporateActions.ts`
 * (`adjustmentFactors`), the single implementation `data/historical.ts` also uses, so a factor on
 * this screen and the factor HP applied to the same session are the same number by construction
 * rather than by agreement. Two notes on how it is called:
 *
 *  - the policy passed is `'total_return'`, because that is the policy under which the engine
 *    yields a step for **both** families — `ratioOld / ratioNew` for splits and
 *    `1 − amount / close(ex − 1 session)` for cash. Under `'price'` the engine (correctly) emits
 *    no step for a cash dividend, and §CACS's own worked example (`4:1` split and the quarterly
 *    dividends composing to `0.24866`) is the total-return product. `cumulativeAdjFactor` is
 *    therefore the product of both families, exactly as §CACS tabulates it;
 *  - the engine throws when a cash action has no close on the session before its ex-date. That is
 *    caught per row and becomes `adjFactor: null` plus `ADJ_FACTOR_NO_CLOSE`, never a factor of 1,
 *    which would silently under-adjust every bar before that date.
 *
 * ## Point in time
 *
 * `knownAt = min(params.knownAt, ctx.asOf.knownAt)`: a user may look back at what the timeline said
 * on an earlier date, never forward of the request (STOR-06). Both reads — the actions and the
 * filings — are made at that instant, so a dividend corrected after it is invisible at the earlier
 * `knownAt` and present at the later one.
 */

import { sql } from 'drizzle-orm';

import type { CaForAdjust, CaType } from '@terminal/core/adjust/corporateActions';
import { adjustmentFactors } from '@terminal/core/adjust/corporateActions';
import type {
  CacsAction,
  CacsEarnings,
  CacsIssuerPayload,
  CacsMemberAction,
  CacsMembersPayload,
  CacsParams,
  CacsPayload,
  CacsProjection,
} from '@terminal/core/functions/manifests/CACS';
import {
  CACS_NOTE_ADJ_NO_CLOSE,
  CACS_NOTE_COVERAGE_PARTIAL,
  CACS_NOTE_EARNINGS_NOT_APPLICABLE,
  CACS_NOTE_ESTIMATED_UNAVAILABLE,
  CACS_NOTE_MEMBER_SUBSET,
  CACS_NOTE_MEMBERSHIP_STALE,
  CACS_NOTE_PROJECTED_ROW,
  CACS_NOTE_PROJECTION_INSUFFICIENT,
  CACS_NOTE_REVIEW_PENDING,
  CACS_NOTE_TYPES_NO_SOURCE,
  CACS_PROJECTION_HIGH_CONFIDENCE_ROWS,
  CACS_PROJECTION_MIN_ROWS,
  CACS_UNSOURCED_TYPES,
} from '@terminal/core/functions/manifests/CACS';
import { canonicalJson, sha256Hex } from '@terminal/core';
import type { AssetClass } from '@terminal/core';

import type { FunctionResolver, ResolveContext } from '../context.js';
import { ProviderUnavailableError } from '../context.js';
import type { CloseRow, CorporateActionRecord } from '../../refdata/corporateActions.js';
import { actionsAsOf, loadCloses } from '../../refdata/corporateActions.js';
import { findIndexByInstrumentId } from '../../refdata/indexMembership.js';
import { citeProvenanceIds } from '../MEMB/resolve.js';
import { cellFromState } from '../shared/cells.js';
import { displayOf } from '../shared/instrumentSummary.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Dates
// ─────────────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function shiftDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}

function shiftYears(at: Date, years: number): Date {
  const out = new Date(at.getTime());
  out.setUTCFullYear(out.getUTCFullYear() + years);
  return out;
}

/** §CACS step 1: never forward of the request's own `knownAt`. */
function pitKnownAt(ctx: ResolveContext, params: CacsParams): Date {
  if (params.knownAt === undefined) return ctx.asOf.knownAt;
  const asked = new Date(params.knownAt);
  return asked.getTime() < ctx.asOf.knownAt.getTime() ? asked : ctx.asOf.knownAt;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface KeyRow extends Record<string, unknown> {
  instrument_id: string;
  ticker: string;
  exch_code: string;
  market_sector: string;
  name: string;
  currency: string;
}

async function keysFor(
  ctx: ResolveContext,
  ids: readonly number[],
): Promise<Map<number, { key: string; name: string; currency: string }>> {
  const out = new Map<number, { key: string; name: string; currency: string }>();
  if (ids.length === 0) return out;
  const validAt = ctx.asOf.validAt.toISOString();
  const knownAt = ctx.asOf.knownAt.toISOString();
  const res = await ctx.db.execute<KeyRow>(sql`
    SELECT instrument_id::text AS instrument_id, ticker, exch_code,
           market_sector::text AS market_sector, name, currency
      FROM instruments
     WHERE instrument_id = ANY(${sql.param(ids.map(String))}::bigint[])
       AND bt_as_of(valid_from, valid_to, tx_from, tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)`);
  for (const row of res.rows) {
    out.set(Number(row.instrument_id), {
      key: displayOf(row.ticker, row.exch_code, row.market_sector as never),
      name: row.name,
      currency: row.currency,
    });
  }
  return out;
}

/** The engine's own factor for one action, or `null` with the reason it could not be computed. */
function factorOf(
  action: CaForAdjust,
  closes: readonly CloseRow[],
): { factor: number | null; noClose: boolean } {
  try {
    const steps = adjustmentFactors([action], closes, 'total_return');
    const step = steps[0];
    return { factor: step === undefined ? null : step.priceFactor, noClose: false };
  } catch {
    // `closeBeforeEx` throws when no session precedes the ex-date in the loaded window, and
    // `adjustmentFactors` throws on a dividend at or above that close. Both are "cannot compute",
    // and a factor of 1 would be a lie about an adjustment that really happened.
    return { factor: null, noClose: true };
  }
}

function toAction(
  record: CorporateActionRecord,
  meta: { key: string; newKey: string | null },
  provIdx: number,
  adjFactor: number | null,
): CacsAction {
  return {
    caId: record.caId,
    instrumentId: record.instrumentId,
    key: meta.key,
    caType: record.caType,
    status: record.status,
    declaredDate: record.declaredDate,
    exDate: record.exDate,
    recordDate: record.recordDate,
    payDate: record.payDate,
    effectiveDate: record.effectiveDate,
    amount: record.amount,
    currency: record.currency,
    ratioNew: record.ratioNew,
    ratioOld: record.ratioOld,
    newInstrumentId: record.newInstrumentId,
    newKey: meta.newKey,
    frequency: record.frequency,
    grossOrNet: record.grossOrNet,
    details: record.details,
    note: record.note,
    sourceId: record.sourceId,
    reviewState: record.reviewState,
    adjFactor,
    projected: false,
    projectionBasis: null,
    provIdx,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Unavailable entries every run carries (§CACS "Unavailable and reason codes")
// ─────────────────────────────────────────────────────────────────────────────────────────────

function reportUnsourcedTypes(ctx: ResolveContext, params: CacsParams, notes: string[]): void {
  const requested = CACS_UNSOURCED_TYPES.filter((t) => params.types.includes(t));
  if (requested.length === 0) return;
  notes.push(CACS_NOTE_TYPES_NO_SOURCE);
  for (const caType of requested) {
    ctx.unavailable.add({
      field: caType,
      reason: 'NO_SOURCE',
      detail:
        `${CACS_NOTE_TYPES_NO_SOURCE}: no reachable source publishes ${caType.replace('_', ' ')} ` +
        'terms; the yahoo.chart event feed carries dividends and splits only (BRIEF §2)',
    });
  }
}

/**
 * The terms a row does not have *because of what it is* (FUNCTIONS.md §1.3 rule 6, per cell).
 *
 * One `corporate_actions` row shape carries every family's terms, so a cash dividend has no split
 * ratio and a split has no amount — declared numeric columns that are legitimately blank on most
 * rows. The runner cannot tell that from an accident, and neither can a user looking at the grid,
 * so each blank column says once, in the footer, that it is the family and not a missing source.
 * The two genuine gaps keep their own entries: `ADJ_FACTOR_NO_CLOSE` (no session close before the
 * ex-date) and the unsourced action types.
 */
function reportPerTypeGaps(ctx: ResolveContext, actions: readonly CacsAction[]): void {
  const say = (field: string, detail: string): void => {
    ctx.unavailable.add({ field, reason: 'NOT_APPLICABLE', detail });
  };
  if (actions.some((a) => a.amount === null)) {
    say(
      'actions.amount',
      'only a cash, special or stock dividend carries an amount; a split, a name change or a ' +
        'ticker change has none',
    );
  }
  if (actions.some((a) => a.ratioNew === null || a.ratioOld === null)) {
    say(
      'actions.ratioNew',
      'only a split, a reverse split or a stock dividend carries a ratio; a cash action has none',
    );
    say(
      'actions.ratioOld',
      'only a split, a reverse split or a stock dividend carries a ratio; a cash action has none',
    );
  }
  if (actions.some((a) => a.adjFactor === null && (a.projected || a.caType === 'name_change'))) {
    say(
      'actions.adjFactor',
      'a row that does not move the price (a name or ticker change) and the PROJECTED row have no ' +
        'price adjustment factor; a dividend whose ex-date session has no close is reported ' +
        `separately as ${CACS_NOTE_ADJ_NO_CLOSE}`,
    );
  }
}

function reportEstimatedGap(ctx: ResolveContext, notes: string[]): void {
  notes.push(CACS_NOTE_ESTIMATED_UNAVAILABLE);
  ctx.unavailable.add({
    field: 'status.estimated',
    reason: 'NO_SOURCE',
    detail:
      `${CACS_NOTE_ESTIMATED_UNAVAILABLE}: the event feed publishes an action only after its ` +
      'ex-date, so pre-announcement (declared-but-not-ex) rows exist only for actions entered by ' +
      'data operations (internal.user); the PROJECTED row is the resolver’s cadence ' +
      'estimate, not an announcement (DATA-08)',
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Projection (§CACS step 8)
// ─────────────────────────────────────────────────────────────────────────────────────────────

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function projectNext(cash: readonly CacsAction[]): CacsProjection | null {
  if (cash.length < CACS_PROJECTION_MIN_ROWS) return null;
  const byDate = [...cash].sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
  const gaps: number[] = [];
  for (let i = 1; i < byDate.length; i += 1) {
    const prev = byDate[i - 1];
    const next = byDate[i];
    if (prev === undefined || next === undefined) continue;
    gaps.push(Math.round((Date.parse(next.exDate) - Date.parse(prev.exDate)) / DAY_MS));
  }
  if (gaps.length === 0) return null;
  const gap = Math.round(median(gaps));
  const last = byDate.at(-1);
  if (last === undefined) return null;
  const n = byDate.length;
  return {
    exDate: isoDate(shiftDays(new Date(`${last.exDate}T00:00:00Z`), gap)),
    amount: last.amount,
    basis: `median gap of last ${String(n)} cash dividends = ${String(gap)} d`,
    confidence: n >= CACS_PROJECTION_HIGH_CONFIDENCE_ROWS ? 0.6 : 0.4,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Earnings (§CACS step 6)
// ─────────────────────────────────────────────────────────────────────────────────────────────


/**
 * A stored timestamp as ISO 8601.
 *
 * `data/filings.ts` returns `accepted_at` and `captured_at` as Postgres renders them
 * (`2026-07-31 20:31:00+00`), while every other reader returns ISO. A payload that mixes the two
 * formats in one list breaks the screen's sort and its formatter — FUNCTIONS.md §1.3 rule 3 wants
 * one instant format — so both are normalised here rather than left for each screen to guess at.
 * An unparseable value is returned unchanged: inventing an instant would be worse than echoing
 * what was stored.
 */
export function isoInstant(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

/**
 * `pre` / `post` / `intraday` from the ET hour of `accepted_at` — the identical rule EE uses, so
 * the two screens never disagree about the same 8-K.
 */
export function reportTimingOf(acceptedAt: string | null): CacsEarnings['reportTiming'] {
  if (acceptedAt === null) return 'unknown';
  const et = new Date(acceptedAt).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const [hourText, minuteText] = et.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isFinite(hour)) return 'unknown';
  if (hour < 9 || (hour === 9 && minute < 30)) return 'pre';
  if (hour >= 16) return 'post';
  return 'intraday';
}


// ─────────────────────────────────────────────────────────────────────────────────────────────
// Freshness probes (§CACS step 2, step 6)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Was any version of this instrument's corporate actions recorded in the last 24 h?
 *
 * §CACS step 2 makes the read-through conditional on exactly this, and the condition is what keeps
 * an ordinary screen off the provider path entirely: `ensure` would probe the store and return
 * `{ fresh: true }` in the same case, but only after a round-trip and a request-key hash, and a
 * circuit that happens to be open would then be reported as a staleness the data does not have.
 */
async function actionsAreFresh(ctx: ResolveContext, instrumentId: number): Promise<boolean> {
  const since = new Date(ctx.clock.now() - 86_400_000).toISOString();
  const res = await ctx.db.execute<{ fresh: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM corporate_actions
       WHERE instrument_id = ${instrumentId}::bigint
         AND tx_to = 'infinity'
         AND tx_from >= ${since}::timestamptz
    ) AS fresh`);
  return res.rows[0]?.fresh === true;
}

/** The same probe for the submissions index behind the earnings block. */
async function filingsAreFresh(ctx: ResolveContext, cik: string): Promise<boolean> {
  const since = new Date(ctx.clock.now() - 21_600_000).toISOString();
  const res = await ctx.db.execute<{ fresh: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM filings
       WHERE cik = ${cik}
         AND captured_at >= ${since}::timestamptz
    ) AS fresh`);
  return res.rows[0]?.fresh === true;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// issuer variant
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ISSUER_FUTURE_FIRST = (a: CacsAction, b: CacsAction): number =>
  a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : 0;

async function issuer(ctx: ResolveContext, params: CacsParams): Promise<CacsIssuerPayload> {
  const instrument = ctx.instrument;
  if (instrument === null) throw new TypeError('CACS: the issuer variant needs a security');

  const knownAt = pitKnownAt(ctx, params);
  const validAt = ctx.asOf.validAt;
  const todayIso = isoDate(validAt);
  const notes: string[] = [];

  const detail = await ctx.data.reference.instrument(instrument.instrumentId);
  const key = displayOf(instrument.ticker, instrument.exchCode, instrument.marketSector);
  const cik = detail.issuer?.cik ?? null;

  const from = params.from ?? isoDate(shiftYears(validAt, -2));
  const to = params.to ?? isoDate(shiftDays(validAt, 90));

  // 2 — the event feed, refreshed only when the stored history is older than a day (§CACS step 2).
  // A stored history is served whether or not the refresh succeeds; a dead upstream is a fact
  // about freshness, not a reason to show nothing (TERM-12).
  const mdLine = detail.mdLines.find((l) => l.sourceId === 'yahoo.chart');
  if (mdLine === undefined) {
    ctx.unavailable.add({
      field: 'actions',
      reason: 'NO_SOURCE',
      detail: 'instrument has no yahoo.chart market-data line, so no event history is reachable',
    });
  } else if (ctx.usage !== 'export' && !(await actionsAreFresh(ctx, instrument.instrumentId))) {
    try {
      await ctx.providers.ensure('yahoo.daily', mdLine.providerSymbol, { maxAgeMs: 86_400_000 });
    } catch (err) {
      if (!(err instanceof ProviderUnavailableError)) throw err;
      ctx.unavailable.add({
        field: 'actions',
        reason: 'NO_SOURCE',
        detail: 'PROVIDER_DOWN: serving the stored corporate-action history',
      });
    }
  }

  // 3 — the rows, bitemporally as-of (validAt, knownAt).
  const records = await actionsAsOf(
    ctx.db,
    {
      instrumentId: instrument.instrumentId,
      from,
      to,
      caTypes: params.types,
      statuses: params.status,
    },
    { validAt, knownAt },
  );

  // 4 — the adjustment factors, from the one implementation.
  const closes = await loadCloses(ctx.db, instrument.instrumentId, from, to);
  const newKeys = await keysFor(
    ctx,
    records.map((r) => r.newInstrumentId).filter((id): id is number => id !== null),
  );

  let noCloseRows = 0;
  let reviewPending = false;
  const actions: CacsAction[] = [];
  for (const record of records) {
    const provIdx = ctx.prov.add({
      sourceId: record.sourceId,
      provenanceId: record.provenanceId,
      capturedAt: new Date(record.validFrom),
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    });
    const computed = factorOf(
      {
        caType: record.caType,
        status: record.status,
        exDate: record.exDate,
        ...(record.amount === null ? {} : { amount: record.amount }),
        ...(record.ratioNew === null ? {} : { ratioNew: record.ratioNew }),
        ...(record.ratioOld === null ? {} : { ratioOld: record.ratioOld }),
      },
      closes,
    );
    if (computed.noClose) noCloseRows += 1;
    if (record.reviewState === 'queued') reviewPending = true;
    actions.push(
      toAction(
        record,
        {
          key,
          newKey:
            record.newInstrumentId === null
              ? null
              : (newKeys.get(record.newInstrumentId)?.key ?? null),
        },
        provIdx,
        computed.factor,
      ),
    );
  }
  if (noCloseRows > 0) {
    ctx.unavailable.add({
      field: 'adjFactor',
      reason: 'NO_SOURCE',
      detail:
        `${CACS_NOTE_ADJ_NO_CLOSE}: no bars_daily close on the session before the ex-date for ` +
        `${String(noCloseRows)} row(s), so the cash-dividend factor cannot be computed`,
    });
    notes.push(CACS_NOTE_ADJ_NO_CLOSE);
  }
  if (reviewPending) notes.push(CACS_NOTE_REVIEW_PENDING);

  ctx.engines.add({
    name: 'adjust/corporateActions',
    version: '1.0.0',
    inputsHash: sha256Hex(
      canonicalJson({
        instrumentId: instrument.instrumentId,
        window: { from, to },
        policy: 'price',
        caIds: records.map((r) => r.caId),
      }),
    ),
  });

  // 5 — name and ticker changes, which no event feed carries.
  if (params.types.includes('name_change')) {
    for (const former of detail.issuer?.formerNames ?? []) {
      const at = former.to;
      if (at === undefined || at.slice(0, 10) < from || at.slice(0, 10) > to) continue;
      actions.push({
        caId: null,
        instrumentId: instrument.instrumentId,
        key,
        caType: 'name_change',
        status: 'confirmed',
        declaredDate: null,
        exDate: at.slice(0, 10),
        recordDate: null,
        payDate: null,
        effectiveDate: at.slice(0, 10),
        amount: null,
        currency: null,
        ratioNew: null,
        ratioOld: null,
        newInstrumentId: null,
        newKey: null,
        frequency: null,
        grossOrNet: 'gross',
        details: { fromName: former.name, toName: detail.issuer?.name ?? '' },
        note: null,
        sourceId: 'sec.submissions',
        reviewState: 'auto',
        adjFactor: null,
        projected: false,
        projectionBasis: null,
        provIdx: ctx.prov.add({
          sourceId: 'sec.submissions',
          provenanceId: detail.issuer?.provenanceId ?? 0,
          capturedAt: knownAt,
          sourceTs: null,
          st: 'closed',
          tier: 'eod',
        }),
      });
    }
  }

  // 8 — the projected row.
  const cash = actions.filter(
    (a) => a.caType === 'cash_dividend' || a.caType === 'special_dividend',
  );
  const nextProjected = params.includeProjected ? projectNext(cash) : null;
  if (params.includeProjected && nextProjected === null) {
    notes.push(CACS_NOTE_PROJECTION_INSUFFICIENT);
  }
  if (nextProjected !== null && !actions.some((a) => a.exDate === nextProjected.exDate)) {
    notes.push(CACS_NOTE_PROJECTED_ROW);
    actions.push({
      caId: null,
      instrumentId: instrument.instrumentId,
      key,
      caType: 'cash_dividend',
      status: 'estimated',
      declaredDate: null,
      exDate: nextProjected.exDate,
      recordDate: null,
      payDate: null,
      effectiveDate: null,
      amount: nextProjected.amount,
      currency: cash.at(-1)?.currency ?? instrument.currency,
      ratioNew: null,
      ratioOld: null,
      newInstrumentId: null,
      newKey: null,
      frequency: cash.at(-1)?.frequency ?? null,
      grossOrNet: 'gross',
      details: { confidence: nextProjected.confidence },
      note: null,
      sourceId: 'internal.derived',
      reviewState: 'auto',
      adjFactor: null,
      projected: true,
      projectionBasis: nextProjected.basis,
      // A projection cites nothing: no source published it. `-1` is the documented "no
      // provenance" value and `amount` may still be a number, which is why it is a projection.
      provIdx: -1,
    });
  }

  // 6 — earnings.
  const earnings: CacsEarnings[] = [];
  if (params.includeEarnings && cik !== null) {
    if (ctx.usage !== 'export' && !(await filingsAreFresh(ctx, cik))) {
      try {
        await ctx.providers.ensure('sec.submissions', cik, { maxAgeMs: 21_600_000 });
      } catch (err) {
        if (!(err instanceof ProviderUnavailableError)) throw err;
      }
    }
    const page = await ctx.data.filings.list(cik, {
      forms: ['8-K', '8-K/A'],
      from,
      to,
      items: ['2.02'],
      limit: 100,
    });
    for (const filing of page.items) {
      earnings.push({
        accessionNo: filing.accessionNo,
        form: filing.form,
        filedAt: filing.filedDate,
        acceptedAt:
          filing.acceptedAt === null
            ? `${filing.filedDate}T00:00:00.000Z`
            : isoInstant(filing.acceptedAt),
        reportDate: filing.reportDate,
        items8k: filing.items,
        reportTiming: reportTimingOf(filing.acceptedAt),
        url: filing.url,
        provIdx: ctx.prov.add({
          sourceId: 'sec.submissions',
          provenanceId: filing.provenanceId,
          capturedAt: new Date(filing.capturedAt),
          sourceTs: filing.acceptedAt === null ? null : new Date(filing.acceptedAt),
          st: 'closed',
          tier: 'eod',
        }),
      });
    }
  } else if (params.includeEarnings && cik === null) {
    ctx.unavailable.add({
      field: 'earnings',
      reason: 'NO_SOURCE',
      detail: 'issuer has no SEC CIK (not an SEC filer), so no 8-K item 2.02 dates are reachable',
    });
  }

  // 9 — the summary, and its two live cells.
  const subject = ctx.plant.subjectFor(instrument.instrumentId);
  ctx.plant.ensureHot([subject]);
  const pxLast = cellFromState(ctx, ctx.plant.snapshot(subject), 'PX_LAST', subject);

  const ttmFrom = isoDate(shiftDays(validAt, -365));
  const ttmRows = cash.filter(
    (a) =>
      !a.projected &&
      a.exDate >= ttmFrom &&
      a.exDate <= todayIso &&
      (a.status === 'announced' || a.status === 'confirmed' || a.status === 'paid') &&
      a.amount !== null,
  );
  const ttmCashDividend =
    ttmRows.length === 0 ? null : ttmRows.reduce((sum, a) => sum + (a.amount ?? 0), 0);
  const newestDividend = [...ttmRows].sort((a, b) => (a.exDate < b.exDate ? 1 : -1))[0];

  const px = typeof pxLast.v === 'number' ? pxLast.v : null;
  const dvdYield =
    ttmCashDividend === null || px === null || px === 0
      ? { v: null, st: 'na' as const, provIdx: -1 }
      : {
          v: (ttmCashDividend / px) * 100,
          st: 'closed' as const,
          provIdx: newestDividend?.provIdx ?? pxLast.provIdx,
          live: { subject, field: 'DVD_YIELD' as const },
        };
  if (dvdYield.v === null) {
    ctx.unavailable.add({
      field: 'DVD_YIELD',
      reason: 'NO_SOURCE',
      detail:
        'DVD_YIELD needs both a trailing-twelve-month cash dividend and a last price; one of ' +
        'them is absent for this security at this instant',
    });
  }

  const splits = actions
    .filter((a) => a.caType === 'split' || a.caType === 'reverse_split')
    .filter((a) => a.exDate <= todayIso && a.ratioNew !== null && a.ratioOld !== null)
    .sort((a, b) => (a.exDate < b.exDate ? 1 : -1));
  const lastSplitRow = splits[0];

  const cumulativeAdjFactor = actions
    .filter((a) => a.exDate <= todayIso && a.adjFactor !== null)
    .reduce((product, a) => product * (a.adjFactor ?? 1), 1);

  const counts: Partial<Record<CaType, number>> = {};
  for (const a of actions) counts[a.caType] = (counts[a.caType] ?? 0) + 1;

  // 7 — future block first (ascending), then the past block (descending).
  const future = actions.filter((a) => a.exDate > todayIso).sort(ISSUER_FUTURE_FIRST);
  const past = actions.filter((a) => a.exDate <= todayIso).sort((a, b) => -ISSUER_FUTURE_FIRST(a, b));

  reportUnsourcedTypes(ctx, params, notes);
  reportEstimatedGap(ctx, notes);
  reportPerTypeGaps(ctx, actions);

  return {
    variant: 'issuer',
    security: {
      instrumentId: instrument.instrumentId,
      key,
      name: instrument.name,
      currency: instrument.currency,
    },
    issuer: {
      issuerId: detail.issuer?.issuerId ?? null,
      name: detail.issuer?.name ?? instrument.name,
      cik,
    },
    window: { from, to },
    knownAt: knownAt.toISOString(),
    actions: [...future, ...past],
    earnings,
    summary: {
      ttmCashDividend,
      ttmCount: ttmRows.length,
      frequency: newestDividend?.frequency ?? null,
      dvdYield,
      pxLast,
      lastSplit:
        lastSplitRow === undefined
          ? null
          : {
              exDate: lastSplitRow.exDate,
              ratioNew: lastSplitRow.ratioNew ?? 0,
              ratioOld: lastSplitRow.ratioOld ?? 0,
            },
      nextProjected,
      cumulativeAdjFactor,
    },
    counts,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// members variant
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The cash and split families — the only ones the members calendar can be about (§CACS step 2). */
const MEMBER_TYPES: readonly CaType[] = Object.freeze([
  'cash_dividend',
  'special_dividend',
  'stock_dividend',
  'split',
  'reverse_split',
] as CaType[]);

async function membersVariant(
  ctx: ResolveContext,
  params: CacsParams,
): Promise<CacsMembersPayload> {
  const instrument = ctx.instrument;
  if (instrument === null) throw new TypeError('CACS: the members variant needs an index');

  const knownAt = pitKnownAt(ctx, params);
  const validAt = ctx.asOf.validAt;
  const todayIso = isoDate(validAt);
  const notes: string[] = [CACS_NOTE_EARNINGS_NOT_APPLICABLE, CACS_NOTE_MEMBER_SUBSET];

  const idx = await findIndexByInstrumentId(ctx.db, instrument.instrumentId);
  const roster = await ctx.data.reference.members(instrument.instrumentId);
  const shown = [...roster.members]
    .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1))
    .slice(0, params.members);

  // `data.reference.members` indexes its citations into the data services' own
  // `ProvenanceIndex`, not `ctx.prov`, so the row's `provIdx` means nothing in this payload; the
  // membership file is re-cited through the collector that actually fills `meta.provenance`.
  const rosterProv = await citeProvenanceIds(ctx, shown.map((m) => m.provenanceId));
  const membershipProvIdx =
    shown[0] === undefined ? -1 : (rosterProv.get(shown[0].provenanceId) ?? -1);
  const membershipSourceId = shown[0]?.sourceId ?? '';
  const ageDays = (validAt.getTime() - Date.parse(`${roster.asOfDate}T00:00:00Z`)) / DAY_MS;
  if (ageDays > 45) notes.push(CACS_NOTE_MEMBERSHIP_STALE);

  const from = params.from ?? isoDate(shiftDays(validAt, -7));
  const to = params.to ?? isoDate(shiftDays(validAt, 90));

  const types = MEMBER_TYPES.filter((t) => params.types.includes(t));
  const records =
    shown.length === 0 || types.length === 0
      ? []
      : await actionsAsOf(
          ctx.db,
          {
            instrumentIds: shown.map((m) => m.instrumentId),
            from,
            to,
            caTypes: types,
            statuses: params.status,
          },
          { validAt, knownAt },
        );

  const byId = new Map(shown.map((m) => [m.instrumentId, m]));
  const actions: CacsMemberAction[] = records.map((record) => {
    const member = byId.get(record.instrumentId);
    const weight = member?.weight ?? null;
    const provIdx = ctx.prov.add({
      sourceId: record.sourceId,
      provenanceId: record.provenanceId,
      capturedAt: new Date(record.validFrom),
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    });
    const base = toAction(
      record,
      {
        key:
          member === undefined
            ? ''
            : displayOf(member.ticker, member.exchCode, member.marketSector),
        newKey: null,
      },
      provIdx,
      null,
    );
    return {
      ...base,
      weight,
      weightedAmount: record.amount === null || weight === null ? null : record.amount * weight,
    };
  });

  const upcoming = actions.filter((a) => a.exDate > todayIso);
  const weighted = upcoming.filter((a) => a.weightedAmount !== null);
  const withActions = new Set(actions.map((a) => a.instrumentId));
  const coverage = shown.length === 0 ? 0 : withActions.size / shown.length;
  if (coverage < 1) notes.push(CACS_NOTE_COVERAGE_PARTIAL);

  ctx.unavailable.add({
    field: 'earnings',
    reason: 'NOT_APPLICABLE',
    detail: `${CACS_NOTE_EARNINGS_NOT_APPLICABLE}: an index has no filings; see CACS on a member`,
  });
  reportUnsourcedTypes(ctx, params, notes);
  reportEstimatedGap(ctx, notes);
  reportPerTypeGaps(ctx, actions);

  return {
    variant: 'members',
    index: {
      instrumentId: instrument.instrumentId,
      key: displayOf(instrument.ticker, instrument.exchCode, instrument.marketSector),
      name: instrument.name,
      indexId: idx?.indexId ?? roster.indexId,
    },
    membership: {
      asOfDate: roster.asOfDate,
      sourceId: membershipSourceId,
      shown: shown.length,
      total: roster.members.length,
      provIdx: membershipProvIdx,
    },
    window: { from, to },
    knownAt: knownAt.toISOString(),
    actions: actions.sort((a, b) => (a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : 0)),
    summary: {
      exDateCount: upcoming.length,
      weightedCashPerIndexUnit:
        weighted.length === 0
          ? null
          : weighted.reduce((sum, a) => sum + (a.weightedAmount ?? 0), 0),
      coverage,
    },
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const variants = {
  equity: issuer,
  etf: issuer,
  index: membersVariant,
} satisfies Partial<Record<AssetClass, FunctionResolver<CacsParams, CacsPayload>>>;

export const resolve: FunctionResolver<CacsParams, CacsPayload> = issuer;

export default { resolve, variants };
