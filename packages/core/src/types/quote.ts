/**
 * Quote state (FEED-03, FEED-05, FEED-06, TERM-12) — ARCHITECTURE §4.2.
 *
 * `QuoteState` is THE composite state held by the plant; the wire snapshot is a projection of it.
 */

import type { AssetClass } from './instrument.js';

/** Ordered eod < delayed < realtime. */
export type Tier = 'realtime' | 'delayed' | 'eod';

/** FEED-06. */
export type SessionState = 'pre' | 'open' | 'auction' | 'halted' | 'closed' | 'post' | 'unknown';

/**
 * Staleness verdict, orthogonal to tier: a delayed-tier value can be 'live' (updating on schedule).
 *
 * - `live`   updated within 3 × expectedIntervalMs and (during 'open') source ts still advancing
 * - `stale`  no capture within 3 × expectedIntervalMs, or source ts frozen > 3 × interval during 'open',
 *            or provider circuit open
 * - `closed` session closed/post; value is the official/last print, not expected to change
 * - `blank`  no value may be shown (entitlement denied / unknown); rendered as '—' + reason, never a
 *            number (ENTL-05)
 * - `na`     field not applicable to this instrument (bid on an index with no book)
 */
export type ValueState = 'live' | 'stale' | 'closed' | 'blank' | 'na';

/** FEED-05 three timestamps, epoch ms UTC. `src` = provider-published time (null when the provider gives none). */
export interface Timestamps3 {
  src: number | null;
  cap: number;
  pub: number;
}

export interface ProvRef {
  sourceId: string;
  provenanceId: number;
  /** Cboe seqno */
  srcSeq?: number;
}

export type TickDirection = 'up' | 'down' | 'flat';

/**
 * The quote-bearing field set carried by a line and by the composite.
 *
 * ARCHITECTURE §4.2 lists the equity block explicitly and names the option and rate blocks in
 * comments; they are spelled out here because `QuoteState.fields` has to carry them for `option`
 * and `rate` subjects and `QuoteFieldId = keyof QuoteFields` is the plant's field-mask alphabet.
 */
export interface QuoteFields {
  PX_LAST?: number;
  LAST_SIZE?: number;
  LAST_TRADE_TIME?: number;
  PX_BID?: number;
  PX_ASK?: number;
  BID_SIZE?: number;
  ASK_SIZE?: number;
  PX_OPEN?: number;
  PX_HIGH?: number;
  PX_LOW?: number;
  PX_CLOSE_1D?: number;
  PX_OFFICIAL_CLOSE?: number;
  PX_VOLUME?: number;
  VWAP?: number;
  CHG_NET_1D?: number;
  CHG_PCT_1D?: number;
  TICK_DIR?: TickDirection;
  IVOL_30D?: number;
  SESSION_STATE?: SessionState;

  // option contracts additionally
  OPT_IV?: number;
  OPT_DELTA?: number;
  OPT_GAMMA?: number;
  OPT_VEGA?: number;
  OPT_THETA?: number;
  OPT_RHO?: number;
  OPT_OI?: number;
  OPT_THEO?: number;

  // rates additionally
  RATE?: number;
  RATE_P1?: number;
  RATE_P25?: number;
  RATE_P75?: number;
  RATE_P99?: number;
  RATE_VOLUME_BN?: number;
  TARGET_FROM?: number;
  TARGET_TO?: number;
}

export type QuoteFieldId = keyof QuoteFields;

/** Per-md-line contribution kept for BUS-05 composition and the QM per-venue view. */
export interface LineState {
  mdLineId: number;
  sourceId: string;
  fields: QuoteFields;
  ts: Timestamps3;
  srcSeq?: number;
  provenanceId: number;
}

export type DataQualityFlag =
  'CROSS_SOURCE_DIVERGENCE' | 'STALE_SOURCE' | 'MISSING_CLOSE' | 'PROVIDER_DOWN';

/** THE composite state. One per subject in the plant; the wire snapshot is a projection of it. */
export interface QuoteState {
  /** 'q:42' */
  subject: string;
  instrumentId: number;
  assetClass: AssetClass;
  /** per-subject version, +1 on every applied change */
  seq: number;
  /** tier of the winning line */
  tier: Tier;
  /** intrinsic delay of the winning line, minutes */
  delayMin: number;
  fields: QuoteFields;
  /** src ts (or cap when src absent) of last change per field */
  fieldTs: Partial<Record<QuoteFieldId, number>>;
  /** of the last applied update */
  ts: Timestamps3;
  session: SessionState;
  state: ValueState;
  ageMs: number;
  expectedIntervalMs: number;
  /** of the last applied update */
  prov: ProvRef;
  /** keyed by mdLineId */
  lines: Record<number, LineState>;
  dq: DataQualityFlag[];
}

/** What every normaliser emits and the only thing `plant.apply` accepts. */
export interface NormalisedUpdate {
  subject: string;
  instrumentId: number;
  mdLineId: number;
  assetClass: AssetClass;
  tier: Tier;
  fields: Partial<QuoteFields>;
  /** src from provider, cap = fetch completion; pub set by the plant */
  ts: Timestamps3;
  prov: ProvRef;
  session?: SessionState;
}
