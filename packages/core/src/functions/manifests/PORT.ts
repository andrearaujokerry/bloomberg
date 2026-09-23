// packages/core/src/functions/manifests/PORT.ts
//
// `PORT` — Portfolio Analytics (FUNCTIONS_TIER2.md §PORT L1321-1531, FUNCTIONS.md §6 L1098).
//
// Four views over one book — holdings, exposure, Brinson–Fachler attribution and ex-post risk —
// and one property that outranks all of them: **the book never leaves the firm** (PORT-07). The
// payload says so in a field rather than in a comment, `confidentiality.firmOnly`, because the CSV
// header and the screen badge both render from it and a rule that lives only in prose is a rule
// that gets exported by accident.
//
// Three shapes in this file are worth reading before the resolver:
//
//  1. **Views are mutually exclusive and null when not asked for.** `exposure`, `attribution` and
//     `risk` are `null` unless `params.view` selected them. An unrequested analytic is not merely
//     hidden — it is never computed, never logged and never cached, which is what keeps a
//     `holdings` launch at three round trips and what keeps a PM's risk numbers out of a screen
//     they did not open.
//  2. **What cannot be measured is named, not zeroed.** `risk.varMonteCarlo` and
//     `risk.factorExposures` are typed `null` — not optional, not `number | null` — because there
//     is no Monte-Carlo VaR and no licensable factor model in this build, and a type that admitted
//     a number would invite one. Fixed-income positions land in `attribution.unattributed` with
//     `FI_ATTRIBUTION_UNAVAILABLE` for the same reason.
//  3. **`benchWeight` is zero, `activeWeight` is the position.** A held name the benchmark does not
//     carry has a benchmark weight of zero, never `null`: the active weight of an off-benchmark
//     position is the whole position. `null` on both columns means one thing only — the portfolio
//     has no benchmark at all.
//
// The five portfolio-class field ids this function produces (`PORT_MV`, `PORT_WEIGHT`,
// `PORT_PNL_1D`, `PORT_ACTIVE_WEIGHT`, `PORT_CONTRIB_TE`) are the ones API.md §7 already declares;
// `PORT_UNREAL_PNL`, `PORT_BETA` and `PORT_VAR` were added with WP-10's `fields/defs/portfolio.ts`.

import { z } from 'zod';

import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';
import { precheckFields } from './CACS.js';
import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import type { AssetClass, MarketSector } from '../../types/instrument.js';
import { SecurityRefInput } from '../schemas.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§PORT "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const PORT_SCENARIO_IDS = [
  'UST_PARALLEL_UP_100',
  'UST_PARALLEL_DN_100',
  'UST_STEEPEN_50',
  'EQUITY_DOWN_10',
  'EQUITY_DOWN_20',
  'USD_UP_5',
  'USD_DN_5',
  'EPISODE_2020_COVID',
  'EPISODE_2022_RATES',
] as const;

export const PORT_VIEWS = ['holdings', 'exposure', 'attribution', 'risk'] as const;
export const PORT_GROUP_BY = ['sector', 'assetClass', 'currency', 'instrument'] as const;
export const PORT_VAR_METHODS = ['historical', 'parametric'] as const;
export const PORT_VAR_CONFIDENCES = ['95', '99'] as const;

export const PortScenarioId = z.enum(PORT_SCENARIO_IDS);
export type PortScenarioId = z.infer<typeof PortScenarioId>;

/** The four scenarios a bare `PORT RISK` shows: a rate shock, an equity shock, FX and an episode. */
export const PORT_DEFAULT_SCENARIOS: readonly PortScenarioId[] = [
  'UST_PARALLEL_UP_100',
  'EQUITY_DOWN_10',
  'USD_UP_5',
  'EPISODE_2022_RATES',
];

