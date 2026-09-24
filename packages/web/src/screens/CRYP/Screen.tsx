// packages/web/src/screens/CRYP/Screen.tsx — Crypto Monitor (FUNCTIONS.md §7.3, FUNCTIONS_TIER3 §CRYP).
//
// The one screen in this build whose first job is to say what it is NOT. `payload.caveat` is
// `CONTEXT_ONLY_NOT_EXCHANGE_DATA` unconditionally, so `badges#caveat` is the first node of the
// body and is never conditional: a reader must meet the statement before the numbers.
//
// Two rules the grid encodes rather than describes:
//
//   * **The change column is `Chg 24h %`, never "today".** CoinGecko publishes a rolling 24-hour
//     move and a 24x7 asset has no close, so the header, the tooltip and the field the cell cites
//     (`CHG_PCT_1D`, which the plant derives from the reconstructed 24-hour-ago level) all say the
//     same thing. Nothing here presents a session boundary that does not exist.
//   * **A row with no seeded CoinGecko line keeps its row.** Its cells arrive `{v:null}` with their
//     reason; the screen renders them as they came and never substitutes a zero or a last value.
//
// Pure: no DOM, no state, no IO.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type { Badge, Cell, FunctionScreen, GridColumn, GridRow, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import {
  cell,
  entitlementBadges,
  footer,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'CRYP'>;
type Payload = PayloadOf<'CRYP'>;
type Row = Payload['rows'][number];

const COLUMNS: GridColumn[] = [
  { id: 'key', label: 'Security', align: 'left', sortable: true },
  { id: 'name', label: 'Name', align: 'left', sortable: true },
  { id: 'coingeckoId', label: 'CoinGecko id', align: 'left' },
  { id: 'px', label: 'Price', align: 'right', fieldId: 'PX_LAST', fmt: 'px', live: true, sortable: true },
  {
    id: 'chg24hPct',
    label: 'Chg 24h %',
    align: 'right',
    fieldId: 'CHG_PCT_1D',
    fmt: 'pct',
    decimals: 2,
    live: true,
    sortable: true,
  },
  { id: 'asOf', label: 'As of', align: 'left', fmt: 'datetime' },
  { id: 'state', label: 'State', align: 'left' },
];

function rowsGrid(p: Payload): Node {
  const rows: GridRow[] = p.rows.map((r: Row): GridRow => {
    const cells: Record<string, Cell> = {
      key: textCell(r.key, { command: `${r.key} DES` }),
      name: textCell(r.name),
      coingeckoId: textCell(r.coingeckoId),
      px: cell('PX_LAST', r.px),
      // Labelled and cited as the rolling 24-hour move it is (CRYP.ts decision 1).
      chg24hPct: cell('CHG_PCT_1D', r.chg24hPct, { fmt: 'pct', decimals: 2, signed: true }),
      asOf: textCell(r.asOf, { fmt: 'datetime' }),
      state: textCell(r.px.r === undefined ? r.px.st : `${r.px.st} · ${r.px.r}`),
    };
    return {
      id: `cryp:${r.coingeckoId}`,
      cells,
      subject: `q:${String(r.instrumentId)}`,
      command: `${r.key} DES`,
    };
  });

  return {
    kind: 'grid',
    id: 'rows',
    columns: COLUMNS,
    rows,
    frozenColumns: 2,
    selectable: true,
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    onEnter: (row: GridRow): string | null => row.command ?? null,
    onShiftEnter: (row: GridRow): string | null => row.command ?? null,
    emptyText: 'No CoinGecko ids selected.',
  };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta }) => {
  if (payload === undefined) {
    return {
      title: 'CRYP · Crypto Monitor',
      subtitle: 'context only — not exchange data',
      body: stack(
        'col',
        [
          {
            kind: 'badges',
            id: 'caveat',
            items: [
              {
                text: 'CONTEXT_ONLY_NOT_EXCHANGE_DATA',
                tone: 'warn',
                title: 'Indicative cross-venue prices from CoinGecko: no order book, no venue, no session.',
              },
            ],
          },
          {
            kind: 'grid',
            id: 'rows',
            columns: COLUMNS,
            rows: params.ids.map((id) => ({
              id: `cryp-skeleton:${id}`,
              cells: { coingeckoId: textCell(id), key: textCell(null) },
              tone: 'muted' as const,
            })),
            emptyText: 'loading…',
          },
        ],
        [0.1, 0.9],
      ),
      footer: footer(undefined),
      initialFocus: 'rows',
    } satisfies ScreenSpec;
  }

  const badges: Badge[] = [
    {
      text: `${payload.caveat} · source ${payload.source}`,
      tone: 'warn',
      title:
        'CoinGecko publishes an indicative cross-venue price and a rolling 24-hour change: there ' +
        'is no order book, no volume, no venue and no session state.',
    },
    ...entitlementBadges(meta),
    ...unavailableBadges(meta),
    ...stalenessBadges(meta),
  ];

  return {
    title: 'CRYP · Crypto Monitor',
    subtitle: `${String(payload.rows.length)} assets · sorted by ${params.sort} · context only`,
    body: stack('col', [{ kind: 'badges', id: 'caveat', items: badges }, rowsGrid(payload)], [0.1, 0.9]),
    footer: footer(meta, [
      'Values are indicative and are not exchange or venue prices (CONTEXT_ONLY_NOT_EXCHANGE_DATA).',
      'The change column is a rolling 24-hour move, not a change since a close.',
    ]),
    initialFocus: 'rows',
  } satisfies ScreenSpec;
};

export default Screen;
