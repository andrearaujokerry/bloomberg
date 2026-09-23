// packages/web/src/screens/CF/Screen.tsx — Company Filings (FUNCTIONS_TIER2.md §CF "Screen").
//
// The EDGAR submissions index as a terminal screen: who the filer is, what the latest periodic and
// current reports are, a form histogram that doubles as a filter, and the filing list itself.
//
// Link-out only: `Enter` opens the primary document on sec.gov. Nothing is proxied and no document
// body is stored, which is why the grid carries `url` on every row and no "view" action.
//
// Pure: no DOM, no state, no IO.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type { Badge, FunctionScreen, GridColumn, GridRow, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import {
  countCell,
  entitlementBadges,
  footer,
  kvRow,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'CF'>;
type Payload = PayloadOf<'CF'>;
type Filing = Payload['filings'][number];

const GROUP_TABS = ['ALL', 'PERIODIC', 'CURRENT', 'OWNERSHIP', 'FUND', 'PROXY'] as const;

function filingColumns(): GridColumn[] {
  return [
    { id: 'filed', label: 'Filed', align: 'left', fmt: 'date', sortable: true },
    { id: 'accepted', label: 'Accepted', align: 'left', fmt: 'datetime' },
    { id: 'form', label: 'Form', align: 'left', sortable: true },
    { id: 'items', label: 'Items', align: 'left' },
    { id: 'description', label: 'Description', align: 'left', width: 60 },
    { id: 'period', label: 'Period', align: 'left', fmt: 'date' },
    { id: 'xbrl', label: 'XBRL', align: 'left' },
    { id: 'size', label: 'Size', align: 'right', fmt: 'int' },
    { id: 'accession', label: 'Accession', align: 'left' },
  ];
}

