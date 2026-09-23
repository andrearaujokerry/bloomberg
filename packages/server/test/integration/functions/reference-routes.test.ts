/**
 * `http/routes/{reference,fields,universe}.ts` — the WP-08 route groups of API.md §5.1 (L399-437),
 * §5.5 (L559-566) and §5.2 (L438-488), exercised through the shipped app.
 *
 * Every case here answers one question: **does the route serve what the normative wire schema
 * says it serves?** So each response is parsed with the schema from `@terminal/sdk/wire/rest/*`
 * rather than probed field by field — a server that emits a shape the SDK would reject fails here,
 * which is the only assertion that stays true as the schemas move.
 *
 * What that catches in practice, and why it is worth a file:
 *
 *  - **Bitemporal instants on the wire.** The master repositories hand back Postgres' own
 *    timestamp text and the `'infinity'` sentinel; `z.iso.datetime()` accepts neither. Every
 *    `Bitemporal`-extending row in §5.1 goes through that conversion, and only a schema parse
 *    notices when one of them does not.
 *  - **REF-03 through the HTTP boundary.** The corporate action is recorded with an explicit
 *    `tx_from` of 2020-07-31, and the same URL with `knownAt=2020-07-30` returns zero actions.
 *    The bitemporal audit view (`?table=…`) is asked for every table it accepts, because the
 *    table→key mapping is the one place a typo serves another instrument's history.
 *  - **The `ETag` contract**, on both cached routes: a content hash, `304` with no body on the
 *    way back, and gzip only when the caller offers it.
 *  - **API-03's deprecation rule**: a deprecated field is still in the payload AND named in
 *    `x-deprecated-fields`. A route that dropped it would look like it was working.
 *
 * Self-sufficient (TESTING §4.3): the issuer, issue, instrument, listing, md-line, identifier,
 * classification, person, alias, corporate action, firm, user and session are all written by this
 * file inside its own `withTxDb()` transaction, which is also the app's database handle.
 * `seed/licences.ts` runs inside it so `GET /fields/:id` resolves a real governing licence.
 *
 * Note for anyone extending it: rows written with raw SQL need an explicit `tx_from` in the past.
 * The column defaults to `now()` — wall clock — which lands AFTER the `VirtualClock`'s `knownAt`,
 * and the row is then invisible to every read in the file.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChangelogResponse, FieldDetail, FieldDictionary } from '@terminal/sdk/wire/rest/fields';
import {
  CorporateActionsResponse,
  IdentifiersResponse,
  InstrumentDetail,
  IssuerResponse,
  ResolveResponse,
  TermsResponse,
  VersionsResponse,
  ClassificationsResponse,
} from '@terminal/sdk/wire/rest/reference';
import { UniverseSnapshot } from '@terminal/sdk/wire/rest/search';

import { getConfig } from '../../../src/config.js';
import { IdentifierRepository } from '../../../src/refdata/identifiers.js';
import {
  InstrumentRepository,
  IssueRepository,
  IssuerRepository,
  ListingRepository,
  MdLineRepository,
} from '../../../src/refdata/master.js';
import { recordAction } from '../../../src/refdata/corporateActions.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { ensureShared, withTxDb, type TestDb } from '../../../src/test/db.js';

/**
 * This fixture's security, named uniquely per run.
 *
 * It used to be Apple, spelled exactly as three other integration files spell it — same
 * `TICKER_EXCH ('AAPL','US')`, same ISIN, same composite FIGI. `identifiers_bt_excl` is
 * `EXCLUDE (scheme, value, qualifier, validity &&)`, so two `withTxDb` transactions in two forks
 * each holding one of those keys and waiting for the other is a deadlock, and which files a run
 * schedules together then decides whether it is green. (`vitest.config.ts` records the same
 * hazard for the replay project — "`secNport` and `symbologyRefresh` both write Apple's ISIN" —
 * and solves it by serialising that project.) A file that mints its own identifier space is
 * self-sufficient in the sense TESTING §4.3 means, and needs no serialising.
 */
const RUN = randomUUID().slice(0, 4).toUpperCase();
const TICKER = `RF${RUN}`;
const DISPLAY = `${TICKER} US Equity`;
const CIK = `00003${RUN.split('').map((c) => String(c.charCodeAt(0) % 10)).join('')}1`;
const ISIN = `US${RUN}000000`; // char(12)
const FIGI = `BBG0${RUN}B9XRY4`.slice(0, 12);
const ALIAS = `Apple ${RUN}`;

const VALID_FROM = new Date('2015-01-01T00:00:00Z');
const KNOWN_BASE = new Date('2015-01-02T00:00:00Z');

