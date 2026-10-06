/**
 * packages/web/test/screens/tier1/screenActions.test.tsx — `ScreenSpec.actions`, and GP's `R`.
 *
 * ## The defect this file is the regression test for
 *
 * `manifests/GP.ts` declares `{ key: 'R', action: 'cycle-range' }` and `screens/GP/Screen.tsx` titled
 * every one of its ten range chips "press R to cycle to <r>". Pressing `R` answered
 * `NOT_APPLICABLE: cycle-range: this key is declared by the screen but not wired yet` — because
 * `KeyboardHost.screenAction` had nowhere to send the action. There was no channel between a resolved
 * binding and the screen that declared it, so the DEFAULT DESK'S CHART COULD NOT BE MOVED OFF ITS
 * RANGE FROM THE KEYBOARD AT ALL; the only path was retyping the whole command positionally.
 *
 * `ScreenSpec.actions` is that channel, `shell/Panel.tsx` publishes the focused panel's copy with the
 * rest of the focus model, and `App.tsx#screenAction` runs it. This file asserts the screen half: the
 * handlers exist, and each one patches the params its key is named after.
 *
 * ## Two guards that are about every screen and not only GP
 *
 *   1. **Nothing is wired that cannot be pressed.** Every key of `spec.actions` must be an `action` of
 *      `manifest.keymap` or of `spec.keymap`. A handler keyed `'cycle-ragne'` is dead code the
 *      dispatcher will never reach, and a typo there is invisible — the footer hint for the real
 *      action still fires, so the screen looks consistent from the outside.
 *   2. **A chip that names a key is a claim about that key.** GP's toolbar is the only place in the
 *      Tier 1 set that titles a badge after a keypress, and the title has to agree with where the
 *      handler actually goes.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifests } from '@terminal/core';
import type { FunctionCode, PayloadOf } from '@terminal/core';
import type { InstrumentSummary } from '@terminal/sdk';
import { describe, expect, it } from 'vitest';

import type { Badge, LiveView, Node, ScreenCtx, ScreenProps, ScreenSpec } from '../../../src/screen/types.js';
import { screenModules } from '../../../src/screens/index.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(dirname(dirname(dirname(TEST_DIR)))));
const GOLDEN_DIR = join(REPO_ROOT, 'fixtures', 'golden', 'functions');

const INSTRUMENT: InstrumentSummary = {
  instrumentId: 1,
  assetClass: 'equity',
  marketSector: 'Equity',
  display: 'AAPL US Equity',
  name: 'Apple Inc',
  currency: 'USD',
  mdLineIds: [101],
  ticker: 'AAPL',
  exchCode: 'US',
  securityType: 'Common Stock',
  compositeFigi: null,
  status: 'active',
  priceDecimals: 2,
};

const LIVE: LiveView = {
  get: (subject, field) => ({ v: null, st: 'blank', provIdx: -1, live: { subject, field } }),
  state: () => 'blank',
};

interface Recorded {
  setParams: Record<string, unknown>[];
  navigate: string[];
}

function ctxOf<P>(rec: Recorded): ScreenCtx<P> {
  return {
    panelId: 'p1',
    setParams: (patch) => rec.setParams.push(patch),
    navigate: (command) => rec.navigate.push(command),
    navigateNext: (command) => rec.navigate.push(`NEXT ${command}`),
    export: () => undefined,
    page: () => undefined,
    focus: () => undefined,
    prompt: () => Promise.resolve(null),
    provenance: () => undefined,
    openUrl: () => undefined,
  };
}

/** The GP spec for one set of params, plus what its handlers did when run. */
function gp(overrides: Record<string, unknown> = {}): {
  spec: ScreenSpec;
  rec: Recorded;
  run: (action: string) => void;
} {
  const payload = JSON.parse(
    readFileSync(join(GOLDEN_DIR, 'GP.equity.json'), 'utf8'),
  ) as PayloadOf<'GP'>;
  const rec: Recorded = { setParams: [], navigate: [] };
  const params = manifests.GP.params.parse(overrides);
  const spec = screenModules.GP.Screen({
    payload,
    params,
    instrument: INSTRUMENT,
    meta: undefined,
    live: LIVE,
    ctx: ctxOf(rec),
  });
  return {
    spec,
    rec,
    run: (action) => {
      const handler = spec.actions?.[action];
      expect(handler, `GP declares ${action} and wires it`).toBeDefined();
      handler?.();
    },
  };
}

