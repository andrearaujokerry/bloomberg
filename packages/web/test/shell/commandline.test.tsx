// packages/web/test/shell/commandline.test.tsx — WP-12 acceptance row (WORKPLAN L1406):
// "`AAPL US Equity DES` + GO dispatches; a parse problem highlights the right span".
//
// The acceptance row is driven end to end and with nothing faked that matters: the real tokenizer,
// the real parser, the real 38-manifest registry, the real ranker and the real `command/dispatch.ts`
// sit behind these keystrokes. Only the SDK is a stand-in, and it records exactly what would have
// gone over the wire — because "GO dispatches the right action" is a statement about the request,
// not about a callback having fired.
//
// The other files of this task are covered here too (the work package names one test file for
// them): the popup's ranking and its badges, the two overlays, and the CSV export's one real rule —
// that the bytes come from the server.

import {
  UniverseIndex,
  registry,
  rank,
  type Candidate,
  type CommandProblem,
  type MruRank,
  type PanelContext,
  type RankContext,
} from '@terminal/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Profiler, useEffect, useReducer, useRef } from 'react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  executeText,
  type DispatchDeps,
  type DispatchSdk,
  type Frame,
  type FramePatch,
  type PanelsPort,
  type UsageEventInput,
} from '../../src/command/dispatch.js';
import {
  RESULT_TTL_MS,
  exportGrid,
  exportResult,
  type ExportDeps,
  type ExportFrame,
} from '../../src/export/csv.js';
import {
  Autocomplete,
  createAutocompleteEngine,
  mergeServerHits,
  rankLocal,
  type AutocompleteContext,
} from '../../src/shell/Autocomplete.js';
import { CommandLine, historyMatches, type CommandLineHandle } from '../../src/shell/CommandLine.js';
import { HelpOverlay } from '../../src/shell/HelpOverlay.js';
import { TicketDialog, collectScreenState } from '../../src/shell/TicketDialog.js';

/* ---------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

const index = UniverseIndex.build({
  version: 'test',
  generatedAt: '2026-09-24T12:00:00.000Z',
  instruments: [
    [1000, 'AAPL', 'Equity', 'US', 'Apple Inc', 'equity', 2, 1],
    [1001, 'AAP', 'Equity', 'US', 'Advance Auto Parts Inc', 'equity', 1, 1],
    [1002, 'MSFT', 'Equity', 'US', 'Microsoft Corp', 'equity', 1, 1],
    [1003, 'EURUSD', 'Curncy', 'FX', 'Euro / US Dollar', 'fx', 1, 1],
  ],
  functions: registry.all().map((m) => [m.code, m.name, [...m.aliases], m.tier] as const),
  people: [[7, 'Jane Doe', 'CFO · Apple Inc']],
  topics: [['FED', 'Federal Reserve']],
});

const lookupTicker: DispatchDeps['lookupTicker'] = (tokens, opts) =>
  index.lookupTicker(tokens, opts);

const EMPTY_PANEL: PanelContext = { security: null, fn: null, params: {} };

function autocompleteContext(panel: PanelContext = EMPTY_PANEL): AutocompleteContext {
  return { index, registry, panel, lookupTicker, ready: true };
}

/** The `PanelsPort` of `command/dispatch.ts`, over plain objects. */
class FakePanels implements PanelsPort {
  readonly frames: Frame[] = [];
  readonly patches: FramePatch[] = [];
  readonly history: string[] = [];
  draft = '';
  problem: CommandProblem | null = null;

  constructor(private panel: PanelContext = EMPTY_PANEL) {}

  context(panelId: string): PanelContext | undefined {
    return panelId === 'p1' ? this.panel : undefined;
  }
  frame(): Frame | undefined {
    return this.frames[this.frames.length - 1];
  }
  pushFrame(_panelId: string, frame: Frame): void {
    this.frames.push(frame);
  }
  replaceFrame(_panelId: string, patch: FramePatch): void {
    this.patches.push(patch);
  }
  pushHistory(_panelId: string, raw: string): void {
    this.history.push(raw);
  }
  setDraft(_panelId: string, value: string): void {
    this.draft = value;
  }
  setProblem(_panelId: string, problem: CommandProblem | null): void {
    this.problem = problem;
  }
}

interface RunCall {
  code: string;
  body: { security?: unknown; params: Record<string, unknown>; panelId?: string; launchKind: string };
  traceId: string | undefined;
}

