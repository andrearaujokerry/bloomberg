/**
 * packages/web/test/app/App.test.tsx — the composition root (WP-15; CLIENT.md §1 L45-53, §2).
 *
 * **Every assertion in this file was false before `App.tsx` was rewritten, and most of them were
 * false in a way no other test could see.** The Shell, the 38 screens, `LiveGrid`, `ChartCanvas`, the
 * dispatcher and the realtime bridge each had a green suite; what nothing tested was that anything
 * ever handed them to each other. The scaffold `App` logged every command as
 * `NOT IMPLEMENTED (no function registry yet)`, and because no `WidgetRegistry` was ever constructed,
 * every grid on every screen rendered `data-pending="LiveGrid"` and every chart its own placeholder.
 * So the five things below are the five things that were missing:
 *
 *   1. mounting the app renders the real Shell — the scaffold copy is gone;
 *   2. a `grid` node draws a grid: no `data-pending="LiveGrid"` anywhere, `role="grid"` with cells;
 *   3. a chart draws a canvas — on the `custom` path that every chart screen actually uses AND on
 *      the `chart` node path of the registry contract;
 *   4. typing a command and pressing GO runs the function and paints its screen in that panel;
 *   5. one socket for the page, with four panels open and four functions running.
 *
 * **The screens and payloads are real.** The specs come from the shipped `screens/` modules fed the
 * committed goldens under `fixtures/golden/functions/`, because what has to be true is that the root
 * hosts the screens that were written months before anything could draw them — not that it can host
 * a hand-built `ScreenSpec`. The stores are the real stores. The universe index is the real
 * `LocalUniverseIndex` decoding a real snapshot, so `AAPL US Equity GP ` is parsed by the real
 * parser against a real index.
 *
 * **The one keystroke this file used to step around.** The only security-plus-function case here
 * typed `'AAPL US Equity GP {Enter}'` — with a TRAILING SPACE, which closes the autocomplete and so
 * took the raw-text branch of `onGo`. Delete that one character and the test failed with
 * `expected [] to deeply equal [ 'GP' ]`: with the popup open, GO ran the leading autocomplete row's
 * `insertText` alone and the security the user typed was discarded. Two work packages shipped over
 * that space. Both shapes are now separate cases named for the branch they cover, the popup-open one
 * first because it is the keystroke a person makes, and `selected` is asserted as well as `runs`,
 * because "which row is highlighted" is what decides what GO executes.
 *
 * **No network and no wall clock.** The SDK is a fake implementing `AppSdk` (the app's own declared
 * surface), the socket is a fake `LiveClientPort` around the real `QuoteCache`, timers come through
 * the injected `Scheduler`, and frames are `test/setup.tsx`'s manual pump. jsdom does not lay out, so
 * the grid's viewport height and one bounding box are stubbed — every row count and pixel below is
 * measured against those and nothing else.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifests } from '@terminal/core';
import type { Candidate, FieldId, FunctionCode, PayloadOf, UniverseSnapshot } from '@terminal/core';
import { QuoteCache } from '@terminal/sdk';
import type {
  DowngradeEvent,
  InstrumentSummary,
  LiveCloseEvent,
  LiveErrorEvent,
  LiveState,
  Notice,
  PayloadMeta,
  Snap,
  StatusEvent,
  SubscribeOptions,
  Subscription,
  UpdateEvent,
} from '@terminal/sdk';
import type { SessionInfo } from '@terminal/sdk/wire/rest/auth';
import type { Workspace } from '@terminal/sdk/wire/rest/workspaces';
import { act, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App, disposeAppRuntime } from '../../src/App.js';
import type { AppSdk } from '../../src/App.js';
import { LocalUniverseIndex, inlineWorkerPort, nullSnapshotStore } from '../../src/command/localIndex.js';
import { cellRegistry } from '../../src/grid/cellRegistry.js';
import { gpChartSpec } from '../../src/screens/GP/Screen.js';
import type { AnyScreenProps, ScreenRegistry } from '../../src/shell/Panel.js';
import { usePanelsStore } from '../../src/state/panels.js';
import { useSessionStore } from '../../src/state/session.js';
import { useSettingsStore } from '../../src/state/settings.js';
import { useSubscriptionsStore } from '../../src/state/subscriptions.js';
import { useUsageStore } from '../../src/state/usage.js';
import { DEFAULT_LAYOUT, useWorkspaceStore } from '../../src/state/workspace.js';
import type { Scheduler } from '../../src/state/workspace.js';
import { flushFrames } from '../setup.js';

/* ---------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(dirname(dirname(TEST_DIR))));
const GOLDEN_DIR = join(REPO_ROOT, 'fixtures', 'golden', 'functions');

function golden<C extends FunctionCode>(file: string): PayloadOf<C> {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, file), 'utf8')) as PayloadOf<C>;
}

/** The goldens each function in this file answers with. */
const PAYLOAD_FILE: Readonly<Record<string, string>> = {
  WEI: 'WEI.default.json',
  GP: 'GP.equity.json',
  DES: 'DES.equity.json',
  // MSG and FXC are here for one reason: they are the two screens whose central widget the shipped
  // `WidgetRegistry` does NOT serve (`widgets.tsx` — `Composer`), and the placeholder they draw is
  // asserted below so that the TRACEABILITY.md row saying so cannot go stale silently.
  MSG: 'MSG.default.json',
  FXC: 'FXC.default.json',
};

