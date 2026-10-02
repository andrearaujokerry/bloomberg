// packages/web/src/command/dispatch.ts — a reading of the command line becomes a panel action
// (FUNCTIONS.md §2.5 L769-786 the context rules, CLIENT.md §6 L434-470, WORKPLAN L1355-1357).
//
// Two halves, deliberately separated:
//
//   `decide()` is **pure**. Given a `ParsedCommand`, the panel's context and the registry it answers
//   what would run, and nothing else: no clock, no trace id, no store, no request. That is what
//   makes the §2.5 table testable case by case, which is this file's acceptance row.
//
//   `execute()` is the effect: it mints the trace id, pushes the frame, appends the history, clears
//   the draft, sends the run request through the SDK and emits the usage events.
//
// The §2.5 table itself is **not re-implemented here**. `core/command/parser.ts` already owns it in
// `toRunRequest()` — which function runs on which security, when the panel's function survives a new
// security, when it falls back to `DES`, and which params merge over which — and `decide()` calls it.
// A second copy in the web package is exactly the drift FUNCTIONS §2.5 exists to prevent, and the
// merge rule ("args over manifest defaults, never over the panel's previous params") is the kind of
// rule that is silently wrong in a second copy for months.
//
// What this file adds on top of core: the panel-level consequences (§2.5 L781-786) — the frame stack
// with its forward-history truncation, the history ring, the draft, the client-minted `traceId`, the
// in-place replacement for a `param` or `page` run, and the `fn.launch` / `search.select` usage
// events.
//
// `executeFrame()` is the one entry point that does not begin with text. A workspace restore re-runs
// a frame the panel already holds, and the frame — not a display string rebuilt from two of its five
// fields — is what it sends (TERM-05; its docstring carries the defect that made the distinction).
//
// Ports, not imports: `state/panels.ts` and `state/usage.ts` are other files in this work package.
// `PanelsPort` and `UsagePort` are the shapes this module needs; `Shell.tsx` implements them once
// over the real stores, and the tests implement them over plain objects.
//
// IO: the run request and the usage batch go through the injected `@terminal/sdk` client (API-05).
// Arithmetic: none — `paramsHash` is core's `sha256Hex(canonicalJson(...))`, `durationMs` is a clock
// difference, and every applicability decision is core's.
import {
  canonicalJson,
  parse,
  sha256Hex,
  toRunRequest,
  SECURITY_FINDER_FUNCTION,
  type Candidate,
  type CommandProblem,
  type CommandSecurityInput,
  type FunctionRegistry,
  type PanelContext,
  type ParseEnv,
  type ParsedCommand,
} from '@terminal/core';
import type { UsageEvent } from '@terminal/sdk/wire/rest/usage';

/** `packages/core` does not re-export `IsoDate` from its barrel; it is `ParseEnv`'s own field type. */
type IsoDate = NonNullable<ParseEnv['today']>;

/* ---------------------------------------------------------------------------------------------- */
/* The panel model this module touches                                                              */
/* ---------------------------------------------------------------------------------------------- */

/** The security as a frame records it (API.md §5.7 `PanelState`). */
export interface FrameSecurity {
  /** `null` when the security was addressed by ref or formula and has no local instrument id. */
  id: number | null;
  /** `'AAPL US Equity'` — what the panel header and the command line echo. */
  display: string;
  /** The `{ ref }` or `{ formula }` form the run request carried, when it was not an id. */
  ref?: string;
}

/** One entry of a panel's `frameStack` (FUNCTIONS §2.5 L781). */
export interface Frame {
  security: FrameSecurity | null;
  fn: string | null;
  params: Record<string, unknown>;
  /** Filled when the run answers; `null` while it is in flight (§2.5 L781). */
  resultId: string | null;
  scroll: number;
  /** Minted client-side, used for the run request and the `fn.launch` event (§2.5 L784-785). */
  traceId: string;
}

/** An in-place frame edit: a `param` change or a `page` run, which push no new frame (§2.5 L785). */
export interface FramePatch {
  params?: Record<string, unknown>;
  resultId?: string | null;
  scroll?: number;
  traceId?: string;
}

/**
 * What `execute` needs from `state/panels.ts`.
 *
 * `pushFrame` is responsible for truncating any forward history (§2.5 L782) — the store owns the
 * stack index, so the truncation belongs with it and is asserted through this port in the tests.
 *
 * The four mutating members are named as `PanelsStore` names them, so the store satisfies them
 * directly. `context()` and `setProblem()` have no counterpart there: a `PanelContext` is derived
 * from the panel's top frame, and the footer problem line belongs to the command line, so the Shell
 * supplies both when it builds this port.
 */
export interface PanelsPort {
  /** The panel's `PanelContext` as the parser and `decide()` read it; `undefined` if no such panel. */
  context(panelId: string): PanelContext | undefined;
  /** The top frame, for the in-place `param` and `page` paths. */
  frame(panelId: string): Frame | undefined;
  pushFrame(panelId: string, frame: Frame): void;
  replaceFrame(panelId: string, patch: FramePatch): void;
  /** Append raw text to the panel's history ring (≤ 100, §2.5 L783). */
  pushHistory(panelId: string, raw: string): void;
  /** `setDraft(panelId, '')` is §2.5 L783's "clears `commandDraft`". */
  setDraft(panelId: string, value: string): void;
  /** The footer problem line; `null` clears it. */
  setProblem(panelId: string, problem: CommandProblem | null): void;
}

