// packages/web/test/command/dispatch.test.ts — WP-12 acceptance row (WORKPLAN L1401):
// "the §2.5 context-rule table, frame stack, `fn.launch` event, trace id minting".
//
// The §2.5 table is walked row by row, each row in both of its columns (panel has a security /
// panel is empty), against the **real** function registry and the real parser: `GP`, `RV` and `YAS`
// are asserted here because their manifests carry the asset-class and `requiresSecurity` facts the
// table turns on, and a fixture manifest would let the table pass while the real catalogue failed.
import {
  UniverseIndex,
  registry,
  type CommandProblem,
  type PanelContext,
  type ParsedCommand,
} from '@terminal/core';
import { createClient } from '@terminal/sdk';
import { describe, expect, it } from 'vitest';

import {
  decide,
  execute,
  executeCandidate,
  executeText,
  paramsHash,
  parseCommand,
  runPage,
  runParams,
  sdkUsagePort,
  type DispatchDeps,
  type DispatchSdk,
  type Frame,
  type FramePatch,
  type PanelsPort,
  type UsageEventInput,
} from '../../src/command/dispatch.js';

/* ---------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

const index = UniverseIndex.build({
  version: 'test',
  generatedAt: '2026-09-24T12:00:00.000Z',
  instruments: [
    [1000, 'AAPL', 'Equity', 'US', 'Apple Inc', 'equity', 1, 1],
    [1001, 'MSFT', 'Equity', 'US', 'Microsoft Corp', 'equity', 1, 1],
    [2000, 'T', 'Govt', 'GOVT', 'US Treasury 4.125 2032', 'govt', 1, 1],
  ],
  functions: [],
  people: [],
  topics: [],
});

const lookupTicker: DispatchDeps['lookupTicker'] = (tokens, opts) =>
  index.lookupTicker(tokens, opts);

const APPLE: NonNullable<PanelContext['security']> = {
  instrumentId: 1000,
  assetClass: 'equity',
  marketSector: 'Equity',
  display: 'AAPL US Equity',
};

function panelWith(over: Partial<PanelContext> = {}): PanelContext {
  return { security: null, fn: null, params: {}, ...over };
}

/** A `PanelsPort` over plain objects, recording every call in order. */
class FakePanels implements PanelsPort {
  readonly frames: Frame[] = [];
  readonly patches: FramePatch[] = [];
  readonly history: string[] = [];
  readonly calls: string[] = [];
  problem: CommandProblem | null = null;
  draft = 'AAPL US Eq';
  draftCleared = 0;

  constructor(private readonly panel: PanelContext | undefined) {}

  context(panelId: string): PanelContext | undefined {
    return panelId === 'p1' ? this.panel : undefined;
  }
  frame(): Frame | undefined {
    return this.frames[this.frames.length - 1];
  }
  pushFrame(_panelId: string, frame: Frame): void {
    this.calls.push('pushFrame');
    this.frames.push(frame);
  }
  replaceFrame(_panelId: string, patch: FramePatch): void {
    this.calls.push('replaceFrame');
    this.patches.push(patch);
    const top = this.frames[this.frames.length - 1];
    if (top !== undefined) {
      if (patch.params !== undefined) top.params = patch.params;
      if (patch.resultId !== undefined) top.resultId = patch.resultId;
    }
  }
  pushHistory(_panelId: string, raw: string): void {
    this.calls.push('pushHistory');
    this.history.push(raw);
  }
  setDraft(_panelId: string, value: string): void {
    this.calls.push(value === '' ? 'clearDraft' : 'setDraft');
    this.draft = value;
    if (value === '') this.draftCleared += 1;
  }
  setProblem(_panelId: string, problem: CommandProblem | null): void {
    this.calls.push(problem === null ? 'clearProblem' : 'setProblem');
    this.problem = problem;
  }
}

interface RunCall {
  code: string;
  body: { security?: unknown; params: Record<string, unknown>; panelId?: string; launchKind: string };
  traceId: string | undefined;
}

