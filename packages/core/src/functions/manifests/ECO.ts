// packages/core/src/functions/manifests/ECO.ts
//
// `ECO` — Economic Calendar (FUNCTIONS_TIER2.md §ECO L1156-1320, FUNCTIONS.md §6).
//
// The §6 binding row is `none → default`: the screen takes no security, and every row names a
// release rather than an instrument.
//
// The one thing this screen is *about* is the column it cannot fill. There is no consensus source
// in the reachable set (BRIEF §2), so `consensus` is structurally `null` on every row and the
// reason travels with it — in the row (`{ v: null, r: 'NO_CONSENSUS_SOURCE' }`), in the payload
// (`payload.consensus`), in `meta.unavailable` and in the CSV (`consensusReason`). A blank cell
// that says nothing would read as "no surprise this month"; a zero would read as a forecast that
// was met. Both are lies a trading screen cannot afford, so the absence is typed.
//
// Two deviations from the tier document, both forced and both recorded here:
//
//  1. **`consensus.r` is not a `ReasonCode`.** `ValueCell.r` is the closed `ReasonCode` union
//     (`types/entitlement.ts`) and `'NO_CONSENSUS_SOURCE'` is not a member of it. The consensus
//     slot is therefore its own shape ({@link EcoConsensus}) rather than a `ValueCell`, which is
//     also the honest typing: the cell can never carry a number, so it has no `st`, no `ts` and no
//     `provIdx` to carry either.
//  2. **`csv.columns` is a function of the payload.** §ECO already says `csvColumns` is `null`
//     because the two modes export different tables; the function returns the calendar table or
//     the long release table from `payload.mode`.

import { z } from 'zod';

import {
  addDays,
  addMonths,
  dayOfWeek,
  endOfMonth,
  parseIsoDate,
  startOfMonth,
  type IsoDate,
} from '../../calendars/calendar.js';
import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import { defineFunction, type CsvColumn, type CsvDocument } from '../manifest.js';
import { monitorPrecheckFields } from './QM.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§ECO "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const EcoRange = z.enum(['D', 'W', 'M']);
export type EcoRange = z.infer<typeof EcoRange>;

export const EcoParams = z.object({
  /** Day / week (Mon–Sun) / calendar month, anchored on `date`. */
  range: EcoRange.default('W'),
  /** Anchor day; undefined = `ctx.asOf.validAt` in America/New_York. */
  date: z.iso.date().optional(),
  country: z.enum(['US', 'ALL']).default('US'),
  /** Minimum `econ_releases.importance` shown (1 = show everything). */
  importance: z.number().int().min(1).max(3).default(1),
  /** Set → release-detail mode (`econ_releases.release_id`). */
  releaseId: z.number().int().positive().optional(),
  fomc: z.boolean().default(true),
});
export type EcoParams = z.infer<typeof EcoParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§ECO "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type EcoImportance = 1 | 2 | 3;
export type EcoSourceId = 'fred.calendar' | 'bls.schedule' | 'fed.fomc';
export type EcoStatus = 'scheduled' | 'released' | 'revised' | 'delayed' | 'cancelled';

/** The code every consensus slot carries. There is exactly one, and it is never absent. */
export const NO_CONSENSUS_SOURCE = 'NO_CONSENSUS_SOURCE';

/**
 * The consensus slot. Deliberately not a `ValueCell`: see deviation 1 in the file header.
 * `v` is typed `null`, so a resolver cannot put a number here even by accident.
 */
export interface EcoConsensus {
  v: null;
  r: typeof NO_CONSENSUS_SOURCE;
}

export const ECO_CONSENSUS: EcoConsensus = Object.freeze({ v: null, r: NO_CONSENSUS_SOURCE });

/** The `meta.unavailable` detail strings, exported so the resolver and its test agree on them. */
export const ECO_CONSENSUS_DETAIL =
  'NO_CONSENSUS_SOURCE: no consensus-estimates provider is reachable in the wedge (BRIEF §2); ' +
  'the column is never populated';