/**
 * What a caller supplies: the wire `UsageEvent` minus the two fields the sink fills in — `ts` is
 * stamped where the event is queued, `details` defaults to `{}` (API.md §5.13). Derived from the
 * wire schema rather than re-typed, and spelled exactly as `state/usage.ts` spells it, so the store
 * **is** a `UsagePort` with no adapter.
 */
export type UsageEventInput = Omit<UsageEvent, 'ts' | 'details'> & {
  details?: Record<string, unknown>;
};

/** What `execute` needs from `state/usage.ts` (which batches: 5 s / 100 events, CLIENT §8). */
export interface UsagePort {
  push(event: UsageEventInput): void;
}

/** The slice of the SDK client this module calls. */
export interface DispatchSdk {
  fn: {
    run(args: { params: { code: string }; body: unknown }, init?: { traceId?: string }): Promise<unknown>;
    page(
      args: { params: { code: string }; body: unknown },
      init?: { traceId?: string },
    ): Promise<unknown>;
  };
  usage: {
    events(args: { body: { events: UsageEvent[] } }): Promise<unknown>;
  };
}

/**
 * A `UsagePort` that posts straight through the SDK, one batch of one.
 *
 * `state/usage.ts` replaces it with the batching store; this exists so that dispatch is usable —
 * and testable — on its own, and so that "emitted through the SDK" is true by construction.
 */
export function sdkUsagePort(
  sdk: DispatchSdk,
  options: { now?: () => number; onError?: (error: unknown) => void } = {},
): UsagePort {
  return {
    push(event) {
      const stamped: UsageEvent = {
        ...event,
        details: event.details ?? {},
        ts: new Date(options.now?.() ?? Date.now()).toISOString(),
      };
      void sdk.usage.events({ body: { events: [stamped] } }).catch((error: unknown) => {
        // Telemetry never fails a user action.
        options.onError?.(error);
      });
    },
  };
}

export interface DispatchDeps {
  sdk: DispatchSdk;
  panels: PanelsPort;
  usage: UsagePort;
  registry: FunctionRegistry;
  /** `ParseEnv.lookupTicker` — the bound one from `LocalUniverseIndex`. */
  lookupTicker: ParseEnv['lookupTicker'];
  /** Defaults to `crypto.randomUUID()`; one id per user action (OPS-07, §2.5 L784). */
  traceId?: () => string;
  /** Monotonic milliseconds, for `durationMs`. */
  clock?: () => number;
  /** Today in the exchange calendar, for the `TODAY` / `T-<n>` argument syntaxes (§2.4). */
  today?: IsoDate;
  /** Shell commands (§2.6) act on the stores; the Shell supplies this. */
  shell?: (word: string, args: string[]) => void;
  /** `HELP` (§4) opens the overlay; the Shell supplies this. */
  help?: (spec: { code?: string; query?: string }) => void;
  onError?: (error: unknown) => void;
}

/* ---------------------------------------------------------------------------------------------- */
/* decide — the pure half (FUNCTIONS §2.5, CLIENT §6)                                               */
/* ---------------------------------------------------------------------------------------------- */

export type Decision =
  | {
      kind: 'run';
      code: string;
      alias?: string;
      /** `null` when the function takes no security (`assetClasses: 'none'`) or none is loaded. */
      security: CommandSecurityInput | null;
      params: Record<string, unknown>;
      /** `false` only for the in-place `param` / `page` paths (§2.5 L785). */
      newFrame: boolean;
    }
  | { kind: 'shell'; word: string; args: string[] }
  | { kind: 'help'; code?: string; query?: string }
  | {
      kind: 'error';
      problem: CommandProblem;
      /** `NO_SECURITY_LOADED` → what the autocomplete offers instead (§2.5 L777). */
      suggest?: string;
    };

export interface DecideOptions {
  /** Copied into the run request for `usage_events.panel_id` (API.md §5.3). */
  panelId?: string;
  today?: IsoDate;
  /** Only needed for the `TODAY` argument syntaxes; the parser has already run without it. */
  lookupTicker?: ParseEnv['lookupTicker'];
}

const NO_LOOKUP: ParseEnv['lookupTicker'] = () => [];

/**
 * The §2.5 table, decided.
 *
 * Every row is delegated to `toRunRequest`, which is the single implementation of the table
 * (see the module header). What is added here is the shell and help shapes, which run no function,
 * and the `SECF <text>` suggestion the footer shows beside a `NO_SECURITY_LOADED` problem.
 */