describe("GP's keymap actions patch the params they are named after", () => {
  it('cycles the range one step, in the order the chips are drawn', () => {
    const { rec, run } = gp({ range: '5D' });
    run('cycle-range');
    expect(rec.setParams).toHaveLength(1);
    expect(rec.setParams[0]?.range).toBe('1M');
  });

  it('wraps at the end of the ladder rather than stopping on MAX', () => {
    const { rec, run } = gp({ range: 'MAX' });
    run('cycle-range');
    expect(rec.setParams[0]?.range).toBe('1D');
  });

  /**
   * THE ONE THAT WOULD BE A SILENT WRONG ANSWER rather than a missing one.
   *
   * `server/src/functions/GP/resolve.ts#planWindow` measures a fixed range back from
   * `params.end ?? today`. A cycle off `CUSTOM` that left the custom `start`/`end` in the params bag
   * would therefore run `1D` against the END OF THE CUSTOM WINDOW — a chart labelled 1D showing a day
   * in the past, with no indication anywhere that it was not today. The golden's own window is
   * `CUSTOM 2026-09-01 → 2026-09-15`, so this is the real shape.
   */
  it('clears the custom dates when it leaves CUSTOM', () => {
    const { rec, run } = gp({ range: 'CUSTOM', start: '2026-09-01', end: '2026-09-15' });
    run('cycle-range');
    const patch = rec.setParams[0];
    expect(patch?.range).toBe('1D');
    expect(patch).toHaveProperty('start');
    expect(patch).toHaveProperty('end');
    expect(patch?.start).toBeUndefined();
    expect(patch?.end).toBeUndefined();
  });

  it('cycles type, adjust and normalise through their own enums', () => {
    const t = gp({ type: 'line' });
    t.run('cycle-type');
    expect(t.rec.setParams[0]?.type).toBe('area');

    const a = gp({ adjust: 'price' });
    a.run('cycle-adjust');
    expect(a.rec.setParams[0]?.adjust).toBe('total_return');

    const n = gp({ normalise: 'base100' });
    n.run('cycle-normalise');
    expect(n.rec.setParams[0]?.normalise).toBe('none');
  });

  /**
   * `P` offers four values on a 1Y chart and six on a 5D one, because §GP step 1 CLAMPS an intraday
   * periodicity on a longer range to `'D'`. Offering `1m` there would spend two presses producing the
   * chart that was already on screen — a key that looks wired and does nothing, which is the defect
   * this file exists for in a quieter form.
   */
  it('offers intraday periodicities only on the ranges that have them', () => {
    const long = gp({ range: '1Y', periodicity: 'auto' });
    long.run('cycle-periodicity');
    expect(long.rec.setParams[0]?.periodicity).toBe('D');

    const short = gp({ range: '5D', periodicity: 'auto' });
    short.run('cycle-periodicity');
    expect(short.rec.setParams[0]?.periodicity).toBe('1m');
  });

  it('toggles the booleans and never patches them to the value they already hold', () => {
    const log = gp({ logScale: false });
    log.run('toggle-log');
    expect(log.rec.setParams[0]?.logScale).toBe(true);

    const vol = gp({ volume: true });
    vol.run('toggle-volume');
    expect(vol.rec.setParams[0]?.volume).toBe(false);
  });

  it('turns every event kind off together, then every kind back on', () => {
    const off = gp();
    off.run('toggle-events');
    const first = off.rec.setParams[0]?.events as Record<string, boolean>;
    expect(Object.values(first).every((v) => v === false)).toBe(true);

    const on = gp({ events: { earnings: false, dividends: false, splits: false, news: false, filings: false, indexChanges: false, fomc: false } });
    on.run('toggle-events');
    const second = on.rec.setParams[0]?.events as Record<string, boolean>;
    expect(Object.values(second).every((v) => v === true)).toBe(true);
  });

  it('does not re-run the function when there is nothing to remove', () => {
    const { rec, run } = gp();
    run('remove-overlay');
    run('remove-study');
    expect(rec.setParams).toHaveLength(0);
  });

  it('navigates to GIP and to HP over the same window', () => {
    const { rec, run } = gp({ range: '5Y' });
    run('open-gip');
    run('open-hp');
    expect(rec.navigate).toEqual(['AAPL US Equity GIP', 'AAPL US Equity HP 5Y']);
  });

  /**
   * The four that are deliberately NOT wired, each because `App.tsx`'s `ctx.prompt` resolves `null`
   * (`PromptDialog` is unwritten). Asserted as ABSENT so that wiring a prompt dialog makes this test
   * fail and the author has to come back here — the alternative is four handlers that look wired and
   * silently cancel.
   */
  it('leaves the prompt-driven actions to the footer hint', () => {
    const { spec } = gp();
    for (const action of ['custom-range', 'add-overlay', 'set-currency', 'add-study']) {
      expect(spec.actions?.[action], `${action} needs ctx.prompt`).toBeUndefined();
    }
  });

  it('titles exactly one chip after R, and it is the chip R goes to', () => {
    const { spec, rec, run } = gp({ range: '1M' });
    run('cycle-range');
    const next = rec.setParams[0]?.range;

    const badges: Badge[] = [];
    const walk = (node: Node): void => {
      if (node.kind === 'badges') badges.push(...node.items);
      if (node.kind === 'split') for (const child of node.children) walk(child);
      if (node.kind === 'tabs') for (const tab of node.tabs) walk(tab.body);
    };
    walk(spec.body);

    const titled = badges.filter((b) => b.title === 'press R to cycle here');
    expect(titled).toHaveLength(1);
    expect(titled[0]?.text).toBe(next);
    // And the key claim is made nowhere else: the old title promised ten chips were one press away.
    expect(badges.filter((b) => (b.title ?? '').startsWith('press R to cycle to'))).toHaveLength(0);
  });
});

