/**
 * `functions/GP/events.ts` — the markers on the chart (§GP resolver step 5, CHRT-06).
 *
 * An event marker is only worth drawing if pressing `Enter` on it opens the thing that explains
 * it, so every marker carries a command string rather than a tooltip: a dividend opens `CACS`, an
 * earnings filing opens `CF`, an index change opens `MEMB`. That is the whole contract — the chart
 * does not know what a corporate action is, it knows how to navigate to one.
 *
 * Each kind comes from the table that actually records it, as of `ctx.asOf`:
 *
 *  | kind                    | source                                            | command        |
 *  | ----------------------- | ------------------------------------------------- | -------------- |
 *  | `earnings`              | `filings` 8-K carrying item 2.02 (else 10-Q/10-K) | `<key> CF`     |
 *  | `dividend` / `split`    | `corporate_actions` as of `knownAt` (REF-09)      | `<key> CACS`   |
 *  | `filing`                | every 8-K, when `events.filings`                  | `<key> CF`     |
 *  | `news`                  | `news_entity_links` for the instrument, ≤ 200     | `<key> CN`     |
 *  | `index_add`/`index_drop`| `index_members` version boundaries                | `<indexKey> MEMB` |
 *  | `fomc`                  | `fomc_meetings`, the `series` variant only        | `FED`          |
 *
 * The cap is 500 markers and the **oldest** are dropped, because the right-hand edge of a chart is
 * where a reader is looking; dropping them silently would leave a chart that looks complete and is
 * not, so the cap is reported through `meta.unavailable`.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { GpEvent, GpParams } from '@terminal/core/functions/manifests/GP';

import { indexMembers, indices } from '../../db/schema/calendars.js';
import { instruments } from '../../db/schema/reference.js';
import { actionsAsOf } from '../../refdata/corporateActions.js';
import { displayOf } from '../shared/instrumentSummary.js';

import type { InstrumentDetail } from '../../data/reference.js';
import type { ResolveContext } from '../context.js';

/** §GP: "capped at 500 markers; oldest dropped". */
export const MAX_EVENTS = 500;
/** §GP: news markers are capped well below the overall cap so they cannot crowd it out. */
const MAX_NEWS_EVENTS = 200;
/** The 8-K item that *is* an earnings release (SEC item numbering). */
const EARNINGS_ITEM = '2.02';

export interface EventsInput {
  ctx: ResolveContext;
  params: GpParams;
  detail: InstrumentDetail;
  window: { start: string; end: string };
  /** `'series'` gets the FOMC markers; nothing else does. */
  variant: string;
  /** `'AAPL US Equity'` — the prefix of every command a marker carries. */
  key: string;
}