function filingRow(f: Filing): GridRow {
  return {
    id: `cf:${f.accessionNo}`,
    cells: {
      filed: textCell(f.filedDate, { fmt: 'date' }),
      accepted: textCell(f.acceptedAt, { fmt: 'datetime' }),
      form: textCell(f.isAmendment ? `${f.form} [A]` : f.form),
      items: textCell(f.items === null ? null : f.items.join(', ')),
      description: textCell(f.primaryDocDesc ?? f.primaryDoc),
      period: textCell(f.reportDate, { fmt: 'date' }),
      xbrl: textCell(f.isInlineXbrl ? 'inline' : f.isXbrl ? 'yes' : 'no'),
      // `sizeBytes` is the submission size EDGAR reports; it cites the submissions capture the row
      // came from, exactly as every other column of the row does.
      size: countCell(f.sizeBytes, 'int'),
      accession: textCell(f.accessionNo),
    },
    tone: f.isAmendment ? 'muted' : 'normal',
  };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, instrument, meta }) => {
  const display = instrument?.display ?? 'security';

  if (payload === undefined) {
    return {
      title: `CF · ${display} · Filings`,
      subtitle: 'loading…',
      body: stack('col', [
        {
          kind: 'kv',
          id: 'issuer',
          columns: 3,
          rows: [kvRow('CIK', textCell(null)), kvRow('SIC', textCell(null)), kvRow('FYE', textCell(null))],
        },
        {
          kind: 'kv',
          id: 'latest',
          columns: 3,
          rows: [
            kvRow('Latest 10-K', textCell(null)),
            kvRow('Latest 10-Q', textCell(null)),
            kvRow('Latest 8-K', textCell(null)),
          ],
        },
        {
          kind: 'grid',
          id: 'filings',
          columns: filingColumns(),
          rows: Array.from({ length: 15 }, (_v, i) => ({
            id: `skeleton:${String(i)}`,
            cells: { filed: textCell(null) },
            tone: 'muted' as const,
          })),
          emptyText: 'loading…',
        },
      ]),
      footer: footer(undefined),
      initialFocus: 'filings',
    } satisfies ScreenSpec;
  }

  const iss = payload.issuer;
  const issuerKv: Node = {
    kind: 'kv',
    id: 'issuer',
    title: 'Filer',
    columns: 3,
    rows: [
      kvRow('CIK', textCell(iss.cik, { fieldId: 'ID_CIK' })),
      kvRow('SIC', textCell(iss.sic === null ? null : `${iss.sic} ${iss.sicDescription ?? ''}`.trim())),
      kvRow('Filer category', textCell(iss.filerCategory)),
      kvRow('Entity type', textCell(iss.entityType)),
      kvRow('Fiscal year end', textCell(iss.fiscalYearEnd)),
      kvRow(
        'Former names',
        textCell(iss.formerNames.length === 0 ? '—' : iss.formerNames.map((n) => n.name).join(' · ')),
      ),
      kvRow('Website', textCell(iss.website)),
    ],
  };

  const describe = (f: Filing | null): string | null =>
    f === null ? null : `${f.form} ${f.filedDate}${f.reportDate === null ? '' : ` (period ${f.reportDate})`}`;

  const latestKv: Node = {
    kind: 'kv',
    id: 'latest',
    title: 'Latest',
    columns: 2,
    rows: [
      kvRow('Annual', textCell(describe(payload.latest.annual))),
      kvRow('Quarterly', textCell(describe(payload.latest.quarterly))),
      kvRow('Current (8-K)', textCell(describe(payload.latest.current8k))),
      kvRow('Fund holdings', textCell(describe(payload.latest.fundHoldings))),
    ],
  };

  const filter: Badge[] = [
    {
      text: `${payload.filter.group}${payload.filter.forms.length === 0 ? '' : ` ${payload.filter.forms.join(',')}`} · ${payload.filter.from}..${payload.filter.to} · ${String(payload.total)} filings`,
      tone: 'info',
      title: `knownAt ${payload.knownAt.slice(0, 10)}`,
    },
  ];
  if (payload.filter.xbrlOnly) filter.push({ text: 'XBRL only', tone: 'info' });
  if (payload.filter.items.length > 0) {
    filter.push({ text: `items ${payload.filter.items.join(',')}`, tone: 'info' });
  }

  const notes: Badge[] = [
    {
      text: 'FULL-TEXT SEARCH UNAVAILABLE',
      tone: 'warn',
      title: 'EDGAR full-text search is not a reachable source in the wedge; the filter is on form, item and date.',
    },
    { text: 'LINK-OUT ONLY', tone: 'info', title: 'Enter opens the primary document on sec.gov; nothing is proxied or stored.' },
    {
      text: payload.coverage.recentOnly ? 'HISTORY: RECENT' : 'HISTORY: FULL',
      tone: payload.coverage.recentOnly ? 'warn' : 'ok',
      title: `${String(payload.coverage.countInStore)} filings stored${payload.coverage.from === null ? '' : ` from ${payload.coverage.from}`}${payload.coverage.to === null ? '' : ` to ${payload.coverage.to}`}.`,
    },
  ];
  for (const note of payload.notes) notes.push({ text: note, tone: 'warn' });
  notes.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));

  const formCounts: Node = {
    kind: 'table',
    id: 'formCounts',
    caption: 'Forms in window',
    columns: [
      { id: 'form', label: 'Form', type: 'string' },
      { id: 'group', label: 'Group', type: 'string' },
      { id: 'count', label: 'Count', type: 'number' },
      { id: 'newest', label: 'Newest', type: 'date' },
    ],
    rows: payload.formCounts.map((c) => [
      textCell(c.form),
      textCell(c.formGroup),
      countCell(c.count),
      textCell(c.newest, { fmt: 'date' }),
    ]),
  };

  const noCik = iss.cik === null;
  const list: Node = noCik
    ? {
        kind: 'text',
        id: 'filings',
        tone: 'warn',
        text:
          (meta?.unavailable ?? [])
            .map((u) => `${u.field}: ${u.reason} — ${u.detail}`)
            .join(' · ') || 'NO_CIK: this issuer has no EDGAR CIK, so no filing index can be read.',
      }
    : {
        kind: 'grid',
        id: 'filings',
        columns: filingColumns(),
        rows: payload.filings.map(filingRow),
        frozenColumns: 1,
        selectable: true,
        sort: { col: 'filed', dir: 'desc' },
        page: { index: meta?.page?.index ?? 0, count: meta?.page?.count ?? 1 },
        emptyText: 'No filings match this filter in the window.',
      };

  const tabs: Node = {
    kind: 'tabs',
    id: 'group-tabs',
    active: payload.filter.group,
    tabs: GROUP_TABS.map((g, i) => ({
      id: g,
      label: g,
      key: String(i + 1),
      body:
        g === payload.filter.group
          ? stack('row', [formCounts, list], [0.24, 0.76])
          : { kind: 'text' as const, id: `tab-${g}`, text: `Press ${String(i + 1)} for ${g}.`, tone: 'muted' as const },
    })),
  };

  return {
    title: `CF · ${display} · ${payload.security.name} · Filings`,
    subtitle: `${payload.filter.group === 'ALL' && payload.filter.forms.length > 0 ? payload.filter.forms.join(',') : payload.filter.group} · ${payload.filter.from} … ${payload.filter.to} · ${String(payload.total)} filings`,
    body: stack(
      'col',
      [
        stack('row', [issuerKv, latestKv], [0.55, 0.45]),
        { kind: 'badges', id: 'filter', items: filter },
        { kind: 'badges', id: 'notes', items: notes },
        tabs,
      ],
      [0.18, 0.05, 0.05, 0.72],
    ),
    footer: footer(meta, payload.notes),
    initialFocus: 'filings',
  } satisfies ScreenSpec;
};

export default Screen;