function fakeSdk(): { sdk: DispatchSdk; runs: RunCall[] } {
  const runs: RunCall[] = [];
  const sdk: DispatchSdk = {
    fn: {
      run: (args, init) => {
        runs.push({ code: args.params.code, body: args.body as RunCall['body'], traceId: init?.traceId });
        return Promise.resolve({ meta: { resultId: `res-${String(runs.length)}` } });
      },
      page: () => Promise.resolve({ meta: { resultId: 'page-1' } }),
    },
    usage: { events: () => Promise.resolve(undefined) },
  };
  return { sdk, runs };
}

/* ---------------------------------------------------------------------------------------------- */
/* The harness: a command line, a popup, and the real dispatch behind GO                            */
/* ---------------------------------------------------------------------------------------------- */

interface Harness {
  panels: FakePanels;
  runs: RunCall[];
  events: UsageEventInput[];
  pending: Promise<unknown>[];
  ac: { open: boolean; rows: Candidate[]; selected: number; span?: readonly [number, number] };
  notify: () => void;
  handle: { current: CommandLineHandle | null };
  commits: number[];
}

let harness: Harness;

function newHarness(panel: PanelContext = EMPTY_PANEL): Harness {
  const { sdk, runs } = fakeSdk();
  const panels = new FakePanels(panel);
  const events: UsageEventInput[] = [];
  const listeners = new Set<() => void>();
  const state: Harness = {
    panels,
    runs,
    events,
    pending: [],
    ac: { open: false, rows: [], selected: 0 },
    notify: () => {
      for (const listener of listeners) listener();
    },
    handle: { current: null },
    commits: [],
  };
  (state as Harness & { listeners: Set<() => void> }).listeners = listeners;
  (state as Harness & { deps: DispatchDeps }).deps = {
    sdk,
    panels,
    usage: {
      push: (event) => {
        events.push(event);
      },
    },
    registry,
    lookupTicker,
    traceId: () => '11111111-2222-4333-8444-555555555555',
  };
  return state;
}

function depsOf(h: Harness): DispatchDeps {
  return (h as Harness & { deps: DispatchDeps }).deps;
}

function listenersOf(h: Harness): Set<() => void> {
  return (h as Harness & { listeners: Set<() => void> }).listeners;
}

/** The popup, in its own component: a keystroke repaints this and nothing else. */
function AutocompleteView(): ReactElement {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const listeners = listenersOf(harness);
    listeners.add(force);
    return () => {
      listeners.delete(force);
    };
  }, []);
  return (
    <Autocomplete
      panelId="p1"
      rows={harness.ac.rows}
      selected={harness.ac.selected}
      open={harness.ac.open}
      registry={registry}
      onSelect={(i) => {
        harness.ac.selected = i;
        harness.notify();
      }}
      onExecute={(i) => {
        const row = harness.ac.rows[i];
        if (row !== undefined) harness.pending.push(go(row.insertText));
      }}
    />
  );
}

function go(text: string): Promise<unknown> {
  return executeText(depsOf(harness), 'p1', text);
}

interface PanelProps {
  problem?: CommandProblem | null;
  history?: readonly string[];
}

function Panel({ problem = null, history = [] }: PanelProps): ReactElement {
  const ref = useRef<CommandLineHandle | null>(null);
  harness.handle = ref;
  const engine = useRef(
    createAutocompleteEngine({
      context: () => autocompleteContext(harness.panels.context('p1') ?? EMPTY_PANEL),
      onRows: (rows, info) => {
        harness.ac = { open: rows.length > 0, rows, selected: 0, span: info.span };
        harness.notify();
      },
    }),
  );

  return (
    <div style={{ position: 'relative' }}>
      <Profiler
        id="cmd"
        onRender={(_id, _phase, actual) => {
          harness.commits.push(actual);
        }}
      >
        <CommandLine
          ref={ref}
          panelId="p1"
          problem={problem}
          history={history}
          getAc={() => harness.ac}
          onInput={(text) => {
            engine.current.query(text);
          }}
          onMoveSelection={(delta) => {
            const rows = harness.ac.rows.length;
            if (rows === 0) return;
            harness.ac = {
              ...harness.ac,
              selected: (harness.ac.selected + delta + rows) % rows,
            };
            harness.notify();
          }}
          onCloseAutocomplete={() => {
            harness.ac = { ...harness.ac, open: false };
            harness.notify();
          }}
          onGo={(text) => {
            harness.pending.push(go(text));
          }}
        />
      </Profiler>
      <AutocompleteView />
    </div>
  );
}

