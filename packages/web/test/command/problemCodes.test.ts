// packages/web/test/command/problemCodes.test.ts — what the desk is told when a RUN fails, as
// opposed to when a command was mistyped (CONTRACTS §4.1 L976, FUNC-02, OPS-07).
//
// `CommandProblem.code` is a closed set of eight words and every one of them is a statement about
// the command line. `problemFor` mapped two server codes onto it and fell through to `'ARG_PARSE'`
// for the rest, so a `500` on a command with no arguments at all read, in the footer of the panel
// and on the command line, as an argument-parse error:
//
//     SRCH <GO>  →  POST /functions/SRCH/run → 500 {"code":"INTERNAL"}
//                →  ARG_PARSE · SRCH failed. · trace a13fd835
//
// Driving the terminal is what found it, and the cost is not cosmetic: a wrong code sends the next
// reader to `core/command/args.ts` when the fault is in a resolver. The same `problemFor` is on
// `executeFrame`'s path, added for the workspace restore, so a restored panel that 500s would have
// accused the stored layout of a syntax error too.
//
// Two channels, two vocabularies, asserted together because the fix is only right if both hold:
//
//   * `Frame.error.code` — the panel footer — carries the SERVER'S code verbatim. It is free-form
//     (`App.tsx` writes `VALIDATION_FAILED` into it for a malformed envelope, which is not a
//     `CommandProblem` code either), so nothing is lost there.
//   * `CommandProblem.code` — the command line — stays inside the closed set, and says `ARG_PARSE`
//     only where the arguments really were the problem.
//
// The harness is deliberately small and local: the point of each case is one `Promise.reject`, so a
// shared registry-backed fixture would add nothing an `AppError` shape does not already say.

import { registry, UniverseIndex, type CommandProblem, type PanelContext } from '@terminal/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeOutcome } from '../../src/App.js';
import {
  executeText,
  type DispatchDeps,
  type DispatchOutcome,
  type DispatchSdk,
  type Frame,
  type FramePatch,
  type PanelsPort,
} from '../../src/command/dispatch.js';
import { usePanelsStore } from '../../src/state/panels.js';

const index = UniverseIndex.build({
  version: 'test',
  generatedAt: '2026-09-24T12:00:00.000Z',
  instruments: [[1000, 'AAPL', 'Equity', 'US', 'Apple Inc', 'equity', 1, 1]],
  functions: [],
  people: [],
  topics: [],
});

const APPLE: NonNullable<PanelContext['security']> = {
  instrumentId: 1000,
  assetClass: 'equity',
  marketSector: 'Equity',
  display: 'AAPL US Equity',
};

class Panels implements PanelsPort {
  readonly frames: Frame[] = [];
  readonly patches: FramePatch[] = [];
  problem: CommandProblem | null = null;

  context(panelId: string): PanelContext | undefined {
    return panelId === 'p1' ? { security: APPLE, fn: null, params: {} } : undefined;
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
  pushHistory(): void {
    /* not asserted here */
  }
  setDraft(): void {
    /* not asserted here */
  }
  setProblem(_panelId: string, problem: CommandProblem | null): void {
    this.problem = problem;
  }
}

/**
 * Deps whose `fn.run` always rejects with `error`.
 *
 * `Error` throughout, never a bare object: `TerminalApiError` is an `Error` with `code`/`details`
 * added, so a fixture rejecting with anything else would let `problemFor` read a shape the SDK never
 * produces.
 */
function failingDeps(error: Error): { deps: DispatchDeps; panels: Panels } {
  const panels = new Panels();
  const sdk: DispatchSdk = {
    fn: {
      run: () => Promise.reject(error),
      page: () => Promise.reject(error),
    },
    usage: { events: () => Promise.resolve(undefined) },
  };
  const deps: DispatchDeps = {
    sdk,
    panels,
    usage: { push: () => undefined },
    registry,
    lookupTicker: (tokens, opts) => index.lookupTicker(tokens, opts),
    traceId: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    clock: () => 0,
    shell: () => undefined,
  };
  return { deps, panels };
}

function apiError(code: string, message: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), details === undefined ? { code } : { code, details });
}

async function failureOf(error: Error): Promise<{
  problem: CommandProblem;
  errorCode: string;
  errorMessage: string;
  outcome: Extract<DispatchOutcome, { kind: 'failed' }>;
}> {
  const { deps, panels } = failingDeps(error);
  const outcome = await executeText(deps, 'p1', 'GP');
  expect(outcome.kind, JSON.stringify(outcome)).toBe('failed');
  if (outcome.kind !== 'failed') throw new Error('unreachable');
  // The command line's copy and the outcome's copy must be the same object's contents; a fix that
  // only corrected one of the two would leave the user reading the wrong word somewhere.
  expect(panels.problem).toEqual(outcome.problem);
  return {
    problem: outcome.problem,
    errorCode: outcome.errorCode,
    errorMessage: outcome.errorMessage,
    outcome,
  };
}

