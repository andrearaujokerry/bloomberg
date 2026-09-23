// packages/core/src/functions/manifests/GIP.ts
//
// GIP — Intraday Price Graph (FUNCTIONS_TIER1.md §GIP L551-657, FUNCTIONS.md §6 L1078).
//
// One variant, `intraday`, for every asset class that has an intraday tape: equity, etf, index,
// fx, crypto and option. The screen is `custom` (the chart owns a canvas) and the payload is what
// the canvas draws: final bars, the forming bar, the session bands and the header statistics.
//
// The forming bar is the whole point of this function and the reason it is not just `GP 1D`: the
// last bar of the window is provisional, comes from the plant's `b1m:` composite rather than from
// `bars_intraday`, and is sealed by an `IS_FINAL:true` delta. It is a separate payload key so that
// a screen can never mistake a provisional bar for a closed one (TERM-12).

import { z } from 'zod';

import type { FieldId } from '../../types/fields.js';
import type { AssetClass } from '../../types/instrument.js';
import type { ValueCell } from '../../types/function.js';
import type { CsvColumn, KeyBinding } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import type { FnInstrumentSummary } from './GP.js';
import { asOfCompact, isoFromEpochMs, slugOf } from './GP.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const GipParams = z.object({
  days: z.enum(['1', '2', '5']).default('1'),
  /** Five days forces `5m`; the resolver echoes the effective interval in `payload.interval`. */
  interval: z.enum(['1m', '5m']).default('1m'),
  session: z.enum(['regular', 'extended']).default('regular'),
  vwap: z.boolean().default(true),
  prevClose: z.boolean().default(true),
  volume: z.boolean().default(true),
});
export type GipParams = z.infer<typeof GipParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface GipBars {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
  provIdx: number;
}

export interface GipFormingBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  isFinal: false;
  provIdx: number;
}

export interface GipSessionBand {
  start: number;
  end: number;
  kind: 'pre' | 'regular' | 'post';
  date: string;
}

export interface GipStats {
  open: ValueCell;
  high: ValueCell;
  low: ValueCell;
  last: ValueCell;
  chgNet: ValueCell;
  chgPct: ValueCell;
  volume: ValueCell;
  vwapNow: ValueCell;
  pctOfAvgVolume30d: ValueCell;
  sessionState: ValueCell;
}

