// packages/web/src/shell/Autocomplete.tsx — the ≤ 12-row popup and the query behind it
// (TERM-02, CLIENT.md §4.2-4.3 L307-334, FUNCTIONS.md §3.3 L924-962, §3.4 L964-973).
//
// ONE RANKER. `rank()` in `packages/core/src/command/rank.ts` scores these rows, and it is the same
// function the server's `/search` route runs over the same `UniverseIndex` shape
// (`server/src/search/rank.ts` calls it verbatim). That is the whole reason there is no scoring in
// this file: the moment the client sorts by its own idea of relevance, a desk that falls back to
// the server on a slow index gets a different list for the same three characters — and, worse, GO
// executes row 0, so a client-side reordering silently changes what Enter does. Nothing here adds
// to a score, and nothing reorders what `rank()` returned.
//
// WHAT THIS FILE DOES OWN is the two things `rank()` cannot know from a bare query string:
//
//   * **Which token is being completed.** FUNCTIONS §3.3 L926: "only the token being completed is
//     scored; anchored tokens narrow the candidate set". `AAPL US Equity D` completes `D` against
//     the functions, not `AAPL US Equity D` against the tickers, and the anchored security becomes
//     the panel context the function rows are scored in. `completionOf()` is that decision and it
//     is made by asking the real parser what it resolved, never by splitting on spaces and hoping.
//   * **The server fallback** of §3.4: only when the local index is not built, or three characters
//     have produced no strong local hit, debounced 60 ms, one `AbortController` per query, and the
//     hits appended *below* the local rows so the list never reorders under the user's hand.
//
// The `SECF <text>` row is the third thing, and it is a rule from §2.5 rather than from ranking: a
// function that needs a security, typed into an empty panel, offers the security finder instead of
// failing. `command/dispatch.ts` reports the same suggestion in the footer; this puts it where the
// user's hands already are.
//
// IO: the fallback goes through the injected `search` port, which the Shell implements over
// `sdk.search.query` (API-05). Nothing here touches the network itself.

import { memo, useEffect, useRef } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import {
  MAX_RESULTS,
  SECURITY_FINDER_FUNCTION,
  parse,
  rank,
  tokenize,
  type Candidate,
  type FunctionRegistry,
  type MarketSector,
  type MruRank,
  type PanelContext,
  type ParseEnv,
  type ParsedCommand,
  type RankContext,
  type UniverseIndex,
} from '@terminal/core';

import { listboxId, optionId } from './CommandLine.js';

/* ---------------------------------------------------------------------------------------------- */
/* Query                                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/** FUNCTIONS §3.3: the list is twelve rows, and core owns the number. */
export const MAX_ROWS = MAX_RESULTS;

/** §3.4: the server is asked only from this length up. */
export const SERVER_FALLBACK_MIN_CHARS = 3;

/** §3.4: "60 ms have elapsed without a further keystroke". */
export const SERVER_DEBOUNCE_MS = 60;

/**
 * §3.4's "no local hit has match ≥ 60".
 *
 * `Candidate` publishes the composite `score`, not the `match` term on its own, so the test is
 * applied to the score with trigram hits excluded — a trigram match is at most 40 by construction
 * (§3.3) and can only reach 60 through popularity and recency, which is precisely the case the
 * fallback exists to catch.
 */
export const STRONG_LOCAL_SCORE = 60;

/** What the ranker needs to score a keystroke, gathered by the Shell once per panel. */
export interface AutocompleteContext {
  index: UniverseIndex;
  registry: FunctionRegistry;
  /** The focused panel's context (`state/panels.ts#selectPanelContext`). */
  panel: PanelContext;
  lookupTicker: ParseEnv['lookupTicker'];
  /** False until the local index has been built; §3.4's first fallback condition. */
  ready?: boolean;
  /** Instrument ids in the panel's watchlist/monitor rows — §3.3's `+8` context term. */
  watchlistIds?: ReadonlySet<number>;
  today?: ParseEnv['today'];
  panelId?: string;
}

