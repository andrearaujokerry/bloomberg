// packages/web/src/grid/flash.ts — the per-cell change flash, and the guarantee that it ends.
//
// CLIENT.md §10.4. `trigger(el, dir)` adds `.flash-up` or `.flash-down`; `tokens.css` animates the
// class for `var(--flash-ms)` and the class is removed on `animationend`. Re-adding a class the
// element already has does not restart a CSS animation, so a cell that ticks twice inside one
// animation would flash once — the class is therefore removed, layout is read to force a style
// recalculation, and the class is re-added.
//
// **The part that matters is the removal.** A flash that never clears leaves a cell permanently
// lit, and a permanently lit cell says "this just changed" about a number that has not moved in an
// hour — worse than no flash at all, because it is a false statement rather than a missing one.
// `animationend` is the normal path and it is not enough on its own: it does not fire in jsdom, it
// does not fire for an element that was removed from the document mid-animation, and it does not
// fire when the animation was never running (a hidden panel, a display:none tab). So every flash is
// also recorded with the time it started, and {@link sweep} clears any that has outlived its
// animation by a wide margin. The registry calls `sweep` once per frame AND once per staleness
// second, so a feed that falls quiet cannot leave the last flash lit: a backstop driven only by the
// next delta is not a backstop, because the case it exists for is the one where no delta arrives.
//
// **One listener per element, for the element's whole life.** The listener is attached the first
// time an element is ever flashed and never removed. A listener *per flash* is what the obvious
// version does, and it leaks without bound: `{ once: true }` removes it only when the event FIRES,
// and every path that takes a flash off early — the sweep, `endFlash`, `endAllFlashes`,
// `setFlashMs(0)` and a re-trigger inside the animation window — removes the class, which CANCELS
// the animation, so `animationend` never comes for it. A cell on a 250 ms conflated feed would gain
// one dead listener per tick for as long as its row stays mounted, and because `addEventListener`
// scans the existing listener list for a duplicate, the cost of the next one grows with the number
// already there: the tick path becomes quadratic in ticks per cell. That is measurable, and it was
// measured — it is what put the sustained frame budget over 8 ms from the second round on. With one
// permanent listener `trigger` performs no listener work at all after the first flash.

import type { FlashDir } from './types.js';

/** The class each direction adds. `flat` has none — see {@link FLAT_HAS_NO_CLASS}. */
export const FLASH_CLASS: Readonly<Record<'up' | 'down', string>> = {
  up: 'flash-up',
  down: 'flash-down',
};

/**
 * Why `flat` adds no class.
 *
 * CLIENT.md §10.4 asks for a "brief neutral flash" on a `text`/`date` change, and `tokens.css`
 * defines `--flash-flat-bg` for it. It defines no `.flash-flat` rule and no `flash-flat` keyframes,
 * and `tokens.css` is WP-01's file, not this package's. A class with no animation behind it never
 * starts an animation, so it never fires `animationend` — it would be added and never removed, and
 * the sweep below would be the only thing ever taking it off. Adding a mark that is wrong until a
 * timeout catches it is worse than not marking a text change at all, so `flat` writes `data-dir`
 * (which is what a test and a screen reader read) and no class. When the keyframes land, the entry
 * goes in {@link FLASH_CLASS} and nothing else here changes.
 */
export const FLAT_HAS_NO_CLASS = true;

/** The default flash lifetime, matching `--flash-ms` in `tokens.css` at normal density. */
export const FLASH_MS = 700;

/** How far past its lifetime a flash may live before {@link sweep} takes it off regardless. */
export const FLASH_SWEEP_FACTOR = 3;

/** Elements currently carrying a flash class, and the timestamp each one was lit at. */
const lit = new Map<HTMLElement, { className: string; at: number }>();

/**
 * Elements that already carry the permanent `animationend` listener.
 *
 * Weak on purpose: the key is a DOM node the grid unmounts and forgets, and a strong set would keep
 * every cell a virtualised 1 000-row grid ever scrolled past alive for the life of the session.
 */
