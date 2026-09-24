// packages/web/src/screen/widgets/roving.ts — one tab stop per node, arrows inside it.
//
// The keyboard contract (FUNCTIONS.md §1.5, CLIENT.md §5.4) is that `Tab` moves *between* nodes and
// arrows move *within* one. A node with twenty rows must therefore be a single tab stop, which is
// the roving-tabindex pattern: exactly one descendant carries `tabIndex={0}` and the rest carry
// `-1`, and the arrow keys move both the focus and the zero.

import { useCallback, useRef, useState } from 'react';

export interface Roving {
  /** The item that currently owns the node's tab stop, clamped to the item count. */
  index: number;
  /** Move focus to `next`, wrapping at both ends. A no-op when the node has no items. */
  move: (next: number) => void;
  /** Move without focusing — for pointer interaction, which has already moved the focus. */
  set: (next: number) => void;
  /** `ref` for item `i`, so `move` can focus it. */
  register: (i: number) => (el: HTMLElement | null) => void;
  /** `tabIndex` for item `i`. */
  tabIndex: (i: number) => 0 | -1;
}

export function useRoving(count: number): Roving {
  const [raw, setRaw] = useState(0);
  const items = useRef<(HTMLElement | null)[]>([]);
  const index = count === 0 ? 0 : Math.min(Math.max(raw, 0), count - 1);

  const move = useCallback(
    (next: number) => {
      if (count === 0) return;
      const wrapped = ((next % count) + count) % count;
      setRaw(wrapped);
      items.current[wrapped]?.focus();
    },
    [count],
  );

  const set = useCallback(
    (next: number) => {
      if (count === 0) return;
      setRaw(((next % count) + count) % count);
    },
    [count],
  );

  const register = useCallback(
    (i: number) => (el: HTMLElement | null) => {
      items.current[i] = el;
    },
    [],
  );

  const tabIndex = useCallback((i: number): 0 | -1 => (i === index ? 0 : -1), [index]);

  return { index, move, set, register, tabIndex };
}

/**
 * The linear arrow handling every list-shaped widget shares: Up/Down (and Left/Right when the node
 * is laid out in a row), Home and End. Returns true when the key was consumed.
 */
export function rovingKey(
  key: string,
  roving: Roving,
  count: number,
  axis: 'vertical' | 'horizontal' = 'vertical',
): boolean {
  const prev = axis === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
  const next = axis === 'vertical' ? 'ArrowDown' : 'ArrowRight';
  if (key === next) {
    roving.move(roving.index + 1);
    return true;
  }
  if (key === prev) {
    roving.move(roving.index - 1);
    return true;
  }
  if (key === 'Home') {
    roving.move(0);
    return true;
  }
  if (key === 'End') {
    roving.move(count - 1);
    return true;
  }
  return false;
}