async function settle(): Promise<void> {
  await Promise.all(harness.pending);
  harness.pending = [];
}

beforeEach(() => {
  harness = newHarness();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ---------------------------------------------------------------------------------------------- */
/* GO — the acceptance row                                                                          */
/* ---------------------------------------------------------------------------------------------- */

describe('GO (WORKPLAN L1406)', () => {
  it('`AAPL US Equity DES` then GO runs DES on the resolved instrument', async () => {
    const user = userEvent.setup();
    render(<Panel />);
    const input = screen.getByRole('combobox');

    await user.click(input);
    await user.keyboard('AAPL US Equity DES');
    expect((input as HTMLInputElement).value).toBe('AAPL US Equity DES');

    await user.keyboard('{Enter}');
    await settle();

    expect(harness.runs).toHaveLength(1);
    const call = harness.runs[0];
    expect(call?.code).toBe('DES');
    // The security is the *resolved instrument id*, not the typed text: REF-01.
    expect(call?.body.security).toEqual({ id: 1000 });
    expect(call?.body.launchKind).toBe('launch');
    expect(call?.traceId).toBe('11111111-2222-4333-8444-555555555555');

    // §2.5 L782-783: one frame pushed, the raw text in the history, the draft cleared.
    expect(harness.panels.frames).toHaveLength(1);
    expect(harness.panels.frames[0]?.fn).toBe('DES');
    expect(harness.panels.history).toEqual(['AAPL US Equity DES']);
    expect(harness.panels.draft).toBe('');
    expect(harness.panels.problem).toBeNull();
    expect(harness.events.map((e) => e.kind)).toContain('fn.launch');
  });

  it('GO executes the highlighted row rather than the raw text (TERM-02)', async () => {
    const user = userEvent.setup();
    render(<Panel />);
    const input = screen.getByRole('combobox');

    await user.click(input);
    await user.keyboard('AAP');

    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    // Row 0 is what GO would run; move to row 1 and GO must run *that*.
    await user.keyboard('{ArrowDown}');
    const chosen = harness.ac.rows[1];
    expect(chosen).toBeDefined();

    await user.keyboard('{Enter}');
    await settle();

    // The row replaces the token it completed — here the whole line, since `AAP` is all there is.
    expect(harness.panels.history).toEqual([chosen?.insertText]);
    expect(harness.runs).toHaveLength(1);
  });

  it('the keys the command line consumes never reach the window dispatcher', async () => {
    const seen: string[] = [];
    const listener = (e: Event): void => {
      seen.push((e as KeyboardEvent).key);
    };
    window.addEventListener('keydown', listener);
    try {
      const user = userEvent.setup();
      render(<Panel />);
      await user.click(screen.getByRole('combobox'));
      await user.keyboard('AAPL US Equity DES');
      await user.keyboard('{Enter}');
      await settle();
      // Every printable key reaches the window (typing-anywhere needs them); Enter must not, or
      // the dispatcher's reserved `go` would run the command a second time.
      expect(seen).toContain('A');
      expect(seen).not.toContain('Enter');
    } finally {
      window.removeEventListener('keydown', listener);
    }
    expect(harness.runs).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Parse problems against their span                                                                */
/* ---------------------------------------------------------------------------------------------- */

describe('a parse problem is shown against its span (WORKPLAN L1406)', () => {
  it('marks the bad argument, not the whole line', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Panel />);
    await user.click(screen.getByRole('combobox'));
    await user.keyboard('AAPL US Equity GP TYPE=zigzag');
    await user.keyboard('{Enter}');
    await settle();

    // Nothing was sent: a command that cannot run is refused, not guessed at (§2.7).
    expect(harness.runs).toHaveLength(0);
    const problem = harness.panels.problem;
    expect(problem?.code).toBe('ARG_PARSE');
    expect(problem?.span).toEqual([18, 29]);

    rerender(<Panel problem={problem} />);

    const mark = document.querySelector('mark.cmd__span');
    expect(mark?.textContent).toBe('TYPE=zigzag');
    expect(screen.getByRole('status').textContent).toContain('TYPE=zigzag');
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('marks an unknown function code', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Panel />);
    await user.click(screen.getByRole('combobox'));
    await user.keyboard('AAPL US Equity ZZZZ');
    await user.keyboard('{Enter}');
    await settle();

    const problem = harness.panels.problem;
    expect(problem?.code).toBe('UNKNOWN_FUNCTION');
    rerender(<Panel problem={problem} />);

    expect(document.querySelector('mark.cmd__span')?.textContent).toBe('ZZZZ');
  });

  it('clears the mark when the problem clears', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Panel />);
    await user.click(screen.getByRole('combobox'));
    await user.keyboard('AAPL US Equity ZZZZ');
    await user.keyboard('{Enter}');
    await settle();
    rerender(<Panel problem={harness.panels.problem} />);
    expect(document.querySelector('mark.cmd__span')).not.toBeNull();

    rerender(<Panel problem={null} />);
    expect(document.querySelector('mark.cmd__span')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The input is uncontrolled                                                                        */
/* ---------------------------------------------------------------------------------------------- */

describe('the input is uncontrolled (CLIENT §4.1, the 16 ms budget)', () => {
  it('a keystroke commits no React render of the command line', async () => {
    const user = userEvent.setup();
    render(<Panel />);
    const input = screen.getByRole('combobox');
    await user.click(input);

    const afterMount = harness.commits.length;
    expect(afterMount).toBe(1);

    let typed = 0;
    for (const ch of 'AAPL US Equity DES') {
      await user.keyboard(ch === ' ' ? '{ }' : ch);
      typed += 1;
    }

    expect((input as HTMLInputElement).value).toHaveLength(typed);
    // The popup below repainted on every one of those keystrokes; the command line did not.
    expect(harness.commits.length).toBe(afterMount);
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });

  it('aria-expanded and aria-activedescendant follow the popup without a render', async () => {
    const user = userEvent.setup();
    render(<Panel />);
    const input = screen.getByRole('combobox');
    await user.click(input);
    expect(input).toHaveAttribute('aria-expanded', 'false');

    await user.keyboard('AAP');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input.getAttribute('aria-activedescendant')).toBe('ac-p1-opt-0');

    await user.keyboard('{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toBe('ac-p1-opt-1');
    expect(harness.commits.length).toBe(1);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The command line's own map (CLIENT §4.1)                                                         */
/* ---------------------------------------------------------------------------------------------- */

describe("the command line's own keys", () => {
  it('Tab completes the selected row and does not execute it', async () => {
    const user = userEvent.setup();
    render(<Panel />);
    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.keyboard('AAP');

    const row0 = harness.ac.rows[0];
    await user.keyboard('{Tab}');

    expect(input.value).toBe(`${row0?.insertText ?? ''} `);
    expect(harness.runs).toHaveLength(0);
    expect(document.activeElement).toBe(input);
  });

  it('ArrowUp recalls history, filtered by what is already typed', async () => {
    const user = userEvent.setup();
    const history = ['MSFT US Equity DES', 'AAPL US Equity GP', 'AAPL US Equity DES'];
    render(<Panel history={history} />);
    const input = screen.getByRole('combobox');
    await user.click(input);

    await user.keyboard('{ArrowUp}');
    expect(input.value).toBe('AAPL US Equity DES');
    await user.keyboard('{ArrowUp}');
    expect(input.value).toBe('AAPL US Equity GP');
    await user.keyboard('{ArrowDown}');
    expect(input.value).toBe('AAPL US Equity DES');

    // With a prefix typed, only the matching entries are walked. The popup owns the arrows while
    // it is open (§4.1), so this is the state after the CANCEL ladder closed it.
    harness.handle.current?.setText('MSFT');
    harness.ac = { ...harness.ac, open: false };
    await user.keyboard('{ArrowUp}');
    expect(input.value).toBe('MSFT US Equity DES');
    await user.keyboard('{ArrowDown}');
    expect(input.value).toBe('MSFT');
  });

  it('historyMatches is most-recent-first, de-duplicated and prefix-filtered', () => {
    const history = ['DES', 'GP', 'DES', 'gp 1y'];
    expect(historyMatches(history, '')).toEqual(['gp 1y', 'DES', 'GP']);
    expect(historyMatches(history, 'g')).toEqual(['gp 1y', 'GP']);
  });

  it('a yellow key inserts its sector token after the typed ticker (FUNCTIONS §2.6)', async () => {
    const user = userEvent.setup();
    render(<Panel />);
    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.keyboard('T 4.25');
    await user.keyboard('{F2}');
    expect(input.value).toBe('T 4.25 Govt ');
  });

  it('the handle gives the dispatcher exactly what typing-anywhere needs', async () => {
    const user = userEvent.setup();
    render(<Panel />);
    const handle = harness.handle.current;
    expect(handle).not.toBeNull();

    handle?.focus({ selectAll: false });
    handle?.type('A');
    handle?.type('A');
    expect(handle?.text()).toBe('AA');
    expect(harness.ac.rows.length).toBeGreaterThan(0);

    handle?.clear();
    expect(handle?.text()).toBe('');
    expect(harness.ac.rows).toHaveLength(0);

    handle?.insertSector('Govt');
    expect(handle?.text()).toBe('Govt ');
    await user.keyboard('{Escape}');
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* Autocomplete (TERM-02, FUNCTIONS §3.3-3.4)                                                       */
/* ---------------------------------------------------------------------------------------------- */

describe('Autocomplete', () => {
  it('renders core rank() order, at most twelve rows, and never its own', () => {
    const ctx = autocompleteContext();
    const result = rankLocal('A', ctx);
    const rankCtx: RankContext = {
      panel: EMPTY_PANEL,
      hasPanelSecurity: false,
      watchlistIds: new Set<number>(),
      mru: new Map<string, MruRank>(index.mru),
    };
    const expected = rank('A', index, rankCtx, registry);

    expect(result.rows.map((r) => `${r.kind}:${r.id}`)).toEqual(
      expected.map((r) => `${r.kind}:${r.id}`),
    );
    expect(result.rows.length).toBeLessThanOrEqual(12);

    render(
      <Autocomplete
        panelId="p1"
        rows={result.rows}
        selected={0}
        open
        registry={registry}
        onSelect={() => undefined}
        onExecute={() => undefined}
      />,
    );
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(result.rows.length);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('completes the token under the caret, not the whole line (FUNCTIONS §3.3 L926)', () => {
    const ctx = autocompleteContext();
    const fn = rankLocal('AAPL US Equity DE', ctx);
    expect(fn.completion.q).toBe('DE');
    expect(fn.completion.span).toEqual([15, 17]);
    // `DE` is not a code the parser can name, but it sits after a resolved security, so it is a
    // function being typed and is ranked as one.
    expect(fn.completion.position).toBe('function');
    expect(fn.rows.some((r) => r.kind === 'function' && r.id === 'DES')).toBe(true);

    const security = rankLocal('AAP', ctx);
    expect(security.completion.position).toBe('security');
    expect(security.rows[0]?.kind).toBe('instrument');

    // A finished token with a space after it completes nothing.
    expect(rankLocal('AAPL US Equity ', ctx).rows).toHaveLength(0);
  });

  it('offers `SECF <text>` when the function needs a security the panel has not got (§2.5)', () => {
    const result = rankLocal('YAS', autocompleteContext());
    expect(result.needsSecurity).toBe(true);
    expect(result.rows[0]?.insertText).toBe('SECF YAS');
  });

  it('badges a function tier, dims an inapplicable row and flags a Yahoo hit', () => {
    const rows: Candidate[] = [
      {
        kind: 'function',
        id: 'DES',
        primary: 'DES',
        secondary: 'Description',
        score: 100,
        matchedOn: 'code',
        matched: [[0, 2]],
        insertText: 'DES',
        source: 'local',
        applicable: false,
      },
      {
        kind: 'instrument',
        id: '9999',
        primary: 'ZZZZ US Equity',
        secondary: 'Zeta Corp',
        score: 30,
        matchedOn: 'name',
        matched: [],
        insertText: 'ZZZZ US Equity',
        source: 'yahoo',
      },
    ];
    render(
      <Autocomplete
        panelId="p1"
        rows={rows}
        selected={0}
        open
        registry={registry}
        notApplicableTo="Curncy"
        onSelect={() => undefined}
        onExecute={() => undefined}
      />,
    );

    const [first, second] = screen.getAllByRole('option');
    expect(first?.textContent).toContain('T1');
    expect(first?.textContent).toContain('not applicable to Curncy');
    expect(first?.getAttribute('data-applicable')).toBe('false');
    expect(first?.querySelector('mark')?.textContent).toBe('DE');
    expect(second?.textContent).toContain('not in master');
  });

  it('falls back to the server only per §3.4, and appends below the local rows', async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const scheduler = {
      setTimer: (fn: () => void, ms: number) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => undefined,
    };
    const served: Candidate[] = [
      {
        kind: 'instrument',
        id: '5555',
        primary: 'ZZQQ US Equity',
        secondary: 'From the server',
        score: 40,
        matchedOn: 'trigram',
        matched: [],
        insertText: 'ZZQQ US Equity',
        source: 'yahoo',
      },
    ];
    const batches: { rows: Candidate[]; source: string }[] = [];
    const search = vi.fn(() => Promise.resolve(served));
    const engine = createAutocompleteEngine({
      context: () => autocompleteContext(),
      search,
      scheduler,
      onRows: (rows, info) => {
        batches.push({ rows, source: info.source });
      },
    });

    // A strong local hit answers on its own: no server call.
    engine.query('AAPL');
    expect(timers).toHaveLength(0);

    // Three characters with nothing strong locally: debounced, then merged below.
    engine.query('ZZQ');
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(60);
    const local = batches[batches.length - 1]?.rows ?? [];
    timers[0]?.fn();
    await waitFor(() => {
      expect(batches[batches.length - 1]?.source).toBe('merged');
    });
    const merged = batches[batches.length - 1]?.rows ?? [];
    expect(merged.slice(0, local.length)).toEqual(local);
    expect(merged[merged.length - 1]?.id).toBe('5555');
  });

  it('mergeServerHits never reorders and never exceeds twelve rows', () => {
    const local: Candidate[] = Array.from({ length: 11 }, (_, i) => ({
      kind: 'instrument',
      id: String(i),
      primary: `L${String(i)}`,
      secondary: '',
      score: 50,
      matchedOn: 'ticker',
      matched: [],
      insertText: `L${String(i)}`,
      source: 'local',
    }));
    const hits: Candidate[] = [
      { ...local[0]!, source: 'yahoo' },
      { ...local[0]!, id: 'new-1', primary: 'S1' },
      { ...local[0]!, id: 'new-2', primary: 'S2' },
    ];
    const merged = mergeServerHits(local, hits);
    expect(merged).toHaveLength(12);
    expect(merged.slice(0, 11)).toEqual(local);
    expect(merged[11]?.id).toBe('new-1');
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* PRINT — the export never serialises locally (FUNC-03)                                            */
/* ---------------------------------------------------------------------------------------------- */

describe('export/csv (FUNC-03)', () => {
  const asOf = { validAt: '2026-09-24T12:00:00.000Z', knownAt: '2026-09-24T12:00:00.000Z' };
  const nowMs = Date.parse(asOf.knownAt) + 1_000;

  function exportDeps(
    csv: (args: { params: { code: string }; query: Record<string, unknown> }, init?: unknown) => Promise<unknown>,
  ): {
    deps: ExportDeps;
    saved: { filename: string; text: string }[];
    footers: string[];
    urls: { routeId: string; args: unknown }[];
  } {
    const saved: { filename: string; text: string }[] = [];
    const footers: string[] = [];
    const urls: { routeId: string; args: unknown }[] = [];
    const deps: ExportDeps = {
      sdk: {
        rest: {
          url: (routeId, args) => {
            urls.push({ routeId, args });
            return `https://terminal.test/api/v1/functions/HP/csv`;
          },
        },
        fn: { csv },
        data: { csv: () => Promise.resolve('a,b\r\n1,2\r\n') },
      },
      footer: (message) => footers.push(message),
      save: (filename, text) => saved.push({ filename, text }),
      now: () => nowMs,
    };
    return { deps, saved, footers, urls };
  }

  const frame: ExportFrame = {
    fn: 'HP',
    params: { range: '1Y' },
    security: { id: 1000, display: 'AAPL US Equity' },
    resultId: 'res-1',
    meta: { resultId: 'res-1', asOf },
  };

  it('saves the bytes the server sent, under the name the server chose', async () => {
    const csv = vi.fn((_args, init?: unknown) => {
      (init as { onResponseHeaders?: (h: Record<string, string>) => void }).onResponseHeaders?.({
        'content-disposition': 'attachment; filename="HP_AAPL_US_Equity_20260924T120000Z.csv"',
        'x-regenerated': 'false',
        'x-trace-id': 'trace-9',
      });
      return Promise.resolve('# Apple\r\nDATE,PX_LAST\r\n2026-09-24,245.1\r\n');
    });
    const { deps, saved } = exportDeps(csv);

    const outcome = await exportResult(deps, frame);

    expect(csv).toHaveBeenCalledWith(
      { params: { code: 'HP' }, query: { resultId: 'res-1' } },
      expect.anything(),
    );
    expect(outcome.kind).toBe('saved');
    expect(saved[0]?.filename).toBe('HP_AAPL_US_Equity_20260924T120000Z.csv');
    // Byte for byte: nothing in the web package reformats a number on its way to a file.
    expect(saved[0]?.text).toBe('# Apple\r\nDATE,PX_LAST\r\n2026-09-24,245.1\r\n');
  });

  it('re-resolves at the payload as-of once the cached result has expired', async () => {
    const csv = vi.fn(() => Promise.resolve('DATE\r\n'));
    const { deps } = exportDeps(csv);
    const stale: ExportFrame = { ...frame, meta: { resultId: 'res-1', asOf } };

    await exportResult({ ...deps, now: () => Date.parse(asOf.knownAt) + RESULT_TTL_MS + 1 }, stale);

    const query = csv.mock.calls[0]?.[0].query as Record<string, string>;
    expect(query.resultId).toBeUndefined();
    expect(query.validAt).toBe(asOf.validAt);
    expect(query.knownAt).toBe(asOf.knownAt);
    expect(query.security).toBe('AAPL US Equity');
    expect(JSON.parse(atob(query.params!.replace(/-/g, '+').replace(/_/g, '/')))).toEqual({
      range: '1Y',
    });
  });

  it('a denied export lands in the footer naming the field and the reason (ENTL-05)', async () => {
    const csv = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error('export denied'), {
          code: 'ENTITLEMENT_DENIED',
          traceId: '3f2a1111-2222-4333-8444-555555555555',
          details: { reasons: [{ fieldId: 'PX_BID', reason: 'LICENCE_FORBIDS_USAGE' }] },
        }),
      ),
    );
    const { deps, footers, saved } = exportDeps(csv);

    const outcome = await exportResult(deps, frame);

    expect(outcome.kind).toBe('failed');
    expect(footers[0]).toBe('EXPORT DENIED: PX_BID LICENCE_FORBIDS_USAGE (trace 3f2a)');
    expect(saved).toHaveLength(0);
  });

  it('PRINT on an empty panel says so instead of sending a request', async () => {
    const csv = vi.fn(() => Promise.resolve(''));
    const { deps, footers } = exportDeps(csv);

    const outcome = await exportResult(deps, {
      fn: null,
      params: {},
      security: null,
      resultId: null,
    });

    expect(outcome).toEqual({ kind: 'nothing', reason: 'NOTHING TO PRINT' });
    expect(csv).not.toHaveBeenCalled();
    expect(footers).toEqual(['NOTHING TO PRINT']);
  });

  it('Ctrl+E posts the instrument × field request and saves the server text', async () => {
    const csv = vi.fn(() => Promise.resolve(''));
    const { deps, saved } = exportDeps(csv);
    const outcome = await exportGrid(deps, {
      securities: [{ id: 1000 }, { id: 1002 }],
      fields: ['PX_LAST', 'CHG_PCT_1D'],
      filename: 'watchlist.csv',
    });
    expect(outcome.kind).toBe('saved');
    expect(saved[0]?.text).toBe('a,b\r\n1,2\r\n');
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* HELP ×1 and HELP ×2 (TERM-09)                                                                    */
/* ---------------------------------------------------------------------------------------------- */

const HELP_PAYLOAD = {
  code: 'HP',
  name: 'Historical Price',
  summary: 'Price history for one security.',
  description: 'Daily, weekly or monthly closes with the adjustment the panel selected.',
  params: [{ name: 'range', text: 'The window to show.', example: '1Y' }],
  keys: [{ key: 'A', action: 'Cycle adjustment' }],
  fields: [
    {
      id: 'PX_LAST',
      label: 'Last',
      definition: 'The last traded price of the session.',
      sourceId: 'yahoo',
      attribution: 'Source: Yahoo Finance',
    },
    {
      id: 'PX_BID',
      label: 'Bid',
      definition: 'Best bid.',
      sourceId: 'yahoo',
      attribution: 'Source: Yahoo Finance',
    },
  ],
  sources: ['Yahoo Finance'],
  related: ['GP', 'DES'],
};

describe('HelpOverlay (HELP ×1)', () => {
  it('explains the screen: params with their current values, fields on screen, and the trace id', () => {
    const onOpened = vi.fn();
    render(
      <HelpOverlay
        panelId="p1"
        help={HELP_PAYLOAD}
        params={{ range: '5Y' }}
        visibleFields={['PX_LAST']}
        traceId="11111111-2222-4333-8444-555555555555"
        onClose={() => undefined}
        onLaunch={() => undefined}
        onTicket={() => undefined}
        onOpened={onOpened}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Help · HP' });
    expect(dialog.textContent).toContain('Price history for one security.');
    // The documented parameter and the value this panel is actually running with.
    expect(dialog.textContent).toContain('The window to show.');
    expect(dialog.textContent).toContain('now: 5Y');
    // Only the fields on screen: PX_BID is in the manifest and not on this screen.
    expect(dialog.textContent).toContain('Last (PX_LAST)');
    expect(dialog.textContent).not.toContain('Bid (PX_BID)');
    expect(dialog.textContent).toContain('Source: Yahoo Finance');
    expect(dialog.textContent).toContain('trace 11111111-2222-4333-8444-555555555555');
    expect(onOpened).toHaveBeenCalledWith('function');
    expect(document.activeElement).toBe(dialog);
  });

  it('Enter on a related code launches it; Escape closes; HELP again asks for a ticket', async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    const onClose = vi.fn();
    const onTicket = vi.fn();
    render(
      <HelpOverlay
        panelId="p1"
        help={HELP_PAYLOAD}
        onClose={onClose}
        onLaunch={onLaunch}
        onTicket={onTicket}
      />,
    );

    const related = screen.getByRole('button', { name: 'GP' });
    related.focus();
    await user.keyboard('{Enter}');
    expect(onLaunch).toHaveBeenCalledWith('GP');

    await user.click(screen.getByRole('button', { name: /open a ticket/i }));
    expect(onTicket).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('TicketDialog (HELP ×2)', () => {
  it('carries the panel, function, params, the visible fields with provIdx and the trace id', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const sdk = {
      help: {
        openTicket: (args: { body: unknown }) => {
          bodies.push(args.body);
          return Promise.resolve({ ticketId: 42, roomId: 7 });
        },
      },
    };
    const onOpened = vi.fn();

    render(
      <TicketDialog
        sdk={sdk}
        draft={{
          panelId: 'p1',
          functionCode: 'HP',
          security: { id: 1000 },
          params: { range: '5Y' },
          screenState: { fields: [{ id: 'PX_LAST', provIdx: 3 }], nodes: ['chart'] },
          traceId: '11111111-2222-4333-8444-555555555555',
          lastError: { code: 'NO_DATA', message: 'no rows for this window' },
        }}
        onClose={() => undefined}
        onOpened={onOpened}
      />,
    );

    const question = screen.getByLabelText('Question');
    await user.click(question);
    await user.keyboard('The chart is empty for 5Y but not for 1Y.');
    await user.click(screen.getByRole('button', { name: /open ticket/i }));

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]).toEqual({
      panelId: 'p1',
      functionCode: 'HP',
      security: { id: 1000 },
      params: { range: '5Y' },
      screenState: {
        fields: [{ id: 'PX_LAST', provIdx: 3 }],
        nodes: ['chart'],
        lastError: { code: 'NO_DATA', message: 'no rows for this window' },
      },
      traceId: '11111111-2222-4333-8444-555555555555',
      question: 'The chart is empty for 5Y but not for 1Y.',
    });

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Ticket 42 opened.');
    });
    expect(screen.getByRole('status').textContent).toContain('MSG room 7');
    expect(onOpened).toHaveBeenCalledWith({ ticketId: 42, roomId: 7 });
  });

  it('a refused ticket says why and stays open', async () => {
    const user = userEvent.setup();
    const sdk = {
      help: {
        openTicket: () =>
          Promise.reject(Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED' })),
      },
    };
    render(
      <TicketDialog
        sdk={sdk}
        draft={{ panelId: 'p1', screenState: { fields: [], nodes: [] } }}
        onClose={() => undefined}
      />,
    );
    await user.click(screen.getByLabelText('Question'));
    await user.keyboard('why');
    await user.click(screen.getByRole('button', { name: /open ticket/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('RATE_LIMITED: rate limited');
    });
    expect(screen.getByLabelText('Question')).toBeInTheDocument();
  });

  it('collectScreenState harvests the provenance indexes the renderer published', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div data-node-id="quote">
        <div data-prov-idx="0"><span data-field="PX_LAST">245.10</span></div>
        <div data-prov-idx="-1"><span data-field="PX_BID">—</span></div>
        <div data-prov-idx="2">Coupon</div>
      </div>`;
    document.body.appendChild(root);
    try {
      const state = collectScreenState(root);
      expect(state.nodes).toEqual(['quote']);
      expect(state.fields).toEqual([
        { id: 'PX_LAST', provIdx: 0 },
        // A pending value keeps its -1: "we do not know where this came from yet" is a fact the
        // desk needs, not a row to drop.
        { id: 'PX_BID', provIdx: -1 },
        { id: 'Coupon', provIdx: 2 },
      ]);
    } finally {
      root.remove();
    }
  });
});