export const PortParams = z.object({
  /** Undefined = the caller's most recently updated portfolio. */
  portfolioId: z.number().int().positive().optional(),
  view: z.enum(PORT_VIEWS).default('holdings'),
  /** Positions as-of date; undefined = the latest stored `positions.as_of_date`. */
  asOfDate: z.iso.date().optional(),
  /** Overrides `portfolios.benchmark_instrument_id` for this run. */
  benchmark: SecurityRefInput.optional(),
  groupBy: z.enum(PORT_GROUP_BY).default('sector'),
  /** Risk/attribution window in sessions (ANAL-07 annualisation 252). */
  lookbackDays: z.number().int().min(60).max(1260).default(252),
  varMethod: z.enum(PORT_VAR_METHODS).default('historical'),
  varConfidence: z.enum(PORT_VAR_CONFIDENCES).default('95'),
  scenarios: z.array(PortScenarioId).max(9).default([...PORT_DEFAULT_SCENARIOS]),
});
export type PortParams = z.infer<typeof PortParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§PORT "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type PortView = (typeof PORT_VIEWS)[number];
export type PortGroupBy = (typeof PORT_GROUP_BY)[number];
export type PortReconStatus = 'ok' | 'unresolved' | 'duplicate' | 'price_missing';

export interface PortHoldingRow {
  positionId: number;
  instrumentId: number | null;
  /** `'AAPL US Equity'`; `null` for cash and for an unresolved identifier. */
  key: string | null;
  name: string;
  rawIdentifier: string;
  assetClass: AssetClass | null;
  marketSector: MarketSector | null;
  gicsSector: string | null;
  currency: string;
  isCash: boolean;
  lotCount: number;
  quantity: number;
  costPrice: number | null;
  costCurrency: string | null;
  tradeDate: string | null;
  accrued: number;
  /** `PX_LAST` and `FX_USD` — both live where a subject exists. */
  px: ValueCell;
  fxRate: ValueCell;
  marketValue: ValueCell;
  weight: ValueCell;
  dayPnl: ValueCell;
  unrealisedPnl: ValueCell;
  /** `null` only when the portfolio has no benchmark; `0` for an off-benchmark name. */
  benchWeight: number | null;
  activeWeight: number | null;
  reconStatus: PortReconStatus;
  /** `'q:42'`, or `null` for a cash / unresolved row. */
  subject: string | null;
  provIdx: number;
}

export interface PortBenchmark {
  instrumentId: number;
  key: string;
  name: string;
  source: 'portfolio' | 'param';
}

export interface PortHeader {
  portfolioId: number;
  firmId: number;
  name: string;
  baseCurrency: string;
  benchmark: PortBenchmark | null;
  asOfDate: string;
  positionCount: number;
  updatedAt: string;
}

export interface PortTotals {
  marketValue: ValueCell;
  costBasis: number | null;
  unrealisedPnl: ValueCell;
  dayPnl: ValueCell;
  cash: number;
  /**
   * Σ accrued interest over the book, `null` when there is no book to accrue on — the answer a
   * portfolio that is not visible gets. A zero there would be a number nothing sourced (DATA-10),
   * and "no accrued interest" is not what "no portfolio" means.
   */
  accrued: number | null;
  longMv: number;
  shortMv: number;
  grossMv: number;
  netMv: number;
  /** Fraction of the gross market value the book would have that actually carries a price. */
  pricedWeight: number;
}

export interface PortExposureRow {
  key: string;
  label: string;
  marketValue: number;
  weight: number;
  benchWeight: number | null;
  activeWeight: number | null;
  count: number;
}

export interface PortCurrencyRow {
  ccy: string;
  marketValue: number;
  weight: number;
  fxRate: ValueCell;
  fxDate: string;
}

export interface PortExposure {
  groupBy: PortGroupBy;
  rows: PortExposureRow[];
  currency: PortCurrencyRow[];
  engine: { name: 'portfolio/exposure'; version: string };
}

