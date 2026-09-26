// packages/web/src/shell/CommandLine.tsx — the one line the whole terminal is driven from
// (TERM-01, CLIENT.md §4.1 L283-305, FUNCTIONS.md §2.6 L790-812).
//
// THE INPUT IS UNCONTROLLED, AND THAT IS THE DESIGN, NOT AN OPTIMISATION.
//
// The budget is 16 ms from keystroke to visual feedback (FUNCTIONS §3.5) and behind this input sit
// ~36 000 universe entries that are parsed and ranked on every character. A controlled input adds a
// React commit of the panel subtree to that path for no benefit: the browser has already painted
// the character the user typed before React hears about it. So the DOM node owns its own value,
// `onInput` pushes the text sideways (the transient store write and the autocomplete query), and
// this component re-renders only when something that is actually *on screen and React's* changes —
// which, here, is one thing: a parse problem.
//
// Three consequences worth stating, because they are what the rest of the shell must respect:
//
//   1. **Nothing may pass the draft back in as a prop.** A `value` prop would re-render on every
//      keystroke and put us back where we started. `test/shell/commandline.test.tsx` asserts the
//      absence of those commits with a `<Profiler>`, so a well-meaning refactor cannot reintroduce
//      them quietly.
//   2. **The autocomplete state is read, never received.** `getAc()` is a stable getter into the
//      panel store; the popup is a separate component that re-renders on its own. What the input
//      still owes the screen reader — `aria-expanded` and `aria-activedescendant` — is written
//      straight to the DOM node (`syncAria`) immediately after `onInput`, which is correct because
//      the store write and the ranking are synchronous: by the time `onInput` returns, `getAc()`
//      already describes the list the user is about to see.
//   3. **The keys this component consumes never reach the window dispatcher.** They are stopped at
//      React's root container with `stopPropagation()`. That is deliberate: CLIENT §5.1 makes the
//      command line's own map stage 4, and the alternative — letting `Enter` be handled here *and*
//      by the dispatcher's reserved stage — executes the command twice. The dispatcher's `go()`
//      still exists, for the key bar's GO and for a GO pressed while focus is on a grid.
//
// A PARSE PROBLEM IS SHOWN AGAINST ITS SPAN. `CommandProblem` carries `[start, end)` into the raw
// text, and the mirror line under the input marks exactly that substring. A user who typed
// `AAPL US Equity GP TYPE=zigzag` is told which token is wrong and sees it underlined, rather than
// being handed "invalid command" for a line that is 90 % correct.
//
// IO: none. This component performs no request; it calls the callbacks the Panel gives it.

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement, Ref } from 'react';

import type { Candidate, CommandProblem, MarketSector } from '@terminal/core';

import { insertSectorToken, reservedFor } from '../keyboard/keymap.js';

/* ---------------------------------------------------------------------------------------------- */
/* The contract                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

/** What the command line reads of the autocomplete; the popup itself is `Autocomplete.tsx`. */
export interface AutocompleteSnapshot {
  open: boolean;
  rows: readonly Candidate[];
  selected: number;
  /**
   * `[start, end)` of the token the rows complete, in the current draft
   * (`Autocomplete.tsx#completionOf`).
   *
   * Accepting a row REPLACES THAT SPAN and nothing else, which is the difference between a
   * completion and a retype: with `AAPL US Equity DE` typed, the `DES` row must leave
   * `AAPL US Equity DES`, not the bare `DES` that would then run against an empty panel. Absent,
   * the whole line is replaced, which is the right fallback for a caller that does not rank.
   */
  span?: readonly [number, number];
}

const CLOSED: AutocompleteSnapshot = { open: false, rows: [], selected: 0 };

/** Accepting a row: the draft with the completed token replaced by the row's `insertText`. */
export function applyCandidate(
  text: string,
  candidate: Candidate,
  span: readonly [number, number] | undefined,
): string {
  if (span === undefined) return candidate.insertText;
  const start = Math.max(0, Math.min(span[0], text.length));
  const end = Math.max(start, Math.min(span[1], text.length));
  return `${text.slice(0, start)}${candidate.insertText}${text.slice(end)}`;
}