describe('WP-08 reference / fields / universe routes', () => {
  const t: TestDb = withTxDb();
  const clock = testClock('2026-09-15T18:41:30.002Z');

  let harness: TestApp;
  let app: FastifyInstance;
  let headers: Record<string, string>;
  /** A session in the same firm holding no entitlement grant at all. */
  let ungrantedHeaders: Record<string, string>;
  let instrumentId: number;
  let issuerId: number;

  beforeEach(async () => {
    await ensureLicences();

    const prov = await t.client.query<{ provenance_id: string }>(
      `INSERT INTO provenance (source_id, request_key, request_url, request_hash,
                               response_sha256, http_status, bytes, captured_at, adapter_version)
       VALUES ('internal.user', $1, 'test://wp08', digest($1,'sha256'), digest($1,'sha256'),
               200, 0, timestamptz '2026-09-15T18:41:28Z', 'test/1.0.0')
       RETURNING provenance_id`,
      [`wp08-check-${randomUUID()}`],
    );
    const provenanceId = Number(prov.rows[0]!.provenance_id);
    const opts = {
      validFrom: VALID_FROM,
      provenanceId,
      knownAt: KNOWN_BASE,
      reason: 'initial' as const,
    };

    issuerId = await new IssuerRepository(t.db).insert(
      { name: 'Apple Inc', cik: CIK, country: 'US', entityType: 'operating' },
      opts,
    );
    const issueId = await new IssueRepository(t.db).insert(
      {
        issuerId,
        assetClass: 'equity',
        securityType: 'Common Stock',
        isin: ISIN,
        name: 'Apple Inc',
        currency: 'USD',
      },
      opts,
    );
    instrumentId = await new InstrumentRepository(t.db).insert(
      {
        issueId,
        assetClass: 'equity',
        marketSector: 'Equity',
        compositeFigi: FIGI,
        ticker: TICKER,
        exchCode: 'US',
        name: 'Apple Inc',
        currency: 'USD',
        searchWeight: 2,
      },
      opts,
    );
    await new ListingRepository(t.db).insert(
      { instrumentId, mic: 'XNAS', exchCode: 'UW', localTicker: TICKER, isPrimary: true },
      opts,
    );
    await new MdLineRepository(t.db).insert(
      {
        instrumentId,
        sourceId: 'yahoo.chart',
        providerSymbol: TICKER,
        lineKind: 'composite',
        intrinsicDelayMin: 15,
        expectedIntervalMs: 10_000,
        priority: 10,
      },
      opts,
    );
    await new IdentifierRepository(t.db).upsert(
      {
        entityKind: 'instrument',
        entityId: instrumentId,
        scheme: 'TICKER_EXCH',
        value: TICKER,
        qualifier: 'US',
        isPrimary: true,
      },
      opts,
    );
    // Shared across four forks: a read first means the common case takes no write lock at all,
    // which is what stops two transactions holding speculative-insert locks on the same primary
    // key and deadlocking (40P01). `test/globalSetup.ts` commits the row once.
    await ensureShared(
      t,
      `SELECT 1 FROM classification_schemes WHERE scheme = 'GICS'`,
      `INSERT INTO classification_schemes (scheme, name, source_id, levels)
       VALUES ('GICS', 'GICS', 'wiki.sp500', 4) ON CONFLICT DO NOTHING`,
    );
    await t.client.query(
      `INSERT INTO classification_codes (scheme, code, name, parent_code, level)
       VALUES ('GICS', '45', 'Information Technology', NULL, 1),
              ('GICS', '4520', 'Technology Hardware', '45', 2)
       ON CONFLICT DO NOTHING`,
    );
    await t.client.query(
      `INSERT INTO entity_classifications (entity_kind, entity_id, scheme, code, valid_from, tx_from, provenance_id)
       VALUES ('instrument', $1, 'GICS', '4520', timestamptz '2015-01-01', timestamptz '2015-01-02', $2)`,
      [instrumentId, provenanceId],
    );
    await t.client.query(
      `INSERT INTO issuer_aliases (issuer_id, alias, kind) VALUES ($1, $2, 'short_name')`,
      [issuerId, ALIAS],
    );
    await t.client.query(
      `INSERT INTO people (name, role, issuer_id, source_id, valid_from, tx_from, provenance_id)
       VALUES ('Tim Cook', 'CEO', $1, 'internal.user', timestamptz '2015-01-01', timestamptz '2015-01-02', $2)`,
      [issuerId, provenanceId],
    );
    await recordAction(t.db, {
      instrumentId,
      caType: 'split',
      status: 'confirmed',
      exDate: '2020-08-31',
      ratioNew: 4,
      ratioOld: 1,
      sourceId: 'internal.user',
      provenanceId,
      txFrom: new Date('2020-07-31T00:00:00Z'),
    });

    const firm = await t.client.query<{ firm_id: string }>(
      `INSERT INTO firms (name, seat_count) VALUES ($1, 5) RETURNING firm_id`,
      [`WP08 Check ${randomUUID().slice(0, 8)}`],
    );
    const firmId = Number(firm.rows[0]!.firm_id);
    const user = await t.client.query<{ user_id: string }>(
      `INSERT INTO users (firm_id, email, display_name, role)
       VALUES ($1, $2, 'Check', 'user') RETURNING user_id`,
      [firmId, `wp08-check-${randomUUID()}@demo.invalid`],
    );
    const token = `sess-${randomUUID()}`;
    await t.client.query(
      `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
       VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
      [Number(user.rows[0]!.user_id), createHash('sha256').update(token, 'utf8').digest()],
    );
    headers = {
      cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    };

    // The master surface is entitlement-gated, exactly as `POST /data` is: `NAME`, `ID_TICKER`
    // and the identifier fields are licensed data, and a session with no grant is refused here
    // for the same reason it is refused there. So this user is granted what the routes ask for —
    // and `ungrantedHeaders` below is a second session that is granted nothing, which is what
    // proves the gate is a gate.
    await grantEverything(firmId, Number(user.rows[0]!.user_id));

    const stranger = await t.client.query<{ user_id: string }>(
      `INSERT INTO users (firm_id, email, display_name, role)
       VALUES ($1, $2, 'Ungranted', 'user') RETURNING user_id`,
      [firmId, `wp08-ungranted-${randomUUID()}@demo.invalid`],
    );
    const strangerToken = `sess-${randomUUID()}`;
    await t.client.query(
      `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
       VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
      [
        Number(stranger.rows[0]!.user_id),
        createHash('sha256').update(strangerToken, 'utf8').digest(),
      ],
    );
    ungrantedHeaders = {
      cookie: `tsid=${encodeURIComponent(cookie.sign(strangerToken, getConfig().SESSION_SECRET))}`,
    };

    harness = await createTestApp({ db: t.db, clock });
    app = harness.app;
  });

  /**
   * The shipped licence terms, seeded only when they are missing.
   *
   * `seedLicences` is idempotent but not *silent*: on a database `test/globalSetup.ts` already
   * seeded, it still issues its inserts and updates against `licence_registry`, `field_licence`
   * and `config_versions` — rows every other integration file is also writing from its own open
   * transaction, in its own fork. Two transactions holding one of those keys and waiting for the
   * other is a deadlock, and which files a run happens to schedule together then decides whether
   * it is green. A read first means the common case takes no locks at all, while a database with
   * no seed still gets one.
   */
  async function ensureLicences(): Promise<void> {
    const present = await t.client.query(
      `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
    );
    if (present.rowCount === 0) await seedLicences(t.client);
  }

  /**
   * Grant the firm and the user everything, with the unscoped grant the evaluator reads as a
   * wildcard (`source_id`, `asset_class` and `field_class` all NULL — rules 4-5 need one row for
   * the firm and one for the user).
   *
   * Two rows rather than two per licensing source: which source owns `ID_ISIN` is not what this
   * file is about, and each extra `entitlement_grants` insert is another key held for the length
   * of the test transaction while three other forks write the same table.
   */
  async function grantEverything(firmId: number, userId: number): Promise<void> {
    for (const [kind, id] of [
      ['firm', firmId],
      ['user', userId],
    ] as const) {
      await t.client.query(
        `INSERT INTO entitlement_grants
           (subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
            usage_display, usage_export, usage_api, valid_from, valid_to)
         VALUES ($1, $2, NULL, NULL, NULL, 'realtime'::tier, true, true, true,
                 timestamptz '2000-01-01', 'infinity'::timestamptz)`,
        [kind, id],
      );
    }
  }

  afterEach(async () => {
    await harness.close();
  });

  const get = (url: string): ReturnType<FastifyInstance['inject']> =>
    app.inject({ method: 'GET', url, headers });

  it('GET /ref/resolve', async () => {
    const res = await get(`/api/v1/ref/resolve?ref=${encodeURIComponent(DISPLAY)}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = ResolveResponse.parse(res.json());
    expect(body.results[0]!.instrument?.instrumentId).toBe(instrumentId);
    expect(body.results[0]!.instrument?.display).toBe(DISPLAY);
  });

  it('POST /ref/resolve', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ref/resolve',
      headers: { ...headers, 'x-requested-with': 'terminal' },
      payload: {
        refs: [{ ref: DISPLAY }, { id: instrumentId }, { ref: 'NOPE XX Equity' }],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = ResolveResponse.parse(res.json());
    expect(body.results).toHaveLength(3);
    expect(body.results[2]!.error?.code).toBe('SECURITY_NOT_FOUND');
  });

  it('GET /ref/:instrumentId', async () => {
    const res = await get(`/api/v1/ref/${instrumentId}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = InstrumentDetail.parse(res.json());
    expect(body.instrument.ticker).toBe(TICKER);
    expect(body.issuer.name).toBe('Apple Inc');
    expect(body.listings).toHaveLength(1);
    expect(body.mdLines).toHaveLength(1);
    expect(body.classifications.map((c) => c.code)).toContain('4520');
    expect(body.classifications.find((c) => c.code === '4520')?.parentCode).toBe('45');
    expect(body.meta.provenance.length).toBeGreaterThan(0);
    expect(body.terms).toBeNull();
  });

  it('GET /ref/* is 403 ENTITLEMENT_DENIED for a session with no grant — like POST /data', async () => {
    // The defect this covers: `POST /data {fields:['NAME']}` answered 403 for this session while
    // `GET /ref/:id` answered 200 with the very same `NAME`, and `/identifiers` handed over ISIN,
    // CUSIP and SEDOL. Whether a user may see a field must not depend on which URL asks.
    const ungranted = (url: string): ReturnType<FastifyInstance['inject']> =>
      app.inject({ method: 'GET', url, headers: ungrantedHeaders });

    for (const url of [
      `/api/v1/ref/${instrumentId}`,
      `/api/v1/ref/${instrumentId}/identifiers`,
      `/api/v1/ref/${instrumentId}/terms`,
      // The audit view re-serves the same rows one version at a time; gating the reads and
      // leaving this open would make the gate a detour rather than a rule.
      `/api/v1/ref/${instrumentId}/versions?table=identifiers`,
    ]) {
      const res = await ungranted(url);
      expect(res.statusCode, `${url}: ${res.body}`).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('ENTITLEMENT_DENIED');
    }

    // …and `POST /data` agrees, which is the whole point.
    const data = await app.inject({
      method: 'POST',
      url: '/api/v1/data',
      headers: { ...ungrantedHeaders, 'x-requested-with': 'terminal' },
      payload: { kind: 'reference', securities: [{ ref: DISPLAY }], fields: ['NAME'] },
    });
    expect(data.statusCode).toBe(403);
    expect(data.json<{ error: { code: string } }>().error.code).toBe('ENTITLEMENT_DENIED');
  });

  it('GET /ref/:instrumentId 404 for an unknown id', async () => {
    const res = await get('/api/v1/ref/2147483600');
    expect(res.statusCode).toBe(404);
  });

  it('GET /ref/:instrumentId/identifiers', async () => {
    const res = await get(`/api/v1/ref/${instrumentId}/identifiers`);
    expect(res.statusCode, res.body).toBe(200);
    const body = IdentifiersResponse.parse(res.json());
    expect(body.identifiers.map((i) => i.scheme)).toContain('TICKER_EXCH');
  });

  it('GET /ref/:instrumentId/versions', async () => {
    for (const table of [
      'instruments',
      'issues',
      'issuers',
      'listings',
      'md_lines',
      'identifiers',
      'corporate_actions',
    ]) {
      const res = await get(`/api/v1/ref/${instrumentId}/versions?table=${table}`);
      expect(res.statusCode, `${table}: ${res.body}`).toBe(200);
      const body = VersionsResponse.parse(res.json());
      expect(body.versions.length, table).toBeGreaterThan(0);
      expect(body.versions[0]!.provenance.sourceId.length).toBeGreaterThan(0);
    }
  });

  it('GET /ref/:instrumentId/corporate-actions', async () => {
    const res = await get(`/api/v1/ref/${instrumentId}/corporate-actions`);
    expect(res.statusCode, res.body).toBe(200);
    const body = CorporateActionsResponse.parse(res.json());
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]!.caType).toBe('split');
    expect(body.actions[0]!.ratioNew).toBe(4);
  });

  it('GET /ref/:instrumentId/corporate-actions at an older knownAt', async () => {
    const res = await get(
      `/api/v1/ref/${instrumentId}/corporate-actions?knownAt=2020-07-30T00%3A00%3A00.000Z`,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(CorporateActionsResponse.parse(res.json()).actions).toHaveLength(0);
  });

  it('GET /ref/:instrumentId/terms', async () => {
    const res = await get(`/api/v1/ref/${instrumentId}/terms`);
    expect(res.statusCode, res.body).toBe(200);
    expect(TermsResponse.parse(res.json()).terms).toBeNull();
  });

  it('GET /issuers/:issuerId', async () => {
    const res = await get(`/api/v1/issuers/${issuerId}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = IssuerResponse.parse(res.json());
    expect(body.issuer.name).toBe('Apple Inc');
    expect(body.instruments.map((i) => i.instrumentId)).toContain(instrumentId);
    expect(body.people.map((p) => p.name)).toContain('Tim Cook');
    expect(body.aliases).toContain(ALIAS);
  });

  it('GET /classifications/:scheme', async () => {
    const res = await get('/api/v1/classifications/gics');
    expect(res.statusCode, res.body).toBe(200);
    const body = ClassificationsResponse.parse(res.json());
    expect(body.nodes.map((n) => n.code)).toContain('4520');
  });

  it('GET /universe/snapshot with ETag and 304', async () => {
    const first = await get('/api/v1/universe/snapshot');
    expect(first.statusCode, first.body).toBe(200);
    const snap = UniverseSnapshot.parse(JSON.parse(first.body));
    expect(snap.instruments.some((row) => row[0] === instrumentId)).toBe(true);
    const etag = first.headers.etag!;
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(first.headers['cache-control']).toBe('private, max-age=3600');

    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/universe/snapshot',
      headers: { ...headers, 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('GET /universe/snapshot gzips when asked', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/universe/snapshot',
      headers: { ...headers, 'accept-encoding': 'gzip' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('GET /universe/snapshot needs a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/universe/snapshot' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /fields with ETag, 304, filters and x-deprecated-fields', async () => {
    const res = await get('/api/v1/fields');
    expect(res.statusCode, res.body).toBe(200);
    const body = FieldDictionary.parse(JSON.parse(res.body));
    expect(body.version).toBe('2026.09.1');
    expect(body.fields.length).toBeGreaterThan(250);
    const deprecated = res.headers['x-deprecated-fields'] as string;
    expect(deprecated.split(',').length).toBeGreaterThan(0);

    const etag = res.headers.etag!;
    const again = await app.inject({
      method: 'GET',
      url: '/api/v1/fields',
      headers: { ...headers, 'if-none-match': etag },
    });
    expect(again.statusCode).toBe(304);

    const filtered = await get('/api/v1/fields?fieldClass=price&assetClass=equity&q=last');
    expect(filtered.statusCode, filtered.body).toBe(200);
    const narrow = FieldDictionary.parse(JSON.parse(filtered.body));
    expect(narrow.fields.length).toBeGreaterThan(0);
    expect(narrow.fields.length).toBeLessThan(body.fields.length);
    for (const f of narrow.fields) {
      expect(f.fieldClass).toBe('price');
      expect(f.assetClasses).toContain('equity');
      expect(`${f.id} ${f.label}`.toLowerCase()).toContain('last');
    }

    // A deprecated field is STILL served (API.md §7 rule 3).
    const anyDeprecated = deprecated.split(',')[0]!;
    expect(body.fields.some((f) => f.id === anyDeprecated)).toBe(true);
  });

  it('GET /fields?version= refuses a version this build does not have', async () => {
    const res = await get('/api/v1/fields?version=2025.01.1');
    expect(res.statusCode).toBe(404);
  });

  it('GET /fields/changelog', async () => {
    const res = await get('/api/v1/fields/changelog');
    expect(res.statusCode, res.body).toBe(200);
    const body = ChangelogResponse.parse(JSON.parse(res.body));
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]!.version).toBe('2026.09.1');
    expect(body.versions[0]!.date).toBe('2026-09-17');
    expect(body.versions[0]!.added.length).toBeGreaterThan(250);
    expect(body.versions[0]!.deprecated.length).toBeGreaterThan(0);

    const since = await get('/api/v1/fields/changelog?since=2026.09.1');
    expect(ChangelogResponse.parse(JSON.parse(since.body)).versions).toHaveLength(0);
  });

  it('GET /fields/:id with the governing licence', async () => {
    const res = await get('/api/v1/fields/PX_LAST');
    expect(res.statusCode, res.body).toBe(200);
    const body = FieldDetail.parse(JSON.parse(res.body));
    expect(body.id).toBe('PX_LAST');
    expect(body.licence.sourceId.length).toBeGreaterThan(0);
    expect(body.licence.attribution.length).toBeGreaterThan(0);
  });

  it('GET /fields/:id 404 FIELD_UNKNOWN', async () => {
    const res = await get('/api/v1/fields/PX_LST');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('FIELD_UNKNOWN');
  });
});