function fakeSdk(): { sdk: DispatchSdk; runs: RunCall[]; pages: RunCall[] } {
  const runs: RunCall[] = [];
  const pages: RunCall[] = [];
  const sdk: DispatchSdk = {
    fn: {
      run(args, init) {
        runs.push({
          code: args.params.code,
          body: args.body as RunCall['body'],
          traceId: init?.traceId,
        });
        return Promise.resolve({ data: { variant: 'x' }, meta: { resultId: 'result-1' } });
      },
      page(args, init) {
        pages.push({
          code: args.params.code,
          body: args.body as RunCall['body'],
          traceId: init?.traceId,
        });
        return Promise.resolve({ data: {}, meta: { resultId: 'result-2' } });
      },
    },
    usage: {
      events: () => Promise.resolve(undefined),
    },
  };
  return { sdk, runs, pages };
}

function depsFor(panel: PanelContext | undefined): {
  deps: DispatchDeps;
  panels: FakePanels;
  runs: RunCall[];
  pages: RunCall[];
  events: UsageEventInput[];
  shell: [string, string[]][];
} {
  const panels = new FakePanels(panel);
  const { sdk, runs, pages } = fakeSdk();
  const events: UsageEventInput[] = [];
  const shell: [string, string[]][] = [];
  let tick = 0;
  const deps: DispatchDeps = {
    sdk,
    panels,
    usage: { push: (event) => events.push(event) },
    registry,
    lookupTicker,
    traceId: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    clock: () => {
      tick += 7;
      return tick;
    },
    shell: (word, args) => shell.push([word, args]),
  };
  return { deps, panels, runs, pages, events, shell };
}

/**
 * Parse `raw` the way the command line does, so `decide` is fed a real reading rather than a
 * hand-built `ParsedCommand` that could disagree with the parser.
 */
function reading(raw: string, panel: PanelContext): ParsedCommand {
  const { deps } = depsFor(panel);
  const cmd = parseCommand(deps, 'p1', raw)[0];
  expect(cmd, `no reading for ${raw}`).toBeDefined();
  return cmd!;
}

/* ---------------------------------------------------------------------------------------------- */

describe('dispatch — the §2.5 context-rule table, panel WITH a security', () => {
  const panel = panelWith({ security: APPLE, fn: 'GP', params: { range: '5Y' } });

  it('function: runs it on the panel’s current security', () => {
    const cmd = reading('HP', panel);
    const decision = decide(cmd, panel, registry, { lookupTicker });

    expect(decision).toMatchObject({ kind: 'run', code: 'HP', security: { id: 1000 } });
  });

  it("function with assetClasses:'none': ignores the panel’s security", () => {
    const cmd = reading('TOP', panel);
    const decision = decide(cmd, panel, registry, { lookupTicker });

    expect(decision).toMatchObject({ kind: 'run', code: 'TOP', security: null });
  });

  it('function not applicable to the loaded asset class: a problem, and it is NOT sent', async () => {
    const { deps, panels, runs } = depsFor(panel);
    const outcome = await executeText(deps, 'p1', 'YAS');

    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.problem.code).toBe('NOT_APPLICABLE');
    expect(runs).toHaveLength(0);
    expect(panels.frames).toHaveLength(0);
    expect(panels.problem?.message).toContain('YAS');
  });

  it('security: keeps the panel’s function and its params, on the new security', () => {
    const cmd = reading('MSFT US Equity', panel);
    const decision = decide(cmd, panel, registry, { lookupTicker });

    expect(decision).toMatchObject({ kind: 'run', code: 'GP', security: { id: 1001 } });
    expect(decision.kind === 'run' && decision.params.range).toBe('5Y');
  });

  it('security whose asset class the panel’s function does not cover: falls back to DES', () => {
    const rvPanel = panelWith({ security: APPLE, fn: 'RV', params: {} });
    const cmd = reading('T Govt', rvPanel);
    const decision = decide(cmd, rvPanel, registry, { lookupTicker });

    expect(decision).toMatchObject({ kind: 'run', code: 'DES', security: { id: 2000 } });
  });

  it('security+function: both replaced, and the panel’s previous params do NOT carry over', () => {
    const cmd = reading('MSFT US Equity GP', panel);
    const decision = decide(cmd, panel, registry, { lookupTicker });

    expect(decision).toMatchObject({ kind: 'run', code: 'GP', security: { id: 1001 } });
    // The panel was on `range: '5Y'`; §2.5 L779 says args merge over the *manifest* defaults only.
    expect(decision.kind === 'run' && decision.params.range).not.toBe('5Y');
  });

  it('security+function with args: the args merge over the manifest defaults', () => {
    const cmd = reading('MSFT US Equity GP 1Y', panel);
    const decision = decide(cmd, panel, registry, { lookupTicker });

    expect(decision.kind === 'run' && decision.params.range).toBe('1Y');
  });
});

