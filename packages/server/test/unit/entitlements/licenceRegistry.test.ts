/**
 * WORKPLAN WP-07 — `entitlements/licenceRegistry.ts`, the process-local copy of `licence_registry`,
 * `field_licence` and `entitlement_grants` that ARCHITECTURE §10 rules 1, 2 and 10 read.
 *
 * A unit test in the strict sense: the database is a fake that RECORDS every query it is handed and
 * answers it from arrays this file writes. That is deliberate, and it is the only way to assert the
 * two properties that matter most here, both of which are about queries rather than about results:
 *
 *  - `refreshIfStale()` costs ONE `SELECT` when nothing moved and five when something did. A test
 *    that only checked the returned data would pass against an implementation that reloaded all
 *    three tables on every call — which is the bug the method exists to avoid.
 *  - `reload()` reads the version BEFORE the data. A bump that lands mid-load must leave the stored
 *    version BEHIND, so the next `refreshIfStale()` reloads; reading it last would pin a torn
 *    snapshot forever. The fake bumps itself mid-load and the test proves the snapshot recovers.
 *
 * The clock is virtual, so `grantsFor`'s as-of filter is asserted by moving time rather than by
 * waiting for it.
 */

import { describe, expect, it } from 'vitest';

import type { AssetClass, FieldClass, Tier } from '@terminal/core';

import type { Db } from '../../../src/db/client.js';
import { licenceRegistry } from '../../../src/entitlements/licenceRegistry.js';
import { testClock, TEST_NOW } from '../../../src/test/clock.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The fake database
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `licence_registry` as the driver returns it (every numeric column may arrive as a string). */
interface LicenceRow {
  source_id: string;
  source_name: string;
  publisher: string;
  licence_kind: string;
  display: boolean;
  non_display: boolean;
  derived: boolean;
  redistribution: boolean;
  export_allowed: boolean;
  api_allowed: boolean;
  max_tier: Tier;
  intrinsic_delay_min: number | string;
  retention_days: number | string | null;
  attribution: string | null;
  contract_ref: string | null;
}

interface FieldRow {
  field_id: string;
  asset_class: AssetClass | null;
  source_id: string;
  field_class: FieldClass;
}

interface GrantRowSql {
  grant_id: string;
  subject_kind: string;
  subject_id: string;
  source_id: string | null;
  asset_class: AssetClass | null;
  field_class: FieldClass | null;
  max_tier: Tier;
  usage_display: boolean;
  usage_export: boolean;
  usage_api: boolean;
  valid_from: string | null;
  valid_to: string | null;
  contract_ref: string | null;
}

type QueryKind = 'version' | 'licences' | 'fields' | 'grants' | 'unknown';

/** Recover the SQL text of a drizzle template so the fake can tell the four queries apart. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: readonly unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk;
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.join('') : '';
    })
    .join(' ');
}

function classify(text: string): QueryKind {
  if (text.includes('config_versions')) return 'version';
  if (text.includes('FROM licence_registry')) return 'licences';
  if (text.includes('FROM field_licence')) return 'fields';
  if (text.includes('FROM entitlement_grants')) return 'grants';
  return 'unknown';
}

interface FakeDb {
  /** The handle to hand the registry. */
  readonly db: Db;
  /** `null` = `config_versions` holds no `entitlements` row yet. */
  version: number | null;
  licences: LicenceRow[];
  fields: FieldRow[];
  grants: GrantRowSql[];
  /** Every query served, in order. */
  readonly seen: QueryKind[];
  /** The SQL text of the last query of each kind. */
  readonly texts: Partial<Record<QueryKind, string>>;
  /** Ran once, just after the query of that kind has been answered. */
  after: Partial<Record<QueryKind, () => void>>;
  /** Queries of one kind served so far. */
  count(kind: QueryKind): number;
  reset(): void;
}