const bound = new WeakSet<HTMLElement>();

/**
 * The one `animationend` handler, shared by every element (see the module header).
 *
 * It reads the CURRENT entry rather than closing over the flash that attached it, so it is correct
 * however many flashes the element has had since. `animationName` is checked because a browser
 * fires `animationcancel` — not `animationend` — for an animation a class removal cut short, but
 * only when it was running at all; comparing the name means an event that does arrive late cannot
 * clear a flash that has only just begun. The keyframes in `tokens.css` are named for their classes
 * (`flash-up` animates `.flash-up`), which is what makes the comparison a direct one.
 */
function onAnimationEnd(event: Event): void {
  const el = event.currentTarget as HTMLElement | null;
  if (el === null) return;
  const entry = lit.get(el);
  if (entry === undefined) return;
  const name = (event as AnimationEvent).animationName;
  if (typeof name === 'string' && name !== '' && name !== entry.className) return;
  clear(el, entry.className);
}

function clear(el: HTMLElement, className: string): void {
  el.classList.remove(className);
  lit.delete(el);
}

/**
 * Flash `el` in direction `dir`.
 *
 * A no-op for `flat` (see {@link FLAT_HAS_NO_CLASS}) and for `flashMs === 0`, which is the
 * settings value meaning "no flashes" (CLIENT.md §8) and the one a user with vestibular sensitivity
 * chooses; honouring it here means no caller has to remember to.
 */
export function trigger(el: HTMLElement, dir: FlashDir, now: number, flashMs = FLASH_MS): void {
  if (dir === 'flat' || flashMs === 0) return;
  const className = FLASH_CLASS[dir];
  const current = lit.get(el);

  if (current !== undefined) {
    // Already lit. Remove whichever class is on, then read a layout property: the read forces the
    // style recalculation that makes the re-add a *new* animation rather than a continuation.
    el.classList.remove(current.className);
    void el.offsetWidth;
    lit.delete(el);
  }

  el.classList.add(className);
  lit.set(el, { className, at: now });

  // The normal end, attached once per element and never again (see the module header). After the
  // first flash this branch is one WeakSet lookup, which is what keeps the tick path flat.
  if (!bound.has(el)) {
    bound.add(el);
    el.addEventListener('animationend', onAnimationEnd);
  }
}

/** Take the flash off one element now. Idempotent, and safe on an element that has none. */
export function endFlash(el: HTMLElement): void {
  const entry = lit.get(el);
  if (entry === undefined) return;
  clear(el, entry.className);
}

/** Take every flash off. What a test calls, and what a grid calls when it unmounts. */
export function endAllFlashes(): void {
  for (const [el, entry] of lit) el.classList.remove(entry.className);
  lit.clear();
}

/**
 * Clear every flash older than `FLASH_SWEEP_FACTOR × flashMs`. The backstop for an `animationend`
 * that never arrives; in the normal case it finds nothing to do.
 */
export function sweep(now: number, flashMs = FLASH_MS): number {
  if (lit.size === 0) return 0;
  const limit = flashMs * FLASH_SWEEP_FACTOR;
  let cleared = 0;
  for (const [el, entry] of lit) {
    if (now - entry.at < limit) continue;
    el.classList.remove(entry.className);
    lit.delete(el);
    cleared += 1;
  }
  return cleared;
}

/** How many elements are lit right now. For tests and for the frame-budget instrumentation. */
export function activeFlashCount(): number {
  return lit.size;
}

/** True while `el` carries a flash. */
export function isFlashing(el: HTMLElement): boolean {
  return lit.has(el);
}

/**
 * True once `el` has been flashed at least once and carries the permanent listener. For the
 * regression test that counts listeners: the count must stay at one however many flashes land.
 */
export function hasEndListener(el: HTMLElement): boolean {
  return bound.has(el);
}
