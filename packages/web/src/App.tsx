// packages/web/src/App.tsx — THE COMPOSITION ROOT (CLIENT.md §1 L45-53, §2 L172-210).
//
// Everything this file renders was written, tested and unreachable. The Shell, the four panels, the
// command line, the autocomplete, the thirty-eight screens, `LiveGrid`, `ChartCanvas`, the command
// dispatcher and the one-socket realtime bridge all exist with their own test suites; what did not
// exist was the single place where they are handed to each other. WP-01 left a scaffold here that
// echoed every command as `NOT IMPLEMENTED (no function registry yet)` and WORKPLAN L1723 assigned
// the replacement to a package that never claimed it. This is that replacement. It composes; it does
// not redesign. Every dependency below is a prop, a port or a store that its owner already declared.
//
// ## The five facts this file is responsible for
//
//  1. **One `RestClient` and ONE `LiveClient` for the page.** API.md §6.3 step 1: a second socket on
//     the same session REPLACES the first, which is then closed `4003 SESSION_SUPERSEDED`. Two
//     owners would not be two streams, they would be two halves of the terminal taking the socket
//     from each other. So the runtime is a module-level singleton, `createWsBridge` refuses a second
//     bridge by construction, and **unmounting `<App/>` does not close the socket** — React
//     StrictMode mounts twice in development, and a bridge torn down on unmount would be a socket
//     opened, superseded and reopened on every hot reload. {@link disposeAppRuntime} is the
//     deliberate teardown, for tests and for a host that really is finished with the page.
//  2. **The session gate decides, honestly.** `GET /auth/session` answers and the store classifies:
//     `ready` renders the Shell, anything else renders what it actually is. There is no login form
//     anywhere in this repo — sessions are minted by `POST /auth/login` against seeded users — so
//     this file does not invent one. It says what is true and offers RETRY.
//  3. **The widget registry is built.** `widgets.tsx` explains why that is three `custom` components
//     and not only `ChartCanvas`.
//  4. **Dispatch is wired both ways, and THE TYPED TEXT IS THE COMMAND.** `command/dispatch.ts`
//     performs a command and returns the payload; nothing in it writes that payload onto the frame,
//     because `PanelsPort` is a port and the store is the Shell's. So the Shell does it here, guarded
//     by the frame's trace id: a run that answers after the user has launched something else must not
//     overwrite the screen they are now looking at. The other half of this is `onGo`: GO runs the line
//     the user typed, and an autocomplete row is reported as `search.select` rather than executed.
//     The first version of this file called `executeCandidate`, which runs `candidate.insertText`
//     ALONE — so `AAPL US Equity DES` ran the leading row (the function `DES`) and threw the security
//     away, and a shell line was swallowed whenever the popup had rows. A row is adopted by Tab or by
//     an arrow key, and then it replaces the token it completes, not the line.
//  5. **The realtime bridge is attached** to the one cell registry, so a live cell is written
//     imperatively outside React (ARCHITECTURE §6.6), and the status bar shows the `LiveState` the
//     bridge reports rather than an optimistic LIVE.
//
// ## What is wired to nothing, and why — none of these is a stub
//
//   * `Shell.keyBar` — CLIENT §3.3's `KeyBar.tsx` was never written; there is no component to pass.
//     Every key it would show is reachable from the keyboard (`keyboard/dispatcher.ts`) and from the
//     panel's own back/forward buttons.
//   * `ScreenCtx.prompt` — `PromptDialog` does not exist. The port answers `null`, which every
//     screen already treats as "the user cancelled", rather than hanging on a promise that cannot
//     resolve.
//   * The page-level lock screen (`CLIENT §5.1`, `SessionStore.status === 'locked'`) is rendered as a
//     gate message here rather than as the modal overlay §5.1 describes, because that overlay is
//     also unwritten. A superseded session is stated, not hidden behind a working terminal.
//   * **The window-level keyboard dispatcher is NOT attached, and this is the one wire that cannot be
//     made from this file.** `keyboard/dispatcher.ts` is complete and tested, but four members of its
//     `KeyboardHost` — `region()`, `screenBindings()`, `capturesTypedText()` and `screenAction()` —
//     need the focus model of `keyboard/focus.ts`: a `FocusState` plus `collectFocusNodes(spec.body)`
//     for the focused panel. `Panel.tsx` is the only place both exist, it holds them in local
//     component state (`focusedNodeId`, `focusNodes`) and it exposes neither, so the composition root
//     would have to re-derive the focused node's KIND from class names in the DOM — a second focus
//     model, disagreeing with the first at exactly the moments the first was written to get right.
//     The honest report is the gap, not a heuristic: `Panel` needs to publish its focus (a callback
//     prop, or the focus slice of a store), and then the host is a straightforward object.
//     What that costs today: `F1`, `PRINT`, `PAGE FWD/BACK`, the panel-switch chords and TERM-06's
//     type-anywhere are not bound at the window. Everything they reach is reachable another way —
//     `HELP` is a command (and typing it twice inside ten seconds opens the ticket, exactly as the
//     key does, because the HELP transition lives in `dispatcher.ts#nextHelpEffect` and is called
//     here), `/panel n`, `/layout` and `/clear` are shell commands, the frame stack has its visible
//     back/forward buttons, and the grid, the chart, the form and the command line each own their own
//     keys at the element. PRINT has no non-key path: `ScreenCtx.export` is wired, so a screen's own
//     PRINT control works, but there is no global key for it.
//
// Arithmetic: none. IO: every request goes through the injected `@terminal/sdk` client (API-05); this
// file never names `fetch` or `WebSocket`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

import { registry } from '@terminal/core';
import type { Candidate, CommandProblem } from '@terminal/core';
import { createClient } from '@terminal/sdk';
import type { LiveState, PayloadMeta, TerminalClient } from '@terminal/sdk';
import type { AssetClass } from '@terminal/core';
import type { SessionInfo } from '@terminal/sdk/wire/rest/auth';
import type { ResolveResponse } from '@terminal/sdk/wire/rest/reference';
import type {
  FunctionPageRequest,
  FunctionRunRequest,
  HelpResponse,
} from '@terminal/sdk/wire/rest/functions';
import type { SearchResponse } from '@terminal/sdk/wire/rest/search';

import { Autocomplete, createAutocompleteEngine } from './shell/Autocomplete.js';
import type { AutocompleteContext, AutocompleteEngine } from './shell/Autocomplete.js';
import { CommandLine, applyCandidate } from './shell/CommandLine.js';
import type { CommandLineHandle, GoSelection } from './shell/CommandLine.js';
import { HelpOverlay, loadHelp } from './shell/HelpOverlay.js';
import type { HelpSdk } from './shell/HelpOverlay.js';
import { SCREENS } from './shell/Panel.js';
import type { PanelActions, PanelSlotProps, PanelSlots, ScreenRegistry } from './shell/Panel.js';
import { Shell } from './shell/Shell.js';
import { TicketDialog, collectScreenState } from './shell/TicketDialog.js';
import type { TicketDraft, TicketSdk } from './shell/TicketDialog.js';