export function decide(
  cmd: ParsedCommand,
  panel: PanelContext,
  registry: FunctionRegistry,
  options: DecideOptions = {},
): Decision {
  if (cmd.shape === 'shell') {
    const shell = cmd.shell;
    return shell === undefined
      ? { kind: 'error', problem: firstProblem(cmd, 'a shell command was expected') }
      : { kind: 'shell', word: shell.word, args: [...shell.args] };
  }

  if (cmd.shape === 'help') {
    const help = cmd.help ?? {};
    return {
      kind: 'help',
      ...(help.code === undefined ? {} : { code: help.code }),
      ...(help.query === undefined ? {} : { query: help.query }),
    };
  }

  const env: ParseEnv = {
    registry,
    panel,
    lookupTicker: options.lookupTicker ?? NO_LOOKUP,
    ...(options.today === undefined ? {} : { today: options.today }),
    ...(options.panelId === undefined ? {} : { panelId: options.panelId }),
  };

  // A reading that carries a problem is **not sent** (FUNCTIONS §2.7's table: "`NOT_APPLICABLE`
  // problem … not sent"). This matters beyond the applicability rows: the parser reports a bad
  // argument as `ARG_PARSE` and *drops* it, so `GP TYPE=zigzag` would otherwise run GP with the
  // default chart type — the command silently doing something other than what was typed, which is
  // worse than refusing. `AMBIGUOUS` is the exception: it means several readings exist and this one
  // is the ranked choice, which is exactly what GO is defined to execute (§3.3 L958-962).
  const blocking = cmd.problems.find((p) => p.code !== 'AMBIGUOUS');
  if (blocking !== undefined) return errorDecision(blocking, cmd);

  const request = toRunRequest(cmd, env);
  if ('problem' in request) return errorDecision(request.problem, cmd);

  const security = request.body.security;
  return {
    kind: 'run',
    code: request.code,
    ...(request.alias === undefined ? {} : { alias: request.alias }),
    security: security ?? null,
    params: request.body.params,
    newFrame: true,
  };
}

function errorDecision(problem: CommandProblem, cmd: ParsedCommand): Decision {
  return problem.code === 'NO_SECURITY_LOADED'
    ? { kind: 'error', problem, suggest: securityFinderFor(cmd) }
    : { kind: 'error', problem };
}

/** `SECF <typed text>` — the row the autocomplete offers when no security is loaded (§2.5 L777). */
function securityFinderFor(cmd: ParsedCommand): string {
  const typed = cmd.fn?.code ?? cmd.raw.trim();
  return typed === '' ? SECURITY_FINDER_FUNCTION : `${SECURITY_FINDER_FUNCTION} ${typed}`;
}

function firstProblem(cmd: ParsedCommand, message: string): CommandProblem {
  const existing = cmd.problems[0];
  if (existing !== undefined) return existing;
  return { code: 'ARG_PARSE', span: [0, cmd.raw.length], message };
}

/* ---------------------------------------------------------------------------------------------- */
/* execute — the effect half                                                                        */
/* ---------------------------------------------------------------------------------------------- */

export type DispatchOutcome =
  | {
      kind: 'ran';
      traceId: string;
      code: string;
      frame: Frame;
      /** The function payload, opaque here — the screen registry decodes it. */
      payload: unknown;
      resultId: string | null;
      durationMs: number;
    }
  | {
      kind: 'failed';
      traceId: string;
      code: string;
      problem: CommandProblem;
      /**
       * The SERVER'S own error code — `INTERNAL`, `PROVIDER_UNAVAILABLE`, `RESULT_EXPIRED` — for the
       * panel footer, which is a free-form line (`App.tsx` already writes `VALIDATION_FAILED` there
       * and that is not a `CommandProblem` code either). `problem.code` is the parser's closed set
       * and cannot carry it; see {@link problemFor}.
       */
      errorCode: string;
      /**
       * The server's own message, WITHOUT the code prepended. {@link problemFor} puts the code in
       * front of the command line's message because `CommandProblem.code` has no word for it; the
       * footer prints `errorCode` on its own line already, so prepending it there too gave
       * `INTERNAL · INTERNAL · YAS failed.` — measured in the browser.
       */
      errorMessage: string;
      error: unknown;
    }
  | { kind: 'rejected'; problem: CommandProblem; suggest?: string }
  | { kind: 'shell'; word: string; args: string[] }
  | { kind: 'help'; code?: string; query?: string };

export interface ExecuteOptions {
  /** `'launch'` for a typed GO, `'refresh'` when the workspace re-runs a restored frame (TERM-05). */
  launchKind?: 'launch' | 'refresh';
  /** The autocomplete row this came from; drives the `search.select` event (TERM-02). */
  candidate?: Candidate;
  /** The selected row's index, 0-based. */
  candidateRank?: number;
  /** `cmd:input → ac:paint` for the selected row, when the caller measured it. */
  searchLatencyMs?: number;
  /** The exact text the user typed, when it differs from `cmd.raw`. */
  raw?: string;
}

function defaultTraceId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  // A host without `crypto.randomUUID` still gets a well-formed v4 id: the server's `UsageEvent`
  // schema is `z.uuid()`, and an id that fails validation would drop the whole usage batch.
  const digits = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else {
      const r = Math.floor(Math.random() * 16);
      out += digits[i === 19 ? (r % 4) + 8 : r] ?? '0';
    }
  }
  return out;
}

function defaultClock(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

/** `sha256Hex(canonicalJson(params))` — the server's own `paramsHash` recipe (API.md §5.13). */
export function paramsHash(params: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(params));
}

