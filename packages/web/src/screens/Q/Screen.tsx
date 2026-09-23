// packages/web/src/screens/Q/Screen.tsx — Quote (FUNCTIONS_TIER1 §Q "Screen").
//
// Q is the screen that shows its own working: the composite quote, every market-data line that
// contributed to it with its three timestamps (FEED-05), the top of book, the tape and the session.
// `Enter` on a line opens its provenance, which is why every line cell carries `provIdx`.

import type { FieldId, ParamsOf, PayloadOf, ValueCell } from '@terminal/core';

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
  blankCell,
  cell,
  countCell,
  entitlementBadges,
  footer,
  kvRow,
  numCell,
  quoteHeader,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'Q'>;
type Payload = PayloadOf<'Q'>;
type Cells = Payload['composite'];

/** A composite or line cell: present → the payload's cell, absent → pending, never invented. */
function fieldCell(cells: Cells, field: FieldId, decimals?: number): Cell {
  const vc: ValueCell | undefined = cells[field];
  if (vc === undefined) return blankCell(field);
  return cell(field, vc, decimals === undefined ? {} : { decimals });
}

/** `table#book` — top of book, with the reason under it when the source publishes no depth. */
function bookTable(p: Payload): Node {
  const d = p.instrument.priceDecimals;
  const rows: Cell[][] = [];
  const levels = Math.max(p.book.bids.length, p.book.asks.length, p.book.depthRequested);
  for (let i = 0; i < levels; i += 1) {
    const bid = p.book.bids[i];
    const ask = p.book.asks[i];
    rows.push([
      textCell(String(i + 1)),
      bid === undefined ? blankCell('PX_BID') : numCell('PX_BID', bid.px, bid.provIdx, { decimals: d }),
      bid === undefined ? blankCell('BID_SIZE') : numCell('BID_SIZE', bid.size, bid.provIdx),
      bid === undefined ? textCell(null) : textCell(bid.venue),
      ask === undefined ? blankCell('PX_ASK') : numCell('PX_ASK', ask.px, ask.provIdx, { decimals: d }),
      ask === undefined ? blankCell('ASK_SIZE') : numCell('ASK_SIZE', ask.size, ask.provIdx),
      ask === undefined ? textCell(null) : textCell(ask.venue),
    ]);
  }
  return {
    kind: 'table',
    id: 'book',
    caption:
      p.book.reason === null
        ? `Top of book · ${String(p.book.depthAvailable)} level(s)`
        : `${p.book.reason} — requested ${String(p.book.depthRequested)}, available ${String(p.book.depthAvailable)}`,
    columns: [
      { id: 'level', label: 'Lvl', type: 'string' },
      { id: 'bid', label: 'Bid', type: 'number' },
      { id: 'bidSize', label: 'Size', type: 'number' },
      { id: 'bidVenue', label: 'Venue', type: 'string' },
      { id: 'ask', label: 'Ask', type: 'number' },
      { id: 'askSize', label: 'Size', type: 'number' },
      { id: 'askVenue', label: 'Venue', type: 'string' },
    ],
    rows,
  };
}

function ohlcBlock(p: Payload): Node {
  const d = p.instrument.priceDecimals;
  return {
    kind: 'kv',
    id: 'ohlc',
    title: 'Session',
    columns: 2,
    rows: [
      kvRow('Open', fieldCell(p.composite, 'PX_OPEN', d)),
      kvRow('High', fieldCell(p.composite, 'PX_HIGH', d)),
      kvRow('Low', fieldCell(p.composite, 'PX_LOW', d)),
      kvRow('Prev', fieldCell(p.composite, 'PX_CLOSE_1D', d)),
      kvRow('Official close', fieldCell(p.composite, 'PX_OFFICIAL_CLOSE', d)),
      kvRow('Volume', fieldCell(p.composite, 'PX_VOLUME')),
      kvRow('VWAP', fieldCell(p.composite, 'VWAP', d)),
      kvRow('IV 30d', fieldCell(p.composite, 'IVOL_30D')),
    ],
  };
}

