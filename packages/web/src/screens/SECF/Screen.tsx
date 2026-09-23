// packages/web/src/screens/SECF/Screen.tsx — Security Finder (FUNCTIONS_TIER1 §SECF "Screen").
//
// The filter form, the asset-class tabs carrying the facet counts, the hit grid and a detail block
// for the focused row.
//
// Reference data is not tier-gated, so no cell here is ever blanked for entitlement. The one
// entitlement the screen can meet is on PRINT, and that surfaces as a footer reason rather than a
// download (ENTL-05). A Yahoo-fallback row is muted and says so: it is not in the master yet.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type {
  Badge,
  FormField,
  FunctionScreen,
  GridColumn,
  GridRow,
  Node,
  ScreenSpec,
} from '../../screen/types.js';
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

type Params = ParamsOf<'SECF'>;
type Payload = PayloadOf<'SECF'>;
type Hit = Payload['hits'][number];

/** The tab strip: a display grouping over the facets, `7` covering rate and econ together. */
const AC_TABS: readonly { id: string; label: string; classes: readonly string[] }[] = [
  { id: 'all', label: 'All', classes: [] },
  { id: 'equity', label: 'Equity', classes: ['equity'] },
  { id: 'etf', label: 'ETF', classes: ['etf'] },
  { id: 'index', label: 'Index', classes: ['index'] },
  { id: 'fx', label: 'Curncy', classes: ['fx'] },
  { id: 'govt', label: 'Govt', classes: ['govt'] },
  { id: 'rate', label: 'Rate/Econ', classes: ['rate', 'econ'] },
  { id: 'crypto', label: 'Crypto', classes: ['crypto'] },
];

const HIT_COLUMNS: GridColumn[] = [
  { id: 'key', label: 'Security', align: 'left', sortable: true },
  { id: 'name', label: 'Name', align: 'left', sortable: true },
  { id: 'securityType', label: 'Type', align: 'left' },
  { id: 'exchCode', label: 'Exch', align: 'left' },
  { id: 'currency', label: 'Ccy', align: 'left' },
  { id: 'status', label: 'Status', align: 'left' },
  { id: 'memberOf', label: 'Idx', align: 'left' },
  { id: 'figi', label: 'FIGI', align: 'left' },
];

function hitRows(hits: readonly Hit[]): GridRow[] {
  return hits.map((h) => {
    const fallback = h.provIdx < 0 || h.instrument.instrumentId <= 0;
    return {
      id: `hit:${String(h.instrument.instrumentId)}:${h.instrument.display}`,
      instrumentId: h.instrument.instrumentId,
      cells: {
        key: textCell(h.instrument.display, { provIdx: h.provIdx }),
        name: textCell(h.instrument.name),
        securityType: textCell(h.instrument.securityType, { fieldId: 'SECURITY_TYP' }),
        exchCode: textCell(h.instrument.exchCode, { fieldId: 'EXCH_CODE' }),
        currency: textCell(h.instrument.currency, { fieldId: 'CRNCY' }),
        status: textCell(h.instrument.status, { fieldId: 'SECURITY_STATUS' }),
        memberOf: textCell(h.memberOf.join(',')),
        figi: textCell(h.identifiers.figi, { fieldId: 'ID_BB_GLOBAL' }),
      },
      command: `${h.instrument.display} DES`,
      tone: fallback ? ('muted' as const) : ('normal' as const),
    };
  });
}

/** `kv#detail` — what the focused row is, beyond what fits in the grid. */
function detailBlock(hit: Hit | undefined): Node {
  if (hit === undefined) {
    return { kind: 'text', id: 'detail', text: 'No row focused.', tone: 'muted' };
  }
  return {
    kind: 'kv',
    id: 'detail',
    columns: 3,
    rows: [
      kvRow('FIGI', textCell(hit.identifiers.figi, { fieldId: 'ID_FIGI_LISTING' })),
      kvRow('Composite FIGI', textCell(hit.instrument.compositeFigi, { fieldId: 'ID_BB_GLOBAL' })),
      kvRow('ISIN', textCell(hit.identifiers.isin, { fieldId: 'ID_ISIN' })),
      kvRow('CUSIP', textCell(hit.identifiers.cusip, { fieldId: 'ID_CUSIP' })),
      kvRow('Listings', countCell(hit.listings)),
      kvRow('GICS sector', textCell(hit.gicsSector, { fieldId: 'GICS_SECTOR_NAME' })),
      kvRow('Member of', textCell(hit.memberOf.length === 0 ? null : hit.memberOf.join(', '))),
      kvRow('Matched on', textCell(String(hit.matchedOn))),
      kvRow('Score', countCell(hit.score, 'text', 4)),
    ],
  };
}

