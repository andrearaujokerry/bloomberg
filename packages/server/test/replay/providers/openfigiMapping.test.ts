/**
 * QA-02 — `openfigi.mapping` over its two recorded captures. WORKPLAN WP-05, PROVIDERS.a §6.1, §6.2.
 *
 * The bytes come from `fixtures/providers/manifest.json` through the replay store, never from a
 * socket, and the request key is derived from the **adapter's own** URL and body: if
 * `openFigiMappingBody` ever changes shape, this test misses its capture rather than silently
 * parsing a stale one.
 *
 * No database: `parse.ts` is pure by contract (§1.2), so nothing here opens a transaction.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  OPENFIGI_ADAPTER_VERSION,
  OPENFIGI_MAPPING_URL,
  OPENFIGI_SEARCH_URL,
  chunkOpenFigiJobs,
  openFigiAdapter,
  openFigiSearchBody,
} from '../../../src/providers/openfigi/adapter.js';
import {
  normaliseOpenFigiMapping,
  normaliseOpenFigiSearch,
  openFigiMappingBody,
  parseOpenFigiJobs,
  parseOpenFigiMapping,
  parseOpenFigiSearch,
  sortOpenFigiJobs,
} from '../../../src/providers/openfigi/parse.js';
import type { OpenFigiJob } from '../../../src/providers/openfigi/parse.js';
import { createProviderRegistry } from '../../../src/providers/registry.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import type { NormaliseContext, RawRecord } from '../../../src/providers/types.js';

const store = openReplayStore();

function goldenText(name: string): string {
  return readFileSync(join(store.dir, 'normalised', name), 'utf8');
}

function serialise(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ctxOf(raw: RawRecord): NormaliseContext {
  return { provenanceId: 0, capturedAt: raw.capturedAt, lines: new Map() };
}

/** The jobs the capture was recorded for, recovered from the manifest's own request body. */
const MAPPING_JOBS: OpenFigiJob[] = [
  { idType: 'TICKER', idValue: 'AAPL', exchCode: 'US' },
  { idType: 'TICKER', idValue: 'AAPL' },
];

const mappingBody = openFigiMappingBody(MAPPING_JOBS);
const searchBody = openFigiSearchBody({ kind: 'search', query: 'apple', exchCode: 'US' });