export const ECO_SURPRISE_DETAIL = 'NO_CONSENSUS_SOURCE: surprise requires a consensus value';

/** One scheduled or released macro print. */
export interface EcoEventRow {
  eventId: number;
  releaseId: number;
  releaseName: string;
  sourceId: EcoSourceId;
  country: string;
  url: string | null;
  importance: EcoImportance;
  scheduledAt: string;
  /** `false` → a FRED calendar date pinned to 08:30 ET; the screen shows `ET —`. */
  timeKnown: boolean;
  periodLabel: string;
  seriesCode: string | null;
  seriesName: string | null;
  units: string | null;
  decimals: number | null;
  actual: ValueCell;
  prior: ValueCell;
  revisedPrior: ValueCell;
  consensus: EcoConsensus;
  surprisePct: null;
  status: EcoStatus;
  /** `'e:CUUR0000SA0'` when `seriesCode` is known. */
  subject: string | null;
  provIdx: number;
}

export interface EcoDay {
  date: string;
  isBusinessDay: boolean;
  events: EcoEventRow[];
}

export interface EcoFomcRow {
  meetingDate: string;
  statementAt: string | null;
  hasSep: boolean;
  decisionBp: number | null;
  isNext: boolean;
  inWindow: boolean;
  provIdx: number;
}

export interface EcoObservation {
  obsDate: string;
  value: number | null;
  status: 'final' | 'preliminary' | 'revised' | 'missing';
  vintageAt: string;
  isLatest: boolean;
  footnote: string | null;
  provIdx: number;
}

export interface EcoVintageGroup {
  obsDate: string;
  vintages: { vintageAt: string; value: number | null; status: string }[];
}

export interface EcoSeriesBlock {
  seriesCode: string;
  name: string;
  units: string;
  frequency: 'D' | 'W' | 'M' | 'Q' | 'A';
  seasonalAdj: string | null;
  decimals: number | null;
  lastObsDate: string | null;
  lastUpdatedAt: string | null;
  observations: EcoObservation[];
  revisions: EcoVintageGroup[];
  /** Oldest → newest, for the Sparkline node. */
  chart: { t: number; v: number | null }[];
}

export interface EcoReleaseBlock {
  releaseId: number;
  name: string;
  sourceId: EcoSourceId;
  country: string;
  url: string | null;
  importance: EcoImportance;
  /** The last 12 events of this release, newest first. */
  events: EcoEventRow[];
  series: EcoSeriesBlock[];
  nextEvent: EcoEventRow | null;
}

export interface EcoWindow {
  from: string;
  to: string;
  tz: 'America/New_York';
  /** `'Week of 2026-09-14'`. */
  label: string;
}