describe('dispatch — the §2.5 context-rule table, panel EMPTY', () => {
  const panel = panelWith();

  it('function that requires a security: NO SECURITY LOADED, and SECF is offered', async () => {
    const { deps, panels, runs } = depsFor(panel);
    const outcome = await executeText(deps, 'p1', 'GP');

    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.problem.code).toBe('NO_SECURITY_LOADED');
    expect(outcome.kind === 'rejected' && outcome.suggest).toBe('SECF GP');
    expect(runs).toHaveLength(0);
    expect(panels.frames).toHaveLength(0);
  });

  it('function that does not require one: runs with no security', () => {
    const cmd = reading('TOP', panel);
    const decision = decide(cmd, panel, registry, { lookupTicker });

    expect(decision).toMatchObject({ kind: 'run', code: 'TOP', security: null });
  });

  it('security alone: runs DES', () => {
    const cmd = reading('AAPL US Equity', panel);
    const decision = decide(cmd, panel, registry, { lookupTicker });

    expect(decision).toMatchObject({ kind: 'run', code: 'DES', security: { id: 1000 } });
  });

  it('security+function: both are taken from the command line', () => {
    const cmd = reading('AAPL US Equity HP', panel);
    const decision = decide(cmd, panel, registry, { lookupTicker });

    expect(decision).toMatchObject({ kind: 'run', code: 'HP', security: { id: 1000 } });
  });

  it('shell: never reaches the function parser, and runs no function', async () => {
    const { deps, panels, runs, shell } = depsFor(panel);
    const outcome = await executeText(deps, 'p1', '/layout 4');

    expect(outcome).toEqual({ kind: 'shell', word: 'layout', args: ['4'] });
    expect(shell).toEqual([['layout', ['4']]]);
    expect(runs).toHaveLength(0);
    expect(panels.frames).toHaveLength(0);
    // §2.5 L783: an executed command still clears the draft and is remembered.
    expect(panels.history).toEqual(['/layout 4']);
    expect(panels.draftCleared).toBe(1);
  });

  it('help: opens the overlay instead of running a function', async () => {
    const { deps, runs, events } = depsFor(panel);
    const helped: { code?: string }[] = [];
    const outcome = await executeText({ ...deps, help: (spec) => helped.push(spec) }, 'p1', 'HELP GP');

    expect(outcome.kind).toBe('help');
    expect(helped).toHaveLength(1);
    expect(runs).toHaveLength(0);
    expect(events.map((e) => e.kind)).toContain('fn.help');
  });
});

