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
];
