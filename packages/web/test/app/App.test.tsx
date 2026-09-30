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
import type { HelpResponse } from '@terminal/sdk/wire/rest/functions';
import { WorkspaceLayout as WorkspaceLayoutSchema } from '@terminal/sdk/wire/rest/workspaces';
import type { Workspace, WorkspaceLayout } from '@terminal/sdk/wire/rest/workspaces';
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
import { buildWidgetRegistry } from '../../src/widgets.js';
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
/**
 * `SPX Index` is deliberately NOT in this file's universe snapshot, and that is the point.
 *
 * The local index is keyed on tickers, and the seeded 41k-instrument snapshot does not answer the
 * display `SPX Index` either — which is exactly how the TERM-05 defect was measured in Chrome: the
 * restore rebuilt `"SPX Index GP"`, the parser had no instrument id for it, and the frame that
 * replaced the restored one anchored no security at all. So this id exists only in the master
 * (`ref.resolve` below), as it does on the real plant.
 */
const SPX_ID = 9001;

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

const SPX: InstrumentSummary = {
  instrumentId: SPX_ID,
  assetClass: 'index',
  marketSector: 'Index',
  display: 'SPX Index',
  name: 'S&P 500',
  currency: 'USD',
  mdLineIds: [201],
  ticker: 'SPX',
  exchCode: 'INDEX',
  securityType: 'Equity Index',
  compositeFigi: null,
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
  /** What `GET /workspace` answers — `DEFAULT_LAYOUT` (no frames) unless a test serves its own. */
  layout: WorkspaceLayout;
  /** Every layout the autosave PUT back, in order: what the NEXT load of this terminal would read. */
  saved: WorkspaceLayout[];
  /** Every `POST /help/tickets` body, and what the plant answered (TERM-09). */
  tickets: { body: unknown }[];
  ticketCreated: { ticketId: number; roomId: number };
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
    layout: DEFAULT_LAYOUT,
    saved: [],
    tickets: [],
    // What the seeded plant answers `POST /help/tickets` with: `201 {ticketId, roomId}` (API.md
    // §5.12). The ids are the shape, not a guess — `packages/e2e/tests/help.spec.ts` reads the real
    // ones off the wire.
    ticketCreated: { ticketId: 12, roomId: 34 },
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
          layout: state.layout,
          updatedAt: '2026-09-15T08:00:00.000Z',
        } satisfies Workspace),
      putActive: (args) => {
        // Recorded, because "the desk comes back" is a claim about what was SAVED and not only
        // about what is on screen after one load (TERM-05).
        state.saved.push(args.body.layout);
        return Promise.resolve({ version: 2, updatedAt: '2026-09-15T09:00:00.000Z' });
      },
    },
    help: {
      // A `HelpResponse` for whatever code is asked about (API.md §5.3): enough for `HelpOverlay` to
      // paint, which is all the ticket path needs from it.
      get: (args) =>
        Promise.resolve({
          code: args.params.code,
          name: `${args.params.code} — a function`,
          summary: `What ${args.params.code} is for.`,
          description: 'The long form.',
          params: [{ name: 'range', type: 'string', required: false, description: 'the window' }],
          keys: [{ key: 'Ctrl+I', action: 'provenance', description: 'where a number came from' }],
          fields: [],
          sources: ['cboe.delayed'],
          related: [],
        } as unknown as HelpResponse),
      openTicket: (args) => {
        state.tickets.push({ body: args.body });
        return Promise.resolve(state.ticketCreated);
      },
    },
    search: {
      universeSnapshot: () => Promise.resolve(snapshot()),
      query: () => Promise.resolve({ hits: [], tookMs: 1, traceId: SESSION.sessionId }),
    },
    ref: {
      // The master, which is the one place `SPX Index` resolves: the local universe index does not
      // answer a display (see `SPX_ID`), and `App.tsx#resolveInstrument` asks this route for the
      // instrument behind the frame's security AFTER the screen has painted.
      resolve: (args) => {
        const asked = args.query.ref;
        const instrument = asked === SPX.display ? SPX : INSTRUMENT;
        return Promise.resolve({
          meta: {
            traceId: SESSION.sessionId,
            asOf: { validAt: '2026-09-15T18:41:28.000Z', knownAt: '2026-09-15T18:41:28.000Z' },
            servedAt: '2026-09-15T18:41:28.100Z',
          },
          results: [
            {
              ref: { id: instrument.instrumentId },
              instrument,
              candidates: [],
              source: 'master' as const,
            },
          ],
        });
      },
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
  options: {
    screens?: ScreenRegistry;
    mode?: '1' | '2h' | '2v' | '4';
    session?: SessionInfo | null;
    /** What `GET /workspace` serves, for the restore path; `DEFAULT_LAYOUT` has no frames in it. */
    layout?: WorkspaceLayout;
  } = {},
): Promise<Mounted> {
  const state = plant();
  if (options.session !== undefined) state.session = options.session;
  if (options.layout !== undefined) state.layout = options.layout;
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
/* The two `custom` components the registry used to leave unserved                                  */
/* ---------------------------------------------------------------------------------------------- */

describe('the `Composer` custom node (widgets.tsx, docs/TRACEABILITY.md)', () => {
  it('draws MSG a real composer, and still refuses to draw one over FXC’s matrix', async () => {
    // THIS TEST USED TO BE INVERTED: it asserted `data-pending="Composer"` on both screens, because
    // `buildWidgetRegistry` registered nothing for the name and the placeholder was the honest state.
    // MSG's half is now a component (`screen/widgets/Composer.tsx`) and its behaviour is pinned in
    // `test/screen/composer.test.tsx`; what belongs HERE is the composed application — that the node
    // MSG emits is served by the registry `App.tsx` actually builds.
    //
    // FXC's half stays a refusal, and that is the point of keeping the two in one test. The screens
    // address one component name with two unrelated prop shapes — a message draft, and a 9 × 9
    // currency matrix of `ValueCell`s — so a component that drew a message box wherever it saw the
    // name would put a textarea over a rate grid. The traceability row for FXC therefore still says
    // "partial", and the day somebody writes the matrix, this test fails and the row gets corrected
    // instead of quietly becoming false.
    const app = await mountApp();

    await app.go('p1', 'MSG{Enter}');
    await app.settle(8);
    expect(app.plant.runs.map((r) => r.code)).toEqual(['MSG']);
    const msgBody = screen.getByTestId('panel-body-p1');
    expect([...msgBody.querySelectorAll<HTMLElement>('[data-pending]')].map((el) => el.dataset.pending)).toEqual([]);
    const composer = msgBody.querySelector<HTMLTextAreaElement>('textarea.composer__body');
    expect(composer, 'MSG has no composer').not.toBeNull();
    // The policy strip's own disclaimer, and the gate, come off the payload — not from the component.
    expect(msgBody.querySelector<HTMLElement>('.composer')?.dataset.composerState).toBe('ready');

    // It is typeable in the composed shell, which is the property the window dispatcher's
    // type-anywhere routing has to respect (`focus.ts#capturesTypedText` names `Composer`).
    if (composer === null) throw new Error('unreachable');
    await act(async () => {
      composer.focus();
      await userEvent.type(composer, 'morning');
    });
    expect(composer.value).toBe('morning');

    await app.go('p1', 'FXC{Enter}');
    await app.settle(8);
    expect(app.plant.runs.map((r) => r.code)).toEqual(['MSG', 'FXC']);
    const fxcBody = screen.getByTestId('panel-body-p1');
    expect(fxcBody.querySelector('textarea.composer__body'), 'a message box was drawn over the FX matrix').toBeNull();
    expect(fxcBody.querySelector<HTMLElement>('.composer--matrix')?.dataset.composerState).toBe(
      'matrix-not-implemented',
    );
  });

  it('draws DES’s rate sparkline instead of a placeholder, and prints no number on it', () => {
    // The other half of the same gap (CHRT-01). `DES.equity.json` is the golden this file already
    // serves DES with; the `rate` variant is the one that emits the node, and the component's own
    // behaviour is pinned in `test/screen/sparkline.test.tsx`. What is asserted here is the registry:
    // a `custom#Sparkline` reaching the composed app finds a component.
    expect(buildWidgetRegistry().custom?.Sparkline).not.toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* TERM-09: the terminal says which ticket it opened                                                */
/* ---------------------------------------------------------------------------------------------- */

describe('a support ticket (TERM-09)', () => {
  it('keeps the confirmation on screen after GO, naming the ticket and its room', async () => {
    // The gap this closes was a one-line callback: `App.tsx#PanelOverlay` passed
    // `onOpened={() => { onClose(); }}`, and `TicketDialog#submit` calls `onOpened(result)` in the
    // same tick it sets `sent` — so the dialog unmounted before its confirmation could paint. The
    // ticket was created, `201 {ticketId, roomId}` came back, and the user was told nothing at all.
    //
    // Driven through the composed app rather than the dialog alone, because the dialog's `sent` branch
    // was never in doubt: what was broken is this composition, and only a test that opens the overlay
    // the way a user does can see it.
    const app = await mountApp();
    await app.go('p1', 'WEI{Enter}');
    await app.settle(8);

    // HELP once explains, twice opens the ticket — `dispatcher.ts#nextHelpEffect`, the same
    // transition `F1` drives.
    await app.go('p1', 'HELP{Enter}');
    await app.settle(4);
    expect(document.querySelector('.help[role="dialog"]'), 'the first HELP did not explain').not.toBeNull();

    await app.go('p1', 'HELP{Enter}');
    await app.settle(4);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Open a helpdesk ticket"]');
    expect(dialog, 'the second HELP did not open a ticket').not.toBeNull();

    const question = document.querySelector<HTMLTextAreaElement>('#ticket-question-p1');
    if (question === null) throw new Error('the ticket has no question field');
    await act(async () => {
      await userEvent.type(question, 'Why is the 1-week return blank for INDU?');
    });
    const submit = document.querySelector<HTMLButtonElement>('.ticket__submit');
    if (submit === null) throw new Error('the ticket has no submit button');
    await act(async () => {
      submit.click();
      await Promise.resolve();
    });
    await app.settle(2);

    // It was posted...
    expect(app.plant.tickets).toHaveLength(1);
    // ...and the user can see WHICH ticket, and where the answer will arrive.
    const confirmation = document.querySelector<HTMLElement>('[data-testid="ticket-opened"]');
    expect(confirmation, 'the ticket was opened and the user was not told').not.toBeNull();
    expect(confirmation?.getAttribute('role')).toBe('status');
    expect(confirmation?.textContent).toContain(`Ticket ${String(app.plant.ticketCreated.ticketId)} opened`);
    expect(confirmation?.textContent).toContain(`MSG ROOM=${String(app.plant.ticketCreated.roomId)}`);

    // And it is the USER who dismisses it — the defect was a confirmation closed for them.
    expect(document.querySelector('[role="dialog"][aria-label="Open a helpdesk ticket"]')).not.toBeNull();
    const close = document.querySelector<HTMLButtonElement>('.ticket__close');
    if (close === null) throw new Error('the confirmation has no close button');
    await act(async () => {
      close.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"][aria-label="Open a helpdesk ticket"]')).toBeNull();
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


describe('the window key dispatcher is attached (TERM-06, TERM-07)', () => {
  /**
   * `keyboard/dispatcher.ts` was complete and tested for fifteen packages and never attached, so
   * `F1`, `PRINT`, `PAGE FWD/BACK`, the panel chords and type-anywhere did nothing at all. Each test
   * here presses a key that was dead and asserts the effect, on the composed application.
   *
   * They are written against `window` rather than an element on purpose: that is the listener under
   * test. A key dispatched at a focused widget would prove the widget's own handler instead, which
   * was never the broken half.
   */
  function press(init: KeyboardEventInit): void {
    act(() => {
      globalThis.window.dispatchEvent(
        new globalThis.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
      );
    });
  }

  it('types anywhere into the focused panel’s command line (TERM-06)', async () => {
    const app = await mountApp();
    // Focus is deliberately taken OFF the command line: type-anywhere is the case where the user is
    // not in the input and starts typing regardless, which is the whole of TERM-06. `blur()` rather
    // than focusing something else, because the shell chrome is not focusable and a `.focus()` that
    // does nothing would leave the caret in the input and test the input instead.
    act(() => {
      const active = globalThis.document.activeElement;
      if (active instanceof globalThis.HTMLElement) active.blur();
    });
    expect(globalThis.document.activeElement).toBe(globalThis.document.body);

    press({ key: 'A' });
    await app.settle();

    // The contract is exactly this: the key lands in the command line AND focus moves there, so the
    // user carries on typing normally. Only the FIRST key routes — after it, the input has focus and
    // the browser types into it natively, which is why the rest of this test uses `userEvent` rather
    // than more synthetic window events (those would prove nothing about a focused input).
    const input = screen.getByRole('combobox', { name: 'Command line p1' });
    expect(input).toHaveValue('A');
    expect(globalThis.document.activeElement).toBe(input);

    await userEvent.type(input, 'PL');
    await app.settle();
    expect(input).toHaveValue('APL');
  });

  it('switches panels with the panel chord, and the store agrees (TERM-04)', async () => {
    const app = await mountApp({ mode: '4' });
    expect(usePanelsStore.getState().focus).toBe('p1');

    press({ key: '3', altKey: true });
    await app.settle();
    expect(usePanelsStore.getState().focus).toBe('p3');

    press({ key: '1', altKey: true });
    await app.settle();
    expect(usePanelsStore.getState().focus).toBe('p1');
  });

  it('walks the frame stack from the window (MENU / back)', async () => {
    const app = await mountApp();
    await app.go('p1', 'WEI{Enter}');
    await app.go('p1', 'TOP{Enter}');
    const before = usePanelsStore.getState().panels.p1;
    expect(before?.frameStack).toHaveLength(2);
    expect(before?.index).toBe(1);

    press({ key: 'Escape' });
    await app.settle();
    // The CANCEL ladder's last rung with nothing else pending is the frame stack.
    expect(usePanelsStore.getState().panels.p1?.index).toBe(0);
  });

  it('PRINT exports the focused panel, which had no key at all before (FUNC-03)', async () => {
    const app = await mountApp();
    await app.go('p1', 'WEI{Enter}');
    const before = app.plant.csvCalls.length;

    press({ key: 'p', ctrlKey: true });
    await app.settle();

    expect(app.plant.csvCalls.length).toBe(before + 1);
    expect(app.plant.csvCalls.at(-1)).toContain('WEI');
  });

  it('leaves a key the focused element already consumed alone', async () => {
    // The rule that makes attaching the listener safe: a widget that handles a key calls
    // `preventDefault`, and the listener returns on `defaultPrevented`. Without it, `Enter` on a grid
    // row would run the row's command AND the command line's GO.
    const app = await mountApp();
    await app.go('p1', 'WEI{Enter}');
    const consumed = new globalThis.KeyboardEvent('keydown', {
      key: 'p',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    consumed.preventDefault();
    const csvBefore = app.plant.csvCalls.length;
    act(() => {
      globalThis.window.dispatchEvent(consumed);
    });
    await app.settle();
    expect(app.plant.csvCalls.length).toBe(csvBefore);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* 6. The workspace a SECOND load restores (TERM-05)                                                */
/* ---------------------------------------------------------------------------------------------- */

describe('the workspace restore (TERM-05)', () => {
  /**
   * A saved desk, with the two fields the old restore path could not carry.
   *
   * `p1` is a chart on `SPX Index`, whose display the local universe index cannot resolve — so the
   * command string `"SPX Index GP"` re-parsed to a REF, and the frame that was pushed in place of
   * the restored one anchored NO security. `p2` is the same function on a security the index CAN
   * resolve, carrying `range: '5Y'` where GP's manifest default is `1Y`: that one loses its params
   * whatever the security does. Both were persisted as they stand here, which is why the loss only
   * became visible on the load after the one that caused it.
   *
   * Parsed through the wire schema rather than hand-built, so a layout this fixture gets wrong is a
   * failure here and not a 500 on the plant.
   */
  const SAVED_LAYOUT: WorkspaceLayout = WorkspaceLayoutSchema.parse({
    schema: 1,
    mode: '2h',
    focus: 'p1',
    panels: [
      {
        id: 'p1',
        index: 0,
        history: ['SPX Index GP'],
        commandDraft: '',
        frameStack: [
          {
            security: { id: SPX_ID, display: 'SPX Index' },
            fn: 'GP',
            params: { range: '1Y' },
            resultId: '01J0000000000000000SAVED1',
            scroll: 0,
          },
        ],
      },
      {
        id: 'p2',
        index: 0,
        history: ['AAPL US Equity GP RANGE=5Y'],
        commandDraft: 'MSF',
        frameStack: [
          {
            security: { id: AAPL_ID, display: 'AAPL US Equity' },
            fn: 'GP',
            params: { range: '5Y', periodicity: 'W' },
            resultId: '01J0000000000000000SAVED2',
            scroll: 0,
          },
        ],
      },
    ],
  });

  /** `FunctionRunRequest` as the plant received it — `RunCall.body` is `unknown` by design. */
  interface RunBody {
    panelId?: string;
    security?: unknown;
    params?: Record<string, unknown>;
    launchKind?: string;
  }

  /** The run body for one panel, which is how a run is attributed when four are in flight. */
  function runFor(app: Mounted, panelId: string): RunBody {
    const body = app.plant.runs
      .map((call) => call.body as RunBody)
      .find((call) => call.panelId === panelId);
    expect(body, `nothing was run for ${panelId}`).toBeDefined();
    return body ?? {};
  }

  function frameOf(panelId: string): ReturnType<typeof usePanelsStore.getState>['panels'][string] {
    const panel = usePanelsStore.getState().panels[panelId];
    expect(panel, `no panel ${panelId}`).toBeDefined();
    return panel!;
  }

  it('re-runs each restored frame FROM THE FRAME: its security, its params, as a refresh', async () => {
    const app = await mountApp({ layout: SAVED_LAYOUT });
    await app.settle(8);

    // Both panels ran their own function, on their own security, with their own parameters. The
    // string `"<security> <fn>"` this path used to build carried neither the id nor the params:
    // `SPX Index` has no local ticker entry, so its run went out with `{ ref: 'SPX Index' }`, and
    // `range` was never in the string at all — `5Y` would have come back as the manifest's `1Y`.
    expect(app.plant.runs.map((r) => r.code)).toEqual(['GP', 'GP']);
    expect(runFor(app, 'p1').security).toEqual({ id: SPX_ID });
    expect(runFor(app, 'p2').security).toEqual({ id: AAPL_ID });
    expect(runFor(app, 'p2').params).toEqual({ range: '5Y', periodicity: 'W' });
    // The plant's usage row has to be able to tell a restore from something a human typed.
    expect(runFor(app, 'p1').launchKind).toBe('refresh');
  });

  it('leaves the frame it restored intact — the layout the NEXT load reads is the one that was saved', async () => {
    const app = await mountApp({ layout: SAVED_LAYOUT });
    await app.settle(8);

    // In the store: one frame per panel, still carrying its security and its params. The old path
    // PUSHED a frame, so the stack grew by one on every load and the frame on screen was a new one
    // built from re-parsed text.
    for (const panelId of ['p1', 'p2']) {
      expect(frameOf(panelId).frameStack, `${panelId} frame stack`).toHaveLength(1);
      expect(frameOf(panelId).index).toBe(0);
    }
    expect(frameOf('p1').frameStack[0]?.security).toEqual({ id: SPX_ID, display: 'SPX Index' });
    expect(frameOf('p2').frameStack[0]?.params).toEqual({ range: '5Y', periodicity: 'W' });

    // And on the wire. `flush()` is what `Shell.tsx` calls on `pagehide`, so this is the layout the
    // browser would leave behind — and the layout the second load of the terminal would restore.
    await act(async () => {
      await useWorkspaceStore.getState().flush();
    });
    const saved = app.plant.saved.at(-1);
    expect(saved, 'the workspace was never saved').toBeDefined();
    const savedPanel = (id: string): unknown =>
      saved?.panels.find((p) => p.id === id)?.frameStack[0];
    expect(savedPanel('p1')).toMatchObject({
      security: { id: SPX_ID, display: 'SPX Index' },
      fn: 'GP',
    });
    expect(savedPanel('p2')).toMatchObject({ params: { range: '5Y', periodicity: 'W' } });
    // The history ring and the draft are persisted state too, and a restore is not something the
    // user typed: the old path appended `"AAPL US Equity GP"` to the ring on every load and cleared
    // the draft that had been saved with the desk.
    expect(saved?.panels.find((p) => p.id === 'p2')?.history).toEqual([
      'AAPL US Equity GP RANGE=5Y',
    ]);
    expect(saved?.panels.find((p) => p.id === 'p2')?.commandDraft).toBe('MSF');
  });

  it('draws the restored screen with the parameters it was saved with', async () => {
    const app = await mountApp({ layout: SAVED_LAYOUT });
    await app.settle(8);

    // `GP/Screen.tsx` L249 builds its subtitle from `params.range`, so this is the restored `5Y`
    // reaching the screen and not merely the store: the panel the user comes back to is the one they
    // left. GP's manifest default is `1Y`, which is what the command line `"AAPL US Equity GP"` used
    // to restore it on.
    const subtitle = screen.getByTestId('panel-body-p2').querySelector('.screen__subtitle');
    expect(subtitle?.textContent).toMatch(/^5Y · /);
    // The security is anchored on the frame, so `resolveInstrument` had something to ask about and
    // the panel knows which instrument it is showing (TERM-03's context rules read this).
    expect(frameOf('p1').frameStack[0]?.instrument?.display).toBe('SPX Index');
    expect(frameOf('p2').frameStack[0]?.instrument?.display).toBe('AAPL US Equity');
  });

  it('is not re-run by an unrelated piece of UI state — opening HELP keeps the screen (TERM-09)', async () => {
    // `Shell.tsx` restores the workspace in an effect keyed on `onRestored`. While that callback
    // closed over `dispatchDeps` — a `useMemo` over `onHelp`, which closes over the open overlay —
    // opening HELP gave it a new identity, re-loaded the workspace and re-ran all four panels, so
    // the screen the user asked about was discarded and TERM-09's ticket captured the restored one.
    const app = await mountApp({ layout: SAVED_LAYOUT });
    await app.settle(8);
    const runsAfterRestore = app.plant.runs.length;

    // A screen the user launched themselves, over the restored one.
    await app.go('p1', 'AAPL US Equity DES {Enter}');
    await app.settle(8);
    expect(frameOf('p1').frameStack.at(-1)?.fn).toBe('DES');
    const runsAfterLaunch = app.plant.runs.length;

    await app.go('p1', 'HELP{Enter}');
    await app.settle(8);

    // The overlay is up, and nothing was restored behind it: no further runs, and the panel is still
    // on the frame the user launched.
    expect(app.plant.runs.length, 'the workspace was re-restored').toBe(runsAfterLaunch);
    expect(runsAfterLaunch).toBeGreaterThan(runsAfterRestore);
    expect(frameOf('p1').frameStack.at(-1)?.fn).toBe('DES');
    expect(frameOf('p1').frameStack).toHaveLength(2);
  });
});
