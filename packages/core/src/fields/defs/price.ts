// packages/core/src/fields/defs/price.ts — field_class 'price'
//
// Market-data fields that come off a trading venue as published: the quote, the size, the session's
// open/high/low/close and the volume. Anything computed from them (CHG_*, 52-week extremes, moving
// averages) is field_class 'derived'; anything modelled (greeks, yields) is 'analytic'.

import type { FieldDef } from '../../types/fields.js';

type FieldSource = FieldDef['sources'][number];

const src = (
  assetClass: FieldSource['assetClass'],
  sourceId: string,
  endpoint: string,
  providerPath: string,
): FieldSource => ({ assetClass, sourceId, endpoint, providerPath });

const SINCE = '2026.09.1';

/** Everything the Cboe delayed-quote feed covers. */
const QUOTED = ['equity', 'etf', 'index'] as const;
const QUOTED_WIDE = ['equity', 'etf', 'index', 'fx', 'crypto'] as const;

export const priceFields: readonly FieldDef[] = [
  {
    id: 'PX_LAST',
    label: 'Last price',
    definition:
      'Price of the most recent trade on the primary venue, in the instrument currency. Outside ' +
      'trading hours it holds the last trade of the most recent session and the line reports the ' +
      'session state rather than a new timestamp.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'price',
    assetClasses: [...QUOTED_WIDE, 'option', 'future'],
    sources: [
      src('equity', 'cboe.quotes', 'quotes', 'data.current_price'),
      src('etf', 'cboe.quotes', 'quotes', 'data.current_price'),
      src('index', 'cboe.quotes', 'quotes', 'data.current_price'),
      src('fx', 'yahoo.chart', 'chart', 'meta.regularMarketPrice'),
      src('crypto', 'yahoo.chart', 'chart', 'meta.regularMarketPrice'),
      src('option', 'cboe.options', 'options', 'data.options[].last_trade_price'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'AAPL US Equity', value: 330.27, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'PX_BID',
    label: 'Bid',
    definition: 'Best bid price displayed on the primary venue at the quote timestamp.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'price',
    assetClasses: [...QUOTED_WIDE, 'option'],
    sources: [
      src('equity', 'cboe.quotes', 'quotes', 'data.bid'),
      src('etf', 'cboe.quotes', 'quotes', 'data.bid'),
      src('index', 'cboe.quotes', 'quotes', 'data.bid'),
      src('option', 'cboe.options', 'options', 'data.options[].bid'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'AAPL US Equity', value: 330.25, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'PX_ASK',
    label: 'Ask',
    definition: 'Best offer price displayed on the primary venue at the quote timestamp.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'price',
    assetClasses: [...QUOTED_WIDE, 'option'],
    sources: [
      src('equity', 'cboe.quotes', 'quotes', 'data.ask'),
      src('etf', 'cboe.quotes', 'quotes', 'data.ask'),
      src('index', 'cboe.quotes', 'quotes', 'data.ask'),
      src('option', 'cboe.options', 'options', 'data.options[].ask'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'AAPL US Equity', value: 330.29, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'BID_SIZE',
    label: 'Bid size',
    definition:
      'Quantity displayed at the best bid, in shares for equities and in contracts for options.',
    type: 'integer',
    unit: 'shares',
    decimals: 0,
    fieldClass: 'price',
    assetClasses: [...QUOTED, 'option'],
    sources: [
      src('equity', 'cboe.quotes', 'quotes', 'data.bid_size'),
      src('etf', 'cboe.quotes', 'quotes', 'data.bid_size'),
      src('option', 'cboe.options', 'options', 'data.options[].bid_size'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'AAPL US Equity', value: 300, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'ASK_SIZE',
    label: 'Ask size',
    definition:
      'Quantity displayed at the best offer, in shares for equities and in contracts for options.',
    type: 'integer',
    unit: 'shares',
    decimals: 0,
    fieldClass: 'price',
    assetClasses: [...QUOTED, 'option'],
    sources: [
      src('equity', 'cboe.quotes', 'quotes', 'data.ask_size'),
      src('etf', 'cboe.quotes', 'quotes', 'data.ask_size'),
      src('option', 'cboe.options', 'options', 'data.options[].ask_size'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'AAPL US Equity', value: 500, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'LAST_SIZE',
    label: 'Last trade size',
    definition: 'Quantity of the trade that set PX_LAST, in shares or contracts.',
    type: 'integer',
    unit: 'shares',
    decimals: 0,
    fieldClass: 'price',
    assetClasses: [...QUOTED, 'option'],
    sources: [
      src('equity', 'cboe.quotes', 'quotes', 'data.last_trade_size'),
      src('etf', 'cboe.quotes', 'quotes', 'data.last_trade_size'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'AAPL US Equity', value: 100, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'LAST_TRADE_TIME',
    label: 'Last trade time',
    definition:
      'Exchange timestamp of the trade that set PX_LAST, in UTC. It is the event time the staleness ' +
      'indicator measures against, never the time the row was ingested.',
    type: 'datetime',
    unit: 'datetime',
    decimals: null,
    fieldClass: 'price',
    assetClasses: [...QUOTED, 'option'],
    sources: [
      src('equity', 'cboe.quotes', 'quotes', 'data.last_trade_time'),
      src('etf', 'cboe.quotes', 'quotes', 'data.last_trade_time'),
      src('index', 'cboe.quotes', 'quotes', 'data.last_trade_time'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: {
      ref: 'AAPL US Equity',
      value: '2026-09-15T18:41:26Z',
      asOf: '2026-09-15T18:41:28Z',
    },
    since: SINCE,
  },
  {
    id: 'PX_OPEN',
    label: 'Open',
    definition: 'First trade price of the current regular session on the primary venue.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'price',
    assetClasses: [...QUOTED_WIDE],
    sources: [
      src('equity', 'cboe.quotes', 'quotes', 'data.open'),
      src('etf', 'cboe.quotes', 'quotes', 'data.open'),
      src('index', 'cboe.quotes', 'quotes', 'data.open'),
      src('*', 'yahoo.chart', 'chart', 'indicators.quote[0].open'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'AAPL US Equity', value: 330.24, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'PX_HIGH',
    label: 'High',
    definition: 'Highest trade price of the current regular session on the primary venue.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'price',
    assetClasses: [...QUOTED_WIDE],
    sources: [
      src('equity', 'cboe.quotes', 'quotes', 'data.high'),
      src('etf', 'cboe.quotes', 'quotes', 'data.high'),
      src('index', 'cboe.quotes', 'quotes', 'data.high'),
      src('*', 'yahoo.chart', 'chart', 'indicators.quote[0].high'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'AAPL US Equity', value: 331.59, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'PX_LOW',
    label: 'Low',
    definition: 'Lowest trade price of the current regular session on the primary venue.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'price',
    assetClasses: [...QUOTED_WIDE],
    sources: [
      src('equity', 'cboe.quotes', 'quotes', 'data.low'),
      src('etf', 'cboe.quotes', 'quotes', 'data.low'),
      src('index', 'cboe.quotes', 'quotes', 'data.low'),
      src('*', 'yahoo.chart', 'chart', 'indicators.quote[0].low'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'AAPL US Equity', value: 328.35, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'HIGH',
    label: 'Bar high',
    definition:
      'Highest trade price inside one intraday bar of the requested interval. Unlike PX_HIGH it is ' +
      'a property of the bar, so it only exists on a bar-bearing subject (b1m:) or a history row.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'price',
    assetClasses: [...QUOTED_WIDE],
    sources: [src('*', 'yahoo.chart', 'chart', 'indicators.quote[0].high[]')],
    updateFreq: '1m',
    pit: false,
    example: { ref: 'AAPL US Equity', value: 330.61, asOf: '2026-09-15T18:41:00Z' },
    since: SINCE,
  },
  {
    id: 'PX_CLOSE_1D',
    label: 'Previous close',
    definition:
      'Official closing price of the previous trading session, unadjusted for corporate actions. It ' +
      'is the denominator of CHG_PCT_1D and never changes intraday.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'price',
    assetClasses: [...QUOTED_WIDE],
    sources: [
      src('equity', 'cboe.quotes', 'quotes', 'data.prev_day_close'),
      src('etf', 'cboe.quotes', 'quotes', 'data.prev_day_close'),
      src('index', 'cboe.quotes', 'quotes', 'data.prev_day_close'),
      src('*', 'yahoo.chart', 'chart', 'meta.chartPreviousClose'),
    ],
    updateFreq: 'daily',
    pit: false,
    example: { ref: 'AAPL US Equity', value: 328.91, asOf: '2026-09-14' },
    since: SINCE,
  },
  {
    id: 'PX_OFFICIAL_CLOSE',
    label: 'Official close',
    definition:
      "The venue's official closing print for the session, published after the closing auction. It " +
      'is the value stored in bars_daily and the one every end-of-day analytic uses.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'price',
    assetClasses: [...QUOTED_WIDE],
    sources: [
      src('equity', 'cboe.quotes', 'quotes', 'data.close'),
      src('etf', 'cboe.quotes', 'quotes', 'data.close'),
      src('index', 'cboe.quotes', 'quotes', 'data.close'),
      src('*', 'yahoo.chart', 'chart', 'indicators.quote[0].close[]'),
    ],
    updateFreq: 'daily',
    pit: false,
    example: { ref: 'AAPL US Equity', value: 330.27, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'PX_VOLUME',
    label: 'Volume',
    definition:
      'Consolidated number of shares or contracts traded in the current session to the quote ' +
      'timestamp. Index subjects report the volume of their constituents only where the venue does.',
    type: 'integer',
    unit: 'shares',
    decimals: 0,
    fieldClass: 'price',
    assetClasses: [...QUOTED_WIDE, 'option'],
    sources: [
      src('equity', 'cboe.quotes', 'quotes', 'data.volume'),
      src('etf', 'cboe.quotes', 'quotes', 'data.volume'),
      src('option', 'cboe.options', 'options', 'data.options[].volume'),
      src('*', 'yahoo.chart', 'chart', 'indicators.quote[0].volume[]'),
    ],
    updateFreq: 'tick',
    pit: false,
    example: { ref: 'AAPL US Equity', value: 16591786, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
  {
    id: 'OPT_OI',
    label: 'Open interest',
    definition:
      'Number of contracts of this option series outstanding at the end of the previous session, as ' +
      'published by the clearing house through the venue.',
    type: 'integer',
    unit: 'contracts',
    decimals: 0,
    fieldClass: 'price',
    assetClasses: ['option'],
    sources: [src('option', 'cboe.options', 'options', 'data.options[].open_interest')],
    updateFreq: '1m',
    pit: false,
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 48213, asOf: '2026-09-15' },
    since: SINCE,
  },
  {
    id: 'OPT_UNDL_PX',
    label: 'Underlying price',
    definition:
      'Price of the underlying instrument used to quote and to value this option, taken from the ' +
      'same snapshot as the chain so the greeks and the underlying never disagree.',
    type: 'number',
    unit: 'price',
    decimals: null,
    fieldClass: 'price',
    assetClasses: ['option'],
    sources: [src('option', 'cboe.options', 'options', 'data.current_price')],
    updateFreq: '1m',
    pit: false,
    example: { ref: 'AAPL US 12/19/26 C350 Equity', value: 330.27, asOf: '2026-09-15T18:41:28Z' },
    since: SINCE,
  },
];