function filterForm(
  params: Params,
  onSubmit: (values: Record<string, unknown>) => void,
): Node {
  const fields: FormField[] = [
    { id: 'query', label: 'Query', type: 'text', value: params.query },
    {
      id: 'assetClass',
      label: 'AC',
      type: 'enum',
      value: params.assetClass ?? '',
      values: ['', 'equity', 'etf', 'index', 'fx', 'govt', 'option', 'future', 'crypto', 'rate', 'econ'] as const,
    },
    { id: 'exchange', label: 'Exch', type: 'text', value: params.exchange ?? '' },
    {
      id: 'status',
      label: 'Status',
      type: 'enum',
      value: params.status,
      values: ['active', 'all'] as const,
    },
  ];
  return { kind: 'form', id: 'q', fields, submitLabel: 'Find', onSubmit };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta, ctx }) => {
  const submit = (values: Record<string, unknown>): void => {
    const patch: Partial<Params> = {};
    const query = values.query;
    if (typeof query === 'string') patch.query = query;
    const exchange = values.exchange;
    if (typeof exchange === 'string' && exchange.length > 0) patch.exchange = exchange;
    const status = values.status;
    if (status === 'active' || status === 'all') patch.status = status;
    ctx.setParams(patch);
  };

  if (payload === undefined) {
    return {
      title: 'SECF · Security Finder',
      subtitle: 'loading…',
      body: stack(
        'col',
        [
          filterForm(params, submit),
          {
            kind: 'tabs',
            id: 'ac',
            active: params.assetClass ?? 'all',
            tabs: AC_TABS.map((t, i) => ({
              id: t.id,
              label: t.label,
              key: String(i + 1),
              body: { kind: 'text', id: `ac-${t.id}`, text: '…', tone: 'muted' },
            })),
          },
          {
            kind: 'grid',
            id: 'hits',
            columns: HIT_COLUMNS,
            rows: Array.from({ length: 8 }, (_v, i) => ({
              id: `skeleton:${String(i)}`,
              cells: { key: textCell(null) },
              tone: 'muted' as const,
            })),
            emptyText: 'loading…',
          },
        ],
        [0.12, 0.06, 0.82],
      ),
      footer: footer(undefined),
      initialFocus: 'q',
    } satisfies ScreenSpec;
  }

  const page = meta?.page;
  const grid: Node = {
    kind: 'grid',
    id: 'hits',
    columns: HIT_COLUMNS,
    rows: hitRows(payload.hits),
    frozenColumns: 1,
    selectable: true,
    emptyText: meta?.unavailable[0]?.detail ?? 'No security matches these filters.',
    sort: { col: params.sort === 'name' ? 'name' : params.sort === 'ticker' ? 'key' : 'key', dir: 'asc' },
    ...(page === undefined ? {} : { page: { index: page.index, count: page.count } }),
  };

  // The tab strip is a filter, not a container: `grid#hits` is its sibling below (§SECF layout).
  // Each tab's body names the facet it selects, so the strip is still a node in its own right.
  const facetCount = (classes: readonly string[]): number =>
    classes.length === 0
      ? payload.total
      : classes.reduce((n, c) => n + (payload.facets.assetClass[c] ?? 0), 0);
  const tabs: Node = {
    kind: 'tabs',
    id: 'ac',
    active: AC_TABS.find((t) => t.classes.includes(params.assetClass ?? ''))?.id ?? 'all',
    tabs: AC_TABS.map((t, i) => ({
      id: t.id,
      label: `${t.label}(${String(facetCount(t.classes))})`,
      key: String(i + 1),
      body: {
        kind: 'text',
        id: `ac-${t.id}`,
        tone: 'muted',
        text:
          t.classes.length === 0
            ? `all asset classes · ${String(payload.total)} hits`
            : `${t.classes.join(' + ')} · ${String(facetCount(t.classes))} hits`,
      },
    })),
  };

  const notes: Badge[] = [
    ...(payload.source === 'master+yahoo'
      ? [
          {
            text: 'YAHOO_FALLBACK',
            tone: 'warn' as const,
            title: 'Some rows are not in the security master yet — Enter resolves them.',
          },
        ]
      : []),
    ...unavailableBadges(meta),
    ...entitlementBadges(meta),
    ...stalenessBadges(meta),
  ];

  return {
    title: 'SECF · Security Finder',
    subtitle: `${String(payload.hits.length)} of ${String(payload.total)} · page ${String((page?.index ?? 0) + 1)}/${String(page?.count ?? 1)} · ${payload.source} · sort ${params.sort}`,
    body: stack(
      'col',
      [
        filterForm(params, submit),
        tabs,
        grid,
        detailBlock(payload.hits[0]),
        { kind: 'badges', id: 'notes', items: notes },
      ],
      [0.12, 0.06, 0.58, 0.18, 0.06],
    ),
    footer: footer(meta),
    initialFocus: 'q',
  } satisfies ScreenSpec;
};

export default Screen;