export interface PortAttributionRow {
  key: string;
  label: string;
  portWeight: number;
  benchWeight: number;
  portReturn: number;
  benchReturn: number;
  allocation: number;
  selection: number;
  interaction: number;
  total: number;
}

export interface PortAttribution {
  method: 'brinson_fachler';
  groupBy: 'sector';
  period: { from: string; to: string; sessions: number };
  rows: PortAttributionRow[];
  /**
   * The share of the book Brinson–Fachler actually ran on, as a fraction of `totals.grossMv`.
   *
   * Both sides are renormalised over the attributable subset (the identity only holds over a
   * normalised weight vector), so `rows[].portWeight` sums to 1 and `total.portReturn` is *that
   * sleeve's* return — not the portfolio's. A screen that prints the total beside a 23.65 %
   * `unattributed` row without this number invites the reader to add 100 % and 23.65 %.
   */
  attributableWeight: number;
  total: {
    portReturn: number;
    benchReturn: number;
    active: number;
    allocation: number;
    selection: number;
    interaction: number;
  };
  /**
   * The sleeve the model could not run on. `total` is its contribution to active return, and it is
   * `null` — not `0` — whenever `reason` says that contribution cannot be computed: a bucket whose
   * attribution is unavailable has an *unknown* contribution, and zero is a claim about it.
   */
  unattributed: {
    weight: number;
    total: number | null;
    reason: 'FI_ATTRIBUTION_UNAVAILABLE' | 'PRICE_MISSING';
  } | null;
  engine: { name: 'portfolio/attribution'; version: string; inputsHash: string };
}

export interface PortScenarioRow {
  id: string;
  label: string;
  method: 'shock' | 'episode';
  detail: string;
  pnlCcy: number | null;
  pnlPct: number | null;
  unavailableReason: string | null;
}

export interface PortRisk {
  lookbackDays: number;
  sessions: number;
  conventions: {
    returns: 'simple';
    priceBasis: 'close';
    adjust: 'price';
    annualisation: 252;
    /**
     * The number of sessions the statistics were computed over — the length of the return series
     * handed to `core/analytics`, which is `lookbackDays` capped by the overlapping history.
     *
     * TIER1 §0.6 pins `volWindow: 30` for the `vol30d` *field*, and this block used to echo that
     * literal while `volPct` was a 252-session volatility: a screen rendered a year's volatility
     * labelled with a month's window. The payload states what it computed.
     */
    volWindow: number;
  };
  volPct: number | null;
  benchVolPct: number | null;
  trackingErrorPct: number | null;
  beta: number | null;
  corr: number | null;
  r2: number | null;
  sharpe: number | null;
  informationRatio: number | null;
  maxDrawdownPct: number | null;
  var: {
    method: 'historical' | 'parametric';
    confidence: 95 | 99;
    horizonDays: 1;
    valuePct: number | null;
    valueCcy: number | null;
    backtest: { windowSessions: number; exceptions: number; expected: number } | null;
  };
  /** Always `null`: `VAR_MC_NOT_IN_V1`. */
  varMonteCarlo: null;
  /** Always `null`: `NO_FACTOR_MODEL`. */
  factorExposures: null;
  scenarios: PortScenarioRow[];
  engine: { name: 'portfolio/risk'; version: string; inputsHash: string };
}

export interface PortRecon {
  importId: number | null;
  channel: 'upload' | 'file_drop' | 'api' | 'manual' | null;
  uploadedAt: string | null;
  status: 'accepted' | 'partial' | 'rejected' | null;
  rowsTotal: number;
  rowsOk: number;
  rowsError: number;
  errors: { row: number; identifier: string; column: string; reason: string }[];
  matched: number;
  added: number;
  removed: number;
  quantityDiffs: { instrumentId: number; before: number; after: number }[];
}