export interface EcoPayload {
  variant: 'default';
  mode: 'calendar' | 'release';
  window: EcoWindow;
  country: 'US' | 'ALL';
  importance: EcoImportance;
  /** Every day of the window; empty days are kept so the screen renders the grid. */
  days: EcoDay[];
  fomc: EcoFomcRow[];
  release: EcoReleaseBlock | null;
  consensus: { value: null; reason: typeof NO_CONSENSUS_SOURCE };
  knownAt: string;
  /** `base64url(JSON)` — the later and earlier window. */
  cursor: { prev: string; next: string };
  notes: string[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Window arithmetic (§ECO resolver steps 1 and 7)
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Pure calendar-day arithmetic on ISO strings, in core so the resolver, the paging unit test and
// the screen all shift a window the same way. `packages/core` is clock-free, so nothing here reads
// "now": the anchor is always supplied.

/** Monday of `anchor`'s ISO week (`dayOfWeek` is 0 = Sunday). */
export function isoWeekStart(anchor: IsoDate): IsoDate {
  const dow = dayOfWeek(anchor);
  return addDays(anchor, -((dow + 6) % 7));
}

/** The `[from, to]` window and its label for one range, anchored on `anchor`. */
export function ecoWindow(anchor: IsoDate, range: EcoRange): EcoWindow {
  if (range === 'D') {
    return { from: anchor, to: anchor, tz: 'America/New_York', label: `Day ${anchor}` };
  }
  if (range === 'W') {
    const from = isoWeekStart(anchor);
    return {
      from,
      to: addDays(from, 6),
      tz: 'America/New_York',
      label: `Week of ${from}`,
    };
  }
  const from = startOfMonth(anchor);
  const { year, month } = parseIsoDate(from);
  return {
    from,
    to: endOfMonth(anchor),
    tz: 'America/New_York',
    label: `${MONTH_NAMES[month - 1] ?? String(month)} ${String(year)}`,
  };
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * The anchor of the window `dir` steps away: `+1` is the **later** window (PAGE FWD), `-1` the
 * earlier one.
 *
 * A month shift clamps at month end through `addMonths` (31 Jan + 1 month = 28/29 Feb), which is
 * what the paging test pins: the anchor never drifts into the following month.
 */
export function ecoShift(anchor: IsoDate, range: EcoRange, dir: 1 | -1): IsoDate {
  if (range === 'D') return addDays(anchor, dir);
  if (range === 'W') return addDays(isoWeekStart(anchor), 7 * dir);
  return startOfMonth(addMonths(startOfMonth(anchor), dir));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§ECO "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The superset §ECO names, before {@link monitorPrecheckFields}.
 *
 * `ECO_VALUE`, `ECO_PERIOD` and `ECO_RELEASE_DT` each carry several `sources` in the dictionary
 * (FRED, BLS, World Bank, IMF, NY Fed), so `field_licence` cannot answer them under the `null`
 * asset class a `'none'` manifest pre-checks with and they come back `FIELD_UNKNOWN` — an audit
 * row that says nothing and a spurious blocked badge. The filter drops them; what survives
 * (`ECO_PRIOR`, `ECO_VINTAGE`, both `fred.csv`) is what the decision can actually decide.
 */
export const ECO_PRECHECK_SUPERSET: readonly FieldId[] = Object.freeze([
  'ECO_VALUE',
  'ECO_PRIOR',
  'ECO_RELEASE_DT',
  'ECO_PERIOD',
  'ECO_VINTAGE',
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§ECO "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

const CALENDAR_COLUMNS: CsvColumn[] = [
  { id: 'date', label: 'Date', type: 'date' },
  { id: 'scheduledAt', label: 'Scheduled', type: 'datetime' },
  { id: 'timeKnown', label: 'Time known', type: 'boolean' },
  { id: 'country', label: 'Country', type: 'string' },
  { id: 'releaseId', label: 'Release id', type: 'number' },
  { id: 'release', label: 'Release', type: 'string' },
  { id: 'periodLabel', label: 'Period', type: 'string' },
  { id: 'seriesCode', label: 'Series', type: 'string' },
  { id: 'units', label: 'Units', type: 'string' },
  { id: 'actual', label: 'Actual', type: 'number' },
  { id: 'prior', label: 'Prior', type: 'number' },
  { id: 'revisedPrior', label: 'Revised prior', type: 'number' },
  { id: 'consensus', label: 'Consensus', type: 'number' },
  { id: 'consensusReason', label: 'Consensus reason', type: 'string' },
  { id: 'status', label: 'Status', type: 'string' },
  { id: 'importance', label: 'Importance', type: 'number' },
  { id: 'url', label: 'URL', type: 'string' },
];

const RELEASE_COLUMNS: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'key', label: 'Key', type: 'string' },
  { id: 'value', label: 'Value', type: 'string' },
  { id: 'unit', label: 'Unit', type: 'string' },
  { id: 'asOf', label: 'As of', type: 'string' },
  { id: 'source', label: 'Source', type: 'string' },
];

function ecoCsvColumns(_params: EcoParams, payload: EcoPayload): CsvColumn[] {
  return payload.mode === 'release' ? [...RELEASE_COLUMNS] : [...CALENDAR_COLUMNS];
}

function calendarRows(payload: EcoPayload): CsvDocument['rows'] {
  const rows: CsvDocument['rows'] = [];
  for (const day of payload.days) {
    for (const e of day.events) {
      rows.push([
        day.date,
        e.scheduledAt,
        e.timeKnown,
        e.country,
        e.releaseId,
        e.releaseName,
        e.periodLabel,
        e.seriesCode,
        e.units,
        typeof e.actual.v === 'number' ? e.actual.v : null,
        typeof e.prior.v === 'number' ? e.prior.v : null,
        typeof e.revisedPrior.v === 'number' ? e.revisedPrior.v : null,
        null,
        NO_CONSENSUS_SOURCE,
        e.status,
        e.importance,
        e.url,
      ]);
    }
  }
  // §1.6 rule 3: the FOMC meetings ride the same table with `release = 'FOMC Meeting'` and the
  // decision in the `actual` column, in bp.
  for (const m of payload.fomc) {
    rows.push([
      m.meetingDate,
      m.statementAt,
      m.statementAt !== null,
      'US',
      0,
      'FOMC Meeting',
      m.meetingDate,
      null,
      'bp',
      m.decisionBp,
      null,
      null,
      null,
      NO_CONSENSUS_SOURCE,
      m.decisionBp === null ? 'scheduled' : 'released',
      1,
      null,
    ]);
  }
  return rows;
}

function releaseRows(payload: EcoPayload): CsvDocument['rows'] {
  const rows: CsvDocument['rows'] = [];
  const release = payload.release;
  if (release === null) return rows;
  rows.push(['release', 'releaseId', String(release.releaseId), '', payload.knownAt, release.sourceId]);
  rows.push(['release', 'name', release.name, '', payload.knownAt, release.sourceId]);
  rows.push(['release', 'country', release.country, '', payload.knownAt, release.sourceId]);
  rows.push([
    'release',
    'importance',
    String(release.importance),
    '',
    payload.knownAt,
    release.sourceId,
  ]);
  rows.push(['release', 'url', release.url ?? '', '', payload.knownAt, release.sourceId]);
  rows.push(['release', 'consensus', '', NO_CONSENSUS_SOURCE, payload.knownAt, release.sourceId]);
  for (const e of release.events) {
    rows.push([
      'event',
      e.scheduledAt,
      typeof e.actual.v === 'number' ? String(e.actual.v) : '',
      e.units ?? '',
      e.periodLabel,
      e.sourceId,
    ]);
  }
  for (const s of release.series) {
    for (const o of s.observations) {
      rows.push([
        'observation',
        o.obsDate,
        o.value === null ? '' : String(o.value),
        s.units,
        o.vintageAt,
        'fred.csv',
      ]);
    }
    for (const g of s.revisions) {
      for (const v of g.vintages) {
        rows.push([
          'vintage',
          `${g.obsDate}|${v.vintageAt}`,
          v.value === null ? '' : String(v.value),
          s.units,
          v.vintageAt,
          'fred.csv',
        ]);
      }
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const ECO = defineFunction<typeof EcoParams, EcoPayload>({
  code: 'ECO',
  name: 'Economic Calendar',
  aliases: ['CAL', 'CALENDAR'],
  tier: 2,
  category: 'monitor',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: EcoParams,
  paramGrammar: {
    positional: [
      { name: 'range', type: 'enum', values: ['D', 'W', 'M'], optional: true },
      { name: 'date', type: 'date', optional: true },
    ],
    keyed: {
      CTY: { name: 'country', type: 'enum', values: ['US', 'ALL'] },
      IMP: { name: 'importance', type: 'int' },
      REL: { name: 'releaseId', type: 'int' },
      FOMC: { name: 'fomc', type: 'boolean' },
    },
  },
  fieldIds: (): FieldId[] => monitorPrecheckFields(ECO_PRECHECK_SUPERSET),
  pageable: true,
  live: (_params, payload) => {
    const subjects =
      payload.mode === 'release'
        ? (payload.release?.series ?? []).map((s) => `e:${s.seriesCode}`)
        : payload.days
            .flatMap((d) => d.events)
            .map((e) => e.subject)
            .filter((s): s is string => s !== null);
    const unique = [...new Set(subjects)];
    return unique.length === 0
      ? null
      : { subjects: unique, fields: '*' as const, conflationMs: 1000 };
  },
  csv: {
    filename: (params, ctx): string => {
      const asOf = ctx.asOf.replace(/[-:]/g, '');
      if (params.releaseId !== undefined) return `ECO_REL${String(params.releaseId)}_${asOf}.csv`;
      return `ECO_${params.range}_${asOf}.csv`;
    },
    columns: ecoCsvColumns,
    rows: (payload): CsvDocument['rows'] =>
      payload.mode === 'release' ? releaseRows(payload) : calendarRows(payload),
  },
  help: {
    summary: 'Macro release calendar with actual, prior and revised values; consensus unavailable',
    description:
      'ECO shows scheduled and released economic data by day, week or month from the FRED release ' +
      'calendar, the BLS release schedule and the FOMC calendar, with the actual print, the prior ' +
      'value and the revised prior taken from the stored observation vintages. Press 1/2/3 for ' +
      'day, week or month, C to switch between US and all countries, I to raise the importance ' +
      'filter and + / - to page to the next or previous window. Enter on a row opens the release, ' +
      'where every observation is listed with the exact vintage that produced it, so a revision is ' +
      'visible as data rather than as a footnote. Consensus, forecast dispersion and surprise are ' +
      'unavailable: no consensus-estimates provider is reachable in this wedge, so those columns ' +
      'show NO_CONSENSUS_SOURCE and are never filled with a guess.',
    params: [
      { name: 'range', text: 'D, W or M', example: 'ECO M' },
      { name: 'date', text: 'anchor day', example: 'ECO W 2026-10-05' },
      { name: 'country', text: 'US or ALL', example: 'CTY=ALL' },
      { name: 'importance', text: 'minimum importance 1–3', example: 'IMP=2' },
      { name: 'releaseId', text: 'open one release', example: 'REL=10' },
      { name: 'fomc', text: 'include FOMC meetings', example: 'FOMC=0' },
    ],
    keys: [
      { key: '1 / 2 / 3', action: 'day, week or month' },
      { key: 'C', action: 'cycle US / ALL' },
      { key: 'I', action: 'cycle the importance floor' },
      { key: 'F', action: 'toggle the FOMC block' },
      { key: 'T', action: 'back to the window containing today' },
      { key: '+ / -', action: 'later / earlier window' },
      { key: 'Enter', action: 'open the release' },
    ],
    sources: ['fred.calendar', 'bls.schedule', 'fed.fomc', 'fred.csv', 'bls.timeseries'],
    related: ['NI', 'GP', 'HP', 'BTMM', 'FED', 'WIRP'],
  },
  keymap: [
    { key: '1', action: 'tab-range', description: 'One day' },
    { key: '2', action: 'tab-range', description: 'One week' },
    { key: '3', action: 'tab-range', description: 'One month' },
    { key: 'C', action: 'cycle-country', description: 'US → ALL → US' },
    { key: 'I', action: 'cycle-importance', description: '1 → 2 → 3 → 1' },
    { key: 'F', action: 'toggle-fomc', description: 'Show or hide the FOMC block' },
    { key: 'T', action: 'today', description: 'Back to the window containing today' },
    { key: '+', action: 'page-fwd', when: 'grid', description: 'The later window' },
    { key: '-', action: 'page-back', when: 'grid', description: 'The earlier window' },
    { key: 'Enter', action: 'open-release', when: 'grid', description: 'Open the release detail' },
    {
      key: 'Shift+Enter',
      action: 'open-release-next',
      when: 'grid',
      description: 'Open the release detail in the next panel',
    },
    { key: 'G', action: 'open-gp', when: 'grid', description: 'Chart the headline series' },
    { key: 'N', action: 'open-news', when: 'grid', description: 'The economics topic feed' },
    { key: 'U', action: 'open-url', when: 'grid', description: 'Open the publisher page' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default ECO;