/**
 * Every handler a screen publishes must be reachable — an `action` some keymap declares.
 *
 * Run over all 38 screens rather than over GP, because the failure it catches is a typo and a typo is
 * silent: the dispatcher resolves the DECLARED action, finds no handler under that spelling, and falls
 * back to the hint, so the screen behaves exactly as it did before anybody wired anything.
 */
describe('every wired action is an action some keymap declares', () => {
  const CODES = Object.keys(screenModules) as FunctionCode[];

  for (const code of CODES) {
    it(`${code}`, () => {
      const manifest = manifests[code];
      const params = manifest.params.parse({}) as Record<string, unknown>;
      const rec: Recorded = { setParams: [], navigate: [] };
      // The skeleton branch: no payload, which every screen must answer, and which is the branch that
      // publishes `actions` before the first paint.
      // Widened to one props type, as `shell/Panel.tsx#AnyScreenProps` does: calling a UNION of 38
      // screen functions would demand an argument that satisfies every screen's props at once.
      const Screen = screenModules[code].Screen as (
        props: ScreenProps<Record<string, unknown>, unknown>,
      ) => ScreenSpec;
      const spec = Screen({
        payload: undefined,
        params,
        instrument: INSTRUMENT,
        meta: undefined,
        live: LIVE,
        ctx: ctxOf<Record<string, unknown>>(rec),
      });

      const declared = new Set([
        ...manifest.keymap.map((b) => b.action),
        ...(spec.keymap ?? []).map((b) => b.action),
      ]);
      for (const action of Object.keys(spec.actions ?? {})) {
        expect(declared.has(action), `${code} wires '${action}', which no keymap declares`).toBe(true);
      }
    });
  }
});