function fakeDb(): FakeDb {
  const seen: QueryKind[] = [];
  const state: FakeDb = {
    db: undefined as unknown as Db,
    version: 1,
    licences: [],
    fields: [],
    grants: [],
    seen,
    texts: {},
    after: {},
    count(kind: QueryKind): number {
      return seen.filter((k) => k === kind).length;
    },
    reset(): void {
      seen.length = 0;
    },
  };

  const execute = (query: unknown): Promise<{ rows: unknown[] }> => {
    const text = sqlText(query);
    const kind = classify(text);
    seen.push(kind);
    state.texts[kind] = text;
    let rows: unknown[];
    switch (kind) {
      case 'version':
        rows = state.version === null ? [] : [{ version: String(state.version) }];
        break;
      case 'licences':
        rows = [...state.licences];
        break;
      case 'fields':
        rows = [...state.fields];
        break;
      case 'grants':
        rows = [...state.grants];
        break;
      default:
        throw new Error(`fakeDb: unrecognised query ${sqlText(query)}`);
    }
    state.after[kind]?.();
    return Promise.resolve({ rows });
  };

  state.db = { execute } as Db;
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row builders
// ─────────────────────────────────────────────────────────────────────────────────────────────

function licence(sourceId: string, over: Partial<LicenceRow> = {}): LicenceRow {
  return {
    source_id: sourceId,
    source_name: `${sourceId} feed`,
    publisher: 'Publisher',
    licence_kind: 'exchange_delayed',
    display: true,
    non_display: false,
    derived: false,
    redistribution: false,
    export_allowed: true,
    api_allowed: false,
    max_tier: 'delayed',
    intrinsic_delay_min: '15',
    retention_days: '90',
    attribution: 'Cboe BZX',
    contract_ref: null,
    ...over,
  };
}

function field(
  fieldId: string,
  assetClass: AssetClass | null,
  sourceId: string,
  fieldClass: FieldClass = 'price',
): FieldRow {
  return { field_id: fieldId, asset_class: assetClass, source_id: sourceId, field_class: fieldClass };
}

let nextGrantId = 1;

function grant(
  subjectKind: 'user' | 'firm',
  subjectId: number,
  over: Partial<GrantRowSql> = {},
): GrantRowSql {
  return {
    grant_id: String(nextGrantId++),
    subject_kind: subjectKind,
    subject_id: String(subjectId),
    source_id: null,
    asset_class: null,
    field_class: null,
    max_tier: 'delayed',
    usage_display: true,
    usage_export: false,
    usage_api: false,
    valid_from: null,
    valid_to: null,
    contract_ref: null,
    ...over,
  };
}

const iso = (offsetMs: number): string => new Date(TEST_NOW + offsetMs).toISOString();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('entitlements/licenceRegistry — the snapshot (ARCHITECTURE §10 rules 1, 2, 10)', () => {
  it('loads the version first and the three tables after it', async () => {
    const db = fakeDb();
    db.licences = [licence('cboe.quotes')];
    db.fields = [field('PX_LAST', 'equity', 'cboe.quotes')];
    db.grants = [grant('user', 1)];

    const registry = licenceRegistry({ db: db.db, clock: testClock() });
    await registry.reload();

    // The order is not cosmetic: the version must be read before the data it describes.
    expect(db.seen).toEqual(['version', 'licences', 'fields', 'grants']);
    expect(registry.version()).toBe(1);
    expect(registry.stats()).toEqual({
      version: 1,
      licences: 1,
      fieldLicences: 1,
      grants: 1,
      loads: 1,
      freshChecks: 0,
    });
  });

  it('reads only the current, in-force version of licence_registry', async () => {
    const db = fakeDb();
    db.licences = [licence('cboe.quotes')];
    const registry = licenceRegistry({ db: db.db, clock: testClock() });
    await registry.reload();

    // A superseded version and a not-yet-in-force one are excluded by the QUERY — this module never
    // re-filters in TypeScript what SQL has already narrowed — so the assertion is on the query: it
    // must carry the open transaction end AND both sides of the validity bracket. Drop any one of
    // the three and the snapshot starts serving terms that are no longer (or not yet) in force.
    const text = db.texts.licences ?? '';
    expect(text).toContain("tx_to = 'infinity'");
    expect(text).toContain('valid_from <=');
    expect(text).toContain('valid_to');
    expect(registry.licence('cboe.quotes')).toEqual({
      sourceId: 'cboe.quotes',
      sourceName: 'cboe.quotes feed',
      publisher: 'Publisher',
      licenceKind: 'exchange_delayed',
      display: true,
      nonDisplay: false,
      derived: false,
      redistribution: false,
      exportAllowed: true,
      apiAllowed: false,
      maxTier: 'delayed',
      // Both arrived from the driver as strings and must be numbers on the way out: a `maxTier`
      // comparison against a stringly-typed delay is how a ceiling stops binding.
      intrinsicDelayMin: 15,
      retentionDays: 90,
      attribution: 'Cboe BZX',
      contractRef: null,
    });
    expect(registry.licence('nyfed.rates')).toBeUndefined();
  });

  it('keeps an unlimited retention (null) distinct from zero', async () => {
    const db = fakeDb();
    db.licences = [licence('internal.derived', { retention_days: null })];
    const registry = licenceRegistry({ db: db.db, clock: testClock() });
    await registry.reload();
    expect(registry.licence('internal.derived')?.retentionDays).toBeNull();
  });

  describe('fieldSource — rule 1', () => {
    it('prefers the exact (field_id, asset_class) row over the field-wide fallback', async () => {
      const db = fakeDb();
      db.licences = [licence('cboe.quotes'), licence('yahoo.chart')];
      // The field-wide row is loaded FIRST here and second in the next assertion: the exact row must
      // win either way, because row order out of Postgres is not a contract.
      db.fields = [
        field('PX_LAST', null, 'yahoo.chart'),
        field('PX_LAST', 'equity', 'cboe.quotes'),
      ];
      const registry = licenceRegistry({ db: db.db, clock: testClock() });
      await registry.reload();
      expect(registry.fieldSource('PX_LAST', 'equity')).toEqual({
        sourceId: 'cboe.quotes',
        fieldClass: 'price',
      });

      const reversed = fakeDb();
      reversed.fields = [
        field('PX_LAST', 'equity', 'cboe.quotes'),
        field('PX_LAST', null, 'yahoo.chart'),
      ];
      const other = licenceRegistry({ db: reversed.db, clock: testClock() });
      await other.reload();
      expect(other.fieldSource('PX_LAST', 'equity')).toEqual({
        sourceId: 'cboe.quotes',
        fieldClass: 'price',
      });
    });

    it('answers the field-wide view only for a caller that names no asset class', async () => {
      const db = fakeDb();
      db.fields = [field('BS_TOT_ASSET', 'equity', 'sec.companyfacts', 'fundamental')];
      const registry = licenceRegistry({ db: db.db, clock: testClock() });
      await registry.reload();

      // One source across the field's rows, so the field-wide view is unambiguous and a request
      // that names no asset class still resolves.
      expect(registry.fieldSource('BS_TOT_ASSET', null)).toEqual({
        sourceId: 'sec.companyfacts',
        fieldClass: 'fundamental',
      });
      // …but 'etf' has no row of its own, and the equity row is NOT portable to it. Resolving it
      // would let an equity-scoped contract be billed for a field it never bought; the evaluator
      // turns this miss into FIELD_UNKNOWN (deny).
      expect(registry.fieldSource('BS_TOT_ASSET', 'etf')).toBeUndefined();
    });

    it('returns undefined rather than guessing when the field rows disagree', async () => {
      const db = fakeDb();
      db.fields = [
        field('PX_LAST', 'equity', 'cboe.quotes'),
        field('PX_LAST', 'fx', 'yahoo.chart'),
        field('PX_LAST', 'option', 'cboe.options'),
      ];
      const registry = licenceRegistry({ db: db.db, clock: testClock() });
      await registry.reload();

      // Each named class resolves exactly…
      expect(registry.fieldSource('PX_LAST', 'fx')?.sourceId).toBe('yahoo.chart');
      expect(registry.fieldSource('PX_LAST', 'option')?.sourceId).toBe('cboe.options');
      // …and a class with no row of its own resolves to NOTHING, because three sources cannot be
      // averaged. The evaluator turns this into FIELD_UNKNOWN (deny), which is the point: an
      // unprovable field is never served from a guessed source.
      expect(registry.fieldSource('PX_LAST', 'crypto')).toBeUndefined();
      expect(registry.fieldSource('PX_LAST', null)).toBeUndefined();
    });

    it('returns undefined for a field the matrix does not carry at all', async () => {
      const db = fakeDb();
      db.fields = [field('PX_LAST', 'equity', 'cboe.quotes')];
      const registry = licenceRegistry({ db: db.db, clock: testClock() });
      await registry.reload();
      // A news field: real `field_licence` has no row for one, and the dictionary's own `sources[]`
      // must not stand in for the licence matrix.
      expect(registry.fieldSource('HEADLINE', 'equity')).toBeUndefined();
      expect(registry.fieldSource('HEADLINE', null)).toBeUndefined();
    });
  });

  describe('grantsFor — the as-of window', () => {
    it('returns only the rows whose validity brackets the clock', async () => {
      const db = fakeDb();
      db.grants = [
        grant('user', 7, { source_id: 'open', valid_from: null, valid_to: null }),
        grant('user', 7, { source_id: 'expired', valid_from: iso(-86_400_000), valid_to: iso(-1) }),
        grant('user', 7, { source_id: 'future', valid_from: iso(60_000), valid_to: null }),
        grant('user', 7, { source_id: 'current', valid_from: iso(-60_000), valid_to: iso(60_000) }),
      ];
      const clock = testClock();
      const registry = licenceRegistry({ db: db.db, clock });
      await registry.reload();

      expect(registry.grantsFor('user', 7).map((g) => g.sourceId).sort()).toEqual([
        'current',
        'open',
      ]);
      // `stats()` counts what was LOADED; `grantsFor` filters what applies. Four rows are held.
      expect(registry.stats().grants).toBe(4);

      // Two minutes later the bracketed grant has lapsed and the future one has begun — with no
      // reload, because validity is decided per call and not baked into the snapshot.
      clock.advance(120_000);
      expect(registry.grantsFor('user', 7).map((g) => g.sourceId).sort()).toEqual([
        'future',
        'open',
      ]);
      expect(registry.stats().loads).toBe(1);
    });

    it('treats the bracket as half-open: valid_from inclusive, valid_to exclusive', async () => {
      const db = fakeDb();
      db.grants = [
        grant('user', 7, { source_id: 'starts-now', valid_from: iso(0), valid_to: iso(1000) }),
        grant('user', 7, { source_id: 'ends-now', valid_from: iso(-1000), valid_to: iso(0) }),
      ];
      const registry = licenceRegistry({ db: db.db, clock: testClock() });
      await registry.reload();
      expect(registry.grantsFor('user', 7).map((g) => g.sourceId)).toEqual(['starts-now']);
    });

    it('never mixes a user subject with a firm subject of the same id', async () => {
      const db = fakeDb();
      db.grants = [
        grant('user', 7, { source_id: 'user-7', max_tier: 'realtime' }),
        grant('firm', 7, { source_id: 'firm-7' }),
      ];
      const registry = licenceRegistry({ db: db.db, clock: testClock() });
      await registry.reload();
      expect(registry.grantsFor('user', 7).map((g) => g.sourceId)).toEqual(['user-7']);
      expect(registry.grantsFor('firm', 7).map((g) => g.sourceId)).toEqual(['firm-7']);
      expect(registry.grantsFor('user', 8)).toEqual([]);
    });

    it('maps a grant row whole, including the open ends', async () => {
      const db = fakeDb();
      db.grants = [
        grant('firm', 3, {
          grant_id: '4242',
          source_id: 'cboe.quotes',
          asset_class: 'equity',
          field_class: 'price',
          max_tier: 'realtime',
          usage_display: true,
          usage_export: true,
          usage_api: true,
          valid_from: null,
          valid_to: null,
          contract_ref: 'CBOE-2026-11',
        }),
      ];
      const registry = licenceRegistry({ db: db.db, clock: testClock() });
      await registry.reload();
      expect(registry.grantsFor('firm', 3)).toEqual([
        {
          grantId: 4242,
          subjectKind: 'firm',
          subjectId: 3,
          sourceId: 'cboe.quotes',
          assetClass: 'equity',
          fieldClass: 'price',
          maxTier: 'realtime',
          usageDisplay: true,
          usageExport: true,
          usageApi: true,
          validFrom: '-infinity',
          validTo: null,
          contractRef: 'CBOE-2026-11',
        },
      ]);
    });
  });

  describe('refreshIfStale — rule 10', () => {
    it('costs one SELECT and reloads nothing when the version has not moved', async () => {
      const db = fakeDb();
      db.licences = [licence('cboe.quotes')];
      db.grants = [grant('user', 7)];
      const registry = licenceRegistry({ db: db.db, clock: testClock() });
      await registry.reload();
      db.reset();

      // Whatever the tables now say is irrelevant: an unmoved version means nothing is re-read.
      db.grants = [grant('user', 7), grant('user', 7, { source_id: 'sneaked-in' })];
      await registry.refreshIfStale();
      await registry.refreshIfStale();
      await registry.refreshIfStale();

      expect(db.seen).toEqual(['version', 'version', 'version']);
      expect(db.count('grants')).toBe(0);
      expect(registry.stats().loads).toBe(1);
      expect(registry.stats().freshChecks).toBe(3);
      expect(registry.grantsFor('user', 7)).toHaveLength(1);
    });

    it('reloads all three tables once when the version has moved', async () => {
      const db = fakeDb();
      db.licences = [licence('cboe.quotes')];
      db.fields = [field('PX_LAST', 'equity', 'cboe.quotes')];
      db.grants = [grant('user', 7, { max_tier: 'delayed' })];
      const registry = licenceRegistry({ db: db.db, clock: testClock() });
      await registry.reload();
      db.reset();

      // What a `bump_config_version('entitlements')` trigger does, and the write that caused it.
      db.version = 2;
      db.grants = [grant('user', 7, { max_tier: 'realtime' })];
      db.licences = [licence('cboe.quotes', { max_tier: 'realtime' }), licence('nyfed.rates')];

      await registry.refreshIfStale();

      // One staleness SELECT, then the load — whose first query is the version again.
      expect(db.seen).toEqual(['version', 'version', 'licences', 'fields', 'grants']);
      expect(registry.version()).toBe(2);
      expect(registry.stats().loads).toBe(2);
      expect(registry.stats().freshChecks).toBe(0);
      expect(registry.grantsFor('user', 7)[0]?.maxTier).toBe('realtime');
      expect(registry.licence('cboe.quotes')?.maxTier).toBe('realtime');
      expect(registry.licence('nyfed.rates')).toBeDefined();

      // And the reload settles: the next check is one SELECT again.
      db.reset();
      await registry.refreshIfStale();
      expect(db.seen).toEqual(['version']);
      expect(registry.stats().loads).toBe(2);
    });

    it('does not pin a torn snapshot when a bump lands mid-load', async () => {
      const db = fakeDb();
      db.licences = [licence('cboe.quotes')];
      db.grants = [grant('user', 7, { max_tier: 'delayed' })];
      // The write commits (and bumps) after this load has read the version but before it reads the
      // grants — so this snapshot is a mixture and MUST be reloaded.
      db.after.licences = (): void => {
        db.version = 5;
        db.grants = [grant('user', 7, { max_tier: 'realtime' })];
        db.after.licences = undefined;
      };

      const registry = licenceRegistry({ db: db.db, clock: testClock() });
      await registry.reload();

      // The version recorded is the one read BEFORE the data — behind the bump, never ahead of it.
      expect(registry.version()).toBe(1);
      db.reset();
      await registry.refreshIfStale();
      expect(db.seen).toEqual(['version', 'version', 'licences', 'fields', 'grants']);
      expect(registry.version()).toBe(5);
      expect(registry.stats().loads).toBe(2);
    });

    it('treats a database with no config_versions row as version 0 and still reloads on the first bump', async () => {
      const db = fakeDb();
      db.version = null;
      db.grants = [grant('user', 7)];
      const registry = licenceRegistry({ db: db.db, clock: testClock() });
      await registry.reload();
      expect(registry.version()).toBe(0);

      db.reset();
      await registry.refreshIfStale();
      expect(db.seen).toEqual(['version']);

      db.version = 1;
      db.grants = [grant('user', 7), grant('user', 7, { source_id: 'second' })];
      await registry.refreshIfStale();
      expect(registry.version()).toBe(1);
      expect(registry.grantsFor('user', 7)).toHaveLength(2);
    });
  });

  it('serves two concurrent reloads from one load rather than racing', async () => {
    const db = fakeDb();
    db.licences = [licence('cboe.quotes')];
    const registry = licenceRegistry({ db: db.db, clock: testClock() });
    await Promise.all([registry.reload(), registry.reload(), registry.reload()]);
    expect(db.count('licences')).toBe(1);
    expect(registry.stats().loads).toBe(1);
  });
});
