/**
 * WORKPLAN WP-08 — `functions/context.ts`, the `ResolveContext` every WP-09/10/11 resolver is
 * written against (FUNCTIONS.md §1.4.1, §1.4.2).
 *
 * A unit test in the strict sense: no database, no network, no clock but the virtual one. The
 * plant, the HTTP client, the provider adapter, the licence registry, the evaluator and the
 * provenance store are all stubs this file writes, which is what makes the four questions below
 * answerable at all.
 *
 * What is proved here:
 *
 *  1. **The collectors.** `prov.add` is idempotent per `provenanceId` — the same row cited twice is
 *     one `meta.provenance` entry and one index — and `worstState()` / `lowestTier()` are checked
 *     over *every* ordered pair of the five `ValueState`s and the three `Tier`s, not over a
 *     convenient example. `meta.staleness` and `meta.tier` are stamped from those two functions, so
 *     one wrong cell in that arithmetic is a screen that says `live` about a stale number.
 *  2. **The plant gate.** A denied field comes back blank with its reason while the underlying
 *     composite holds a real number for it — the gate, not the absence of data, is what makes it
 *     blank. And a denial that arrives mid-resolve through `ctx.entitle` closes the gate for the
 *     reads that follow it.
 *  3. **The read-through's three circuit outcomes**, on a `VirtualClock` with a fake adapter:
 *     fresh store ⇒ the provider is never touched; circuit open with stale data ⇒ the stale row,
 *     labelled `fresh: false`; circuit open with nothing stored ⇒ `ProviderUnavailableError`.
 *  4. **The closed surface.** A resolver holds a `ResolveContext` and nothing else, so this module
 *     must not hand it a way to open a connection or a transaction. The exported surface is
 *     asserted, and so is the context's own key set.
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  EntitlementDecision,
  EntitlementRequest,
  FieldId,
  Instrument,
  ProvRef,
  QuoteState,
  ReasonCode,
  Tier,
  ValueState,
} from '@terminal/core';

import {
  buildContext,
  engineCollector,
  plantReader,
  provenanceCollector,
  readThrough,
  ReadThroughRoutes,
  unavailableCollector,
  type DataServices,
  type PlantGate,
  type ReadThroughStore,
  type ResolveContext,
} from '../../../src/functions/context.js';
import * as contextModule from '../../../src/functions/context.js';
import { ProviderUnavailableError } from '../../../src/http/errors.js';
import { HotSet } from '../../../src/ingest/hotset.js';
import type { EodView } from '../../../src/plant/eod.js';
import type { Plant } from '../../../src/plant/tickerPlant.js';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import { requestKey as requestKeyOf } from '../../../src/providers/replayStore.js';
import type {
  BreakerState,
  HttpClient,
  Normalised,
  ProviderAdapter,
  RawRecord,
} from '../../../src/providers/types.js';
import type { Tx } from '../../../src/db/client.js';
import type { Evaluator } from '../../../src/entitlements/evaluator.js';
import type { LicenceEntry, LicenceRegistry } from '../../../src/entitlements/licenceRegistry.js';
import { testClock, TEST_NOW } from '../../../src/test/clock.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Nothing in this file reaches Postgres; a context that tried would fail loudly, not silently. */
const NO_DB = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`the unit context touched the database (db.${String(prop)})`);
    },
  },
) as unknown as Tx;

const SOURCE = 'yahoo.chart';

function quoteState(over: Partial<QuoteState> = {}): QuoteState {
  const prov: ProvRef = { sourceId: SOURCE, provenanceId: 7 };
  return {
    subject: 'q:42',
    instrumentId: 42,
    assetClass: 'equity',
    seq: 3,
    tier: 'delayed',
    delayMin: 15,
    fields: { PX_LAST: 188.5, PX_BID: 188.4, PX_VOLUME: 1_000_000 },
    fieldTs: { PX_LAST: TEST_NOW - 1_000, PX_BID: TEST_NOW - 2_000, PX_VOLUME: TEST_NOW - 3_000 },
    ts: { src: TEST_NOW - 1_000, cap: TEST_NOW - 500, pub: TEST_NOW - 400 },
    session: 'open',
    state: 'live',
    ageMs: 500,
    expectedIntervalMs: 15_000,
    prov,
    lines: {},
    dq: [],
    ...over,
  };
}

/** Only the three methods `plantReader` calls; anything else is a bug this stub reports. */
function fakePlant(states: readonly QuoteState[], eod: ReadonlyMap<string, EodView> = new Map()): Plant {
  const bySubject = new Map(states.map((s) => [s.subject, s]));
  const copy = (s: QuoteState): QuoteState => structuredClone(s);
  const plant = {
    snapshot: (subject: string): QuoteState | undefined => {
      const held = bySubject.get(subject);
      return held === undefined ? undefined : copy(held);
    },
    snapshotMany: (subjects: readonly string[]): Map<string, QuoteState> => {
      const out = new Map<string, QuoteState>();
      for (const subject of subjects) {
        const held = bySubject.get(subject);
        if (held !== undefined) out.set(subject, copy(held));
      }
      return out;
    },
    eodView: (subject: string): EodView | null => eod.get(subject) ?? null,
  };
  return plant as unknown as Plant;
}