describe('dispatch — the frame stack (§2.5 L781-786)', () => {
  it('pushes one frame, appends the history and clears the draft BEFORE the run answers', async () => {
    const panel = panelWith({ security: APPLE, fn: null, params: {} });
    const { deps, panels, runs } = depsFor(panel);

    const outcome = await executeText(deps, 'p1', 'HP');

    expect(outcome.kind).toBe('ran');
    expect(panels.frames).toHaveLength(1);
    // The frame, the history and the draft all land before the request: the panel can paint a
    // skeleton while the function runs.
    expect(panels.calls.slice(0, 4)).toEqual([
      'clearProblem',
      'pushFrame',
      'pushHistory',
      'clearDraft',
    ]);
    expect(panels.history).toEqual(['HP']);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.body.panelId).toBe('p1');
    expect(runs[0]?.body.launchKind).toBe('launch');
  });

  it('records the frame with resultId null and fills it from the payload', async () => {
    const panel = panelWith({ security: APPLE });
    const { deps, panels } = depsFor(panel);

    const outcome = await executeText(deps, 'p1', 'HP');

    // What was pushed carried no result yet…
    expect(panels.frames[0]?.fn).toBe('HP');
    expect(panels.frames[0]?.security).toEqual({ id: 1000, display: 'AAPL US Equity' });
    expect(panels.frames[0]?.scroll).toBe(0);
    // …and the result id arrived as a patch, not as a second frame.
    expect(panels.patches).toEqual([{ resultId: 'result-1' }]);
    expect(panels.frames).toHaveLength(1);
    expect(outcome.kind === 'ran' && outcome.resultId).toBe('result-1');
  });

  it('a param change replaces params and resultId in place — no new frame, no history', async () => {
    const panel = panelWith({ security: APPLE });
    const { deps, panels, runs, events } = depsFor(panel);
    await executeText(deps, 'p1', 'GP 1Y');
    const framesAfterLaunch = panels.frames.length;
    const historyAfterLaunch = panels.history.length;

    const outcome = await runParams(deps, 'p1', { range: '5Y' });

    expect(outcome.kind).toBe('ran');
    expect(panels.frames).toHaveLength(framesAfterLaunch);
    expect(panels.history).toHaveLength(historyAfterLaunch);
    expect(panels.frames[0]?.params.range).toBe('5Y');
    expect(runs[1]?.body.launchKind).toBe('param');
    // Same frame, same trace id (§2.5 L785).
    expect(runs[1]?.traceId).toBe(runs[0]?.traceId);
    expect(events.map((e) => e.kind)).toEqual(['fn.launch', 'fn.param']);
  });

  it('a page run likewise replaces the resultId in place', async () => {
    const panel = panelWith({ security: APPLE });
    const { deps, panels, pages, events } = depsFor(panel);
    await executeText(deps, 'p1', 'GP');

    const outcome = await runPage(deps, 'p1', 'fwd');

    expect(outcome.kind === 'ran' && outcome.resultId).toBe('result-2');
    expect(panels.frames).toHaveLength(1);
    expect(pages[0]?.body).toMatchObject({ resultId: 'result-1', direction: 'fwd' });
    expect(events.map((e) => e.kind)).toEqual(['fn.launch', 'fn.page']);
  });

  it('refuses to page a screen that has no result yet', async () => {
    const { deps } = depsFor(panelWith({ security: APPLE }));
    const outcome = await runPage(deps, 'p1', 'fwd');
    expect(outcome.kind).toBe('rejected');
  });

  it('a run that the server rejects leaves the frame and shows the reason', async () => {
    const panel = panelWith({ security: APPLE });
    const { deps, panels } = depsFor(panel);
    const failing: DispatchDeps = {
      ...deps,
      sdk: {
        ...deps.sdk,
        fn: {
          run: () =>
            Promise.reject(
              Object.assign(new Error('GP is not licensed for this security'), {
                code: 'ENTITLEMENT_DENIED',
              }),
            ),
          page: deps.sdk.fn.page.bind(deps.sdk.fn),
        },
      },
    };

    const outcome = await executeText(failing, 'p1', 'GP');

    expect(outcome.kind).toBe('failed');
    expect(panels.frames).toHaveLength(1);
    expect(panels.problem?.message).toContain('not licensed');
  });

  it('rejects a command aimed at a panel that does not exist', async () => {
    const { deps } = depsFor(panelWith({ security: APPLE }));
    const cmd = reading('HP', panelWith({ security: APPLE }));
    const outcome = await execute(deps, 'p9', cmd);
    expect(outcome.kind).toBe('rejected');
  });
});