/** The token the caret is in, and what anchors it. */
export interface Completion {
  /** Upper-cased text handed to `rank()`. */
  q: string;
  /** `[start, end)` of `q` in the raw text — what a completion replaces. */
  span: [number, number];
  /** Which position is being completed; a function completes against the anchored security. */
  position: 'security' | 'function' | 'token';
  /** Set only when the sector was typed *in the token being completed* (R1). */
  sector?: MarketSector;
}

export interface AutocompleteResult {
  rows: Candidate[];
  completion: Completion;
  parsed: ParsedCommand | undefined;
  /** The parse says this function needs a security the panel has not got (§2.5 L777). */
  needsSecurity: boolean;
}

const EMPTY_COMPLETION: Completion = { q: '', span: [0, 0], position: 'token' };

/**
 * Which token is being completed.
 *
 * The parser is the authority: if it resolved a function whose span reaches the caret, that is what
 * is being completed; likewise a security. Only when it resolved neither does this fall back to the
 * trailing token, which is the case for text that is not yet anything (`APP`, `FED`).
 *
 * Trailing whitespace means the user has finished a token and started nothing, so there is no
 * completion at all — an empty `q`, which `rank()` answers with an empty list.
 */
export function completionOf(raw: string, parsed: ParsedCommand | undefined): Completion {
  if (raw === '' || /\s$/.test(raw)) return EMPTY_COMPLETION;
  const end = raw.length;

  const fn = parsed?.fn;
  if (fn?.span[1] === end) {
    return {
      q: raw.slice(fn.span[0], fn.span[1]).toUpperCase(),
      span: [fn.span[0], end],
      position: 'function',
    };
  }

  const security = parsed?.security;
  if (security?.span[1] === end) {
    const completion: Completion = {
      q: raw.slice(security.span[0], security.span[1]).toUpperCase(),
      span: [security.span[0], end],
      position: 'security',
    };
    const sector = sectorOf(security);
    if (sector !== undefined) completion.sector = sector;
    return completion;
  }

  const tokens = tokenize(raw);
  const last = tokens[tokens.length - 1];
  if (last === undefined) return EMPTY_COMPLETION;
  // A trailing token that starts after a resolved security is a function being typed, even though
  // the parser could not name it yet (`AAPL US Equity DE` — `DE` is not a code, `DES` is). Saying
  // so is what lets the rows be scored against the security on the line rather than against the
  // panel's, which for an empty panel is the difference between DES ranking and DES not.
  const position: Completion['position'] =
    security !== undefined && security.span[1] <= last.start ? 'function' : 'token';
  return { q: last.upper, span: [last.start, last.end], position };
}

/** The sector the user actually typed, for R1; absent when the parser inferred it. */
function sectorOf(security: NonNullable<ParsedCommand['security']>): MarketSector | undefined {
  if (!security.sectorGiven) return undefined;
  const ref = security.ref as { kind?: string; sector?: MarketSector };
  return ref.kind === 'ticker' ? ref.sector : undefined;
}

/**
 * Parse, then rank. The local half of CLIENT §4.2, and the whole of it when the index is built.
 *
 * `parse()` runs first because its result *is* the context: the security it anchored is what the
 * function rows are scored against, and its problems are what put the `SECF` row on top.
 */
export function rankLocal(raw: string, ctx: AutocompleteContext): AutocompleteResult {
  const env: ParseEnv = {
    registry: ctx.registry,
    panel: ctx.panel,
    lookupTicker: ctx.lookupTicker,
    ...(ctx.today === undefined ? {} : { today: ctx.today }),
    ...(ctx.panelId === undefined ? {} : { panelId: ctx.panelId }),
  };
  const parsed = parse(raw, env)[0];
  const completion = completionOf(raw, parsed);
  const needsSecurity =
    parsed?.problems.some((p) => p.code === 'NO_SECURITY_LOADED') === true;

  if (completion.q === '') {
    return { rows: needsSecurity ? [securityFinderRow(raw, parsed)] : [], completion, parsed, needsSecurity };
  }

  // The panel the function rows are scored against: the panel's own security, or the one just
  // typed on this line. Typing `AAPL US Equity DE` must rank `DES` as applicable to an equity even
  // though the panel behind it is still empty.
  const panel = panelForRanking(ctx, parsed, completion);
  const rankCtx: RankContext = {
    panel,
    hasPanelSecurity: panel.security !== null,
    watchlistIds: new Set(ctx.watchlistIds ?? []),
    mru: new Map<string, MruRank>(ctx.index.mru),
  };
  if (completion.sector !== undefined) rankCtx.sectorGiven = completion.sector;

  const rows = rank(completion.q, ctx.index, rankCtx, ctx.registry);
  const withFinder = needsSecurity ? [securityFinderRow(raw, parsed), ...rows] : rows;
  return {
    rows: withFinder.length > MAX_ROWS ? withFinder.slice(0, MAX_ROWS) : withFinder,
    completion,
    parsed,
    needsSecurity,
  };
}

