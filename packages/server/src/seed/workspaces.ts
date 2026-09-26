// packages/server/src/seed/workspaces.ts
//
// Seed module 13 of DATA_MODEL §18 (L2572), the last one: what a seeded desk looks like when it logs
// in — a four-panel workspace per user, three watchlists and one portfolio.
//
//   fixtures/seed/workspaces.json → workspaces 7 (WEI / TOP / GP SPX / W "Core" per user),
//                                   watchlists 3 + watchlist_items, portfolios 1, lots 12, positions 12
//
// Three things here are worth reading before changing anything.
//
// **1. The layout is validated by the wire schema, not trusted.** `layout` is a `jsonb` column, so
// Postgres will accept any shape at all, and a malformed one surfaces as a client crash on somebody's
// first login rather than as a seed failure. `WorkspaceLayout` (API.md §5.7) is parsed here for the
// same reason `http/routes/workspaces.ts` parses `DEFAULT_WORKSPACE_LAYOUT` at module load: a field
// the schema gains and the fixture lacks should stop the seed.
//
// **2. A frame never carries a bare ticker.** REF-01: the command line resolves a security to an
// instrument and the frame stores the id. So the fixture writes `{ticker, exchCode, display}` as a
// *reference* and this module substitutes `{id, display}`; when the instrument does not exist —
// `seed/universe.ts` is module 3 and the modules are independently skippable — the panel is written
// with `security: null` and a warning. A frame pointing at an id nothing resolves to would be worse
// than a frame with no security: the first is a broken screen, the second is an empty one.
//
// **3. "S&P 500 Top 25" is derived, not listed.** "Top 25" is an ordering by index weight, and the
// weights are a recorded fact — the SPY N-PORT and SSGA holdings files in `etf_holdings`. Copying 25
// tickers into the fixture would freeze a ranking with no provenance behind it and no way to notice
// it had gone stale. Reading `etf_holdings` means the list is whatever the recorded file says, and an
// empty `etf_holdings` yields an empty watchlist, which is visibly empty.
//
// Idempotence: `workspaces` upserts on `(user_id, name)`, `watchlists` on `(owner_user_id, name)`,
// `watchlist_items` on `(watchlist_id, position)` — and the item set is *replaced* rather than merged,
// because a list that shortened must shorten. `portfolios` upserts on `(firm_id, name)`, `positions`
// on `(portfolio_id, as_of_date, raw_identifier, lot_id)`. `lots` has no natural key at all (0012), so
// it is keyed on `(portfolio_id, instrument_id, open_date, external_ref)` by hand, with
// `external_ref` carrying the fixture's own lot label — which is what makes a re-seed recognise the
// lot it wrote last time instead of doubling the book.

import { WorkspaceLayout } from '@terminal/sdk/wire/rest/workspaces';

import { readSeedFixture, withTenant } from './users.js';

import type { SeedContext } from './index.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** How the fixture names a security before this module resolves it (see note 2 in the header). */
interface SecurityRef {
  ticker: string;
  exchCode: string;
  display: string;
}

interface WatchlistItemFixture {
  ticker?: string;
  exchCode?: string;
  formula?: string;
  label?: string;
  note?: string;
}

interface WatchlistFixture {
  key: string;
  name: string;
  owner: string;
  sharedScope: 'private' | 'firm' | 'users';
  columns: unknown[];
  sort: unknown[];
  groupBy: string | null;
  tickers?: SecurityRef[] | { ticker: string; exchCode: string }[];
  items?: WatchlistItemFixture[];
  derivedFrom?: {
    kind: 'etf_holdings';
    etfTicker: string;
    etfExchCode: string;
    limit: number;
    orderBy: 'weight_desc';
  };
}

interface LotFixture {
  ticker: string;
  exchCode: string;
  openDate: string;
  quantity: number;
  unitCost: number;
  currency: string;
}

interface PortfolioFixture {
  key: string;
  name: string;
  firm: string;
  owner: string;
  baseCurrency: string;
  benchmark: { ticker: string; exchCode: string };
  asOfDate: string;
  lots: LotFixture[];
}