const AAPL_ID = 1000;

const INSTRUMENT: InstrumentSummary = {
  instrumentId: AAPL_ID,
  assetClass: 'equity',
  marketSector: 'Equity',
  display: 'AAPL US Equity',
  name: 'Apple Inc',
  currency: 'USD',
  mdLineIds: [101],
  ticker: 'AAPL',
  exchCode: 'US',
  securityType: 'Common Stock',
  compositeFigi: 'BBG000B9XRY4',
  status: 'active',
  priceDecimals: 2,
};

/** Enough `provenance` rows that a screen citing an index finds one (DATA-10). */
function metaFor(traceId: string): PayloadMeta {
  return {
    traceId,
    resultId: '01J0000000000000000000TEST',
    asOf: { validAt: '2026-09-15T18:41:28.000Z', knownAt: '2026-09-15T18:41:28.000Z' },
    tier: 'delayed',
    staleness: 'live',
    provenance: Array.from({ length: 64 }, (_v, idx) => ({
      idx,
      sourceId: `source.${String(idx)}`,
      provenanceId: 1000 + idx,
      capturedAt: '2026-09-15T18:41:28.000Z',
      sourceTs: '2026-09-15T18:26:26.000Z',
      attribution: `Attribution for source ${String(idx)}`,
    })),
    entitlement: [],
    unavailable: [],
    engines: [],
    page: { index: 0, count: 1, cursor: null },
    servedAt: '2026-09-15T18:41:28.100Z',
  };
}

const SESSION: SessionInfo = {
  sessionId: '11111111-2222-4333-8444-555555555555',
  userId: 7,
  firmId: 1,
  firmName: 'Demo Capital',
  email: 'trader@demo.test',
  displayName: 'Demo Trader',
  desk: 'Equities',
  role: 'trader',
  clientKind: 'web',
  mfaRequired: false,
  mfaVerified: false,
  webauthnEnrolled: false,
  createdAt: '2026-09-15T08:00:00.000Z',
  expiresAt: '2026-09-16T08:00:00.000Z',
  entitlementSummary: { defaultTier: 'delayed', exportAllowed: true, apiAllowed: false },
  quotas: {
    dailyUniqueInstruments: { used: 3, limit: 500, resetsAt: '2026-09-16T00:00:00.000Z' },
    monthlyDataPoints: { used: 10, limit: 1_000_000, resetsAt: '2026-10-01T00:00:00.000Z' },
    concurrentSubscriptions: { used: 1, limit: 200, resetsAt: '2026-09-16T00:00:00.000Z' },
  },
  protocol: 1,
  serverVersion: '0.1.0',
  minClientVersion: '0.0.1',
  dictionaryVersion: 'dict-1',
};