/**
 * What the PANEL FOOTER ends up saying, through the real `App.tsx` writer and the real panels store.
 *
 * The outcome is the one the dispatcher above actually produced, never a hand-built object: an
 * assertion over a shape no code path emits proves nothing about the shape that is emitted.
 */
function footerFor(outcome: Extract<DispatchOutcome, { kind: 'failed' }>): {
  code: string;
  message: string;
} {
  const store = usePanelsStore.getState();
  store.pushFrame('p1', {
    security: null,
    fn: 'GP',
    params: {},
    resultId: null,
    scroll: 0,
    traceId: outcome.traceId,
    status: 'loading',
  });
  writeOutcome('p1', outcome);
  const panel = usePanelsStore.getState().panels.p1;
  const frame = panel === undefined ? undefined : panel.frameStack[panel.index];
  expect(frame?.status, 'the frame was not marked failed').toBe('error');
  return { code: frame?.error?.code ?? '', message: frame?.error?.message ?? '' };
}

beforeEach(() => {
  usePanelsStore.getState().reset();
});

afterEach(() => {
  usePanelsStore.getState().reset();
});

describe('a server failure is not an argument-parse problem', () => {
  it('reports INTERNAL as itself in the footer and never as ARG_PARSE on the line', async () => {
    const { problem, errorCode, outcome } = await failureOf(apiError('INTERNAL', 'SRCH failed.'));

    expect(errorCode, 'the panel footer must name what actually went wrong').toBe('INTERNAL');
    // …and it is the footer that must show it. `Panel.tsx` prints `frame.error.code` verbatim, and
    // this is the line the auditor read as `ARG_PARSE · SRCH failed. · trace a13fd835`.
    const footer = footerFor(outcome);
    expect(footer.code).toBe('INTERNAL');
    // ONCE, not twice. The footer renders `code · message`, and the command line's message carries
    // the code in front of it, so writing that message here produced `INTERNAL · INTERNAL · SRCH
    // failed.` — measured in the browser on a forced 500.
    expect(footer.message).toBe('SRCH failed.');
    expect(problem.code).not.toBe('ARG_PARSE');
    expect(problem.code).toBe('NOT_APPLICABLE');
    // The code is never lost: the closed set has no word for it, so it leads the message instead.
    expect(problem.message).toBe('INTERNAL · SRCH failed.');
  });

  it('keeps the same rule for a provider outage and a rate limit', async () => {
    for (const code of ['PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'RESULT_EXPIRED'] as const) {
      const { problem, errorCode } = await failureOf(apiError(code, 'nope'));
      expect(errorCode).toBe(code);
      expect(problem.code, code).not.toBe('ARG_PARSE');
      expect(problem.message, code).toBe(`${code} · nope`);
    }
  });

  it('maps the server codes that really are statements about the command', async () => {
    const cases: readonly [string, CommandProblem['code']][] = [
      ['FUNCTION_NOT_APPLICABLE', 'NOT_APPLICABLE'],
      ['NO_SECURITY_CONTEXT', 'NO_SECURITY_LOADED'],
      ['NOT_IN_UNIVERSE', 'NOT_IN_UNIVERSE'],
      ['SECURITY_NOT_FOUND', 'BAD_IDENTIFIER'],
      ['AMBIGUOUS_SECURITY', 'AMBIGUOUS'],
      ['FUNCTION_NOT_FOUND', 'UNKNOWN_FUNCTION'],
      ['FIELD_UNKNOWN', 'ARG_PARSE'],
    ];
    for (const [api, expected] of cases) {
      const { problem, errorCode } = await failureOf(apiError(api, 'because'));
      expect(problem.code, api).toBe(expected);
      // A mapped code is already the sentence; it is not repeated into the message.
      expect(problem.message, api).toBe('because');
      expect(errorCode, api).toBe(api);
    }
  });

  it("calls a rejected function parameter ARG_PARSE, and only that VALIDATION_FAILED", async () => {
    const fnParams = await failureOf(
      apiError('VALIDATION_FAILED', 'range must be one of 1D…MAX', { location: 'fnParams' }),
    );
    expect(fnParams.problem.code, 'the user really did type a bad argument').toBe('ARG_PARSE');

    // A rejected request body is the client's bug, not the user's, and must not underline a token.
    const body = await failureOf(
      apiError('VALIDATION_FAILED', 'body/panelId must match ^p[1-8]$', { location: 'body' }),
    );
    expect(body.problem.code).toBe('NOT_APPLICABLE');
  });

  it('still describes a failure that did not come from the API at all', async () => {
    const { problem, errorCode } = await failureOf(new TypeError('fetch failed'));
    expect(problem.code).toBe('NOT_APPLICABLE');
    // No code to prepend, so the message is the exception's own and nothing is invented.
    expect(problem.message).toBe('fetch failed');
    expect(errorCode, 'the footer still needs a word, and the failure was ours').toBe('INTERNAL');
  });
});