export interface PortPayload {
  variant: 'default';
  view: PortView;
  portfolio: PortHeader;
  totals: PortTotals;
  holdings: PortHoldingRow[];
  exposure: PortExposure | null;
  attribution: PortAttribution | null;
  risk: PortRisk | null;
  recon: PortRecon;
  confidentiality: {
    firmOnly: true;
    note: 'PORT-07: firm-isolated; never leaves the tenant';
  };
  notes: string[];
}

/** The one confidentiality statement; the screen badge and the CSV header both render it. */
export const PORT_CONFIDENTIALITY: PortPayload['confidentiality'] = Object.freeze({
  firmOnly: true,
  note: 'PORT-07: firm-isolated; never leaves the tenant',
});

export const PORT_NOTE_NO_BENCHMARK = 'NO_BENCHMARK';
export const PORT_NOTE_PRICE_MISSING = 'PRICE_MISSING';
export const PORT_NOTE_FX_MISSING = 'FX_MISSING';
export const PORT_NOTE_FI_UNATTRIBUTED = 'FI_ATTRIBUTION_UNAVAILABLE';
export const PORT_NOTE_EPISODE_WINDOW = 'EPISODE_WINDOW_UNAVAILABLE';
export const PORT_NOTE_NO_PORTFOLIO = 'NO_PORTFOLIO';
export const PORT_NOTE_FIRM_ONLY = 'PORT-07 FIRM ONLY';
export const PORT_NOTE_SHORT_HISTORY = 'INSUFFICIENT_HISTORY';

/** The `# confidential:` header line every `PORT` export carries before `# source:`. */
export function portConfidentialHeader(firmId: number): string {
  return `# confidential: client portfolio data, firm ${String(firmId)} only (PORT-07)`;
}

/** The asset classes whose attribution needs evaluated bond prices this build does not source. */
export const PORT_UNATTRIBUTED_CLASSES: readonly AssetClass[] = Object.freeze([
  'govt',
  'option',
  'future',
] as AssetClass[]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§PORT "CSV")
// ─────────────────────────────────────────────────────────────────────────────────────────────

const HOLDINGS_COLUMNS: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'key', label: 'Key', type: 'string' },
  { id: 'name', label: 'Name', type: 'string' },
  { id: 'rawIdentifier', label: 'Identifier', type: 'string' },
  { id: 'assetClass', label: 'Asset class', type: 'string' },
  { id: 'gicsSector', label: 'GICS sector', type: 'string' },
  { id: 'currency', label: 'Currency', type: 'string' },
  { id: 'quantity', label: 'Quantity', type: 'number', decimals: 8 },
  { id: 'costPrice', label: 'Cost price', type: 'number', decimals: 6 },
  { id: 'costCurrency', label: 'Cost currency', type: 'string' },
  { id: 'tradeDate', label: 'Trade date', type: 'date' },
  { id: 'px', label: 'Last', type: 'number', decimals: 6 },
  { id: 'fxRate', label: 'FX rate', type: 'number', decimals: 8 },
  { id: 'marketValue', label: 'Market value', type: 'number', decimals: 2 },
  { id: 'weight', label: 'Weight', type: 'number', decimals: 10 },
  { id: 'benchWeight', label: 'Bench weight', type: 'number', decimals: 10 },
  { id: 'activeWeight', label: 'Active weight', type: 'number', decimals: 10 },
  { id: 'dayPnl', label: 'Day P&L', type: 'number', decimals: 2 },
  { id: 'unrealisedPnl', label: 'Unrealised P&L', type: 'number', decimals: 2 },
  { id: 'accrued', label: 'Accrued', type: 'number', decimals: 6 },
  { id: 'lotCount', label: 'Lots', type: 'number', decimals: 0 },
  { id: 'reconStatus', label: 'Recon', type: 'string' },
];

const LONG_COLUMNS: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'key', label: 'Key', type: 'string' },
  { id: 'value', label: 'Value', type: 'number', decimals: 10 },
  { id: 'unit', label: 'Unit', type: 'string' },
  { id: 'asOf', label: 'As of', type: 'date' },
  { id: 'source', label: 'Source', type: 'string' },
];