/** The row GO is executing, when it came from the popup (drives `search.select`, TERM-02). */
export interface GoSelection {
  candidate: Candidate;
  /** 0-based row index, as `search.select.details.rank`. */
  rank: number;
}

/**
 * What the shell can do to a command line. This is also exactly what `keyboard/dispatcher.ts`'s
 * `KeyboardHost` needs for `focusCommandLine`, `typeIntoCommandLine`, `insertSector`,
 * `commandText` and `clearCommandDraft` — the Shell wires one to the other.
 */
export interface CommandLineHandle {
  /** The current draft, read from the DOM (there is no React copy of it). */
  text(): string;
  /** Replace the draft; notifies `onInput` so the store and the autocomplete stay in step. */
  setText(text: string, caret?: number): void;
  focus(opts?: { selectAll?: boolean }): void;
  /** Typing anywhere (TERM-06): one character, at the caret. */
  type(ch: string): void;
  /** A yellow key (F2…F11): insert the sector token after the typed ticker (FUNCTIONS §2.6). */
  insertSector(sector: MarketSector): void;
  /** The CANCEL ladder's "clear the command draft" rung. */
  clear(): void;
  /** GO — the key bar's button and the dispatcher's reserved `Enter` both land here. */
  go(): void;
  /** History recall: `-1` older, `+1` newer (CLIENT §4.4). */
  recall(direction: 1 | -1): void;
  element(): HTMLInputElement | null;
}

export interface CommandLineProps {
  /** `'p1'`…`'p8'`; the popup's element ids are derived from it. */
  panelId: string;
  /** The restored draft (`PanelState.commandDraft`). Uncontrolled: later changes are ignored. */
  defaultText?: string;
  /** The panel's executed commands, oldest first (`PanelState.history`, ≤ 100). */
  history?: readonly string[];
  /** The last parse or run problem for this panel; `null` clears the line. */
  problem?: CommandProblem | null;
  /** Reads the panel's live autocomplete state. Must be stable across renders. */
  getAc?: () => AutocompleteSnapshot;
  /** Every keystroke: the transient draft write **and** the autocomplete query (CLIENT §4.1). */
  onInput?: (text: string) => void;
  /**
   * GO. `text` is what runs: the draft, or the draft with the highlighted row's `insertText`
   * substituted into the completed token. `selection` is that row, for `search.select`.
   */
  onGo?: (text: string, selection: GoSelection | null) => void;
  /** ArrowDown / ArrowUp with the popup open. */
  onMoveSelection?: (delta: 1 | -1) => void;
  /** Tab completed a row (no execute, CLIENT §4.1). */
  onComplete?: (text: string, candidate: Candidate) => void;
  /**
   * A recalled history entry closed the popup.
   *
   * `ArrowUp` walks the history, and the second `ArrowUp` must walk it further rather than start
   * moving the selection of a popup that opened because the recalled text was re-queried.
   */
  onCloseAutocomplete?: () => void;
  placeholder?: string;
  ref?: Ref<CommandLineHandle>;
}

/** The popup's `role="listbox"` id for a panel — shared with `Autocomplete.tsx`. */
export function listboxId(panelId: string): string {
  return `ac-${panelId}`;
}

/** The popup's `role="option"` id for a row — shared with `Autocomplete.tsx`. */
export function optionId(panelId: string, index: number): string {
  return `ac-${panelId}-opt-${String(index)}`;
}

/* ---------------------------------------------------------------------------------------------- */
/* History recall (CLIENT §4.4)                                                                     */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The history entries `ArrowUp` walks, most recent first, de-duplicated.
 *
 * A non-empty draft filters by prefix (CLIENT §4.4): `AAPL` then `ArrowUp` offers the last thing
 * that started with `AAPL`, not the last thing typed. The comparison is case-insensitive because
 * the command line is.
 */