export async function buildEvents(input: EventsInput): Promise<GpEvent[]> {
  const { ctx, params } = input;
  const out: GpEvent[] = [];

  if (params.events.dividends || params.events.splits) out.push(...(await actionEvents(input)));
  if (params.events.earnings || params.events.filings) out.push(...(await filingEvents(input)));
  if (params.events.news) out.push(...(await newsEvents(input)));
  if (params.events.indexChanges) out.push(...(await membershipEvents(input)));
  if (params.events.fomc && input.variant === 'series') out.push(...(await fomcEvents(input)));

  out.sort((a, b) => a.t - b.t || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));

  if (out.length > MAX_EVENTS) {
    ctx.unavailable.add({
      field: 'events',
      reason: 'NOT_APPLICABLE',
      detail: 'capped at 500 markers; oldest dropped',
    });
    return out.slice(out.length - MAX_EVENTS);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Corporate actions
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function actionEvents(input: EventsInput): Promise<GpEvent[]> {
  const { ctx, params, detail, window, key } = input;
  const actions = await actionsAsOf(
    ctx.db,
    { instrumentId: detail.instrument.instrumentId, from: window.start, to: window.end },
    ctx.asOf,
  );

  const out: GpEvent[] = [];
  for (const action of actions) {
    const kind = actionKind(action.caType);
    if (kind === null) continue;
    if (kind === 'dividend' && !params.events.dividends) continue;
    if (kind === 'split' && !params.events.splits) continue;

    const provIdx = ctx.prov.add({
      sourceId: action.sourceId,
      provenanceId: action.provenanceId,
      capturedAt: new Date(action.validFrom),
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    });
    out.push({
      t: Date.parse(`${action.exDate}T00:00:00.000Z`),
      kind,
      label: actionLabel(action),
      command: `${key} CACS`,
      provIdx,
    });
  }
  return out;
}

function actionKind(caType: string): 'dividend' | 'split' | null {
  if (caType === 'cash_dividend' || caType === 'special_dividend') return 'dividend';
  if (caType === 'split' || caType === 'reverse_split' || caType === 'stock_dividend') {
    return 'split';
  }
  return null;
}

/** `'$0.26'` for cash, `'4:1'` for a ratio — what the marker reads on the axis. */
function actionLabel(action: {
  caType: string;
  amount: number | null;
  currency: string | null;
  ratioNew: number | null;
  ratioOld: number | null;
}): string {
  if (action.amount !== null) {
    const symbol = action.currency === 'USD' || action.currency === null ? '$' : `${action.currency} `;
    return `${symbol}${action.amount.toFixed(2)}`;
  }
  if (action.ratioNew !== null && action.ratioOld !== null) {
    return `${String(action.ratioNew)}:${String(action.ratioOld)}`;
  }
  return action.caType;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Filings
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function filingEvents(input: EventsInput): Promise<GpEvent[]> {
  const { ctx, params, detail, window, key } = input;
  const cik = cikOf(detail);
  if (cik === null) return [];

  const forms = params.events.earnings ? ['8-K', '10-Q', '10-K'] : ['8-K'];
  const page = await ctx.data.filings.list(cik, {
    forms,
    from: window.start,
    to: window.end,
    limit: MAX_EVENTS,
  });

  const out: GpEvent[] = [];
  for (const filing of page.items) {
    const isEarnings =
      (filing.form === '8-K' && (filing.items ?? []).includes(EARNINGS_ITEM)) ||
      filing.form === '10-Q' ||
      filing.form === '10-K';

    if (isEarnings && !params.events.earnings) continue;
    if (!isEarnings && !params.events.filings) continue;

    const provIdx = ctx.prov.add({
      sourceId: 'sec.submissions',
      provenanceId: filing.provenanceId,
      capturedAt: new Date(`${filing.filedDate}T00:00:00.000Z`),
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    });
    out.push({
      t: Date.parse(`${filing.filedDate}T00:00:00.000Z`),
      kind: isEarnings ? 'earnings' : 'filing',
      label: filing.form,
      command: `${key} CF`,
      provIdx,
    });
  }
  return out;
}

function cikOf(detail: InstrumentDetail): string | null {
  // `identifiers` carries the instrument's own rows and its issuer's; a CIK is an issuer identifier.
  const cik = detail.identifiers.find((id) => id.scheme === 'CIK');
  return cik?.value ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// News
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function newsEvents(input: EventsInput): Promise<GpEvent[]> {
  const { ctx, detail, window, key } = input;
  const page = await ctx.data.news.search({
    instrumentId: detail.instrument.instrumentId,
    from: `${window.start}T00:00:00.000Z`,
    to: `${window.end}T23:59:59.999Z`,
    limit: MAX_NEWS_EVENTS,
  });

  return page.items.map((item) => ({
    t: Date.parse(item.publishedAt),
    kind: 'news' as const,
    label: item.headline.length > 60 ? `${item.headline.slice(0, 57)}…` : item.headline,
    command: `${key} CN`,
    provIdx: ctx.prov.add({
      sourceId: item.sourceId,
      provenanceId: item.provenanceId,
      capturedAt: new Date(item.capturedAt),
      sourceTs: item.sourceTs === null ? null : new Date(item.sourceTs),
      st: 'closed',
      tier: 'eod',
    }),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Index membership
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A membership version's `valid_from` is an add and its `valid_to` is a drop.
 *
 * Only boundaries **inside the window** are markers: a security that has been in the index since
 * before the chart starts has no add to draw, which is why `index_add` is legitimately absent from
 * a five-year AAPL chart.
 */
async function membershipEvents(input: EventsInput): Promise<GpEvent[]> {
  const { ctx, detail, window } = input;
  const from = `${window.start}T00:00:00.000Z`;
  const to = `${window.end}T23:59:59.999Z`;

  const rows = await ctx.db
    .select({
      indexId: indexMembers.indexId,
      validFrom: indexMembers.validFrom,
      validTo: indexMembers.validTo,
      provenanceId: indexMembers.provenanceId,
      sourceId: indexMembers.sourceId,
      indexInstrumentId: indices.instrumentId,
    })
    .from(indexMembers)
    .innerJoin(indices, eq(indices.indexId, indexMembers.indexId))
    .where(
      and(
        eq(indexMembers.instrumentId, detail.instrument.instrumentId),
        sql`${indexMembers.txTo} = 'infinity'`,
      ),
    )
    .orderBy(asc(indexMembers.validFrom));

  if (rows.length === 0) return [];

  const keys = await indexKeys(
    ctx,
    rows.map((r) => r.indexInstrumentId),
  );

  const out: GpEvent[] = [];
  for (const row of rows) {
    const provIdx = ctx.prov.add({
      sourceId: row.sourceId,
      provenanceId: row.provenanceId,
      capturedAt: new Date(row.validFrom),
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    });
    const indexKey = keys.get(row.indexInstrumentId) ?? 'index';
    if (row.validFrom >= from && row.validFrom <= to) {
      out.push({
        t: Date.parse(row.validFrom),
        kind: 'index_add',
        label: `Added to ${indexKey}`,
        command: `${indexKey} MEMB`,
        provIdx,
      });
    }
    if (row.validTo !== 'infinity' && row.validTo >= from && row.validTo <= to) {
      out.push({
        t: Date.parse(row.validTo),
        kind: 'index_drop',
        label: `Dropped from ${indexKey}`,
        command: `${indexKey} MEMB`,
        provIdx,
      });
    }
  }
  return out;
}

/** `instrument_id → 'SPX Index'` for the indices a membership row names. */
async function indexKeys(
  ctx: ResolveContext,
  instrumentIds: readonly number[],
): Promise<Map<number, string>> {
  const unique = [...new Set(instrumentIds)];
  if (unique.length === 0) return new Map();
  const rows = await ctx.db
    .select({
      instrumentId: instruments.instrumentId,
      ticker: instruments.ticker,
      exchCode: instruments.exchCode,
      marketSector: instruments.marketSector,
    })
    .from(instruments)
    .where(and(inArray(instruments.instrumentId, unique), sql`${instruments.txTo} = 'infinity'`));

  return new Map(
    rows.map((row) => [row.instrumentId, displayOf(row.ticker, row.exchCode, row.marketSector)]),
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// FOMC
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function fomcEvents(input: EventsInput): Promise<GpEvent[]> {
  const { ctx, window } = input;
  const meetings = await ctx.data.econ.fomc({ from: window.start, to: window.end });

  return meetings
    .filter((m) => m.meetingDate >= window.start && m.meetingDate <= window.end)
    // A meeting scraped from the calendar page rather than captured has no provenance row, and a
    // marker that cannot say where it came from is not drawn (DATA-10).
    .filter((m): m is typeof m & { provenanceId: number } => m.provenanceId !== null)
    .map((m) => ({
      t: Date.parse(`${m.meetingDate}T00:00:00.000Z`),
      kind: 'fomc' as const,
      label: 'FOMC',
      command: 'FED',
      provIdx: ctx.prov.add({
        sourceId: 'fed.fomc',
        provenanceId: m.provenanceId,
        capturedAt: new Date(`${m.meetingDate}T00:00:00.000Z`),
        sourceTs: null,
        st: 'closed',
        tier: 'eod',
      }),
    }));
}
