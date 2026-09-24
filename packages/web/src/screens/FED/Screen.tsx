// packages/web/src/screens/FED/Screen.tsx — Federal Reserve Monitor (FUNCTIONS_TIER3 §FED "Screen").
//
// The policy page: the target range and the overnight complex from the New York Fed, the SOFR
// averages, the H.15 constant-maturity grid, the FOMC calendar with the rate implied at each
// meeting by the SOFR OIS curve, and the Federal Reserve press feed.
//
// **The four things this page cannot show are part of the page.** IORB, the primary-credit rate,
// the balance sheet and hike/cut probabilities have no reachable source in this build, so each is
// an em dash carrying its reason code and a chip in `badges#caveats` — never an omitted row and
// never a number derived from something adjacent. `meetings[].hikeProbPct` is typed `null` in the
// payload precisely so no resolver can fill it; this screen renders that null in words.
//
// The calendar shows an implied *rate path*, which is a different claim from a probability
// distribution, and `text#pathNote` says so under the grid.
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
  EM_DASH,
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

type Params = ParamsOf<'FED'>;
type Payload = PayloadOf<'FED'>;
type RateRow = Payload['rates'][number];
type MeetingRow = Payload['meetings'][number];

// The four structural gaps, spelled as `core/functions/manifests/FED.ts` declares them. They are
// literals here because `@terminal/core` exports the manifest, not the manifest module's constants.
const NO_IORB_SOURCE = 'NO_IORB_SOURCE';
const NO_DISCOUNT_RATE_SOURCE = 'NO_DISCOUNT_RATE_SOURCE';
const NO_BALANCE_SHEET_SOURCE = 'NO_BALANCE_SHEET_SOURCE';
const NO_FUTURES_SOURCE = 'NO_FUTURES_SOURCE';

const GAP_TITLES: Readonly<Record<string, string>> = {
  [NO_IORB_SOURCE]:
    'IORB is published in H.15 selected daily rates; the H.15 slice fetched here is the constant-maturity Treasury block only (BRIEF §2).',
  [NO_DISCOUNT_RATE_SOURCE]: 'No reachable keyless source for the discount window rate.',
  [NO_BALANCE_SHEET_SOURCE]: 'H.4.1 is not among the verified keyless endpoints (BRIEF §2).',
  [NO_FUTURES_SOURCE]:
    'No fed-funds futures source (CME FedWatch not reachable); the calendar shows an implied rate path, not a probability distribution.',
};

/** The line §FED requires under the calendar grid (FED_PATH_NOTE). */
const pathNote = (curveDate: string | null): string =>
  `Implied path from the SOFR OIS curve ${curveDate ?? '—'} (proxy inputs); no fed-funds futures source, so no probabilities.`;

function policyKv(p: Payload): Node {
  const pol = p.policy;
  const next = pol.nextMeeting;
  return {
    kind: 'kv',
    id: 'policy',
    title: 'Policy',
    columns: 3,
    rows: [
      kvRow('Target from', cell('TARGET_FROM', pol.targetFrom, { fmt: 'pct', decimals: 2 })),
      kvRow('Target to', cell('TARGET_TO', pol.targetTo, { fmt: 'pct', decimals: 2 })),
      kvRow('Effective', textCell(pol.effectiveDate, { fmt: 'date' })),
      kvRow(
        'Last change',
        textCell(
          pol.lastChange === null
            ? null
            : `${pol.lastChange.decisionBp > 0 ? '+' : ''}${String(pol.lastChange.decisionBp)} bp (${pol.lastChange.meetingDate})`,
        ),
      ),
      kvRow(
        'Next FOMC',
        textCell(
          next === null
            ? null
            : `${next.meetingDate}${next.hasSep ? ' · SEP' : ''} · ${String(next.businessDaysAway)} business day(s)`,
        ),
      ),
      kvRow('Statement', textCell(next?.statementAt ?? null, { fmt: 'datetime' })),
      // Four gaps, each an em dash carrying its reason rather than an omitted row.
      kvRow('IORB', textCell(`${EM_DASH} ${NO_IORB_SOURCE}`)),
      kvRow('Discount (primary)', textCell(`${EM_DASH} ${NO_DISCOUNT_RATE_SOURCE}`)),
      kvRow('Balance sheet', textCell(`${EM_DASH} ${NO_BALANCE_SHEET_SOURCE}`)),
    ],
  };
}

