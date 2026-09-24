// packages/web/src/screens/WIRP/Screen.tsx — Implied Policy Path (FUNCTIONS_TIER3 §WIRP "Screen").
//
// The FOMC-dated overnight path read off the money-market curve, and the allocation of each
// meeting's implied step onto the adjacent 25 bp target ranges.
//
// **This screen says twice that its probability tab is not a traded distribution**, because a
// reader who takes it for one has been misled and that is the single failure this entry exists to
// prevent. `NO_FUTURES_SOURCE` and `POINT_MASS_PROBABILITY_MODEL` are permanent badges on
// `badges#caveats`, and `text#disclaimer` carries the sentence in words directly above the grid the
// numbers are in. Neither is conditional and neither can be dismissed.
//
// A past meeting is not a forecast: its implied cells arrive `{v:null, r:'NOT_IN_UNIVERSE'}` and
// render muted with only the decision the Fed actually took. Nothing back-fills them with the model.
//
// Pure: no DOM, no state, no IO.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type {
  Badge,
  Cell,
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

type Params = ParamsOf<'WIRP'>;
type Payload = PayloadOf<'WIRP'>;
type Meeting = Payload['meetings'][number];

/** The sentence §WIRP requires above the probability grid, verbatim (WIRP_PROBABILITY_DISCLAIMER). */
const DISCLAIMER =
  'Implied allocation of the curve-implied step onto adjacent 25 bp ranges — not an ' +
  'options-implied distribution; no fed-funds futures source';

const CAVEAT_TITLES: Readonly<Record<string, string>> = {
  NO_FUTURES_SOURCE:
    'No fed-funds futures or options source is reachable (BRIEF §2), so no market price of a policy outcome exists in this build.',
  POINT_MASS_PROBABILITY_MODEL:
    'The probability tab allocates one implied rate onto two adjacent target ranges; it is arithmetic, not a traded distribution.',
  PROXY_CURVE:
    'SOFR OIS term points are proxied (SOFR averages, bills, UST par); no OIS swap or futures source.',
  NO_OIS_SWAP_QUOTES_SOURCE: 'There is no OIS swap quote source in this build.',
  FOMC_CALENDAR_HORIZON: 'Fewer undecided FOMC meetings are published than were asked to be projected.',
};

function currentKv(p: Payload): Node {
  const b = p.basis;
  return {
    kind: 'kv',
    id: 'current',
    title: 'Current policy',
    columns: 3,
    rows: [
      kvRow('Reference', textCell(p.current.rateCode)),
      kvRow('Rate', cell('RATE', p.current.rate, { fmt: 'pct', decimals: 4 })),
      kvRow('Effective', textCell(p.current.effectiveDate, { fmt: 'date' })),
      kvRow('Target from', cell('TARGET_FROM', p.current.targetFrom, { fmt: 'pct', decimals: 2 })),
      kvRow('Target to', cell('TARGET_TO', p.current.targetTo, { fmt: 'pct', decimals: 2 })),
      kvRow('Target mid', computedCell(p.current.targetMid, 'pct', 4)),
      kvRow('Basis bp', computedCell(b.appliedBp, 'bp', 2)),
      kvRow('Basis source', textCell(b.source)),
      kvRow('Basis window', textCell(b.window === null ? null : `${b.window.from} → ${b.window.to} (${String(b.observations)} obs)`)),
      kvRow('Formula', textCell(b.formula)),
    ],
  };
}