/**
 * §1.6 rule 4: the column set depends on `params.view`, so `FunctionManifestPublic.csvColumns` is
 * `null` and the runner's static column check does not apply to this manifest.
 */
export function portCsvColumns(params: PortParams): CsvColumn[] {
  return params.view === 'holdings' ? HOLDINGS_COLUMNS : LONG_COLUMNS;
}

type Cell = string | number | boolean | null;

function cellValue(cell: ValueCell): number | null {
  return typeof cell.v === 'number' ? cell.v : null;
}

function holdingsRows(payload: PortPayload): Cell[][] {
  const rows: Cell[][] = payload.holdings.map((h) => [
    'holding',
    h.key,
    h.name,
    h.rawIdentifier,
    h.assetClass,
    h.gicsSector,
    h.currency,
    h.quantity,
    h.costPrice,
    h.costCurrency,
    h.tradeDate,
    cellValue(h.px),
    cellValue(h.fxRate),
    cellValue(h.marketValue),
    cellValue(h.weight),
    h.benchWeight,
    h.activeWeight,
    cellValue(h.dayPnl),
    cellValue(h.unrealisedPnl),
    h.accrued,
    h.lotCount,
    h.reconStatus,
  ]);

  // §1.6 rule 3: the appended section rows reuse the wide grid's columns. `key` names the figure
  // and `marketValue` carries it, so one numeric column holds every appended number rather than
  // each section inventing its own alignment.
  const MARKET_VALUE_AT = HOLDINGS_COLUMNS.findIndex((c) => c.id === 'marketValue');
  const section = (kind: string, key: string, value: Cell, name: Cell = null): Cell[] => {
    const row: Cell[] = new Array<Cell>(HOLDINGS_COLUMNS.length).fill(null);
    row[0] = kind;
    row[1] = key;
    row[2] = name;
    row[MARKET_VALUE_AT] = value;
    return row;
  };

  const t = payload.totals;
  rows.push(section('totals', 'marketValue', cellValue(t.marketValue), payload.portfolio.name));
  rows.push(section('totals', 'costBasis', t.costBasis));
  rows.push(section('totals', 'unrealisedPnl', cellValue(t.unrealisedPnl)));
  rows.push(section('totals', 'dayPnl', cellValue(t.dayPnl)));
  rows.push(section('totals', 'grossMv', t.grossMv));
  rows.push(section('totals', 'netMv', t.netMv));
  rows.push(section('totals', 'longMv', t.longMv));
  rows.push(section('totals', 'shortMv', t.shortMv));
  rows.push(section('totals', 'cash', t.cash));
  rows.push(section('totals', 'accrued', t.accrued));
  rows.push(section('totals', 'pricedWeight', t.pricedWeight));

  const r = payload.recon;
  rows.push(section('recon', 'importId', r.importId, r.status));
  rows.push(section('recon', 'rowsTotal', r.rowsTotal, r.channel));
  rows.push(section('recon', 'rowsOk', r.rowsOk));
  rows.push(section('recon', 'rowsError', r.rowsError));
  rows.push(section('recon', 'matched', r.matched));
  rows.push(section('recon', 'added', r.added));
  rows.push(section('recon', 'removed', r.removed));
  for (const e of r.errors) {
    rows.push(section('recon_error', `${String(e.row)}|${e.column}`, e.row, `${e.identifier}: ${e.reason}`));
  }
  return rows;
}

