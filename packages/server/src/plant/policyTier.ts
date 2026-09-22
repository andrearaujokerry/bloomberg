/**
 * Tier views (BUS-06, ENTL-05) — ARCHITECTURE §6.5, API.md §6.6.
 *
 * `view(state, tier, ctx)` projects the plant's composite `QuoteState` onto what one subscriber is
 * entitled to see. The projection is total and never invents a number:
 *
 * | tier       | view                                                                          |
 * | ---------- | ----------------------------------------------------------------------------- |
 * | `realtime` | identity. No v1 source supplies it; the gateway downgrades the *request* to    |
 * |            | `delayed` with `SOURCE_TIER_CAP` before it gets here. The identity exists so a |
 * |            | future realtime line needs no protocol change.                                 |
 * | `delayed`  | identity on Cboe/Yahoo lines: they are ≥ 15 min delayed at source and the      |
 * |            | delay is not doubled.                                                          |
 * | `eod`      | every field replaced by the `EodView` (`plant/eod.ts`): the six close fields   |
 * |            | carry the official close with `ts.src` = session close, every other requested  |
 * |            | field is `null` with `r: 'TIER_EOD'`, and `state` is `'closed'`.               |
 *
 * `ctx.denied` (the entitlement decision's per-field denials) wins over every tier: a denied field
 * is `null` with its reason and never carries a number, whatever the tier (ENTL-05). Only
 * `ctx.fieldIds` are emitted — a subscriber to `PX_LAST` never receives `PX_BID` (BUS-02).
 *
 * `r` carries a reason **only for a field that is not served** (API.md §6.8's eod paragraph is
 * exactly the four `TIER_EOD` denials and no key for the served `PX_VOLUME`): a key in `r` means
 * "this field is null and blank", so a served field never appears there and never adds frame
 * weight.
 */

import type {
  FieldId,
  FieldValue,
  ProvRef,
  QuoteFields,
  QuoteState,
  ReasonCode,
  SessionState,
  Tier,
  Timestamps3,
  ValueState,
} from '@terminal/core';

import type { EodView } from './eod.js';

/** The projection the conflator encodes into a `snap` (API.md §6.3). */
export interface TierView {
  seq: number;
  tier: Tier;
  /** Exactly `ctx.fieldIds`, in that order; `null` where nothing may be shown. */
  fields: Record<FieldId, FieldValue | null>;
  /** Source timestamp per field that carries a value (FEED-05). */
  fieldTs: Record<FieldId, number>;
  /**
   * Reason per **unserved** field only: a key here means the field is `null` and renders blank
   * (ENTL-05, `wire/ws.ts`). A served field carries no entry — `r` is what the wire's partial
   * `r` record is, so `snap.r` equals this object and stays off the frame when nothing is denied.
   */
  r: Record<FieldId, ReasonCode>;
  ts: Timestamps3;
  state: ValueState;
  session: SessionState;
  prov: ProvRef;
}

export interface ViewContext {
  /** The subscription's field set (BUS-02); nothing outside it is emitted. */
  fieldIds: readonly FieldId[];
  /** The official close the `eod` tier freezes on; `null`/absent when none has been built yet. */
  eod?: EodView | null;
  /** Fields the entitlement decision refused, with the reason (ENTL-05). */
  denied?: ReadonlyMap<FieldId, ReasonCode>;
}

/** Project `state` onto what a `tier` subscriber with `ctx` may see. */
export function view(state: QuoteState, tier: Tier, ctx: ViewContext): TierView {
  return tier === 'eod' ? eodView(state, ctx) : identityView(state, tier, ctx);
}

/** `realtime` and `delayed`: the state's own values, minus denials, restricted to `ctx.fieldIds`. */
function identityView(state: QuoteState, tier: Tier, ctx: ViewContext): TierView {
  const fields: Record<FieldId, FieldValue | null> = {};
  const fieldTs: Record<FieldId, number> = {};
  const r: Record<FieldId, ReasonCode> = {};

  for (const id of ctx.fieldIds) {
    const denial = ctx.denied?.get(id);
    if (denial !== undefined) {
      fields[id] = null;
      r[id] = denial;
      continue;
    }
    const value = fieldValue(state.fields, id);
    fields[id] = value;
    if (value !== null) {
      const ts = state.fieldTs[id as keyof QuoteFields];
      if (ts !== undefined) fieldTs[id] = ts;
    }
  }

  return {
    seq: state.seq,
    tier,
    fields,
    fieldTs,
    r,
    ts: state.ts,
    state: state.state,
    session: state.session,
    prov: state.prov,
  };
}

/**
 * `eod`: frozen at the official close. Without an `EodView` there is nothing an eod subscriber may
 * see, so every field is `null`/`TIER_EOD` and the state is `'blank'` rather than a fabricated
 * `'closed'` value (ENTL-05: a downgrade yields the lower tier's value or a blank, never a stale
 * higher-tier one).
 */
function eodView(state: QuoteState, ctx: ViewContext): TierView {
  const eod = ctx.eod ?? null;
  const fields: Record<FieldId, FieldValue | null> = {};
  const fieldTs: Record<FieldId, number> = {};
  const r: Record<FieldId, ReasonCode> = {};

  for (const id of ctx.fieldIds) {
    const denial = ctx.denied?.get(id);
    if (denial !== undefined) {
      fields[id] = null;
      r[id] = denial;
      continue;
    }
    const value = eod === null ? undefined : eod.fields[id];
    if (eod === null || value === undefined || value === null) {
      fields[id] = null;
      r[id] = 'TIER_EOD';
      continue;
    }
    fields[id] = value;
    fieldTs[id] = eod.closeTs;
  }

  const ts: Timestamps3 =
    eod === null ? state.ts : { src: eod.closeTs, cap: state.ts.cap, pub: state.ts.pub };

  return {
    seq: state.seq,
    tier: 'eod',
    fields,
    fieldTs,
    r,
    ts,
    state: eod === null ? 'blank' : 'closed',
    session: eod === null ? state.session : 'closed',
    prov: state.prov,
  };
}

/** The state's value for `id` as a wire `FieldValue`; absent, `NaN` and non-scalar are `null`. */
function fieldValue(fields: QuoteFields, id: FieldId): FieldValue | null {
  const v = (fields as Record<string, unknown>)[id];
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  return null;
}