/** `grid#lines` — one row per market-data line, live on its own `l:` subject. */
function linesGrid(p: Payload): Node {
  const d = p.instrument.priceDecimals;
  const columns: GridColumn[] = [
    { id: 'line', label: 'Line', align: 'left' },
    { id: 'source', label: 'Source', align: 'left' },
    { id: 'symbol', label: 'Symbol', align: 'left' },
    { id: 'last', label: 'Last', fieldId: 'PX_LAST', fmt: 'px', decimals: d, align: 'right', live: true },
    { id: 'bid', label: 'Bid', fieldId: 'PX_BID', fmt: 'px', decimals: d, align: 'right', live: true },
    { id: 'ask', label: 'Ask', fieldId: 'PX_ASK', fmt: 'px', decimals: d, align: 'right', live: true },
    { id: 'volume', label: 'Volume', fieldId: 'PX_VOLUME', fmt: 'int', align: 'right', live: true },
    { id: 'srcTs', label: 'Src ts', fmt: 'datetime', align: 'left' },
    { id: 'capTs', label: 'Cap ts', fmt: 'datetime', align: 'left' },
    { id: 'pubTs', label: 'Pub ts', fmt: 'datetime', align: 'left' },
    { id: 'seq', label: 'Seq', fmt: 'int', align: 'right' },
    { id: 'state', label: 'State', align: 'left' },
  ];
  const rows: GridRow[] = p.lines.map((l) => ({
    id: `line:${String(l.mdLineId)}`,
    subject: l.subject,
    cells: {
      line: textCell(String(l.mdLineId), { provIdx: l.provIdx }),
      source: textCell(l.sourceId, { fieldId: 'SOURCE_ID', provIdx: l.provIdx }),
      symbol: textCell(l.providerSymbol, { provIdx: l.provIdx }),
      last: fieldCell(l.cells, 'PX_LAST', d),
      bid: fieldCell(l.cells, 'PX_BID', d),
      ask: fieldCell(l.cells, 'PX_ASK', d),
      volume: fieldCell(l.cells, 'PX_VOLUME'),
      srcTs: textCell(l.ts.src, { fmt: 'datetime' }),
      capTs: textCell(l.ts.cap, { fmt: 'datetime' }),
      pubTs: textCell(l.ts.pub, { fmt: 'datetime' }),
      seq: countCell(l.srcSeq),
      state: textCell(l.st, { fieldId: 'PLANT_STATE' }),
    },
  }));
  return {
    kind: 'grid',
    id: 'lines',
    columns,
    rows,
    frozenColumns: 3,
    selectable: true,
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    emptyText: 'No market-data line publishes this security.',
  };
}

function tapeList(p: Payload): Node {
  return {
    kind: 'list',
    id: 'tape',
    items: p.tape.map((t, i) => ({
      id: `tick:${String(i)}:${t.capTs}`,
      primary:
        t.kind === 'trade'
          ? `T ${String(t.price ?? '—')} ×${String(t.size ?? '—')}`
          : t.kind === 'quote'
            ? `Q ${String(t.bid ?? '—')}/${String(t.ask ?? '—')}`
            : 'S summary',
      ...(t.conditions.length > 0 ? { secondary: t.conditions.join(' ') } : {}),
      ts: t.capTs,
      badges: t.tickDir === null ? [] : [{ text: t.tickDir, tone: 'info' as const }],
    })),
  };
}

function sessionBlock(p: Payload): Node {
  if (p.session === null) {
    return { kind: 'text', id: 'session', text: 'No calendar for this instrument.', tone: 'muted' };
  }
  return {
    kind: 'kv',
    id: 'session',
    title: 'Trading session',
    columns: 3,
    rows: [
      kvRow('State', textCell(p.session.state, { fieldId: 'SESSION_STATE' })),
      kvRow('Calendar', textCell(p.session.calendarId, { fieldId: 'EXCH_CALENDAR_ID' })),
      kvRow('Timezone', textCell(p.session.tz, { fieldId: 'EXCH_TIMEZONE' })),
      kvRow('Open', textCell(p.session.openLocal)),
      kvRow('Close', textCell(p.session.closeLocal)),
      kvRow('Next change', textCell(p.session.nextChangeAt, { fmt: 'datetime' })),
      kvRow('Early close', textCell(p.session.earlyClose ? 'yes' : 'no')),
    ],
  };
}