function longRows(payload: PortPayload): Cell[][] {
  const asOf = payload.portfolio.asOfDate;
  const rows: Cell[][] = [];
  const push = (section: string, key: string, value: number | null, unit: string, source: string): void => {
    rows.push([section, key, value, unit, asOf, source]);
  };

  push('portfolio', 'portfolioId', payload.portfolio.portfolioId, 'id', 'internal.user');
  push('portfolio', 'positionCount', payload.portfolio.positionCount, 'count', 'internal.user');
  push('totals', 'grossMv', payload.totals.grossMv, payload.portfolio.baseCurrency, 'internal.derived');
  push('totals', 'netMv', payload.totals.netMv, payload.portfolio.baseCurrency, 'internal.derived');
  push('totals', 'cash', payload.totals.cash, payload.portfolio.baseCurrency, 'internal.derived');
  push('totals', 'pricedWeight', payload.totals.pricedWeight, 'ratio', 'internal.derived');

  const exposure = payload.exposure;
  if (exposure !== null) {
    for (const row of exposure.rows) {
      push('exposure', `${row.key}|marketValue`, row.marketValue, payload.portfolio.baseCurrency, 'internal.derived');
      push('exposure', `${row.key}|weight`, row.weight, 'ratio', 'internal.derived');
      push('exposure', `${row.key}|benchWeight`, row.benchWeight, 'ratio', 'internal.derived');
      push('exposure', `${row.key}|activeWeight`, row.activeWeight, 'ratio', 'internal.derived');
      push('exposure', `${row.key}|count`, row.count, 'count', 'internal.derived');
    }
    for (const ccy of exposure.currency) {
      push('currency', `${ccy.ccy}|marketValue`, ccy.marketValue, payload.portfolio.baseCurrency, 'internal.derived');
      push('currency', `${ccy.ccy}|weight`, ccy.weight, 'ratio', 'internal.derived');
      push('currency', `${ccy.ccy}|fxRate`, cellValue(ccy.fxRate), 'rate', 'frankfurter');
    }
  }

  const attribution = payload.attribution;
  if (attribution !== null) {
    for (const row of attribution.rows) {
      for (const term of ['portWeight', 'benchWeight', 'portReturn', 'benchReturn', 'allocation', 'selection', 'interaction', 'total'] as const) {
        push('attribution', `${row.key}|${term}`, row[term], 'ratio', 'internal.derived');
      }
    }
    for (const term of ['portReturn', 'benchReturn', 'active', 'allocation', 'selection', 'interaction'] as const) {
      push('attributionTotal', term, attribution.total[term], 'ratio', 'internal.derived');
    }
    if (attribution.unattributed !== null) {
      push('unattributed', attribution.unattributed.reason, attribution.unattributed.weight, 'ratio', 'internal.derived');
    }
  }

  const risk = payload.risk;
  if (risk !== null) {
    push('risk', 'sessions', risk.sessions, 'count', 'internal.derived');
    push('risk', 'volPct', risk.volPct, 'pct', 'internal.derived');
    push('risk', 'benchVolPct', risk.benchVolPct, 'pct', 'internal.derived');
    push('risk', 'trackingErrorPct', risk.trackingErrorPct, 'pct', 'internal.derived');
    push('risk', 'beta', risk.beta, 'ratio', 'internal.derived');
    push('risk', 'corr', risk.corr, 'ratio', 'internal.derived');
    push('risk', 'r2', risk.r2, 'ratio', 'internal.derived');
    push('risk', 'sharpe', risk.sharpe, 'ratio', 'internal.derived');
    push('risk', 'informationRatio', risk.informationRatio, 'ratio', 'internal.derived');
    push('risk', 'maxDrawdownPct', risk.maxDrawdownPct, 'pct', 'internal.derived');
    push('var', `${risk.var.method}|${String(risk.var.confidence)}|pct`, risk.var.valuePct, 'pct', 'internal.derived');
    push('var', `${risk.var.method}|${String(risk.var.confidence)}|ccy`, risk.var.valueCcy, payload.portfolio.baseCurrency, 'internal.derived');
    if (risk.var.backtest !== null) {
      push('backtest', 'windowSessions', risk.var.backtest.windowSessions, 'count', 'internal.derived');
      push('backtest', 'exceptions', risk.var.backtest.exceptions, 'count', 'internal.derived');
      push('backtest', 'expected', risk.var.backtest.expected, 'count', 'internal.derived');
    }
    for (const s of risk.scenarios) {
      push('scenario', `${s.id}|pnlCcy`, s.pnlCcy, payload.portfolio.baseCurrency, 'internal.derived');
      push('scenario', `${s.id}|pnlPct`, s.pnlPct, 'ratio', 'internal.derived');
    }
  }
  return rows;
}