function panelForRanking(
  ctx: AutocompleteContext,
  parsed: ParsedCommand | undefined,
  completion: Completion,
): PanelContext {
  if (completion.position !== 'function') return ctx.panel;
  const typed = parsed?.security;
  if (typed?.instrumentId === undefined) return ctx.panel;
  const at = ctx.index.entryOfInstrument(typed.instrumentId);
  const entry = at >= 0 ? ctx.index.entryAt(at) : undefined;
  if (entry?.assetClass == null || entry.marketSector == null) return ctx.panel;
  return {
    security: {
      instrumentId: typed.instrumentId,
      assetClass: entry.assetClass,
      marketSector: entry.marketSector,
      display: entry.primary,
    },
    fn: ctx.panel.fn,
    params: ctx.panel.params,
  };
}

/**
 * `SECF <typed text>` — FUNCTIONS §2.5 L777.
 *
 * A synthetic row, not a ranked one: it is offered because of what the parse *said*, not because
 * anything matched. Its `insertText` is what GO will run, like every other row.
 */
export function securityFinderRow(raw: string, parsed: ParsedCommand | undefined): Candidate {
  const typed = (parsed?.fn?.code ?? raw.trim()).trim();
  const insertText = typed === '' ? SECURITY_FINDER_FUNCTION : `${SECURITY_FINDER_FUNCTION} ${typed}`;
  return {
    kind: 'function',
    id: SECURITY_FINDER_FUNCTION,
    primary: insertText,
    secondary: 'Find a security first — this panel has none loaded',
    score: 1_000,
    matchedOn: 'code',
    matched: [[0, SECURITY_FINDER_FUNCTION.length]],
    insertText,
    source: 'local',
    applicable: true,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* The engine: local now, server later (§3.4)                                                       */
/* ---------------------------------------------------------------------------------------------- */

export interface AutocompleteScheduler {
  setTimer(fn: () => void, ms: number): number;
  clearTimer(handle: number): void;
}

const defaultScheduler: AutocompleteScheduler = {
  setTimer: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimer: (handle) => {
    globalThis.clearTimeout(handle);
  },
};

export interface AutocompleteEngineOptions {
  /** Read fresh on every keystroke: the index is swapped in atomically under us (§3.1). */
  context(): AutocompleteContext;
  /** `sdk.search.query` — omitted when the shell has no server to fall back to. */
  search?: (q: string, signal: AbortSignal) => Promise<readonly Candidate[]>;
  /**
   * Called with the rows to show; twice per query when the server answers with something new.
   *
   * `span` is the token these rows complete: accepting one replaces exactly that range of the
   * draft (`CommandLine.tsx#applyCandidate`).
   */
  onRows(
    rows: Candidate[],
    info: {
      q: string;
      raw: string;
      source: 'local' | 'merged';
      span: readonly [number, number];
    },
  ): void;
  scheduler?: AutocompleteScheduler;
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

export interface AutocompleteEngine {
  /** Rank one keystroke. Returns the local rows synchronously — the ≤ 16 ms path. */
  query(raw: string): AutocompleteResult;
  /** Drop any pending server request (GO, Escape, blur). */
  cancel(): void;
  dispose(): void;
}

export function createAutocompleteEngine(options: AutocompleteEngineOptions): AutocompleteEngine {
  const scheduler = options.scheduler ?? defaultScheduler;
  const debounceMs = options.debounceMs ?? SERVER_DEBOUNCE_MS;
  let timer: number | null = null;
  let inFlight: AbortController | null = null;
  let generation = 0;

  const cancel = (): void => {
    if (timer !== null) {
      scheduler.clearTimer(timer);
      timer = null;
    }
    inFlight?.abort();
    inFlight = null;
  };

  return {
    query(raw) {
      cancel();
      generation += 1;
      const mine = generation;
      const ctx = options.context();
      const result = rankLocal(raw, ctx);
      options.onRows(result.rows, {
        q: result.completion.q,
        raw,
        source: 'local',
        span: result.completion.span,
      });

      const q = result.completion.q;
      const search = options.search;
      if (search === undefined || q === '') return result;

      const ready = ctx.ready !== false;
      const strong = result.rows.some(
        (row) => row.source === 'local' && row.matchedOn !== 'trigram' && row.score >= STRONG_LOCAL_SCORE,
      );
      const wanted = !ready || (q.length >= SERVER_FALLBACK_MIN_CHARS && !strong);
      if (!wanted) return result;

      timer = scheduler.setTimer(() => {
        timer = null;
        const controller = new AbortController();
        inFlight = controller;
        void search(q, controller.signal)
          .then((hits) => {
            // A response that arrives after a newer keystroke is discarded (§3.4).
            if (mine !== generation || controller.signal.aborted) return;
            const merged = mergeServerHits(result.rows, hits);
            if (merged.length === result.rows.length) return;
            options.onRows(merged, { q, raw, source: 'merged', span: result.completion.span });
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            options.onError?.(error);
          })
          .finally(() => {
            if (inFlight === controller) inFlight = null;
          });
      }, debounceMs);

      return result;
    },
    cancel,
    dispose: cancel,
  };
}

/**
 * Server hits go **below** the local rows, in the order the server sent them, minus anything
 * already shown.
 *
 * §3.4: "the list never reorders on arrival except by appending below local rows". A list that
 * re-sorted 60 ms after the user stopped typing would move the row under their finger.
 */
export function mergeServerHits(
  local: readonly Candidate[],
  hits: readonly Candidate[],
): Candidate[] {
  const seen = new Set(local.map((row) => `${row.kind}:${row.id}`));
  const out = [...local];
  for (const hit of hits) {
    if (out.length >= MAX_ROWS) break;
    const key = `${hit.kind}:${hit.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* The popup (CLIENT §4.3)                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** CLIENT §4.3 L323, verbatim. */
export interface AutocompleteProps {
  panelId: string;
  rows: Candidate[];
  selected: number;
  open: boolean;
  onSelect: (i: number) => void;
  onExecute: (i: number) => void;
  /** The panel security's sector, for the `not applicable to Curncy` reason (CLIENT §4.3). */
  notApplicableTo?: string;
  /** Tier badges: `registry.get(code)?.tier`. Omitted in tests that have no registry. */
  registry?: FunctionRegistry;
}

const GLYPH: Readonly<Record<Candidate['kind'], string>> = Object.freeze({
  instrument: '▤',
  function: 'ƒ',
  person: '☺',
  topic: '#',
});

const POPUP: CSSProperties = {
  position: 'absolute',
  zIndex: 20,
  left: 0,
  right: 0,
  margin: 0,
  padding: 0,
  listStyle: 'none',
  background: 'var(--c-bg-header)',
  border: '1px solid var(--c-grid-line)',
  maxHeight: '18rem',
  overflowY: 'auto',
};

const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '1ch',
  padding: '0 1ch',
  cursor: 'default',
  whiteSpace: 'nowrap',
};

/**
 * The popup.
 *
 * `role="listbox"` with the command-line input as its combobox, so the selected row is announced
 * without focus ever leaving the input — which it must not, because the next keystroke belongs to
 * the command line (TERM-01).
 */
export function Autocomplete({
  panelId,
  rows,
  selected,
  open,
  onSelect,
  onExecute,
  notApplicableTo,
  registry,
}: AutocompleteProps): ReactElement | null {
  const listRef = useRef<HTMLUListElement | null>(null);
  const shown = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;
  const active = Math.min(Math.max(selected, 0), Math.max(0, shown.length - 1));

  // jsdom does not scroll, and a browser must: the selected row is walked with the arrows and can
  // leave the visible window of a twelve-row list in a short panel.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const row = list?.children[active];
    if (row instanceof HTMLElement && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [active, open]);

  if (!open || shown.length === 0) return null;

  return (
    <ul
      className="ac"
      id={listboxId(panelId)}
      role="listbox"
      aria-label={`Command suggestions ${panelId}`}
      ref={listRef}
      style={POPUP}
    >
      {shown.map((row, i) => (
        <AutocompleteRow
          key={`${row.kind}:${row.id}`}
          panelId={panelId}
          row={row}
          index={i}
          selected={i === active}
          tier={row.kind === 'function' ? (registry?.get(row.id)?.tier ?? null) : null}
          notApplicableTo={notApplicableTo ?? null}
          onSelect={onSelect}
          onExecute={onExecute}
        />
      ))}
    </ul>
  );
}

interface AutocompleteRowProps {
  panelId: string;
  row: Candidate;
  index: number;
  selected: boolean;
  tier: number | null;
  notApplicableTo: string | null;
  onSelect: (i: number) => void;
  onExecute: (i: number) => void;
}

/**
 * One row, memoised on its identity.
 *
 * Twelve of these are rebuilt on every keystroke, inside a 16 ms budget that also contains a parse
 * and a rank over 36 000 entries. `memo` is what keeps the eleven rows that did not change from
 * re-rendering when the twelfth did.
 */
const AutocompleteRow = memo(function AutocompleteRow({
  panelId,
  row,
  index,
  selected,
  tier,
  notApplicableTo,
  onSelect,
  onExecute,
}: AutocompleteRowProps): ReactElement {
  const dim = row.applicable === false;
  const reason =
    dim && notApplicableTo !== null && notApplicableTo !== ''
      ? `not applicable to ${notApplicableTo}`
      : dim
        ? 'not applicable here'
        : '';

  return (
    <li
      className="ac__row"
      id={optionId(panelId, index)}
      role="option"
      aria-selected={selected}
      data-kind={row.kind}
      {...(dim ? { 'data-applicable': 'false' } : {})}
      style={{
        ...ROW,
        background: selected ? 'var(--c-bg-selected)' : 'transparent',
        color: dim ? 'var(--c-muted)' : 'var(--c-value)',
        opacity: dim ? 0.6 : 1,
      }}
      onMouseDown={(e) => {
        // The command line keeps focus: a blur here would close the popup before the click lands.
        e.preventDefault();
        onSelect(index);
      }}
      onClick={() => {
        onExecute(index);
      }}
    >
      <span className="ac__glyph" aria-hidden="true">
        {GLYPH[row.kind]}
      </span>
      <span className="ac__primary">{highlight(row.primary, row.matched)}</span>
      <span className="ac__secondary" style={{ color: 'var(--c-muted)' }}>
        {row.secondary}
      </span>
      {tier === null ? null : (
        <span className="ac__tier" style={{ color: 'var(--c-label)' }}>{`T${String(tier)}`}</span>
      )}
      {row.source === 'yahoo' ? (
        <span className="ac__badge" style={{ color: 'var(--c-warn)' }}>
          not in master
        </span>
      ) : null}
      {reason === '' ? null : <span className="ac__reason">{reason}</span>}
    </li>
  );
});

/** `matched` ranges are ascending and non-overlapping (`core/search/types.ts`); render them so. */
function highlight(primary: string, ranges: readonly (readonly [number, number])[]): ReactElement {
  if (ranges.length === 0) return <>{primary}</>;
  const parts: ReactElement[] = [];
  let at = 0;
  ranges.forEach(([start, end], i) => {
    const from = Math.max(at, Math.min(start, primary.length));
    const to = Math.max(from, Math.min(end, primary.length));
    if (from > at) parts.push(<span key={`p${String(i)}`}>{primary.slice(at, from)}</span>);
    if (to > from) parts.push(<mark key={`m${String(i)}`}>{primary.slice(from, to)}</mark>);
    at = to;
  });
  if (at < primary.length) parts.push(<span key="tail">{primary.slice(at)}</span>);
  return <>{parts}</>;
}

export default Autocomplete;
