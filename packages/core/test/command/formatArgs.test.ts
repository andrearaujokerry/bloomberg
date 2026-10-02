/**
 * packages/core/test/command/formatArgs.test.ts — `formatArgs`, the inverse of `parseArgs`.
 *
 * ## The defect this file is the regression test for
 *
 * `server/src/functions/MSG/resolve.ts` built a chart attachment's click-through command by
 * upper-casing every param name into `KEY=value`, producing `AAPL US Equity GP RANGE=1Y`. `range` is
 * the FIRST POSITIONAL SLOT of `GP.paramGrammar` and its `keyed` map holds TYPE / ADJ / VS / CCY /
 * NORM / PER / LOG and no RANGE, so `parseArgs` answers `ARG_PARSE: RANGE is not an argument of this
 * function`. A chip the user clicks, that cannot be clicked through. The same spelling had already been
 * found and fixed once, in `fixtures/seed/workspaces.json`, by
 * `server/test/unit/seed/workspaceHistory.test.ts` — twice is a missing function, not two mistakes.
 *
 * ## What is asserted, and why the round trip is the assertion
 *
 * The shape of this bug is that the producer and the consumer of a command disagree about a grammar
 * neither of them reads. So the test is not "does `formatArgs` emit the string I expect" — that is the
 * assertion that already passed against the defect, in three places, because each compared the output
 * to a transcription of the same wrong rule. It is: **take params, format them, parse them back, and
 * get the same params.** Run over every shipped manifest, so a grammar added later is covered the day
 * it lands.
 *
 * Where the round trip cannot close, it is asserted NOT to close silently: `formatArgs` reports those
 * keys in `dropped`, and the test checks that every key it loses is a key it names.
 */

import { describe, expect, it } from 'vitest';

import { manifests, registry } from '../../src/functions/manifests/index.js';
import { FunctionRegistry } from '../../src/functions/registry.js';
import { formatArgString, formatArgs, parseArgs } from '../../src/command/args.js';
import type { AnyFunctionManifest, ParamGrammar } from '../../src/functions/manifest.js';
import type { ParseEnv } from '../../src/command/parser.js';

const env: ParseEnv = {
  registry: new FunctionRegistry([]),
  panel: { security: null, fn: null, params: {} },
  lookupTicker: () => [],
  today: '2026-09-17',
};

/** GP's grammar, which is the one the defect was about: three optional positionals, seven keyed. */
const GP_GRAMMAR: ParamGrammar = registry.get('GP')?.paramGrammar ?? { positional: [] };