import { executeText, runPage, runParams, sdkUsagePort } from './command/dispatch.js';
import type { DispatchDeps, DispatchOutcome, DispatchSdk, PanelsPort } from './command/dispatch.js';
import { LocalUniverseIndex } from './command/localIndex.js';
import type { UniverseSdk } from './command/localIndex.js';
import { initialHelpState, nextHelpEffect } from './keyboard/dispatcher.js';
import type { HelpState } from './keyboard/dispatcher.js';

import { ChartLiveContext } from './chart/index.js';
import type { ChartLiveSource } from './chart/index.js';
import { GridLiveContext, cellRegistry } from './grid/cellRegistry.js';
import { createWsBridge, disposeWsBridge, getWsBridge } from './rt/wsBridge.js';
import type { LiveClientPort, WsBridge } from './rt/wsBridge.js';
import { selectPanelContext, usePanelsStore } from './state/panels.js';
import type { Frame } from './state/panels.js';
import { useSessionStore } from './state/session.js';
import { useSettingsStore } from './state/settings.js';
import { useSubscriptionsStore } from './state/subscriptions.js';
import { useUsageStore } from './state/usage.js';
import type { UsageApi } from './state/usage.js';
import type { Scheduler, WorkspaceApi } from './state/workspace.js';
import { STORE_CHART_HOST, buildWidgetRegistry } from './widgets.js';
import type { WidgetRegistry } from './screen/widgets/registry.js';

/** Injected by vite (`define` in `vite.config.ts`) from `package.json#version`. */
declare const __APP_VERSION__: string;

/**
 * `web/0.1.0` — the string that goes out as `x-client-version` and in the WS `hello.client`.
 *
 * `typeof` and not a bare read: `__APP_VERSION__` is a build-time substitution, and vitest's `web`
 * project has no `define` for it. A bare reference would make this module throw a `ReferenceError`
 * the moment a test imported it, which is exactly why no test ever imported the scaffold.
 */
export const CLIENT_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? `web/${__APP_VERSION__}` : 'web/0.0.0-dev';

/* ---------------------------------------------------------------------------------------------- */
/* The SDK surface the application uses                                                             */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Exactly the routes this file reaches for, declared structurally so that `TerminalClient` satisfies
 * it without an adapter and a test satisfies it with an object literal.
 *
 * It is deliberately NOT `TerminalClient`: that type carries every route in the barrel, and a fake
 * for it would be four hundred methods of which this app calls eight. Each member below is reused
 * from the port that already declared it — `DispatchSdk['fn']`, `WorkspaceApi`, `HelpSdk['help']` —
 * so there is one declaration of each shape in the codebase and it lives with its consumer.
 */
export interface AppSdk {
  auth: {
    session(): Promise<SessionInfo>;
    /** `/logout` (FUNCTIONS §2.6): the server drops the session, then the gate takes the page. */
    logout(): Promise<unknown>;
  };
  /** `fn.run` / `fn.page` are the dispatcher's; `fn.csv` is PRINT (FUNC-03, API.md §9). */
  fn: DispatchSdk['fn'] & {
    csv(
      args: { params: { code: string }; query: { resultId?: string } },
      init?: { traceId?: string; onResponseHeaders?: (headers: Record<string, string>) => void },
    ): Promise<unknown>;
  };
  usage: UsageApi;
  workspace: WorkspaceApi;
  help: HelpSdk['help'] & TicketSdk['help'];
  search: UniverseSdk['search'] & {
    query(
      args: { query: { q: string; limit: number } },
      init?: { signal?: AbortSignal },
    ): Promise<SearchResponse>;
  };
  ref: {
    resolve(args: { query: { ref: string; panelSecurityId?: number } }): Promise<ResolveResponse>;
  };
  /** The one `LiveClient` of the page. `rt/wsBridge.ts` owns it from here on. */
  live: LiveClientPort;
}

/**
 * `TerminalClient` → {@link AppSdk}, which is not a formality.
 *
 * `TerminalClient`'s route methods are typed by their zod schemas — `fn.run` wants a
 * `FunctionRunRequest`, not an object. `command/dispatch.ts` builds that body and declares it
 * `unknown`, deliberately: `DispatchSdk` is the slice of the SDK the dispatcher is ALLOWED to use,
 * and a dispatcher that imported the wire schema could reach for the rest of it. The two meet here,
 * in two casts and nowhere else, and the request is validated against the schema by the client
 * immediately afterwards — so a body dispatch got wrong is a `VALIDATION_FAILED` at the call, not a
 * bad request on the wire.
 */
