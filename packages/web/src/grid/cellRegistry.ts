// packages/web/src/grid/cellRegistry.ts — the mechanism this whole package exists for.
//
// CLIENT.md §10.4, ARCHITECTURE §6.6. A delta arrives for one subject carrying two or three changed
// fields. This file finds the DOM elements for exactly those (subject, fieldId) pairs and writes
// them — `textContent`, `data-st`, `data-dir`, the flash class — and touches nothing else. React is
// not on this path at all: it owns columns, sort, group, selection, focus and the virtual window,
// and it is not re-rendered by a tick.
//
// Why it has to be this way, stated once. A 1 000-row watchlist with 12 columns under a 250 ms
// conflation window is a few hundred cell changes a second. Routing those through React state means
// reconciling the whole subtree for each batch — thousands of vnodes to discover that three strings
// differ — and the frame budget (NFR-02: p95 under 16 ms) is gone at a tenth of that load. The cost
// of a correct update is three property writes; everything above that is overhead, and a grid that
// pays it cannot hold the budget at the size the terminal is specified for.
//
// Three rules carry the file:
//
//  1. **One rAF per frame, whatever arrives.** `apply` never writes. It merges into a pending map
//     and schedules a single animation frame if one is not already scheduled. Fifty batches between
//     two frames produce one callback and one write per cell, carrying the latest value.
//  2. **No write, no flash, on a no-op.** A conflated frame re-states fields that did not move. A
//     cell whose value, state and reason are all unchanged is skipped entirely — otherwise the grid
//     would flash every subscribed field four times a second and mean nothing by it.
//  3. **A cap, not a drop.** At most `MAX_WRITES_PER_FRAME` cell writes per frame; the remainder
//     stays pending for the next one. Nothing is lost, because the value is read from the live
//     `QuoteView` at write time — a deferred cell writes the newest number, not the one that was
//     current when the batch was queued.

import { createContext, useContext } from 'react';

import type { FieldId, FieldValue, ValueState } from '@terminal/core';
import type { QuoteView } from '@terminal/sdk';

import { BLANK, formatCell } from '../format/index.js';
import type { Cell } from '../screen/types.js';
import * as flash from './flash.js';
import { FLASH_MS } from './flash.js';
import type { CellRef, ChangeBatch, FlashDir } from './types.js';

/** CLIENT.md §10.4 — the per-frame write cap. */
export const MAX_WRITES_PER_FRAME = 2_500;

/** The ▲/▼ a change column prints, the same two glyphs `CellView.tsx` prints. */
const DIR_GLYPH: Readonly<Record<FlashDir, string>> = { up: '▲', down: '▼', flat: '' };

/** One phrase per state, verbatim from `CellView.tsx` so both surfaces say the same thing. */
const STATE_PHRASE: Readonly<Record<ValueState, string>> = {
  live: 'live',
  stale: 'stale, no fresh update',
  closed: 'closed, session ended',
  blank: 'unavailable',
  na: 'not applicable',
};

/**
 * How a subject-level `status` frame is spoken (API.md §6.5, CLIENT.md §9).
 *
 * Only the states that are NOT a `ValueState` are here. `stale`, `closed` and `blank` are value
 * states — {@link statusValueState} lands them on the cell's own `st`, where `STATE_PHRASE` says
 * them and `tokens.css` colours them — so repeating them here would make a screen reader announce
 * "stale, no fresh update, stale". `pending`, `shed`, `gone` and `halted` say something `st` cannot:
 * why there is no fresh number behind this one.
 */
const STATUS_PHRASE: Readonly<Record<string, string>> = {
  pending: 'pending',
  shed: 'shed — off screen, not being sent',
  gone: 'gone — the subject no longer exists',
  halted: 'halted — trading is halted in this instrument',
};

/**
 * The `ValueState` a `status` frame puts on a cell, mirroring `QuoteCache`'s own split.
 *
 * `QuoteCache` divides `status.st` into the lifecycle (`pending`/`shed`/`gone`, which land on
 * `QuoteView.status`) and the **verdict** (`stale`/`closed`/`blank`, which ARE `ValueState`s and
 * land on `QuoteView.st`). The cells have to divide it the same way, and the reason is the one
 * failure this protocol can detect and cannot silently repair: between a gap in the `prev` chain and
 * the snapshot that heals it, `rt/wsBridge.ts` marks every subject `stale`, because the client has
 * just REFUSED to apply a number it was sent. If that did not reach `data-st`, every cell on the
 * screen would keep the live colour, the live glyph and the accessible name "…, live" for numbers
 * nobody can trade on — which is the whole thing TERM-12 exists to prevent, and it is invisible to
 * any test that asserts the call rather than the cell.
 *
 * `halted` is not a `ValueState` (it is a session, and `QuoteCache` puts it on `view.session`), so
 * it changes no `st`; it is spoken through {@link STATUS_PHRASE} instead.
 */