function frameSecurityOf(
  security: CommandSecurityInput | null,
  cmd: ParsedCommand,
  panel: PanelContext,
): FrameSecurity | null {
  if (security === null) return null;
  if ('id' in security) {
    const display =
      cmd.security?.instrumentId === security.id
        ? cmd.security.text
        : (panel.security?.display ?? String(security.id));
    return { id: security.id, display };
  }
  const ref = 'ref' in security ? security.ref : security.formula;
  return { id: null, display: cmd.security?.text ?? ref, ref };
}

function instrumentIdOf(security: CommandSecurityInput | null): number | undefined {
  return security !== null && 'id' in security ? security.id : undefined;
}

/** Parse `raw` against a panel, with the loader's ticker lookup (CLIENT §4.2). */
export function parseCommand(deps: DispatchDeps, panelId: string, raw: string): ParsedCommand[] {
  const panel = deps.panels.context(panelId) ?? { security: null, fn: null, params: {} };
  return parse(raw, {
    registry: deps.registry,
    panel,
    lookupTicker: deps.lookupTicker,
    ...(deps.today === undefined ? {} : { today: deps.today }),
    panelId,
  });
}

/** GO on raw command-line text: parse, then execute the first reading (§2.6 `Enter`). */
export async function executeText(
  deps: DispatchDeps,
  panelId: string,
  raw: string,
  options: ExecuteOptions = {},
): Promise<DispatchOutcome> {
  const reading = parseCommand(deps, panelId, raw)[0];
  if (reading === undefined) {
    const problem: CommandProblem = {
      code: 'UNKNOWN_FUNCTION',
      span: [0, raw.length],
      message: 'nothing to run',
    };
    deps.panels.setProblem(panelId, problem);
    return { kind: 'rejected', problem };
  }
  return execute(deps, panelId, reading, { ...options, raw });
}

/**
 * GO on a selected autocomplete row (TERM-02): the row's `insertText` is what runs, and the
 * selection is reported as `search.select` alongside whatever the run itself emits.
 */
export function executeCandidate(
  deps: DispatchDeps,
  panelId: string,
  candidate: Candidate,
  options: ExecuteOptions = {},
): Promise<DispatchOutcome> {
  return executeText(deps, panelId, candidate.insertText, { ...options, candidate });
}

/**
 * Run one reading against one panel.
 *
 * Order is deliberate and observable: the frame is pushed, the history appended and the draft
 * cleared **before** the request goes out, so the panel shows the new screen's skeleton while the
 * function runs (the `go → fn:first-paint` budget of CLIENT §16.1 is measured across exactly this).
 */
export async function execute(
  deps: DispatchDeps,
  panelId: string,
  cmd: ParsedCommand,
  options: ExecuteOptions = {},
): Promise<DispatchOutcome> {
  const panel = deps.panels.context(panelId);
  if (panel === undefined) {
    const problem: CommandProblem = {
      code: 'NOT_APPLICABLE',
      span: [0, cmd.raw.length],
      message: `panel ${panelId} does not exist`,
    };
    return { kind: 'rejected', problem };
  }

  const raw = options.raw ?? cmd.raw;
  const decision = decide(cmd, panel, deps.registry, {
    panelId,
    lookupTicker: deps.lookupTicker,
    ...(deps.today === undefined ? {} : { today: deps.today }),
  });

  if (decision.kind === 'shell') {
    deps.panels.pushHistory(panelId, raw);
    deps.panels.setDraft(panelId, '');
    deps.panels.setProblem(panelId, null);
    deps.shell?.(decision.word, decision.args);
    return { kind: 'shell', word: decision.word, args: decision.args };
  }

  if (decision.kind === 'help') {
    deps.panels.pushHistory(panelId, raw);
    deps.panels.setDraft(panelId, '');
    deps.panels.setProblem(panelId, null);
    const spec = {
      ...(decision.code === undefined ? {} : { code: decision.code }),
      ...(decision.query === undefined ? {} : { query: decision.query }),
    };
    deps.help?.(spec);
    emit(deps, {
      kind: 'fn.help',
      panelId,
      ...(decision.code === undefined ? {} : { code: decision.code }),
    });
    return { kind: 'help', ...spec };
  }

  if (decision.kind === 'error') {
    // §2.5: a command that cannot run is **not sent**; the footer carries the reason.
    deps.panels.setProblem(panelId, decision.problem);
    emit(deps, {
      kind: 'cmd.parse_error',
      panelId,
      details: {
        code: decision.problem.code,
        span: decision.problem.span,
        ...(decision.suggest === undefined ? {} : { suggest: decision.suggest }),
      },
    });
    return {
      kind: 'rejected',
      problem: decision.problem,
      ...(decision.suggest === undefined ? {} : { suggest: decision.suggest }),
    };
  }

  const traceId = (deps.traceId ?? defaultTraceId)();
  const clock = deps.clock ?? defaultClock;
  const started = clock();

  const frame: Frame = {
    security: frameSecurityOf(decision.security, cmd, panel),
    fn: decision.code,
    params: decision.params,
    resultId: null,
    scroll: 0,
    traceId,
  };

  deps.panels.setProblem(panelId, null);
  deps.panels.pushFrame(panelId, frame);
  deps.panels.pushHistory(panelId, raw);
  deps.panels.setDraft(panelId, '');

  if (options.candidate !== undefined) {
    emitSearchSelect(deps, panelId, traceId, options);
  }

  const body = {
    ...(decision.security === null ? {} : { security: decision.security }),
    params: decision.params,
    panelId,
    launchKind: options.launchKind ?? 'launch',
  };

  try {
    const payload = await deps.sdk.fn.run({ params: { code: decision.code }, body }, { traceId });
    const durationMs = Math.round(clock() - started);
    const resultId = resultIdOf(payload);
    deps.panels.replaceFrame(panelId, { resultId });
    const instrumentId = instrumentIdOf(decision.security);

    emit(deps, {
      kind: 'fn.launch',
      panelId,
      code: decision.code,
      paramsHash: paramsHash(decision.params),
      durationMs,
      traceId,
      ...(instrumentId === undefined ? {} : { instrumentId }),
      details: {
        launchKind: options.launchKind ?? 'launch',
        clientReported: true,
        ...(decision.alias === undefined ? {} : { alias: decision.alias }),
        ...(options.candidate === undefined ? {} : { source: 'autocomplete' }),
      },
    });

    return {
      kind: 'ran',
      traceId,
      code: decision.code,
      frame: { ...frame, resultId },
      payload,
      resultId,
      durationMs,
    };
  } catch (error) {
    const problem = problemFor(error, decision.code);
    deps.panels.setProblem(panelId, problem);
    deps.onError?.(error);
    return {
      kind: 'failed',
      traceId,
      code: decision.code,
      problem,
      errorCode: apiCodeOf(error) || 'INTERNAL',
      errorMessage: messageOf(error, decision.code),
      error,
    };
  }
}

