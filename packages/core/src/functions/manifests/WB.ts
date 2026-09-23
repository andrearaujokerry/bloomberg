// packages/core/src/functions/manifests/WB.ts
//
// `WB` — World Bond Markets (FUNCTIONS_TIER2.md §WB L2226-2337, FUNCTIONS.md §6 `none → default`).
//
// Sixteen benchmark government-bond markets on one page. One of them — the United States — has a
// daily published curve and an intraday proxy. The other fifteen have a MONTHLY OECD long-term
// interest-rate series and nothing else, and the whole design of this screen is about not letting
// that difference disappear:
//
//  * `frequency`, `asOfDate` and `lagDays` sit on every row, so a print from five weeks ago is
//    labelled as one rather than rendered next to today's US close as if they were the same day.
//  * `tenor` 2Y and 30Y are a **US-only** view. The OECD series is a ten-year benchmark; the other
//    rows are `NO_OECD_SERIES_FOR_TENOR`, never the ten-year number reused under another heading.
//  * A series with no recorded fixture in `PROVIDER_MODE=replay` is `NO_RECORDED_FIXTURE`, not an
//    interpolation, not the previous month carried forward, and not a neighbour's yield.
//  * `1D` on a monthly series is `NOT_APPLICABLE`, because a monthly series has no yesterday.
//
// The country table is a constant of this manifest (§WB resolver step 1) so the screen, the CSV
// and the resolver agree on the sixteen rows and their FRED provider codes without a database
// round trip.
//
// `CurvePointRow` is imported from `BTMM.ts`, which is where the shared rate shapes live in this
// build (see that file's header).

import { z } from 'zod';

import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import { defineFunction, type CsvColumn, type CsvDocument, type LiveSpec } from '../manifest.js';
import type { MonitorRow } from '../shared/monitor.js';
import type { CurvePointRow } from './BTMM.js';
import { monitorPrecheckFields } from './QM.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§WB "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const WbRegions = ['AMERICAS', 'EMEA', 'APAC'] as const;
export type WbRegion = (typeof WbRegions)[number];

export const WbTenors = ['2Y', '10Y', '30Y'] as const;
export type WbTenor = (typeof WbTenors)[number];

export const WbChgWindows = ['1D', '1W', '1M', '1Y'] as const;
export type WbChgWindow = (typeof WbChgWindows)[number];