export interface GipPayload {
  variant: 'intraday';
  instrument: FnInstrumentSummary;
  interval: '1m' | '5m';
  days: 1 | 2 | 5;
  tz: string;
  calendarId: string;
  bars: GipBars;
  /** From `b1m:<id>` at resolve time; `null` when the plant holds no provisional bar. */
  forming: GipFormingBar | null;
  sessions: GipSessionBand[];
  /** Cumulative per regular session, aligned to `bars.t`; `NaN` outside a regular session. */
  vwap: number[] | null;
  /**
   * The block citation for {@link GipPayload.vwap} (§0.4 rule 4, DATA-10).
   *
   * VWAP is derived from the bar block and cites the bar block's `provIdx`, the way `GpSeries`
   * carries one `provIdx` for its whole `c[]`. Without it the series is several hundred prices a
   * client cannot trace — and `vwap` is a declared CSV column, so those prices leave the building
   * in an export whose header advertises a provenance trail. `-1` when `vwap` is `null`.
   */
  vwapProvIdx: number;
  prevClose: ValueCell;
  stats: GipStats;
  sourceLine: {
    mdLineId: number;
    sourceId: string;
    providerSymbol: string;
    intrinsicDelayMin: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entitlement pre-check field set (§GIP "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

const GIP_FIELDS: readonly FieldId[] = [
  'BAR_TS',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_LAST',
  'PX_VOLUME',
  'IS_FINAL',
  'PX_CLOSE_1D',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'VWAP',
  'SESSION_STATE',
  'VOLUME_AVG_30D',
];

function fieldsFor(_assetClass: AssetClass | null): FieldId[] {
  return [...GIP_FIELDS];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Static columns (§GIP CSV): one row per final bar, then the forming bar with `session:'forming'`. */
export const gipCsvColumns: readonly CsvColumn[] = [
  { id: 't', label: 'Timestamp', type: 'string' },
  { id: 'open', label: 'Open', type: 'number' },
  { id: 'high', label: 'High', type: 'number' },
  { id: 'low', label: 'Low', type: 'number' },
  { id: 'close', label: 'Close', type: 'number' },
  { id: 'volume', label: 'Volume', type: 'number' },
  { id: 'vwap', label: 'VWAP', type: 'number' },
  { id: 'session', label: 'Session', type: 'string' },
];

/** `2026-09-15T13:30:00Z` — ISO-8601 UTC without the millisecond field. */
export function gipCsvTimestamp(ms: number): string {
  return isoFromEpochMs(ms);
}

/** Which band a bar start falls in; `'regular'` when the bands do not cover it. */
function sessionOf(payload: GipPayload, t: number): string {
  for (const band of payload.sessions) {
    if (t >= band.start && t < band.end) return band.kind;
  }
  return 'regular';
}

export function gipCsvRows(payload: GipPayload): (string | number | null)[][] {
  const rows: (string | number | null)[][] = [];
  for (const [i, t] of payload.bars.t.entries()) {
    const vwap = payload.vwap?.[i];
    rows.push([
      gipCsvTimestamp(t),
      payload.bars.o[i] ?? null,
      payload.bars.h[i] ?? null,
      payload.bars.l[i] ?? null,
      payload.bars.c[i] ?? null,
      payload.bars.v[i] ?? null,
      vwap === undefined || Number.isNaN(vwap) ? null : vwap,
      sessionOf(payload, t),
    ]);
  }
  const forming = payload.forming;
  if (forming !== null) {
    rows.push([
      gipCsvTimestamp(forming.t),
      forming.o,
      forming.h,
      forming.l,
      forming.c,
      forming.v,
      null,
      'forming',
    ]);
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Keymap — §2.6's reserved `Enter` stays with the shell; the chart node handles it itself.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const KEYMAP: readonly KeyBinding[] = [
  { key: 'ArrowLeft', action: 'crosshair-prev', when: 'chart', description: 'Crosshair one bar left' },
  { key: 'ArrowRight', action: 'crosshair-next', when: 'chart', description: 'Crosshair one bar right' },
  { key: 'Home', action: 'crosshair-first', when: 'chart', description: 'Crosshair to the first bar' },
  { key: 'End', action: 'crosshair-last', when: 'chart', description: 'Crosshair to the last bar' },
  { key: 'Shift+ArrowLeft', action: 'pan-left', when: 'chart', description: 'Pan one hour left' },
  { key: 'Shift+ArrowRight', action: 'pan-right', when: 'chart', description: 'Pan one hour right' },
  { key: '+', action: 'zoom-in', when: 'chart', description: 'Zoom in around the crosshair' },
  { key: '-', action: 'zoom-out', when: 'chart', description: 'Zoom out around the crosshair' },
  { key: '1', action: 'days-1', description: 'One trading day' },
  { key: '2', action: 'days-2', description: 'Two trading days' },
  { key: '5', action: 'days-5', description: 'Five trading days' },
  { key: 'I', action: 'toggle-interval', description: 'Switch between 1m and 5m' },
  { key: 'X', action: 'toggle-session', description: 'Regular or extended hours' },
  { key: 'V', action: 'toggle-vwap', description: 'Toggle VWAP' },
  { key: 'C', action: 'toggle-prevclose', description: 'Toggle the previous-close line' },
  { key: 'B', action: 'toggle-volume', description: 'Toggle the volume pane' },
  { key: 'T', action: 'cycle-type', description: 'Cycle candle, ohlc, line, area (display only)' },
  { key: 'G', action: 'open-gp', description: 'Open GP' },
  { key: 'Q', action: 'open-q', description: 'Open Q' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const GIP = defineFunction<typeof GipParams, GipPayload>({
  code: 'GIP',
  name: 'Intraday Price Graph',
  aliases: ['INTRA'],
  tier: 1,
  category: 'charting',
  assetClasses: ['equity', 'etf', 'index', 'fx', 'crypto', 'option'],
  requiresSecurity: true,
  variants: {
    equity: 'intraday',
    etf: 'intraday',
    index: 'intraday',
    fx: 'intraday',
    crypto: 'intraday',
    option: 'intraday',
  },
  params: GipParams,
  paramGrammar: {
    positional: [
      { name: 'days', type: 'enum', values: ['1', '2', '5'], optional: true },
      { name: 'interval', type: 'enum', values: ['1m', '5m'], optional: true },
    ],
    keyed: {
      SESS: { name: 'session', type: 'enum', values: ['regular', 'extended'] },
      VWAP: { name: 'vwap', type: 'boolean' },
    },
  },
  fieldIds: fieldsFor,
  pageable: false,
  live: (_params, payload) => ({
    subjects: [
      `b1m:${String(payload.instrument.instrumentId)}`,
      `q:${String(payload.instrument.instrumentId)}`,
    ],
    fields: [
      'BAR_TS',
      'PX_OPEN',
      'PX_HIGH',
      'PX_LOW',
      'PX_LAST',
      'PX_VOLUME',
      'IS_FINAL',
      'PX_CLOSE_1D',
      'CHG_NET_1D',
      'CHG_PCT_1D',
      'SESSION_STATE',
    ],
    conflationMs: 250,
    essential: [`q:${String(payload.instrument.instrumentId)}`],
  }),
  csv: {
    filename: (params, ctx) =>
      `GIP_${slugOf(ctx.display)}_${params.days}D${params.interval}_${asOfCompact(ctx.asOf)}.csv`,
    columns: [...gipCsvColumns],
    rows: (payload) => gipCsvRows(payload),
  },
  help: {
    summary: 'Intraday chart: 1- or 5-minute bars with VWAP, sessions and the forming bar streamed',
    description:
      'GIP charts the current session (or the last two or five) at one- or five-minute resolution ' +
      'from the Yahoo chart feed (15 minutes delayed at source). The last bar is the forming bar ' +
      'and updates from the ticker plant until it is sealed; VWAP is cumulative per regular ' +
      'session; pre- and post-market bars are included with SESS=EXTENDED.\n\n' +
      'The previous close is drawn as a reference line. Indices and FX have no volume, so VWAP and ' +
      'the volume pane are not applicable. Crypto intraday bars are built from the captured ' +
      'CoinGecko polls and are context only.',
    params: [
      { name: 'days', text: '1, 2 or 5 trading days', example: '5' },
      { name: 'interval', text: '1m or 5m (5D forces 5m)', example: '5m' },
      { name: 'session', text: 'Regular or extended hours', example: 'SESS=EXTENDED' },
      { name: 'vwap', text: 'Draw VWAP', example: 'VWAP=N' },
      { name: 'prevClose', text: 'Draw the previous close', example: 'C toggles' },
      { name: 'volume', text: 'Volume pane', example: 'B toggles' },
    ],
    keys: KEYMAP.map((k) => ({ key: k.key, action: k.description })),
    sources: ['yahoo.chart', 'cboe.quotes', 'coingecko.simple', 'internal.derived'],
    related: ['GP', 'Q', 'DES', 'HP'],
  },
  keymap: KEYMAP,
  screenKind: 'custom',
  payloadVersion: 1,
});