/**
 * Re-run the frame a panel ALREADY HOLDS, from its own fields — the workspace restore (TERM-05).
 *
 * A restored frame carries its function, its security and its params but no payload: a workspace row
 * is a layout, not a cache (CLIENT §8 L574-577), so the screen has to be re-run to exist. What this
 * function exists to avoid is how that used to be done. `App.tsx#onRestored` rebuilt the display
 * string `"<security> <fn>"` and handed it to {@link executeText}, and a round trip through text
 * loses everything the text does not spell:
 *
 *   * `"SPX Index GP"` re-parses to a REF, not to an instrument id — the local universe index is
 *     keyed on tickers, so `CommandSecurity.instrumentId` is undefined and `parser.ts#securityInput`
 *     falls back to `{ ref }`. A ref-addressed security has no local id, so the frame that was
 *     pushed in place of the restored one anchored NO security, and that frame was then persisted:
 *     the second load of the terminal restored GP with no instrument at all.
 *   * `params` is one of the five persisted fields and is not in the string. A panel saved as
 *     `W Core` — `params: { watchlist: { name: 'Core' } }` — came back as the bare `W`, which is the
 *     manifest's defaults: somebody else's watchlist, in the user's own panel.
 *
 * So nothing here parses anything, and nothing here consults the §2.5 context rules: those rules
 * decide what a NEW command means against the panel it is typed into, and this is not a new command.
 * The frame is the request.
 *
 * Three consequences, each one a thing the text path got wrong:
 *
 *   * **The frame is updated in place — no push.** It is already the top of the stack. A push would
 *     grow the stack by one frame per load (to `MAX_FRAMES`) and leave an idle duplicate of the
 *     screen one Back click away.
 *   * **No history entry and no draft clear.** A restore is not something the user typed. Appending
 *     to the ring fills `PanelState.history` with commands nobody issued — and ArrowUp then recalls
 *     them — while `commandDraft` is persisted precisely so a half-typed line comes back with the
 *     desk.
 *   * **A fresh trace id** (OPS-07, §2.5 L784). A frame restored from a layout carries `traceId: ''`
 *     (`state/panels.ts#fromWireFrame`), and the run header, the `fn.launch` event and the caller's
 *     own "is this answer still for the screen on the display" guard are all keyed on it. `''` would
 *     also fail the server's `z.uuid()` on the usage event and drop the whole batch.
 */
export async function executeFrame(
  deps: DispatchDeps,
  panelId: string,
  options: { launchKind?: 'launch' | 'refresh' } = {},
): Promise<DispatchOutcome> {
  const frame = deps.panels.frame(panelId);
  if (frame?.fn == null) {
    // Not an error the user made: a panel with no function has nothing to restore, and every caller
    // loops over every panel. Rejected silently, with no footer problem.
    const problem: CommandProblem = {
      code: 'NOT_APPLICABLE',
      span: [0, 0],
      message: `panel ${panelId} has no function to re-run`,
    };
    return { kind: 'rejected', problem };
  }

  const code = frame.fn;
  const security = frameSecurityInput(frame.security);
  const launchKind = options.launchKind ?? 'refresh';
  const traceId = (deps.traceId ?? defaultTraceId)();
  const clock = deps.clock ?? defaultClock;
  const started = clock();

  deps.panels.setProblem(panelId, null);
  deps.panels.replaceFrame(panelId, { traceId, resultId: null });

  const body = {
    ...(security === null ? {} : { security }),
    params: frame.params,
    panelId,
    launchKind,
  };

  try {
    const payload = await deps.sdk.fn.run({ params: { code }, body }, { traceId });
    const durationMs = Math.round(clock() - started);
    const resultId = resultIdOf(payload);
    deps.panels.replaceFrame(panelId, { resultId });
    const instrumentId = instrumentIdOf(security);

    emit(deps, {
      kind: 'fn.launch',
      panelId,
      code,
      paramsHash: paramsHash(frame.params),
      durationMs,
      traceId,
      ...(instrumentId === undefined ? {} : { instrumentId }),
      details: { launchKind, clientReported: true },
    });

    return {
      kind: 'ran',
      traceId,
      code,
      frame: { ...frame, traceId, resultId },
      payload,
      resultId,
      durationMs,
    };
  } catch (error) {
    const problem = problemFor(error, code);
    deps.panels.setProblem(panelId, problem);
    deps.onError?.(error);
    return {
      kind: 'failed',
      traceId,
      code,
      problem,
      errorCode: apiCodeOf(error) || 'INTERNAL',
      errorMessage: messageOf(error, code),
      error,
    };
  }
}

