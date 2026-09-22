/**
 * BUS-06 / ENTL-05 — `plant/policyTier.ts#view` and `plant/eod.ts#buildEodSnapshot`
 * (ARCHITECTURE §6.5, API.md §6.6 and the last paragraph of §6.8).
 *
 * The state under test is the one recorded Cboe observation of AAPL,
 * `fixtures/providers/normalised/cboe-quote-AAPL.json`, applied as the composite state of `q:101`
 * with the derived `CHG_*` fields the plant adds. The eod view over it must be exactly what
 * API.md §6.8 shows an `eod`-only subscriber receiving:
 * `f:{PX_LAST:null, PX_BID:null, PX_ASK:null, PX_VOLUME:16591786, CHG_PCT_1D:null}`,
 * `r:{PX_LAST:TIER_EOD, PX_BID:TIER_EOD, PX_ASK:TIER_EOD, CHG_PCT_1D:TIER_EOD}`, `st:"closed"`.
 */

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { FieldId, NormalisedUpdate, QuoteState, ReasonCode } from '@terminal/core';

import { buildEodSnapshot } from '../../../src/plant/eod.js';
import { view } from '../../../src/plant/policyTier.js';
import { readNormalised } from '../../../src/test/fixtures.js';

// `src/test/fixtures.ts` resolves `REPLAY_DIR` against `packages/server`, and the repository's
// `.env` carries the root-relative `./fixtures/providers`, which lands one directory too deep. The
// captures are a fixed part of the repository, so this file pins the absolute path (the same thing
// `test/integration/ingest/reconcile.test.ts` does). It must be set on `process.env`, not through
// `setConfig`, because the setup files clear the memoised config before every test.
process.env.REPLAY_DIR = fileURLToPath(
  new URL('../../../../../fixtures/providers', import.meta.url),
);

interface NormalisedFixture {
  updates: NormalisedUpdate[];
  rows: { crossChecks: { priceChange: number; priceChangePercent: number }[] };
}

/** 2026-09-15 16:00 ET — the NYSE close of the fixture's session. */
const SESSION_DATE = '2026-09-15';
const CLOSE_TS = Date.parse('2026-09-15T20:00:00.000Z');

/** The composite state the plant holds after applying the fixture's one update (seq 1). */
async function aaplState(): Promise<QuoteState> {
  const fx = await readNormalised<NormalisedFixture>('cboe-quote-AAPL');
  const u = fx.updates[0]!;
  const xc = fx.rows.crossChecks[0]!;
  expect(u.subject).toBe('q:101');
  expect(u.fields.PX_LAST).toBe(330.27);
  expect(u.fields.PX_VOLUME).toBe(16591786);

  const fields: QuoteState['fields'] = {
    ...u.fields,
    CHG_NET_1D: xc.priceChange,
    CHG_PCT_1D: xc.priceChangePercent,
    TICK_DIR: 'down',
  };
  const fieldTs: QuoteState['fieldTs'] = {};
  for (const id of Object.keys(fields) as (keyof QuoteState['fields'])[]) {
    fieldTs[id] = u.ts.src ?? u.ts.cap;
  }
  return {
    subject: u.subject,
    instrumentId: u.instrumentId,
    assetClass: u.assetClass,
    seq: 1,
    tier: u.tier,
    delayMin: 15,
    fields,
    fieldTs,
    ts: u.ts,
    session: 'open',
    state: 'live',
    ageMs: 0,
    expectedIntervalMs: 10_000,
    prov: u.prov,
    lines: {
      [u.mdLineId]: {
        mdLineId: u.mdLineId,
        sourceId: u.prov.sourceId,
        fields: u.fields,
        ts: u.ts,
        srcSeq: u.prov.srcSeq!,
        provenanceId: u.prov.provenanceId,
      },
    },
    dq: [],
  };
}

const SUB_FIELDS: FieldId[] = ['PX_LAST', 'PX_BID', 'PX_ASK', 'PX_VOLUME', 'CHG_PCT_1D'];

