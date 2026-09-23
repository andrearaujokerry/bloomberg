// packages/web/src/screens/DES/Screen.tsx — Security Description (FUNCTIONS_TIER1 §DES "Screen").
//
// Eight asset classes, eight layouts, one code (FUNC-02). The variant switch below mirrors
// `DesPayload`'s discriminant exactly, so a payload shape the runner accepted always has a screen.
//
// A screen is a PURE function of its props: it returns a `ScreenSpec` — data — and never touches
// the DOM, holds state or does IO. WP-12's `ScreenRenderer` draws what this returns.

import type { FieldId, ParamsOf, PayloadOf, ValueCell } from '@terminal/core';

import type { Cell, FunctionScreen, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import { newsList } from '../shared/newsList.js';
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

type Params = ParamsOf<'DES'>;
type Payload = PayloadOf<'DES'>;

/** The tab strip of each variant; `1`…`8` map onto it (§DES Keyboard). */
const TABS: Record<string, { id: string; label: string }[]> = {
  equity: [
    { id: 'profile', label: 'Profile' },
    { id: 'identifiers', label: 'Identifiers' },
    { id: 'listings', label: 'Listings' },
    { id: 'filings', label: 'Filings' },
    { id: 'news', label: 'News' },
    { id: 'members', label: 'Members' },
    { id: 'terms', label: 'Terms' },
    { id: 'history', label: 'History' },
  ],
  index: [
    { id: 'profile', label: 'Profile' },
    { id: 'members', label: 'Members' },
    { id: 'listings', label: 'Related' },
  ],
};

/** The subtitle line: what kind of thing the loaded security is. */
function subtitleOf(p: Payload): string {
  switch (p.variant) {
    case 'equity':
      return `${p.instrument.securityType} · ${p.instrument.exchCode} · ${p.instrument.currency}`;
    case 'index':
      return `${p.instrument.name} · ${p.terms.provider}`;
    case 'fx':
      return `Spot FX · ${p.terms.baseCcy}/${p.terms.quoteCcy}`;
    case 'govt':
      return `US Treasury ${p.terms.securityType} · ${p.terms.termLabel ?? p.terms.maturityDate}`;
    case 'option':
      return `Equity Option · ${p.terms.underlying.key}`;
    case 'crypto':
      return `Digital asset · CoinGecko (${p.coingeckoId})`;
    case 'rate':
      return `${p.terms.tenorDays === 1 ? 'Overnight rate' : 'Reference rate'} · ${p.terms.publisher}`;
    case 'econ':
      return `Economic series · ${p.series.sourceId}`;
  }
}

/** `kv#quote` — the live block every quoted variant shows. */
interface QuoteBlockCells {
  px: ValueCell;
  chgNet: ValueCell;
  chgPct: ValueCell;
  open: ValueCell;
  high: ValueCell;
  low: ValueCell;
  prevClose: ValueCell;
}

function quoteBlock(
  q: QuoteBlockCells,
  decimals: number,
  extra: { label: string; value: Cell }[] = [],
): Node {
  return {
    kind: 'kv',
    id: 'quote',
    title: 'Quote',
    columns: 2,
    rows: [
      kvRow('Last', cell('PX_LAST', q.px, { decimals })),
      kvRow('Chg', cell('CHG_NET_1D', q.chgNet, { decimals, signed: true })),
      kvRow('Chg %', cell('CHG_PCT_1D', q.chgPct, { signed: true })),
      kvRow('Open', cell('PX_OPEN', q.open, { decimals })),
      kvRow('High', cell('PX_HIGH', q.high, { decimals })),
      kvRow('Low', cell('PX_LOW', q.low, { decimals })),
      kvRow('Prev', cell('PX_CLOSE_1D', q.prevClose, { decimals })),
      ...extra.map((e) => kvRow(e.label, e.value)),
    ],
  };
}

/** `kv#stats` — the ANAL-07 block (§0.6 conventions), shared by equity, index and fx. */
function statsBlock(
  s: Extract<Payload, { variant: 'equity' }>['stats'],
  decimals: number,
): Node {
  return {
    kind: 'kv',
    id: 'stats',
    title: 'Statistics (simple, close, adjust price, 252 d)',
    columns: 2,
    rows: [
      kvRow('52w high', cell('PX_HIGH_52W', s.high52w, { decimals })),
      kvRow('52w low', cell('PX_LOW_52W', s.low52w, { decimals })),
      kvRow('Avg vol 30d', cell('VOLUME_AVG_30D', s.avgVolume30d)),
      kvRow('Vol 30d', cell('VOL_30D', s.vol30d)),
      kvRow('Ret 1D', cell('RET_1D', s.ret1d, { signed: true })),
      kvRow('Ret 1W', cell('RET_1W', s.ret1w, { signed: true })),
      kvRow('Ret 1M', cell('RET_1M', s.ret1m, { signed: true })),
      kvRow('Ret YTD', cell('RET_YTD', s.retYtd, { signed: true })),
      kvRow('Ret 1Y', cell('RET_1Y', s.ret1y, { signed: true })),
      kvRow('Beta 1Y', cell('BETA_1Y', s.beta1y)),
      kvRow('Bars as of', textCell(s.barsAsOf, { fmt: 'date' })),
    ],
  };
}

function identifiersTable(rows: Extract<Payload, { variant: 'equity' }>['identifiers']): Node {
  return {
    kind: 'table',
    id: 'identifiers',
    caption: 'Identifiers (REF-02)',
    columns: [
      { id: 'scheme', label: 'Scheme', type: 'string' },
      { id: 'value', label: 'Value', type: 'string' },
      { id: 'qualifier', label: 'Qualifier', type: 'string' },
      { id: 'primary', label: 'Primary', type: 'boolean' },
      { id: 'validFrom', label: 'Valid from', type: 'date' },
    ],
    rows: rows.map((r) => [
      textCell(r.scheme),
      textCell(r.value, { command: `/${r.scheme}/${r.value}` }),
      textCell(r.qualifier),
      textCell(r.isPrimary ? 'yes' : 'no'),
      textCell(r.validFrom, { fmt: 'date' }),
    ]),
  };
}

function listingsTable(rows: Extract<Payload, { variant: 'equity' }>['listings']): Node {
  return {
    kind: 'table',
    id: 'listings',
    caption: 'Listings',
    columns: [
      { id: 'exch', label: 'Exchange', type: 'string' },
      { id: 'mic', label: 'MIC', type: 'string' },
      { id: 'ticker', label: 'Local ticker', type: 'string' },
      { id: 'figi', label: 'FIGI', type: 'string' },
      { id: 'primary', label: 'Primary', type: 'boolean' },
      { id: 'status', label: 'Status', type: 'string' },
      { id: 'lines', label: 'Lines', type: 'number' },
    ],
    rows: rows.map((r) => [
      textCell(r.exchCode, { fieldId: 'EXCH_CODE' }),
      textCell(r.mic, { fieldId: 'PRIM_EXCH_MIC' }),
      textCell(r.localTicker, { fieldId: 'ID_EXCH_TICKER' }),
      textCell(r.figi, { fieldId: 'ID_FIGI_LISTING' }),
      textCell(r.isPrimary ? 'yes' : 'no'),
      textCell(r.listingStatus, { fieldId: 'LISTING_STATUS' }),
      countCell(r.mdLines.length),
    ]),
  };
}

function membershipTable(rows: Extract<Payload, { variant: 'equity' }>['membership']): Node {
  return {
    kind: 'table',
    id: 'membership',
    caption: 'Index membership',
    columns: [
      { id: 'index', label: 'Index', type: 'string' },
      { id: 'weight', label: 'Weight', type: 'number', decimals: 4 },
      { id: 'shares', label: 'Shares', type: 'number' },
      { id: 'asOf', label: 'As of', type: 'date' },
      { id: 'source', label: 'Source', type: 'string' },
    ],
    rows: rows.map((r) => [
      textCell(r.indexKey, { command: `${r.indexKey} MEMB` }),
      numCell('IDX_MEMBER_WEIGHT', r.weight, r.provIdx),
      numCell('IDX_MEMBER_SHARES', r.shares, r.provIdx),
      textCell(r.asOfDate, { fmt: 'date' }),
      textCell(r.sourceId),
    ]),
  };
}

function filingsList(rows: Extract<Payload, { variant: 'equity' }>['filings']): Node {
  return {
    kind: 'list',
    id: 'filings',
    items: rows.map((f) => ({
      id: `filing:${f.accessionNo}`,
      primary: `${f.form} · ${f.filedDate}`,
      secondary:
        f.items.length > 0 ? f.items.join(', ') : (f.primaryDocDesc ?? f.accessionNo),
      ts: f.acceptedAt ?? `${f.filedDate}T00:00:00.000Z`,
      badges: f.isXbrl ? [{ text: 'XBRL', tone: 'info' as const }] : [],
      url: f.url,
    })),
  };
}

/** The tab strip and the body of the active tab (`tab` is a param, not screen state — §DES L131). */
function equityTabs(p: Extract<Payload, { variant: 'equity' }>, active: string): Node {
  const bodies: Record<string, Node> = {
    profile: {
      kind: 'text',
      id: 'description',
      text: [
        p.issuer.legalName ?? p.issuer.name,
        p.issuer.website ?? '',
        p.issuer.formerNames.length > 0
          ? `Formerly: ${p.issuer.formerNames.map((f) => `${f.name} (${f.from}–${f.to ?? 'present'})`).join('; ')}`
          : '',
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
    },
    identifiers: identifiersTable(p.identifiers),
    listings: listingsTable(p.listings),
    filings: filingsList(p.filings),
    news: newsList('news', p.news, { showFeed: true, showKind: true }),
    members: membershipTable(p.membership),
    terms:
      p.fund === null
        ? { kind: 'text', id: 'fund', text: 'Not applicable — this is not a fund.', tone: 'muted' }
        : {
            kind: 'kv',
            id: 'fund',
            title: 'Fund terms',
            columns: 2,
            rows: [
              kvRow('Type', textCell(p.fund.fundType)),
              kvRow(
                'Tracks',
                textCell(p.fund.trackedIndex?.key ?? null, {
                  ...(p.fund.trackedIndex === null
                    ? {}
                    : { command: `${p.fund.trackedIndex.key} DES` }),
                }),
              ),
              kvRow('Sponsor', textCell(p.fund.sponsor)),
              kvRow('Expense ratio', countCell(p.fund.expenseRatio, 'pct', 2)),
              kvRow('Inception', textCell(p.fund.inceptionDate, { fmt: 'date' })),
              kvRow('Holdings as of', textCell(p.fund.holdingsAsOf, { fmt: 'date' })),
              kvRow('Holdings', countCell(p.fund.holdingsCount)),
            ],
          },
    history: { kind: 'text', id: 'history', text: 'Press H for HP.', tone: 'muted' },
  };
  return {
    kind: 'tabs',
    id: 'tabs',
    active,
    tabs: (TABS.equity ?? []).map((t, i) => ({
      id: t.id,
      label: t.label,
      key: String(i + 1),
      body: bodies[t.id] ?? { kind: 'text', id: `tab-${t.id}`, text: 'Not applicable.', tone: 'muted' },
    })),
  };
}

/** The body of each variant, below the header and the meta badge rows. */
function variantBody(p: Payload, params: Params): Node[] {
  switch (p.variant) {
    case 'equity': {
      const d = p.instrument.priceDecimals;
      const f = p.fundamentals;
      const profile: Node = {
        kind: 'kv',
        id: 'profile',
        title: 'Issuer',
        columns: 2,
        rows: [
          kvRow('Issuer', textCell(p.issuer.name)),
          kvRow('Legal name', textCell(p.issuer.legalName)),
          kvRow('CIK', textCell(p.issuer.cik, { fieldId: 'ID_CIK' })),
          kvRow('LEI', textCell(p.issuer.lei, { fieldId: 'ID_LEI' })),
          kvRow('SIC', textCell(p.issuer.sicCode, { fieldId: 'SIC_CODE' })),
          kvRow('SIC description', textCell(p.issuer.sicDescription, { fieldId: 'SIC_DESCRIPTION' })),
          kvRow('GICS sector', textCell(p.issuer.gicsSector, { fieldId: 'GICS_SECTOR_NAME' })),
          kvRow(
            'GICS industry group',
            textCell(p.issuer.gicsIndustryGroup, { fieldId: 'GICS_INDUSTRY_GROUP_NAME' }),
          ),
          kvRow('Incorporated', textCell(p.issuer.stateOfInc ?? p.issuer.countryOfIncorp)),
          kvRow('Fiscal year end', textCell(p.issuer.fiscalYearEnd, { fieldId: 'FISCAL_YEAR_END' })),
          kvRow('Filer category', textCell(p.issuer.filerCategory)),
          kvRow('Entity type', textCell(p.issuer.entityType, { fieldId: 'ISSUER_TYPE' })),
        ],
      };
      const fundamentals: Node = {
        kind: 'kv',
        id: 'fundamentals',
        title: 'Fundamentals',
        columns: 2,
        rows: [
          kvRow('Shares out', cell('EQY_SH_OUT', f.sharesOut)),
          kvRow('Float %', cell('EQY_FLOAT_PCT', f.publicFloat)),
          kvRow('Market cap', cell('CUR_MKT_CAP', f.mktCap)),
          kvRow('EPS TTM (dil)', cell('EPS_DIL', f.epsTtmDil)),
          kvRow('Revenue TTM', cell('SALES_REV_TURN', f.revenueTtm)),
          kvRow('Net income TTM', cell('NET_INCOME', f.netIncomeTtm)),
          kvRow('DPS 12m', cell('DVD_SH_12M', f.dvdSh12m)),
          kvRow('Dividend yield', cell('DVD_YIELD', f.dvdYield)),
          kvRow(
            'Last dividend',
            f.lastDividend === null
              ? blankCell('CA_AMOUNT')
              : numCell('CA_AMOUNT', f.lastDividend.amount, f.lastDividend.provIdx),
          ),
          kvRow(
            'Next earnings (est.)',
            textCell(f.nextEarnings?.expectedDate ?? null, { fmt: 'date' }),
          ),
          kvRow(
            'Short interest',
            f.shortInterest === null
              ? blankCell()
              : countCell(f.shortInterest.shortQty, 'shares', 0),
          ),
          kvRow('Statements as of', textCell(f.statementsAsOf?.periodEnd ?? null, { fmt: 'date' })),
        ],
      };
      return [
        stack(
          'row',
          [profile, stack('col', [quoteBlock(p.quote, d, [
            kvRow('Bid', cell('PX_BID', p.quote.bid, { decimals: d })).value === undefined
              ? { label: 'Bid', value: blankCell('PX_BID') }
              : { label: 'Bid', value: cell('PX_BID', p.quote.bid, { decimals: d }) },
            { label: 'Ask', value: cell('PX_ASK', p.quote.ask, { decimals: d }) },
            { label: 'Volume', value: cell('PX_VOLUME', p.quote.volume) },
            { label: 'IV 30d', value: cell('IVOL_30D', p.quote.ivol30d) },
            { label: 'Last trade', value: cell('LAST_TRADE_TIME', p.quote.lastTradeTime) },
          ]), statsBlock(p.stats, d), fundamentals], [0.3, 0.35, 0.35])],
          [0.5, 0.5],
        ),
        equityTabs(p, params.tab),
      ];
    }

    case 'index': {
      const d = p.instrument.priceDecimals;
      const terms: Node = {
        kind: 'kv',
        id: 'terms',
        title: 'Index terms',
        columns: 2,
        rows: [
          kvRow('Provider', textCell(p.terms.provider, { fieldId: 'IDX_PROVIDER' })),
          kvRow('Methodology', textCell(p.terms.methodology)),
          kvRow('Calc currency', textCell(p.terms.calcCurrency, { fieldId: 'CRNCY' })),
          kvRow('Region', textCell(p.terms.region)),
          kvRow('Base date', textCell(p.terms.baseDate, { fmt: 'date' })),
          kvRow('Base value', numCell('IDX_RATIO_BASE', p.terms.baseValue, p.terms.provIdx)),
          kvRow(
            'Constituents',
            numCell('IDX_MEMBER_COUNT', p.terms.constituentCount, p.terms.provIdx),
          ),
          kvRow(
            'Proxy fund',
            textCell(p.terms.proxyFund?.key ?? null, {
              fieldId: 'IDX_PROXY_FUND',
              ...(p.terms.proxyFund === null ? {} : { command: `${p.terms.proxyFund.key} DES` }),
            }),
          ),
        ],
      };
      const mb = p.membership;
      const members: Node =
        mb === null
          ? { kind: 'text', id: 'members', text: 'No membership source for this index.', tone: 'muted' }
          : {
              kind: 'table',
              id: 'members',
              caption: `Top 10 of ${String(mb.count)} · ${mb.asOfDate} · ${mb.sourceId}`,
              columns: [
                { id: 'key', label: 'Member', type: 'string' },
                { id: 'name', label: 'Name', type: 'string' },
                { id: 'weight', label: 'Weight', type: 'number', decimals: 4 },
              ],
              rows: mb.top10.map((m) => [
                textCell(m.key, { command: `${m.key} DES` }),
                textCell(m.name),
                numCell('IDX_MEMBER_WEIGHT', m.weight, mb.provIdx),
              ]),
            };
      const related: Node = {
        kind: 'list',
        id: 'related',
        items: p.related.map((r) => ({ id: `rel:${r.key}`, primary: r.label, secondary: r.key, command: `${r.key} DES` })),
      };
      return [
        stack('row', [terms, stack('col', [
          quoteBlock(p.quote, d, [
            { label: 'IV 30d', value: cell('IVOL_30D', p.quote.ivol30d) },
          ]),
          statsBlock(p.stats, d),
        ])], [0.4, 0.6]),
        {
          kind: 'tabs',
          id: 'tabs',
          active: params.tab === 'members' ? 'members' : params.tab === 'listings' ? 'listings' : 'profile',
          tabs: [
            {
              id: 'profile',
              label: 'Profile',
              key: '1',
              body: {
                kind: 'text',
                id: 'index-profile',
                text: `${p.terms.provider} · ${p.terms.methodology} · calculated in ${p.terms.calcCurrency}${p.terms.region === null ? '' : ` · ${p.terms.region}`}`,
              },
            },
            { id: 'members', label: 'Members', key: '2', body: members },
            { id: 'listings', label: 'Related', key: '3', body: related },
          ],
        },
      ];
    }

    case 'fx': {
      const d = p.instrument.priceDecimals;
      return [
        stack('row', [
          {
            kind: 'kv',
            id: 'terms',
            title: 'Terms',
            columns: 2,
            rows: [
              kvRow('Base', textCell(p.terms.baseCcy)),
              kvRow('Quote', textCell(p.terms.quoteCcy)),
              kvRow('Spot lag', countCell(p.terms.spotLag, 'int')),
              kvRow('Calendar', textCell(p.terms.calendarId, { fieldId: 'EXCH_CALENDAR_ID' })),
              kvRow('Pip', numCell('MIN_INCREMENT', p.terms.pipSize, p.terms.provIdx)),
              kvRow('Convention', textCell(p.terms.quoteConvention)),
            ],
          },
          stack('col', [
            quoteBlock(p.quote, d, [
              { label: 'Inverse', value: cell('PX_LAST', p.inverse, { decimals: d }) },
            ]),
            statsBlock(p.stats, d),
            {
              kind: 'kv',
              id: 'ecb',
              title: 'ECB reference',
              columns: 2,
              rows:
                p.ecb === null
                  ? [kvRow('ECB reference', blankCell())]
                  : [
                      kvRow('Rate date', textCell(p.ecb.rateDate, { fmt: 'date' })),
                      kvRow('Base per USD', numCell('FX_USD', p.ecb.baseCcyPerUsd, p.ecb.provIdx)),
                      kvRow('Quote per USD', numCell('FX_USD', p.ecb.quoteCcyPerUsd, p.ecb.provIdx)),
                      kvRow('Cross', numCell('PX_LAST', p.ecb.crossRate, p.ecb.provIdx, { decimals: d })),
                    ],
            },
          ]),
        ], [0.35, 0.65]),
      ];
    }

    case 'govt': {
      const t = p.terms;
      const terms: Node = {
        kind: 'kv',
        id: 'terms',
        title: 'Terms',
        columns: 2,
        rows: [
          kvRow('CUSIP', textCell(t.cusip, { fieldId: 'ID_CUSIP' })),
          kvRow('Type', textCell(t.securityType, { fieldId: 'BOND_TYPE' })),
          kvRow('Maturity', textCell(t.maturityDate, { fieldId: 'MATURITY', fmt: 'date' })),
          kvRow('Coupon', numCell('CPN', t.couponRate, t.provIdx)),
          kvRow('Frequency', numCell('CPN_FREQ', t.couponFreq, t.provIdx)),
          kvRow('Day count', textCell(t.dayCount, { fieldId: 'DAY_CNT' })),
          kvRow('Dated', textCell(t.datedDate, { fieldId: 'DATED_DT', fmt: 'date' })),
          kvRow('First coupon', textCell(t.firstCouponDate, { fieldId: 'FIRST_CPN_DT', fmt: 'date' })),
          kvRow('BDC', textCell(t.businessDayConv, { fieldId: 'BUSINESS_DAY_CONV' })),
          kvRow('Calendar', textCell(t.calendarId, { fieldId: 'SETTLE_CALENDAR' })),
          kvRow('Settle', numCell('SETTLE_DAYS', t.settlementDays, t.provIdx)),
          kvRow('Min denom', numCell('MIN_PIECE', t.minDenomination, t.provIdx)),
          kvRow('Outstanding', numCell('AMT_OUTSTANDING', t.amountOutstanding, t.provIdx)),
          kvRow('On the run', textCell(t.onTheRun ? 'yes' : 'no', { fieldId: 'ON_THE_RUN' })),
        ],
      };
      const pricing: Node =
        p.pricing === null
          ? { kind: 'text', id: 'pricing', text: 'No curve priced this security today.', tone: 'muted' }
          : {
              kind: 'kv',
              id: 'pricing',
              title: 'Pricing',
              columns: 2,
              rows: [
                kvRow('Settlement', textCell(p.pricing.settlementDate, { fmt: 'date' })),
                kvRow('Days to maturity', numCell('DAYS_TO_MTY', p.pricing.daysToMaturity, p.pricing.provIdx)),
                kvRow('Yield source', textCell(p.pricing.yieldSource)),
                kvRow('Curve', textCell(`${p.pricing.curveId} ${p.pricing.curveDate}`, { fieldId: 'CURVE_DATE' })),
                kvRow('Yield', cell('YLD_YTM_MID', p.pricing.yield)),
                kvRow('Discount', cell('DISC_RATE', p.pricing.discountRate)),
                kvRow('Price', cell('PX_CLEAN_MID', p.pricing.price)),
                kvRow('Accrued', cell('ACCRUED', p.pricing.accrued)),
                kvRow('Dirty', cell('PX_DIRTY_MID', p.pricing.dirtyPrice)),
                kvRow('Mac duration', cell('DUR_MID', p.pricing.macDuration)),
                kvRow('Mod duration', cell('DUR_ADJ_MID', p.pricing.modDuration)),
                kvRow('Convexity', cell('CONVEXITY_MID', p.pricing.convexity)),
                kvRow('DV01', cell('DV01', p.pricing.dv01)),
              ],
            };
      const engine: Node = {
        kind: 'badges',
        id: 'engine',
        items:
          p.pricing === null
            ? [{ text: 'no pricing', tone: 'warn' as const }]
            : [
                { text: `curve ${p.pricing.curveId} ${p.pricing.curveDate}`, tone: 'info' as const },
                { text: `settle ${p.pricing.settlementDate}`, tone: 'info' as const },
              ],
      };
      return [stack('row', [terms, pricing], [0.45, 0.55]), engine, identifiersTable(p.identifiers)];
    }

    case 'option': {
      const t = p.terms;
      const d = p.instrument.priceDecimals;
      return [
        stack('row', [
          {
            kind: 'kv',
            id: 'terms',
            title: 'Contract',
            columns: 2,
            rows: [
              kvRow('OCC', textCell(t.occSymbol, { fieldId: 'ID_OCC' })),
              kvRow('Root', textCell(t.root, { fieldId: 'OPT_ROOT' })),
              kvRow('Underlying', textCell(t.underlying.key, { fieldId: 'OPT_UNDL_TICKER', command: `${t.underlying.key} DES` })),
              kvRow('Expiry', textCell(t.expiry, { fieldId: 'OPT_EXPIRE_DT', fmt: 'date' })),
              kvRow('Strike', numCell('OPT_STRIKE_PX', t.strike, t.provIdx, { decimals: d })),
              kvRow('Put/Call', textCell(t.putCall, { fieldId: 'OPT_PUT_CALL' })),
              kvRow('Exercise', textCell(t.exerciseStyle, { fieldId: 'OPT_EXER_TYP' })),
              kvRow('Settlement', textCell(t.settlement, { fieldId: 'OPT_SETTLE_TYP' })),
              kvRow('AM/PM', textCell(t.amPm, { fieldId: 'OPT_AM_PM' })),
              kvRow('Multiplier', numCell('OPT_MULTIPLIER', t.multiplier, t.provIdx)),
              kvRow('Weekly', textCell(t.isWeekly ? 'yes' : 'no', { fieldId: 'OPT_IS_WEEKLY' })),
              kvRow('Days to expiry', countCell(t.daysToExpiry)),
            ],
          },
          stack('col', [
            {
              kind: 'kv',
              id: 'quote',
              title: 'Quote and greeks',
              columns: 2,
              rows: [
                kvRow('Bid', cell('PX_BID', p.quote.bid, { decimals: d })),
                kvRow('Ask', cell('PX_ASK', p.quote.ask, { decimals: d })),
                kvRow('Last', cell('PX_LAST', p.quote.last, { decimals: d })),
                kvRow('Volume', cell('PX_VOLUME', p.quote.volume)),
                kvRow('OI', cell('OPT_OI', p.quote.oi)),
                kvRow('IV', cell('OPT_IV', p.quote.iv)),
                kvRow('Delta', cell('OPT_DELTA', p.quote.delta)),
                kvRow('Gamma', cell('OPT_GAMMA', p.quote.gamma)),
                kvRow('Vega', cell('OPT_VEGA', p.quote.vega)),
                kvRow('Theta', cell('OPT_THETA', p.quote.theta)),
                kvRow('Rho', cell('OPT_RHO', p.quote.rho)),
                kvRow('Theo', cell('OPT_THEO', p.quote.theo)),
              ],
            },
            {
              kind: 'kv',
              id: 'moneyness',
              title: 'Moneyness',
              columns: 2,
              rows: [
                kvRow('Underlying', cell('OPT_UNDL_PX', p.underlying.px, { decimals: d })),
                kvRow('Underlying chg %', cell('CHG_PCT_1D', p.underlying.chgPct, { signed: true })),
                kvRow('Intrinsic', cell('OPT_INTRINSIC', p.moneyness.intrinsic, { decimals: d })),
                kvRow('Time value', cell('OPT_TIME_VALUE', p.moneyness.timeValue, { decimals: d })),
                kvRow('% from spot', cell('OPT_LOG_MNY', p.moneyness.pctFromSpot, { signed: true })),
              ],
            },
            {
              kind: 'kv',
              id: 'chain',
              title: 'Chain',
              columns: 2,
              rows:
                p.chain === null
                  ? [kvRow('Chain', blankCell())]
                  : [
                      kvRow('Expiries', textCell(p.chain.expiries.join(', '), { fieldId: 'EXPIRIES' })),
                      kvRow('Contracts', numCell('CONTRACT_COUNT', p.chain.contractCount, t.provIdx)),
                      kvRow('ATM IV', cell('ATM_IV', p.chain.atmIv)),
                      kvRow('Put/Call ratio', cell('PUT_CALL_RATIO', p.chain.putCallRatio)),
                    ],
            },
          ]),
        ], [0.4, 0.6]),
      ];
    }

    case 'crypto':
      return [
        {
          kind: 'badges',
          id: 'caveat',
          items: [
            { text: p.caveat, tone: 'warn', title: 'CoinGecko aggregates; this is not exchange data.' },
            { text: p.source, tone: 'info' },
          ],
        },
        {
          kind: 'kv',
          id: 'quote',
          title: 'Quote',
          columns: 2,
          rows: [
            kvRow('Last', cell('PX_LAST', p.px, { decimals: p.instrument.priceDecimals })),
            kvRow('24h change', cell('CHG_PCT_1D', p.chg24hPct, { signed: true })),
            kvRow('As of', textCell(p.asOf, { fmt: 'datetime' })),
            kvRow('CoinGecko id', textCell(p.coingeckoId)),
          ],
        },
      ];

    case 'rate': {
      const t = p.terms;
      const terms: Node = {
        kind: 'kv',
        id: 'terms',
        title: 'Terms',
        columns: 2,
        rows: [
          kvRow('Code', textCell(t.rateCode)),
          kvRow('Publisher', textCell(t.publisher)),
          kvRow('Day count', textCell(t.dayCount, { fieldId: 'DAY_CNT' })),
          kvRow('Publication (ET)', textCell(t.publicationTimeEt)),
          kvRow('Tenor (days)', numCell('DAYS_TO_MTY', t.tenorDays, t.provIdx)),
          kvRow('Compounding', textCell(t.compounding)),
          kvRow('Series', textCell(t.seriesCode)),
        ],
      };
      const latest: Node =
        p.latest === null
          ? { kind: 'text', id: 'latest', text: 'No fixing captured.', tone: 'muted' }
          : {
              kind: 'kv',
              id: 'latest',
              title: 'Latest fixing',
              columns: 2,
              rows: [
                kvRow('Effective', textCell(p.latest.effectiveDate, { fmt: 'date' })),
                kvRow('Rate', cell('RATE', p.latest.rate)),
                kvRow('1st pct', cell('RATE_P1', p.latest.pct1)),
                kvRow('25th pct', cell('RATE_P25', p.latest.pct25)),
                kvRow('75th pct', cell('RATE_P75', p.latest.pct75)),
                kvRow('99th pct', cell('RATE_P99', p.latest.pct99)),
                kvRow('Volume ($bn)', cell('RATE_VOLUME_BN', p.latest.volumeBn)),
                kvRow('Target from', cell('TARGET_FROM', p.latest.targetFrom)),
                kvRow('Target to', cell('TARGET_TO', p.latest.targetTo)),
                kvRow('Revision', textCell(p.latest.revisionIndicator, { fieldId: 'REVISED' })),
                kvRow('Vintage', textCell(p.latest.vintageAt, { fmt: 'datetime' })),
              ],
            };
      const averages: Node =
        p.averages === null
          ? { kind: 'text', id: 'averages', text: 'No compounded averages for this rate.', tone: 'muted' }
          : {
              kind: 'kv',
              id: 'averages',
              title: 'Averages',
              columns: 2,
              rows: [
                kvRow('Effective', textCell(p.averages.effectiveDate, { fmt: 'date' })),
                kvRow('30d', numCell('RATE', p.averages.avg30d, p.averages.provIdx)),
                kvRow('90d', numCell('RATE', p.averages.avg90d, p.averages.provIdx)),
                kvRow('180d', numCell('RATE', p.averages.avg180d, p.averages.provIdx)),
                kvRow('Index', numCell('VALUE', p.averages.indexValue, p.averages.provIdx)),
              ],
            };
      return [
        stack('row', [terms, stack('col', [latest, averages])], [0.35, 0.65]),
        {
          kind: 'custom',
          id: 'sparkline',
          component: 'Sparkline',
          props: {
            label: p.instrument.display,
            points: p.history.map((h) => ({ t: h.effectiveDate, v: h.rate })),
            fieldId: 'RATE',
          },
        },
        { kind: 'text', id: 'description', text: p.description },
      ];
    }

    case 'econ': {
      const s = p.series;
      return [
        stack('row', [
          {
            kind: 'kv',
            id: 'series',
            title: 'Series',
            columns: 2,
            rows: [
              kvRow('Code', textCell(s.code)),
              kvRow('Name', textCell(s.name)),
              kvRow('Source', textCell(`${s.sourceId} · ${s.providerCode}`)),
              kvRow('Units', textCell(s.units)),
              kvRow('Frequency', textCell(s.frequency)),
              kvRow('Seasonal adj', textCell(s.seasonalAdj)),
              kvRow('Country', textCell(s.country)),
              kvRow('Release', textCell(s.releaseName)),
              kvRow('First obs', textCell(s.firstObsDate, { fmt: 'date' })),
              kvRow('Last obs', textCell(s.lastObsDate, { fmt: 'date' })),
            ],
          },
          {
            kind: 'kv',
            id: 'latest',
            title: 'Latest',
            columns: 2,
            rows: [
              kvRow('Period', textCell(p.latest?.obsDate ?? null, { fieldId: 'ECO_PERIOD', fmt: 'date' })),
              kvRow(
                'Value',
                p.latest === null ? blankCell('ECO_VALUE') : cell('ECO_VALUE', p.latest.value, { decimals: s.decimals }),
              ),
              kvRow('Status', textCell(p.latest?.status ?? null)),
              kvRow('Vintage', textCell(p.latest?.vintageAt ?? null, { fieldId: 'ECO_VINTAGE', fmt: 'datetime' })),
              kvRow('Prior period', textCell(p.prior?.obsDate ?? null, { fmt: 'date' })),
              kvRow('Prior value', countCell(p.prior?.value ?? null, 'text', s.decimals)),
              kvRow('Change', countCell(p.change?.abs ?? null, 'text', s.decimals)),
              kvRow('Change %', countCell(p.change?.pct ?? null, 'pct', 2)),
              kvRow(
                'Next release',
                textCell(p.nextRelease?.scheduledAt ?? null, { fieldId: 'ECO_RELEASE_DT', fmt: 'datetime' }),
              ),
            ],
          },
        ], [0.45, 0.55]),
        {
          kind: 'table',
          id: 'history',
          caption: `History · knownAt ${p.knownAt}`,
          columns: [
            { id: 'period', label: 'Period', type: 'date' },
            { id: 'value', label: 'Value', type: 'number', decimals: s.decimals },
            { id: 'status', label: 'Status', type: 'string' },
          ],
          rows: p.history.map((h) => [
            textCell(h.obsDate, { fmt: 'date' }),
            numCell('ECO_VALUE', h.value, s.provIdx, { decimals: s.decimals }),
            textCell(h.status),
          ]),
        },
      ];
    }
  }
}

/** The header cells each variant can supply; a variant without a live quote shows a pending header. */
function headerCells(p: Payload): { px?: ValueCell; chgNet?: ValueCell; chgPct?: ValueCell; sessionState?: ValueCell } {
  switch (p.variant) {
    case 'equity':
    case 'index':
    case 'fx':
      return {
        px: p.quote.px,
        chgNet: p.quote.chgNet,
        chgPct: p.quote.chgPct,
        sessionState: p.quote.sessionState,
      };
    case 'option':
      return { px: p.quote.last, chgNet: p.quote.chgNet, chgPct: p.quote.chgPct };
    case 'crypto':
      return { px: p.px, chgPct: p.chg24hPct };
    case 'govt':
      return p.pricing === null ? {} : { px: p.pricing.price };
    case 'rate':
      return p.latest === null ? {} : { px: p.latest.rate };
    case 'econ':
      return p.latest === null ? {} : { px: p.latest.value };
  }
}

/** DES renders the header with the variant's leading number, which is not always `PX_LAST`. */
function headerPxField(p: Payload): FieldId {
  switch (p.variant) {
    case 'govt':
      return 'PX_CLEAN_MID';
    case 'rate':
      return 'RATE';
    case 'econ':
      return 'ECO_VALUE';
    default:
      return 'PX_LAST';
  }
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, instrument, meta }) => {
  const display = payload?.instrument.display ?? instrument?.display ?? '—';
  const name = payload?.instrument.name ?? instrument?.name ?? '';

  if (payload === undefined) {
    // Skeleton: the header with muted values and the tab strip with its labels (§DES "Screen").
    const tabs = TABS.equity ?? [];
    return {
      title: `DES · ${display} · ${name}`,
      subtitle: 'loading…',
      body: stack('col', [
        quoteHeader(instrument ?? null, {}),
        {
          kind: 'tabs',
          id: 'tabs',
          active: params.tab,
          tabs: tabs.map((t, i) => ({
            id: t.id,
            label: t.label,
            key: String(i + 1),
            body: { kind: 'text', id: `tab-${t.id}`, text: '…', tone: 'muted' },
          })),
        },
      ]),
      footer: footer(undefined),
      initialFocus: 'tabs',
    } satisfies ScreenSpec;
  }

  const badges: Node[] = [];
  const entitlement = entitlementBadges(meta);
  if (entitlement.length > 0) badges.push({ kind: 'badges', id: 'entitlement', items: entitlement });
  const unavailable = [...unavailableBadges(meta), ...stalenessBadges(meta)];
  if (unavailable.length > 0) badges.push({ kind: 'badges', id: 'unavailable', items: unavailable });

  const body = stack('col', [
    quoteHeader(payload.instrument, headerCells(payload), { pxField: headerPxField(payload) }),
    ...badges,
    ...variantBody(payload, params),
  ]);

  const hasTabs = (node: Node): boolean =>
    node.kind === 'tabs' || (node.kind === 'split' && node.children.some(hasTabs));

  const notes: string[] = [];
  if (payload.variant === 'equity' || payload.variant === 'econ') {
    if (meta !== undefined) notes.push(`knownAt=${meta.asOf.knownAt}`);
  }

  return {
    title: `DES · ${payload.instrument.display} · ${payload.instrument.name}`,
    subtitle: subtitleOf(payload),
    body,
    footer: footer(meta, notes),
    initialFocus: hasTabs(body) ? 'tabs' : 'header',
  } satisfies ScreenSpec;
};

export default Screen;