export function portCsvRows(payload: PortPayload, params: PortParams): Cell[][] {
  return params.view === 'holdings' ? holdingsRows(payload) : longRows(payload);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Live (§PORT "Live")
// ─────────────────────────────────────────────────────────────────────────────────────────────

function portLive(_params: PortParams, payload: PortPayload): LiveSpec | null {
  const subjects: string[] = [];
  for (const row of payload.holdings) {
    if (row.subject !== null && !subjects.includes(row.subject)) subjects.push(row.subject);
  }
  if (subjects.length === 0) return null;
  const benchmark = payload.portfolio.benchmark;
  if (benchmark !== null) {
    const subject = `q:${String(benchmark.instrumentId)}`;
    if (!subjects.includes(subject)) subjects.push(subject);
  }
  return {
    subjects,
    fields: ['PX_LAST', 'CHG_NET_1D', 'CHG_PCT_1D'] as FieldId[],
    conflationMs: 2000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

const PORT_FIELDS: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'PX_CLOSE_1D',
  'FX_USD',
  'PORT_MV',
  'PORT_WEIGHT',
  'PORT_PNL_1D',
  'PORT_UNREAL_PNL',
  'PORT_ACTIVE_WEIGHT',
  'PORT_BETA',
  'PORT_CONTRIB_TE',
  'PORT_VAR',
] as FieldId[]);

export const PORT = defineFunction<typeof PortParams, PortPayload>({
  code: 'PORT',
  name: 'Portfolio Analytics',
  aliases: ['PRT'],
  tier: 2,
  category: 'portfolio',
  assetClasses: 'none',
  requiresSecurity: false,
  variants: {},
  params: PortParams,
  paramGrammar: {
    positional: [{ name: 'view', type: 'enum', values: PORT_VIEWS, optional: true }],
    keyed: {
      P: { name: 'portfolioId', type: 'int' },
      DATE: { name: 'asOfDate', type: 'date' },
      BM: { name: 'benchmark', type: 'security' },
      GRP: { name: 'groupBy', type: 'enum', values: PORT_GROUP_BY },
      N: { name: 'lookbackDays', type: 'int' },
      VAR: { name: 'varMethod', type: 'enum', values: PORT_VAR_METHODS },
      CONF: { name: 'varConfidence', type: 'enum', values: PORT_VAR_CONFIDENCES },
      SCEN: { name: 'scenarios', type: 'string' },
    },
  },
  fieldIds: (assetClass): FieldId[] => precheckFields(PORT_FIELDS, assetClass),
  pageable: false,
  live: portLive,
  csv: {
    filename: (params, ctx): string =>
      `PORT_${(ctx.display ?? 'portfolio').replace(/[^A-Za-z0-9]+/g, '_')}_` +
      `${params.view.toUpperCase()}_${ctx.asOf.slice(0, 10).replace(/-/g, '')}.csv`,
    columns: (params): CsvColumn[] => portCsvColumns(params),
    rows: (payload, params): Cell[][] => portCsvRows(payload, params),
  },
  help: {
    summary: 'Portfolio holdings, exposure, Brinson attribution and ex-post risk, firm-isolated',
    description:
      'PORT prices your imported positions live, shows exposure by sector, asset class or ' +
      "currency against the portfolio's benchmark, decomposes active return with a " +
      'Brinson-Fachler attribution, and reports ex-post risk: volatility, tracking error, beta, ' +
      'drawdown and one-day VaR with an exception backtest, plus parallel and steepening curve ' +
      'shifts, equity and FX shocks and two historical-episode replays. Press 1 to 4 for the four ' +
      'views, B to change the benchmark, D to price a different as-of date, V to cycle the VaR ' +
      'method and confidence, and + / - to lengthen or shorten the risk window. Multi-factor risk ' +
      'exposures and Monte Carlo VaR are unavailable: there is no licensable factor model in this ' +
      'wedge, so risk is measured ex-post from returns. Fixed-income positions are grouped into ' +
      'one unattributed bucket because curve, spread and carry attribution needs evaluated bond ' +
      'prices that this build does not source. Portfolio data is tenant-isolated: it is never ' +
      'sent to a data provider and is visible only inside your firm.',
    params: [
      { name: 'portfolioId', text: 'which portfolio', example: 'P=1' },
      { name: 'view', text: 'holdings, exposure, attribution or risk', example: 'PORT RISK' },
      { name: 'asOfDate', text: 'positions as of', example: 'DATE=2026-09-15' },
      { name: 'benchmark', text: 'benchmark security', example: 'BM=SPX Index' },
      { name: 'groupBy', text: 'sector, assetClass, currency or instrument', example: 'GRP=currency' },
      { name: 'lookbackDays', text: '60–1260 sessions', example: 'N=504' },
      { name: 'varMethod', text: 'historical or parametric', example: 'VAR=parametric' },
      { name: 'varConfidence', text: '95 or 99', example: 'CONF=99' },
      { name: 'scenarios', text: 'comma-separated scenario ids', example: 'SCEN=EQUITY_DOWN_20,USD_UP_5' },
    ],
    keys: [
      { key: '1…4', action: 'holdings, exposure, attribution, risk' },
      { key: 'P', action: 'pick a portfolio' },
      { key: 'B', action: 'set the benchmark' },
      { key: 'D', action: 'price a different as-of date' },
      { key: 'R', action: 'cycle the exposure grouping' },
      { key: 'V', action: 'cycle the VaR method and confidence' },
      { key: '+ / -', action: 'lengthen or shorten the risk window' },
      { key: 'S', action: 'edit the scenario list' },
    ],
    sources: [
      'internal.user',
      'cboe.quotes',
      'yahoo.chart',
      'frankfurter',
      'sec.archives',
      'ssga.holdings',
      'wiki.sp500',
      'internal.derived',
    ],
    related: ['W', 'QM', 'MEMB', 'HDS', 'GP', 'BTMM'],
  },
  keymap: [
    { key: '1', action: 'tab-view', description: 'Holdings' },
    { key: '2', action: 'tab-view', description: 'Exposure' },
    { key: '3', action: 'tab-view', description: 'Attribution' },
    { key: '4', action: 'tab-view', description: 'Risk' },
    { key: 'P', action: 'pick-portfolio', description: 'Pick a portfolio' },
    { key: 'B', action: 'set-benchmark', description: 'Set the benchmark' },
    { key: 'D', action: 'set-as-of-date', description: 'Positions as of' },
    { key: 'R', action: 'cycle-group-by', when: 'grid', description: 'sector → assetClass → currency → instrument' },
    { key: 'V', action: 'cycle-var', description: 'historical/95 → historical/99 → parametric/95 → parametric/99' },
    { key: '+', action: 'longer-lookback', description: 'Lengthen the risk window' },
    { key: '-', action: 'shorter-lookback', description: 'Shorten the risk window' },
    { key: 'S', action: 'edit-scenarios', when: 'grid', description: 'Edit the scenario list' },
    { key: 'Enter', action: 'open-des', when: 'grid', description: 'Description of this holding' },
    { key: 'Shift+Enter', action: 'open-des-next', when: 'grid', description: 'DES in the next panel' },
    { key: 'G', action: 'open-gp', when: 'grid', description: 'Price chart' },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default PORT;