function ratesGrid(p: Payload): Node {
  const columns: GridColumn[] = [
    { id: 'rate', label: 'Rate', align: 'left' },
    { id: 'name', label: 'Name', align: 'left' },
    { id: 'date', label: 'Eff date', align: 'left', fmt: 'date' },
    { id: 'value', label: 'Rate %', align: 'right', fieldId: 'RATE', fmt: 'pct', decimals: 4, live: true },
    { id: 'p1', label: '1st', align: 'right', fieldId: 'RATE_P1', fmt: 'pct', decimals: 4 },
    { id: 'p25', label: '25th', align: 'right', fieldId: 'RATE_P25', fmt: 'pct', decimals: 4 },
    { id: 'p75', label: '75th', align: 'right', fieldId: 'RATE_P75', fmt: 'pct', decimals: 4 },
    { id: 'p99', label: '99th', align: 'right', fieldId: 'RATE_P99', fmt: 'pct', decimals: 4 },
    { id: 'volumeBn', label: 'Vol $bn', align: 'right', fieldId: 'RATE_VOLUME_BN', fmt: 'int' },
    { id: 'chg1dBp', label: 'Δ1d bp', align: 'right', fmt: 'bp', decimals: 1 },
    { id: 'spreadToMidBp', label: 'vs mid bp', align: 'right', fmt: 'bp', decimals: 1 },
  ];

  const rows: GridRow[] = p.rates.map((r: RateRow): GridRow => {
    const row: GridRow = {
      id: `rate:${r.rateCode}`,
      cells: {
        rate: textCell(r.rateCode),
        name: textCell(r.name),
        date: textCell(r.effectiveDate, { fmt: 'date' }),
        value: cell('RATE', r.rate, { fmt: 'pct', decimals: 4 }),
        p1: cell('RATE_P1', r.p1, { fmt: 'pct', decimals: 4 }),
        p25: cell('RATE_P25', r.p25, { fmt: 'pct', decimals: 4 }),
        p75: cell('RATE_P75', r.p75, { fmt: 'pct', decimals: 4 }),
        p99: cell('RATE_P99', r.p99, { fmt: 'pct', decimals: 4 }),
        volumeBn: cell('RATE_VOLUME_BN', r.volumeBn, { fmt: 'int', decimals: 0 }),
        chg1dBp: computedCell(r.chg1dBp, 'bp', 1),
        spreadToMidBp: computedCell(r.spreadToMidBp, 'bp', 1),
      },
      command: `${r.rateCode} Index GP`,
    };
    if (r.subject !== null) row.subject = r.subject;
    return row;
  });

  return {
    kind: 'grid',
    id: 'rates',
    columns,
    rows,
    frozenColumns: 2,
    selectable: true,
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    onEnter: (row: GridRow): string | null => row.command ?? null,
    onShiftEnter: (row: GridRow): string | null => row.command ?? null,
    emptyText: 'No New York Fed reference rates stored for this date.',
  };
}

function sofrAvgKv(p: Payload): Node {
  const a = p.sofrAverages;
  return {
    kind: 'kv',
    id: 'sofrAvg',
    title: 'SOFR averages and index',
    columns: 3,
    rows: [
      kvRow('Effective', textCell(a.effectiveDate, { fmt: 'date' })),
      kvRow('30-day', cell('RATE_AVG_30D', a.avg30d, { fmt: 'pct', decimals: 5 })),
      kvRow('90-day', cell('RATE_AVG_90D', a.avg90d, { fmt: 'pct', decimals: 5 })),
      kvRow('180-day', cell('RATE_AVG_180D', a.avg180d, { fmt: 'pct', decimals: 5 })),
      kvRow('Index', cell('RATE_INDEX', a.indexValue, { fmt: 'px', decimals: 8 })),
    ],
  };
}