export function historyMatches(history: readonly string[], prefix: string): string[] {
  const needle = prefix.trim().toUpperCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry === undefined || entry === '') continue;
    if (needle !== '' && !entry.toUpperCase().startsWith(needle)) continue;
    const key = entry.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* Presentation                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

// Layout only. Colour comes from `theme/tokens.css` through `var(--c-*)`; these are inline because
// the shell stylesheet is another work package's file and the two must not race to define
// `.cmd`. Every rule here is either positioning or the mirror alignment the span highlight needs.

const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '1ch',
  padding: '0 1ch',
  background: 'var(--c-bg-panel)',
};

const PROMPT: CSSProperties = { color: 'var(--c-label)', fontWeight: 600 };

const FIELD: CSSProperties = { position: 'relative', flex: '1 1 auto', minWidth: 0 };

/** The mirror and the input must be the same text in the same place, or the mark lands wrong. */
const TEXT: CSSProperties = {
  font: 'inherit',
  letterSpacing: 'inherit',
  padding: 0,
  margin: 0,
  border: 'none',
  width: '100%',
  whiteSpace: 'pre',
};

const INPUT: CSSProperties = {
  ...TEXT,
  position: 'relative',
  background: 'transparent',
  color: 'var(--c-value)',
  outline: 'none',
  textTransform: 'uppercase',
};

const MIRROR: CSSProperties = {
  ...TEXT,
  position: 'absolute',
  inset: 0,
  color: 'transparent',
  pointerEvents: 'none',
  overflow: 'hidden',
  textTransform: 'uppercase',
};

const MARK: CSSProperties = {
  background: 'transparent',
  color: 'transparent',
  borderBottom: '2px solid var(--c-error)',
};

const PROBLEM: CSSProperties = { margin: 0, padding: '0 1ch', color: 'var(--c-error)' };