describe('openfigi.mapping — POST /v3/mapping (§6.1)', () => {
  const key = requestKey('openfigi.mapping', 'POST', OPENFIGI_MAPPING_URL, mappingBody);
  const raw = store.replay({
    providerId: 'openfigi.mapping',
    method: 'POST',
    url: OPENFIGI_MAPPING_URL,
    body: mappingBody,
  });

  it('the adapter body derives the recorded request key', () => {
    expect(store.has(key)).toBe(true);
    expect(store.entry(key)?.body).toBe(mappingBody);
    expect(raw.requestKey).toBe(key);
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.body.length).toBe(70_534);
  });

  it('parse.ts equals the committed golden, byte for byte', () => {
    const jobs = parseOpenFigiJobs(store.entry(key)?.body ?? '');
    expect(jobs).toEqual(MAPPING_JOBS);
    const out = normaliseOpenFigiMapping(raw, ctxOf(raw), jobs);
    expect(serialise(out)).toBe(goldenText('openfigi-map.json'));
  });

  it('measures what the capture actually contains', () => {
    const out = normaliseOpenFigiMapping(raw, ctxOf(raw), MAPPING_JOBS);
    // Two jobs, two positional answers, 1 + 275 records.
    expect(out.rows.answers.map((a) => [a.index, a.outcome, a.recordCount])).toEqual([
      [0, 'data', 1],
      [1, 'data', 275],
    ]);
    expect(out.rows.answers[0]?.job).toEqual(MAPPING_JOBS[0]);
    expect(out.rows.answers[1]?.job).toEqual(MAPPING_JOBS[1]);

    // 98 distinct composites across 90-odd venues; 255 venue-level listings; no conflicts.
    expect(out.rows.composites).toHaveLength(98);
    expect(out.rows.listings).toHaveLength(255);
    expect(out.rows.identifiers).toHaveLength(629);
    expect(out.rows.exceptions).toHaveLength(0);
    expect(out.problems).toHaveLength(0);

    // Field coverage: every composite carries a ticker, a name and a security type; exactly 20
    // of the 98 are named by a record that IS the composite, so the other 78 have no composite
    // exchange code and must not borrow their venue's.
    expect(out.rows.composites.every((c) => c.ticker !== '' && c.name !== '')).toBe(true);
    expect(out.rows.composites.filter((c) => c.compositeExchCode !== null)).toHaveLength(20);
    expect(out.rows.composites.every((c) => c.securityType === 'Common Stock')).toBe(true);
    expect(out.rows.composites.every((c) => c.assetClass === 'equity')).toBe(true);
    expect(out.rows.composites.every((c) => c.marketSector === 'Equity')).toBe(true);
    // One share class (Apple's) across all 98 composites; 78 composites are named only by venue
    // records that publish none, so `shareClassFigi` is null on them.
    expect(new Set(out.rows.composites.map((c) => c.shareClassFigi))).toEqual(
      new Set(['BBG001S5N8V8', null]),
    );

    const apple = out.rows.composites.find((c) => c.compositeFigi === 'BBG000B9XRY4');
    expect(apple).toEqual({
      compositeFigi: 'BBG000B9XRY4',
      ticker: 'AAPL',
      compositeExchCode: 'US',
      name: 'APPLE INC',
      securityType: 'Common Stock',
      securityType2: 'Common Stock',
      marketSector: 'Equity',
      shareClassFigi: 'BBG001S5N8V8',
      assetClass: 'equity',
    });

    // Identifier schemes, by count — the four the §6.1 table names and nothing else.
    const schemes = new Map<string, number>();
    for (const row of out.rows.identifiers) {
      schemes.set(row.scheme, (schemes.get(row.scheme) ?? 0) + 1);
    }
    expect(Object.fromEntries(schemes)).toEqual({
      COMPOSITE_FIGI: 98,
      SHARE_CLASS_FIGI: 1,
      TICKER_EXCH: 275,
      FIGI: 255,
    });
  });

  it('refuses the whole payload when the response is not positionally parallel', () => {
    const parsed = parseOpenFigiMapping(raw.body, [
      ...MAPPING_JOBS,
      { idType: 'TICKER', idValue: 'MSFT' },
    ]);
    expect(parsed.elements).toHaveLength(0);
    expect(parsed.problems[0]?.kind).toBe('schema_drift');
    expect(parsed.problems[0]?.detail).toContain('positional');
  });

  it('reports an error element as unknown_symbol with a data_exceptions candidate', () => {
    const body = JSON.stringify([{ error: 'No identifier found.' }]);
    const synthetic: RawRecord = { ...raw, body: Buffer.from(body, 'utf8') };
    const out = normaliseOpenFigiMapping(synthetic, ctxOf(raw), [
      { idType: 'ID_CUSIP', idValue: '000000000' },
    ]);
    expect(out.rows.composites).toHaveLength(0);
    expect(out.rows.exceptions).toEqual([
      {
        kind: 'unresolved_identifier',
        entityKind: 'instrument',
        field: 'ID_CUSIP',
        candidates: [{ sourceId: 'openfigi.mapping', value: '000000000' }],
      },
    ]);
    expect(out.problems[0]?.kind).toBe('unknown_symbol');
  });

  it('raises source_conflict when one ticker+exchCode maps to two composites', () => {
    const record = (figi: string, composite: string): unknown => ({
      figi,
      name: 'TEST INC',
      ticker: 'TST',
      exchCode: 'US',
      compositeFIGI: composite,
      securityType: 'Common Stock',
      marketSector: 'Equity',
    });
    const body = JSON.stringify([
      { data: [record('BBG000000001', 'BBG000000001'), record('BBG000000002', 'BBG000000002')] },
    ]);
    const out = normaliseOpenFigiMapping({ ...raw, body: Buffer.from(body, 'utf8') }, ctxOf(raw), [
      { idType: 'TICKER', idValue: 'TST', exchCode: 'US' },
    ]);
    expect(out.rows.exceptions).toEqual([
      {
        kind: 'source_conflict',
        entityKind: 'instrument',
        field: 'compositeFIGI',
        candidates: [
          { sourceId: 'openfigi.mapping', value: 'BBG000000001' },
          { sourceId: 'openfigi.mapping', value: 'BBG000000002' },
        ],
      },
    ]);
  });
});