function h15Grid(p: Payload): Node {
  const rows: GridRow[] = p.h15.rows.map((r): GridRow => ({
    id: `h15:${r.tenor}`,
    cells: {
      tenor: textCell(r.tenor),
      days: countCell(r.tenorDays),
      yieldPct: cell('CURVE_PAR', r.yieldPct, { fmt: 'pct', decimals: 2 }),
      chg1dBp: computedCell(r.chg1dBp, 'bp', 1),
    },
  }));
  return {
    kind: 'grid',
    id: 'h15',
    columns: [
      { id: 'tenor', label: 'Tenor', align: 'left' },
      { id: 'days', label: 'Days', align: 'right', fmt: 'int' },
      { id: 'yieldPct', label: `CMT % (${p.h15.curveDate ?? '—'})`, align: 'right', fieldId: 'CURVE_PAR', fmt: 'pct', decimals: 2 },
      { id: 'chg1dBp', label: `Δ1d bp (${p.h15.priorDate ?? '—'})`, align: 'right', fmt: 'bp', decimals: 1 },
    ],
    rows,
    frozenColumns: 1,
    selectable: true,
    emptyText: 'No H.15 constant-maturity row stored for this date.',
  };
}

function historyGrid(p: Payload): Node {
  // The overnight history is the same NY Fed capture the policy block cites; each level is a value
  // of `RATE` for its own code, and the target bounds are the policy fields.
  const provIdx = p.policy.provIdx;
  const rate = (v: number | null): Cell => numCell('RATE', v, provIdx, { fmt: 'pct', decimals: 4 });

  const rows: GridRow[] = p.history.map((h): GridRow => ({
    id: `hist:${h.date}`,
    cells: {
      date: textCell(h.date, { fmt: 'date' }),
      effr: rate(h.effr),
      sofr: rate(h.sofr),
      obfr: rate(h.obfr),
      tgcr: rate(h.tgcr),
      bgcr: rate(h.bgcr),
      targetFrom: numCell('TARGET_FROM', h.targetFrom, provIdx, { fmt: 'pct', decimals: 2 }),
      targetTo: numCell('TARGET_TO', h.targetTo, provIdx, { fmt: 'pct', decimals: 2 }),
    },
  }));

  return {
    kind: 'grid',
    id: 'history',
    columns: [
      { id: 'date', label: 'Date', align: 'left', fmt: 'date' },
      { id: 'effr', label: 'EFFR', align: 'right', fieldId: 'RATE', fmt: 'pct', decimals: 4 },
      { id: 'sofr', label: 'SOFR', align: 'right', fieldId: 'RATE', fmt: 'pct', decimals: 4 },
      { id: 'obfr', label: 'OBFR', align: 'right', fieldId: 'RATE', fmt: 'pct', decimals: 4 },
      { id: 'tgcr', label: 'TGCR', align: 'right', fieldId: 'RATE', fmt: 'pct', decimals: 4 },
      { id: 'bgcr', label: 'BGCR', align: 'right', fieldId: 'RATE', fmt: 'pct', decimals: 4 },
      { id: 'targetFrom', label: 'Target from', align: 'right', fieldId: 'TARGET_FROM', fmt: 'pct', decimals: 2 },
      { id: 'targetTo', label: 'Target to', align: 'right', fieldId: 'TARGET_TO', fmt: 'pct', decimals: 2 },
    ],
    rows,
    frozenColumns: 1,
    selectable: true,
    emptyText: 'No overnight history stored.',
  };
}

