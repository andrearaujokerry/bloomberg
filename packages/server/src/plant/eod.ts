/**
 * End-of-day snapshot builder (BUS-06) — ARCHITECTURE §6.5, API.md §6.6.
 *
 * The `eod` tier sees only the official close of the last completed session:
 * `PX_OFFICIAL_CLOSE PX_CLOSE_1D PX_VOLUME PX_OPEN PX_HIGH PX_LOW`, with `ts.src` = the session
 * close. `buildEodSnapshot` projects a composite `QuoteState` onto that shape at the close; the
 * result is what `plant/store.ts#writeEodSnapshot` persists to `eod_snapshots.fields` and what
 * `plant/policyTier.ts` freezes an `eod` subscriber on.
 *
 * Nothing is invented: a field the state does not carry is absent from the view, not zero. The
 * one substitution the view makes is spelled out in `flags`: when no official closing print
 * exists (`PX_OFFICIAL_CLOSE` absent — the Cboe delayed line publishes none), the last trade at
 * the close stands in for it and the view says so with `OFFICIAL_CLOSE_FROM_LAST`. When neither
 * exists the close is `MISSING_CLOSE` (the OPS-03 DQ check).
 */

import type { FieldId, FieldValue, QuoteState } from '@terminal/core';

/** The fields an `eod` view may carry — the `eod_snapshots.fields` alphabet (DATA_MODEL §7.2). */
export const EOD_FIELD_IDS = Object.freeze([
  'PX_OFFICIAL_CLOSE',
  'PX_CLOSE_1D',
  'PX_VOLUME',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
] as const);

export type EodFieldId = (typeof EOD_FIELD_IDS)[number];

const EOD_FIELD_SET: ReadonlySet<string> = new Set(EOD_FIELD_IDS);

/** True when `id` is one of the six fields an eod view can supply. */
export function isEodField(id: FieldId): id is EodFieldId {
  return EOD_FIELD_SET.has(id);
}

export type EodFlag =
  /** `PX_OFFICIAL_CLOSE` is the last trade at the close: the source published no official print. */
  | 'OFFICIAL_CLOSE_FROM_LAST'
  /** Neither an official close nor a last trade exists; `PX_OFFICIAL_CLOSE` is absent. */
  | 'MISSING_CLOSE';

export interface EodView {
  /** ISO date of the completed session (`eod_snapshots.session_date`). */
  sessionDate: string;
  /** The session close instant, epoch ms — `ts.src` of every eod-tier value (FEED-05). */
  closeTs: number;
  /** Only keys from `EOD_FIELD_IDS`; a field the state lacked is absent, never `null` or `0`. */
  fields: Record<FieldId, FieldValue>;
  /** What the builder had to substitute, if anything. */
  flags: EodFlag[];
}

/**
 * Project `state` onto the official-close view of `sessionDate`, closed at `closeTsMs`.
 *
 * `PX_OFFICIAL_CLOSE` falls back to `PX_LAST` when no official print exists, flagged
 * `OFFICIAL_CLOSE_FROM_LAST`; every other field is copied only when the state carries a finite
 * number for it.
 */
export function buildEodSnapshot(
  state: Pick<QuoteState, 'fields'>,
  sessionDate: string,
  closeTsMs: number,
): EodView {
  const fields: Record<FieldId, FieldValue> = {};
  const flags: EodFlag[] = [];
  const f = state.fields;

  const official = finite(f.PX_OFFICIAL_CLOSE);
  if (official !== undefined) {
    fields.PX_OFFICIAL_CLOSE = official;
  } else {
    const last = finite(f.PX_LAST);
    if (last !== undefined) {
      fields.PX_OFFICIAL_CLOSE = last;
      flags.push('OFFICIAL_CLOSE_FROM_LAST');
    } else {
      flags.push('MISSING_CLOSE');
    }
  }

  for (const id of ['PX_CLOSE_1D', 'PX_VOLUME', 'PX_OPEN', 'PX_HIGH', 'PX_LOW'] as const) {
    const v = finite(f[id]);
    if (v !== undefined) fields[id] = v;
  }

  return { sessionDate, closeTs: closeTsMs, fields, flags };
}

/** A finite number or `undefined`; `NaN`/`Infinity` are parse problems, never a close. */
function finite(v: number | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