function licenceRegistryStub(attribution: Record<string, string | null>): LicenceRegistry {
  return {
    licence: (sourceId: string): LicenceEntry | undefined => {
      if (!(sourceId in attribution)) return undefined;
      return { sourceId, attribution: attribution[sourceId] ?? null } as unknown as LicenceEntry;
    },
    fieldSource: () => undefined,
    grantsFor: () => [],
    version: () => 1,
    reload: () => Promise.resolve(),
    refreshIfStale: () => Promise.resolve(),
    stats: () => ({ version: 1, licences: 0, fieldLicences: 0, grants: 0, loads: 1, freshChecks: 0 }),
  };
}

function decision(over: Partial<EntitlementDecision> = {}): EntitlementDecision {
  return { effectiveTier: 'delayed', fields: [], downgrades: [], logIds: [], ...over };
}

function denyField(fieldId: FieldId, reason: ReasonCode): EntitlementDecision['fields'][number] {
  return {
    fieldId,
    sourceId: SOURCE,
    fieldClass: 'market_data',
    decision: 'deny',
    effectiveTier: null,
    reason,
  };
}

/** A memory `ReadThroughStore`: the one seam `readThrough` has onto Postgres. */
function memoryStore(seed?: { requestKey: string; provenanceId: number; capturedAt: number }): {
  store: ReadThroughStore;
  writes: number[];
} {
  const rows = new Map<string, { provenanceId: number; capturedAt: Date }>();
  const writes: number[] = [];
  let nextId = 900;
  if (seed !== undefined) {
    rows.set(seed.requestKey, {
      provenanceId: seed.provenanceId,
      capturedAt: new Date(seed.capturedAt),
    });
  }
  const store: ReadThroughStore = {
    latest: (key) => Promise.resolve(rows.get(key) ?? null),
    record: async (args) => {
      const id = (nextId += 1);
      writes.push(id);
      if (args.persist !== undefined) {
        const normalised = await args.normalise(NO_DB, id);
        await args.persist({
          tx: NO_DB,
          raw: args.raw,
          provenanceId: id,
          normalised,
          key: args.key,
          capturedAt: args.raw.capturedAt,
        });
      }
      rows.set(args.raw.requestKey, { provenanceId: id, capturedAt: new Date(args.raw.capturedAt) });
      return id;
    },
  };
  return { store, writes };
}

const YAHOO_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL';

function rawRecord(capturedAt: number, status = 200): RawRecord {
  return {
    providerId: SOURCE,
    method: 'GET',
    url: YAHOO_URL,
    requestKey: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    status,
    headers: {},
    body: Buffer.from('{}'),
    capturedAt,
    sha256: 'c'.repeat(64),
    sourceTs: null,
    origin: 'replay',
  };
}

interface FakeAdapterHandle {
  adapter: ProviderAdapter<{ symbol: string }, Record<string, never>>;
  calls: string[];
  /** What the next `fetch` does. */
  behaviour: { kind: 'ok'; status?: number } | { kind: 'throw'; error: Error };
}

function fakeAdapter(capturedAt: number): FakeAdapterHandle {
  const handle: FakeAdapterHandle = {
    calls: [],
    behaviour: { kind: 'ok' },
    adapter: {
      id: SOURCE,
      sourceId: SOURCE,
      adapterVersion: 'yahoo/1.0.0',
      fetch: (_http, req) => {
        handle.calls.push(req.symbol);
        if (handle.behaviour.kind === 'throw') return Promise.reject(handle.behaviour.error);
        return Promise.resolve(rawRecord(capturedAt, handle.behaviour.status ?? 200));
      },
      normalise: (): Normalised<Record<string, never>> => ({
        updates: [],
        rows: {},
        sourceTs: null,
        problems: [],
      }),
    },
  };
  return handle;
}