function meetingsGrid(p: Payload): Node {
  const rows: GridRow[] = p.meetings.map((m: MeetingRow): GridRow => ({
    id: `fomc:${m.meetingDate}`,
    cells: {
      meeting: textCell(m.meetingDate, { fmt: 'date' }),
      statement: textCell(m.statementAt, { fmt: 'datetime' }),
      sep: textCell(m.hasSep ? 'SEP' : ''),
      decisionBp: computedCell(
        m.decisionBp === null
          ? { v: null, st: 'na', provIdx: -1 }
          : { v: m.decisionBp, st: 'closed', provIdx: m.provIdx },
        'bp',
        0,
      ),
      impliedRatePct: computedCell(m.impliedRatePct, 'pct', 4),
      impliedMoveBp: computedCell(m.impliedMoveBp, 'bp', 1),
      cumulativeMoveBp: computedCell(m.cumulativeMoveBp, 'bp', 1),
      // Structurally null: the payload types these `null` so no resolver can fill them.
      hikeProb: textCell(`${EM_DASH} ${NO_FUTURES_SOURCE}`),
      cutProb: textCell(`${EM_DASH} ${NO_FUTURES_SOURCE}`),
    },
    tone: m.isNext ? 'highlight' : m.isPast ? 'muted' : 'normal',
  }));

  return {
    kind: 'grid',
    id: 'meetings',
    columns: [
      { id: 'meeting', label: 'Meeting', align: 'left', fmt: 'date' },
      { id: 'statement', label: 'Statement (ET)', align: 'left', fmt: 'datetime' },
      { id: 'sep', label: 'SEP', align: 'left' },
      { id: 'decisionBp', label: 'Decision bp', align: 'right', fmt: 'bp', decimals: 0 },
      { id: 'impliedRatePct', label: 'Implied O/N %', align: 'right', fmt: 'pct', decimals: 4 },
      { id: 'impliedMoveBp', label: 'Move bp', align: 'right', fmt: 'bp', decimals: 1 },
      { id: 'cumulativeMoveBp', label: 'Cum bp', align: 'right', fmt: 'bp', decimals: 1 },
      { id: 'hikeProb', label: 'Hike prob', align: 'right' },
      { id: 'cutProb', label: 'Cut prob', align: 'right' },
    ],
    rows,
    frozenColumns: 1,
    selectable: true,
    emptyText: 'No FOMC meeting stored.',
  };
}

function pressList(p: Payload): Node {
  return {
    kind: 'list',
    id: 'press',
    items: p.press.map((item) => {
      const badges: Badge[] = [{ text: item.kind === 'fed_release' ? 'RELEASE' : 'PRESS', tone: 'info' }];
      if (item.category !== null) badges.push({ text: item.category, tone: 'ok' });
      if (item.isCorrection) badges.push({ text: 'CORRECTION', tone: 'warn' });
      const entry: {
        id: string;
        primary: string;
        secondary?: string;
        ts?: string;
        badges?: Badge[];
        url?: string;
      } = {
        id: `press:${String(item.newsId)}`,
        primary: item.headline,
        ts: item.publishedAt,
        url: item.url,
        badges,
      };
      if (item.summary !== null) entry.secondary = item.summary;
      return entry;
    }),
    live: { subject: 'n:topic:FED' },
  };
}

function pathKv(p: Payload): Node {
  const path = p.path;
  return {
    kind: 'kv',
    id: 'path',
    title: 'Implied path',
    columns: 3,
    rows: [
      kvRow('Engine', textCell(path === null ? null : `${path.engine.name}@${path.engine.version}`)),
      kvRow('Inputs hash', textCell(path === null ? null : path.engine.inputsHash.slice(0, 8))),
      kvRow('Curve', textCell(path === null ? null : `${path.curveId} ${path.curveDate}`)),
      kvRow('Build', textCell(path === null ? null : String(path.buildId))),
      kvRow(
        'Spot rate',
        path === null ? textCell(null) : cell('RATE', path.spotRatePct, { fmt: 'pct', decimals: 4 }),
      ),
    ],
  };
}