export function statusValueState(st: string): ValueState | null {
  switch (st) {
    // The lifecycle states that do have a value consequence.
    case 'shed':
      // A shed subject keeps its last value and the server has stopped sending it: that is exactly
      // what `stale` means.
      return 'stale';
    case 'gone':
      return 'blank';
    // The verdicts, which are `ValueState`s already.
    case 'stale':
    case 'closed':
    case 'blank':
      return st;
    default:
      // `pending` (no value yet) and `halted` (a session, not a value) say nothing about `st`.
      return null;
  }
}

/** Everything a cell needs to render one value, gathered so React and the registry share it. */
export interface CellPresentation {
  value: FieldValue;
  st: ValueState;
  /** The `ReasonCode` that explains a blank, when one is known. */
  reason?: string | undefined;
  fmt: Cell['fmt'];
  decimals?: number | undefined;
  priceDecimals?: number | undefined;
  currency?: string | undefined;
  /** A change column: the value prints with its sign and a ▲/▼ glyph. */
  signed: boolean;
}

/**
 * The direction a cell *asserts*.
 *
 * For a change column (`CHG_NET_1D`, `CHG_PCT_1D` — the ones `CellView` marks with a `dir`) that is
 * the sign of the value, which is what `[data-dir] .chg` colours and what the ▲/▼ glyph shows: a
 * change of −2.1 % is red whether it rose from −2.3 % or fell from −1.9 %. For a level column there
 * is no sign to state, so it is the direction the level moved, which is CLIENT.md §10.4's `dir`.
 *
 * The **flash** never uses this. A flash answers "did this number just move?", which is
 * {@link movementOf}, and is why a change cell creeping up while still negative flashes green and
 * stays red — two different facts, two different marks.
 */
export function dirOf(p: CellPresentation, previous: FieldValue): FlashDir {
  if (p.signed) {
    if (typeof p.value !== 'number') return 'flat';
    return p.value > 0 ? 'up' : p.value < 0 ? 'down' : 'flat';
  }
  return movementOf(p.value, previous);
}

/** Did the number move, and which way? `flat` for anything that is not two comparable numbers. */
export function movementOf(next: FieldValue, previous: FieldValue): FlashDir {
  if (typeof next !== 'number' || typeof previous !== 'number') return 'flat';
  if (next > previous) return 'up';
  if (next < previous) return 'down';
  return 'flat';
}

/**
 * The visible text of a cell.
 *
 * All number formatting is `format/index.ts` — the single formatter (`core/fields/format.ts`) — and
 * this function adds exactly two things to it, both of which are about *states*, not numbers:
 *
 *  * the ▲/▼ on a change column, as `CellView` does;
 *  * **the reason beside a blank**, as visible text. WP-12's audit found 73 blank cells across the
 *    38 screens, every one of them an em dash with the reason hidden in a span clipped to a single
 *    pixel — so a price withheld by entitlement and a price the source does not have looked
 *    identical, which is exactly what ENTL-05 forbids. On this cell the reason is in the text
 *    itself. There is nowhere for it to hide.
 */
export function cellText(p: CellPresentation): string {
  const synthetic: Cell = { v: p.value, st: p.st, provIdx: -1 };
  if (p.fmt !== undefined) synthetic.fmt = p.fmt;
  if (p.decimals !== undefined) synthetic.decimals = p.decimals;
  const text = formatCell(synthetic, {
    ...(p.currency === undefined ? {} : { currency: p.currency }),
    ...(p.priceDecimals === undefined ? {} : { priceDecimals: p.priceDecimals }),
    ...(p.signed ? { signed: true } : {}),
    blank: BLANK,
  });

  if (p.st === 'blank') return p.reason === undefined ? text : `${text} ${p.reason}`;
  if (!p.signed) return text;
  const glyph = DIR_GLYPH[dirOf(p, null)];
  return glyph === '' ? text : `${glyph} ${text}`;
}

/**
 * The accessible name: the column, the value, and the state in words.
 *
 * The state has to be *said*, not only coloured — `stale` and `live` differ by a grey and a `·`,
 * and neither reaches a screen reader on its own. It is an `aria-label` rather than a hidden span
 * because the registry writes this element imperatively and a label is one attribute write, where a
 * hidden child would be a second element to keep in step (and, as WP-12 found, a place for the
 * truth to hide from the eye while satisfying a test).
 */
export function cellLabel(label: string, p: CellPresentation, status?: string | null): string {
  const parts = [`${label}: ${cellText(p)}`, STATE_PHRASE[p.st]];
  if (p.st === 'blank' && p.reason !== undefined) parts.push(p.reason);
  if (status !== undefined && status !== null && STATUS_PHRASE[status] !== undefined) {
    parts.push(STATUS_PHRASE[status]);
  }
  return parts.join(', ');
}