function pathGrid(p: Payload): Node {
  const columns: GridColumn[] = [
    { id: 'meeting', label: 'Meeting', align: 'left', fmt: 'date' },
    { id: 'sep', label: 'SEP', align: 'left' },
    { id: 'days', label: 'Days', align: 'right', fmt: 'int' },
    { id: 'impliedOn', label: 'Implied O/N %', align: 'right', fmt: 'pct', decimals: 4 },
    { id: 'impliedRef', label: `Implied ${p.current.rateCode} %`, align: 'right', fmt: 'pct', decimals: 4 },
    { id: 'cumBp', label: 'Cum bp', align: 'right', fmt: 'bp', decimals: 2 },
    { id: 'stepBp', label: 'Step bp', align: 'right', fmt: 'bp', decimals: 2 },
    { id: 'moves', label: 'Moves', align: 'right', fmt: 'px', decimals: 3 },
    { id: 'vsCompare', label: 'vs compare bp', align: 'right', fmt: 'bp', decimals: 2 },
    { id: 'decisionBp', label: 'Decision bp', align: 'right', fmt: 'bp', decimals: 0 },
  ];

  const rows: GridRow[] = p.meetings.map((m: Meeting): GridRow => {
    const cells: Record<string, Cell> = {
      meeting: textCell(m.meetingDate, { fmt: 'date' }),
      sep: textCell(m.hasSep ? 'SEP' : ''),
      days: countCell(m.daysAhead),
      // Every implied number is model output over the curve: no dictionary field names it, and the
      // provenance it carries is the curve build it was read off.
      impliedOn: computedCell(m.impliedOvernightPct, 'pct', 4),
      impliedRef: computedCell(m.impliedReferencePct, 'pct', 4),
      cumBp: computedCell(m.cumChangeBp, 'bp', 2),
      stepBp: computedCell(m.stepChangeBp, 'bp', 2),
      moves: computedCell(m.impliedMoves, 'px', 3),
      vsCompare: computedCell(
        m.vsCompare?.deltaBp == null
          ? { v: null, st: 'na', provIdx: -1 }
          : { v: m.vsCompare.deltaBp, st: 'closed', provIdx: m.provIdx },
        'bp',
        2,
      ),
      decisionBp: computedCell(
        m.decisionBp === null
          ? { v: null, st: 'na', provIdx: -1 }
          : { v: m.decisionBp, st: 'closed', provIdx: m.provIdx },
        'bp',
        0,
      ),
    };
    return {
      id: `mtg:${m.meetingDate}`,
      cells,
      command: `FED ${m.meetingDate}`,
      tone: m.isPast ? 'muted' : 'normal',
    };
  });

  return {
    kind: 'grid',
    id: 'path',
    columns,
    rows,
    frozenColumns: 2,
    selectable: true,
    onShiftEnter: (row: GridRow): string | null => row.command ?? null,
    emptyText: 'No FOMC meeting is stored for this horizon.',
  };
}

function terminalKv(p: Payload): Node {
  return {
    kind: 'kv',
    id: 'terminal',
    title: 'Terminal',
    columns: 3,
    rows: [
      kvRow('Meeting', textCell(p.terminal.meetingDate, { fmt: 'date' })),
      kvRow('Implied rate', computedCell(p.terminal.ratePct, 'pct', 4)),
      kvRow('From current mid', computedCell(p.terminal.cumChangeBp, 'bp', 2)),
    ],
  };
}

function probsGrid(p: Payload): Node {
  const rows: GridRow[] = p.meetings.flatMap((m: Meeting): GridRow[] =>
    m.outcomes.map((o) => ({
      id: `prob:${m.meetingDate}:${String(o.moves)}`,
      cells: {
        meeting: textCell(m.meetingDate, { fmt: 'date' }),
        outcome: textCell(o.moves === 0 ? 'hold' : `${o.moves > 0 ? '+' : ''}${String(o.bp)} bp`),
        rangeFrom: numCell('TARGET_FROM', o.rangeFrom, m.provIdx, { fmt: 'pct', decimals: 2 }),
        rangeTo: numCell('TARGET_TO', o.rangeTo, m.provIdx, { fmt: 'pct', decimals: 2 }),
        prob: computedCell(o.probPct, 'pct', 2),
      },
      tone: m.isPast ? 'muted' : 'normal',
    })),
  );

  return {
    kind: 'grid',
    id: 'probs',
    columns: [
      { id: 'meeting', label: 'Meeting', align: 'left', fmt: 'date' },
      { id: 'outcome', label: 'Outcome', align: 'left' },
      { id: 'rangeFrom', label: 'Range from', align: 'right', fieldId: 'TARGET_FROM', fmt: 'pct', decimals: 2 },
      { id: 'rangeTo', label: 'Range to', align: 'right', fieldId: 'TARGET_TO', fmt: 'pct', decimals: 2 },
      { id: 'prob', label: 'Allocation %', align: 'right', fmt: 'pct', decimals: 2 },
    ],
    rows,
    frozenColumns: 2,
    selectable: true,
    emptyText: 'No undecided meeting to allocate a step across.',
  };
}

