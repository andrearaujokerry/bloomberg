// packages/web/src/screens/ECO/Screen.tsx — Economic Calendar (FUNCTIONS_TIER2.md §ECO "Screen").
//
// Two modes on one code: `calendar` (a day / week / month of releases, grouped by day, with the
// FOMC block beside it) and `release` (one release, its recent events, its series and — the part
// that makes the screen point-in-time — the vintage audit behind each observation, STOR-06).
//
// Two honesty rules the layout fixes and this file keeps:
//   * `consensus` is ALWAYS an em dash with `NO_CONSENSUS_SOURCE`; there is no estimates provider.
//     The reason rides the column label, because §1.5's `Cell` has no tooltip field.
//   * `timeKnown === false` means FRED published a date and not a time. The time cell is an em
//     dash, not a fabricated 08:30, and the note says so.
//
// Pure: no DOM, no state, no IO.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type { Badge, Cell, FunctionScreen, GridColumn, GridRow, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import {
  EM_DASH,
  cell,
  countCell,
  entitlementBadges,
  footer,
  kvRow,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'ECO'>;
type Payload = PayloadOf<'ECO'>;
type EventRow = Payload['days'][number]['events'][number];

const NO_CONSENSUS = 'NO_CONSENSUS_SOURCE';
const NO_CONSENSUS_DETAIL =
  'NO_CONSENSUS_SOURCE: no economist-survey provider in the wedge; the column is shown, empty and explained, rather than dropped.';
const TIME_UNKNOWN_DETAIL =
  'FRED publishes the date only; 08:30 ET is assumed for ordering and the time is shown as —.';

const RANGE_TABS: readonly { id: Params['range']; label: string }[] = [
  { id: 'D', label: 'Day' },
  { id: 'W', label: 'Week' },
  { id: 'M', label: 'Month' },
];

function eventColumns(): GridColumn[] {
  return [
    { id: 'time', label: 'Time (ET)', align: 'left' },
    { id: 'release', label: 'Release', align: 'left', width: 34 },
    { id: 'period', label: 'Period', align: 'left', fieldId: 'ECO_PERIOD' },
    { id: 'series', label: 'Series', align: 'left' },
    { id: 'actual', label: 'Actual', align: 'right', fieldId: 'ECO_VALUE', fmt: 'px', live: true },
    { id: 'prior', label: 'Prior', align: 'right', fieldId: 'ECO_PRIOR', fmt: 'px' },
    { id: 'revised', label: 'Revised', align: 'right', fieldId: 'REVISED', fmt: 'px' },
    { id: 'consensus', label: `Consensus — ${NO_CONSENSUS}`, align: 'right' },
    { id: 'status', label: 'Status', align: 'left' },
  ];
}

function eventRow(e: EventRow, dayKey: string): GridRow {
  const decimals = e.decimals ?? 2;
  const cells: Record<string, Cell> = {
    time: textCell(e.timeKnown ? e.scheduledAt : EM_DASH, e.timeKnown ? { fmt: 'datetime' } : {}),
    release: textCell(e.releaseName),
    period: textCell(e.periodLabel, { fieldId: 'ECO_PERIOD' }),
    series: textCell(e.seriesCode, e.seriesCode === null ? {} : { command: `${e.seriesCode} Index GP 5Y` }),
    actual: cell('ECO_VALUE', e.actual, { fmt: 'px', decimals }),
    prior: cell('ECO_PRIOR', e.prior, { fmt: 'px', decimals }),
    revised: cell('REVISED', e.revisedPrior, { fmt: 'px', decimals }),
    consensus: textCell(EM_DASH),
    status: textCell(e.status),
  };
  return {
    id: `eco:${String(e.eventId)}`,
    cells,
    group: dayKey,
    ...(e.subject === null ? {} : { subject: e.subject }),
    command: `ECO REL=${String(e.releaseId)}`,
    tone: e.importance >= 3 ? 'highlight' : 'normal',
  };
}