/**
 * The frame's own security, as a run request addresses it.
 *
 * `id` first, because that is what the layout persists and what REF-01 anchors a panel to.
 *
 * `ref` is for the frame shape {@link Frame} declares and {@link execute} builds — `id: null` plus a
 * ref, a security addressed by ref or formula on the line that created it. A RESTORED frame is never
 * that shape today: `state/panels.ts#FrameSecurity.id` is `number` and the wire's
 * `PanelState.frameStack[].security` is `{ id, display }`, so a ref-addressed security is not
 * persisted at all. The branch is here because this function's argument is a `dispatch.Frame`,
 * whatever `PanelsPort` supplies it, and dropping a ref the frame is carrying would repeat in a new
 * place exactly the loss this file's restore path exists to stop.
 *
 * A security with neither is not addressable, and the run goes out with no security rather than with
 * a guess: the function answers `NO_SECURITY_CONTEXT` and the footer says so, which is the truth
 * about that frame.
 */
function frameSecurityInput(security: FrameSecurity | null): CommandSecurityInput | null {
  if (security === null) return null;
  if (security.id !== null) return { id: security.id };
  return security.ref === undefined ? null : { ref: security.ref };
}

/**
 * A `param` change (`ScreenCtx.setParams`): the current frame's `params` and `resultId` are replaced
 * **in place** — no new frame, no history entry, no new trace id (§2.5 L785-786).
 */
export async function runParams(
  deps: DispatchDeps,
  panelId: string,
  params: Record<string, unknown>,
): Promise<DispatchOutcome> {
  const frame = deps.panels.frame(panelId);
  if (frame?.fn == null) {
    const problem: CommandProblem = {
      code: 'NOT_APPLICABLE',
      span: [0, 0],
      message: 'no function is loaded in this panel',
    };
    return { kind: 'rejected', problem };
  }

  const clock = deps.clock ?? defaultClock;
  const started = clock();
  const merged = { ...frame.params, ...params };
  deps.panels.replaceFrame(panelId, { params: merged, resultId: null });

  const body = {
    ...(frame.security?.id == null ? {} : { security: { id: frame.security.id } }),
    params: merged,
    panelId,
    launchKind: 'param' as const,
  };

  try {
    const payload = await deps.sdk.fn.run(
      { params: { code: frame.fn }, body },
      { traceId: frame.traceId },
    );
    const resultId = resultIdOf(payload);
    const durationMs = Math.round(clock() - started);
    deps.panels.replaceFrame(panelId, { resultId });
    emit(deps, {
      kind: 'fn.param',
      panelId,
      code: frame.fn,
      paramsHash: paramsHash(merged),
      durationMs,
      traceId: frame.traceId,
      ...(frame.security?.id == null ? {} : { instrumentId: frame.security.id }),
      details: { clientReported: true },
    });
    return {
      kind: 'ran',
      traceId: frame.traceId,
      code: frame.fn,
      frame: { ...frame, params: merged, resultId },
      payload,
      resultId,
      durationMs,
    };
  } catch (error) {
    const problem = problemFor(error, frame.fn);
    deps.panels.setProblem(panelId, problem);
    deps.onError?.(error);
    return {
      kind: 'failed',
      traceId: frame.traceId,
      code: frame.fn,
      problem,
      errorCode: apiCodeOf(error) || 'INTERNAL',
      errorMessage: messageOf(error, frame.fn),
      error,
    };
  }
}