function modelKv(p: Payload): Node {
  const e = p.model.engine;
  return {
    kind: 'kv',
    id: 'model',
    title: 'Model',
    columns: 3,
    rows: [
      kvRow('Engine', textCell(e === null ? null : `${e.name}@${e.version}`)),
      kvRow('Inputs hash', textCell(e === null ? null : e.inputsHash.slice(0, 8))),
      kvRow('Step', countCell(p.model.stepBp, 'bp', 0)),
      kvRow('Probability model', textCell(p.model.probabilityModel)),
      kvRow('Curve', textCell(p.curve.date === null ? `${p.curve.id} (none stored)` : `${p.curve.id} ${p.curve.date}`)),
      kvRow('Interpolation', textCell(p.curve.interpolation)),
      kvRow('Build', textCell(p.curve.buildId === null ? null : String(p.curve.buildId))),
      kvRow('Valuation date', textCell(p.asOfDate, { fmt: 'date' })),
    ],
  };
}

function caveatBadges(p: Payload, meta: Parameters<typeof footer>[0]): Badge[] {
  const badges: Badge[] = p.model.caveats.map((c) => ({
    text: c,
    tone: 'warn' as const,
    title: CAVEAT_TITLES[c] ?? c,
  }));
  badges.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));
  return badges;
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta, ctx }) => {
  if (payload === undefined) {
    return {
      title: `WIRP · Implied Policy Path · ${params.reference} · ${params.curveId}`,
      subtitle: 'loading…',
      body: stack(
        'col',
        [
          {
            kind: 'kv',
            id: 'current',
            columns: 3,
            rows: [
              kvRow('Reference', textCell(params.reference)),
              kvRow('Rate', textCell(null)),
              kvRow('Target from', textCell(null)),
              kvRow('Target to', textCell(null)),
            ],
          },
          {
            kind: 'grid',
            id: 'path',
            columns: [{ id: 'meeting', label: 'Meeting', align: 'left' }],
            rows: Array.from({ length: 3 }, (_v, i) => ({
              id: `mtg-skeleton:${String(i)}`,
              cells: { meeting: textCell(null) },
              tone: 'muted' as const,
            })),
            emptyText: 'loading…',
          },
        ],
        [0.3, 0.7],
      ),
      footer: footer(undefined),
      initialFocus: 'path',
    } satisfies ScreenSpec;
  }

  const notes = [
    DISCLAIMER,
    ...(payload.model.caveats.includes('FOMC_CALENDAR_HORIZON')
      ? [
          `only ${String(payload.meetings.filter((m) => !m.isPast).length)} undecided FOMC meetings are published`,
        ]
      : []),
  ];

  const next = payload.meetings.find((m) => !m.isPast);

  return {
    title: `WIRP · Implied Policy Path · ${payload.current.rateCode} · ${payload.curve.id} ${payload.curve.date ?? '—'}`,
    subtitle: `next decision ${next?.meetingDate ?? '—'} · basis ${String(payload.basis.appliedBp.v ?? '—')} bp (${payload.basis.source}) · step ${String(payload.model.stepBp)} bp`,
    body: stack(
      'col',
      [
        { kind: 'badges', id: 'caveats', items: caveatBadges(payload, meta) },
        currentKv(payload),
        {
          kind: 'tabs',
          id: 'view',
          active: params.view,
          tabs: [
            {
              id: 'path',
              label: 'Path',
              key: '1',
              body: stack('col', [pathGrid(payload), terminalKv(payload)], [0.78, 0.22]),
            },
            {
              id: 'probabilities',
              label: 'Probabilities',
              key: '2',
              body: stack(
                'col',
                [
                  { kind: 'text', id: 'disclaimer', tone: 'warn', text: DISCLAIMER },
                  probsGrid(payload),
                ],
                [0.12, 0.88],
              ),
            },
          ],
          onChange: (id): void => {
            ctx.setParams({ view: id as Params['view'] });
          },
        },
        modelKv(payload),
      ],
      [0.08, 0.17, 0.6, 0.15],
    ),
    footer: footer(meta, notes),
    initialFocus: 'path',
  } satisfies ScreenSpec;
};

export default Screen;