function fakeHttp(breaker: BreakerState['state']): HttpClient {
  return {
    mode: 'replay',
    get: () => Promise.reject(new Error('the adapter builds its own request')),
    post: () => Promise.reject(new Error('the adapter builds its own request')),
    breaker: () => ({ state: breaker, consecutiveFailures: breaker === 'open' ? 5 : 0, openedAt: breaker === 'open' ? TEST_NOW : null }),
    tokens: () => ({ capacity: 10, available: 10, refillPerSec: 1 }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. ProvenanceCollector
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ProvenanceCollector', () => {
  const at = new Date(TEST_NOW);

  it('returns the same idx for the same provenanceId, and one meta entry', () => {
    const prov = provenanceCollector();
    const first = prov.add({ sourceId: SOURCE, provenanceId: 11, capturedAt: at, sourceTs: null });
    const again = prov.add({ sourceId: SOURCE, provenanceId: 11, capturedAt: at, sourceTs: null });
    const other = prov.add({ sourceId: SOURCE, provenanceId: 12, capturedAt: at, sourceTs: null });

    expect(first).toBe(0);
    expect(again).toBe(0);
    expect(other).toBe(1);
    expect(prov.size()).toBe(2);
    expect(prov.list().map((r) => r.provenanceId)).toEqual([11, 12]);
    expect(prov.list().map((r) => r.idx)).toEqual([0, 1]);
  });

  it('lets a second citation of one row refine its state and tier, never soften them', () => {
    const prov = provenanceCollector();
    prov.add({ sourceId: SOURCE, provenanceId: 11, capturedAt: at, sourceTs: null, st: 'live', tier: 'realtime' });
    prov.add({ sourceId: SOURCE, provenanceId: 11, capturedAt: at, sourceTs: null, st: 'stale', tier: 'eod' });
    expect(prov.size()).toBe(1);
    expect(prov.worstState()).toBe('stale');
    expect(prov.lowestTier()).toBe('eod');

    // The other direction cannot undo it.
    prov.add({ sourceId: SOURCE, provenanceId: 11, capturedAt: at, sourceTs: null, st: 'live', tier: 'realtime' });
    expect(prov.worstState()).toBe('stale');
    expect(prov.lowestTier()).toBe('eod');
  });

  it('cites a plant snapshot from its own prov, timestamps, state and tier', () => {
    const prov = provenanceCollector();
    const state = quoteState({ state: 'stale', tier: 'eod' });
    const idx = prov.addQuote(state);

    expect(idx).toBe(0);
    const [row] = prov.list();
    expect(row).toMatchObject({
      idx: 0,
      sourceId: SOURCE,
      provenanceId: 7,
      capturedAt: new Date(state.ts.cap).toISOString(),
      sourceTs: new Date(state.ts.src!).toISOString(),
    });
    expect(prov.worstState()).toBe('stale');
    expect(prov.lowestTier()).toBe('eod');

    // Cited again from a second block: one entry, same index.
    expect(prov.addQuote(state)).toBe(0);
    expect(prov.size()).toBe(1);
  });

  it('carries a null sourceTs when the provider published no instant', () => {
    const prov = provenanceCollector();
    prov.addQuote(quoteState({ ts: { src: null, cap: TEST_NOW, pub: TEST_NOW } }));
    expect(prov.list()[0]?.sourceTs).toBeNull();
  });

  it('fills attribution from the licence registry, and leaves an unknown source empty', () => {
    const registry = licenceRegistryStub({ [SOURCE]: 'Source: Yahoo Finance', 'sec.atom': null });
    const prov = provenanceCollector({ attribution: (id) => registry.licence(id)?.attribution });
    prov.add({ sourceId: SOURCE, provenanceId: 1, capturedAt: at, sourceTs: null });
    prov.add({ sourceId: 'sec.atom', provenanceId: 2, capturedAt: at, sourceTs: null });
    prov.add({ sourceId: 'unknown.source', provenanceId: 3, capturedAt: at, sourceTs: null });

    expect(prov.list().map((r) => r.attribution)).toEqual(['Source: Yahoo Finance', '', '']);
  });

  // ── the arithmetic, over every combination ────────────────────────────────────────────────

  const STATES: readonly ValueState[] = ['live', 'closed', 'na', 'stale', 'blank'];
  /** `meta.staleness` severity: a finished session's close is not a fault; a blank is the worst. */
  const SEVERITY: Readonly<Record<ValueState, number>> = { live: 0, closed: 1, na: 2, stale: 3, blank: 4 };

  it('worstState() is the worst verdict cited, for every ordered pair', () => {
    for (const a of STATES) {
      for (const b of STATES) {
        const prov = provenanceCollector();
        prov.add({ sourceId: SOURCE, provenanceId: 1, capturedAt: at, sourceTs: null, st: a });
        prov.add({ sourceId: SOURCE, provenanceId: 2, capturedAt: at, sourceTs: null, st: b });
        const expected = SEVERITY[a] >= SEVERITY[b] ? a : b;
        expect(prov.worstState(), `worst of ${a} and ${b}`).toBe(expected);
      }
    }
  });

  it("worstState() is 'live' with nothing cited and ignores a row that carried no verdict", () => {
    const empty = provenanceCollector();
    expect(empty.worstState()).toBe('live');

    const silent = provenanceCollector();
    silent.add({ sourceId: SOURCE, provenanceId: 1, capturedAt: at, sourceTs: null, st: 'blank' });
    silent.add({ sourceId: SOURCE, provenanceId: 2, capturedAt: at, sourceTs: null });
    expect(silent.worstState()).toBe('blank');
  });

  const TIERS: readonly Tier[] = ['eod', 'delayed', 'realtime'];
  const RANK: Readonly<Record<Tier, number>> = { eod: 0, delayed: 1, realtime: 2 };

  it('lowestTier() is the lowest tier cited, for every ordered pair', () => {
    for (const a of TIERS) {
      for (const b of TIERS) {
        const prov = provenanceCollector();
        prov.add({ sourceId: SOURCE, provenanceId: 1, capturedAt: at, sourceTs: null, tier: a });
        prov.add({ sourceId: SOURCE, provenanceId: 2, capturedAt: at, sourceTs: null, tier: b });
        const expected = RANK[a] <= RANK[b] ? a : b;
        expect(prov.lowestTier(), `lowest of ${a} and ${b}`).toBe(expected);
      }
    }
  });

  it("lowestTier() is 'eod' when nothing said — the most restrictive claim, never an overstatement", () => {
    expect(provenanceCollector().lowestTier()).toBe('eod');

    const silent = provenanceCollector();
    silent.add({ sourceId: SOURCE, provenanceId: 1, capturedAt: at, sourceTs: null });
    expect(silent.lowestTier()).toBe('eod');

    const one = provenanceCollector();
    one.add({ sourceId: SOURCE, provenanceId: 1, capturedAt: at, sourceTs: null, tier: 'realtime' });
    one.add({ sourceId: SOURCE, provenanceId: 2, capturedAt: at, sourceTs: null });
    expect(one.lowestTier()).toBe('realtime');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. Unavailable and engines
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('UnavailableCollector', () => {
  it('de-duplicates on (field, reason) and keeps the first detail', () => {
    const unavailable = unavailableCollector();
    unavailable.add({ field: 'EPS_EST', reason: 'NO_SOURCE', detail: 'no estimate vendor' });
    unavailable.add({ field: 'EPS_EST', reason: 'NO_SOURCE', detail: 'a second row, same gap' });
    unavailable.add({ field: 'EPS_EST', reason: 'NOT_LICENSED', detail: 'licence forbids export' });
    unavailable.add({ field: 'PX_BID', reason: 'NOT_APPLICABLE', detail: 'an index has no book' });

    expect(unavailable.list()).toEqual([
      { field: 'EPS_EST', reason: 'NO_SOURCE', detail: 'no estimate vendor' },
      { field: 'EPS_EST', reason: 'NOT_LICENSED', detail: 'licence forbids export' },
      { field: 'PX_BID', reason: 'NOT_APPLICABLE', detail: 'an index has no book' },
    ]);
  });

  it('hands out copies, so a caller cannot edit meta after the fact', () => {
    const unavailable = unavailableCollector();
    unavailable.add({ field: 'EPS_EST', reason: 'NO_SOURCE', detail: 'none' });
    const first = unavailable.list();
    const row = first[0];
    if (row !== undefined) row.detail = 'tampered';
    expect(unavailable.list()[0]?.detail).toBe('none');
  });
});

describe('EngineCollector', () => {
  it('de-duplicates on all three fields — same inputs once, different inputs twice', () => {
    const engines = engineCollector();
    engines.add({ name: 'adjust', version: '1.0.0', inputsHash: 'aa' });
    engines.add({ name: 'adjust', version: '1.0.0', inputsHash: 'aa' });
    engines.add({ name: 'adjust', version: '1.0.0', inputsHash: 'bb' });
    engines.add({ name: 'adjust', version: '1.1.0', inputsHash: 'aa' });

    expect(engines.list()).toEqual([
      { name: 'adjust', version: '1.0.0', inputsHash: 'aa' },
      { name: 'adjust', version: '1.0.0', inputsHash: 'bb' },
      { name: 'adjust', version: '1.1.0', inputsHash: 'aa' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. PlantReader
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('PlantReader', () => {
  const openGate = (): PlantGate => ({ tier: 'delayed', denied: new Map() });

  it('names the subject of an instrument in each family', () => {
    const reader = plantReader({ plant: fakePlant([]), gate: openGate });
    expect(reader.subjectFor(42)).toBe('q:42');
    expect(reader.subjectFor(42, 'q')).toBe('q:42');
    expect(reader.subjectFor(42, 'b1m')).toBe('b1m:42');
    expect(reader.subjectFor(42, 'oc')).toBe('oc:42');
  });

  it('serves the composite when nothing is denied', () => {
    const state = quoteState();
    const reader = plantReader({ plant: fakePlant([state]), gate: openGate });
    const snap = reader.snapshot('q:42');

    expect(snap?.fields.PX_LAST).toBe(188.5);
    expect(snap?.fields.PX_BID).toBe(188.4);
    expect(snap?.r).toEqual({});
    expect(snap?.tier).toBe('delayed');
  });

  it('returns a denied field blank with its reason, never the number the composite holds', () => {
    const state = quoteState();
    const denied = new Map<FieldId, ReasonCode>([['PX_BID', 'NOT_ENTITLED_TIER']]);
    const reader = plantReader({ plant: fakePlant([state]), gate: () => ({ tier: 'delayed', denied }) });

    const snap = reader.snapshot('q:42');
    // The composite really does hold a number for it — the gate is what makes it blank.
    expect(state.fields.PX_BID).toBe(188.4);
    expect(snap?.fields.PX_BID).toBeUndefined();
    expect(snap?.fieldTs.PX_BID).toBeUndefined();
    expect(snap?.r.PX_BID).toBe('NOT_ENTITLED_TIER');
    // and the fields around it are untouched
    expect(snap?.fields.PX_LAST).toBe(188.5);
    expect(snap?.r.PX_LAST).toBeUndefined();
  });

  it('freezes every field on an eod gate with no official close, and says why', () => {
    const reader = plantReader({
      plant: fakePlant([quoteState()]),
      gate: () => ({ tier: 'eod', denied: new Map() }),
    });
    const snap = reader.snapshot('q:42');

    expect(snap?.fields).toEqual({});
    expect(snap?.state).toBe('blank');
    expect(snap?.tier).toBe('eod');
    expect(snap?.r).toEqual({
      PX_LAST: 'TIER_EOD',
      PX_BID: 'TIER_EOD',
      PX_VOLUME: 'TIER_EOD',
    });
  });

  it('serves the official close to an eod gate that has one', () => {
    const eod: EodView = {
      sessionDate: '2026-09-16',
      closeTs: TEST_NOW - 86_400_000,
      fields: { PX_VOLUME: 987_654 },
      flags: [],
    };
    const reader = plantReader({
      plant: fakePlant([quoteState()], new Map([['q:42', eod]])),
      gate: () => ({ tier: 'eod', denied: new Map() }),
    });
    const snap = reader.snapshot('q:42');

    expect(snap?.fields.PX_VOLUME).toBe(987_654);
    expect(snap?.fieldTs.PX_VOLUME).toBe(eod.closeTs);
    expect(snap?.r.PX_VOLUME).toBeUndefined();
    expect(snap?.r.PX_LAST).toBe('TIER_EOD');
    expect(snap?.state).toBe('closed');
  });

  it('gates every subject of a snapshotMany, and skips what the plant does not hold', () => {
    const denied = new Map<FieldId, ReasonCode>([['PX_LAST', 'NO_FIRM_ENTITLEMENT']]);
    const reader = plantReader({
      plant: fakePlant([quoteState(), quoteState({ subject: 'q:43', instrumentId: 43 })]),
      gate: () => ({ tier: 'delayed', denied }),
    });

    const many = reader.snapshotMany(['q:42', 'q:43', 'q:99']);
    expect([...many.keys()]).toEqual(['q:42', 'q:43']);
    for (const snap of many.values()) {
      expect(snap.fields.PX_LAST).toBeUndefined();
      expect(snap.r.PX_LAST).toBe('NO_FIRM_ENTITLEMENT');
      expect(snap.fields.PX_BID).toBe(188.4);
    }
  });

  it('returns undefined for a subject the plant has never seen', () => {
    const reader = plantReader({ plant: fakePlant([]), gate: openGate });
    expect(reader.snapshot('q:404')).toBeUndefined();
  });

  it('ensureHot holds a subject for the decay window without pinning it for ever', () => {
    const clock = testClock();
    const hotset = new HotSet({ clock, decayMs: 60_000 });
    const reader = plantReader({ plant: fakePlant([]), hotset, gate: openGate });

    reader.ensureHot(['q:42', 'q:43']);
    expect(hotset.has('q:42')).toBe(true);
    expect(hotset.subscriberCount('q:42')).toBe(0);

    clock.advance(59_000);
    expect(hotset.has('q:42')).toBe(true);
    clock.advance(2_000);
    expect(hotset.has('q:42')).toBe(false);
    expect(hotset.has('q:43')).toBe(false);
  });

  it('ensureHot never releases a hold somebody else is keeping', () => {
    const clock = testClock();
    const hotset = new HotSet({ clock, decayMs: 60_000 });
    hotset.subscribe('q:42');
    const reader = plantReader({ plant: fakePlant([]), hotset, gate: openGate });

    reader.ensureHot(['q:42']);
    expect(hotset.subscriberCount('q:42')).toBe(1);
    clock.advance(600_000);
    expect(hotset.has('q:42')).toBe(true);
  });

  it('ensureHot is a no-op without a hot set, rather than a throw a resolver must guard', () => {
    const reader = plantReader({ plant: fakePlant([]), gate: openGate });
    expect(() => reader.ensureHot(['q:42'])).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. ReadThrough
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ReadThrough', () => {
  function harness(options: {
    breaker?: BreakerState['state'];
    seed?: { provenanceId: number; ageMs: number };
    schedulerOnly?: boolean;
  } = {}) {
    const clock = testClock();
    const handle = fakeAdapter(TEST_NOW);
    const routes = new ReadThroughRoutes();
    routes.register('yahoo.daily', {
      providerId: SOURCE,
      request: (key: string) => ({ symbol: key }),
      url: () => YAHOO_URL,
    });
    const providers = new ProviderRegistry();
    providers.register(handle.adapter, options.schedulerOnly === true ? { schedulerOnly: true } : {});

    const key = requestKeyOf(SOURCE, 'GET', YAHOO_URL);
    const seeded =
      options.seed === undefined
        ? undefined
        : { requestKey: key, provenanceId: options.seed.provenanceId, capturedAt: TEST_NOW - options.seed.ageMs };
    const { store, writes } = memoryStore(seeded);

    const rt = readThrough({
      clock,
      db: NO_DB,
      traceId: '11111111-1111-4111-8111-111111111111',
      routes,
      providers,
      http: fakeHttp(options.breaker ?? 'closed'),
      store,
    });
    return { rt, handle, clock, writes, store };
  }

  it('serves a store younger than maxAgeMs without touching the provider', async () => {
    const { rt, handle, writes } = harness({ seed: { provenanceId: 101, ageMs: 30_000 } });

    const out = await rt.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 60_000 });
    expect(out).toEqual({ fresh: true, provenanceId: 101, capturedAt: new Date(TEST_NOW - 30_000) });
    expect(handle.calls).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('fetches, persists and reports fresh when the store is older than maxAgeMs', async () => {
    const { rt, handle, writes } = harness({ seed: { provenanceId: 101, ageMs: 120_000 } });

    const out = await rt.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 60_000 });
    expect(handle.calls).toEqual(['AAPL']);
    expect(writes).toHaveLength(1);
    expect(out.fresh).toBe(true);
    expect(out.provenanceId).toBe(writes[0]);
    expect(out.capturedAt).toEqual(new Date(TEST_NOW));
  });

  it('fetches when nothing is stored at all', async () => {
    const { rt, handle, writes } = harness();
    const out = await rt.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 60_000 });
    expect(handle.calls).toEqual(['AAPL']);
    expect(out).toEqual({ fresh: true, provenanceId: writes[0], capturedAt: new Date(TEST_NOW) });
  });

  it('counts age against the injected clock, not the wall clock', async () => {
    const { rt, handle, clock } = harness({ seed: { provenanceId: 101, ageMs: 0 } });

    await rt.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 60_000 });
    expect(handle.calls).toEqual([]);

    clock.advance(60_001);
    await rt.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 60_000 });
    expect(handle.calls).toEqual(['AAPL']);
  });

  // ── the three circuit outcomes ────────────────────────────────────────────────────────────

  it('circuit closed: the provider is reached', async () => {
    const { rt, handle } = harness({ breaker: 'closed' });
    await rt.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 0 });
    expect(handle.calls).toEqual(['AAPL']);
  });

  it('circuit open WITH stale data stored: the stale row, labelled fresh:false, no fetch', async () => {
    const { rt, handle, writes } = harness({ breaker: 'open', seed: { provenanceId: 101, ageMs: 600_000 } });

    const out = await rt.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 60_000 });
    expect(out).toEqual({ fresh: false, provenanceId: 101, capturedAt: new Date(TEST_NOW - 600_000) });
    expect(handle.calls).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('circuit open with NOTHING stored: ProviderUnavailableError, 503 and retryable', async () => {
    const { rt, handle } = harness({ breaker: 'open' });

    await expect(rt.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 60_000 })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    const err = await rt.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 60_000 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503, retryable: true });
    expect((err as Error).message).toContain('circuit');
    expect(handle.calls).toEqual([]);
  });

  // ── every other way a fetch can be impossible lands in the same two places ────────────────

  it('a failed fetch degrades to the stored row rather than failing the screen', async () => {
    const { rt, handle } = harness({ seed: { provenanceId: 101, ageMs: 600_000 } });
    handle.behaviour = { kind: 'throw', error: new Error('replay miss: no capture for this key') };

    const out = await rt.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 60_000 });
    expect(out).toEqual({ fresh: false, provenanceId: 101, capturedAt: new Date(TEST_NOW - 600_000) });
    expect(handle.calls).toEqual(['AAPL']);
  });

  it('a failed fetch with nothing stored is a 503 that names the cause', async () => {
    const { rt, handle } = harness();
    handle.behaviour = { kind: 'throw', error: new Error('replay miss: no capture for this key') };

    const err = await rt.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 60_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect((err as Error).message).toContain('replay miss');
    expect(handle.calls).toEqual(['AAPL']);
  });

  it('a scheduler-only source is never fetched interactively (PROVIDERS.a §2.6)', async () => {
    const { rt, handle } = harness({ schedulerOnly: true, seed: { provenanceId: 101, ageMs: 600_000 } });

    const out = await rt.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 60_000 });
    expect(out.fresh).toBe(false);
    expect(out.provenanceId).toBe(101);
    expect(handle.calls).toEqual([]);
  });

  it('a 304 is a freshness confirmation: no provenance row, the stored one is current', async () => {
    const { rt, handle, writes } = harness({ seed: { provenanceId: 101, ageMs: 600_000 } });
    handle.behaviour = { kind: 'ok', status: 304 };

    const out = await rt.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 60_000 });
    expect(out).toEqual({ fresh: true, provenanceId: 101, capturedAt: new Date(TEST_NOW - 600_000) });
    expect(writes).toEqual([]);
  });

  it('an unrouted kind degrades instead of pretending it fetched', async () => {
    const { rt } = harness();
    const err = await rt.ensure('fred.series', 'DGS10', { maxAgeMs: 60_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect((err as Error).message).toContain('no read-through route');
  });

  it('runs the route persist hook inside the same write, with the normalised rows', async () => {
    const clock = testClock();
    const handle = fakeAdapter(TEST_NOW);
    const persisted: { provenanceId: number; key: string; capturedAt: number }[] = [];
    const routes = new ReadThroughRoutes();
    routes.register('yahoo.daily', {
      providerId: SOURCE,
      request: (key: string) => ({ symbol: key }),
      url: () => YAHOO_URL,
      persist: (args) => {
        persisted.push({ provenanceId: args.provenanceId, key: args.key, capturedAt: args.capturedAt });
        expect(args.normalised.updates).toEqual([]);
      },
    });
    const providers = new ProviderRegistry();
    providers.register(handle.adapter);
    const { store, writes } = memoryStore();

    const rt = readThrough({
      clock,
      db: NO_DB,
      traceId: '11111111-1111-4111-8111-111111111111',
      routes,
      providers,
      http: fakeHttp('closed'),
      store,
    });

    await rt.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 0 });
    expect(persisted).toEqual([{ provenanceId: writes[0], key: 'AAPL', capturedAt: TEST_NOW }]);
  });

  it('probes the store on the request key the route would produce', async () => {
    const { rt, store, handle } = harness();
    const spy = vi.spyOn(store, 'latest');
    await rt.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 60_000 });
    expect(spy).toHaveBeenCalledWith(requestKeyOf(SOURCE, 'GET', YAHOO_URL));
    expect(handle.calls).toEqual(['AAPL']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5. buildContext
// ─────────────────────────────────────────────────────────────────────────────────────────────

const INSTRUMENT: Instrument = {
  instrumentId: 42,
  issueId: 7,
  assetClass: 'equity',
  marketSector: 'Equity',
  ticker: 'AAPL',
  exchCode: 'US',
  name: 'Apple Inc',
  currency: 'USD',
  status: 'active',
  searchWeight: 2,
  validFrom: '2020-01-01T00:00:00.000Z',
  validTo: 'infinity',
  txFrom: '2020-01-01T00:00:00.000Z',
  txTo: 'infinity',
} as unknown as Instrument;

function buildFixture(options: { decision?: EntitlementDecision; evaluate?: Evaluator['evaluate'] } = {}) {
  const clock = testClock();
  const requests: EntitlementRequest[] = [];
  const evaluate: Evaluator['evaluate'] = options.evaluate ?? (() => Promise.resolve(decision()));
  const entitlements: Evaluator = {
    evaluate: (req) => {
      requests.push(req);
      return evaluate(req);
    },
    invalidate: () => undefined,
    stats: () => ({ evaluations: requests.length, cacheHits: 0, cacheMisses: 0 }),
  };

  const ctx = buildContext(
    {
      clock,
      db: NO_DB,
      data: {} as unknown as DataServices,
      plant: fakePlant([quoteState()]),
      registry: licenceRegistryStub({ [SOURCE]: 'Source: Yahoo Finance' }),
      entitlements,
    },
    {
      user: { userId: 5, firmId: 2, sessionId: 'sess-1', role: 'user' },
      traceId: '11111111-1111-4111-8111-111111111111',
      panelId: 'p1',
      instrument: INSTRUMENT,
      asOf: { validAt: new Date(TEST_NOW), knownAt: new Date(TEST_NOW) },
      usage: 'display',
      page: { cursor: null, direction: 'fwd' },
      purpose: 'DES',
      ...(options.decision === undefined ? {} : { decision: options.decision }),
    },
  );
  return { ctx, clock, requests };
}

describe('buildContext', () => {
  it('assembles exactly the FUNCTIONS.md §1.4.1 surface, and nothing else', () => {
    const { ctx } = buildFixture();
    expect(Object.keys(ctx).sort()).toEqual(
      [
        'asOf',
        'clock',
        'data',
        'db',
        'engines',
        'entitle',
        'instrument',
        'page',
        'panelId',
        'plant',
        'prov',
        'providers',
        'traceId',
        'unavailable',
        'usage',
        'user',
      ].sort(),
    );
  });

  it('passes the request transaction through and opens nothing of its own', () => {
    const { ctx } = buildFixture();
    expect(ctx.db).toBe(NO_DB);
  });

  it('carries the injected clock, trace, panel, as-of, usage and instrument', () => {
    const { ctx, clock } = buildFixture();
    expect(ctx.clock).toBe(clock);
    expect(ctx.clock.now()).toBe(TEST_NOW);
    expect(ctx.traceId).toBe('11111111-1111-4111-8111-111111111111');
    expect(ctx.panelId).toBe('p1');
    expect(ctx.usage).toBe('display');
    expect(ctx.instrument?.instrumentId).toBe(42);
    expect(ctx.asOf.validAt.toISOString()).toBe(new Date(TEST_NOW).toISOString());
  });

  it('omits panelId and page entirely when the request carried none', () => {
    const ctx = buildContext(
      {
        clock: testClock(),
        db: NO_DB,
        data: {} as unknown as DataServices,
        plant: fakePlant([]),
        registry: licenceRegistryStub({}),
        entitlements: { evaluate: () => Promise.resolve(decision()), invalidate: () => undefined, stats: () => ({ evaluations: 0, cacheHits: 0, cacheMisses: 0 }) },
      },
      {
        user: { userId: 5, firmId: 2, sessionId: 'sess-1', role: 'user' },
        traceId: '11111111-1111-4111-8111-111111111111',
        instrument: null,
        asOf: { validAt: new Date(TEST_NOW), knownAt: new Date(TEST_NOW) },
        usage: 'api',
      },
    );
    expect('panelId' in ctx).toBe(false);
    expect('page' in ctx).toBe(false);
    expect(ctx.instrument).toBeNull();
  });

  it('gives each context its own collectors, with the licence attribution already wired', () => {
    const { ctx } = buildFixture();
    const other = buildFixture().ctx;

    ctx.prov.add({ sourceId: SOURCE, provenanceId: 1, capturedAt: new Date(TEST_NOW), sourceTs: null });
    expect(ctx.prov.list()).toHaveLength(1);
    expect(ctx.prov.list()[0]?.attribution).toBe('Source: Yahoo Finance');
    expect(other.prov.list()).toHaveLength(0);
  });

  it('records the page cursor a resolver sets, for meta.page and the next page request', () => {
    const { ctx } = buildFixture();
    expect(ctx.page?.cursor).toBeNull();
    expect(ctx.page?.direction).toBe('fwd');
    expect(ctx.page?.info).toBeNull();

    ctx.page?.set({ index: 0, count: 50, cursor: 'eyJvIjo1MH0' });
    expect(ctx.page?.info).toEqual({ index: 0, count: 50, cursor: 'eyJvIjo1MH0' });
  });

  it('applies the runner decision to the plant gate before a resolver reads a thing', () => {
    const { ctx } = buildFixture({
      decision: decision({ fields: [denyField('PX_BID', 'NO_FIRM_ENTITLEMENT')] }),
    });
    const snap = ctx.plant.snapshot('q:42');
    expect(snap?.fields.PX_LAST).toBe(188.5);
    expect(snap?.fields.PX_BID).toBeUndefined();
    expect(snap?.r.PX_BID).toBe('NO_FIRM_ENTITLEMENT');
  });

  it("takes the decision's tier, and does not cap a realtime grant at the delayed default", () => {
    const { ctx } = buildFixture({ decision: decision({ effectiveTier: 'realtime' }) });
    expect(ctx.plant.snapshot('q:42')?.tier).toBe('realtime');

    const eod = buildFixture({ decision: decision({ effectiveTier: 'eod' }) }).ctx;
    expect(eod.plant.snapshot('q:42')?.tier).toBe('eod');
  });

  it('ctx.entitle asks the evaluator about this instrument, under this run purpose', async () => {
    const { ctx, requests } = buildFixture();
    await ctx.entitle(['PX_LAST', 'PX_BID'], 'export');

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      userId: 5,
      firmId: 2,
      sessionId: 'sess-1',
      instrumentId: 42,
      assetClass: 'equity',
      fieldIds: ['PX_LAST', 'PX_BID'],
      tier: 'delayed',
      usage: 'export',
      purpose: 'DES',
      traceId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('a mid-resolve denial closes the gate for every plant read that follows it', async () => {
    const { ctx } = buildFixture({
      evaluate: () =>
        Promise.resolve(decision({ fields: [denyField('PX_LAST', 'LICENCE_FORBIDS_USAGE')] })),
    });

    expect(ctx.plant.snapshot('q:42')?.fields.PX_LAST).toBe(188.5);
    await ctx.entitle(['PX_LAST'], 'export');
    const after = ctx.plant.snapshot('q:42');
    expect(after?.fields.PX_LAST).toBeUndefined();
    expect(after?.r.PX_LAST).toBe('LICENCE_FORBIDS_USAGE');
  });

  it('a second decision can only lower the tier, never hand one back', async () => {
    const { ctx } = buildFixture({
      decision: decision({ effectiveTier: 'delayed' }),
      evaluate: () => Promise.resolve(decision({ effectiveTier: 'realtime' })),
    });
    await ctx.entitle(['PX_LAST'], 'display');
    expect(ctx.plant.snapshot('q:42')?.tier).toBe('delayed');

    const down = buildFixture({
      decision: decision({ effectiveTier: 'delayed' }),
      evaluate: () => Promise.resolve(decision({ effectiveTier: 'eod' })),
    }).ctx;
    await down.entitle(['PX_LAST'], 'display');
    expect(down.plant.snapshot('q:42')?.tier).toBe('eod');
  });

  it('a manifest with no security asks about instrumentId null, not about a stale panel security', async () => {
    const requests: EntitlementRequest[] = [];
    const ctx = buildContext(
      {
        clock: testClock(),
        db: NO_DB,
        data: {} as unknown as DataServices,
        plant: fakePlant([]),
        registry: licenceRegistryStub({}),
        entitlements: {
          evaluate: (req) => {
            requests.push(req);
            return Promise.resolve(decision());
          },
          invalidate: () => undefined,
          stats: () => ({ evaluations: 0, cacheHits: 0, cacheMisses: 0 }),
        },
      },
      {
        user: { userId: 5, firmId: 2, sessionId: 'sess-1', role: 'user' },
        traceId: '11111111-1111-4111-8111-111111111111',
        instrument: null,
        asOf: { validAt: new Date(TEST_NOW), knownAt: new Date(TEST_NOW) },
        usage: 'display',
      },
    );
    await ctx.entitle(['ECO_VALUE'], 'display');
    expect(requests[0]).toMatchObject({ instrumentId: null, assetClass: null, purpose: 'fn' });
  });

  it('degrades every read-through kind when no routes are wired, rather than inventing one', async () => {
    const { ctx } = buildFixture();
    await expect(ctx.providers.ensure('yahoo.daily', 'AAPL', { maxAgeMs: 1 })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 6. The closed surface (ARCHITECTURE §5.1: a resolver never imports db/client.ts)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the resolver surface', () => {
  /** Everything `db/client.ts` exports that opens, closes or wraps a connection. */
  const CONNECTION_API = [
    'getDb',
    'getPool',
    'connectDb',
    'closeDb',
    'withTx',
    'withMaintTx',
    'currentTx',
    'runWithTx',
    'setAmbientTx',
    'pingDb',
    'migrationFiles',
    'pendingMigrations',
  ];

  it('re-exports nothing from db/client.ts, under that name or any other', async () => {
    const dbClient: Record<string, unknown> = await import('../../../src/db/client.js');
    const exported = Object.entries(contextModule as Record<string, unknown>);

    for (const name of CONNECTION_API) {
      expect(Object.keys(contextModule as Record<string, unknown>)).not.toContain(name);
      const value = dbClient[name];
      // and not under an alias either: no exported binding IS one of those functions
      expect(exported.some(([, v]) => v === value && value !== undefined)).toBe(false);
    }
  });

  it('exports no provider adapter, HTTP client or plant — only the collaborators §1.4.2 names', () => {
    const values = Object.values(contextModule as Record<string, unknown>);
    // The whole exported surface is types, three collector factories, the plant reader, the
    // read-through, its route table and store, `buildContext` and the 503. Nothing that holds a
    // socket, a pool or a live plant.
    expect(Object.keys(contextModule as Record<string, unknown>).sort()).toEqual(
      [
        'ProviderUnavailableError',
        'ReadThroughRoutes',
        'buildContext',
        'dbReadThroughStore',
        'engineCollector',
        'pageContext',
        'plantReader',
        'provenanceCollector',
        'readThrough',
        'unavailableCollector',
      ].sort(),
    );
    expect(values.every((v) => typeof v === 'function')).toBe(true);
  });

  it('gives a resolver a context whose handles are the ones it was built with', () => {
    const { ctx } = buildFixture();
    const surface: ResolveContext = ctx;
    // `plant` is the gated reader, not WP-06's Plant: no `apply`, no `publish`, no `subscribe`.
    expect('apply' in surface.plant).toBe(false);
    expect('publish' in surface.plant).toBe(false);
    expect('subscribe' in surface.plant).toBe(false);
    expect(Object.keys(surface.plant).sort()).toEqual(
      ['ensureHot', 'snapshot', 'snapshotMany', 'subjectFor'].sort(),
    );
    // `providers` is the read-through, not the adapter registry.
    expect(Object.keys(surface.providers)).toEqual(['ensure']);
  });
});
