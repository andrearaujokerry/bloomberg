// packages/core/src/fields/defs/econ.ts — field_class 'econ'
//
// Published statistics and policy rates. Every one of them is vintaged: a statistical agency revises
// a period's value long after the period ends, so `pit: true` here means "the value for a period
// depends on which release was known at knownAt", and ECO_VINTAGE names that release.

import type { FieldDef } from '../../types/fields.js';

type FieldSource = FieldDef['sources'][number];

const src = (
  assetClass: FieldSource['assetClass'],
  sourceId: string,
  endpoint: string,
  providerPath: string,
): FieldSource => ({ assetClass, sourceId, endpoint, providerPath });

const SINCE = '2026.09.1';
const SERIES = ['econ', 'rate'] as const;

export const econFields: readonly FieldDef[] = [
  {
    id: 'ECO_VALUE',
    label: 'Observation value',
    definition:
      'Value of the economic series for the observation period, in the unit the publisher uses ' +
      '(index level, percent, thousands of persons). The unit is a property of the series, so a ' +
      'screen must render it with the series metadata rather than assume percent.',
    type: 'number',
    unit: null,
    decimals: 3,
    fieldClass: 'econ',
    assetClasses: [...SERIES],
    sources: [
      src('econ', 'fred.csv', 'series', 'observations[].value'),
      src('econ', 'bls.timeseries', 'timeseries', 'Results.series[].data[].value'),
      src('econ', 'worldbank', 'indicator', '[1][].value'),
      src('econ', 'imf.datamapper', 'datamapper', 'values.<indicator>.<country>'),
      src('rate', 'nyfed.rates', 'rates', 'refRates[].percentRate'),
    ],
    updateFreq: 'monthly',
    pit: true,
    example: { ref: 'CPIAUCSL Index', value: 324.106, asOf: '2026-08-01' },
    since: SINCE,
  },
  {
    id: 'ECO_PERIOD',
    label: 'Observation period',
    definition:
      'First day of the period the observation describes — 2026-08-01 for August 2026, 2026-07-01 ' +
      'for Q3 2026 — never the date the figure was published.',
    type: 'date',
    unit: 'date',
    decimals: null,
    fieldClass: 'econ',
    assetClasses: [...SERIES],
    sources: [
      src('econ', 'fred.csv', 'series', 'observations[].date'),
      src('econ', 'bls.timeseries', 'timeseries', 'Results.series[].data[].period'),
    ],
    updateFreq: 'monthly',
    pit: false,
    example: { ref: 'CPIAUCSL Index', value: '2026-08-01', asOf: '2026-09-11' },
    since: SINCE,
  },
  {
    id: 'ECO_RELEASE_DT',
    label: 'Release date',
    definition:
      'Date the publisher released this observation. It is the knownAt of the value: a run as of ' +
      'the day before it returns the previous vintage instead.',
    type: 'date',
    unit: 'date',
    decimals: null,
    fieldClass: 'econ',
    assetClasses: [...SERIES],
    sources: [
      src('econ', 'fred.calendar', 'calendar', 'release_dates[].date'),
      src('econ', 'bls.schedule', 'schedule', 'rows[].release_date'),
    ],
    updateFreq: 'monthly',
    pit: false,
    example: { ref: 'CPIAUCSL Index', value: '2026-09-11', asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'ECO_VINTAGE',
    label: 'Vintage',
    definition:
      'Identifier of the release this value came from, as the publisher labels it (an ALFRED ' +
      'vintage date, a BLS release id). Two vintages of one period are two rows, never an update.',
    type: 'string',
    unit: 'text',
    decimals: null,
    fieldClass: 'econ',
    assetClasses: [...SERIES],
    sources: [src('econ', 'fred.csv', 'series', 'vintage_dates[]')],
    updateFreq: 'monthly',
    pit: true,
    example: { ref: 'CPIAUCSL Index', value: '2026-09-11', asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'ECO_PRIOR',
    label: 'Prior value',
    definition:
      'Value of the previous observation period as it stood in this release — the comparison the ' +
      'publisher printed, so it already reflects any revision made to that period by this release.',
    type: 'number',
    unit: null,
    decimals: 3,
    fieldClass: 'econ',
    assetClasses: [...SERIES],
    sources: [src('econ', 'fred.csv', 'series', 'observations[-2].value')],
    updateFreq: 'monthly',
    pit: true,
    example: { ref: 'CPIAUCSL Index', value: 323.048, asOf: '2026-08-13' },
    since: SINCE,
  },

  // ── WP-11 Tier 3: the NY Fed's published SOFR averages and index (FUNCTIONS_TIER3 FED L1806,
  //    SWPM L1161, WIRP L597). The daily fixing itself is `RATE` and lives in `price.ts` with
  //    field_class 'price'; these four are not fixings. The New York Fed *computes and publishes*
  //    them from the fixing history — compounded 30/90/180-day averages and a cumulative index —
  //    so they are published statistics of a rate, which is what field_class 'econ' names, and
  //    they arrive on the same `nyfed.rates` payload under `SOFRAI` (PROVIDERS §9.1). They are
  //    stored on `rate_fixings.avg_30d` / `avg_90d` / `avg_180d` / `index_value`.
  {
    id: 'RATE_AVG_30D',
    label: 'SOFR 30-day average',
    definition:
      'Compounded average of the overnight rate over the previous 30 calendar days, in percent, ' +
      'as the publisher computes it. It is not a mean of the RATE column: the publisher compounds ' +
      'daily and carries the rate over non-business days, so recomputing it from RATE is wrong by ' +
      'a basis point or two and must never be done here.',
    type: 'number',
    unit: 'pct',
    decimals: 5,
    fieldClass: 'econ',
    assetClasses: ['rate'],
    sources: [src('rate', 'nyfed.rates', 'rates', 'refRates[].average30day')],
    updateFreq: 'daily',
    pit: true,
    example: { ref: 'SOFR Index', value: 3.6485, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'RATE_AVG_90D',
    label: 'SOFR 90-day average',
    definition:
      'Compounded average of the overnight rate over the previous 90 calendar days, in percent, ' +
      'as the publisher computes it (see RATE_AVG_30D on why it is never recomputed).',
    type: 'number',
    unit: 'pct',
    decimals: 5,
    fieldClass: 'econ',
    assetClasses: ['rate'],
    sources: [src('rate', 'nyfed.rates', 'rates', 'refRates[].average90day')],
    updateFreq: 'daily',
    pit: true,
    example: { ref: 'SOFR Index', value: 3.64603, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'RATE_AVG_180D',
    label: 'SOFR 180-day average',
    definition:
      'Compounded average of the overnight rate over the previous 180 calendar days, in percent, ' +
      'as the publisher computes it (see RATE_AVG_30D on why it is never recomputed).',
    type: 'number',
    unit: 'pct',
    decimals: 5,
    fieldClass: 'econ',
    assetClasses: ['rate'],
    sources: [src('rate', 'nyfed.rates', 'rates', 'refRates[].average180day')],
    updateFreq: 'daily',
    pit: true,
    example: { ref: 'SOFR Index', value: 3.65767, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'RATE_INDEX',
    label: 'SOFR index',
    definition:
      'Cumulative compounded value of the overnight rate since the index base date, a level and ' +
      'not a rate: the compounded return between two dates is the ratio of the two index values. ' +
      'Published to eight decimals, and eight decimals is what a floating-rate coupon needs, so ' +
      'it is carried as decimal text end to end and never through a float.',
    type: 'number',
    unit: null,
    decimals: 8,
    fieldClass: 'econ',
    assetClasses: ['rate'],
    sources: [src('rate', 'nyfed.rates', 'rates', 'refRates[].index')],
    updateFreq: 'daily',
    pit: true,
    example: { ref: 'SOFR Index', value: 1.25884091, asOf: '2026-09-15' },
    since: SINCE,
  },

  // ── Harvested id kept for coverage (see reference.ts for why) ────────────────────────────────
  {
    id: 'ECO_',
    label: 'Economic field family',
    definition:
      'Not a field: the ECO_* prefix, harvested from wildcard references to the economic-release ' +
      'family. Use the concrete member — ECO_VALUE, ECO_PERIOD, ECO_RELEASE_DT, ECO_VINTAGE.',
    type: 'string',
    unit: 'text',
    decimals: null,
    fieldClass: 'econ',
    assetClasses: [],
    sources: [],
    updateFreq: 'static',
    pit: false,
    example: { ref: '-', value: 'ECO_*', asOf: '2026-09-17' },
    since: SINCE,
    deprecated: { since: SINCE, replacement: 'ECO_VALUE', removeAfter: '2027.01.1' },
  },

  // ── WP-06 subject fields (API.md §6.1): e:<seriesCode> latest observation ────────────────────
  {
    id: 'VALUE',
    label: 'Value',
    definition:
      'Latest observation of the series on the e: subject, in the publisher’s unit. The ' +
      'point-in-time history is ECO_VALUE; this is the live head of it.',
    type: 'number',
    unit: null,
    decimals: 3,
    fieldClass: 'econ',
    assetClasses: [],
    sources: [
      src('econ', 'fred.csv', 'series', 'observations[].value'),
      src('econ', 'bls.timeseries', 'timeseries', 'Results.series[].data[].value'),
      src('rate', 'nyfed.rates', 'rates', 'refRates[].percentRate'),
    ],
    updateFreq: 'monthly',
    pit: false,
    example: { ref: 'e:CPIAUCSL', value: 324.106, asOf: '2026-09-11T12:30:00Z' },
    since: SINCE,
  },
  {
    id: 'PERIOD',
    label: 'Period',
    definition: 'Observation period of VALUE as an ISO date: the first day of the month, quarter or year it covers.',
    type: 'date',
    unit: 'date',
    decimals: null,
    fieldClass: 'econ',
    assetClasses: [],
    sources: [
      src('econ', 'fred.csv', 'series', 'observations[].date'),
      src('econ', 'bls.timeseries', 'timeseries', 'Results.series[].data[].period'),
    ],
    updateFreq: 'monthly',
    pit: false,
    example: { ref: 'e:CPIAUCSL', value: '2026-08-01', asOf: '2026-09-11T12:30:00Z' },
    since: SINCE,
  },
  {
    id: 'RELEASED_AT',
    label: 'Released',
    definition: 'Time the publisher released the observation carried in VALUE, in UTC.',
    type: 'datetime',
    unit: 'datetime',
    decimals: null,
    fieldClass: 'econ',
    assetClasses: [],
    sources: [
      src('econ', 'fred.calendar', 'calendar', 'release_dates[].date'),
      src('econ', 'bls.schedule', 'schedule', 'rows[].release_date'),
    ],
    updateFreq: 'monthly',
    pit: false,
    example: { ref: 'e:CPIAUCSL', value: '2026-09-11T12:30:00Z', asOf: '2026-09-11T12:30:00Z' },
    since: SINCE,
  },
  {
    id: 'PREV',
    label: 'Previous',
    definition: 'The observation immediately before VALUE, as last published (revised where the publisher revised it).',
    type: 'number',
    unit: null,
    decimals: 3,
    fieldClass: 'econ',
    assetClasses: [],
    sources: [
      src('econ', 'fred.csv', 'series', 'observations[].value'),
      src('econ', 'bls.timeseries', 'timeseries', 'Results.series[].data[].value'),
    ],
    updateFreq: 'monthly',
    pit: false,
    example: { ref: 'e:CPIAUCSL', value: 323.048, asOf: '2026-09-11T12:30:00Z' },
    since: SINCE,
  },
  {
    id: 'REVISED',
    label: 'Revised',
    definition: 'True when the latest release revised a previously published observation of the series.',
    type: 'boolean',
    unit: null,
    decimals: null,
    fieldClass: 'econ',
    assetClasses: [],
    sources: [src('econ', 'fred.csv', 'series', 'observations[].value')],
    updateFreq: 'monthly',
    pit: false,
    example: { ref: 'e:CPIAUCSL', value: false, asOf: '2026-09-11T12:30:00Z' },
    since: SINCE,
  },
  {
    id: 'STATUS',
    label: 'Status',
    definition: 'Release status of VALUE: preliminary, final or revised, as the publisher marks the vintage.',
    type: 'enum',
    unit: 'enum',
    decimals: null,
    enumValues: ['preliminary', 'final', 'revised'],
    fieldClass: 'econ',
    assetClasses: [],
    sources: [src('econ', 'fred.csv', 'series', 'observations[].realtime_start')],
    updateFreq: 'monthly',
    pit: false,
    example: { ref: 'e:CPIAUCSL', value: 'final', asOf: '2026-09-11T12:30:00Z' },
    since: SINCE,
  },
];