describe('formatArgs spells a param the way its grammar reads it', () => {
  it('emits a positional slot positionally, not as KEY=value', () => {
    expect(formatArgs(GP_GRAMMAR, { range: '1Y' })).toEqual({ args: ['1Y'], dropped: [] });
    expect(formatArgString(GP_GRAMMAR, { range: '1Y' })).toBe(' 1Y');
    // The spelling the defect produced, stated here so the diff shows what changed.
    expect(formatArgString(GP_GRAMMAR, { range: '1Y' })).not.toContain('RANGE=');
  });

  it('emits a keyed param with the grammar’s own key', () => {
    const { args } = formatArgs(GP_GRAMMAR, { type: 'candle', adjust: 'total_return' });
    expect(args).toContain('TYPE=candle');
    expect(args).toContain('ADJ=total_return');
  });

  it('puts the positionals before the keyed tokens, because position is counted', () => {
    const { args } = formatArgs(GP_GRAMMAR, { type: 'candle', range: '5D' });
    expect(args[0]).toBe('5D');
  });

  it('spells a boolean Y or N, and emits the false one', () => {
    // Dropping a `false` would read as "unset" to a reader and "take the default" to the manifest, and
    // those differ for every param whose default is `true` — GP's `volume` is one.
    expect(formatArgs(GP_GRAMMAR, { logScale: true }).args).toEqual(['LOG=Y']);
    expect(formatArgs(GP_GRAMMAR, { logScale: false }).args).toEqual(['LOG=N']);
  });

  /**
   * THE RULE THAT STOPS THIS WRITING A COMMAND THAT MEANS SOMETHING ELSE.
   *
   * Positions are counted, not named. `{ start, end }` with no `range` cannot be written: the first
   * token would land in the `range` slot (`'2026-01-01'` is not a range word, so `parseArgs` skips the
   * optional slot and it lands in `start` — but `end` would then be `start + 1` and the dates would
   * shift). The run of leading slots that the params cover is emitted and the rest are named.
   */
  it('stops at the first gap in the positional run and says what it dropped', () => {
    const out = formatArgs(GP_GRAMMAR, { end: '2026-01-31' });
    expect(out.args).toEqual([]);
    expect(out.dropped).toContain('end');
  });

  it('emits a run only while every earlier slot has a value', () => {
    const out = formatArgs(GP_GRAMMAR, {
      range: 'CUSTOM',
      start: '2026-01-01',
      end: '2026-01-31',
    });
    expect(out.args).toEqual(['CUSTOM', '2026-01-01', '2026-01-31']);
    expect(out.dropped).toEqual([]);
  });

  /**
   * An array is dropped and named rather than flattened, because a repeated keyed token OVERWRITES in
   * `parseArgs` (`params[spec.name] = coerced.value`) instead of appending. `VS=A VS=B` would read back
   * as `B` alone — a command that parses and charts the wrong overlay, which is worse than one that is
   * honestly missing it.
   */
  it('drops an array rather than emitting a token that round-trips to one element', () => {
    const out = formatArgs(GP_GRAMMAR, { overlays: ['MSFT US Equity', 'SPX Index'] });
    expect(out.args).toEqual([]);
    expect(out.dropped).toContain('overlays');
  });

  it('drops an object, which no single token can carry', () => {
    const out = formatArgs(GP_GRAMMAR, { events: { earnings: true } });
    expect(out.args).toEqual([]);
    expect(out.dropped).toContain('events');
  });

  /**
   * THE SECOND INSTANCE OF THE SAME DEFECT, found by parsing the commands rather than reading them.
   *
   * `MSG/resolve.ts` also emitted `PORT 7` for a portfolio attachment. `portfolioId` is PORT's KEYED
   * `P=` and its one positional is `view` (an enum of `PORT_VIEWS`), so `7` filled nothing and the
   * parser answered `ARG_PARSE: 7 is not an argument of this function` — the chart chip's bug the other
   * way round, in the same file, past the same tests. Both spellings are pinned here, at the grammar,
   * because that is the thing both producers were guessing at.
   */
  it('spells PORT’s portfolio keyed and W’s watchlist positionally', () => {
    const port = registry.get('PORT')?.paramGrammar ?? { positional: [] };
    const w = registry.get('W')?.paramGrammar ?? { positional: [] };
    expect(formatArgString(port, { portfolioId: 7 })).toBe(' P=7');
    expect(formatArgString(port, { portfolioId: 7 })).not.toBe(' 7');
    expect(formatArgString(w, { watchlist: 3 })).toBe(' 3');
    // And both read back, which is the claim the spelling is for.
    expect(parseArgs(port, ['P=7'], env).problems).toEqual([]);
    expect(parseArgs(port, ['7'], env).problems.map((p) => p.code)).toEqual(['ARG_PARSE']);
    expect(parseArgs(w, ['3'], env).problems).toEqual([]);
  });

  it('answers for a grammar that is not one, and for params that are not params', () => {
    // Totality (QA-05): nothing in `args.ts` throws, for any input.
    expect(formatArgs(null as unknown as ParamGrammar, { a: 1 }).args).toEqual([]);
    expect(formatArgs(GP_GRAMMAR, null as unknown as Record<string, unknown>).args).toEqual([]);
    expect(formatArgString(GP_GRAMMAR, {})).toBe('');
  });
});

