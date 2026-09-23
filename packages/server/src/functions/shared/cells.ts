/**
 * `functions/shared/cells.ts` — the one cell rule every Tier 1 screen obeys
 * (FUNCTIONS_TIER1.md §0.4 rule 1, TERM-12, ENTL-05, DATA-10).
 *
 * A plant-backed `ValueCell` has to answer three questions at once: what is the number, how fresh
 * is it, and — when there is no number — *why not*. The third one is the one that goes wrong, and
 * it goes wrong in two opposite directions that look identical on screen:
 *
 *  - **Pending.** The instrument exists, the subject is valid, and the plant has simply never been
 *    polled for it. Nothing was denied, nothing is missing upstream: the answer has not arrived
 *    yet. The cell is `{ v: null, st: 'blank', provIdx: -1, live: { subject, field } }` — **no
 *    `r`**, because there is no reason to give, and `provIdx: -1`, the documented "no provenance
 *    yet" value. `meta.provenance` is untouched: a cell that cited nothing must not add a row that
 *    claims a source was consulted. The screen renders `…` and the WebSocket `snap` (or a
 *    `status 'pending'` frame) fills it in a moment later.
 *  - **Denied.** The composite *does* hold a value and the caller may not see it. `plant.snapshot`
 *    has already run it through `policyTier.view`, so the field is absent from `fields` and
 *    present in `r` with the reason (ENTL-05). The cell keeps that `r` verbatim.
 *
 * Confusing the two is not cosmetic. A pending cell carrying a reason code tells a user their
 * entitlements are short when they are not — the support ticket that follows costs more than the
 * screen. A denied cell rendered as pending hides a real entitlement gap behind a spinner that
 * never resolves, and ENTL-05 exists precisely so a blank says why it is blank.
 *
 * Both cells carry `live: { subject, field }` either way, which is what lets the shell overwrite
 * `v` from the WebSocket quote cache without re-running the function.
 */

import type { FieldId, QuoteFieldId, QuoteState, ReasonCode, ValueCell } from '@terminal/core';

import type { ResolveContext } from '../context.js';

/**
 * A snapshot as a resolver receives it. `ctx.plant.snapshot` returns a `GatedQuoteState`, whose
 * `r` is a total record; §0.4 writes the access as `state.r?.[field]`, so the parameter admits a
 * bare `QuoteState` too — a caller holding an ungated composite (a test, the sim feed) gets the
 * same cell with no reason attached, which is the honest answer when no gate was applied.
 */
export type CellState = QuoteState & { r?: Readonly<Partial<Record<FieldId, ReasonCode>>> };

/**
 * The cell for a subject the plant has never been polled for (FUNCTIONS_TIER1.md §0.4 rule 1).
 *
 * Deliberately *not* `{ r: 'NO_DATA' }` or any other reason: nothing was refused and nothing is
 * known to be missing. It is also deliberately not routed through `ctx`, because the whole point
 * is that it cites nothing — there is no `ctx` interaction to make.
 */
export function pendingCell(subject: string, field: FieldId): ValueCell {
  return { v: null, st: 'blank', provIdx: -1, live: { subject, field } };
}

/**
 * `state` → the `ValueCell` a screen renders, citing the snapshot's provenance row.
 *
 * `state === undefined` means the plant holds no such subject: {@link pendingCell}, and
 * `ctx.prov` is not touched. Otherwise the snapshot is cited exactly once per call through
 * `ctx.prov.addQuote` — the collector is idempotent on `provenanceId`, so ten fields off one
 * snapshot produce ten identical `provIdx` values and one `meta.provenance` entry.
 *
 * `v` is `null` when the field is absent from the projection, which happens for two reasons the
 * cell then distinguishes by the presence of `r`: the gate removed it (denied, `r` set) or the
 * composite never carried it (`r` absent — the same "not here yet" a pending cell means, for one
 * field rather than the whole subject).
 */
export function cellFromState(
  ctx: ResolveContext,
  state: CellState | undefined,
  field: FieldId,
  subject: string,
): ValueCell {
  if (state === undefined) return pendingCell(subject, field);

  const key = field as QuoteFieldId;
  const cell: ValueCell = {
    v: state.fields[key] ?? null,
    st: state.state,
    ts: state.fieldTs[key] ?? null,
    provIdx: ctx.prov.addQuote(state),
    live: { subject, field },
  };
  // `exactOptionalPropertyTypes`: a served field must have no `r` key at all, not `r: undefined`.
  const reason = state.r?.[field];
  if (reason !== undefined) cell.r = reason;
  return cell;
}

/**
 * A stored value (a bar, a fact, a fixing) as a cell — §0.4 rule 3. `st: 'closed'` because a
 * finished session's official print *is* the value, not a stale one, and no `live`: nothing on the
 * wire will update it.
 */
export function storedCell(args: {
  v: ValueCell['v'];
  provIdx: number;
  ts?: number | null;
  st?: ValueCell['st'];
}): ValueCell {
  const cell: ValueCell = { v: args.v, st: args.st ?? 'closed', provIdx: args.provIdx };
  if (args.ts !== undefined) cell.ts = args.ts;
  return cell;
}

/**
 * A cell for a value that is absent for a stated reason — §1.3 rule 6's payload half. The caller
 * is responsible for the `meta` half (`ctx.unavailable.add`); this only shapes the cell, and takes
 * a `ReasonCode` rather than an `UnavailableReason` because `r` is what the screen renders and the
 * wire's `snap.r` carries.
 */
export function blankCell(r: ReasonCode, provIdx = -1): ValueCell {
  return { v: null, st: 'blank', r, provIdx };
}
