/**
 * packages/web/test/screens/tier1/desFloatUnits.test.tsx — a number is not shown under a field whose
 * unit it does not have (FUNCTIONS.md §1.5, DATA-10).
 *
 * `DES`'s `Fundamentals` block printed `Float % 3,253,431,000,000.00%` two rows above
 * `Mkt cap $4,820,019,828,600`. The value was `payload.fundamentals.publicFloat` — the XBRL fact
 * `dei:EntityPublicFloat`, an aggregate MARKET VALUE in the filing currency — and it was rendered as
 * `cell('EQY_FLOAT_PCT', …)`, a field the dictionary defines as a percentage of shares outstanding
 * (`unit: 'pct'`, `decimals: 2`, derivation `PUBLIC_FLOAT / EQY_SH_OUT × 100`, example `99.87`). The
 * cell was wrong by a factor of the market capitalisation and said so in the unit.
 *
 * The rule asserted here is the general one and not "this row is gone": a number this payload carries
 * may be shown under a money field or not shown at all, and must never be shown under a field of
 * another unit. `screens.test.tsx` already proves that every cited number names a field IN the
 * dictionary; nothing proved that the field it names measures the same thing.
 *
 * **Why the market-cap leg is in the test.** With the float row removed there is no cell holding that
 * value, so the assertion has nothing to iterate and would pass against a screen that renders
 * nothing at all. So the walk is first proved to work — on `mktCap`, the neighbouring money amount,
 * which it must find under a `ccy` field — and only then is the float value's absence-or-money
 * asserted. That is the difference between this file and the ten tests in this build that could not
 * fail.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getField, manifests } from '@terminal/core';
import type { PayloadOf } from '@terminal/core';
import type { InstrumentSummary, PayloadMeta } from '@terminal/sdk';
import { describe, expect, it } from 'vitest';

import { Screen as DesScreen } from '../../../src/screens/DES/Screen.js';
import type { Cell, Node, ScreenCtx, ScreenSpec } from '../../../src/screen/types.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(dirname(dirname(dirname(TEST_DIR)))));

function golden(): PayloadOf<'DES'> {
  return JSON.parse(
    readFileSync(
      join(REPO_ROOT, 'fixtures', 'golden', 'functions', 'DES.equity.json'),
      'utf8',
    ),
  ) as PayloadOf<'DES'>;
}

const INSTRUMENT: InstrumentSummary = {
  instrumentId: 1,
  assetClass: 'equity',
  marketSector: 'Equity',
  display: 'AAPL US Equity',
  name: 'Apple Inc',
  currency: 'USD',
  mdLineIds: [101],
  ticker: 'AAPL',
  exchCode: 'UW',
  securityType: 'Common Stock',
  compositeFigi: 'BBG000B9Y5X2',
  status: 'active',
  priceDecimals: 2,
};

/** The screen does no IO; every action is a no-op recorder. */
function ctx(): ScreenCtx<ParamsOfDes> {
  return {
    setParams: () => undefined,
    navigate: () => undefined,
    page: () => undefined,
    showProvenance: () => undefined,
    export: () => undefined,
    focus: () => undefined,
    openUrl: () => undefined,
  } as unknown as ScreenCtx<ParamsOfDes>;
}
type ParamsOfDes = ReturnType<typeof manifests.DES.params.parse>;

/** Enough `PayloadMeta` for the screen's footer; the provenance rows are asserted elsewhere. */
function meta(): PayloadMeta {
  return {
    traceId: '0f2c9ab1-0000-4000-8000-00000000abcd',
    resultId: '01J0000000000000000000TEST',
    asOf: { validAt: '2026-09-15T18:41:28.000Z', knownAt: '2026-09-15T18:41:28.000Z' },
    tier: 'delayed',
    staleness: 'live',
    provenance: [
      {
        idx: 0,
        sourceId: 'sec.companyfacts',
        provenanceId: 1000,
        capturedAt: '2026-09-15T18:41:28.000Z',
        sourceTs: '2026-09-15T18:26:26.000Z',
        attribution: 'SEC company facts',
      },
    ],
    entitlement: [],
    unavailable: [],
    engines: [],
    page: { index: 0, count: 1, cursor: null },
    servedAt: '2026-09-15T18:41:28.100Z',
  };
}

function walkNodes(node: Node, out: Node[] = []): Node[] {
  out.push(node);
  if (node.kind === 'split') for (const child of node.children) walkNodes(child, out);
  if (node.kind === 'tabs') for (const tab of node.tabs) walkNodes(tab.body, out);
  return out;
}

/** Every cell of a spec, with the label or column it is shown under. */
function cellsOf(spec: ScreenSpec): { cell: Cell; where: string }[] {
  const out: { cell: Cell; where: string }[] = [];
  for (const n of walkNodes(spec.body)) {
    if (n.kind === 'kv') {
      for (const row of n.rows) out.push({ cell: row.value, where: `${n.id}.${row.label}` });
    } else if (n.kind === 'grid') {
      for (const row of n.rows) {
        for (const [column, cell] of Object.entries(row.cells)) {
          out.push({ cell, where: `${n.id}.${column}` });
        }
      }
    } else if (n.kind === 'table') {
      for (const row of n.rows) {
        row.forEach((cell, i) => {
          out.push({ cell, where: `${n.id}.${n.columns[i]?.id ?? String(i)}` });
        });
      }
    }
  }
  return out;
}

describe('DES fundamentals — the unit a cell claims is the unit its value has', () => {
  const payload = golden();
  const fundamentals = payload.variant === 'equity' ? payload.fundamentals : null;

  it('shows the public float as money, or does not show it at all', () => {
    expect(fundamentals, 'DES.equity.json has no fundamentals block').not.toBeNull();
    const float = fundamentals?.publicFloat.v;
    const mktCap = fundamentals?.mktCap.v;
    // The premise. `dei:EntityPublicFloat` is a currency amount of the same order as the market cap,
    // which is exactly why the two are confusable and why a wrong unit is not visible by eye.
    expect(typeof float, 'the golden carries no public float to be wrong about').toBe('number');
    expect(typeof mktCap).toBe('number');
    expect(float).not.toBe(mktCap);

    const spec = DesScreen({
      payload,
      params: manifests.DES.params.parse({}),
      instrument: INSTRUMENT,
      meta: meta(),
      live: { value: () => undefined, state: () => undefined } as never,
      ctx: ctx(),
    });
    const cells = cellsOf(spec);

    // The walk works, proved on the neighbouring money amount: `Mkt cap` must be there, under a
    // field the dictionary measures in currency.
    const cap = cells.filter((c) => c.cell.v === mktCap && c.cell.fieldId !== undefined);
    expect(cap.length, 'the walk found no market-cap cell, so it proves nothing below').toBe(1);
    expect(getField(cap[0]!.cell.fieldId!)?.unit).toBe('ccy');

    // And the float value: wherever it appears under a field id, that field is a currency field.
    for (const { cell, where } of cells) {
      if (cell.v !== float || cell.fieldId === undefined) continue;
      expect(
        getField(cell.fieldId)?.unit,
        `${where}: a currency amount shown under ${cell.fieldId}`,
      ).toBe('ccy');
    }
  });
});