/** The `title`: state, then why, then when — the same order `CellView.cellTooltip` uses. */
export function cellTitle(p: CellPresentation, ts: number | null, status?: string | null): string {
  const parts: string[] = [STATE_PHRASE[p.st]];
  if (p.reason !== undefined) parts.push(p.reason);
  if (status !== undefined && status !== null && STATUS_PHRASE[status] !== undefined) {
    parts.push(STATUS_PHRASE[status]);
  }
  if (ts !== null) parts.push(new Date(ts).toISOString());
  return parts.join(' · ');
}

/**
 * The `ValueState` of one field of a view.
 *
 * A `null` value is `blank` — §6.3 step 4: a null in a delta means the composite value became
 * unknown, and ENTL-05 means a denied field is null with a reason. The one exception is a field the
 * payload already called `na`: "this field does not apply to this instrument" is a statement about
 * the instrument, not about today's feed, and a null from the wire does not contradict it.
 */
export function fieldState(view: QuoteView, field: FieldId, previous: ValueState): ValueState {
  const value = view.f[field];
  if (value === null || value === undefined) return previous === 'na' ? 'na' : 'blank';
  return view.st;
}

/** How many DOM writes the registry has done, and what it decided not to do. */
export interface CellRegistryStats {
  /** rAF callbacks run. */
  frames: number;
  /** Batches merged in through {@link CellRegistry.apply}. */
  batches: number;
  /** Cells written: the number the acceptance test asserts is exactly the changed ones. */
  writes: number;
  /** Fields looked at and skipped because nothing about them had changed. */
  skipped: number;
  /** Flashes triggered. */
  flashes: number;
  /** Field updates deferred past the per-frame cap and carried to the next frame. */
  deferred: number;
  /** Cells restyled by the 1 s staleness sweep. */
  restyled: number;
}

/**
 * What one animation frame did, handed to every {@link CellRegistry.onFlush} listener.
 *
 * It exists for the live re-sort and the live group aggregates (CLIENT.md §10.3, §10.4). Both are
 * React's work — they change the ORDER and the header rows, which is structure — and both must be
 * driven by the fact that live values moved, which only this file knows. `fields` carries the field
 * ids actually WRITTEN, never the ones a conflated frame merely re-stated: a re-sort triggered by a
 * no-op would churn the row order for nothing, which is the churn the throttle exists to prevent.
 *
 * Collected only while at least one listener is attached, so a grid that is neither sorted on a live
 * column nor grouped pays nothing for it.
 */
export interface FlushInfo {
  /** Cells written this frame. */
  writes: number;
  /** The field ids written this frame. */
  fields: ReadonlySet<FieldId>;
  /** The frame's clock reading, so a listener's throttle and the flash share one `now`. */
  now: number;
}

export interface CellRegistryOptions {
  /** How a frame is scheduled. Defaults to the platform's `requestAnimationFrame`. */
  requestFrame?: ((callback: () => void) => number) | undefined;
  cancelFrame?: ((handle: number) => void) | undefined;
  /** The clock the flash lifetime is measured against. Defaults to `performance.now`. */
  now?: (() => number) | undefined;
  /** `settings.flashMs` (CLIENT.md §8): 700, 350, or 0 for "no flashes at all". */
  flashMs?: number | undefined;
  /** The per-frame write cap. Only a benchmark has a reason to change it. */
  maxWritesPerFrame?: number | undefined;
  /** The staleness source {@link CellRegistry.restyle} consults — `quoteCache.get(s)?.st`. */
  stateOf?: ((subject: string) => ValueState | undefined) | undefined;
  /** Called after every cell write. Instrumentation for the acceptance and budget tests. */
  onWrite?: ((cell: CellRef) => void) | undefined;
}

/** One pending subject: the union of every field reported changed since the last frame. */
interface PendingEntry {
  changed: Set<FieldId>;
  state: QuoteView;
}

/**
 * `Map<subject, Map<fieldId, CellRef>>` (CLIENT.md §10.2), with one widening: the innermost value
 * is a **set** of cells, not one cell.
 *
 * One registry serves every widget on the screen — CLIENT.md §9 routes grid, kv and list cells
 * through the same `cellRegistry.apply` — so two widgets showing `q:42 PX_LAST`, or one watchlist
 * holding the same instrument twice, are ordinary rather than exotic. A single-ref map would have
 * silently stopped updating whichever of them registered first, and a cell that stops updating
 * while still looking live is the defect TERM-12 exists to prevent.
 */