export function appSdk(client: TerminalClient): AppSdk {
  return {
    auth: {
      session: () => client.auth.session(),
      logout: () => client.auth.logout(),
    },
    fn: {
      run: (args, init) =>
        client.fn.run({ params: args.params, body: args.body as FunctionRunRequest }, init),
      page: (args, init) =>
        client.fn.page({ params: args.params, body: args.body as FunctionPageRequest }, init),
      csv: (args, init) => client.fn.csv(args, init),
    },
    usage: {
      // `UsageApi.events` answers `void`; the route answers a receipt nothing reads.
      events: async (args) => {
        await client.usage.events(args);
      },
    },
    workspace: {
      getActive: () => client.workspace.getActive(),
      putActive: (args) => client.workspace.putActive(args),
    },
    help: {
      // `HelpOverlay`'s `HelpSdk` types `assetClass` as a plain string (it comes off a frame and is
      // put in a query string); the route types it as the `AssetClass` enum. The enum is the
      // authority, and an unknown value would be refused by the route rather than silently used.
      get: (args, init) =>
        client.help.get(
          {
            params: args.params,
            // `query` is required by the route's arg shape even when it is empty.
            query:
              args.query?.assetClass === undefined
                ? {}
                : { assetClass: args.query.assetClass as AssetClass },
          },
          init,
        ),
      openTicket: (args, init) => client.help.openTicket(args, init),
    },
    search: {
      universeSnapshot: (args, init) => client.search.universeSnapshot(args, init),
      query: (args, init) => client.search.query(args, init),
    },
    ref: { resolve: (args) => client.ref.resolve(args) },
    live: client.live,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* The runtime: one per page                                                                        */
/* ---------------------------------------------------------------------------------------------- */

export interface AppRuntime {
  readonly sdk: AppSdk;
  readonly bridge: WsBridge;
  readonly universe: LocalUniverseIndex;
  readonly widgets: WidgetRegistry;
  readonly screens: ScreenRegistry;
  /** `ChartCanvas`'s socket seam — one subscription per chart, on the page's one socket. */
  readonly chartLive: ChartLiveSource;
}

export interface AppRuntimeOptions {
  /** Injected by a test; built with `createClient` when absent. */
  sdk?: AppSdk | undefined;
  widgets?: WidgetRegistry | undefined;
  screens?: ScreenRegistry | undefined;
  universe?: LocalUniverseIndex | undefined;
  /** Non-fatal failures: a broken snapshot cache, a usage batch the plant refused. */
  onError?: ((error: unknown) => void) | undefined;
}

let currentRuntime: AppRuntime | null = null;

/** `setParams` needs the dispatcher, which needs the runtime; the chart host reads it through here. */
let chartSetParams: (panelId: string, patch: Record<string, unknown>) => void = () => undefined;

function buildRuntime(options: AppRuntimeOptions): AppRuntime {
  const sdk: AppSdk =
    options.sdk ??
    appSdk(
      createClient({
        // `/api/v1` is appended by the client; the dev server proxies it to the plant on :8080.
        baseUrl: window.location.origin,
        clientVersion: CLIENT_VERSION,
        credentials: 'include',
        traceId: () => crypto.randomUUID(), // one id per user action (OPS-07)
      }),
    );

  // `getWsBridge()` first: a hot reload re-runs this module, and the socket the previous copy opened
  // is still the session's one socket.
  const bridge =
    getWsBridge() ??
    createWsBridge({
      client: sdk.live,
      // The fan-out target (CLIENT §10.4): updates are written to cells imperatively, outside React.
      registry: cellRegistry,
    });

  const universe =
    options.universe ??
    new LocalUniverseIndex({
      sdk: { search: sdk.search },
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    });

  const chartLive: ChartLiveSource = {
    subscribe: (subjects, fields, onUpdate) => {
      // Through the bridge's client for the same reason `gridLive` is: one owner of the socket.
      const subscription = bridge.client.subscribe([...subjects], [...fields]);
      const off = subscription.on('update', onUpdate);
      return () => {
        off();
        subscription.unsubscribe();
      };
    },
    // `onStaleness` is omitted, not stubbed: the bridge's sweep reports the subjects whose verdict
    // CHANGED through `CellRegistryPort.restyle(subjects)`, which carries the subjects and not the
    // verdicts, and `ChartLiveSource.onStaleness` is handed `Map<subject, ValueState>`. Deriving the
    // verdicts here would mean a second reader of `QuoteCache` state beside the one the bridge
    // already drives, and CLIENT §12.1 allows exactly one. Consequence, stated rather than hidden: a
    // chart's legend does not grey when the feed goes quiet, while every grid cell does.
  };

  return {
    sdk,
    bridge,
    universe,
    widgets:
      options.widgets ??
      buildWidgetRegistry({
        // A thunk, not `chartSetParams` itself: the registry is built once, before any component
        // exists, and the real `setParams` arrives with the dispatcher. Passing the variable would
        // capture the no-op for the life of the page.
        chartHost: STORE_CHART_HOST((panelId, patch) => {
          chartSetParams(panelId, { ...patch });
        }),
      }),
    screens: options.screens ?? SCREENS,
    chartLive,
  };
}

/** THE runtime of this page, built on first use. */
export function appRuntime(options: AppRuntimeOptions = {}): AppRuntime {
  currentRuntime ??= buildRuntime(options);
  return currentRuntime;
}

/**
 * Close the socket and forget the runtime.
 *
 * Not called on unmount (see the file header). A test calls it in `afterEach`; a host that is
 * navigating away entirely may call it to close the socket politely instead of letting the page go.
 */
export function disposeAppRuntime(): void {
  const runtime = currentRuntime;
  currentRuntime = null;
  runtime?.universe.dispose();
  // `disposeWsBridge()` stops the bridge AND clears `rt/wsBridge.ts`'s own singleton, which is what
  // lets the next `createWsBridge` succeed; stopping the bridge alone would leave that module
  // holding a dead one and refusing to build another.
  disposeWsBridge();
}

/* ---------------------------------------------------------------------------------------------- */
/* Payload → frame                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

/** `POST /functions/:code/run` answers `{ data, meta }` (API.md §5.3 `Payload`). */
interface RunEnvelope {
  readonly data: unknown;
  readonly meta: PayloadMeta;
}

/**
 * The envelope, or `null` for anything else.
 *
 * The SDK has already validated the body against the `Payload` schema, so this narrows rather than
 * checks — but it narrows, because `DispatchOutcome.payload` is `unknown` (dispatch is deliberately
 * ignorant of what a screen payload is) and a `meta` written onto a frame is read by every screen.
 */
function envelopeOf(payload: unknown): RunEnvelope | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const bag = payload as { data?: unknown; meta?: unknown };
  if (typeof bag.meta !== 'object' || bag.meta === null) return null;
  return { data: bag.data, meta: bag.meta as PayloadMeta };
}

/**
 * Write a run's answer onto the frame that asked for it.
 *
 * Guarded by the trace id. `replaceFrame` patches whatever frame is on top of the panel's stack now,
 * and a run that answers after the user launched something else would otherwise paint the first
 * screen's payload into the second screen's frame — a screen showing another function's numbers
 * under this function's title, with no error anywhere.
 */
function writeOutcome(panelId: string, outcome: DispatchOutcome): void {
  const store = usePanelsStore.getState();
  const panel = store.panels[panelId];
  const frame: Frame | undefined = panel === undefined ? undefined : panel.frameStack[panel.index];
  if (frame === undefined) return;

  if (outcome.kind === 'failed') {
    if (frame.traceId !== outcome.traceId) return;
    store.replaceFrame(panelId, {
      status: 'error',
      error: {
        code: outcome.problem.code,
        message: outcome.problem.message,
        traceId: outcome.traceId,
      },
    });
    return;
  }
  if (outcome.kind !== 'ran') return;
  if (frame.traceId !== outcome.traceId) return;

  const envelope = envelopeOf(outcome.payload);
  if (envelope === null) {
    store.replaceFrame(panelId, {
      status: 'error',
      error: {
        code: 'VALIDATION_FAILED',
        message: 'the function answered something that is not a payload envelope',
        traceId: outcome.traceId,
      },
    });
    return;
  }
  store.replaceFrame(panelId, {
    payload: envelope.data,
    meta: envelope.meta,
    status: 'ready',
  });
}

/* ---------------------------------------------------------------------------------------------- */
/* Presentation of the gate                                                                         */
/* ---------------------------------------------------------------------------------------------- */

const S = {
  app: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: 'var(--c-bg)',
    color: 'var(--c-value)',
  },
  gate: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1ch',
    padding: '2ch',
    maxWidth: '80ch',
  },
  head: { color: 'var(--c-label)', margin: 0 },
  muted: { color: 'var(--c-muted)', margin: 0 },
  warn: { color: 'var(--c-warn)', margin: 0 },
  error: { color: 'var(--c-error)', margin: 0 },
  action: {
    color: 'var(--c-focus)',
    cursor: 'pointer',
    textDecoration: 'underline',
    alignSelf: 'flex-start',
  },
  popup: { position: 'relative' },
} satisfies Record<string, CSSProperties>;

export interface GateProps {
  status: 'unknown' | 'anonymous' | 'mfa' | 'locked';
  error: { code: string; message: string } | null;
  supersededBy?: { deviceLabel: string; createdAt: string } | undefined;
  onRetry: () => void;
}

/**
 * Everything that is not a running terminal.
 *
 * Four states, four sentences, and no login form: this build has no sign-in UI, and a box that
 * collected an email and could do nothing with it would be worse than the truth.
 */
