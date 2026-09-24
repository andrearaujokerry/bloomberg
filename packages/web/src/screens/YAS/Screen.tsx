// packages/web/src/screens/YAS/Screen.tsx — Yield & Spread Analysis (FUNCTIONS_TIER3 §YAS "Screen").
//
// One Treasury and every number a desk quotes it by. The screen is polymorphic inside the `govt`
// variant exactly as the payload is: `results.kind` decides whether the reader is shown the coupon
// block (yield, clean/dirty price, accrued, duration, convexity, DV01, key-rate durations) or the
// bill block (discount rate, investment yield, money-market yield, dollar discount), and the
// key-rate table is absent — not empty — on a bill, because a discount bill has no key-rate
// structure to show.
//
// Three rules this file encodes:
//
//   * **Nothing is recomputed here.** Every number is a payload `ValueCell` produced by a versioned
//     engine (ANAL-08); the screen picks the field id it is a value of and passes the cell through.
//     The engines are named in the footer so a reader can trace any number to its producer.
//   * **A refused or absent number stays absent.** A curve-derived cell that arrived `{v:null}` with
//     `r:'PROVIDER_DOWN'` renders as an em dash carrying that reason; nothing substitutes a zero,
//     and the user-input modes still price.
//   * **TIPS and FRNs are refused in words.** When the run reported `results NOT_APPLICABLE`, the
//     results block is replaced by `text#na` rather than filled with numbers from a convention that
//     does not apply to the security.
//
// Pure: no DOM, no state, no IO.

import type { FieldId, ParamsOf, PayloadOf, ValueCell } from '@terminal/core';