export class CellRegistry {
  readonly #cells = new Map<string, Map<FieldId, Set<CellRef>>>();
  readonly #pending = new Map<string, PendingEntry>();
  /**
   * The newest `QuoteView` seen per subject — a reference, not a copy, so it is never behind the
   * cache. It exists for {@link CellRegistry.register}: virtualisation unmounts a row when it
   * scrolls out and mounts a fresh one when it comes back, and that fresh cell renders the value
   * the PAYLOAD was built with. Without this a scroll down and back would show prices from when the
   * screen was opened, looking every bit as live as the ones that never left the viewport.
   */
  readonly #latest = new Map<string, QuoteView>();
  readonly #status = new Map<string, string>();
  readonly #flushListeners = new Set<(info: FlushInfo) => void>();
  readonly #requestFrame: (callback: () => void) => number;
  readonly #cancelFrame: (handle: number) => void;
  readonly #now: () => number;
  readonly #maxWrites: number;
  readonly #onWrite: ((cell: CellRef) => void) | undefined;
  #flashMs: number;
  #stateOf: ((subject: string) => ValueState | undefined) | undefined;
  #frame: number | null = null;

  readonly stats: CellRegistryStats = {
    frames: 0,
    batches: 0,
    writes: 0,
    skipped: 0,
    flashes: 0,
    deferred: 0,
    restyled: 0,
  };

  constructor(options: CellRegistryOptions = {}) {
    this.#requestFrame =
      options.requestFrame ?? ((callback) => globalThis.requestAnimationFrame(callback));
    this.#cancelFrame =
      options.cancelFrame ?? ((handle) => globalThis.cancelAnimationFrame(handle));
    this.#now = options.now ?? ((): number => performance.now());
    this.#flashMs = options.flashMs ?? FLASH_MS;
    this.#maxWrites = options.maxWritesPerFrame ?? MAX_WRITES_PER_FRAME;
    this.#stateOf = options.stateOf;
    this.#onWrite = options.onWrite;
  }

  /** Register one live cell. Returns the unregister function the row's effect calls on unmount. */
  register(cell: CellRef): () => void {
    let bySubject = this.#cells.get(cell.subject);
    if (bySubject === undefined) {
      bySubject = new Map<FieldId, Set<CellRef>>();
      this.#cells.set(cell.subject, bySubject);
    }
    let refs = bySubject.get(cell.fieldId);
    if (refs === undefined) {
      refs = new Set<CellRef>();
      bySubject.set(cell.fieldId, refs);
    }
    refs.add(cell);
    this.#prepareElement(cell);

    // Paint it now from the newest view, if there is one. No flash: a row arriving in the viewport
    // has not changed, it has appeared, and a flash would say otherwise.
    const latest = this.#latest.get(cell.subject);
    const status = this.#status.get(cell.subject) ?? null;
    if (latest !== undefined) {
      this.#write(cell, latest, this.#now(), status, false);
    } else {
      // No frame has arrived for this subject, so the payload's own values are the only truth there
      // is — and from this moment the registry is the ONLY writer of this element's content, so it
      // has to paint them. `LiveGrid` renders no text into a live cell precisely because React
      // repainting from a stale payload over a live number is the defect this replaces.
      this.#paintSeed(cell, status);
    }

    return () => {
      // The flash goes with the cell. A row scrolled out mid-animation would otherwise be recycled
      // into the DOM still lit, asserting a change that belongs to a different instrument.
      flash.endFlash(cell.el);
      cell.valueEl = undefined;
      refs.delete(cell);
      if (refs.size === 0) bySubject.delete(cell.fieldId);
      if (bySubject.size === 0) this.#cells.delete(cell.subject);
    };
  }

  /**
   * Queue one subject's changes. Never writes; schedules at most one frame.
   *
   * `changed` is **unioned** rather than replaced. CLIENT.md §10.4's "deduped by subject, last
   * wins" is about the *state* — the `QuoteView` is mutated in place by `QuoteCache`, so the last
   * one is the only one worth holding — but the changed-field lists are disjoint slices of that
   * state, and replacing them would drop a field: two batches between frames, one reporting
   * `PX_LAST` and the next `PX_VOLUME`, would leave the price unwritten on screen while the cache
   * holds the new one.
   */
  apply(batch: ChangeBatch): void {
    this.stats.batches += 1;
    this.#latest.set(batch.subject, batch.state);
    const existing = this.#pending.get(batch.subject);
    if (existing === undefined) {
      this.#pending.set(batch.subject, { changed: new Set(batch.changed), state: batch.state });
    } else {
      for (const field of batch.changed) existing.changed.add(field);
      existing.state = batch.state;
    }
    this.#schedule();
  }