export function Gate({ status, error, supersededBy, onRetry }: GateProps): ReactElement {
  return (
    <div style={S.app} data-testid="session-gate" data-gate={status}>
      <div style={S.gate} role="status">
        {status === 'unknown' && error === null ? (
          <p style={S.muted}>SESSION · checking…</p>
        ) : null}

        {status === 'unknown' && error !== null ? (
          <>
            <p style={S.error}>{`The plant did not answer /auth/session — ${error.code}`}</p>
            <p style={S.muted}>{error.message}</p>
          </>
        ) : null}

        {status === 'anonymous' ? (
          <>
            <p style={S.warn}>NO SESSION</p>
            <p style={S.muted}>
              This terminal has no sign-in screen. A session is minted by the plant
              (POST /auth/login) against a seeded user; the web client only ever reads
              GET /auth/session. Sign in through the plant, then retry.
            </p>
          </>
        ) : null}

        {status === 'mfa' ? (
          <>
            <p style={S.warn}>SECOND FACTOR REQUIRED</p>
            <p style={S.muted}>
              The session owes a WebAuthn verification (/auth/webauthn/login/verify). No WebAuthn UI
              exists in this build, so the terminal cannot complete it here.
            </p>
          </>
        ) : null}

        {status === 'locked' ? (
          <>
            <p style={S.warn}>SESSION SUPERSEDED</p>
            <p style={S.muted}>
              {supersededBy === undefined
                ? 'Another window took this session (SEC-03).'
                : `Another window took this session at ${supersededBy.createdAt} (${supersededBy.deviceLabel}).`}
            </p>
          </>
        ) : null}

        <button type="button" style={S.action} onClick={onRetry} data-testid="gate-retry">
          RETRY
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* The application                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

export interface AppProps {
  /** A test injects the whole runtime; production passes nothing. */
  runtime?: AppRuntimeOptions | undefined;
  /** The workspace autosave's timers (TESTING §2.2); the store's own wall clock when absent. */
  scheduler?: Scheduler | undefined;
  /** Load the universe snapshot on mount. A test that has no snapshot route passes `false`. */
  loadUniverse?: boolean | undefined;
}

export function App({ runtime: options, scheduler, loadUniverse = true }: AppProps = {}): ReactElement {
  const runtime = useMemo(() => appRuntime(options ?? {}), [options]);
  const sdk = runtime.sdk;

  const status = useSessionStore((s) => s.status);
  const sessionError = useSessionStore((s) => s.error);
  const lock = useSessionStore((s) => s.lock);

  /** The footer problem line of each panel — `PanelsPort.setProblem`'s destination. */
  const [problems, setProblems] = useState<Readonly<Record<string, CommandProblem | null>>>({});
  /**
   * `LiveClient.state`, as the bridge reports it (CLIENT §3.2).
   *
   * Read off the BRIDGE and through a lazy initialiser, for the same reason twice: on the real
   * `TerminalClient`, `live` is a getter that CONSTRUCTS the `LiveClient` on first access
   * (`client/rest.ts`), so every reach through it is a chance to own a second socket. The bridge
   * already holds the one client, and `useState(x)` evaluates `x` on every render while
   * `useState(() => x)` evaluates it once. Together they make "the page touches the live client
   * exactly once" a fact this component's test can assert.
   */
  const [connection, setConnection] = useState<LiveState>(() => runtime.bridge.status.state);
  /** The open overlay of each panel, and what it is showing. */
  const [overlay, setOverlay] = useState<OverlayState | null>(null);

  const commandLines = useRef(new Map<string, CommandLineHandle | null>());
  const engines = useRef(new Map<string, AutocompleteEngine>());
  const spans = useRef(new Map<string, readonly [number, number]>());
  const helpState = useRef<HelpState>(initialHelpState);

  const onError = useCallback((error: unknown) => {
    // A non-fatal failure is reported where a developer will see it and nowhere else: the user is
    // told by the panel's problem line or the status bar, both of which are driven above.
    globalThis.console?.warn?.('[terminal]', error);
  }, []);

  /* ── the session gate (CLIENT §2 L172-210) ───────────────────────────────────────────────── */

  const reload = useCallback(() => {
    void useSessionStore.getState().load(sdk.auth);
  }, [sdk]);

  useEffect(() => {
    useSessionStore.getState().setClientVersion(CLIENT_VERSION);
    void useSessionStore.getState().load(sdk.auth);
  }, [sdk]);

  /* ── the one socket, and the usage batcher ───────────────────────────────────────────────── */

  useEffect(() => {
    if (status !== 'ready') return undefined;
    const bridge = runtime.bridge;
    setConnection(bridge.status.state);
    const off = bridge.onStatus((s) => {
      setConnection(s.state);
    });
    void bridge.start().catch(onError);
    return off;
  }, [runtime, status, onError]);

  useEffect(() => {
    if (status !== 'ready') return undefined;
    const usage = useUsageStore.getState();
    usage.configure({
      api: sdk.usage,
      ...(scheduler === undefined ? {} : { scheduler }),
    });
    usage.start();
    return () => {
      useUsageStore.getState().stop();
    };
  }, [sdk, scheduler, status]);

  /* ── the local universe index (CLIENT §3.4, TERM-02) ─────────────────────────────────────── */

  useEffect(() => {
    if (status !== 'ready' || !loadUniverse) return;
    void runtime.universe.load().catch(onError);
  }, [runtime, status, loadUniverse, onError]);

  /* ── dispatch (FUNCTIONS §2.5, CLIENT §6) ────────────────────────────────────────────────── */

  const setProblem = useCallback((panelId: string, problem: CommandProblem | null) => {
    setProblems((previous) => ({ ...previous, [panelId]: problem }));
  }, []);

  /**
   * `PanelsPort` over the real store.
   *
   * Two members have no counterpart in `state/panels.ts` and are the reason this port exists:
   * `context()` is the store's own selector, and `setProblem()` belongs to the command line, which
   * is this component's state. The `security` conversion is the one lossy step in the file and is
   * documented at the call site.
   */
  const panelsPort = useMemo<PanelsPort>(
    () => ({
      context: (panelId) => selectPanelContext(panelId)(usePanelsStore.getState()),
      frame: (panelId) => {
        const panel = usePanelsStore.getState().panels[panelId];
        const frame = panel === undefined ? undefined : panel.frameStack[panel.index];
        if (frame === undefined) return undefined;
        return {
          security: frame.security === null ? null : { id: frame.security.id, display: frame.security.display },
          fn: frame.fn,
          params: frame.params,
          resultId: frame.resultId,
          scroll: frame.scroll,
          traceId: frame.traceId,
        };
      },
      pushFrame: (panelId, frame) => {
        // `dispatch.Frame.security.id` is `number | null` — `null` for a security addressed by ref
        // or by formula, which has no local instrument id. `state/panels.ts#FrameSecurity.id` is
        // `number`, because REF-01 says a panel is anchored to a resolved instrument and the layout
        // that is persisted carries instrument ids. So a ref-addressed security anchors NO security
        // on the frame; the run still carries the ref (the request was built before this point) and
        // the panel header shows the function without a security rather than a security the store
        // cannot represent.
        usePanelsStore.getState().pushFrame(panelId, {
          security:
            frame.security?.id == null
              ? null
              : { id: frame.security.id, display: frame.security.display },
          fn: frame.fn,
          traceId: frame.traceId,
          params: frame.params,
          resultId: frame.resultId,
          scroll: frame.scroll,
        });
      },
      replaceFrame: (panelId, patch) => {
        usePanelsStore.getState().replaceFrame(panelId, patch);
      },
      pushHistory: (panelId, raw) => {
        usePanelsStore.getState().pushHistory(panelId, raw);
      },
      setDraft: (panelId, value) => {
        usePanelsStore.getState().setDraft(panelId, value);
      },
      setProblem,
    }),
    [setProblem],
  );

  /** HELP: one press explains, a second within ten seconds opens a ticket (TERM-09). */
  const onHelp = useCallback(
    (spec: { code?: string; query?: string }, panelId: string) => {
      const now = Date.now();
      const next = nextHelpEffect(helpState.current, now, overlay?.kind === 'help');
      helpState.current = next.state;
      if (next.effect === 'ticket') {
        setOverlay({ kind: 'ticket', panelId });
        return;
      }
      const store = usePanelsStore.getState();
      const panel = store.panels[panelId];
      const frame = panel === undefined ? undefined : panel.frameStack[panel.index];
      const code = spec.code ?? frame?.fn ?? null;
      if (code === null) {
        // `HELP` with no function to explain: the overlay would have nothing in it. The footer says
        // so, which is the same channel every other unusable command uses.
        setProblem(panelId, {
          code: 'UNKNOWN_FUNCTION',
          span: [0, 4],
          message: 'HELP explains the function in this panel; this panel has none',
        });
        return;
      }
      setOverlay({ kind: 'help', panelId, code, status: 'loading', help: null, error: null });
      void loadHelp(sdk, {
        code,
        ...(frame?.instrument?.assetClass === undefined ? {} : { assetClass: frame.instrument.assetClass }),
        ...(frame?.traceId === undefined || frame.traceId === '' ? {} : { traceId: frame.traceId }),
      })
        .then((help) => {
          setOverlay((current) =>
            current !== null && current.kind === 'help' && current.code === code
              ? { ...current, status: 'ready', help }
              : current,
          );
        })
        .catch((error: unknown) => {
          const described =
            typeof error === 'object' && error !== null
              ? (error as { code?: unknown; message?: unknown })
              : {};
          setOverlay((current) =>
            current !== null && current.kind === 'help' && current.code === code
              ? {
                  ...current,
                  status: 'error',
                  error: {
                    code: typeof described.code === 'string' ? described.code : 'UNKNOWN',
                    message: typeof described.message === 'string' ? described.message : 'help is unavailable',
                  },
                }
              : current,
          );
        });
    },
    [sdk, overlay, setProblem],
  );

  /**
   * The eight shell commands of FUNCTIONS §2.6 (`core/command/grammar.ts#SHELL_COMMANDS`), all of
   * them, because a word the parser accepts and the shell ignores is the worst of the three
   * possible behaviours.
   *
   * The arguments arrive already validated against each command's `ShellArgSpec` — the parser
   * refuses `/layout 3` before `execute` is reached — so this switch narrows rather than checks.
   * `/trace` and `/version` are the two that do nothing here, and they are the two the status bar
   * shows continuously anyway (`StatusBar.tsx`: `data-testid="trace-id"`, the client version and the
   * RELOAD badge), so there is nothing for them to open.
   */
  const onShellCommand = useCallback(
    (word: string, args: string[]) => {
      const store = usePanelsStore.getState();
      // `Token.text` keeps the case the tokenizer read, and the command line up-cases what the user
      // typed; the grammar's own enums are lower case (`'2h'`, `'light'`), so the comparison is.
      const first = (args[0] ?? '').toLowerCase();
      switch (word.toLowerCase()) {
        case 'panel': {
          const index = Number.parseInt(first, 10);
          if (Number.isFinite(index) && index >= 1) store.setFocus(`p${String(index)}`);
          return;
        }
        case 'layout': {
          if (first === '1' || first === '2h' || first === '2v' || first === '4') store.setMode(first);
          return;
        }
        case 'clear':
          store.clearFrames(store.focus);
          return;
        case 'conflate': {
          const ms = Number.parseInt(first, 10);
          if (!Number.isFinite(ms)) return;
          // Both halves: the socket is told (API.md §6.1 `hello.conflationMs`) and the store is told,
          // because the status bar reads the store and a number shown that the socket never got is
          // the kind of lie TERM-12 exists to prevent.
          runtime.bridge.client.setConflation(ms);
          useSubscriptionsStore.getState().setEffective(ms);
          return;
        }
        case 'theme': {
          if (first === 'dark' || first === 'light' || first === 'system') {
            useSettingsStore.getState().set('theme', first);
          }
          return;
        }
        case 'logout': {
          void sdk.auth
            .logout()
            .catch(onError)
            .finally(() => {
              // The gate takes the page back either way: a logout the plant refused still means this
              // client is finished with the session.
              useSessionStore.getState().reset();
            });
          return;
        }
        case 'trace':
        case 'version':
          return;
        default:
          // A `/` line the grammar does not name. The parser has already said so on the command
          // line's own problem row; nothing further happens here.
          return;
      }
    },
    [runtime, sdk, onError],
  );

  const dispatchDeps = useMemo<DispatchDeps>(() => {
    const deps: DispatchDeps = {
      sdk,
      panels: panelsPort,
      // The batching store IS a `UsagePort` (`state/usage.ts` says so); `sdkUsagePort` is the
      // fallback for the window before `configure()` has an api, so telemetry is never lost and
      // never fails a user action either way.
      usage: status === 'ready' ? useUsageStore.getState() : sdkUsagePort(sdk, { onError }),
      registry,
      lookupTicker: runtime.universe.lookupTicker,
      shell: onShellCommand,
      help: (spec) => {
        onHelp(spec, usePanelsStore.getState().focus);
      },
      onError,
    };
    return deps;
  }, [sdk, panelsPort, runtime, status, onShellCommand, onHelp, onError]);

  /**
   * `frame.instrument` for a run that anchored one.
   *
   * The run request carries a security; the payload does not carry the security master row, and
   * three things need it: TERM-03's context rules (`assetClass`/`marketSector` decide whether the
   * next function survives the security), the panel header, and `ccy`/`px` cell formatting
   * (`instruments.currency`, `price_decimals`). `GET /ref/resolve` is the one route that answers it,
   * and it is asked once per launch AFTER the screen has already painted — the `go → fn:first-paint`
   * budget of CLIENT §16.1 is measured across the run, and a reference lookup in front of it would be
   * spent on three display details. The cost is one extra paint per launch: writing the instrument
   * onto the frame rebuilds that panel's `ScreenSpec`, so a chart screen also re-subscribes its live
   * bindings once (ref-counted by `SubscriptionRegistry`, so the socket ends with one subscription).
   */
  const resolveInstrument = useCallback(
    (panelId: string, traceId: string, display: string) => {
      void sdk.ref
        .resolve({ query: { ref: display } })
        .then((response) => {
          const instrument = response.results[0]?.instrument ?? null;
          if (instrument === null) return;
          const panel = usePanelsStore.getState().panels[panelId];
          const frame = panel === undefined ? undefined : panel.frameStack[panel.index];
          if (frame?.traceId !== traceId) return;
          usePanelsStore.getState().replaceFrame(panelId, { instrument });
        })
        .catch(onError);
    },
    [sdk, onError],
  );

  /** Everything a run has to do to the panel after `dispatch` returns. */
  const settle = useCallback(
    (panelId: string, outcome: DispatchOutcome): void => {
      writeOutcome(panelId, outcome);
      if (outcome.kind !== 'ran') return;
      const panel = usePanelsStore.getState().panels[panelId];
      const frame = panel === undefined ? undefined : panel.frameStack[panel.index];
      if (frame?.traceId !== outcome.traceId) return;
      if (frame.security !== null && frame.instrument == null) {
        resolveInstrument(panelId, outcome.traceId, frame.security.display);
      }
    },
    [resolveInstrument],
  );

  const run = useCallback(
    (panelId: string, promise: Promise<DispatchOutcome>): void => {
      void promise
        .then((outcome) => {
          settle(panelId, outcome);
        })
        .catch(onError);
    },
    [settle, onError],
  );

  /** PRINT (FUNC-03): the server's CSV, never a locally serialised one (API.md §9). */
  const exportResult = useCallback(
    (panelId: string) => {
      const panel = usePanelsStore.getState().panels[panelId];
      const frame = panel === undefined ? undefined : panel.frameStack[panel.index];
      if (frame?.fn == null || frame.resultId === null) {
        setProblem(panelId, {
          code: 'NOT_APPLICABLE',
          span: [0, 0],
          message: 'this screen has nothing to export yet',
        });
        return;
      }
      const code = frame.fn;
      let filename = `${code}.csv`;
      void sdk.fn
        .csv(
          { params: { code }, query: { resultId: frame.resultId } },
          {
            traceId: frame.traceId,
            onResponseHeaders: (headers) => {
              // API.md §9: the server names the file (`<CODE>_<security>_<asOf>.csv`).
              const disposition = headers['content-disposition'] ?? '';
              const match = /filename="?([^";]+)"?/.exec(disposition);
              if (match?.[1] !== undefined) filename = match[1];
            },
          },
        )
        .then((body) => {
          const text = typeof body === 'string' ? body : (body as { text?: unknown }).text;
          if (typeof text !== 'string') throw new TypeError('the export was not a CSV document');
          const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
          const link = document.createElement('a');
          link.href = url;
          link.download = filename;
          link.rel = 'noopener';
          link.click();
          URL.revokeObjectURL(url);
          useUsageStore.getState().push({
            kind: 'fn.export',
            panelId,
            code,
            traceId: frame.traceId,
            details: { clientReported: true, filename },
          });
        })
        .catch((error: unknown) => {
          // ENTL-05: an export the user is not entitled to is refused with a reason code, and the
          // reason code is what the footer shows — not "export failed".
          const described =
            typeof error === 'object' && error !== null
              ? (error as { code?: unknown; message?: unknown })
              : {};
          // `CommandProblem.code` is the parser's closed set (`core/command/parser.ts`), so the
          // server's reason code — `EXPORT_NOT_PERMITTED`, `TIER_INSUFFICIENT` — goes in the
          // message, which is the line the user actually reads. ENTL-05 asks for the reason to be
          // shown, not for it to be re-spelled as a parse problem it is not.
          const reason = typeof described.code === 'string' ? described.code : 'UNKNOWN';
          const detail = typeof described.message === 'string' ? described.message : 'the export failed';
          setProblem(panelId, {
            code: 'NOT_APPLICABLE',
            span: [0, 0],
            message: `${reason} · ${detail}`,
          });
          onError(error);
        });
    },
    [sdk, setProblem, onError],
  );

  const actions = useMemo<PanelActions>(
    () => ({
      navigate: (panelId, command) => {
        run(panelId, executeText(dispatchDeps, panelId, command));
      },
      navigateNext: (panelId, command) => {
        const store = usePanelsStore.getState();
        const order = store.visible;
        const at = order.indexOf(panelId);
        const next = order[(at + 1) % Math.max(1, order.length)] ?? panelId;
        store.setFocus(next);
        run(next, executeText(dispatchDeps, next, command));
      },
      setParams: (panelId, patch) => {
        run(panelId, runParams(dispatchDeps, panelId, patch));
      },
      page: (panelId, direction) => {
        run(panelId, runPage(dispatchDeps, panelId, direction));
      },
      exportResult,
      prompt: () => {
        // `PromptDialog` does not exist (see the file header). `null` is "cancelled", which every
        // screen already handles, and is the only answer that is not a fabrication.
        return Promise.resolve(null);
      },
      openUrl: (url) => {
        globalThis.open?.(url, '_blank', 'noopener,noreferrer');
      },
      provenance: () => {
        // The NOTIFICATION, not the opener, and it is correctly empty. `screen/ScreenRenderer.tsx`
        // both renders the provenance panel (`role="dialog" aria-label="Provenance"`) and opens it —
        // for `Ctrl+I` itself, and for `ScreenCtx.provenance(idx)` through the handle `Panel.tsx`
        // holds. What reaches here is the renderer reporting that one opened, and `usage_events.kind`
        // (API.md §5.13) has no provenance member, so there is no telemetry row to emit. An earlier
        // version of this header said the panel did not exist; it does, and it works.
      },
    }),
    [dispatchDeps, exportResult, run],
  );

  // The chart host's `setParams` is the same one the panels use; the registry closed over a mutable
  // reference at module scope because `buildWidgetRegistry` runs once, before this component exists.
  useEffect(() => {
    // An arrow, not the method itself: `setParams` is a member of the actions object and must be
    // called on it.
    chartSetParams = (panelId, patch) => {
      actions.setParams(panelId, patch);
    };
  }, [actions]);

  /* ── the command line and the autocomplete (CLIENT §4) ───────────────────────────────────── */

  const engineFor = useCallback(
    (panelId: string): AutocompleteEngine => {
      const existing = engines.current.get(panelId);
      if (existing !== undefined) return existing;
      const context = (): AutocompleteContext => ({
        index: runtime.universe.index,
        registry,
        panel: selectPanelContext(panelId)(usePanelsStore.getState()),
        lookupTicker: runtime.universe.lookupTicker,
        ready: runtime.universe.ready,
        panelId,
      });
      const engine = createAutocompleteEngine({
        context,
        search: async (q, signal) => {
          const response = await sdk.search.query({ query: { q, limit: 12 } }, { signal });
          return response.hits as readonly Candidate[];
        },
        onRows: (rows, info) => {
          spans.current.set(panelId, info.span);
          // `selected: -1` — NOTHING is highlighted until the user arrows onto a row, and that is a
          // correctness requirement rather than a cosmetic one. With `selected: 0` every fresh list
          // reported a highlighted row to `CommandLine.go()`, which then treated GO as "execute the
          // highlighted candidate": `AAPL US Equity DES` ran whatever row 0 happened to be — the
          // FUNCTION `DES` on its own, against the wrong instrument — and `LAYOUT 4` never reached
          // the shell handler at all. Row 0 is a SUGGESTION (Tab accepts it, ArrowDown adopts it);
          // GO runs what the user typed (TERM-01, CLIENT §4.1).
          usePanelsStore.getState().setAc(panelId, { rows, selected: -1, open: rows.length > 0 });
        },
        onError,
      });
      engines.current.set(panelId, engine);
      return engine;
    },
    [runtime, sdk, onError],
  );

  useEffect(
    () => () => {
      for (const engine of engines.current.values()) engine.dispose();
      engines.current.clear();
    },
    [],
  );

  const onGo = useCallback(
    (panelId: string, text: string, selection: GoSelection | null) => {
      engineFor(panelId).cancel();
      usePanelsStore.getState().setAc(panelId, { rows: [], selected: -1, open: false });
      // §2.5 L783: a GO clears `commandDraft`. `dispatch` clears the STORE's copy, but the input is
      // uncontrolled — CLIENT §4.1's 16 ms budget is why — so the DOM keeps whatever was typed
      // unless the shell clears it, and the next command is appended to the last one: the second
      // command of a session arrives as `AAPL US Equity DESGP`. `clear()` is the handle's own rung
      // for this and notifies `onInput`, so the store and the autocomplete stay in step. Done here,
      // before the request goes out, because the panel is already painting the new screen.
      commandLines.current.get(panelId)?.clear();
      if (selection === null) {
        run(panelId, executeText(dispatchDeps, panelId, text));
        return;
      }
      runtime.universe.noteUse(selection.candidate.kind, selection.candidate.id);
      // THE TEXT IS THE COMMAND, and the candidate is telemetry. `executeCandidate` runs
      // `candidate.insertText` and nothing else (`command/dispatch.ts` L415-422), so a row accepted
      // on a line that had a security on it — `AAPL US Equity DES`, with the `DES` row highlighted —
      // discarded every other token the user typed and ran `DES` against whatever the panel held or
      // against the ETF of that ticker. `text` is what `CommandLine` hands over: the draft with the
      // accepted row substituted into the completed span (`applyCandidate`), which is the whole
      // line. `options.candidate` still reports `search.select` with its rank (TERM-02), so nothing
      // is lost from the telemetry by not running it.
      run(
        panelId,
        executeText(dispatchDeps, panelId, text, {
          candidate: selection.candidate,
          candidateRank: selection.rank,
        }),
      );
    },
    [dispatchDeps, engineFor, run, runtime],
  );

  const slots = useMemo<PanelSlots>(
    () => ({
      commandLine: (props: PanelSlotProps): ReactNode => (
        <CommandLineSlot
          key={props.panelId}
          panelId={props.panelId}
          problem={problems[props.panelId] ?? null}
          handles={commandLines.current}
          spans={spans.current}
          engineFor={engineFor}
          onGo={onGo}
        />
      ),
      overlay: (props: PanelSlotProps): ReactNode => {
        if (overlay?.panelId !== props.panelId) return null;
        return (
          <PanelOverlay
            state={overlay}
            sdk={sdk}
            onClose={() => {
              setOverlay(null);
            }}
            onLaunch={(command) => {
              setOverlay(null);
              actions.navigate(props.panelId, command);
            }}
            onTicket={() => {
              setOverlay({ kind: 'ticket', panelId: props.panelId });
            }}
          />
        );
      },
    }),
    [problems, engineFor, onGo, overlay, sdk, actions],
  );

  /* ── the workspace (TERM-05) ─────────────────────────────────────────────────────────────── */

  const onRestored = useCallback(() => {
    // A restored frame carries its function and its security but no payload: the layout persists
    // five fields, not a screen (CLIENT §8 L574-577). Re-running it is the only way to fill it, and
    // `launchKind: 'refresh'` is what tells the plant's usage row that a human did not type this.
    const store = usePanelsStore.getState();
    for (const panelId of store.order) {
      const panel = store.panels[panelId];
      const frame = panel === undefined ? undefined : panel.frameStack[panel.index];
      if (frame?.fn == null) continue;
      const command = frame.security === null ? frame.fn : `${frame.security.display} ${frame.fn}`;
      run(panelId, executeText(dispatchDeps, panelId, command, { launchKind: 'refresh' }));
    }
  }, [dispatchDeps, run]);

  /**
   * The terminal is keyboard-first (TERM-01): on the first ready paint the caret belongs in the
   * focused panel's command line, so a user can type `AAPL US Equity DES` without touching a mouse.
   *
   * Once, and only from `'checking'` → `'ready'`: a later re-focus would fight the user, and this is
   * precisely the steal `ScreenRenderer`'s `autoFocus={false}` exists to prevent on every subsequent
   * frame. The ref makes the effect idempotent across React StrictMode's double mount. The handle is
   * registered by the slot's `ref` callback, which has run by the time this effect does.
   */
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (status !== 'ready' || focusedOnce.current) return;
    const handle = commandLines.current.get(usePanelsStore.getState().focus);
    if (handle == null) return;
    focusedOnce.current = true;
    handle.focus();
  }, [status]);

  const gridLive = useMemo(
    () => ({
      setEssential: (subjects: readonly string[], essential: boolean): void => {
        // BUS-04 / API.md §6.5: a row scrolled out of view is sheddable, one in view is not.
        // Through the bridge's own client, not `sdk.live`: the bridge is the one owner of the socket
        // and this is a viewport report on it, not a second acquisition of it.
        runtime.bridge.client.setEssential([...subjects], essential);
      },
    }),
    [runtime],
  );

  if (status !== 'ready') {
    return (
      <Gate
        status={status}
        error={sessionError}
        {...(lock?.supersededBy === undefined ? {} : { supersededBy: lock.supersededBy })}
        onRetry={reload}
      />
    );
  }

  return (
    <GridLiveContext.Provider value={gridLive}>
      <ChartLiveContext.Provider value={runtime.chartLive}>
        <Shell
          workspace={sdk.workspace}
          {...(scheduler === undefined ? {} : { scheduler })}
          onRestored={onRestored}
          connection={connection}
          actions={actions}
          slots={slots}
          widgets={runtime.widgets}
          screens={runtime.screens}
          clientVersion={CLIENT_VERSION}
        />
      </ChartLiveContext.Provider>
    </GridLiveContext.Provider>
  );
}

