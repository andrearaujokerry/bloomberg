// packages/web/test/shell/autocomplete.bench.ts — WP-12 acceptance row (WORKPLAN L1407):
// "ranking + render under the 80 ms p95 budget on the 36 k-instrument snapshot".
//
// This is a vitest TEST, not a reporting benchmark, for the same reason `core`'s
// `command.bench.ts` is one: a budget that only prints a number is a budget nobody notices
// breaking. The p95 is asserted, and this file fails the suite when the keystroke path regresses.
//
// WHAT IS TIMED IS A KEYSTROKE, NOT A FUNCTION CALL. The acceptance row says "ranking **plus
// render**", and the only honest way to measure that pair is to let the real components do it:
// the real `CommandLine` (uncontrolled input, CLIENT §4.1), the real `createAutocompleteEngine`
// over the real `parse()` and `rank()`, and the real `Autocomplete` popup rendering into jsdom.
// So each sample is the wall time of one native `input` event dispatched at the real input node —
// which contains, inside React's own discrete-event flush:
//
//     parse(raw) → completionOf → rank(q, index, ctx, registry) → onRows → setState →
//     React render of the ≤ 12-row popup → DOM commit
//
// Nothing is stubbed on that path. The assertion after the timed section proves the render really
// did happen inside the measured window: the `role="option"` nodes are counted straight off the
// document *before* anything flushes, and a deferred render would show zero of them.
//
// TWO BUDGETS, both from the design, both asserted:
//
//   * **80 ms p95** — the WP-12 acceptance row (WORKPLAN L1407) and the NFR of FUNCTIONS §3.5
//     ("autocomplete result set < 80 ms p95"). On the local path this is the whole keystroke.
//   * **16 ms** — "keystroke to visual feedback" (FUNCTIONS §3.5, CLIENT §16 L1179). This is the
//     budget that a controlled command-line input would destroy, so it is measured here and the
//     React commit count of the command-line subtree is asserted at zero over the same run: if a
//     refactor ever passes the draft back in as a prop, this file reports the commits *and* the
//     milliseconds they cost.
//
// METHOD (the shape `core`'s bench established, because the noise is the same shape):
//
//   * The universe is the §3.1 snapshot at its stated volumes — 36 000 US-listed instruments plus
//     31 indices, 9 FX pairs, 4 crypto, 20 govt/rate lines and 70 econ series, the real 38-manifest
//     registry with its real aliases, 500 people and 13 topics — built from one seeded
//     xoshiro128** stream (`core/analytics/prng.ts`), so every machine ranks a byte-identical
//     corpus and a regression is a code change, never a different fixture.
//   * 480 keystrokes drawn from that corpus: ticker prefixes of one to four characters (a
//     one-character prefix touches the largest block of the ticker array and is the worst case),
//     name-word prefixes, function codes and aliases typed *after* a resolved security — the
//     `AAPL US Equity DE` form, which is the expensive one because the parser resolves the
//     security before the functions are scored — and typos that fall through to the trigram
//     fallback.
//   * Three untimed warmup passes, then three measured rounds; the assertion is on the MEDIAN
//     round's p95. One round's p95 on a loaded laptop can be one GC pause; the median of three is
//     robust to that while still failing on a real regression, which moves every round together.
//
// No `setTimeout` is waited on (TESTING §2.2): the engine is built without a `search` port, so the
// §3.4 server fallback never arms its debounce, and every millisecond counted here is synchronous.

import {
  UniverseIndex,
  registry,
  type AssetClass,
  type Candidate,
  type MarketSector,
  type MruRecord,
  type PanelContext,
  type ParseEnv,
  type UniverseFunctionTuple,
  type UniverseInstrumentTuple,
  type UniversePersonTuple,
  type UniverseSnapshot,
  type UniverseTopicTuple,
} from '@terminal/core';
import { makePrng } from '@terminal/core/analytics/prng';
import { render } from '@testing-library/react';
import { Profiler, createElement, useEffect, useReducer, useRef } from 'react';
import type { ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  Autocomplete,
  createAutocompleteEngine,
  rankLocal,
  type AutocompleteContext,
  type AutocompleteEngine,
} from '../../src/shell/Autocomplete.js';
import { CommandLine, type AutocompleteSnapshot } from '../../src/shell/CommandLine.js';