describe('plant/eod — buildEodSnapshot over the AAPL fixture', () => {
  it('carries the six close fields, falls back to PX_LAST for the official close and says so', async () => {
    const state = await aaplState();
    const eod = buildEodSnapshot(state, SESSION_DATE, CLOSE_TS);
    expect(eod.sessionDate).toBe(SESSION_DATE);
    expect(eod.closeTs).toBe(CLOSE_TS);
    // The Cboe delayed line publishes no official print: PX_LAST at the close stands in, flagged.
    expect(eod.fields).toEqual({
      PX_OFFICIAL_CLOSE: 330.27,
      PX_CLOSE_1D: 333.08,
      PX_VOLUME: 16591786,
      PX_OPEN: 330.24,
      PX_HIGH: 331.59,
      PX_LOW: 328.35,
    });
    expect(eod.flags).toEqual(['OFFICIAL_CLOSE_FROM_LAST']);
    // Nothing outside the eod alphabet leaks into the view.
    expect(Object.keys(eod.fields)).not.toContain('PX_LAST');
    expect(Object.keys(eod.fields)).not.toContain('PX_BID');
  });

  it('uses the official print when the state has one, with no flag', async () => {
    const state = await aaplState();
    state.fields.PX_OFFICIAL_CLOSE = 330.3;
    const eod = buildEodSnapshot(state, SESSION_DATE, CLOSE_TS);
    expect(eod.fields.PX_OFFICIAL_CLOSE).toBe(330.3);
    expect(eod.flags).toEqual([]);
  });

  it('never invents a close: no official print and no last trade is MISSING_CLOSE, not 0', async () => {
    const state = await aaplState();
    delete state.fields.PX_LAST;
    delete state.fields.PX_OFFICIAL_CLOSE;
    const eod = buildEodSnapshot(state, SESSION_DATE, CLOSE_TS);
    expect(eod.fields.PX_OFFICIAL_CLOSE).toBeUndefined();
    expect(eod.flags).toEqual(['MISSING_CLOSE']);
    expect(eod.fields.PX_VOLUME).toBe(16591786);
  });
});