export default App;

/* ---------------------------------------------------------------------------------------------- */
/* The command-line slot                                                                            */
/* ---------------------------------------------------------------------------------------------- */

interface CommandLineSlotProps {
  panelId: string;
  problem: CommandProblem | null;
  handles: Map<string, CommandLineHandle | null>;
  spans: Map<string, readonly [number, number]>;
  engineFor: (panelId: string) => AutocompleteEngine;
  onGo: (panelId: string, text: string, selection: GoSelection | null) => void;
}

/**
 * One panel's command line and its autocomplete popup (CLIENT §4.1-§4.4).
 *
 * `CommandLine` is uncontrolled on purpose — CLIENT §4.1's budget is 16 ms from keystroke to visual
 * feedback behind ~36 000 universe entries, and a controlled input would put a React commit in that
 * path. So the draft lives in the DOM, this component writes it through to the store for the
 * workspace to persist, and the popup is the only thing that re-renders per keystroke.
 *
 * The handle is stashed in a map the shell owns, because `keyboard/dispatcher.ts`'s `KeyboardHost`
 * needs exactly this object for `commandText`, `typeIntoCommandLine`, `insertSector`,
 * `focusCommandLine` and `clearCommandDraft` — `CommandLineHandle`'s own doc comment says so.
 */