  #schedule(): void {
    if (this.#frame !== null) return;
    this.#frame = this.#requestFrame(() => {
      this.#frame = null;
      this.flush();
    });
  }

  /**
   * The rAF callback. Public because the frame-budget benchmark times it directly and a test drives
   * it without a pump; the grid itself never calls it.
   */
  flush(): void {
    const now = this.#now();
    this.stats.frames += 1;
    let written = 0;
    // Only while somebody is listening (see {@link FlushInfo}).
    const touched: Set<FieldId> | null = this.#flushListeners.size > 0 ? new Set<FieldId>() : null;

    for (const [subject, entry] of this.#pending) {
      const bySubject = this.#cells.get(subject);
      if (bySubject === undefined) {
        // Nothing on screen shows this subject — a row scrolled out, a panel closed. Drop it: the
        // value lives in the QuoteCache and the cell repaints from there when it mounts again.
        this.#pending.delete(subject);
        continue;
      }
      const status = this.#status.get(subject) ?? null;
      const remaining: FieldId[] = [];
      let capped = false;

      for (const field of entry.changed) {
        if (capped) {
          remaining.push(field);
          continue;
        }
        const refs = bySubject.get(field);
        if (refs === undefined) {
          // Subscribed but not displayed — a field another widget asked for. Not a skip worth
          // counting: there was never a cell to write.
          continue;
        }
        let wrote = false;
        for (const cell of refs) {
          if (this.#write(cell, entry.state, now, status, true)) {
            written += 1;
            wrote = true;
          } else this.stats.skipped += 1;
        }
        if (wrote && touched !== null) touched.add(field);
        if (written >= this.#maxWrites) capped = true;
      }

      if (remaining.length === 0) {
        this.#pending.delete(subject);
      } else {
        entry.changed = new Set(remaining);
        this.stats.deferred += remaining.length;
      }
      if (capped) break;
    }

    // Anything left is a deferred remainder. Ask for the next frame now, so the queue drains at one
    // cap per frame rather than waiting for the next delta to wake it.
    if (this.#pending.size > 0) this.#schedule();

    flash.sweep(now, this.#flashMs);

    if (touched !== null && written > 0) {
      const info: FlushInfo = { writes: written, fields: touched, now };
      for (const listener of [...this.#flushListeners]) listener(info);
    }
  }

  /**
   * Be told what each frame wrote (see {@link FlushInfo}). Returns the unsubscribe function.
   *
   * The listener runs INSIDE the animation frame, after every write. A listener that re-renders
   * React is therefore paying for it on the tick path, which is why the only two callers gate
   * themselves on a throttle: the live re-sort (at most once per `liveSortThrottleMs`) and the group
   * aggregates (at most once a second).
   */
  onFlush(listener: (info: FlushInfo) => void): () => void {
    this.#flushListeners.add(listener);
    return () => {
      this.#flushListeners.delete(listener);
    };
  }

  /**
   * Give the element the one child a signed cell needs, once, at registration.
   *
   * `tokens.css` colours a change value through `[data-dir='up'] .chg` / `[data-dir='down'] .chg` —
   * the rule needs an inner element to match, exactly as `CellView.tsx` supplies one. Without it the
   * grid wrote `data-dir='down'` onto a cell with no `.chg` inside and the rule matched nothing, so
   * a +2.1 % and a −2.1 % were the same colour in the grid and opposite colours in the `kv` block
   * beside it, for the same data. The span is created ONCE and only its `textContent` is written per
   * tick, so the hot path costs exactly what it did before.
   *
   * Unsigned cells get no wrapper: nothing keys off `.chg` for them, and a level column is the
   * common case — one text write beats a write plus an element per cell on a 1 000-row grid.
   */
  #prepareElement(cell: CellRef): void {
    if (!cell.signed) {
      cell.valueEl = undefined;
      return;
    }
    const existing = cell.el.firstElementChild;
    if (existing instanceof HTMLElement && existing.classList.contains('chg')) {
      cell.valueEl = existing;
      return;
    }
    const span = cell.el.ownerDocument.createElement('span');
    span.className = 'cell__value chg';
    cell.el.textContent = '';
    cell.el.appendChild(span);
    cell.valueEl = span;
  }

  /** Where a cell's text goes: the `.chg` span for a signed cell, the cell itself otherwise. */
  #setText(cell: CellRef, presentation: CellPresentation): void {
    const target = cell.valueEl ?? cell.el;
    target.textContent = cellText(presentation);
  }

  /** The presentation of what the registry last wrote to a cell, at whatever state it now holds. */
  #presentationOf(cell: CellRef, st: ValueState = cell.st): CellPresentation {
    return {
      value: cell.last,
      st,
      reason: cell.reason,
      fmt: cell.fmt,
      decimals: cell.decimals,
      priceDecimals: cell.priceDecimals,
      currency: cell.currency,
      signed: cell.signed,
    };
  }

  /**
   * Paint a cell from the values it was registered with — its payload seed — and nothing else.
   *
   * No flash and no `cell.last` change: this is not an update, it is the first paint of a cell whose
   * subject no frame has arrived for. Every static screen in the application goes through here.
   */
  #paintSeed(cell: CellRef, status: string | null): void {
    const presentation = this.#presentationOf(cell);
    this.#setText(cell, presentation);
    cell.el.setAttribute('data-st', cell.st);
    cell.el.setAttribute('data-dir', dirOf(presentation, null));
    cell.el.setAttribute('aria-label', cellLabel(cell.label, presentation, status));
    cell.el.title = cellTitle(presentation, cell.lastTs, status);
    if (status !== null) this.#applyStatusToCell(cell, status);
  }

  /**
   * The payload behind a registered cell changed — a screen repainted (`ctx.rerun`, a param change,
   * a poll) with a new value for a cell the registry already owns.
   *
   * The rule is "the newest number wins, and there is only one writer". A live frame is newer than
   * any payload, so if one has arrived for this subject the cell is repainted from it and the payload
   * is ignored. If none has, the payload IS the newest thing anyone has and it is adopted, seed and
   * all. The alternative — letting React write the payload's number as JSX children — desynchronised
   * `cell.last` from the DOM, and the no-op skip rule then suppressed the correction when the wire
   * re-stated the value the registry thought was already on screen.
   */
  reseed(cell: CellRef, seed: { value: FieldValue; st: ValueState; reason: string | undefined; ts: number | null }): void {
    const latest = this.#latest.get(cell.subject);
    const status = this.#status.get(cell.subject) ?? null;
    if (latest !== undefined) {
      // A frame has arrived: the live value is the truth and the cell already shows it.
      this.#write(cell, latest, this.#now(), status, false);
      return;
    }
    if (seed.value === cell.last && seed.st === cell.st && seed.reason === cell.reason) return;
    cell.last = seed.value;
    cell.st = seed.st;
    cell.reason = seed.reason;
    cell.lastTs = seed.ts;
    this.#paintSeed(cell, status);
  }

  /** Write one cell if anything about it changed. Returns true when the DOM was touched. */
  #write(
    cell: CellRef,
    view: QuoteView,
    now: number,
    status: string | null,
    allowFlash: boolean,
  ): boolean {
    const value = view.f[cell.fieldId] ?? null;
    const st = fieldState(view, cell.fieldId, cell.st);
    const reason = view.r[cell.fieldId];
    const ts = view.fts[cell.fieldId] ?? null;

    if (value === cell.last && st === cell.st && reason === cell.reason) return false;

    const presentation: CellPresentation = {
      value,
      st,
      reason,
      fmt: cell.fmt,
      decimals: cell.decimals,
      priceDecimals: cell.priceDecimals,
      currency: cell.currency,
      signed: cell.signed,
    };
    const moved = movementOf(value, cell.last);
    const dir = dirOf(presentation, cell.last);

    this.#setText(cell, presentation);
    if (st !== cell.st) cell.el.setAttribute('data-st', st);
    cell.el.setAttribute('data-dir', dir);
    cell.el.setAttribute('aria-label', cellLabel(cell.label, presentation, status));
    cell.el.title = cellTitle(presentation, ts, status);

    // `movementOf` is `flat` unless BOTH the old and the new value are numbers, so a first paint
    // (whose previous value is the payload's, often null) cannot flash: nothing moved, something
    // appeared. Flashing an appearance would light the whole grid at mount and mean nothing.
    if (allowFlash && moved !== 'flat') {
      flash.trigger(cell.el, moved, now, this.#flashMs);
      this.stats.flashes += 1;
    }

    cell.last = value;
    cell.lastTs = ts;
    cell.st = st;
    cell.reason = reason;
    this.stats.writes += 1;
    this.#onWrite?.(cell);
    return true;
  }

  /**
   * A subject-level `status` frame (API.md §6.5).
   *
   * `shed` is the one that matters: the server stopped sending this subject because the socket
   * backed up and the row is off screen. The cells keep their last value — throwing it away would
   * lose information the server still has — and are marked `stale`, because that is precisely what
   * they are: a number with no fresh update behind it. Marking them anything else, or nothing,
   * would leave a shed price looking live, which is the one thing TERM-12 forbids. `gone` blanks
   * them, because the subject itself no longer exists.
   */
  setSubjectStatus(subject: string, st: string): void {
    this.#status.set(subject, st);
    const bySubject = this.#cells.get(subject);
    if (bySubject === undefined) return;
    for (const refs of bySubject.values()) {
      for (const cell of refs) this.#applyStatusToCell(cell, st);
    }
  }

  /**
   * Drop a subject's status and put its cells back on the value states they actually have.
   *
   * `setSubjectStatus` is not one-way. The gap grey is the case that proves it: `wsBridge` marks
   * every subject `stale` when the `prev` chain breaks, and the snapshot that heals the gap has to
   * take the grey off again — a snap whose values happen to match what was on screen reports NO
   * changed fields (`QuoteCache.#applySnap`), so nothing else would ever repaint those cells and
   * every one of them would stay grey, and say "stale", for the rest of the session. Marking a live
   * price stale forever is the same lie as marking a stale price live; it just fails safe.
   *
   * A no-op when the subject carries no status, which is the common case — the hot path never
   * touches a cell through here.
   */
  clearSubjectStatus(subject: string): void {
    if (!this.#status.delete(subject)) return;
    const bySubject = this.#cells.get(subject);
    if (bySubject === undefined) return;
    const latest = this.#latest.get(subject);
    for (const refs of bySubject.values()) {
      for (const cell of refs) {
        cell.el.classList.remove('st-shed', 'st-gone');
        cell.el.removeAttribute('data-status');
        // The value state comes back from the authority, not from memory: the newest view when there
        // is one (`fieldState` keeps a payload `na` as `na`), else whatever the staleness source
        // says, else the state the cell already had.
        const st =
          latest !== undefined
            ? fieldState(latest, cell.fieldId, cell.st)
            : (this.#stateOf?.(subject) ?? cell.st);
        cell.st = st;
        cell.el.setAttribute('data-st', st);
        const presentation = this.#presentationOf(cell, st);
        this.#setText(cell, presentation);
        cell.el.setAttribute('aria-label', cellLabel(cell.label, presentation, null));
        cell.el.title = cellTitle(presentation, cell.lastTs, null);
      }
    }
  }

  /**
   * One cell's response to a `status` frame.
   *
   * The state it lands on is {@link statusValueState}'s — the same split `QuoteCache` makes, which is
   * what stops a cell and the cache disagreeing about what the server just said. Two states are not
   * overwritten, for the same reason {@link CellRegistry.restyle} does not overwrite them: `na` is a
   * statement about the instrument ("this field does not apply"), not about today's feed, and a
   * `blank` has no number for a verdict about numbers to qualify.
   */
  #applyStatusToCell(cell: CellRef, st: string): void {
    const next = statusValueState(st);
    cell.el.classList.toggle('st-shed', st === 'shed');
    cell.el.classList.toggle('st-gone', st === 'gone');
    cell.el.setAttribute('data-status', st);
    if (next !== null && next !== cell.st && cell.st !== 'na' && !(cell.st === 'blank' && next !== 'blank')) {
      cell.st = next;
      cell.el.setAttribute('data-st', next);
    }
    const presentation = this.#presentationOf(cell);
    this.#setText(cell, presentation);
    cell.el.setAttribute('aria-label', cellLabel(cell.label, presentation, st));
    cell.el.title = cellTitle(presentation, cell.lastTs, st);
  }

  /**
   * The 1 s staleness sweep (TERM-12, CLIENT.md §9): `data-st` and the words that go with it, and
   * nothing else. No value is re-read and no flash is triggered — a number going stale is not a
   * number changing, and flashing it would say the opposite of what happened.
   */
  restyle(
    subjects: readonly string[],
    stateOf: ((subject: string) => ValueState | undefined) | undefined = this.#stateOf,
  ): void {
    if (stateOf === undefined) return;
    for (const subject of subjects) {
      const bySubject = this.#cells.get(subject);
      if (bySubject === undefined) continue;
      const st = stateOf(subject);
      if (st === undefined) continue;
      const status = this.#status.get(subject) ?? null;
      for (const refs of bySubject.values()) {
        for (const cell of refs) {
          // A blank cell is blank because its value was denied or is unknown; the subject going
          // stale does not give it a number, so it stays blank. An `na` cell is excluded for a
          // different and stronger reason: "this field does not apply to this instrument" is a fact
          // about the instrument, and restyling it to `stale` would replace it with "this number has
          // no fresh update" — a claim about a number that does not exist. `#write` already makes
          // that exception through `fieldState`; the sweep has to make the same one or a single quiet
          // second would contradict it.
          if (cell.st === 'blank' || cell.st === 'na' || cell.st === st) continue;
          cell.st = st;
          cell.el.setAttribute('data-st', st);
          const presentation = this.#presentationOf(cell, st);
          this.#setText(cell, presentation);
          cell.el.setAttribute('aria-label', cellLabel(cell.label, presentation, status));
          cell.el.title = cellTitle(presentation, cell.lastTs, status);
          this.stats.restyled += 1;
        }
      }
    }
  }

  /**
   * Remove every flash now.
   *
   * `animationend` does not fire in jsdom (TESTING.md §2.2), so a component test proves the flash
   * is applied, calls this, and proves it is gone; the 700 ms lifetime is Playwright's to assert.
   * The grid also calls it on unmount.
   */
  endFlash(): void {
    flash.endAllFlashes();
  }

  /**
   * Clear any flash that has outlived its animation. The 1 s staleness ticker calls this, and so does
   * every frame.
   *
   * Why both. The frame sweep can only run when a new batch schedules a frame, so it is driven by the
   * very thing whose absence it exists to cover: after the LAST delta of a session — market close, a
   * closed socket, the `display:none` panel `flash.ts` names — no frame is ever scheduled again and
   * the last flash stays lit indefinitely, saying "this just changed" about the final print of the
   * day. The staleness ticker runs whether or not anything arrived, which is exactly the property a
   * backstop needs.
   */
  sweepFlashes(now: number = this.#now()): number {
    return flash.sweep(now, this.#flashMs);
  }

  /**
   * The newest live value of one `(subject, field)`, or `undefined` when no frame has arrived.
   *
   * This is `sort.ts`'s `LiveValueLookup` — CLIENT.md §10.3's "re-evaluates the order from
   * `cellRegistry` values" and §10.4's "group aggregates are recomputed every 1 s from `cellRegistry`
   * values". It reads the same `QuoteView` the cells were written from, so the order on screen and
   * the numbers on screen cannot come from two different sources.
   */
  value(subject: string, field: FieldId): FieldValue | undefined {
    return this.#latest.get(subject)?.f[field];
  }

  /** `settings.flashMs` changed (CLIENT.md §8). `0` means the next flash is a no-op. */
  setFlashMs(ms: number): void {
    this.#flashMs = ms;
    if (ms === 0) flash.endAllFlashes();
  }

  /** Point {@link restyle} at a `QuoteCache`. `wsBridge` calls this when the client connects. */
  setStateSource(stateOf: (subject: string) => ValueState | undefined): void {
    this.#stateOf = stateOf;
  }

  /**
   * Forget a subject entirely — its queued changes and its remembered view. What the bridge calls
   * on `unsub`, so a subject nobody is subscribed to any more cannot repaint a cell that happens to
   * mount with the same id later.
   */
  forget(subject: string): void {
    this.#pending.delete(subject);
    this.#latest.delete(subject);
    this.#status.delete(subject);
  }

  /** Subjects with at least one registered cell — what the bridge subscribes to. */
  subjects(): string[] {
    return [...this.#cells.keys()];
  }

  /** The cells registered for one (subject, field), for a test that wants to look. */
  cellsOf(subject: string, field: FieldId): readonly CellRef[] {
    const refs = this.#cells.get(subject)?.get(field);
    return refs === undefined ? [] : [...refs];
  }

  /** How many cells are registered in total. */
  get size(): number {
    let n = 0;
    for (const bySubject of this.#cells.values()) {
      for (const refs of bySubject.values()) n += refs.size;
    }
    return n;
  }

  /** Batches queued but not yet written. */
  get pendingSubjects(): number {
    return this.#pending.size;
  }

  /** Drop everything: registrations, queue, flashes, the scheduled frame. */
  reset(): void {
    if (this.#frame !== null) {
      this.#cancelFrame(this.#frame);
      this.#frame = null;
    }
    flash.endAllFlashes();
    this.#cells.clear();
    this.#pending.clear();
    this.#latest.clear();
    this.#status.clear();
    this.#flushListeners.clear();
    for (const key of Object.keys(this.stats) as (keyof CellRegistryStats)[]) this.stats[key] = 0;
  }
}

/**
 * The application's registry.
 *
 * One per document, because one socket feeds the whole application (TERM-04) and every widget on
 * every panel takes its values from it. `rt/wsBridge.ts` drives this instance; a test builds its
 * own and provides it through {@link CellRegistryContext}.
 */
export const cellRegistry = new CellRegistry();

export const CellRegistryContext = createContext<CellRegistry>(cellRegistry);

export function useCellRegistry(): CellRegistry {
  return useContext(CellRegistryContext);
}

/**
 * What the grid tells the SDK when its viewport moves (BUS-04, API.md §6.5).
 *
 * `wsBridge.ts` provides it as `sdk.live.setEssential`. The default is a no-op so a grid rendered
 * with no socket behind it — every screen test, the HELP overlay, a static payload — still works;
 * it does mean a grid with no provider marks nothing essential, which is correct, because with no
 * socket there is nothing to shed.
 */
export interface GridLiveBridge {
  setEssential(subjects: readonly string[], essential: boolean): void;
}

const INERT_BRIDGE: GridLiveBridge = { setEssential: () => undefined };

export const GridLiveContext = createContext<GridLiveBridge>(INERT_BRIDGE);

export function useGridLive(): GridLiveBridge {
  return useContext(GridLiveContext);
}