export const WbParams = z.object({
  region: z.enum(['ALL', ...WbRegions]).default('ALL'),
  tenor: z.enum(WbTenors).default('10Y'),
  spreadTo: z.enum(['US', 'NONE']).default('US'),
  chgWindow: z.enum(WbChgWindows).default('1D'),
  sort: z.enum(['region', 'yield', 'spread', 'chg']).default('region'),
});
export type WbParams = z.infer<typeof WbParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The country table (§WB resolver step 1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface WbCountry {
  /** ISO 3166-1 alpha-2, matching `econ_series.country`. */
  iso: string;
  name: string;
  region: WbRegion;
  ccy: string;
  /**
   * The FRED OECD long-term-rate provider code, `IRLTLT01<ISO3>M156N`. `null` for the US, whose
   * ten-year benchmark is the Treasury par curve rather than an OECD monthly series.
   */
  providerCode: string | null;
}

export const WB_COUNTRIES: readonly WbCountry[] = Object.freeze([
  { iso: 'US', name: 'United States', region: 'AMERICAS', ccy: 'USD', providerCode: null },
  { iso: 'CA', name: 'Canada', region: 'AMERICAS', ccy: 'CAD', providerCode: 'IRLTLT01CAM156N' },
  { iso: 'MX', name: 'Mexico', region: 'AMERICAS', ccy: 'MXN', providerCode: 'IRLTLT01MXM156N' },
  { iso: 'BR', name: 'Brazil', region: 'AMERICAS', ccy: 'BRL', providerCode: 'IRLTLT01BRM156N' },
  { iso: 'DE', name: 'Germany', region: 'EMEA', ccy: 'EUR', providerCode: 'IRLTLT01DEM156N' },
  { iso: 'FR', name: 'France', region: 'EMEA', ccy: 'EUR', providerCode: 'IRLTLT01FRM156N' },
  { iso: 'IT', name: 'Italy', region: 'EMEA', ccy: 'EUR', providerCode: 'IRLTLT01ITM156N' },
  { iso: 'ES', name: 'Spain', region: 'EMEA', ccy: 'EUR', providerCode: 'IRLTLT01ESM156N' },
  { iso: 'GB', name: 'United Kingdom', region: 'EMEA', ccy: 'GBP', providerCode: 'IRLTLT01GBM156N' },
  { iso: 'CH', name: 'Switzerland', region: 'EMEA', ccy: 'CHF', providerCode: 'IRLTLT01CHM156N' },
  { iso: 'SE', name: 'Sweden', region: 'EMEA', ccy: 'SEK', providerCode: 'IRLTLT01SEM156N' },
  { iso: 'NO', name: 'Norway', region: 'EMEA', ccy: 'NOK', providerCode: 'IRLTLT01NOM156N' },
  { iso: 'JP', name: 'Japan', region: 'APAC', ccy: 'JPY', providerCode: 'IRLTLT01JPM156N' },
  { iso: 'AU', name: 'Australia', region: 'APAC', ccy: 'AUD', providerCode: 'IRLTLT01AUM156N' },
  { iso: 'NZ', name: 'New Zealand', region: 'APAC', ccy: 'NZD', providerCode: 'IRLTLT01NZM156N' },
  { iso: 'KR', name: 'Korea', region: 'APAC', ccy: 'KRW', providerCode: 'IRLTLT01KRM156N' },
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§WB "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type WbUnavailableReason =
  | 'NO_RECORDED_FIXTURE'
  | 'NO_OECD_SERIES_FOR_TENOR'
  | 'NO_SERIES_SEEDED';

export const OECD_MONTHLY_LAG = 'OECD_MONTHLY_LAG';
export const NO_NON_US_INTRADAY = 'NO_NON_US_INTRADAY';
export const NO_RECORDED_FIXTURE = 'NO_RECORDED_FIXTURE';

export const WB_TENOR_DETAIL =
  'NO_OECD_SERIES_FOR_TENOR: the OECD long-term interest-rate series is a ten-year benchmark only';
export const WB_MONTHLY_CHG_DETAIL =
  'OECD_MONTHLY_LAG: a monthly series has no previous day; use CHG=1M or CHG=1Y';
export const WB_CURVE_DETAIL =
  'NO_SOURCE: only the US publishes a full par curve in the reachable source set';

export function wbFixtureDetail(providerCode: string): string {
  return (
    `NO_RECORDED_FIXTURE: no recorded fred.csv response for ${providerCode}; ` +
    'run npm run test:live or record the fixture'
  );
}

export function wbSeriesDetail(providerCode: string): string {
  return (
    `NO_SERIES_SEEDED: ${providerCode} has no econ_series row; the OECD long-term rate for this ` +
    'country is not ingested in this build'
  );
}

export interface WbCountryRow {
  iso: string;
  country: string;
  region: WbRegion;
  ccy: string;
  tenor: WbTenor;
  /** `econ_series.series_code`; `null` when no series is seeded. */
  seriesCode: string | null;
  sourceId: 'treasury.yieldcurve' | 'fed.h15' | 'fred.csv' | null;
  /** OECD long-term rates are MONTHLY; the US curve is daily. */
  frequency: 'D' | 'M' | null;
  /** Percent. */
  yield: ValueCell;
  /** `obs_date` / `curve_date` of the value in `yield`. */
  asOfDate: string | null;
  chgBp: ValueCell;
  /** `yield − US yield` of the same tenor, ×100; `na` when `spreadTo = 'NONE'`. */
  spreadBp: ValueCell;
  /** Populated for the US only; `NO_SOURCE` elsewhere. */
  curve: { t2y: ValueCell; t10y: ValueCell; t30y: ValueCell };
  /** `'e:<seriesCode>'`; `'q:<instrumentId>'` for the US intraday proxy row. */
  subject: string | null;
  /** `ctx.asOf.validAt − asOfDate` in calendar days — the honest freshness number. */
  lagDays: number | null;
  provIdx: number;
  unavailableReason: WbUnavailableReason | null;
}

export interface WbUsBlock {
  curveDate: string | null;
  points: CurvePointRow[];
  /** `TNX Index` — the Cboe ten-year yield index, the only intraday yield in the source set. */
  intraday: MonitorRow | null;
}

export interface WbPayload {
  variant: 'default';
  tenor: WbTenor;
  chgWindow: WbChgWindow;
  spreadTo: 'US' | 'NONE';
  us: WbUsBlock;
  rows: WbCountryRow[];
  regions: { region: WbRegion; count: number; withData: number }[];
  notes: string[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Sorting (§WB resolver step 6)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The table order of {@link WB_COUNTRIES} as a rank, so `sort:'region'` is a stable comparator. */
const TABLE_ORDER = new Map(WB_COUNTRIES.map((c, i) => [c.iso, i]));

/**
 * §WB step 6. `yield`/`spread`/`chg` sort descending **with null cells last**: a missing source
 * sinks to the bottom rather than sorting as a zero yield, which would put a country with no data
 * at the tight end of the table and read as a negative-yielding market.
 */
export function sortWbRows(rows: WbCountryRow[], sort: WbParams['sort']): WbCountryRow[] {
  const out = [...rows];
  if (sort === 'region') {
    out.sort((a, b) => (TABLE_ORDER.get(a.iso) ?? 0) - (TABLE_ORDER.get(b.iso) ?? 0));
    return out;
  }
  const key = (row: WbCountryRow): number | null => {
    const cell = sort === 'yield' ? row.yield : sort === 'spread' ? row.spreadBp : row.chgBp;
    return typeof cell.v === 'number' ? cell.v : null;
  };
  out.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === null && kb === null) {
      return (TABLE_ORDER.get(a.iso) ?? 0) - (TABLE_ORDER.get(b.iso) ?? 0);
    }
    if (ka === null) return 1;
    if (kb === null) return -1;
    if (ka === kb) return (TABLE_ORDER.get(a.iso) ?? 0) - (TABLE_ORDER.get(b.iso) ?? 0);
    return kb - ka;
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§WB "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The whole §WB list — what the screen subscribes to. */
export const WB_FIELD_IDS: readonly FieldId[] = Object.freeze([
  'ECO_VALUE',
  'ECO_PERIOD',
  'ECO_PRIOR',
  'ECO_VINTAGE',
  'ECO_RELEASE_DT',
  'CRV_2Y',
  'CRV_10Y',
  'CRV_30Y',
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
]);

/**
 * The entitlement pre-check set.
 *
 * Deliberately **not** the whole §WB list, for the reason BTMM.ts records at length: `CRV_*` is
 * licensed from `treasury.yieldcurve` and `ECO_PRIOR`/`ECO_VINTAGE` from `fred.csv`, both capped
 * at `eod` by `licence_registry`, and `EntitlementDecision.effectiveTier` — the MINIMUM over the
 * fields asked about — seeds the plant gate for the whole run. Pre-checking a published curve or a
 * monthly observation, neither of which the plant serves, would blank `us.intraday` (the delayed
 * Cboe ten-year yield index) with `TIER_EOD`. Everything this screen reads from the plant is a
 * multi-source quote field that {@link monitorPrecheckFields} drops anyway, so the set is empty and
 * the gate keeps its default `delayed` — the same trade QM.ts documents.
 */
export const WB_PRECHECK_SUPERSET: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
]);

export const WB_LIVE_FIELDS: readonly FieldId[] = Object.freeze([
  'ECO_VALUE',
  'ECO_PERIOD',
  'ECO_RELEASE_DT',
  'ECO_VINTAGE',
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§WB "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

const WB_COLUMNS: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'iso', label: 'ISO', type: 'string' },
  { id: 'country', label: 'Country', type: 'string' },
  { id: 'region', label: 'Region', type: 'string' },
  { id: 'ccy', label: 'Currency', type: 'string' },
  { id: 'tenor', label: 'Tenor', type: 'string' },
  { id: 'seriesCode', label: 'Series', type: 'string' },
  { id: 'yield', label: 'Yield', type: 'number' },
  { id: 'asOfDate', label: 'As of', type: 'date' },
  { id: 'frequency', label: 'Frequency', type: 'string' },
  { id: 'chgBp', label: 'Change bp', type: 'number' },
  { id: 'spreadBp', label: 'Spread bp', type: 'number' },
  { id: 'lagDays', label: 'Lag days', type: 'number' },
  { id: 'sourceId', label: 'Source', type: 'string' },
  { id: 'reason', label: 'Reason', type: 'string' },
];

const cellNum = (cell: ValueCell): number | null => (typeof cell.v === 'number' ? cell.v : null);

function wbCsvRows(payload: WbPayload): CsvDocument['rows'] {
  const rows: CsvDocument['rows'] = [];
  for (const point of payload.us.points) {
    rows.push([
      'us_curve',
      'US',
      'United States',
      'AMERICAS',
      'USD',
      point.tenor,
      null,
      cellNum(point.value),
      payload.us.curveDate,
      'D',
      cellNum(point.chgBp),
      null,
      0,
      'treasury.yieldcurve',
      null,
    ]);
  }
  for (const row of payload.rows) {
    rows.push([
      'country',
      row.iso,
      row.country,
      row.region,
      row.ccy,
      row.tenor,
      row.seriesCode,
      cellNum(row.yield),
      row.asOfDate,
      row.frequency,
      cellNum(row.chgBp),
      cellNum(row.spreadBp),
      row.lagDays,
      row.sourceId,
      row.unavailableReason,
    ]);
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const WB = defineFunction<typeof WbParams, WbPayload>({
  code: 'WB',
  name: 'World Bond Markets',
  aliases: ['BONDS'],
  tier: 2,
  category: 'monitor',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: WbParams,
  paramGrammar: {
    positional: [
      { name: 'region', type: 'enum', values: ['ALL', ...WbRegions], optional: true },
      { name: 'tenor', type: 'enum', values: [...WbTenors], optional: true },
    ],
    keyed: {
      SPR: { name: 'spreadTo', type: 'enum', values: ['US', 'NONE'] },
      CHG: { name: 'chgWindow', type: 'enum', values: [...WbChgWindows] },
      SORT: { name: 'sort', type: 'enum', values: ['region', 'yield', 'spread', 'chg'] },
    },
  },
  fieldIds: (): FieldId[] => monitorPrecheckFields(WB_PRECHECK_SUPERSET),
  pageable: false,
  live: (_params, payload): LiveSpec | null => {
    const subjects = payload.rows
      .map((r) => r.subject)
      .filter((s): s is string => s?.startsWith('e:') === true);
    const intradaySubject = payload.us.intraday?.subject;
    if (intradaySubject !== undefined) subjects.push(intradaySubject);
    return subjects.length === 0
      ? null
      : { subjects, fields: [...WB_LIVE_FIELDS], conflationMs: 2000 };
  },
  csv: {
    filename: (params, ctx): string => `WB_${params.tenor}_${ctx.asOf.replace(/[-:]/g, '')}.csv`,
    columns: WB_COLUMNS,
    rows: (payload): CsvDocument['rows'] => wbCsvRows(payload),
  },
  help: {
    summary: 'Benchmark government-bond yields by region, with the US curve and spreads vs the US',
    description:
      'WB is the global government-bond page: sixteen markets grouped Americas / EMEA / APAC with ' +
      'the benchmark yield, the change over the chosen window and the spread to the US of the same ' +
      'tenor. Only the United States publishes a daily curve in the reachable source set, so the ' +
      'US block shows the full Treasury par curve and the Cboe ten-year yield index intraday; ' +
      'every other market is the OECD long-term interest rate from FRED, which is MONTHLY. The lag ' +
      'column is always on screen for that reason: a spread between a daily US yield and a monthly ' +
      'OECD print is not a spread between two prices struck on the same day, and the screen says ' +
      'so rather than implying otherwise. The 2Y and 30Y tabs are a US-only view — the OECD series ' +
      'is a ten-year benchmark, and no substitute tenor is shown in its place. A country with no ' +
      'recorded observation shows its reason code and no number.',
    params: [
      { name: 'region', text: 'ALL, AMERICAS, EMEA or APAC', example: 'WB EMEA' },
      { name: 'tenor', text: '2Y, 10Y or 30Y', example: 'WB ALL 30Y' },
      { name: 'spreadTo', text: 'US or NONE', example: 'SPR=NONE' },
      { name: 'chgWindow', text: '1D, 1W, 1M or 1Y', example: 'CHG=1M' },
      { name: 'sort', text: 'region, yield, spread or chg', example: 'SORT=spread' },
    ],
    keys: [
      { key: '1…3', action: 'tenor tabs' },
      { key: 'R', action: 'cycle the region' },
      { key: 'C', action: 'cycle the change window' },
      { key: 'S', action: 'cycle the sort' },
      { key: 'P', action: 'toggle the spread column' },
      { key: 'B', action: 'BTMM' },
    ],
    sources: ['treasury.yieldcurve', 'fred.csv', 'fed.h15', 'cboe.quotes', 'yahoo.chart'],
    related: ['BTMM', 'CRVF', 'FXC', 'GP', 'HP', 'DES'],
  },
  keymap: [
    { key: '1', action: 'tab-tenor', description: 'Two-year benchmark' },
    { key: '2', action: 'tab-tenor', description: 'Ten-year benchmark' },
    { key: '3', action: 'tab-tenor', description: 'Thirty-year benchmark' },
    { key: 'R', action: 'cycle-region', description: 'ALL → AMERICAS → EMEA → APAC → ALL' },
    { key: 'C', action: 'cycle-chg-window', description: '1D → 1W → 1M → 1Y → 1D' },
    { key: 'S', action: 'cycle-sort', description: 'region → yield → spread → chg → region' },
    { key: 'P', action: 'toggle-spread', description: 'Spread vs US on or off' },
    { key: 'Enter', action: 'open-gp', when: 'grid', description: 'Chart the focused series' },
    {
      key: 'Shift+Enter',
      action: 'open-gp-next',
      when: 'grid',
      description: 'Chart the focused series in the next panel',
    },
    { key: 'H', action: 'open-hp', when: 'grid', description: 'Full observation history' },
    { key: 'D', action: 'open-des', when: 'grid', description: 'Series description and vintages' },
    { key: 'V', action: 'open-crvf', description: 'Curve construction' },
    { key: 'B', action: 'open-btmm', description: 'Treasury and money markets' },
    { key: 'X', action: 'open-fxc', description: 'FX cross matrix' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default WB;