function CommandLineSlot({
  panelId,
  problem,
  handles,
  spans,
  engineFor,
  onGo,
}: CommandLineSlotProps): ReactElement {
  const ac = usePanelsStore((s) => s.panels[panelId]?.ac);
  const history = usePanelsStore((s) => s.panels[panelId]?.history);
  /** The restored draft. Read once: the input is uncontrolled and owns it from here on. */
  const initial = useRef(usePanelsStore.getState().panels[panelId]?.commandDraft ?? '');

  const getAc = useCallback(() => {
    const panel = usePanelsStore.getState().panels[panelId];
    const span = spans.get(panelId);
    return {
      open: panel?.ac.open ?? false,
      rows: panel?.ac.rows ?? [],
      selected: panel?.ac.selected ?? -1,
      ...(span === undefined ? {} : { span }),
    };
  }, [panelId, spans]);

  const setSelection = useCallback(
    (index: number) => {
      const store = usePanelsStore.getState();
      const panel = store.panels[panelId];
      if (panel === undefined) return;
      const count = panel.ac.rows.length;
      if (count === 0) return;
      // Wraps, as CLIENT §4.3's list does: ArrowDown on the last row is the first row.
      const next = ((index % count) + count) % count;
      store.setAc(panelId, { ...panel.ac, selected: next });
    },
    [panelId],
  );

  const close = useCallback(() => {
    const store = usePanelsStore.getState();
    const panel = store.panels[panelId];
    if (panel?.ac.open !== true) return;
    store.setAc(panelId, { ...panel.ac, open: false });
  }, [panelId]);

  return (
    <div style={S.popup}>
      <CommandLine
        panelId={panelId}
        defaultText={initial.current}
        history={history ?? []}
        problem={problem}
        getAc={getAc}
        placeholder="AAPL US Equity DES <GO>"
        ref={(handle) => {
          handles.set(panelId, handle);
        }}
        onInput={(text) => {
          usePanelsStore.getState().setDraft(panelId, text);
          engineFor(panelId).query(text);
        }}
        onGo={(text, selection) => {
          onGo(panelId, text, selection);
        }}
        onMoveSelection={(delta) => {
          const current = usePanelsStore.getState().panels[panelId]?.ac.selected ?? -1;
          // From "nothing highlighted" (-1) ArrowDown takes the FIRST row and ArrowUp the LAST.
          // `current + delta` would give -2 for ArrowUp, and -2 wraps to `count - 2` — one row short
          // of the end — so the two openings are named rather than arithmetic.
          setSelection(current < 0 ? (delta === 1 ? 0 : -1) : current + delta);
        }}
        onComplete={close}
        onCloseAutocomplete={close}
      />
      <Autocomplete
        panelId={panelId}
        rows={ac?.rows ?? []}
        selected={ac?.selected ?? 0}
        open={ac?.open ?? false}
        registry={registry}
        onSelect={setSelection}
        onExecute={(index) => {
          const row = usePanelsStore.getState().panels[panelId]?.ac.rows[index];
          if (row === undefined) return;
          // A clicked row replaces the completed SPAN of the draft and nothing else, exactly as the
          // keyboard's Tab and GO do (`AutocompleteSnapshot.span`, CommandLine.tsx L57-63): with
          // `AAPL US Equity DE` typed, clicking `DES` runs `AAPL US Equity DES` and not the bare
          // `DES` that would then run against whatever the panel already held.
          const text = handles.get(panelId)?.text() ?? row.insertText;
          onGo(panelId, applyCandidate(text, row, spans.get(panelId)), { candidate: row, rank: index });
        }}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* The per-panel overlays                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/** What a panel has open over its screen. One at a time, per CLIENT §3.4. */
export type OverlayState =
  | {
      kind: 'help';
      panelId: string;
      code: string;
      status: 'loading' | 'ready' | 'error';
      help: HelpResponse | null;
      error: { code: string; message: string } | null;
    }
  | { kind: 'ticket'; panelId: string };

interface PanelOverlayProps {
  state: OverlayState;
  sdk: AppSdk;
  onClose: () => void;
  onLaunch: (command: string) => void;
  onTicket: () => void;
}

/**
 * HELP and the support ticket (TERM-09, FUNCTIONS §4).
 *
 * The ticket's `screenState` is harvested from the DOM of the panel it was opened over, which is
 * what `collectScreenState` is for: what is in the document is what the user can actually see, down
 * to the open tab and the scrolled-in rows.
 */
function PanelOverlay({ state, sdk, onClose, onLaunch, onTicket }: PanelOverlayProps): ReactElement {
  const store = usePanelsStore.getState();
  const panel = store.panels[state.panelId];
  const frame = panel === undefined ? undefined : panel.frameStack[panel.index];

  if (state.kind === 'help') {
    return (
      <HelpOverlay
        panelId={state.panelId}
        help={state.help}
        status={state.status}
        error={state.error}
        params={frame?.params ?? {}}
        traceId={frame?.traceId ?? null}
        onClose={onClose}
        onLaunch={onLaunch}
        onTicket={onTicket}
      />
    );
  }

  const body = document.querySelector<HTMLElement>(`[data-testid="panel-body-${state.panelId}"]`);
  const draft: TicketDraft = {
    panelId: state.panelId,
    screenState: collectScreenState(body),
    ...(frame?.fn == null ? {} : { functionCode: frame.fn }),
    ...(frame?.security?.id == null ? {} : { security: { id: frame.security.id } }),
    ...(frame?.params === undefined ? {} : { params: frame.params }),
    ...(frame?.traceId === undefined || frame.traceId === '' ? {} : { traceId: frame.traceId }),
    ...(frame?.error === undefined
      ? {}
      : { lastError: { code: frame.error.code, message: frame.error.message } }),
  };

  return (
    <TicketDialog
      draft={draft}
      sdk={sdk}
      onClose={onClose}
      onOpened={() => {
        // The server opens a room for the ticket. `MSG` on that room is CLIENT §3.4's next step and
        // needs the room addressing of `MSG`'s param grammar, which nothing in this file can spell
        // correctly without guessing; closing the dialog is what is certainly right.
        onClose();
      }}
    />
  );
}