describe('plant/policyTier — view(state, tier, ctx)', () => {
  it('eod: exactly the snap of API.md §6.8 last paragraph', async () => {
    const state = await aaplState();
    const eod = buildEodSnapshot(state, SESSION_DATE, CLOSE_TS);
    const v = view(state, 'eod', { fieldIds: SUB_FIELDS, eod });

    expect(v.tier).toBe('eod');
    expect(v.fields).toEqual({
      PX_LAST: null,
      PX_BID: null,
      PX_ASK: null,
      PX_VOLUME: 16591786,
      CHG_PCT_1D: null,
    });
    // Exactly the four denials of API.md §6.8 — the served PX_VOLUME carries no key in `r`.
    expect(v.r).toEqual({
      PX_LAST: 'TIER_EOD',
      PX_BID: 'TIER_EOD',
      PX_ASK: 'TIER_EOD',
      CHG_PCT_1D: 'TIER_EOD',
    });
    expect(v.state).toBe('closed');
    expect(v.session).toBe('closed');
    // ts.src is the session close, not the delayed line's source time.
    expect(v.ts).toEqual({ src: CLOSE_TS, cap: state.ts.cap, pub: state.ts.pub });
    expect(v.fieldTs).toEqual({ PX_VOLUME: CLOSE_TS });
    expect(v.seq).toBe(1);
    // Only the subscribed fields are emitted, in subscription order (BUS-02).
    expect(Object.keys(v.fields)).toEqual(SUB_FIELDS);
  });

  it('eod: every close field is served from the EodView with ts.src = close', async () => {
    const state = await aaplState();
    const eod = buildEodSnapshot(state, SESSION_DATE, CLOSE_TS);
    const ids: FieldId[] = [
      'PX_OFFICIAL_CLOSE',
      'PX_CLOSE_1D',
      'PX_OPEN',
      'PX_HIGH',
      'PX_LOW',
      'PX_VOLUME',
      'PX_LAST',
    ];
    const v = view(state, 'eod', { fieldIds: ids, eod });
    expect(v.fields).toEqual({
      PX_OFFICIAL_CLOSE: 330.27,
      PX_CLOSE_1D: 333.08,
      PX_OPEN: 330.24,
      PX_HIGH: 331.59,
      PX_LOW: 328.35,
      PX_VOLUME: 16591786,
      PX_LAST: null,
    });
    expect(v.r).toEqual({ PX_LAST: 'TIER_EOD' });
    for (const id of ids.slice(0, 6)) {
      expect(v.r[id]).toBeUndefined();
      expect(v.fieldTs[id]).toBe(CLOSE_TS);
    }
  });

  it('eod with no EodView yet: everything null with TIER_EOD and st blank — never a live number', async () => {
    const state = await aaplState();
    const v = view(state, 'eod', { fieldIds: SUB_FIELDS, eod: null });
    expect(Object.values(v.fields).every((x) => x === null)).toBe(true);
    expect(Object.values(v.r).every((x) => x === 'TIER_EOD')).toBe(true);
    expect(v.state).toBe('blank');
  });

  it('delayed: identity on the Cboe line, restricted to the subscribed fields', async () => {
    const state = await aaplState();
    const v = view(state, 'delayed', { fieldIds: SUB_FIELDS });
    expect(v.tier).toBe('delayed');
    expect(v.fields).toEqual({
      PX_LAST: 330.27,
      PX_BID: 330.25,
      PX_ASK: 330.28,
      PX_VOLUME: 16591786,
      CHG_PCT_1D: -0.8436,
    });
    // A served field carries no reason: `r` is the denial list, not a per-field status.
    expect(v.r).toEqual({});
    expect(v.fieldTs).toEqual({
      PX_LAST: state.ts.src,
      PX_BID: state.ts.src,
      PX_ASK: state.ts.src,
      PX_VOLUME: state.ts.src,
      CHG_PCT_1D: state.ts.src,
    });
    expect(v.ts).toEqual(state.ts);
    expect(v.state).toBe('live');
    expect(v.session).toBe('open');
    expect(v.prov).toEqual(state.prov);
    // A subscriber to PX_LAST never receives PX_BID (BUS-02).
    const narrow = view(state, 'delayed', { fieldIds: ['PX_LAST'] });
    expect(Object.keys(narrow.fields)).toEqual(['PX_LAST']);
    expect(narrow.r).toEqual({});
  });

  it('realtime: the identity, reported as realtime (the gateway owns the SOURCE_TIER_CAP downgrade)', async () => {
    const state = await aaplState();
    const v = view(state, 'realtime', { fieldIds: ['PX_LAST', 'TICK_DIR'] });
    expect(v.tier).toBe('realtime');
    expect(v.fields).toEqual({ PX_LAST: 330.27, TICK_DIR: 'down' });
  });

  it('a field the state lacks is null with no reason, not a fabricated value', async () => {
    const state = await aaplState();
    const v = view(state, 'delayed', { fieldIds: ['PX_LAST', 'LAST_SIZE', 'VWAP'] });
    expect(v.fields).toEqual({ PX_LAST: 330.27, LAST_SIZE: null, VWAP: null });
    // Nothing denied the field; it simply has no value yet, so `r` stays empty.
    expect(v.r).toEqual({});
    expect(v.fieldTs).toEqual({ PX_LAST: state.ts.src });
  });

  it('ENTL-05: a denied field is null with its reason on every tier and never carries a number', async () => {
    const state = await aaplState();
    const eod = buildEodSnapshot(state, SESSION_DATE, CLOSE_TS);
    const denied = new Map<FieldId, ReasonCode>([
      ['PX_VOLUME', 'NO_USER_ENTITLEMENT'],
      ['PX_LAST', 'NO_FIRM_ENTITLEMENT'],
    ]);
    for (const tier of ['realtime', 'delayed', 'eod'] as const) {
      const v = view(state, tier, { fieldIds: SUB_FIELDS, eod, denied });
      expect(v.fields.PX_VOLUME).toBeNull();
      expect(v.r.PX_VOLUME).toBe('NO_USER_ENTITLEMENT');
      expect(v.fields.PX_LAST).toBeNull();
      expect(v.r.PX_LAST).toBe('NO_FIRM_ENTITLEMENT');
      expect(v.fieldTs.PX_VOLUME).toBeUndefined();
      expect(v.fieldTs.PX_LAST).toBeUndefined();
    }
    // The undenied fields are untouched by the denial map.
    const d = view(state, 'delayed', { fieldIds: SUB_FIELDS, denied });
    expect(d.fields.PX_BID).toBe(330.25);
    expect(d.r.PX_BID).toBeUndefined();
    expect(Object.keys(d.r).sort()).toEqual(['PX_LAST', 'PX_VOLUME']);
  });
});