describe('openfigi.mapping — POST /v3/search (§6.2)', () => {
  const key = requestKey('openfigi.mapping', 'POST', OPENFIGI_SEARCH_URL, searchBody);
  const raw = store.replay({
    providerId: 'openfigi.mapping',
    method: 'POST',
    url: OPENFIGI_SEARCH_URL,
    body: searchBody,
  });

  it('the adapter body derives the recorded request key', () => {
    expect(searchBody).toBe('{"query":"apple","exchCode":"US"}');
    expect(store.has(key)).toBe(true);
    expect(raw.origin).toBe('replay');
    expect(raw.body.length).toBe(28_665);
  });

  it('parse.ts equals the committed golden, byte for byte', () => {
    expect(serialise(normaliseOpenFigiSearch(raw, ctxOf(raw)))).toBe(
      goldenText('openfigi-search.json'),
    );
  });

  it('measures what the capture actually contains', () => {
    const out = normaliseOpenFigiSearch(raw, ctxOf(raw));
    expect(out.rows.candidates).toHaveLength(100);
    expect(out.rows.next).toMatch(/^QW9JSVFGL1poQ3hDUWtj/);
    expect(out.problems).toHaveLength(0);

    // Search is a relevance list, not an identity assertion: nothing is written from it (§6.2).
    expect(out.updates).toHaveLength(0);

    // Field coverage: every candidate carries the seven keyed fields; `shareClassFIGI` is
    // published on only six of the hundred (options and ETPs carry none).
    expect(out.rows.candidates.every((c) => c.figi !== '' && c.ticker !== '')).toBe(true);
    expect(out.rows.candidates.filter((c) => c.shareClassFIGI !== undefined)).toHaveLength(6);
    expect(out.rows.candidates.every((c) => c.figi === c.compositeFIGI)).toBe(true);
    expect(new Set(out.rows.candidates.map((c) => c.securityType))).toEqual(
      new Set(['Common Stock', 'ETP', 'Equity Option', 'REIT']),
    );
    expect(out.rows.candidates[0]).toEqual({
      figi: 'BBG000B9XRY4',
      name: 'APPLE INC',
      ticker: 'AAPL',
      exchCode: 'US',
      compositeFIGI: 'BBG000B9XRY4',
      securityType: 'Common Stock',
      marketSector: 'Equity',
      shareClassFIGI: 'BBG001S5N8V8',
      securityType2: 'Common Stock',
      securityDescription: 'AAPL',
    });
  });
});

describe('openfigi adapter plumbing', () => {
  it('registers under its licensed source id', () => {
    const registry = createProviderRegistry([openFigiAdapter]);
    expect(registry.ids()).toEqual(['openfigi.mapping']);
    expect(registry.require('openfigi.mapping').adapterVersion).toBe(OPENFIGI_ADAPTER_VERSION);
    expect(openFigiAdapter.sourceId).toBe('openfigi.mapping');
  });

  it('sorts an absent exchCode last, so the chunk body is stable', () => {
    const jobs: OpenFigiJob[] = [
      { idType: 'TICKER', idValue: 'MSFT' },
      { idType: 'TICKER', idValue: 'AAPL', exchCode: 'US' },
      { idType: 'TICKER', idValue: 'AAPL' },
      { idType: 'ID_CUSIP', idValue: '037833100' },
    ];
    expect(sortOpenFigiJobs(jobs)).toEqual([
      { idType: 'ID_CUSIP', idValue: '037833100' },
      { idType: 'TICKER', idValue: 'AAPL', exchCode: 'US' },
      { idType: 'TICKER', idValue: 'AAPL' },
      { idType: 'TICKER', idValue: 'MSFT' },
    ]);
    // Sorting twice is the same list, so the request key is stable across runs.
    expect(sortOpenFigiJobs(sortOpenFigiJobs(jobs))).toEqual(sortOpenFigiJobs(jobs));
  });

  it('chunks at the keyless ceiling of ten jobs a request', () => {
    const jobs: OpenFigiJob[] = Array.from({ length: 25 }, (_, i) => ({
      idType: 'TICKER',
      idValue: `T${String(i).padStart(3, '0')}`,
      exchCode: 'US',
    }));
    const chunks = chunkOpenFigiJobs(jobs);
    expect(chunks.map((c) => c.length)).toEqual([10, 10, 5]);
    expect(chunks.flat()).toHaveLength(25);
  });

  it('never throws on truncated or corrupted input (QA-05 smoke)', () => {
    const text = store
      .replay({
        providerId: 'openfigi.mapping',
        method: 'POST',
        url: OPENFIGI_MAPPING_URL,
        body: mappingBody,
      })
      .body.toString('utf8');
    for (const candidate of [
      '',
      '[',
      '[{}]',
      '[null]',
      '{"data":null}',
      text.slice(0, 5_000),
      text.slice(1_000),
    ]) {
      expect(() => parseOpenFigiMapping(candidate, null)).not.toThrow();
      expect(() => parseOpenFigiSearch(candidate)).not.toThrow();
      expect(() => parseOpenFigiJobs(candidate)).not.toThrow();
    }
  });
});