/* ---------------------------------------------------------------------------------------------- */
/* Budgets                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** WORKPLAN L1407 / FUNCTIONS §3.5: the autocomplete result set, p95. */
const BUDGET_P95_MS = 80;

/** FUNCTIONS §3.5 / CLIENT §16 L1179: keystroke to visual feedback, one frame. */
const KEYSTROKE_BUDGET_MS = 16;

/** No single round may cross this, however loaded the machine is. */
const CEILING_P95_MS = BUDGET_P95_MS;

const US_LISTED = 36_000;
const INDICES = 31;
const FX_PAIRS = 9;
const CRYPTO = 4;
const GOVT = 20;
const ECON = 70;
const PEOPLE = 500;
const WARMUP_PASSES = 3;
const ROUNDS = 3;

/* ---------------------------------------------------------------------------------------------- */
/* The 36 k-instrument snapshot (FUNCTIONS §3.1 L866-872, DATA_MODEL §18 volumes)                   */
/* ---------------------------------------------------------------------------------------------- */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const WORDS = [
  'ALPHA', 'AMERICAN', 'BANCORP', 'BRIDGE', 'CAPITAL', 'CONSOLIDATED', 'DELTA', 'DIGITAL',
  'ELECTRIC', 'ENERGY', 'FEDERAL', 'FINANCIAL', 'GLOBAL', 'HOLDINGS', 'INDUSTRIES', 'JUNIPER',
  'KINETIC', 'LOGISTICS', 'MICRO', 'NORTHERN', 'OMEGA', 'PACIFIC', 'QUANTUM', 'RESOURCES',
  'SYSTEMS', 'TECHNOLOGIES', 'UNION', 'VENTURES', 'WESTERN', 'XENON', 'YIELD', 'ZENITH',
] as const;

const SUFFIXES = ['Inc', 'Corp', 'Ltd', 'Group', 'Holdings', 'Co', 'PLC', 'Trust'] as const;

const INDEX_NAMES = [
  'S&P 500', 'Dow Jones Industrial Average', 'Nasdaq 100', 'Russell 2000', 'FTSE 100', 'DAX',
  'CAC 40', 'Nikkei 225', 'Hang Seng', 'Euro Stoxx 50', 'S&P/TSX', 'IBEX 35', 'AEX', 'SMI',
  'OMX Stockholm 30', 'ASX 200', 'KOSPI', 'Sensex', 'Bovespa', 'MOEX', 'Straits Times',
  'Shanghai Composite', 'Taiex', 'Jakarta Composite', 'PSEi', 'Nifty 50', 'MIB', 'BEL 20',
  'ATX', 'PSI 20', 'Tel Aviv 35',
] as const;

const FX_PAIR_CODES = [
  ['EURUSD', 'Euro / US Dollar'],
  ['USDJPY', 'US Dollar / Japanese Yen'],
  ['GBPUSD', 'British Pound / US Dollar'],
  ['USDCHF', 'US Dollar / Swiss Franc'],
  ['AUDUSD', 'Australian Dollar / US Dollar'],
  ['USDCAD', 'US Dollar / Canadian Dollar'],
  ['NZDUSD', 'New Zealand Dollar / US Dollar'],
  ['EURGBP', 'Euro / British Pound'],
  ['USDCNH', 'US Dollar / Offshore Yuan'],
] as const;

const CRYPTO_CODES = [
  ['XBT', 'Bitcoin'],
  ['ETH', 'Ether'],
  ['SOL', 'Solana'],
  ['XRP', 'XRP'],
] as const;

const TOPIC_CODES = [
  ['FED', 'Federal Reserve'],
  ['ECB', 'European Central Bank'],
  ['CPI', 'Consumer Prices'],
  ['OIL', 'Crude Oil'],
  ['MNA', 'Mergers and Acquisitions'],
  ['IPO', 'Initial Public Offerings'],
  ['ERNS', 'Earnings Season'],
  ['GEO', 'Geopolitics'],
  ['CRD', 'Credit Markets'],
  ['FXT', 'Currencies'],
  ['CRY', 'Crypto'],
  ['REG', 'Regulation'],
  ['JOB', 'Labour Market'],
] as const;