describe('dispatch — trace id minting and the usage events (§2.5 L784-785, FUNC-04)', () => {
  it('mints one trace id, uses it for the run request, the frame and fn.launch', async () => {
    const panel = panelWith({ security: APPLE });
    const { deps, panels, runs, events } = depsFor(panel);

    const outcome = await executeText(deps, 'p1', 'HP');

    const traceId = outcome.kind === 'ran' ? outcome.traceId : '';
    expect(traceId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(panels.frames[0]?.traceId).toBe(traceId);
    expect(runs[0]?.traceId).toBe(traceId);

    const launch = events.find((e) => e.kind === 'fn.launch');
    expect(launch).toBeDefined();
    expect(launch?.traceId).toBe(traceId);
    expect(launch?.panelId).toBe('p1');
    expect(launch?.code).toBe('HP');
    expect(launch?.instrumentId).toBe(1000);
    expect(launch?.durationMs).toBe(7);
    expect(launch?.paramsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(launch?.paramsHash).toBe(paramsHash(runs[0]!.body.params));
  });

  it('mints a v4 uuid by default, and a different one per action', async () => {
    const panel = panelWith({ security: APPLE });
    const { deps } = depsFor(panel);
    const { traceId: _drop, ...rest } = deps;
    const first = await executeText(rest, 'p1', 'HP');
    const second = await executeText(rest, 'p1', 'HP');

    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(first.kind === 'ran' && first.traceId).toMatch(uuid);
    expect(second.kind === 'ran' && second.traceId).toMatch(uuid);
    expect(first.kind === 'ran' && second.kind === 'ran' && first.traceId === second.traceId).toBe(
      false,
    );
  });

  it('emits search.select when the command came from an autocomplete row', async () => {
    const panel = panelWith();
    const { deps, events } = depsFor(panel);

    await executeCandidate(
      deps,
      'p1',
      {
        kind: 'instrument',
        id: '1000',
        primary: 'AAPL US Equity',
        secondary: 'Apple Inc · Common Stock · US',
        score: 120,
        matchedOn: 'ticker',
        matched: [[0, 4]],
        insertText: 'AAPL US Equity',
        source: 'local',
      },
      { candidateRank: 0, searchLatencyMs: 9.4 },
    );

    const select = events.find((e) => e.kind === 'search.select');
    expect(select).toBeDefined();
    expect(select?.instrumentId).toBe(1000);
    expect(select?.durationMs).toBe(9);
    expect(select?.details).toMatchObject({ kind: 'instrument', id: '1000', rank: 0 });
    // The row's `insertText` is what actually ran: an empty panel plus a security is DES (§2.5).
    const launch = events.find((e) => e.kind === 'fn.launch');
    expect(launch?.code).toBe('DES');
    expect(select?.traceId).toBe(launch?.traceId);
  });

  it('reports a parse problem as cmd.parse_error and sends nothing', async () => {
    const { deps, events, runs } = depsFor(panelWith({ security: APPLE }));
    const outcome = await executeText(deps, 'p1', 'GP TYPE=zigzag');

    expect(outcome.kind).toBe('rejected');
    expect(runs).toHaveLength(0);
    expect(events.map((e) => e.kind)).toEqual(['cmd.parse_error']);
  });

  it('an unknown ticker is still a security: DES runs and the server resolves it (§2.3)', async () => {
    const { deps, runs } = depsFor(panelWith());
    const outcome = await executeText(deps, 'p1', 'ZZZZZ');

    // Not a parse failure: the local index is not the master, so an unrecognised ticker is sent as
    // `{ ref }` for `/ref/resolve` to decide (FUNCTIONS §2.3). An empty panel makes that `DES`.
    expect(outcome.kind).toBe('ran');
    expect(runs[0]?.code).toBe('DES');
    expect(runs[0]?.body.security).toEqual({ ref: 'ZZZZZ' });
  });

  it('posts usage events through the SDK, not by any other path', async () => {
    const posted: { url: string; body: unknown }[] = [];
    const client = createClient({
      baseUrl: 'https://plant.test',
      clientVersion: 'web/test',
      fetch: ((url: string, init?: { body?: unknown }) => {
        const body = typeof init?.body === 'string' ? init.body : '{}';
        posted.push({ url, body: JSON.parse(body) as unknown });
        return Promise.resolve({
          ok: true,
          status: 202,
          headers: {
            get: () => null,
            forEach: () => undefined,
          } as unknown as Headers,
          text: () => Promise.resolve(''),
        } as unknown as Response);
      }) as unknown as typeof fetch,
    });

    const port = sdkUsagePort(client as unknown as DispatchSdk);
    port.push({
      kind: 'fn.launch',
      panelId: 'p1',
      code: 'GP',
      traceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toContain('/api/v1/usage/events');
    expect(posted[0]?.body).toMatchObject({ events: [{ kind: 'fn.launch', code: 'GP' }] });
  });
});
