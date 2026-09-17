// packages/core/src/fields/defs/reference.ts — field_class 'reference'
//
// Descriptive, slowly-changing terms of an instrument or of a membership: what the contract is,
// not what it is worth. Every one of them is bitemporal (`pit: true`) unless it is a property of a
// contract that cannot be restated.

import type { FieldDef } from '../../types/fields.js';

type FieldSource = FieldDef['sources'][number];

const src = (
  assetClass: FieldSource['assetClass'],
  sourceId: string,
  endpoint: string,
  providerPath: string,
): FieldSource => ({ assetClass, sourceId, endpoint, providerPath });

const SINCE = '2026.09.1';
const REMOVE_AFTER = '2027.01.1';

export const referenceFields: readonly FieldDef[] = [
  {
    id: 'EQY_SH_OUT',
    label: 'Shares outstanding',
    definition:
      'Number of common shares issued and outstanding as reported on the cover page of the most ' +
      'recent periodic filing known at knownAt. Not adjusted for splits after that filing date.',
    type: 'number',
    unit: 'shares',
    decimals: 0,
    fieldClass: 'reference',
    assetClasses: ['equity', 'etf'],
    sources: [
      src(
        'equity',
        'sec.companyfacts',
        'companyfacts',
        'facts.dei.EntityCommonStockSharesOutstanding',
      ),
    ],
    updateFreq: 'on_filing',
    pit: true,
    example: { ref: 'AAPL US Equity', value: 14840392000, asOf: '2026-08-01' },
    since: SINCE,
  },
  {
    id: 'CPN_FREQ',
    label: 'Coupon frequency',
    definition:
      'Number of coupon payments per year fixed by the terms of the issue: 2 for a US Treasury ' +
      'note or bond, 0 for a discount bill.',
    type: 'integer',
    unit: 'count',
    decimals: 0,
    fieldClass: 'reference',
    assetClasses: ['govt'],
    sources: [src('govt', 'treasury.bills', 'bills', 'securities[].interestPaymentFrequency')],
    updateFreq: 'static',
    pit: true,
    example: { ref: 'T 4 1/4 11/15/35 Govt', value: 2, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'OPT_STRIKE_PX',
    label: 'Strike price',
    definition: 'Exercise price of the option series, in the contract currency.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'reference',
    assetClasses: ['option'],
    sources: [src('option', 'cboe.options', 'options', 'data.options[].option')],
    updateFreq: 'static',
    pit: false,
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 350, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'OPT_EXPIRE_DT',
    label: 'Expiration date',
    definition:
      'Last date on which the option may be exercised, parsed from the OCC symbol; the expiry cut ' +
      'itself is a property of the venue, not of this field.',
    type: 'date',
    unit: 'date',
    decimals: null,
    fieldClass: 'reference',
    assetClasses: ['option'],
    sources: [src('option', 'cboe.options', 'options', 'data.options[].option')],
    updateFreq: 'static',
    pit: false,
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: '2026-12-19', asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'OPT_PUT_CALL',
    label: 'Put/call',
    definition: 'Whether the series is a call (C) or a put (P), from the OCC symbol.',
    type: 'enum',
    unit: 'enum',
    decimals: null,
    enumValues: ['C', 'P'],
    fieldClass: 'reference',
    assetClasses: ['option'],
    sources: [src('option', 'cboe.options', 'options', 'data.options[].option')],
    updateFreq: 'static',
    pit: false,
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 'C', asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'OPT_CONT_SIZE',
    label: 'Contract size',
    definition:
      'Number of underlying units one contract delivers — 100 shares for a standard US equity ' +
      'option, less after an adjustment for a corporate action.',
    type: 'integer',
    unit: 'shares',
    decimals: 0,
    fieldClass: 'reference',
    assetClasses: ['option'],
    sources: [src('option', 'cboe.symbolBook', 'symbolBook', 'rows[].contract_size')],
    updateFreq: 'static',
    pit: true,
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 100, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'OPT_UNDL_TICKER',
    label: 'Underlying ticker',
    definition:
      'Display ticker of the instrument the option delivers, as the terminal resolves it — the ' +
      'root symbol of the OCC code mapped back onto a loadable security.',
    type: 'string',
    unit: 'text',
    decimals: null,
    fieldClass: 'reference',
    assetClasses: ['option'],
    sources: [src('option', 'cboe.options', 'options', 'data.symbol')],
    updateFreq: 'static',
    pit: false,
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 'AAPL US Equity', asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'IDX_MEMBER_WEIGHT',
    label: 'Index weight',
    definition:
      'Weight of the member in the index as of the effective date of the holdings file, expressed ' +
      'as a fraction of the index (0.0712 = 7.12 %).',
    type: 'number',
    unit: 'ratio',
    decimals: 6,
    fieldClass: 'reference',
    assetClasses: ['index', 'etf'],
    sources: [
      src('index', 'sec.archives', 'archives', 'invstOrSec[].pctVal'),
      src('etf', 'ssga.holdings', 'holdings', 'rows[].Weight'),
    ],
    updateFreq: 'monthly',
    pit: true,
    example: { ref: 'SPX Index', value: 0.0712, asOf: '2026-08-31' },
    since: SINCE,
  },
  {
    id: 'IDX_MEMBER_SHARES',
    label: 'Index shares held',
    definition:
      'Share count of the member held by the index vehicle at the effective date of the holdings ' +
      'file; the basis of the weight when the index is share-weighted.',
    type: 'number',
    unit: 'shares',
    decimals: 0,
    fieldClass: 'reference',
    assetClasses: ['index', 'etf'],
    sources: [
      src('index', 'sec.archives', 'archives', 'invstOrSec[].balance'),
      src('etf', 'ssga.holdings', 'holdings', 'rows[].Shares Held'),
    ],
    updateFreq: 'monthly',
    pit: true,
    example: { ref: 'SPX Index', value: 173920000, asOf: '2026-08-31' },
    since: SINCE,
  },
  {
    id: 'IDX_MEMBER_SINCE',
    label: 'Member since',
    definition:
      'First date on which the member appears in the index membership history the terminal holds. ' +
      'It is the start of the bitemporal membership row, not an index-provider announcement date.',
    type: 'date',
    unit: 'date',
    decimals: null,
    fieldClass: 'reference',
    assetClasses: ['index', 'etf'],
    sources: [src('index', 'sec.archives', 'archives', 'filing.periodOfReport')],
    updateFreq: 'monthly',
    pit: true,
    example: { ref: 'SPX Index', value: '2013-04-30', asOf: '2026-08-31' },
    since: SINCE,
  },

  // ── Harvested ids kept for coverage ─────────────────────────────────────────────────────────
  // CONTRACTS §4.3 collects every identifier the design writes in field position. Two of the
  // reference-family entries there are not data fields: they are a wildcard and a command token.
  // They are declared (so the dictionary covers the whole list and `GET /fields/:id` answers
  // rather than 404s) and deprecated on the same day, so the generator can drop them once §4.3 is
  // regenerated from this dictionary instead of from prose.
  {
    id: 'OPT_',
    label: 'Option field family',
    definition:
      'Not a field: the OPT_* prefix, harvested from wildcard references to the option field ' +
      'family. Use the concrete member — OPT_STRIKE_PX, OPT_DELTA, OPT_IV and the rest.',
    type: 'string',
    unit: 'text',
    decimals: null,
    fieldClass: 'reference',
    assetClasses: [],
    sources: [],
    updateFreq: 'static',
    pit: false,
    example: { ref: '-', value: 'OPT_*', asOf: '2026-09-17' },
    since: SINCE,
    deprecated: { since: SINCE, replacement: null, removeAfter: REMOVE_AFTER },
  },
  {
    id: 'CPNTO',
    label: 'Coupon upper bound (screener token)',
    definition:
      'Not a field: the SRCH screener keyed token CPNTO=<rate>, which bounds a coupon filter from ' +
      'above. The coupon itself is carried by CPN_FREQ and the govt terms block.',
    type: 'number',
    unit: 'pct',
    decimals: 3,
    fieldClass: 'reference',
    assetClasses: [],
    sources: [],
    updateFreq: 'static',
    pit: false,
    example: { ref: '-', value: 'CPNTO=5', asOf: '2026-09-17' },
    since: SINCE,
    deprecated: { since: SINCE, replacement: null, removeAfter: REMOVE_AFTER },
  },
];