const FIRST_NAMES = [
  'Jane', 'John', 'Aisha', 'Carlos', 'Mei', 'Priya', 'Tomas', 'Anna', 'David', 'Fatima',
] as const;
const LAST_NAMES = [
  'Doe', 'Smith', 'Okafor', 'Rivera', 'Chen', 'Patel', 'Novak', 'Muller', 'Kim', 'Haddad',
] as const;

interface Corpus {
  snapshot: UniverseSnapshot;
  /** US-listed tickers, in corpus order — the query set is drawn from these. */
  tickers: string[];
  /** Company names, in corpus order. */
  names: string[];
}

/**
 * Build the corpus. Everything comes off one seeded generator in a fixed order, so the snapshot is
 * identical on every machine and in every process.
 */
function buildCorpus(): Corpus {
  const prng = makePrng('WP-12:autocomplete.bench:36k');
  const pick = <T>(xs: readonly T[]): T => xs[prng.nextInt(xs.length)]!;

  const instruments: UniverseInstrumentTuple[] = [];
  const tickers: string[] = [];
  const names: string[] = [];
  const seen = new Set<string>();
  let id = 1;

  // Ticker length distribution: the real US tape is mostly 3-4 characters with a thin tail of one-
  // and two-character symbols, and those short ones are what make a one-character query the worst
  // case for the prefix block.
  const lengthOf = (): number => {
    const u = prng.next();
    if (u < 0.01) return 1;
    if (u < 0.06) return 2;
    if (u < 0.4) return 3;
    if (u < 0.85) return 4;
    return 5;
  };

  for (let i = 0; i < US_LISTED; i += 1) {
    let ticker = '';
    // Duplicate tickers exist in reality (the same symbol on two venues); a bounded retry keeps the
    // corpus dominated by distinct symbols without ever looping unboundedly.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const n = lengthOf();
      let candidate = '';
      for (let k = 0; k < n; k += 1) candidate += ALPHABET[prng.nextInt(ALPHABET.length)]!;
      ticker = candidate;
      if (!seen.has(candidate)) break;
    }
    seen.add(ticker);

    const name = `${pick(WORDS)} ${pick(WORDS)} ${pick(SUFFIXES)}`;
    const assetClass: AssetClass = prng.next() < 0.15 ? 'etf' : 'equity';
    // ≈ 5 % index members at searchWeight 2.0 — the "notable" subset §3.1 trigram-indexes.
    const weight = prng.next() < 0.05 ? 2 : prng.next() < 0.03 ? 0.5 : 1;
    const status = prng.next() < 0.02 ? 0 : 1;

    instruments.push([id, ticker, 'Equity', 'US', name, assetClass, weight, status]);
    tickers.push(ticker);
    names.push(name);
    id += 1;
  }

  for (let i = 0; i < INDICES; i += 1) {
    const name = INDEX_NAMES[i % INDEX_NAMES.length]!;
    const ticker = `${name.replace(/[^A-Za-z0-9]/g, '').slice(0, 5).toUpperCase()}X`;
    instruments.push([id, ticker, 'Index', 'INDEX', name, 'index', 2, 1]);
    id += 1;
  }

  for (let i = 0; i < FX_PAIRS; i += 1) {
    const [code, name] = FX_PAIR_CODES[i % FX_PAIR_CODES.length]!;
    instruments.push([id, code, 'Curncy', 'FX', name, 'fx', 2, 1]);
    id += 1;
  }

  for (let i = 0; i < CRYPTO; i += 1) {
    const [code, name] = CRYPTO_CODES[i % CRYPTO_CODES.length]!;
    instruments.push([id, code, 'Crypto', 'CRYPTO', name, 'crypto', 2, 1]);
    id += 1;
  }

  for (let i = 0; i < GOVT; i += 1) {
    const ticker = i % 2 === 0 ? 'T' : 'B';
    instruments.push([
      id,
      ticker,
      'Govt',
      'GOVT',
      `US Treasury ${String(2 + i)}% 2/15/${String(30 + (i % 20))}`,
      'govt',
      2,
      1,
    ]);
    id += 1;
  }

  for (let i = 0; i < ECON; i += 1) {
    const ticker = `EC${String(i).padStart(3, '0')}`;
    instruments.push([
      id,
      ticker,
      'Index',
      'ECON',
      `${pick(WORDS)} ${pick(['Index', 'Rate', 'Claims', 'Sales', 'Payrolls'])}`,
      'econ',
      1,
      1,
    ]);
    id += 1;
  }

  // The real 38 manifests with their real aliases and tiers: the function half of the ranking is
  // the half the `AAPL US Equity DE` queries exercise, and a synthetic code list would not have
  // the real `assetClasses` that decide applicability.
  const functions: UniverseFunctionTuple[] = registry
    .all()
    .map((m): UniverseFunctionTuple => [m.code, m.name, [...m.aliases], m.tier]);

  const people: UniversePersonTuple[] = Array.from(
    { length: PEOPLE },
    (_, i): UniversePersonTuple => [
      i + 1,
      `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
      `${pick(['CEO', 'CFO', 'COO', 'Chair', 'Analyst'])} · ${pick(WORDS)} ${pick(SUFFIXES)}`,
    ],
  );

  const topics: UniverseTopicTuple[] = TOPIC_CODES.map(([code, name]): UniverseTopicTuple => [
    code,
    name,
  ]);

  return {
    snapshot: {
      version: 'bench-36k',
      generatedAt: '2026-09-24T00:00:00.000Z',
      instruments,
      functions,
      people,
      topics,
    },
    tickers,
    names,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* The 480 keystrokes                                                                               */
/* ---------------------------------------------------------------------------------------------- */

function buildQueries(corpus: Corpus, codes: readonly (readonly [string, readonly string[]])[]): string[] {
  const prng = makePrng('WP-12:autocomplete.bench:queries');
  const queries: string[] = [];

  // 200 ticker prefixes, 1-4 characters, one-character prefixes over-weighted on purpose.
  for (let i = 0; i < 200; i += 1) {
    const ticker = corpus.tickers[prng.nextInt(corpus.tickers.length)]!;
    const u = prng.next();
    const len = u < 0.25 ? 1 : u < 0.5 ? 2 : u < 0.8 ? 3 : 4;
    queries.push(ticker.slice(0, Math.min(len, ticker.length)));
  }

  // 100 name-word prefixes: the word index, including 3-character keys with long postings.
  for (let i = 0; i < 100; i += 1) {
    const words = corpus.names[prng.nextInt(corpus.names.length)]!.split(' ');
    const word = words[prng.nextInt(words.length)]!.toUpperCase();
    const len = 3 + prng.nextInt(Math.max(1, word.length - 2));
    queries.push(word.slice(0, len));
  }

  // 80 `<ticker> US Equity <partial code>` — the expensive shape: the parser resolves the security
  // against the 36 k index first, and only then are the functions scored against it (§3.3 L926).
  for (let i = 0; i < 80; i += 1) {
    const ticker = corpus.tickers[prng.nextInt(corpus.tickers.length)]!;
    const [code] = codes[prng.nextInt(codes.length)]!;
    const cut = 1 + prng.nextInt(code.length);
    queries.push(`${ticker} US Equity ${code.slice(0, cut)}`);
  }

  // 60 bare function codes and aliases.
  for (let i = 0; i < 60; i += 1) {
    const [code, aliases] = codes[prng.nextInt(codes.length)]!;
    const token = aliases.length > 0 && prng.next() < 0.3 ? aliases[0]! : code;
    queries.push(prng.next() < 0.5 ? token : token.slice(0, Math.max(1, token.length - 1)));
  }

  // 40 typos: no prefix hit at all, so the trigram fallback runs (§3.1 L889).
  for (let i = 0; i < 40; i += 1) {
    const word = corpus.names[prng.nextInt(corpus.names.length)]!.split(' ')[0]!.toUpperCase();
    const cut = 1 + prng.nextInt(Math.max(1, word.length - 2));
    queries.push(`${word.slice(0, cut)}${word.slice(cut + 1)}`);
  }

  return queries;
}

/* ---------------------------------------------------------------------------------------------- */
/* Statistics                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/* ---------------------------------------------------------------------------------------------- */
/* The harness: the real command line, the real engine, the real popup                              */
/* ---------------------------------------------------------------------------------------------- */

interface AcState {
  open: boolean;
  rows: Candidate[];
  selected: number;
  span?: readonly [number, number];
}

let ac: AcState = { open: false, rows: [], selected: 0 };
const listeners = new Set<() => void>();
/** React commits of the command-line subtree, counted by a `<Profiler>`. */
let commandLineCommits = 0;
let context: AutocompleteContext;

function notify(): void {
  for (const listener of listeners) listener();
}

/** The popup, in its own component: a keystroke repaints this and nothing else. */
function AutocompleteView(): ReactElement | null {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => {
      listeners.delete(force);
    };
  }, []);
  return createElement(Autocomplete, {
    panelId: 'p1',
    rows: ac.rows,
    selected: ac.selected,
    open: ac.open,
    registry,
    onSelect: () => undefined,
    onExecute: () => undefined,
  });
}

function Harness(): ReactElement {
  const engine = useRef<AutocompleteEngine | null>(null);
  engine.current ??= createAutocompleteEngine({
    context: () => context,
    onRows: (rows, info) => {
      ac = { open: rows.length > 0, rows, selected: 0, span: info.span };
      notify();
    },
  });

  return createElement(
    'div',
    { style: { position: 'relative' } },
    createElement(
      Profiler,
      {
        id: 'cmd',
        onRender: () => {
          commandLineCommits += 1;
        },
      },
      createElement(CommandLine, {
        panelId: 'p1',
        getAc: (): AutocompleteSnapshot => ac,
        onInput: (text: string) => {
          engine.current?.query(text);
        },
      }),
    ),
    createElement(AutocompleteView, null),
  );
}

/**
 * One keystroke, timed.
 *
 * The draft is written straight onto the uncontrolled input and a native `input` event is
 * dispatched at it, exactly as a browser does.
 *
 * `flushSync` is wrapped around the dispatch, and it is load-bearing: **React 19 does not commit a
 * discrete event’s state update inside `dispatchEvent`**. It schedules the sync-lane work and
 * drains it in a microtask — measured here, not assumed: dispatching alone leaves
 * `document.querySelectorAll('[role="option"]')` empty and the rows appear only after
 * `await Promise.resolve()`. In a browser that microtask still runs before the next paint, so the
 * user-visible budget covers it; a bench that stopped its clock at the end of `dispatchEvent`
 * would therefore time the ranking and bill the render to nobody. `flushSync` pulls exactly that
 * commit back inside the measured window, which is why the number below is a keystroke rather than
 * a `rank()` call.
 */
function keystroke(input: HTMLInputElement, text: string): number {
  input.value = text;
  const started = performance.now();
  flushSync(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return performance.now() - started;
}

/* ---------------------------------------------------------------------------------------------- */

describe('TERM-02 budget — ranking + render on the 36 k snapshot (WORKPLAN L1407)', () => {
  let corpus: Corpus;
  let index: UniverseIndex;
  let queries: string[];
  let buildMs = 0;

  beforeAll(() => {
    corpus = buildCorpus();
    const codes = registry.all().map((m) => [m.code, [...m.aliases]] as const);
    queries = buildQueries(corpus, codes);

    // A realistic MRU (25 rows) and watchlist (40 ids): both are read on every scored row, so
    // ranking with empty ones would measure a context the terminal never has.
    const mru: MruRecord[] = [];
    for (let i = 0; i < 25; i += 1) {
      mru.push({ kind: 'instrument', id: String(i * 37 + 1), lastUsed: 1_700_000_000_000 - i * 1_000, count: i * 3 });
    }
    const watchlistIds = new Set<number>();
    for (let i = 0; i < 40; i += 1) watchlistIds.add(i * 101 + 7);

    const started = performance.now();
    index = UniverseIndex.build(corpus.snapshot, { mru });
    buildMs = performance.now() - started;

    const lookupTicker: ParseEnv['lookupTicker'] = (tokens, opts) => index.lookupTicker(tokens, opts);
    const panel: PanelContext = {
      security: {
        instrumentId: 1,
        assetClass: 'equity' as AssetClass,
        marketSector: 'Equity' as MarketSector,
        display: `${corpus.tickers[0]!} US Equity`,
      },
      fn: 'DES',
      params: {},
    };
    context = { index, registry, panel, lookupTicker, ready: true, watchlistIds };
  }, 120_000);

  it('holds the whole keystroke — parse, rank and popup render — inside the budget', () => {
    expect(index.size).toBeGreaterThanOrEqual(US_LISTED);

    const wasActEnvironment = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
    render(createElement(Harness, null));
    const input = document.querySelector<HTMLInputElement>('input.cmd__input');
    expect(input).not.toBeNull();
    const field = input!;

    // ── the mechanism is real ────────────────────────────────────────────────────────────────
    // Before a single millisecond is counted: prove that a native `input` event on this node
    // ranks AND paints, so that what follows measures both halves and not just the first.
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      const probe = corpus.tickers[0]!;
      keystroke(field, probe);
      expect(ac.rows.length).toBeGreaterThan(0);
      // Counted straight off the document, with nothing flushed in between: these nodes exist
      // because React committed them inside `dispatchEvent`.
      const painted = document.querySelectorAll('[role="option"]').length;
      expect(painted).toBe(Math.min(ac.rows.length, 12));

      // ── warmup: three full passes, untimed ─────────────────────────────────────────────────
      for (let pass = 0; pass < WARMUP_PASSES; pass += 1) {
        for (const q of queries) keystroke(field, q);
      }

      // The commit counter is read from here on: every render above was a mount or a warmup.
      commandLineCommits = 0;

      // ── measure: three independent rounds ──────────────────────────────────────────────────
      const roundP95: number[] = [];
      const roundMean: number[] = [];
      const roundMax: number[] = [];
      let worst = { query: '', ms: 0 };

      for (let round = 0; round < ROUNDS; round += 1) {
        const samples: number[] = [];
        let total = 0;
        for (const q of queries) {
          const dt = keystroke(field, q);
          samples.push(dt);
          total += dt;
          if (dt > worst.ms) worst = { query: q, ms: dt };
        }
        samples.sort((a, b) => a - b);
        roundP95.push(percentile(samples, 0.95));
        roundMean.push(total / samples.length);
        roundMax.push(samples[samples.length - 1]!);
      }

      // ── the ranking half on its own, for the split ─────────────────────────────────────────
      const rankSamples: number[] = [];
      for (const q of queries) {
        const started = performance.now();
        rankLocal(q, context);
        rankSamples.push(performance.now() - started);
      }
      rankSamples.sort((a, b) => a - b);

      const p95 = median(roundP95);
      const mean = median(roundMean);
      const rankP95 = percentile(rankSamples, 0.95);

      // A budget nobody can read is a budget nobody keeps: the measurement is printed.
      console.log(
        [
          `[TERM-02] universe ${String(index.size)} entries (${String(US_LISTED)} US-listed), ` +
            `index build ${buildMs.toFixed(1)} ms`,
          `keystrokes ${String(queries.length)} × ${String(ROUNDS)} rounds, each = parse + rank + popup render + commit`,
          `p95 median ${p95.toFixed(3)} ms (rounds ${roundP95.map((x) => x.toFixed(3)).join(' / ')})`,
          `mean ${mean.toFixed(3)} ms · round max ${roundMax.map((x) => x.toFixed(2)).join(' / ')} ms · ` +
            `slowest single keystroke '${worst.query}' ${worst.ms.toFixed(3)} ms`,
          `of which parse+rank p95 ${rankP95.toFixed(3)} ms → render+commit p95 ≈ ${(p95 - rankP95).toFixed(3)} ms`,
          `command-line React commits over ${String(queries.length * ROUNDS)} keystrokes: ${String(commandLineCommits)}`,
        ].join('\n  '),
      );

      // The acceptance row: ranking + render, p95, on the 36 k snapshot.
      expect(p95).toBeLessThanOrEqual(BUDGET_P95_MS);
      for (const round of roundP95) expect(round).toBeLessThanOrEqual(CEILING_P95_MS);

      // The keystroke budget, which is the tighter of the two and the one a controlled input
      // would break (FUNCTIONS §3.5, CLIENT §16 L1179).
      expect(p95).toBeLessThanOrEqual(KEYSTROKE_BUDGET_MS);

      // …and the reason it holds: the command line itself never re-rendered. A `value` prop, a
      // draft in a store the input subscribes to, or a parent that re-renders on every keystroke
      // would each put commits here — and the milliseconds above would show them.
      expect(commandLineCommits).toBe(0);
    } finally {
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
    }
  }, 300_000);
});