function calendarBody(p: Payload, notes: Badge[], reasons: Badge[]): Node {
  const rows: GridRow[] = [];
  for (const day of p.days) {
    const label = `${day.date}${day.isBusinessDay ? '' : ' · non-business'}`;
    for (const e of day.events) rows.push(eventRow(e, label));
  }

  const events: Node = {
    kind: 'grid',
    id: 'events',
    columns: eventColumns(),
    rows,
    groupBy: 'date',
    frozenColumns: 2,
    selectable: true,
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    page: { index: 0, count: 1 },
    emptyText: 'No releases in this window at this importance.',
  };

  const fomc: Node = {
    kind: 'table',
    id: 'fomc',
    caption: 'FOMC',
    columns: [
      { id: 'meeting', label: 'Meeting', type: 'date' },
      { id: 'statement', label: 'Statement', type: 'datetime' },
      { id: 'sep', label: 'SEP', type: 'boolean' },
      { id: 'decision', label: 'Decision bp', type: 'number' },
    ],
    rows: p.fomc.map((m) => [
      textCell(m.meetingDate, { fmt: 'date' }),
      textCell(m.statementAt, { fmt: 'datetime' }),
      textCell(m.hasSep ? 'yes' : 'no'),
      m.decisionBp === null ? textCell(EM_DASH) : countCell(m.decisionBp, 'bp', 0),
    ]),
  };

  const tabs: Node = {
    kind: 'tabs',
    id: 'range',
    active: p.window.label.startsWith('Week') ? 'W' : p.window.from === p.window.to ? 'D' : 'M',
    tabs: RANGE_TABS.map((t, i) => ({
      id: t.id,
      label: t.label,
      key: String(i + 1),
      body: { kind: 'text' as const, id: `tab-${t.id}`, text: `Press ${String(i + 1)} for ${t.label}.`, tone: 'muted' as const },
    })),
  };

  return stack(
    'col',
    [
      tabs,
      { kind: 'badges', id: 'mode', items: notes },
      { kind: 'badges', id: 'reason', items: reasons },
      events,
      fomc,
    ],
    [0.06, 0.06, 0.06, 0.6, 0.22],
  );
}