/* ---------------------------------------------------------------------------------------------- */
/* The round trip, over every shipped grammar                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * One representative value per slot type, so the round trip is driven by the grammar and not by a list
 * of params this file invented. The values are the syntaxes `§2.4`'s coercion table accepts, which is
 * what makes a failure a `formatArgs` failure rather than a bad fixture.
 */
function sampleFor(type: string, values: readonly string[] | undefined): unknown {
  if (values !== undefined && values.length > 0) return values[0];
  switch (type) {
    case 'range':
      return '1Y';
    case 'tenor':
      return '10Y';
    case 'date':
      return '2026-01-15';
    case 'int':
      return 7;
    case 'number':
      return 2.5;
    case 'boolean':
      return true;
    case 'currency':
      return 'EUR';
    case 'field':
      return 'PX_LAST';
    case 'topic':
      return 'TOP';
    case 'curve':
      return 'UST_PAR';
    case 'enum':
    case 'string':
    case 'text':
      return 'alpha';
    // `security` is deliberately absent: a security token is resolved against the universe, and this
    // file's `lookupTicker` answers `[]` on purpose (see `env`). Returning a ticker here would assert
    // the universe rather than the grammar.
    default:
      return null;
  }
}

describe('every shipped grammar round-trips params → tokens → params', () => {
  const CODES = Object.keys(manifests);

  it('has grammars to check', () => {
    // Guards the shape of this file against passing vacuously if the barrel is ever renamed.
    expect(CODES.length).toBeGreaterThanOrEqual(30);
  });

  for (const code of CODES) {
    it(`${code}`, () => {
      const manifest: AnyFunctionManifest | undefined = registry.get(code);
      expect(manifest, code).toBeDefined();
      if (manifest === undefined) return;
      const grammar = manifest.paramGrammar;

      const params: Record<string, unknown> = {};
      for (const slot of grammar.positional) {
        const sample = sampleFor(slot.type, slot.values);
        // A slot this file has no sample for closes the run, so stop filling at the first one: the
        // positional contract is about a leading run and a half-filled bag would assert nothing.
        if (sample === null) break;
        params[slot.name] = sample;
      }
      for (const [, spec] of Object.entries(grammar.keyed ?? {})) {
        const sample = sampleFor(spec.type, spec.values);
        if (sample !== null) params[spec.name] = sample;
      }
      if (grammar.rest !== undefined) params[grammar.rest.name] = 'free text';

      const { args, dropped } = formatArgs(grammar, params);
      expect(dropped, `${code} dropped a param this test gave it a spelling for`).toEqual([]);

      const read = parseArgs(grammar, args, env);
      expect(
        read.problems.map((p) => p.message),
        `${code}: formatArgs produced tokens parseArgs refuses — ${args.join(' ')}`,
      ).toEqual([]);

      /**
       * AND THE SECOND PASS, which is where the contract is actually stated.
       *
       * `parseArgs` canonicalises (an uppercased tenor, a resolved enum word) and three of its
       * coercions produce an OBJECT from one token, so the params a function receives are not always
       * the params a formatter was handed. The claim is not that formatting is idempotent over every
       * value — it is that **nothing is lost silently**: each key of the parsed params either survives
       * the round trip with its value intact, or is named in `dropped`.
       *
       * `QM` is the case that makes this the right assertion rather than a weaker one: its `source`
       * slot is `type: 'watchlist'`, which reads `'alpha'` as `{ kind: 'watchlist', name: 'alpha' }`.
       * That object has an exact inverse and round-trips. A `{ id }` from the universe does not, and
       * would be reported.
       */
      const second = formatArgs(grammar, read.params);
      const again = parseArgs(grammar, second.args, env);
      for (const key of Object.keys(read.params)) {
        if (second.dropped.includes(key)) continue;
        expect(again.params[key], `${code}.${key} did not survive the round trip`).toEqual(
          read.params[key],
        );
      }
      const accounted = new Set([...Object.keys(again.params), ...second.dropped]);
      for (const key of Object.keys(read.params)) {
        expect(accounted.has(key), `${code}.${key} was lost and not reported in dropped`).toBe(true);
      }
    });
  }
});
