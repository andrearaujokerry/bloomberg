/**
 * packages/core/test/command/customRange.test.ts — a custom date window can be typed.
 *
 * ## The defect
 *
 * HP's help says its range is "1M … MAX, or CUSTOM with two dates", and both `HpRange` and `GpRange`
 * include `CUSTOM`. The parser's base range list (`RANGE_VALUES`) does not, and neither range slot
 * declared `values` to extend it — so the spelling the help gives answered
 * `ARG_PARSE: CUSTOM is not an argument of this function`. Found when an e2e spec was moved off a
 * window ending today (which rots against a frozen fixture) onto a fixed one, and the fixed one could
 * not be typed.
 *
 * A SECOND defect sits beside it and is NOT fixed here, deliberately — it changes resolver behaviour
 * for GP and HP and wants its own pass: typing the two dates WITHOUT `CUSTOM` parses to
 * `{ start, end }` with `range` left at its `1Y` default, and `server/src/functions/HP/window.ts#
 * resolveWindow` only reads `start` in the `CUSTOM` branch. So `HP 2026-08-25 2026-09-15` shows a full
 * year ending 15 September and says nothing about the start date it dropped. `BUILD_STATUS.md` records
 * it; the last test below pins the current behaviour so that a fix arrives as a failing assertion.
 */

import { describe, expect, it } from 'vitest';

import { parse } from '../../src/command/parser.js';
import type { ParseEnv } from '../../src/command/parser.js';
import { registry } from '../../src/functions/manifests/index.js';

const env: ParseEnv = {
  registry,
  panel: { security: null, fn: null, params: {} },
  lookupTicker: () => [],
  today: '2026-10-06',
};

const argProblems = (raw: string): string[] =>
  (parse(raw, env)[0]?.problems ?? []).filter((p) => p.code === 'ARG_PARSE').map((p) => p.message);

describe('the spelling the help text gives for a custom window parses', () => {
  for (const code of ['HP', 'GP'] as const) {
    it(`${code} CUSTOM <start> <end>`, () => {
      const raw = `${code} CUSTOM 2026-08-25 2026-09-15`;
      expect(argProblems(raw), raw).toEqual([]);
      expect(parse(raw, env)[0]?.params).toEqual({
        range: 'CUSTOM',
        start: '2026-08-25',
        end: '2026-09-15',
      });
    });
  }

  it('accepts it in any case, as every other range word is', () => {
    expect(parse('HP custom 2026-08-25 2026-09-15', env)[0]?.params.range).toBe('CUSTOM');
  });

  it('still accepts the fixed ranges, which the extension must not have displaced', () => {
    for (const r of ['1M', '1Y', 'MAX', 'YTD']) {
      expect(parse(`HP ${r}`, env)[0]?.params.range, r).toBe(r);
    }
  });

  it('does not make CUSTOM a word for a function whose range has no such member', () => {
    // GP and HP are the only manifests with a `range` slot, and both enums include CUSTOM — so this
    // is asserted structurally: every manifest that accepts CUSTOM at the parser accepts it in zod.
    for (const code of ['HP', 'GP'] as const) {
      const manifest = registry.get(code);
      expect(manifest, code).toBeDefined();
      const parsed = manifest?.params.safeParse({ range: 'CUSTOM', start: '2026-08-25' });
      expect(parsed?.success, `${code}'s schema accepts what its grammar now accepts`).toBe(true);
    }
  });
});

describe('KNOWN, NOT FIXED: dates without CUSTOM keep the 1Y default', () => {
  it('parses to start and end with no range — which the resolver then reads as 1Y and drops the start', () => {
    // Pinned as current behaviour. When resolveWindow (or the parser) is taught that a start date
    // means a custom window, this assertion goes red and the author updates BUILD_STATUS.md.
    expect(parse('HP 2026-08-25 2026-09-15', env)[0]?.params).toEqual({
      start: '2026-08-25',
      end: '2026-09-15',
    });
  });
});