function releaseBody(p: Payload, notes: Badge[], reasons: Badge[]): Node {
  const r = p.release;
  if (r === null) {
    return stack('col', [
      { kind: 'badges', id: 'reason', items: reasons },
      { kind: 'text', id: 'events', tone: 'warn', text: 'No such release in the store.' },
    ]);
  }

  const next = r.nextEvent;
  const last = r.events[0] ?? null;
  const series0 = r.series[0] ?? null;

  const releaseKv: Node = {
    kind: 'kv',
    id: 'release',
    title: r.name,
    columns: 2,
    rows: [
      kvRow('Publisher', textCell(r.sourceId)),
      kvRow('Country', textCell(r.country)),
      kvRow('Importance', countCell(r.importance)),
      kvRow('Next event', textCell(next === null ? null : `${next.scheduledAt} · ${next.periodLabel}`)),
      kvRow('Last actual', last === null ? textCell(null) : cell('ECO_VALUE', last.actual, { fmt: 'px', decimals: last.decimals ?? 2 })),
      kvRow('Prior', last === null ? textCell(null) : cell('ECO_PRIOR', last.prior, { fmt: 'px', decimals: last.decimals ?? 2 })),
      kvRow('Revised prior', last === null ? textCell(null) : cell('REVISED', last.revisedPrior, { fmt: 'px', decimals: last.decimals ?? 2 })),
      kvRow(`Consensus (${NO_CONSENSUS})`, textCell(EM_DASH)),
    ],
  };

  const spark: Node = {
    kind: 'custom',
    id: 'spark',
    component: 'Sparkline',
    props: { points: series0?.chart ?? [], fmt: 'px' },
  };

  const events: Node = {
    kind: 'grid',
    id: 'events',
    columns: eventColumns(),
    rows: r.events.map((e) => eventRow(e, r.name)),
    frozenColumns: 2,
    selectable: true,
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    emptyText: 'No events stored for this release.',
  };

  const vintages: Node = {
    kind: 'grid',
    id: 'vintages',
    columns: [
      { id: 'obsDate', label: 'Obs date', align: 'left', fmt: 'date' },
      { id: 'vintageAt', label: 'Vintage at', align: 'left', fmt: 'datetime', fieldId: 'ECO_VINTAGE' },
      { id: 'value', label: 'Value', align: 'right', fieldId: 'ECO_VALUE', fmt: 'px' },
      { id: 'status', label: 'Status', align: 'left' },
    ],
    rows: (series0?.revisions ?? []).flatMap((g) =>
      g.vintages.map((v, i) => ({
        id: `vintage:${g.obsDate}:${String(i)}`,
        cells: {
          obsDate: textCell(g.obsDate, { fmt: 'date' }),
          vintageAt: textCell(v.vintageAt, { fmt: 'datetime', fieldId: 'ECO_VINTAGE' }),
          value: countCell(v.value, 'px', series0?.decimals ?? 3),
          status: textCell(v.status),
        },
        group: g.obsDate,
        ...(series0 === null ? {} : { command: `${series0.seriesCode} Index HP` }),
      })),
    ),
    groupBy: 'obsDate',
    emptyText: 'No revision history recorded for this series.',
  };

  return stack(
    'col',
    [
      releaseKv,
      { kind: 'badges', id: 'mode', items: notes },
      { kind: 'badges', id: 'reason', items: reasons },
      spark,
      events,
      vintages,
    ],
    [0.2, 0.05, 0.05, 0.12, 0.31, 0.27],
  );
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta }) => {
  if (payload === undefined) {
    return {
      title: 'ECO · Economic Calendar',
      subtitle: 'loading…',
      body: stack('col', [
        {
          kind: 'tabs',
          id: 'range',
          active: params.range,
          tabs: RANGE_TABS.map((t, i) => ({
            id: t.id,
            label: t.label,
            key: String(i + 1),
            body: { kind: 'text' as const, id: `tab-${t.id}`, text: 'loading…', tone: 'muted' as const },
          })),
        },
        {
          kind: 'grid',
          id: 'events',
          columns: eventColumns(),
          rows: Array.from({ length: 12 }, (_v, i) => ({
            id: `skeleton:${String(i)}`,
            cells: { release: textCell(null) },
            tone: 'muted' as const,
          })),
          emptyText: 'loading…',
        },
      ]),
      footer: footer(undefined),
      initialFocus: 'events',
    } satisfies ScreenSpec;
  }

  const notes: Badge[] = [
    { text: payload.country, tone: 'info' },
    { text: `IMP ≥ ${String(payload.importance)}`, tone: 'info' },
    { text: params.fomc ? 'FOMC ON' : 'FOMC OFF', tone: 'info' },
    ...stalenessBadges(meta),
  ];

  const timeUnknown = payload.days.some((d) => d.events.some((e) => !e.timeKnown));
  const reasons: Badge[] = [
    { text: `CONSENSUS UNAVAILABLE · ${NO_CONSENSUS}`, tone: 'warn', title: NO_CONSENSUS_DETAIL },
  ];
  if (timeUnknown) reasons.push({ text: 'TIME NOT PUBLISHED', tone: 'warn', title: TIME_UNKNOWN_DETAIL });
  for (const note of payload.notes) reasons.push({ text: note, tone: 'warn' });
  reasons.push(...entitlementBadges(meta), ...unavailableBadges(meta));

  const isRelease = payload.mode === 'release';
  const title = isRelease
    ? `ECO · ${payload.release?.name ?? 'Release'} · release ${String(payload.release?.releaseId ?? 0)} (${payload.release?.sourceId ?? '—'})`
    : `ECO · Economic Calendar · ${payload.window.label} (${payload.country})`;

  return {
    title,
    subtitle: `${params.range} · IMP ≥ ${String(payload.importance)} · ${payload.window.from} … ${payload.window.to} (${payload.window.tz})`,
    body: isRelease ? releaseBody(payload, notes, reasons) : calendarBody(payload, notes, reasons),
    footer: footer(meta, [NO_CONSENSUS_DETAIL, ...payload.notes]),
    initialFocus: 'events',
  } satisfies ScreenSpec;
};

export default Screen;
