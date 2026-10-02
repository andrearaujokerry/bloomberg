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
import { fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
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
import { CommandLine } from '../../src/shell/CommandLine.js';
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

async function failureOf(
  error: Error,
  text = 'GP',
): Promise<{
  problem: CommandProblem;
  errorCode: string;
  errorMessage: string;
  outcome: Extract<DispatchOutcome, { kind: 'failed' }>;
}> {
  const { deps, panels } = failingDeps(error);
  const outcome = await executeText(deps, 'p1', text);
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

/**
 * WHAT THE LINE UNDERLINES, through the real `CommandLine`.
 *
 * `CommandProblem.span` is a second claim in the same sentence. The line mirrors the draft, marks
 * `draft.slice(span[0], span[1])` under the caret and appends that token to the message
 * (`shell/CommandLine.tsx` L466-481 and L539-547), so a span is the terminal saying "this is the part
 * you got wrong".
 *
 * The draft it marks is THE CURRENT ONE, captured when the problem arrives — and `App.tsx#onGo`
 * clears the input before the request goes out (L1105, §2.5 L783). So the text under the span when a
 * run fails is whatever the desk has typed SINCE, which is how this was measured in Chrome on slot 7
 * against the seeded universe:
 *
 *     FXC <GO>                     → 500 INTERNAL, FXC: numbers with no provenance … (DATA-10)
 *     AAPL US Equity  (still typing when the answer came back)
 *     → AAP underlined, and the line read `… (DATA-10). — AAP`
 *
 * `AAP` is three characters of the command the user is typing NOW, and the run that failed had
 * nothing to do with it. So the test types the next command before the problem lands, which is the
 * sequence the product produces rather than a component mounted with the text already in it.
 */
function lineFor(problem: CommandProblem, draft: string): { marked: string | null; message: string } {
  // `createElement` rather than JSX: this suite is a `.ts` file, and it is the dispatcher's suite —
  // renaming it to `.tsx` to render one component would move the file the defect is recorded in.
  const { container, rerender, unmount } = render(
    createElement(CommandLine, { panelId: 'p1', problem: null }),
  );
  const input = container.querySelector('input');
  expect(input, 'the command line rendered no input').not.toBeNull();
  // The next command, typed into the uncontrolled input the way the user types it. `''` is the other
  // real case — GO has just cleared the line and nothing has been typed yet.
  if (input !== null && draft !== '') fireEvent.input(input, { target: { value: draft } });
  rerender(createElement(CommandLine, { panelId: 'p1', problem }));
  const mark = container.querySelector('.cmd__span');
  const line = {
    marked: mark === null ? null : mark.textContent,
    message: container.querySelector('.cmd__problem')?.textContent ?? '',
  };
  unmount();
  return line;
}

describe('the underline is a claim about the typed text too', () => {
  it('underlines nothing and names no token when the failure was the server\u2019s own', async () => {
    // The WEI case verbatim: delete the seeded `md_lines` for the four index subjects and the DATA-10
    // guard in `functions/runner.ts` refuses the whole run with an `INTERNAL`. The refusal is right —
    // the screen may not print a number it cannot cite — and the three characters `WEI` are the one
    // part of that command that was certainly correct. `FXC` answers the same way on the seeded
    // universe today, which is how this was driven in the browser.
    const { problem } = await failureOf(
      apiError(
        'INTERNAL',
        'WEI: numbers with no provenance and no engine: historySessions (DATA-10).',
      ),
      'WEI',
    );
    const line = lineFor(problem, 'AAPL US Equity');

    expect(line.marked, 'the command line underlined the command being typed now').toBe('');
    expect(problem.span, 'a server fault has no token to point at').toEqual([0, 0]);
    expect(line.message).toBe(
      'NOT_APPLICABLE: INTERNAL \u00b7 WEI: numbers with no provenance and no engine: historySessions (DATA-10).',
    );
  });

  it('withdraws it for a rejected request body and for a dead connection', async () => {
    const body = await failureOf(
      apiError('VALIDATION_FAILED', 'body/panelId must match ^p[1-8]$', { location: 'body' }),
    );
    expect(
      lineFor(body.problem, 'AAPL US Equity').marked,
      'this client sent the bad field, not the user',
    ).toBe('');
    expect(body.problem.span).toEqual([0, 0]);

    const offline = await failureOf(new TypeError('fetch failed'));
    expect(offline.problem.span).toEqual([0, 0]);
    expect(lineFor(offline.problem, 'AAPL US Equity').message).toBe('NOT_APPLICABLE: fetch failed');
  });

  it('underlines nothing even for the codes that ARE answering about the command', async () => {
    // THE REPAIR, and the case that used to be the exception. A rejected function argument and an
    // inapplicable function are both statements about what was typed, so `problemFor` used to keep the
    // caller's span for them — `[0, 2]`, the function token's own offsets in `'GP'`. The span is not a
    // statement though, it is an INDEX INTO A STRING, and the string is gone: `App.tsx#onGo` calls
    // `commandLines.current.get(panelId)?.clear()` unconditionally and BEFORE the request goes out
    // (L1095-1105, CLIENT §2.5 L783), and `CommandLine.tsx` L399-403 captures the draft the input holds
    // WHEN THE PROBLEM ARRIVES. So the text a run's span lands in is empty, or it is the next command.
    //
    // Driven in Chrome on slot 6 before it was written here, with the span restored and then removed,
    // because the race needs a real network round trip to produce: `ZZZZ US Equity DES <GO>` with
    // `AAPL US Equity` typed while it was in flight read
    //
    //     BAD_IDENTIFIER: nothing resolves 'ZZZZ US Equity' — AA        mark "AA"
    //
    // and reads `BAD_IDENTIFIER: nothing resolves 'ZZZZ US Equity'` with an empty mark now. `AA` is two
    // characters of the command the desk is typing, on a line about a command that has already failed.
    // (`AAPL US Equity YAS` is NOT this case and was the first thing tried: `decide()` refuses that one
    // locally, before any request, so its span is a parse-time span and points at real text.)
    //
    // Both drafts are exercised here, through the real `CommandLine`, and neither may produce a mark.
    for (const error of [
      apiError('VALIDATION_FAILED', 'range must be one of 1D\u2026MAX', { location: 'fnParams' }),
      apiError('FUNCTION_NOT_APPLICABLE', 'GP does not apply to a money-market instrument'),
      apiError('NO_SECURITY_CONTEXT', 'GP needs a security'),
      apiError('SECURITY_NOT_FOUND', "nothing resolves 'ZZZZ US Equity'"),
    ]) {
      const { problem } = await failureOf(error);
      expect(problem.span, error.message).toEqual([0, 0]);

      // (a) GO has just cleared the line and nothing has been typed: an empty mark, no token.
      const quiet = lineFor(problem, '');
      expect(quiet.marked, error.message).toBe('');
      expect(quiet.message, error.message).toBe(`${problem.code}: ${problem.message}`);

      // (b) the desk is already typing the next command when the answer lands — the false accusation
      // this withdrew. `AAP` was underlined and appended here; now nothing is.
      const busy = lineFor(problem, 'AAPL US Equity');
      expect(busy.marked, error.message).toBe('');
      expect(busy.message, error.message).toBe(`${problem.code}: ${problem.message}`);
    }
  });

  it('still says WHICH kind of failure it was, which is the channel that can carry it', async () => {
    // Without this the suite above would be the "identity the arithmetic forced" from this build's
    // catalogue: once every span is `[0, 0]`, asserting `[0, 0]` proves nothing on its own. The CODE is
    // what the repair deliberately did NOT touch, and it still separates the three cases a desk acts on
    // differently — look at what you typed, look at the panel, or neither.
    const argument = await failureOf(
      apiError('VALIDATION_FAILED', 'range must be one of 1D\u2026MAX', { location: 'fnParams' }),
    );
    expect(argument.problem.code).toBe('ARG_PARSE');

    const body = await failureOf(
      apiError('VALIDATION_FAILED', 'body/panelId must match ^p[1-8]$', { location: 'body' }),
    );
    expect(body.problem.code).toBe('NOT_APPLICABLE');

    const security = await failureOf(apiError('NO_SECURITY_CONTEXT', 'GP needs a security'));
    expect(security.problem.code).toBe('NO_SECURITY_LOADED');

    const unknown = await failureOf(apiError('FUNCTION_NOT_FOUND', 'no such function'));
    expect(unknown.problem.code).toBe('UNKNOWN_FUNCTION');

    // Two different API codes under one problem code are still two different messages, so the line a
    // desk reads is not the same line.
    expect(argument.problem.message).not.toBe(body.problem.message);
  });
});