/** The option and rate variants of the right-hand column (§Q "Option variant adds…"). */
function extraBlocks(p: Payload): Node[] {
  if (p.instrument.assetClass === 'option') {
    return [
      {
        kind: 'kv',
        id: 'greeks',
        title: 'Greeks (as published)',
        columns: 2,
        rows: [
          kvRow('IV', fieldCell(p.composite, 'OPT_IV')),
          kvRow('Delta', fieldCell(p.composite, 'OPT_DELTA')),
          kvRow('Gamma', fieldCell(p.composite, 'OPT_GAMMA')),
          kvRow('Vega', fieldCell(p.composite, 'OPT_VEGA')),
          kvRow('Theta', fieldCell(p.composite, 'OPT_THETA')),
          kvRow('Theo', fieldCell(p.composite, 'OPT_THEO')),
          kvRow('Open interest', fieldCell(p.composite, 'OPT_OI')),
          kvRow('Underlying', fieldCell(p.composite, 'OPT_UNDL_PX')),
        ],
      },
    ];
  }
  if (p.instrument.assetClass === 'rate') {
    return [
      {
        kind: 'kv',
        id: 'fixing',
        title: 'Fixing',
        columns: 2,
        rows: [
          kvRow('Rate', fieldCell(p.composite, 'RATE')),
          kvRow('1st pct', fieldCell(p.composite, 'RATE_P1')),
          kvRow('25th pct', fieldCell(p.composite, 'RATE_P25')),
          kvRow('75th pct', fieldCell(p.composite, 'RATE_P75')),
          kvRow('99th pct', fieldCell(p.composite, 'RATE_P99')),
          kvRow('Volume ($bn)', fieldCell(p.composite, 'RATE_VOLUME_BN')),
          kvRow('Target from', fieldCell(p.composite, 'TARGET_FROM')),
          kvRow('Target to', fieldCell(p.composite, 'TARGET_TO')),
        ],
      },
    ];
  }
  return [];
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, instrument, meta }) => {
  const display = payload?.instrument.display ?? instrument?.display ?? '—';
  const name = payload?.instrument.name ?? instrument?.name ?? '';
  const title = `Q · ${display} · ${name}`;

  if (payload === undefined) {
    return {
      title,
      subtitle: 'loading…',
      body: stack('col', [
        quoteHeader(instrument ?? null, {}),
        {
          kind: 'table',
          id: 'book',
          caption: 'Top of book',
          columns: [
            { id: 'level', label: 'Lvl', type: 'string' },
            { id: 'bid', label: 'Bid', type: 'number' },
            { id: 'ask', label: 'Ask', type: 'number' },
          ],
          rows: [],
        },
      ]),
      footer: footer(undefined),
      initialFocus: 'book',
    } satisfies ScreenSpec;
  }

  const d = payload.instrument.priceDecimals;
  const dqBadges: Badge[] = payload.dq.map((flag) => ({
    text: String(flag),
    tone: 'warn' as const,
    title: 'Data-quality flag raised by the composite merge (OPS-03).',
  }));
  const header = quoteHeader(
    payload.instrument,
    {
      ...(payload.composite.PX_LAST === undefined ? {} : { px: payload.composite.PX_LAST }),
      ...(payload.composite.CHG_NET_1D === undefined
        ? {}
        : { chgNet: payload.composite.CHG_NET_1D }),
      ...(payload.composite.CHG_PCT_1D === undefined
        ? {}
        : { chgPct: payload.composite.CHG_PCT_1D }),
      ...(payload.composite.SESSION_STATE === undefined
        ? {}
        : { sessionState: payload.composite.SESSION_STATE }),
    },
    {
      priceDecimals: d,
      extra: [
        { label: 'Size', value: fieldCell(payload.composite, 'LAST_SIZE') },
        { label: 'Last trade', value: fieldCell(payload.composite, 'LAST_TRADE_TIME') },
        { label: 'Tick', value: fieldCell(payload.composite, 'TICK_DIR') },
      ],
    },
  );

  const badges: Node[] = [];
  const chips = [
    ...dqBadges,
    ...entitlementBadges(meta),
    ...unavailableBadges(meta),
    ...stalenessBadges(meta),
  ];
  if (chips.length > 0) badges.push({ kind: 'badges', id: 'dq', items: chips });

  const rules: Node = {
    kind: 'text',
    id: 'rules',
    mono: true,
    tone: 'muted',
    text: payload.compositionRules.join('\n'),
  };

  const body = stack(
    'col',
    [
      header,
      ...badges,
      stack(
        'row',
        [bookTable(payload), stack('col', [ohlcBlock(payload), ...extraBlocks(payload)]), stack('col', [linesGrid(payload), rules], [0.75, 0.25])],
        [0.3, 0.35, 0.35],
      ),
      tapeList(payload),
      sessionBlock(payload),
    ],
    [0.18, 0.82],
  );

  const focus = params.view === 'lines' ? 'lines' : params.view === 'tape' ? 'tape' : 'book';

  return {
    title,
    subtitle: `${payload.session?.state ?? 'unknown'} · ${payload.tier} · ${String(payload.delayMin)} min delayed · seq ${String(payload.compositeSeq)}`,
    body,
    footer: footer(meta),
    initialFocus: focus,
  } satisfies ScreenSpec;
};

export default Screen;