/** PAGE FWD / PAGE BACK (§2.6): a new `resultId` in the same frame, like a `param` change. */
export async function runPage(
  deps: DispatchDeps,
  panelId: string,
  direction: 'fwd' | 'back',
): Promise<DispatchOutcome> {
  const frame = deps.panels.frame(panelId);
  if (frame?.fn == null || frame.resultId === null) {
    const problem: CommandProblem = {
      code: 'NOT_APPLICABLE',
      span: [0, 0],
      message: 'this screen has no page to turn',
    };
    return { kind: 'rejected', problem };
  }

  const clock = deps.clock ?? defaultClock;
  const started = clock();
  try {
    const payload = await deps.sdk.fn.page(
      { params: { code: frame.fn }, body: { resultId: frame.resultId, direction } },
      { traceId: frame.traceId },
    );
    const resultId = resultIdOf(payload);
    deps.panels.replaceFrame(panelId, { resultId });
    const durationMs = Math.round(clock() - started);
    emit(deps, {
      kind: 'fn.page',
      panelId,
      code: frame.fn,
      durationMs,
      traceId: frame.traceId,
      details: { direction, clientReported: true },
    });
    return {
      kind: 'ran',
      traceId: frame.traceId,
      code: frame.fn,
      frame: { ...frame, resultId },
      payload,
      resultId,
      durationMs,
    };
  } catch (error) {
    const problem = problemFor(error, frame.fn);
    deps.panels.setProblem(panelId, problem);
    deps.onError?.(error);
    return {
      kind: 'failed',
      traceId: frame.traceId,
      code: frame.fn,
      problem,
      errorCode: apiCodeOf(error) || 'INTERNAL',
      errorMessage: messageOf(error, frame.fn),
      error,
    };
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Internals                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** Queue one event. The sink stamps `ts`; a broken telemetry sink never fails a user action. */
function emit(deps: DispatchDeps, event: UsageEventInput): void {
  try {
    deps.usage.push(event);
  } catch (error) {
    deps.onError?.(error);
  }
}

function emitSearchSelect(
  deps: DispatchDeps,
  panelId: string,
  traceId: string,
  options: ExecuteOptions,
): void {
  const candidate = options.candidate;
  if (candidate === undefined) return;
  emit(deps, {
    kind: 'search.select',
    panelId,
    traceId,
    ...(candidate.kind === 'function' ? { code: candidate.id } : {}),
    ...(candidate.kind === 'instrument' && Number.isFinite(Number(candidate.id))
      ? { instrumentId: Number(candidate.id) }
      : {}),
    ...(options.searchLatencyMs === undefined
      ? {}
      : { durationMs: Math.round(options.searchLatencyMs) }),
    details: {
      kind: candidate.kind,
      id: candidate.id,
      matchedOn: candidate.matchedOn,
      source: candidate.source,
      score: candidate.score,
      ...(options.candidateRank === undefined ? {} : { rank: options.candidateRank }),
    },
  });
}

function resultIdOf(payload: unknown): string | null {
  const body = payload as { meta?: { resultId?: unknown } } | null;
  const id = body?.meta?.resultId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * The server's `ErrorCode` → the closed set `CommandProblem.code` is (`core/command/parser.ts`,
 * CONTRACTS §4.1 L976).
 *
 * Only the codes that really are a statement about what the user typed map onto a parser code. This
 * function used to map two of them and fall through to `'ARG_PARSE'` for everything else, so the
 * command line accused a command of a syntax error on the strength of a `500`: `SRCH <GO>` — no
 * arguments at all, parsed perfectly — printed `ARG_PARSE: SRCH failed.`, and `WEI` printed
 * `ARG_PARSE: WEI: numbers with no provenance and no engine`. Both sent the next reader to the wrong
 * file, which is the whole cost of a wrong code.
 *
 * `VALIDATION_FAILED` is the one case that is genuinely ambiguous, and `details.location` decides it:
 * `'fnParams'` means the function's own arguments were rejected — an `ARG_PARSE` and nothing else —
 * while a `'body'` or `'query'` failure is the client's bug, not the user's.
 *
 * Everything the closed set has no word for — `INTERNAL`, `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`,
 * `RESULT_EXPIRED` — becomes `'NOT_APPLICABLE'` with the server's code first in the message. That is
 * the convention `App.tsx`'s export path already documents for the same reason: the closed set is a
 * documented contract and adding a `RUN_FAILED` to it is a change to CONTRACTS §4.1 rather than a
 * patch, and of the eight words available `NOT_APPLICABLE` is the only one that does not accuse the
 * user's input of something. The precise code is never lost — it is the first thing in the message,
 * and it is what the panel footer prints on its own line (see {@link DispatchOutcome}).
 */
const PROBLEM_FOR_API_CODE: Readonly<Record<string, CommandProblem['code']>> = Object.freeze({
  FUNCTION_NOT_APPLICABLE: 'NOT_APPLICABLE',
  NO_SECURITY_CONTEXT: 'NO_SECURITY_LOADED',
  NOT_IN_UNIVERSE: 'NOT_IN_UNIVERSE',
  SECURITY_NOT_FOUND: 'BAD_IDENTIFIER',
  AMBIGUOUS_SECURITY: 'AMBIGUOUS',
  FUNCTION_NOT_FOUND: 'UNKNOWN_FUNCTION',
  FIELD_UNKNOWN: 'ARG_PARSE',
});

/** The server's code, or `''` when the failure did not come from the API at all. */
function apiCodeOf(error: unknown): string {
  const apiError = error as { code?: unknown } | null;
  return apiError !== null && typeof apiError.code === 'string' ? apiError.code : '';
}

/** The failure's own sentence — the API error's message, or the exception's. */
function messageOf(error: unknown, code: string): string {
  const apiError = error as { message?: unknown } | null;
  return apiError !== null && typeof apiError.message === 'string' && apiError.message !== ''
    ? apiError.message
    : `${code} failed`;
}

/**
 * THE SPAN IS THE SAME ACCUSATION, IN THE OTHER CHANNEL, AND IT IS WITHDRAWN WITH THE CODE.
 *
 * `CommandProblem.span` is not decoration: the command line mirrors the draft, marks
 * `draft.slice(span[0], span[1])` under the caret, and appends that token to the problem line
 * (`shell/CommandLine.tsx` L466-481, L539-547). A span is the terminal saying "this is the part you
 * got wrong", so correcting a problem's CODE and keeping its span only moves a false claim one
 * channel over.
 *
 * **A run failure has no text to point at, by construction.** `App.tsx#onGo` calls
 * `commandLines.current.get(panelId)?.clear()` unconditionally and BEFORE the request goes out
 * (L1095-1105), because CLIENT §2.5 L783 says a GO clears `commandDraft`; `CommandLine.tsx` L402-404
 * then captures the draft the input holds WHEN THE PROBLEM ARRIVES. So by the time this function runs
 * the command it is about is gone from the line, and the only two things a surviving span can mark are
 * nothing at all, or whatever the desk has typed since. A span is not a statement — it is an INDEX
 * INTO A STRING — and that string no longer exists.
 *
 * Driven in Chrome on slot 6, with the span restored and then removed, because the second case needs a
 * real round trip to produce. `ZZZZ US Equity DES <GO>`, with `AAPL US Equity` typed while the request
 * was in flight:
 *
 *     > AAPL US Equity                                      ← `AA` underlined
 *     BAD_IDENTIFIER: nothing resolves 'ZZZZ US Equity' — AA
 *
 * `AA` is two characters of the command being typed NOW, on a line about a command that has already
 * failed. With the span withdrawn the same sequence reads `BAD_IDENTIFIER: nothing resolves 'ZZZZ US
 * Equity'` and marks nothing. `SECURITY_NOT_FOUND` → `BAD_IDENTIFIER` is one of the seven entries in
 * {@link PROBLEM_FOR_API_CODE}, which is exactly the set an earlier revision of this file kept the
 * span for, on the ground that those answers ARE statements about the command. They are; their spans
 * were not.
 *
 * Two things that look like counter-examples and are not. `AAPL US Equity YAS` was the first thing
 * tried and never reaches here: `decide()` refuses an inapplicable function locally, before any
 * request, so its span is a PARSE-time span. And `FXC <GO>` — refused by the DATA-10 guard with an
 * `INTERNAL` — marked nothing even before this change, because `INTERNAL` is not a mapped code and
 * took the `[0, 0]` branch already. The spans that remain in this file are the parse-time ones (L298,
 * L426, L465, L511), produced synchronously on the keystroke that cleared the line, and those keep
 * pointing at real text.
 *
 * `[0, 0]` is this file's existing word for "no text to blame" — `executeFrame` and the `page()` path
 * always passed it, because a restored frame and a page turn begin with no text at all — and it renders
 * as an empty mark and a message with no token appended. It is now the only answer a run failure gives.
 * The code mapping is untouched and is the part that still carries the distinction: `ARG_PARSE` tells
 * the desk to look at what it typed and `NOT_APPLICABLE` tells it not to.
 *
 * One stale claim is left standing elsewhere and is recorded in `BUILD_STATUS.md`:
 * `CommandLine.tsx` L400-401 says "GO does not clear the draft when the command is refused, so the
 * input still holds exactly that text". It does not, and nothing here depends on it any more.
 */
const NOTHING_TYPED_IS_AT_FAULT: () => [number, number] = () => [0, 0];

/**
 * A failed run becomes a footer problem; the API error's own message is what the desk needs.
 *
 * No `span` parameter, deliberately — see {@link NOTHING_TYPED_IS_AT_FAULT}. A run's answer arrives
 * after the input has been cleared, so there is no draft for a span to index and the only thing one
 * can do is accuse whatever is being typed now. The CODE still distinguishes the cases.
 */
function problemFor(error: unknown, code: string): CommandProblem {
  const apiError = error as { details?: { location?: unknown } } | null;
  const message = messageOf(error, code);
  const apiCode = apiCodeOf(error);
  if (apiCode === 'VALIDATION_FAILED') {
    // A rejected `fnParams` is the user's argument; a rejected body or query string is this client's
    // own request, and the user's text is not what the server was reading. The distinction is worth
    // keeping even with no span to carry it: `ARG_PARSE` tells the desk to look at what it typed and
    // `NOT_APPLICABLE` tells it not to.
    return apiError?.details?.location === 'fnParams'
      ? { code: 'ARG_PARSE', span: NOTHING_TYPED_IS_AT_FAULT(), message }
      : { code: 'NOT_APPLICABLE', span: NOTHING_TYPED_IS_AT_FAULT(), message };
  }
  const mapped = PROBLEM_FOR_API_CODE[apiCode];
  if (mapped !== undefined) {
    return { code: mapped, span: NOTHING_TYPED_IS_AT_FAULT(), message };
  }
  return {
    code: 'NOT_APPLICABLE',
    span: NOTHING_TYPED_IS_AT_FAULT(),
    message: apiCode === '' ? message : `${apiCode} · ${message}`,
  };
}