function caveatBadges(p: Payload, meta: Parameters<typeof footer>[0]): Badge[] {
  const codes = [NO_FUTURES_SOURCE, NO_IORB_SOURCE, NO_DISCOUNT_RATE_SOURCE, NO_BALANCE_SHEET_SOURCE];
  const badges: Badge[] = codes.map((code) => ({ text: code, tone: 'warn' as const, title: GAP_TITLES[code] ?? code }));
  for (const c of p.path?.caveats ?? []) {
    if (badges.some((b) => b.text === c)) continue;
    badges.push({ text: c, tone: 'warn', title: GAP_TITLES[c] ?? c });
  }
  badges.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));
  return badges;
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta, ctx }) => {
  if (payload === undefined) {
    return {
      title: 'FED · Federal Reserve Monitor',
      subtitle: 'loading…',
      body: stack(
        'col',
        [
          {
            kind: 'kv',
            id: 'policy',
            columns: 3,
            rows: [
              kvRow('Target from', textCell(null)),
              kvRow('Target to', textCell(null)),
              kvRow('Next FOMC', textCell(null)),
              kvRow('IORB', textCell(`${EM_DASH} ${NO_IORB_SOURCE}`)),
            ],
          },
          {
            kind: 'grid',
            id: 'rates',
            columns: [{ id: 'rate', label: 'Rate', align: 'left' }],
            rows: Array.from({ length: 5 }, (_v, i) => ({
              id: `rate-skeleton:${String(i)}`,
              cells: { rate: textCell(null) },
              tone: 'muted' as const,
            })),
            emptyText: 'loading…',
          },
          {
            kind: 'grid',
            id: 'meetings',
            columns: [{ id: 'meeting', label: 'Meeting', align: 'left' }],
            rows: Array.from({ length: params.meetings }, (_v, i) => ({
              id: `fomc-skeleton:${String(i)}`,
              cells: { meeting: textCell(null) },
              tone: 'muted' as const,
            })),
            emptyText: 'loading…',
          },
        ],
        [0.2, 0.4, 0.4],
      ),
      footer: footer(undefined),
      initialFocus: 'rates',
    } satisfies ScreenSpec;
  }

  const effr = payload.rates.find((r) => r.rateCode === 'EFFR');

  return {
    title: 'FED · Federal Reserve Monitor',
    subtitle: `target ${String(payload.policy.targetFrom.v ?? '—')}–${String(payload.policy.targetTo.v ?? '—')} % · EFFR ${String(effr?.rate.v ?? '—')} % (${effr?.effectiveDate ?? '—'}) · next FOMC ${payload.policy.nextMeeting?.meetingDate ?? '—'}`,
    body: stack(
      'col',
      [
        { kind: 'badges', id: 'caveats', items: caveatBadges(payload, meta) },
        policyKv(payload),
        {
          kind: 'tabs',
          id: 'view',
          active: params.view,
          tabs: [
            {
              id: 'rates',
              label: 'Rates',
              key: '1',
              body: stack(
                'col',
                [ratesGrid(payload), sofrAvgKv(payload), h15Grid(payload), historyGrid(payload)],
                [0.3, 0.14, 0.28, 0.28],
              ),
            },
            {
              id: 'calendar',
              label: 'Calendar',
              key: '2',
              body: stack(
                'col',
                [
                  meetingsGrid(payload),
                  { kind: 'text', id: 'pathNote', tone: 'warn', text: pathNote(payload.path?.curveDate ?? null) },
                  pathKv(payload),
                ],
                [0.66, 0.1, 0.24],
              ),
            },
            { id: 'press', label: 'Press', key: '3', body: pressList(payload) },
          ],
          onChange: (id): void => {
            ctx.setParams({ view: id as Params['view'] });
          },
        },
      ],
      [0.08, 0.17, 0.75],
    ),
    footer: footer(meta, [
      pathNote(payload.path?.curveDate ?? null),
      `${NO_IORB_SOURCE} · ${NO_DISCOUNT_RATE_SOURCE} · ${NO_BALANCE_SHEET_SOURCE}`,
    ]),
    initialFocus: 'rates',
  } satisfies ScreenSpec;
};

export default Screen;