import type {
  Badge,
  Cell,
  FormField,
  FunctionScreen,
  GridColumn,
  GridRow,
  Node,
  ScreenSpec,
} from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import {
  computedCell,
  cell,
  countCell,
  entitlementBadges,
  footer,
  kvRow,
  numCell,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'YAS'>;
type Payload = PayloadOf<'YAS'>;
type Results = Payload['results'];
type Cashflow = Payload['cashflows'][number];
type KvRow = ReturnType<typeof kvRow>;

/** `'2Y'` → `KRD_2Y`; the four key-rate tenors YAS bumps all have a dictionary field. */
const KRD_FIELDS: Readonly<Record<string, FieldId>> = {
  '2Y': 'KRD_2Y',
  '5Y': 'KRD_5Y',
  '10Y': 'KRD_10Y',
  '30Y': 'KRD_30Y',
};

/** A derived number with no dictionary field of its own, cited to the input it came from. */
function derived(vc: ValueCell, fmt: NonNullable<Cell['fmt']>, decimals: number): Cell {
  return computedCell(vc, fmt, decimals);
}

function inputsForm(p: Payload, params: Params, setParams: (patch: Partial<Params>) => void): Node {
  const isBill = p.results.kind === 'bill';
  const fields: FormField[] = [
    {
      id: 'input',
      label: 'Mode',
      type: 'enum',
      value: params.input,
      values: isBill ? ['curve', 'discount', 'price'] : ['curve', 'yield', 'price'],
    },
    { id: 'yield', label: 'Yield %', type: 'number', value: params.yield, step: 0.01, bigStep: 0.1, unit: '%' },
    { id: 'price', label: 'Price', type: 'number', value: params.price, step: 1 / 32, bigStep: 10 / 32 },
    { id: 'discount', label: 'Discount %', type: 'number', value: params.discount, step: 0.01, bigStep: 0.1, unit: '%' },
    { id: 'settlement', label: `Settlement (${p.settlement.rule})`, type: 'date', value: p.settlement.date },
    { id: 'face', label: 'Face', type: 'number', value: params.face, step: 1_000_000, bigStep: 10_000_000 },
    { id: 'curveId', label: 'Curve', type: 'enum', value: params.curveId, values: ['UST_PAR', 'UST_CMT', 'SOFR_OIS'] },
    {
      id: 'interpolation',
      label: 'Interpolation',
      type: 'enum',
      value: params.interpolation,
      values: ['linear_zero', 'log_linear_df', 'monotone_convex'],
    },
  ];

  return {
    kind: 'form',
    id: 'inputs',
    fields,
    submitLabel: 'Reprice',
    onSubmit: (values): void => {
      const num = (id: string): number | null => {
        const v = values[id];
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
      };
      const text = (id: string): string | null => {
        const v = values[id];
        return typeof v === 'string' && v !== '' ? v : null;
      };
      const patch: Partial<Params> = {
        yield: num('yield'),
        price: num('price'),
        discount: num('discount'),
        settlement: text('settlement'),
      };
      const face = num('face');
      if (face !== null) patch.face = face;
      const mode = text('input');
      if (mode !== null) patch.input = mode as Params['input'];
      const curveId = text('curveId');
      if (curveId !== null) patch.curveId = curveId as Params['curveId'];
      const interpolation = text('interpolation');
      if (interpolation !== null) patch.interpolation = interpolation as Params['interpolation'];
      setParams(patch);
    },
  };
}

function couponRows(r: Extract<Results, { kind: 'coupon' }>): KvRow[] {
  return [
    kvRow('Yield (street)', cell('YLD_YTM_MID', r.yieldPct, { fmt: 'pct', decimals: 4 })),
    kvRow('Clean price', cell('PX_CLEAN_MID', r.cleanPrice, { fmt: 'px', decimals: 6 })),
    kvRow('Dirty price', cell('PX_DIRTY_MID', r.dirtyPrice, { fmt: 'px', decimals: 6 })),
    kvRow(`Accrued (${String(r.accruedDays)}d of ${String(r.daysInPeriod)})`, cell('ACCRUED', r.accrued, { fmt: 'px', decimals: 6 })),
    kvRow('Macaulay duration', cell('DUR_MID', r.macaulayDuration, { fmt: 'px', decimals: 3 })),
    kvRow('Modified duration', cell('DUR_ADJ_MID', r.modifiedDuration, { fmt: 'px', decimals: 3 })),
    kvRow('Convexity', cell('CONVEXITY_MID', r.convexity, { fmt: 'px', decimals: 2 })),
    kvRow('DV01', cell('DV01', r.dv01, { fmt: 'ccy', decimals: 2 })),
    kvRow('DV01 / 100', derived(r.dv01Per100, 'px', 5)),
    kvRow('Yield value 1/32', derived(r.yieldValueOf32nd, 'bp', 2)),
  ];
}

function billRows(r: Extract<Results, { kind: 'bill' }>, termsProvIdx: number): KvRow[] {
  return [
    kvRow('Discount rate', cell('DISC_RATE', r.discountRatePct, { fmt: 'pct', decimals: 4 })),
    kvRow('Investment yield (BEY)', cell('BEY', r.investmentYieldPct, { fmt: 'pct', decimals: 4 })),
    kvRow('Price', cell('PX_CLEAN_MID', r.price, { fmt: 'px', decimals: 6 })),
    kvRow('Money-market yield', cell('MM_YIELD', r.moneyMarketYieldPct, { fmt: 'pct', decimals: 4 })),
    kvRow('Dollar discount', derived(r.dollarDiscount, 'ccy', 2)),
    kvRow('Days to maturity', numCell('DAYS_TO_MTY', r.daysToMaturity, termsProvIdx, { fmt: 'int' })),
    kvRow('Modified duration', cell('DUR_ADJ_MID', r.modifiedDuration, { fmt: 'px', decimals: 4 })),
    kvRow('DV01', cell('DV01', r.dv01, { fmt: 'ccy', decimals: 2 })),
  ];
}

function spreadRows(r: Results, curveId: string): KvRow[] {
  const s = r.spreads;
  const rows = [
    kvRow(`Curve yield (${curveId})`, cell('CURVE_PAR', s.interpolatedCurveYieldPct, { fmt: 'pct', decimals: 4 })),
    kvRow(`Spread to ${curveId}`, cell('SPRD_TO_CRV', s.toCurveBp, { fmt: 'bp', decimals: 1, signed: true })),
  ];
  if (s.zSpreadBp !== null) {
    rows.push(kvRow('Z-spread', cell('Z_SPRD_MID', s.zSpreadBp, { fmt: 'bp', decimals: 1, signed: true })));
  }
  if (s.benchmark !== null) {
    const b = s.benchmark;
    rows.push(
      kvRow(
        `Benchmark ${b.tenor} (${b.key})`,
        numCell('YLD_YTM_MID', b.yieldPct, b.provIdx, { fmt: 'pct', decimals: 4 }),
      ),
      kvRow('Spread to benchmark', numCell('SPRD_TO_BENCH', b.spreadBp, b.provIdx, { fmt: 'bp', decimals: 1 })),
    );
  }
  return rows;
}

function resultsKv(p: Payload): Node {
  const rows =
    p.results.kind === 'coupon'
      ? couponRows(p.results)
      : billRows(p.results, p.terms.provIdx);
  return {
    kind: 'kv',
    id: 'results',
    title: 'Results',
    columns: 2,
    rows: [...rows, ...spreadRows(p.results, p.inputs.curveId)],
  };
}

function termsKv(p: Payload): Node {
  const t = p.terms;
  const i = p.instrument;
  return {
    kind: 'kv',
    id: 'terms',
    title: 'Terms',
    columns: 3,
    rows: [
      kvRow('CUSIP', textCell(i.cusip, { fieldId: 'ID_CUSIP', provIdx: t.provIdx })),
      kvRow('Type', textCell(i.securityType, { fieldId: 'SECURITY_TYP', provIdx: t.provIdx })),
      kvRow('Term', textCell(i.termLabel)),
      kvRow('On-the-run', textCell(i.onTheRun ? 'Y' : 'N', { fieldId: 'ON_THE_RUN' })),
      kvRow('Coupon', numCell('CPN', t.couponRate, t.provIdx, { fmt: 'pct', decimals: 3 })),
      kvRow('Frequency', numCell('CPN_FREQ', t.couponFreq, t.provIdx, { fmt: 'int' })),
      kvRow('Day count', textCell(t.dayCount, { fieldId: 'DAY_CNT', provIdx: t.provIdx })),
      kvRow('Issued', textCell(t.issueDate, { fieldId: 'ISSUE_DT', fmt: 'date', provIdx: t.provIdx })),
      kvRow('Dated', textCell(t.datedDate, { fmt: 'date' })),
      kvRow('Maturity', textCell(t.maturityDate, { fieldId: 'MATURITY', fmt: 'date', provIdx: t.provIdx })),
      kvRow('First coupon', textCell(t.firstCouponDate, { fmt: 'date' })),
      kvRow('Business day conv', textCell(t.businessDayConv)),
      kvRow('Calendar', textCell(t.calendarId)),
      kvRow('Settlement days', countCell(t.settlementDays)),
      kvRow('Min denomination', countCell(t.minDenomination, 'ccy', 0)),
      kvRow('Amount outstanding', numCell('AMT_OUTSTANDING', t.amountOutstanding, t.provIdx, { fmt: 'ccy', decimals: 0 })),
      kvRow('Days to maturity', countCell(p.settlement.daysToMaturity)),
      kvRow('Years to maturity', countCell(p.settlement.yearsToMaturity, 'px', 3)),
      kvRow('Terms known at', textCell(t.knownAt, { fmt: 'datetime' })),
    ],
  };
}

/**
 * `table#krd` — one ±1 bp triangular bump of the pricing curve's zero curve per key tenor,
 * repriced with the Z-spread held fixed (ANAL-01, §0). The buckets sum to the curve's
 * parallel-shift duration, which is close to but not the same number as the modified duration.
 */
function krdNode(p: Payload): Node {
  if (p.results.kind !== 'coupon') {
    return {
      kind: 'text',
      id: 'krd',
      tone: 'muted',
      text: 'Key-rate durations do not apply to a discount bill: it has one cashflow and one rate.',
    };
  }
  const krds = p.results.keyRateDurations;
  return {
    kind: 'table',
    id: 'krd',
    caption: 'Key-rate durations (years) — 1 bp bump of the zero curve, Z-spread held fixed',
    columns: [
      { id: 'tenor', label: 'Tenor', type: 'string' },
      { id: 'krd', label: 'KRD (yrs)', type: 'number', decimals: 4 },
    ],
    rows: krds.map((k) => [
      textCell(k.tenor),
      numCell(KRD_FIELDS[k.tenor] ?? 'DUR_ADJ_MID', k.krd, p.curve?.provIdx ?? -1, { fmt: 'px', decimals: 4 }),
    ]),
  };
}

function cashflowsGrid(p: Payload): Node {
  const provIdx = p.curve?.provIdx ?? -1;
  const money = (v: number | null): Cell =>
    computedCell(v === null ? { v: null, st: 'na', provIdx: -1 } : { v, st: 'closed', provIdx }, 'ccy', 2);

  const columns: GridColumn[] = [
    { id: 'date', label: 'Date', align: 'left', fmt: 'date' },
    { id: 'kind', label: 'Kind', align: 'left' },
    { id: 'days', label: 'Days', align: 'right', fmt: 'int' },
    { id: 'coupon', label: 'Coupon', align: 'right', fmt: 'ccy', decimals: 2 },
    { id: 'principal', label: 'Principal', align: 'right', fmt: 'ccy', decimals: 2 },
    { id: 'total', label: 'Total', align: 'right', fmt: 'ccy', decimals: 2 },
    { id: 'df', label: 'DF', align: 'right', fmt: 'px', decimals: 8 },
    { id: 'pv', label: 'PV', align: 'right', fmt: 'ccy', decimals: 2 },
  ];

  const rows: GridRow[] = p.cashflows.map((f: Cashflow, i) => ({
    id: `cf:${f.date}:${String(i)}`,
    cells: {
      date: textCell(f.date, { fmt: 'date' }),
      kind: textCell(f.kind),
      days: countCell(f.days),
      coupon: money(f.coupon),
      principal: money(f.principal),
      total: money(f.total),
      df: computedCell(
        f.df === null ? { v: null, st: 'na', provIdx: -1 } : { v: f.df, st: 'closed', provIdx },
        'px',
        8,
      ),
      pv: money(f.pv),
    },
    tone: f.fromCurve ? 'normal' : 'muted',
  }));

  return {
    kind: 'grid',
    id: 'cashflows',
    columns,
    rows,
    frozenColumns: 2,
    selectable: true,
    emptyText: 'No remaining cashflows.',
  };
}

function notesBadges(p: Payload, meta: Parameters<typeof footer>[0]): Badge[] {
  const badges: Badge[] = [];
  if (p.curve === null) {
    badges.push({
      text: 'NO_CURVE',
      tone: 'warn',
      title: `No ${p.inputs.curveId} curve stored on or before the valuation date; curve-derived cells are blank.`,
    });
  }
  badges.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));
  return badges;
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, instrument, meta, ctx }) => {
  if (payload === undefined) {
    return {
      title: `YAS · ${instrument?.display ?? 'Govt'}`,
      subtitle: 'loading…',
      body: stack(
        'col',
        [
          {
            kind: 'form',
            id: 'inputs',
            fields: [
              { id: 'input', label: 'Mode', type: 'enum', value: params.input, values: ['curve', 'yield', 'price', 'discount'] },
              { id: 'curveId', label: 'Curve', type: 'enum', value: params.curveId, values: ['UST_PAR', 'UST_CMT', 'SOFR_OIS'] },
              { id: 'face', label: 'Face', type: 'number', value: params.face },
            ],
            submitLabel: 'Reprice',
            onSubmit: (): void => undefined,
          },
          {
            kind: 'kv',
            id: 'results',
            title: 'Results',
            columns: 2,
            rows: [
              kvRow('Yield (street)', textCell(null)),
              kvRow('Clean price', textCell(null)),
              kvRow('Modified duration', textCell(null)),
              kvRow('DV01', textCell(null)),
            ],
          },
        ],
        [0.34, 0.66],
      ),
      footer: footer(undefined),
      initialFocus: 'inputs',
    } satisfies ScreenSpec;
  }

  // §YAS: a TIPS or FRN is refused in words, not priced on a convention that does not apply.
  const notApplicable = (meta?.unavailable ?? []).some(
    (u) => u.field === 'results' && u.reason === 'NOT_APPLICABLE',
  );

  const results: Node = notApplicable
    ? {
        kind: 'text',
        id: 'results',
        tone: 'warn',
        text:
          'YAS does not price TIPS or FRNs in v1: an inflation or reference-rate engine is needed, ' +
          'and pricing them on the fixed-coupon convention would be wrong rather than approximate.',
      }
    : resultsKv(payload);

  const tabs: Node = {
    kind: 'tabs',
    id: 'view',
    active: params.view,
    tabs: [
      { id: 'analysis', label: 'Analysis', key: '1', body: krdNode(payload) },
      { id: 'cashflows', label: 'Cashflows', key: '2', body: cashflowsGrid(payload) },
    ],
    onChange: (id): void => {
      ctx.setParams({ view: id as Params['view'] });
    },
  };

  // Two interpolations produce the two curve numbers on this page: the build's discounts the
  // cashflows for the Z-spread, the quote's reads the par yield the spread-to-curve is measured
  // against. Naming only the build's made the quote look monotone-convex when it is linear.
  const curveLabel =
    payload.curve === null
      ? `${payload.inputs.curveId} (none stored)`
      : `${payload.curve.id} ${payload.curve.date} · build ${payload.curve.interpolation} · quote ${payload.curve.quoteInterpolation}`;

  return {
    title: `YAS · ${payload.instrument.key} · ${payload.instrument.name}`,
    subtitle: `settlement ${payload.settlement.date} (${payload.settlement.rule}) · curve ${curveLabel} · ${payload.inputs.mode} input`,
    body: stack(
      'col',
      [
        { kind: 'badges', id: 'notes', items: notesBadges(payload, meta) },
        stack(
          'row',
          [
            inputsForm(payload, params, (patch) => {
              ctx.setParams(patch);
            }),
            results,
          ],
          [0.34, 0.66],
        ),
        termsKv(payload),
        tabs,
      ],
      [0.07, 0.38, 0.22, 0.33],
    ),
    footer: footer(meta, [
      `engines: ${payload.engines.map((e) => `${e.name}@${e.version}`).join(' · ')}`,
      ...(payload.results.spreads.benchmark === null ? ['NO_BENCHMARK_ROW'] : []),
    ]),
    initialFocus: 'inputs',
  } satisfies ScreenSpec;
};

export default Screen;