/** One real instrument and the four function codes this file types. */
function snapshot(): UniverseSnapshot {
  return {
    version: 'v-app-test',
    generatedAt: '2026-09-24T12:00:00.000Z',
    instruments: [[AAPL_ID, 'AAPL', 'Equity', 'US', 'Apple Inc', 'equity', 2, 1]],
    functions: [
      ['WEI', 'World equity indices', [], 1],
      ['GP', 'Price graph', [], 1],
      ['DES', 'Security description', [], 1],
      ['MSG', 'Messaging', [], 1],
      ['FXC', 'FX rate calculator', [], 1],
    ],
    people: [],
    topics: [],
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* The fake socket — one per page, and this file counts                                             */
/* ---------------------------------------------------------------------------------------------- */

interface Handlers {
  update: ((e: UpdateEvent) => void)[];
  status: ((e: StatusEvent) => void)[];
  downgrade: ((e: DowngradeEvent) => void)[];
  notice: ((e: Notice) => void)[];
  state: ((s: LiveState) => void)[];
  error: ((e: LiveErrorEvent) => void)[];
  close: ((e: LiveCloseEvent) => void)[];
}

class FakeLive {
  state: LiveState = 'idle';
  sessionId: string | null = 'session-1';
  conflationMs = 250;
  stats = { resyncs: 0 };
  readonly quoteCache = new QuoteCache({ clock: { now: () => this.now } });
  readonly subscriptions = { isShed: (): boolean => false };
  now = 1_700_000_000_000;
  connects = 0;
  closes = 0;
  readonly essential: { subjects: string[]; essential: boolean }[] = [];
  readonly subCalls: { subjects: string[]; fields: FieldId[] | '*' }[] = [];
  readonly handlers: Handlers = {
    update: [],
    status: [],
    downgrade: [],
    notice: [],
    state: [],
    error: [],
    close: [],
  };

  connect(): Promise<void> {
    this.connects += 1;
    this.state = 'open';
    this.emit('state', 'open');
    return Promise.resolve();
  }

  close(): void {
    this.closes += 1;
    this.state = 'closed';
  }

  subscribe(subjects: string[], fields: FieldId[] | '*', _opts?: SubscribeOptions): Subscription {
    this.subCalls.push({ subjects: [...subjects], fields });
    return {
      id: this.subCalls.length,
      subjects,
      fields,
      ack: Promise.resolve({ accepted: [], rejected: [] }),
      on: () => () => undefined,
      unsubscribe: () => undefined,
    };
  }

  setEssential(subjects: string[], essential: boolean): void {
    this.essential.push({ subjects: [...subjects], essential });
  }

  setConflation(ms: number): void {
    this.conflationMs = ms;
  }

  on(event: string, h: (e: never) => void): () => void {
    const list = this.handlers[event as keyof Handlers] as unknown[];
    list.push(h);
    return () => {
      const at = list.indexOf(h);
      if (at >= 0) list.splice(at, 1);
    };
  }

  emit<E extends keyof Handlers>(event: E, payload: Parameters<Handlers[E][number]>[0]): void {
    for (const h of [...this.handlers[event]] as ((e: unknown) => void)[]) h(payload);
  }

  /** A real `snap` through the real cache, emitted as the client would emit it. */
  snap(subject: string, fields: Record<string, number>, seq = 1): void {
    const frame: Snap = {
      t: 'snap',
      s: subject,
      seq,
      tier: 'delayed',
      reason: 'SOURCE_TIER_CAP',
      f: fields,
      ts: { src: this.now, cap: this.now, pub: this.now },
      st: 'live',
      prov: { p: 'cboe.quotes', id: 1 },
      ac: 'equity',
      id: AAPL_ID,
    };
    const result = this.quoteCache.apply(frame);
    const view = this.quoteCache.get(subject);
    if (view === undefined) throw new Error('the cache refused the snapshot');
    this.emit('update', { subject, seq, changed: result.changed, state: view, kind: 'snap' });
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* The fake plant                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/** `TerminalApiError` as the session store reads it: a `status` and a `code` on an `Error`. */
class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${code} (${String(status)})`);
    this.name = 'ApiError';
  }
}

interface RunCall {
  code: string;
  body: unknown;
}

interface Plant {
  sdk: AppSdk;
  live: FakeLive;
  runs: RunCall[];
  csvCalls: string[];
  usageBatches: number;
  /** How many times anything asked the plant for the page's live client. */
  liveAccesses: () => number;
  session: SessionInfo | null;
  /** `null` session → 401, which the session store reads as anonymous, not as broken. */
  authError: { status: number; code: string; message: string } | null;
}

function plant(): Plant {
  const live = new FakeLive();
  const runs: RunCall[] = [];
  const csvCalls: string[] = [];
  let accesses = 0;
  const state: Plant = {
    live,
    runs,
    csvCalls,
    usageBatches: 0,
    liveAccesses: () => accesses,
    session: SESSION,
    authError: null,
    sdk: undefined as unknown as AppSdk,
  };

  const payloadFor = (code: string): unknown => {
    const file = PAYLOAD_FILE[code];
    if (file === undefined) throw new Error(`no golden payload for ${code} in this test`);
    return { data: golden(file), meta: metaFor('33333333-4444-4555-8666-777777777777') };
  };

  const sdk: AppSdk = {
    auth: {
      logout: () => Promise.resolve(undefined),
      session: () => {
        if (state.authError !== null) {
          return Promise.reject(new ApiError(state.authError.status, state.authError.code));
        }
        // What the plant answers a browser with no session cookie; the store reads 401 as anonymous.
        if (state.session === null) return Promise.reject(new ApiError(401, 'AUTH_REQUIRED'));
        return Promise.resolve(state.session);
      },
    },
    fn: {
      run: (args, _init) => {
        runs.push({ code: args.params.code, body: args.body });
        return Promise.resolve(payloadFor(args.params.code));
      },
      page: (args) => Promise.resolve(payloadFor(args.params.code)),
      csv: (args) => {
        csvCalls.push(args.params.code);
        return Promise.resolve('a,b\n1,2\n');
      },
    },
    usage: {
      events: () => {
        state.usageBatches += 1;
        return Promise.resolve();
      },
    },
    workspace: {
      getActive: () =>
        Promise.resolve({
          workspaceId: 1,
          name: 'Default',
          isActive: true,
          version: 1,
          layout: DEFAULT_LAYOUT,
          updatedAt: '2026-09-15T08:00:00.000Z',
        } satisfies Workspace),
      putActive: () => Promise.resolve({ version: 2, updatedAt: '2026-09-15T09:00:00.000Z' }),
    },
    help: {
      get: () => Promise.reject(new Error('help is not exercised here')),
      openTicket: () => Promise.reject(new Error('tickets are not exercised here')),
    },
    search: {
      universeSnapshot: () => Promise.resolve(snapshot()),
      query: () => Promise.resolve({ hits: [], tookMs: 1, traceId: SESSION.sessionId }),
    },
    ref: {
      resolve: () =>
        Promise.resolve({
          meta: {
            traceId: SESSION.sessionId,
            asOf: { validAt: '2026-09-15T18:41:28.000Z', knownAt: '2026-09-15T18:41:28.000Z' },
            servedAt: '2026-09-15T18:41:28.100Z',
          },
          results: [{ ref: { id: AAPL_ID }, instrument: INSTRUMENT, candidates: [], source: 'master' }],
        }),
    },
    get live(): FakeLive {
      accesses += 1;
      return live;
    },
  };

  state.sdk = sdk;
  return state;
}

/* ---------------------------------------------------------------------------------------------- */
/* Harness                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** The workspace autosave's timers, recording instead of scheduling (TESTING §2.2). */
function recordingScheduler(): Scheduler {
  return {
    setTimer: () => 0,
    clearTimer: () => undefined,
    now: () => 0,
  };
}

const VIEWPORT_PX = 600;
const BOX = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 900,
  bottom: 600,
  width: 900,
  height: 600,
  toJSON: () => ({}),
} as DOMRect;

let clientHeightSpy: PropertyDescriptor | undefined;

function stubLayout(): void {
  clientHeightSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return this.classList.contains('grid__viewport') ? VIEWPORT_PX : 0;
    },
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(BOX);
}

function restoreLayout(): void {
  if (clientHeightSpy === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  else Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightSpy);
  clientHeightSpy = undefined;
  vi.restoreAllMocks();
}

function universeFor(sdk: AppSdk): LocalUniverseIndex {
  // The real loader and the real decoder; only the two hosts jsdom lacks are replaced — IndexedDB
  // and `Worker` — with the ports `localIndex.ts` exports for exactly that.
  return new LocalUniverseIndex({
    sdk: { search: sdk.search },
    store: nullSnapshotStore(),
    createWorker: inlineWorkerPort,
  });
}

interface Mounted {
  plant: Plant;
  universe: LocalUniverseIndex;
  /** Let the session gate, the workspace load and the universe decode settle. */
  settle: (frames?: number) => Promise<void>;
  /** Type into a panel's command line and press GO. */
  go: (panelId: string, text: string) => Promise<void>;
}

async function mountApp(
  options: { screens?: ScreenRegistry; mode?: '1' | '2h' | '2v' | '4'; session?: SessionInfo | null } = {},
): Promise<Mounted> {
  const state = plant();
  if (options.session !== undefined) state.session = options.session;
  const universe = universeFor(state.sdk);

  const settle = async (frames = 4): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      flushFrames(frames);
    });
  };

  render(
    <App
      runtime={{
        sdk: state.sdk,
        universe,
        ...(options.screens === undefined ? {} : { screens: options.screens }),
      }}
      scheduler={recordingScheduler()}
    />,
  );
  await settle();
  // The snapshot decode is two microtask hops behind the mount; parsing `AAPL US Equity` needs it.
  await act(async () => {
    await universe.load();
  });
  // AFTER the mount, never before: `Shell` hydrates the workspace on mount and `fromLayout` applies
  // the served layout — `DEFAULT_LAYOUT`, mode '1' — over anything set earlier.
  if (options.mode !== undefined) {
    const mode = options.mode;
    act(() => {
      usePanelsStore.getState().setMode(mode);
    });
    await settle();
  }

  const go = async (panelId: string, text: string): Promise<void> => {
    const input = screen.getByRole('combobox', { name: `Command line ${panelId}` });
    await userEvent.type(input, text);
    await settle();
  };

  return { plant: state, universe, settle, go };
}

/** Type `text` and read the rows the real engine ranked for it, without pressing GO. */
async function rowsFor(app: Mounted, text: string): Promise<readonly Candidate[]> {
  await app.go('p1', text);
  return usePanelsStore.getState().panels.p1?.ac.rows ?? [];
}

beforeEach(() => {
  stubLayout();
  usePanelsStore.getState().reset();
  useSessionStore.getState().reset();
  useSubscriptionsStore.getState().reset();
  useSettingsStore.getState().reset();
  useUsageStore.getState().reset();
  useWorkspaceStore.getState().reset();
  useWorkspaceStore.getState().configure({ scheduler: recordingScheduler() });
});

afterEach(() => {
  // The runtime is a module singleton (one socket per page); every test gets a new one.
  disposeAppRuntime();
  usePanelsStore.getState().reset();
  useUsageStore.getState().reset();
  restoreLayout();
});

/* ---------------------------------------------------------------------------------------------- */
/* 1. The scaffold is gone                                                                          */
/* ---------------------------------------------------------------------------------------------- */

describe('the composition root', () => {
  it('mounts the real Shell, not the WP-01 scaffold', async () => {
    await mountApp();

    expect(screen.getByTestId('shell')).toBeInTheDocument();
    expect(screen.getByTestId('panel-grid')).toBeInTheDocument();
    expect(screen.getByTestId('status-bar')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Command line p1' })).toBeInTheDocument();
    // `data-testid="command-line"` is the handle `packages/e2e/tests/smoke.spec.ts` L20 selects on,
    // and it went missing when the real command line replaced the scaffold's input — which broke the
    // only committed Playwright spec. One per panel, so with the default one-panel layout there is
    // exactly one, which is what that spec's strict locator needs.
    expect(document.querySelectorAll('[data-testid="command-line"]')).toHaveLength(1);

    // Keyboard-first (TERM-01): the caret is in the focused panel's command line on the first ready
    // paint, so `AAPL US Equity DES <GO>` is typeable without touching a pointer. Nothing did this —
    // the app loaded with focus on `<body>`, which for a terminal whose window-level type-anywhere is
    // not attached (TERM-06) meant the first keystroke went nowhere at all.
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Command line p1' }));

    // The three strings the scaffold put on the screen. Each of them was there before this file.
    expect(document.body.textContent).not.toContain('NOT IMPLEMENTED');
    expect(document.body.textContent).not.toContain('SHELL ENTRY POINT');
    expect(document.body.textContent).not.toContain('Scaffold shell');
    expect(screen.queryByTestId('shell-entry-point')).toBeNull();
  });

  it('renders the gate, and no Shell, when the plant says there is no session', async () => {
    await mountApp({ session: null });

    expect(screen.getByTestId('session-gate')).toHaveAttribute('data-gate', 'anonymous');
    expect(screen.queryByTestId('shell')).toBeNull();
    expect(document.body.textContent).toContain('NO SESSION');
    // No login form is invented: there is no such route in this build.
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 2 + 4. A grid node draws a grid, because a command ran                                           */
/* ---------------------------------------------------------------------------------------------- */

describe('a function launched from the command line', () => {
  it('runs WEI and draws its grids — no LiveGrid placeholder anywhere', async () => {
    const app = await mountApp();
    await app.go('p1', 'WEI{Enter}');

    // The command reached the dispatcher and the dispatcher reached the plant.
    expect(app.plant.runs.map((r) => r.code)).toEqual(['WEI']);

    // The panel is showing WEI's own screen, titled by the screen module itself.
    const body = screen.getByTestId('panel-body-p1');
    expect(body.textContent).toContain('WEI');

    // The assertion this whole file exists for: the grid is real.
    expect(document.querySelector('[data-pending="LiveGrid"]')).toBeNull();
    expect(document.querySelectorAll('[data-pending]')).toHaveLength(0);
    const grids = body.querySelectorAll('[role="grid"]');
    expect(grids.length).toBeGreaterThan(0);
    expect(body.querySelectorAll('.grid__cell').length).toBeGreaterThan(0);

    // DATA-10 through the real grid: every drawn cell names its source.
    const cells = [...body.querySelectorAll<HTMLElement>('.grid__cell')];
    expect(cells.every((cell) => cell.dataset.provIdx !== undefined)).toBe(true);
  });

  it('runs GP on a parsed security with the popup OPEN and draws a canvas — the real keystroke', async () => {
    const app = await mountApp();
    // NO TRAILING SPACE, because that is what a user types. `AAPL US Equity GP` leaves the
    // autocomplete open on one row — the FUNCTION `GP`, `insertText: 'GP'` — and that row is what
    // GO used to run: `executeCandidate` executes `candidate.insertText` and nothing else, so the
    // security the user named was discarded and `GP` ran against whatever the panel held (in real
    // Chrome, `AAPL US Equity DES` ran DES against instrument 8566, the WisdomTree ETF whose ticker
    // is DES, instead of AAPL). This assertion is the whole user path, and the version of this test
    // that typed a trailing space could not see any of it.
    await app.go('p1', 'AAPL US Equity GP{Enter}');
    await app.settle(8);

    // The popup WAS open when Enter was pressed, so this is not the raw-text path by accident.
    expect(app.plant.runs.map((r) => r.code)).toEqual(['GP']);
    expect(app.plant.runs[0]?.body).toMatchObject({ security: { id: AAPL_ID } });

    const body = screen.getByTestId('panel-body-p1');
    // `GP` emits `custom/PriceChart`, NOT a `chart` node — so this is the placeholder that was on
    // screen before the registry existed, and the canvas that is there now.
    expect(document.querySelector('[data-pending="PriceChart"]')).toBeNull();
    expect(document.querySelector('[data-pending="ChartCanvas"]')).toBeNull();
    const chartHost = body.querySelector<HTMLElement>('.chart-host');
    expect(chartHost?.dataset.chartState).toBe('drawn');
    expect(body.querySelector('canvas.chart__base')).not.toBeNull();
    expect(body.querySelector('canvas.chart__overlay')).not.toBeNull();

    // The chart's live seam reached the page's ONE socket (`ChartLiveSource`, CLIENT §9): before the
    // composition root existed, `ChartLiveContext` was `null` on every chart in the terminal and a
    // chart drew its payload and never moved. The subject is `q:<equity>` because
    // `GP.equity.json`'s `instrumentId` is a redacted placeholder — a subject `wire/ws.ts` would
    // reject, which WP-14 already reported about the fixture. What is asserted here is the wire, not
    // the subject: the binding the screen built arrived at the socket the page holds.
    expect(app.plant.live.subCalls.map((call) => call.subjects.join(','))).toContain('q:<equity>');
    expect(app.plant.live.subCalls[0]?.fields).toEqual(['PX_LAST']);
  });

  it('runs GP on the same line with the popup CLOSED — the raw-text `executeText` guard', async () => {
    const app = await mountApp();
    // The trailing space closes the autocomplete (`completionOf` returns an empty completion), so
    // GO takes the `selection === null` branch. Kept as its own case because it is a different
    // branch of `onGo`, NOT because the space is an implementation detail: the case above is the one
    // a user produces, and for two work packages this file only had this one.
    await app.go('p1', 'AAPL US Equity GP {Enter}');
    await app.settle(8);

    expect(usePanelsStore.getState().panels.p1?.ac.open).toBe(false);
    expect(app.plant.runs.map((r) => r.code)).toEqual(['GP']);
    expect(app.plant.runs[0]?.body).toMatchObject({ security: { id: AAPL_ID } });
  });

  it('accepts the row the user arrowed onto, into the token it completes', async () => {
    const app = await mountApp();
    await app.go('p1', 'AAPL US Equity D');

    // Nothing is highlighted until the user arrows: that is what makes GO mean "run what I typed".
    expect(usePanelsStore.getState().panels.p1?.ac.rows.map((r) => r.id)).toEqual(['DES']);
    expect(usePanelsStore.getState().panels.p1?.ac.selected).toBe(-1);

    await app.go('p1', '{ArrowDown}');
    expect(usePanelsStore.getState().panels.p1?.ac.selected).toBe(0);

    await app.go('p1', '{Enter}');
    await app.settle(8);

    // An accepted row replaces the COMPLETED TOKEN and leaves the rest of the line standing
    // (`AutocompleteSnapshot.span`): `AAPL US Equity D` + the `DES` row is `AAPL US Equity DES`, not
    // the bare `DES` that would run against an empty panel. Both halves are asserted, because the
    // failure mode of the fix above would be a candidate that is never honoured at all.
    expect(app.plant.runs.map((r) => r.code)).toEqual(['DES']);
    expect(app.plant.runs[0]?.body).toMatchObject({ security: { id: AAPL_ID } });
  });

  it('says a security is needed rather than launching the top suggestion', async () => {
    const app = await mountApp();
    // The leading row for `GP` on an empty panel is not `GP`: it is SECF, with
    // `insertText: 'SECF GP'` — the security finder, offered so the user can accept it with Tab. GO
    // on the typed text must report the parse problem the parser already writes; before the fix it
    // ran the suggestion, so a user who typed GP landed on a DIFFERENT FUNCTION with no message.
    expect((await rowsFor(app, 'GP')).map((r) => r.insertText)).toEqual(['SECF GP', 'GP']);

    await app.go('p1', '{Enter}');
    await app.settle(8);

    expect(app.plant.runs).toHaveLength(0);
    const input = screen.getByRole('combobox', { name: 'Command line p1' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(document.querySelector('.cmd__problem')?.textContent).toContain('NO_SECURITY_LOADED');
  });

  it('draws a `chart` node too — the `WidgetRegistry.ChartCanvas` contract of §10.2', async () => {
    // No shipped screen emits a `chart` node (they all use `custom`), so the node's own path is
    // exercised with one screen that does. Everything else is the real root.
    const spec = gpChartSpec(golden<'GP'>('GP.equity.json'), manifests.GP.params.parse({}));
    const screens: ScreenRegistry = {
      WEI: {
        Screen: () => ({
          title: 'chart node',
          body: { kind: 'chart', id: 'c1', spec },
          footer: { sources: ['test'] },
        }),
      },
    };
    const app = await mountApp({ screens });
    await app.go('p1', 'WEI{Enter}');
    await app.settle(8);

    const body = screen.getByTestId('panel-body-p1');
    expect(document.querySelector('[data-pending="ChartCanvas"]')).toBeNull();
    expect(body.querySelector('canvas.chart__base')).not.toBeNull();
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* What the popup SAYS is selected (TERM-02, CLIENT §4.3)                                           */
/* ---------------------------------------------------------------------------------------------- */

describe('the autocomplete selection', () => {
  it('highlights nothing until the user arrows, and then says so in the DOM and in ARIA', async () => {
    const app = await mountApp();
    const input = screen.getByRole('combobox', { name: 'Command line p1' });

    await app.go('p1', 'GP');
    expect(usePanelsStore.getState().panels.p1?.ac.rows).toHaveLength(2);

    // Open, and NOTHING highlighted: no `aria-activedescendant` (the WAI-ARIA combobox pattern) and
    // no row drawn as chosen. Both used to point at row 0 — which is how a user learned to expect
    // Enter to run the top suggestion, which is the behaviour that ran the wrong function.
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).not.toHaveAttribute('aria-activedescendant');
    expect(document.querySelectorAll('[role="option"][aria-selected="true"]')).toHaveLength(0);

    // ArrowDown adopts the FIRST row.
    await app.go('p1', '{ArrowDown}');
    expect(usePanelsStore.getState().panels.p1?.ac.selected).toBe(0);
    expect(input).toHaveAttribute('aria-activedescendant', 'ac-p1-opt-0');
    const chosen = [...document.querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]')];
    expect(chosen).toHaveLength(1);
    expect(chosen[0]?.id).toBe('ac-p1-opt-0');
  });

  it('ArrowUp from nothing highlighted takes the LAST row, not the last but one', async () => {
    const app = await mountApp();
    // Two rows for `GP`: `SECF GP` then `GP`. Walking backwards out of "nothing" wraps to the end,
    // and `selected - 1` would have given -2, which the modulo turns into `count - 2`.
    await app.go('p1', 'GP');
    await app.go('p1', '{ArrowUp}');

    expect(usePanelsStore.getState().panels.p1?.ac.selected).toBe(1);
    expect(screen.getByRole('combobox', { name: 'Command line p1' })).toHaveAttribute(
      'aria-activedescendant',
      'ac-p1-opt-1',
    );
  });

  it('clicking a row completes the token it covers rather than retyping the line', async () => {
    const app = await mountApp();
    await app.go('p1', 'AAPL US Equity D');
    // The row's accessible name is split by the match highlight (`D` + `ES` around a `<mark>`), so
    // the row is taken by position and its id asserted instead.
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]?.id).toBe('ac-p1-opt-0');
    const option = options[0]!;

    // A mouse is not a shortcut past the span: the row `DES` clicked on `AAPL US Equity D` runs
    // `AAPL US Equity DES`. Running `insertText` alone is what dropped the security on the keyboard
    // path, and the popup's own click handler had the same defect.
    await userEvent.click(option);
    await app.settle(8);

    expect(app.plant.runs.map((r) => r.code)).toEqual(['DES']);
    expect(app.plant.runs[0]?.body).toMatchObject({ security: { id: AAPL_ID } });
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* DATA-10: `ScreenCtx.provenance` opens the panel that exists                                      */
/* ---------------------------------------------------------------------------------------------- */

describe('ScreenCtx.provenance (DATA-10)', () => {
  it('opens the renderer\'s provenance panel when a screen asks for an index', async () => {
    // The provenance panel is BUILT and green — `screen/ScreenRenderer.tsx` renders
    // `role="dialog" aria-label="Provenance"` and answers `Ctrl+I` itself. What did not work was the
    // programmatic seam: `ScreenCtx.provenance(idx)` was delegated up to `PanelActions.provenance`,
    // which is the telemetry NOTIFICATION the renderer fires on its way, so a screen that put a
    // source link on a value got silence. `Panel` now answers it from the renderer's own handle.
    let ctx: AnyScreenProps['ctx'] | null = null;
    const screens: ScreenRegistry = {
      WEI: {
        Screen: (props) => {
          ctx = props.ctx;
          return {
            title: 'prov seam',
            body: { kind: 'text', id: 't1', text: 'a value with a source link' },
            footer: { sources: ['test'] },
          };
        },
      },
    };
    const app = await mountApp({ screens });
    await app.go('p1', 'WEI{Enter}');
    await app.settle(8);

    expect(document.querySelector('[role="dialog"][aria-label="Provenance"]')).toBeNull();

    act(() => {
      // `metaFor` gives index 1 the source `source.1` and provenance id 1001.
      ctx?.provenance(1);
    });

    const panel = document.querySelector('[role="dialog"][aria-label="Provenance"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('source.1');
    expect(panel?.textContent).toContain('1001');
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The one widget the registry does NOT serve — an inverted assertion, on purpose                   */
/* ---------------------------------------------------------------------------------------------- */

describe('the `Composer` custom node (widgets.tsx, docs/TRACEABILITY.md)', () => {
  it('leaves MSG and FXC on the WP-12 placeholder, and says so out loud', async () => {
    // `buildWidgetRegistry` deliberately omits `Composer`: MSG passes a message draft with
    // attachments and a send gate, FXC "a keyboard-driven editor grid", and no component for either
    // exists anywhere in the repo — so the node keeps the placeholder that NAMES what it waits for
    // rather than drawing an empty canvas over a message composer (widgets.tsx header).
    //
    // THIS ASSERTION IS INVERTED AND THAT IS THE POINT. Every other test in this file asserts
    // `[data-pending]` is absent; these two assert it is present, because docs/TRACEABILITY.md
    // records MSG and FXC as partially implemented for exactly this reason. The day someone
    // registers a `Composer`, this test fails and the traceability row gets corrected instead of
    // quietly becoming false.
    const app = await mountApp();

    await app.go('p1', 'MSG{Enter}');
    await app.settle(8);
    expect(app.plant.runs.map((r) => r.code)).toEqual(['MSG']);
    const msgBody = screen.getByTestId('panel-body-p1');
    const msgPending = [...msgBody.querySelectorAll<HTMLElement>('[data-pending]')];
    expect(msgPending.map((el) => el.dataset.pending)).toEqual(['Composer']);

    await app.go('p1', 'FXC{Enter}');
    await app.settle(8);
    expect(app.plant.runs.map((r) => r.code)).toEqual(['MSG', 'FXC']);
    const fxcBody = screen.getByTestId('panel-body-p1');
    const fxcPending = [...fxcBody.querySelectorAll<HTMLElement>('[data-pending]')];
    expect(fxcPending.map((el) => el.dataset.pending)).toEqual(['Composer']);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The shell commands (FUNCTIONS §2.6)                                                              */
/* ---------------------------------------------------------------------------------------------- */

describe('a shell command typed on the command line', () => {
  it('splits the workspace and switches the theme through the stores', async () => {
    const app = await mountApp();

    await app.go('p1', '/layout 4{Enter}');
    expect(document.querySelectorAll('[data-panel]')).toHaveLength(4);
    expect(screen.getByTestId('panel-grid')).toHaveAttribute('data-layout', '4');

    await app.go('p1', '/theme light{Enter}');
    // `Shell` reflects the settings store onto `<html>` (CLIENT §12.3), which is what proves the
    // shell hook reached the store and not just the parser.
    expect(document.documentElement.dataset.theme).toBe('light');

    // A shell line runs no function.
    expect(app.plant.runs).toHaveLength(0);
    // Two commands in one panel, and the second was not appended to the first: §2.5 L783's "clears
    // commandDraft" has to reach the DOM, because the input is uncontrolled.
    expect(usePanelsStore.getState().panels.p1?.history).toEqual(['/layout 4', '/theme light']);
    expect(screen.getByRole('combobox', { name: 'Command line p1' })).toHaveValue('');
  });

  it('splits the workspace with a popup still open — a stale ranking does not swallow the line', async () => {
    const app = await mountApp();

    // A real ranked row, for an earlier draft: `GP` on its own ranks the FUNCTION `GP`.
    await app.go('p1', 'GP');
    const stale = usePanelsStore.getState().panels.p1?.ac.rows[0];
    // NOT `GP`: the leading row for a function that needs a security is SECF, `insertText:
    // 'SECF GP'` — which is the same fact the case above rests on, from the other side.
    expect(stale?.insertText).toBe('SECF GP');

    // Retype the line as a shell command. The autocomplete ranks no shell words, so THIS draft has
    // no rows of its own — which is exactly why the bug was invisible in the case above.
    await app.go('p1', '{Backspace}{Backspace}/layout 4');
    expect(usePanelsStore.getState().panels.p1?.ac.open).toBe(false);

    // Now the previous draft's ranking lands late. `Autocomplete.tsx` ranks behind a debounce and a
    // `sdk.search.query`, so rows describing what was typed a moment ago can still be on screen when
    // the user presses GO on a shell line — and `CommandLine.go()` used to clamp the selection to
    // row 0 and report it as chosen, so `onGo` ran `GP` and `/layout`, `/panel n` and `/clear` were
    // swallowed whenever the popup had rows at all.
    act(() => {
      usePanelsStore.getState().setAc('p1', { rows: stale === undefined ? [] : [stale], selected: -1, open: true });
    });
    expect(usePanelsStore.getState().panels.p1?.ac.open).toBe(true);

    await app.go('p1', '{Enter}');

    expect(document.querySelectorAll('[data-panel]')).toHaveLength(4);
    expect(screen.getByTestId('panel-grid')).toHaveAttribute('data-layout', '4');
    expect(app.plant.runs).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 5. One socket for the page                                                                       */
/* ---------------------------------------------------------------------------------------------- */

describe('the one socket (TERM-04, API.md §6.3 step 1)', () => {
  it('opens exactly one connection with four panels and four functions running', async () => {
    const app = await mountApp({ mode: '4' });
    expect(document.querySelectorAll('[data-panel]')).toHaveLength(4);

    // One page, one live client: the runtime asked for it once, for the one bridge.
    expect(app.plant.liveAccesses()).toBe(1);
    expect(app.plant.live.connects).toBe(1);

    for (const panelId of ['p1', 'p2', 'p3', 'p4']) {
      act(() => {
        usePanelsStore.getState().setFocus(panelId);
      });
      await app.go(panelId, 'WEI{Enter}');
    }

    expect(app.plant.runs.map((r) => r.code)).toEqual(['WEI', 'WEI', 'WEI', 'WEI']);
    expect(document.querySelectorAll('[role="grid"]').length).toBeGreaterThanOrEqual(4);
    // Four screens, four grids, still one socket and one connect.
    expect(app.plant.live.connects).toBe(1);
    expect(app.plant.liveAccesses()).toBe(1);
  });

  it('fans a live frame out to the one cell registry', async () => {
    const app = await mountApp();
    const before = cellRegistry.stats.batches;

    act(() => {
      app.plant.live.snap(`q:${String(AAPL_ID)}`, { PX_LAST: 231.4, PX_BID: 231.3 });
    });

    // The bridge was attached to the real `cellRegistry` by the composition root; without that, a
    // frame off the socket reaches nothing and every live cell on every screen stays as it was.
    expect(cellRegistry.stats.batches).toBe(before + 1);
  });
});