interface WorkspacesFixture {
  workspaceName: string;
  layout: Record<string, unknown>;
  watchlists: WatchlistFixture[];
  portfolios: PortfolioFixture[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The live composite instrument for `(ticker, exchCode)`, or `null`.
 *
 * `instruments` is bitemporal, so "live" is the current version currently believed
 * (`tx_to = 'infinity' AND valid_to = 'infinity'`) — the same predicate `db/bitemporal.ts#current`
 * builds, spelled out because this module writes SQL rather than using the query builder. A
 * `delisted`, `matured` or `expired` instrument is excluded: a seeded watchlist should not open on a
 * row that cannot quote. `pending` is *not* excluded — DATA_MODEL §21.1 leaves ≈ 1,600 Cboe roots
 * pending for want of a second symbology pass, and none of them is named by this fixture anyway.
 */
async function resolveInstrument(
  ctx: SeedContext,
  ticker: string,
  exchCode: string,
): Promise<number | null> {
  const found = await ctx.query(
    `SELECT instrument_id FROM instruments
      WHERE ticker = $1 AND exch_code = $2
        AND tx_to = 'infinity' AND valid_to = 'infinity'
        AND status IN ('active', 'pending')
      ORDER BY instrument_id
      LIMIT 1`,
    [ticker, exchCode],
  );
  const row = found.rows[0] as { instrument_id: string | number } | undefined;
  return row === undefined ? null : Number(row.instrument_id);
}

/** `users.user_id` by email, and `firms.firm_id` by name — module 12's rows, read back by key. */
async function readDesk(ctx: SeedContext): Promise<{
  userIdByEmail: Map<string, number>;
  usersByKey: Map<string, { userId: number; firmId: number; role: string }>;
  firmIdByName: Map<string, number>;
}> {
  const users = await ctx.query(
    `SELECT u.user_id, u.email, u.firm_id, u.role, f.name AS firm_name
       FROM users u JOIN firms f ON f.firm_id = u.firm_id
      ORDER BY u.user_id`,
  );
  const firms = await ctx.query(`SELECT firm_id, name FROM firms`);

  const userIdByEmail = new Map<string, number>();
  const usersByKey = new Map<string, { userId: number; firmId: number; role: string }>();
  for (const row of users.rows as {
    user_id: string | number;
    email: string;
    firm_id: string | number;
    role: string;
  }[]) {
    const userId = Number(row.user_id);
    userIdByEmail.set(row.email.toLowerCase(), userId);
    // The fixtures reference a user by the local part of their email (`pm`, `analyst`, `eod`), which
    // is the `key` field of users.json; deriving it here rather than re-reading that fixture keeps
    // module 13 independent of module 12's file layout and dependent only on its rows.
    const key = row.email.split('@')[0];
    if (key !== undefined) {
      usersByKey.set(key, { userId, firmId: Number(row.firm_id), role: row.role });
    }
  }

  const firmIdByName = new Map(
    (firms.rows as { firm_id: string | number; name: string }[]).map((r) => [
      r.name,
      Number(r.firm_id),
    ]),
  );
  return { userIdByEmail, usersByKey, firmIdByName };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Watchlists
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One resolved watchlist row: an instrument, or a CHRT-07 formula. */
interface ResolvedItem {
  instrumentId: number | null;
  formula: string | null;
  label: string | null;
  note: string | null;
}

/**
 * The rows of one watchlist, in order.
 *
 * `watchlist_items` has `CHECK ((instrument_id IS NULL) <> (formula IS NULL))` (0012), so exactly one
 * of the two is set per row and an unresolvable ticker produces **no row at all** rather than a row
 * with neither. That is why an unresolved ticker is logged: a silently shorter list is the kind of
 * thing nobody notices until a screenshot is wrong.
 */
async function resolveWatchlistItems(
  ctx: SeedContext,
  list: WatchlistFixture,
): Promise<ResolvedItem[]> {
  const out: ResolvedItem[] = [];

  const fromFixture: WatchlistItemFixture[] = [...(list.tickers ?? []), ...(list.items ?? [])];
  for (const item of fromFixture) {
    if (item.formula !== undefined) {
      out.push({
        instrumentId: null,
        formula: item.formula,
        label: item.label ?? null,
        note: item.note ?? null,
      });
      continue;
    }
    if (item.ticker === undefined || item.exchCode === undefined) {
      throw new Error(
        `watchlist '${list.name}' has an item that is neither a formula nor a ` +
          '(ticker, exchCode) pair — fixtures/seed/workspaces.json',
      );
    }
    const instrumentId = await resolveInstrument(ctx, item.ticker, item.exchCode);
    if (instrumentId === null) {
      ctx.log(
        `watchlist '${list.name}': ${item.ticker} ${item.exchCode} does not resolve to a live ` +
          'instrument (seed/universe.ts, module 3) — the row is left out',
      );
      continue;
    }
    out.push({
      instrumentId,
      formula: null,
      label: item.label ?? null,
      note: item.note ?? null,
    });
  }

  if (list.derivedFrom !== undefined) {
    const etfId = await resolveInstrument(
      ctx,
      list.derivedFrom.etfTicker,
      list.derivedFrom.etfExchCode,
    );
    if (etfId === null) {
      ctx.log(
        `watchlist '${list.name}' is derived from ${list.derivedFrom.etfTicker} holdings, which ` +
          'does not resolve to an instrument — the list is created empty',
      );
    } else {
      // The latest as-of date only. DATA_MODEL §21.1 open question 3: SSGA and the N-PORT disagree
      // on a constituent between their two as-of dates and `etf_holdings` keeps both, so taking
      // "all rows for SPY" would double the list and interleave two files. `weight DESC NULLS LAST`
      // then `line_no` makes the ordering total, so the same holdings file always produces the same
      // 25 names in the same order.
      const holdings = await ctx.query(
        `SELECT h.holding_instrument_id
           FROM etf_holdings h
          WHERE h.etf_instrument_id = $1
            AND h.holding_instrument_id IS NOT NULL
            AND h.as_of_date = (SELECT max(as_of_date) FROM etf_holdings WHERE etf_instrument_id = $1)
          ORDER BY h.weight DESC NULLS LAST, h.line_no
          LIMIT $2`,
        [etfId, list.derivedFrom.limit],
      );
      const seen = new Set(out.map((r) => r.instrumentId));
      for (const row of holdings.rows as { holding_instrument_id: string | number }[]) {
        const instrumentId = Number(row.holding_instrument_id);
        if (seen.has(instrumentId)) continue;
        seen.add(instrumentId);
        out.push({ instrumentId, formula: null, label: null, note: null });
      }
      if (holdings.rows.length === 0) {
        ctx.log(
          `watchlist '${list.name}': etf_holdings holds no resolved row for ` +
            `${list.derivedFrom.etfTicker} — the list is created empty rather than guessed`,
        );
      }
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The module
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SeedWorkspacesResult {
  workspacesWritten: number;
  watchlistsWritten: number;
  watchlistItemsWritten: number;
  portfoliosWritten: number;
  lotsInserted: number;
  positionsWritten: number;
  unresolvedSecurities: number;
}

export async function seedWorkspaces(ctx: SeedContext): Promise<SeedWorkspacesResult> {
  const fixture = readSeedFixture<WorkspacesFixture>('workspaces.json');
  const desk = await readDesk(ctx);

  const result: SeedWorkspacesResult = {
    workspacesWritten: 0,
    watchlistsWritten: 0,
    watchlistItemsWritten: 0,
    portfoliosWritten: 0,
    lotsInserted: 0,
    positionsWritten: 0,
    unresolvedSecurities: 0,
  };

  if (desk.usersByKey.size === 0) {
    // Not an error: `only: ['workspaces']` on an empty database is a legitimate invocation, and
    // saying so beats writing nothing in silence.
    ctx.log('no users exist yet (seed/users.ts, module 12) — nothing to do');
    return result;
  }

  // ── watchlists first: the default layout names one by name ───────────────────────────────────
  for (const list of fixture.watchlists) {
    const owner = desk.usersByKey.get(list.owner);
    if (owner === undefined) {
      ctx.log(`watchlist '${list.name}' is owned by '${list.owner}', who is not seeded — skipped`);
      continue;
    }

    const written = await ctx.query(
      `INSERT INTO watchlists (owner_user_id, firm_id, name, columns, sort, group_by, shared_scope)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       ON CONFLICT (owner_user_id, name) DO UPDATE
          SET columns = EXCLUDED.columns, sort = EXCLUDED.sort,
              group_by = EXCLUDED.group_by, shared_scope = EXCLUDED.shared_scope
        WHERE watchlists.columns      IS DISTINCT FROM EXCLUDED.columns
           OR watchlists.sort         IS DISTINCT FROM EXCLUDED.sort
           OR watchlists.group_by     IS DISTINCT FROM EXCLUDED.group_by
           OR watchlists.shared_scope IS DISTINCT FROM EXCLUDED.shared_scope
       RETURNING watchlist_id`,
      [
        owner.userId,
        owner.firmId,
        list.name,
        JSON.stringify(list.columns),
        JSON.stringify(list.sort),
        list.groupBy,
        list.sharedScope,
      ],
    );
    if (written.rows.length > 0) result.watchlistsWritten += 1;

    const found = await ctx.query(
      `SELECT watchlist_id FROM watchlists WHERE owner_user_id = $1 AND name = $2`,
      [owner.userId, list.name],
    );
    const watchlistId = Number(
      (found.rows[0] as { watchlist_id: string | number } | undefined)?.watchlist_id,
    );
    if (Number.isNaN(watchlistId))
      throw new Error(`watchlist '${list.name}' has no id after upsert`);

    const items = await resolveWatchlistItems(ctx, list);

    // The item set is replaced, not merged: `(watchlist_id, position)` is the primary key, so a list
    // that lost a row would otherwise keep the old row at the position nothing writes any more. The
    // DELETE is scoped to positions past the new end, and each surviving position is upserted with a
    // predicate so an unchanged row is not rewritten — the second run then reports zero.
    const deleted = await ctx.query(
      `DELETE FROM watchlist_items WHERE watchlist_id = $1 AND position > $2 RETURNING position`,
      [watchlistId, items.length],
    );
    result.watchlistItemsWritten += deleted.rows.length;

    for (const [index, item] of items.entries()) {
      const itemWritten = await ctx.query(
        `INSERT INTO watchlist_items (watchlist_id, position, instrument_id, formula, label, note)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (watchlist_id, position) DO UPDATE
            SET instrument_id = EXCLUDED.instrument_id, formula = EXCLUDED.formula,
                label = EXCLUDED.label, note = EXCLUDED.note
          WHERE watchlist_items.instrument_id IS DISTINCT FROM EXCLUDED.instrument_id
             OR watchlist_items.formula       IS DISTINCT FROM EXCLUDED.formula
             OR watchlist_items.label         IS DISTINCT FROM EXCLUDED.label
             OR watchlist_items.note          IS DISTINCT FROM EXCLUDED.note
         RETURNING position`,
        [watchlistId, index + 1, item.instrumentId, item.formula, item.label, item.note],
      );
      result.watchlistItemsWritten += itemWritten.rows.length;
    }
    ctx.log(`watchlist '${list.name}': ${String(items.length)} rows`);
  }

  // ── the default workspace, one per user ─────────────────────────────────────────────────────
  //
  // The layout is resolved once and written to all seven users: it names no user-specific id (the W
  // panel names its list by name, which is what makes that possible), so seven identical `jsonb`
  // documents is the honest representation rather than a shortcoming.
  const layout = await resolveLayout(ctx, fixture.layout, result);
  const layoutJson = JSON.stringify(layout);

  for (const [key, user] of [...desk.usersByKey].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const written = await ctx.query(
      `INSERT INTO workspaces (user_id, firm_id, name, is_active, layout)
       VALUES ($1, $2, $3, true, $4::jsonb)
       ON CONFLICT (user_id, name) DO UPDATE SET layout = EXCLUDED.layout
        WHERE workspaces.layout IS DISTINCT FROM EXCLUDED.layout
       RETURNING workspace_id`,
      [user.userId, user.firmId, fixture.workspaceName, layoutJson],
    );
    if (written.rows.length > 0) result.workspacesWritten += 1;
    else ctx.log(`workspace for '${key}' is already current`);
  }
  ctx.log(
    `workspaces ~${String(result.workspacesWritten)} of ${String(desk.usersByKey.size)} users`,
  );

  // ── the portfolio, its lots and its positions ────────────────────────────────────────────────
  for (const portfolio of fixture.portfolios) {
    const owner = desk.usersByKey.get(portfolio.owner);
    const firmId = desk.firmIdByName.get(
      portfolio.firm === 'demo' ? 'Demo Capital' : portfolio.firm,
    );
    if (owner === undefined || firmId === undefined) {
      ctx.log(`portfolio '${portfolio.name}' has no seeded owner or firm — skipped`);
      continue;
    }
    await seedPortfolio(ctx, portfolio, { userId: owner.userId, firmId, role: owner.role }, result);
  }

  return result;
}

/**
 * Substitute resolved instrument ids into the fixture's frames and parse the result.
 *
 * The parse is deliberately the *last* step: `WorkspaceLayout` rejects a `security` that is not
 * `{id, display} | null`, so it is also the check that every reference was substituted and none was
 * left in its fixture shape.
 */
async function resolveLayout(
  ctx: SeedContext,
  raw: Record<string, unknown>,
  result: SeedWorkspacesResult,
): Promise<unknown> {
  const layout = structuredClone(raw) as {
    panels: { frameStack: { security: SecurityRef | { id: number; display: string } | null }[] }[];
  };

  for (const panel of layout.panels) {
    for (const frame of panel.frameStack) {
      const security = frame.security;
      if (security === null || !('ticker' in security)) continue;
      const instrumentId = await resolveInstrument(ctx, security.ticker, security.exchCode);
      if (instrumentId === null) {
        result.unresolvedSecurities += 1;
        ctx.log(
          `layout frame names ${security.display}, which does not resolve to a live instrument ` +
            '(seed/universe.ts, module 3) — the panel is written with no security (REF-01)',
        );
        frame.security = null;
        continue;
      }
      frame.security = { id: instrumentId, display: security.display };
    }
  }

  const parsed = WorkspaceLayout.safeParse(layout);
  if (!parsed.success) {
    throw new Error(
      'fixtures/seed/workspaces.json `layout` does not satisfy WorkspaceLayout (API.md §5.7): ' +
        JSON.stringify(parsed.error.issues),
    );
  }
  return parsed.data;
}

/** One portfolio, its open lots and its as-of positions, under the owning firm's RLS context. */
async function seedPortfolio(
  ctx: SeedContext,
  fixture: PortfolioFixture,
  tenant: { userId: number; firmId: number; role: string },
  result: SeedWorkspacesResult,
): Promise<void> {
  const benchmarkId = await resolveInstrument(
    ctx,
    fixture.benchmark.ticker,
    fixture.benchmark.exchCode,
  );
  if (benchmarkId === null) {
    result.unresolvedSecurities += 1;
    ctx.log(
      `portfolio '${fixture.name}': benchmark ${fixture.benchmark.ticker} does not resolve; ` +
        'PORT will report NO_BENCHMARK rather than attribute against a guess',
    );
  }

  // `portfolios`, `lots` and `positions` are FORCE ROW LEVEL SECURITY (0015 §15.f), so every write
  // below happens under the owning user's identity — see `seed/users.ts#withTenant` for why that is
  // not optional.
  await withTenant(ctx, tenant, async () => {
    const written = await ctx.query(
      `INSERT INTO portfolios (firm_id, owner_user_id, name, base_currency, benchmark_instrument_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (firm_id, name) DO UPDATE
          SET base_currency = EXCLUDED.base_currency,
              benchmark_instrument_id = EXCLUDED.benchmark_instrument_id
        WHERE portfolios.base_currency           IS DISTINCT FROM EXCLUDED.base_currency
           OR portfolios.benchmark_instrument_id IS DISTINCT FROM EXCLUDED.benchmark_instrument_id
       RETURNING portfolio_id`,
      [tenant.firmId, tenant.userId, fixture.name, fixture.baseCurrency, benchmarkId],
    );
    if (written.rows.length > 0) result.portfoliosWritten += 1;

    const found = await ctx.query(
      `SELECT portfolio_id FROM portfolios WHERE firm_id = $1 AND name = $2`,
      [tenant.firmId, fixture.name],
    );
    const portfolioId = Number(
      (found.rows[0] as { portfolio_id: string | number } | undefined)?.portfolio_id,
    );
    if (Number.isNaN(portfolioId)) {
      throw new Error(`portfolio '${fixture.name}' has no id after upsert`);
    }

    for (const lot of fixture.lots) {
      const instrumentId = await resolveInstrument(ctx, lot.ticker, lot.exchCode);
      const rawIdentifier = `${lot.ticker} ${lot.exchCode}`;

      if (instrumentId === null) {
        result.unresolvedSecurities += 1;
        // `lots.instrument_id` is NOT NULL, so an unresolved holding cannot be a lot — but it can
        // still be a position, and `recon_status = 'unresolved'` is exactly the state PORT-01's
        // reconciliation report is for. Dropping the holding would understate the book; writing it
        // unresolved says what is true.
        ctx.log(
          `portfolio '${fixture.name}': ${rawIdentifier} does not resolve; written as an ` +
            "unresolved position with no lot (recon_status 'unresolved')",
        );
      } else {
        // `lots` has no unique constraint (0012), so the seed identifies its own row by
        // `external_ref`. Without it a second run would insert a thirteenth lot, and lot-level cost
        // basis would silently double.
        const externalRef = `seed:${fixture.key}:${rawIdentifier}`;
        const lotWritten = await ctx.query(
          `INSERT INTO lots (portfolio_id, firm_id, instrument_id, open_date, quantity, unit_cost, currency, external_ref)
           SELECT $1, $2, $3, $4::date, $5::numeric, $6::numeric, $7, $8
            WHERE NOT EXISTS (
              SELECT 1 FROM lots WHERE portfolio_id = $1 AND external_ref = $8)
           RETURNING lot_id`,
          [
            portfolioId,
            tenant.firmId,
            instrumentId,
            lot.openDate,
            lot.quantity.toFixed(8),
            lot.unitCost.toFixed(8),
            lot.currency,
            externalRef,
          ],
        );
        result.lotsInserted += lotWritten.rows.length;
      }

      const positionWritten = await ctx.query(
        `INSERT INTO positions (portfolio_id, firm_id, as_of_date, instrument_id, raw_identifier,
                                is_cash, lot_id, quantity, cost_price, cost_currency, trade_date, recon_status)
         VALUES ($1, $2, $3::date, $4, $5, false, 'default', $6::numeric, $7::numeric, $8, $9::date, $10)
         ON CONFLICT (portfolio_id, as_of_date, raw_identifier, lot_id) DO UPDATE
            SET instrument_id = EXCLUDED.instrument_id, quantity = EXCLUDED.quantity,
                cost_price = EXCLUDED.cost_price, cost_currency = EXCLUDED.cost_currency,
                trade_date = EXCLUDED.trade_date, recon_status = EXCLUDED.recon_status
          WHERE positions.instrument_id IS DISTINCT FROM EXCLUDED.instrument_id
             OR positions.quantity      IS DISTINCT FROM EXCLUDED.quantity
             OR positions.cost_price    IS DISTINCT FROM EXCLUDED.cost_price
             OR positions.cost_currency IS DISTINCT FROM EXCLUDED.cost_currency
             OR positions.trade_date    IS DISTINCT FROM EXCLUDED.trade_date
             OR positions.recon_status  IS DISTINCT FROM EXCLUDED.recon_status
         RETURNING position_id`,
        [
          portfolioId,
          tenant.firmId,
          fixture.asOfDate,
          instrumentId,
          rawIdentifier,
          lot.quantity.toFixed(8),
          lot.unitCost.toFixed(6),
          lot.currency,
          lot.openDate,
          instrumentId === null ? 'unresolved' : 'ok',
        ],
      );
      result.positionsWritten += positionWritten.rows.length;
    }
  });

  ctx.log(
    `portfolio '${fixture.name}': lots +${String(result.lotsInserted)}, ` +
      `positions ~${String(result.positionsWritten)} of ${String(fixture.lots.length)}`,
  );
}

/** Module 13 of the ordered seed runner (`seed/index.ts`) — the last one. */
export const workspacesSeedModule = {
  order: 13,
  name: 'workspaces',
  run: seedWorkspaces,
} as const;