/* ---------------------------------------------------------------------------------------------- */
/* The component                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

export function CommandLine({
  panelId,
  defaultText = '',
  history = [],
  problem = null,
  getAc,
  onInput,
  onGo,
  onMoveSelection,
  onComplete,
  onCloseAutocomplete,
  placeholder,
  ref,
}: CommandLineProps): ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** History cursor: -1 is the live draft, 0 the most recent match. */
  const cursor = useRef(-1);
  /** The draft the user was writing before `ArrowUp` walked away from it. */
  const stash = useRef<string>('');
  /** The text the problem below is anchored to, captured when the problem arrived. */
  const [problemText, setProblemText] = useState('');

  const ac = useCallback((): AutocompleteSnapshot => getAc?.() ?? CLOSED, [getAc]);

  /** `aria-expanded` / `aria-activedescendant`, written to the node rather than re-rendered. */
  const syncAria = useCallback((): void => {
    const input = inputRef.current;
    if (input === null) return;
    const state = ac();
    input.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    if (state.open && state.rows.length > 0 && state.selected >= 0) {
      const index = Math.min(state.selected, state.rows.length - 1);
      input.setAttribute('aria-activedescendant', optionId(panelId, index));
    } else {
      // A combobox with `aria-autocomplete="list"` and no highlighted row has NO active descendant
      // (WAI-ARIA 1.2 combobox pattern). Announcing row 0 as active while GO would run the typed
      // text is the screen-reader form of the same lie the visual highlight told sighted users.
      input.removeAttribute('aria-activedescendant');
    }
  }, [ac, panelId]);

  /**
   * Every path that changes the text goes through here: one place that notifies, one that syncs.
   *
   * A replacement that did not come from `recall` ends the history walk — the draft is new, so the
   * next `ArrowUp` starts again from it rather than from wherever the last walk had got to.
   */
  const commit = useCallback(
    (text: string, caret?: number, keepCursor = false): void => {
      if (!keepCursor) {
        cursor.current = -1;
        stash.current = '';
      }
      const input = inputRef.current;
      if (input !== null) {
        input.value = text;
        const at = caret ?? text.length;
        input.setSelectionRange(at, at);
      }
      onInput?.(text);
      syncAria();
    },
    [onInput, syncAria],
  );

  const go = useCallback((): void => {
    const text = inputRef.current?.value ?? '';
    const state = ac();
    // `selected < 0` is "the popup is open and NOTHING in it is highlighted", and it is honoured
    // here rather than clamped to row 0. The clamp was the defect: the shell reports a fresh list
    // with no selection, so every GO looked like "execute the highlighted row" and `AAPL US Equity
    // DES` was substituted-and-run as whichever row the ranking had put first. The invariant the old
    // comment appealed to — row 0 is `parse(text)[0]`'s leading candidate, so the substitution is the
    // identity — is NOT true of the shipped engine: for `AAPL US Equity DES` row 0 is the function
    // `DES`, whose `insertText` is `DES`. An untouched popup must therefore yield the typed text.
    const index =
      state.selected < 0 || state.rows.length === 0
        ? -1
        : Math.min(state.selected, state.rows.length - 1);
    const row = state.open && index >= 0 ? state.rows[index] : undefined;
    cursor.current = -1;
    stash.current = '';
    if (row === undefined) {
      onGo?.(text, null);
      return;
    }
    // A row the user DID arrow onto is accepted into the completed span and the whole line runs.
    onGo?.(applyCandidate(text, row, state.span), { candidate: row, rank: index });
  }, [ac, onGo]);

  const recall = useCallback(
    (direction: 1 | -1): void => {
      const input = inputRef.current;
      if (input === null) return;
      if (cursor.current === -1) stash.current = input.value;
      const matches = historyMatches(history, stash.current);
      if (matches.length === 0) return;

      // -1 walks back into the past (ArrowUp), +1 returns towards the live draft.
      const next = direction === -1 ? cursor.current + 1 : cursor.current - 1;
      if (next < -1) return;
      if (next >= matches.length) return;
      cursor.current = next;
      commit(next === -1 ? stash.current : (matches[next] ?? stash.current), undefined, true);
      onCloseAutocomplete?.();
    },
    [commit, history, onCloseAutocomplete],
  );

  const insertSector = useCallback(
    (sector: MarketSector): void => {
      const input = inputRef.current;
      if (input === null) return;
      const { text, caret } = insertSectorToken(input.value, sector);
      commit(text, caret);
    },
    [commit],
  );

  const focus = useCallback((opts: { selectAll?: boolean } = {}): void => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    if (opts.selectAll === true) input.select();
  }, []);

  useImperativeHandle(
    ref,
    (): CommandLineHandle => ({
      text: () => inputRef.current?.value ?? '',
      setText: (text, caret) => {
        commit(text, caret);
      },
      focus,
      type: (ch) => {
        const input = inputRef.current;
        if (input === null) return;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        const next = `${input.value.slice(0, start)}${ch}${input.value.slice(end)}`;
        commit(next, start + ch.length);
      },
      insertSector,
      clear: () => {
        cursor.current = -1;
        stash.current = '';
        commit('');
      },
      go,
      recall,
      element: () => inputRef.current,
    }),
    [commit, focus, go, insertSector, recall],
  );

  // The problem is anchored to the text that produced it. GO does not clear the draft when the
  // command is refused (`command/dispatch.ts`), so the input still holds exactly that text.
  useEffect(() => {
    setProblemText(problem == null ? '' : (inputRef.current?.value ?? ''));
  }, [problem]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    const state = ac();

    // A yellow key first: F2…F11 are reserved, and the browser must not get F5 or F11.
    const reserved = reservedFor(e);
    if (reserved?.action === 'sector' && reserved.sector !== undefined) {
      e.preventDefault();
      e.stopPropagation();
      insertSector(reserved.sector);
      return;
    }

    switch (e.key) {
      case 'Enter': {
        // GO. Handled here rather than by the window dispatcher's reserved stage, which would
        // otherwise run the same command a second time (see the module header).
        e.preventDefault();
        e.stopPropagation();
        go();
        return;
      }
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        e.stopPropagation();
        const down = e.key === 'ArrowDown';
        if (state.open && state.rows.length > 0) {
          onMoveSelection?.(down ? 1 : -1);
          syncAria();
          return;
        }
        recall(down ? 1 : -1);
        return;
      }
      case 'Tab': {
        // Completion, never execution (CLIENT §4.1). With the popup closed, Tab is the reserved
        // focus move and belongs to the dispatcher, so it is left alone.
        if (!state.open || state.rows.length === 0 || e.shiftKey) return;
        const index = Math.min(Math.max(state.selected, 0), state.rows.length - 1);
        const row = state.rows[index];
        if (row === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        const text = `${applyCandidate(e.currentTarget.value, row, state.span)} `;
        commit(text);
        onComplete?.(text, row);
        return;
      }
      default:
        break;
    }

    if (e.key === 'l' && e.ctrlKey && !e.altKey && !e.metaKey) {
      // Ctrl+L with focus already here is select-all (CLIENT §4.1); the dispatcher's version
      // focuses this input from elsewhere and does the same thing through `focus({selectAll})`.
      e.preventDefault();
      e.stopPropagation();
      inputRef.current?.select();
    }
  };

  const span = problem == null ? null : clampSpan(problem.span, problemText);

  return (
    <div className="cmd" data-panel-id={panelId} style={ROW}>
      <span className="cmd__prompt" aria-hidden="true" style={PROMPT}>
        {'>'}
      </span>
      <span className="cmd__field" style={FIELD}>
        {span === null ? null : (
          <span className="cmd__mirror" aria-hidden="true" style={MIRROR}>
            {problemText.slice(0, span[0])}
            <mark className="cmd__span" style={MARK}>
              {problemText.slice(span[0], span[1])}
            </mark>
            {problemText.slice(span[1])}
          </span>
        )}
        <input
          ref={inputRef}
          className="cmd__input"
          // The documented end-to-end handle for this input (`packages/e2e/tests/smoke.spec.ts`
          // L20). The scaffold `App.tsx` carried it and the real command line did not, so the only
          // committed Playwright spec stopped finding a command line the moment the composition root
          // landed. It is per PANEL — a four-panel layout has four of them — so an e2e selector that
          // must be unique scopes it by `[data-panel="p1"]` first.
          data-testid="command-line"
          style={INPUT}
          type="text"
          defaultValue={defaultText}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          role="combobox"
          aria-label={`Command line ${panelId}`}
          aria-autocomplete="list"
          aria-expanded="false"
          aria-controls={listboxId(panelId)}
          {...(problem == null ? {} : { 'aria-invalid': true, 'aria-errormessage': `cmd-problem-${panelId}` })}
          {...(placeholder === undefined ? {} : { placeholder })}
          onKeyDown={onKeyDown}
          onInput={(e) => {
            cursor.current = -1;
            onInput?.(e.currentTarget.value);
            syncAria();
          }}
        />
      </span>
      {problem == null ? null : (
        <p
          className="cmd__problem"
          id={`cmd-problem-${panelId}`}
          role="status"
          style={PROBLEM}
        >
          {problemMessage(problem, problemText, span)}
        </p>
      )}
    </div>
  );
}

/** A span is a promise about the raw text; a stale one is clamped rather than thrown away. */
function clampSpan(span: readonly [number, number], text: string): [number, number] {
  const start = Math.max(0, Math.min(span[0], text.length));
  const end = Math.max(start, Math.min(span[1], text.length));
  return [start, end];
}

/**
 * The footer line. It names the offending token, because the underline is a visual channel and a
 * screen reader gets nothing from it.
 */
function problemMessage(
  problem: CommandProblem,
  text: string,
  span: [number, number] | null,
): string {
  const token = span === null ? '' : text.slice(span[0], span[1]).trim();
  return token === ''
    ? `${problem.code}: ${problem.message}`
    : `${problem.code}: ${problem.message} — ${token}`;
}

export default CommandLine;
