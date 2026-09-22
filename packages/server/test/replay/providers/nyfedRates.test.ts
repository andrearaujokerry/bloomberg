/**
 * `nyfed.rates` — QA-02 over all three recorded captures of this source:
 * `raw/nyfed-all` → `nyfed-all.json`, `raw/nyfed-sofr` → `nyfed-sofr.json` and
 * `raw/nyfed-effr.json` → `nyfed-effr.json`, byte for byte.
 *
 * Measured from the captures:
 *
 *  - `/all/latest.json` carries **all six types in one request** — SOFR, EFFR, OBFR, TGCR, BGCR
 *    and SOFRAI — which is why `ingest/jobs/fedRates.ts` calls it once a day instead of six times;
 *  - **five of the six carry percentiles and a volume; SOFRAI carries none.** SOFRAI publishes
 *    only `average30day/90day/180day` and `index`, so its `rate` is `null` and `r:SOFRAI` gets no
 *    update at all — the screen shows `—`, which is correct, rather than a fabricated zero;
 *  - **`targetRateFrom`/`targetRateTo` appear on EFFR alone** (3.50–3.75 on every recorded day),
 *    exactly as §10.4 says, and on no other type;
 *  - `/secured/sofr/last/5.json` is 5 days, 2026-09-08 … 2026-09-14, and every one of them becomes
 *    a `SOFR_FIX` curve point at tenor `ON`; `/unsecured/effr/last/10.json` is 10 days,
 *    2026-08-31 … 2026-09-14, and none of them does — the fixing curve is SOFR's;
 *  - **a multi-day response publishes one update, for its latest day**: the tables hold the
 *    history, the plant holds a current value;
 *  - `revisionIndicator` is empty on all 21 recorded fixings, so every row is a first vintage.
 */

import { describe, expect, it } from 'vitest';

import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import {
  lastNUrl,
  latestAllUrl,
  nyFedRatesAdapter,
  registerNyFedAdapters,
} from '../../../src/providers/nyfed/adapter.js';
import { RATE_CODES, parseRefRates } from '../../../src/providers/nyfed/parse.js';
import { readGolden, serialiseGolden, toGolden } from './golden.js';
import type { NormaliseContext, NormaliseLine } from '../../../src/providers/types.js';

const store = openReplayStore();

/**
 * The canonical context — one `md_lines` row per type, keyed by the type itself, as PROVIDERS
 * §10.4 describes them (`line_kind 'composite'`, `intrinsic_delay_min 0`, `priority 10`, and
 * `tier 'realtime'`, which is the one source where the entitlement evaluator may grant it).
 */
const RATE_LINES = new Map<string, NormaliseLine>(
  RATE_CODES.map((code, index) => [
    code,
    {
      mdLineId: 9101 + index,
      instrumentId: 8101 + index,
      assetClass: 'rate',
      tier: 'realtime',
      intrinsicDelayMin: 0,
      expectedIntervalMs: 86_400_000,
      priority: 10,
    },
  ]),
);

function load(url: string): { raw: ReturnType<typeof store.replay>; ctx: NormaliseContext } {
  const raw = store.replay({ providerId: 'nyfed.rates', url });
  return { raw, ctx: { provenanceId: 1, capturedAt: raw.capturedAt, lines: RATE_LINES } };
}

const all = load(latestAllUrl());
const sofr = load(lastNUrl('SOFR', 5));
const effr = load(lastNUrl('EFFR', 10));

const allParsed = parseRefRates(all.raw, all.ctx);
const sofrParsed = parseRefRates(sofr.raw, sofr.ctx);
const effrParsed = parseRefRates(effr.raw, effr.ctx);

describe('nyfed.rates replay', () => {
  it('reads all three recorded captures, never a socket', () => {
    expect(latestAllUrl()).toBe('https://markets.newyorkfed.org/api/rates/all/latest.json');
    expect(lastNUrl('SOFR', 5)).toBe(
      'https://markets.newyorkfed.org/api/rates/secured/sofr/last/5.json',
    );
    expect(lastNUrl('EFFR', 10)).toBe(
      'https://markets.newyorkfed.org/api/rates/unsecured/effr/last/10.json',
    );
    expect(() => lastNUrl('SOFR', 0)).toThrow(/positive integer/);

    for (const { raw, sha, bytes } of [
      {
        raw: all.raw,
        sha: '298eabfe35d09cfb487ed5e5f1d3d3f66f91ddac8afd821b47e2d1f0fcf8d93b',
        bytes: 1_426,
      },
      {
        raw: sofr.raw,
        sha: 'b918aedbe543391ec1fe917fe65c57aaedf49257108e4251e59a1a06b38defd8',
        bytes: 1_208,
      },
      {
        raw: effr.raw,
        sha: '24b2f0b9b5356fcee9904067a14164a3ea840f03d10f245a74cda65fdb4788a3',
        bytes: 2_847,
      },
    ]) {
      expect(raw.origin).toBe('replay');
      expect(raw.providerId).toBe('nyfed.rates');
      expect(raw.status).toBe(200);
      expect(raw.sha256).toBe(sha);
      expect(raw.body.byteLength).toBe(bytes);
      expect(raw.requestKey).toBe(requestKey('nyfed.rates', 'GET', raw.url));
    }
  });

  it('matches the three committed goldens exactly', () => {
    for (const { capture, raw, parsed } of [
      { capture: 'nyfed-all', raw: all.raw, parsed: allParsed },
      { capture: 'nyfed-sofr', raw: sofr.raw, parsed: sofrParsed },
      { capture: 'nyfed-effr.json', raw: effr.raw, parsed: effrParsed },
    ]) {
      const golden = serialiseGolden(
        toGolden(
          capture,
          nyFedRatesAdapter.id,
          raw.requestKey,
          nyFedRatesAdapter.adapterVersion,
          parsed,
        ),
      );
      const name = capture.endsWith('.json') ? capture : `${capture}.json`;
      expect(golden).toBe(readGolden(name));
    }
  });

  it('reads all six types out of one /all/latest.json request', () => {
    expect(allParsed.problems).toEqual([]);
    expect(allParsed.rows.fixings).toHaveLength(6);
    expect(allParsed.rows.fixings.map((f) => f.rateCode).sort()).toEqual(
      ['BGCR', 'EFFR', 'OBFR', 'SOFR', 'SOFRAI', 'TGCR'].sort(),
    );
    const byCode = new Map(allParsed.rows.fixings.map((f) => [f.rateCode, f]));
    expect(byCode.get('SOFR')).toMatchObject({
      effectiveDate: '2026-09-14',
      rate: 3.62,
      pct1: 3.57,
      pct25: 3.6,
      pct75: 3.67,
      pct99: 3.7,
      volumeBn: 2861,
      revisionIndicator: '',
    });
    expect(byCode.get('SOFR')?.vintageAt).toBe(new Date(all.raw.capturedAt).toISOString());
    // The payload publishes no instant of its own, only effective dates.
    expect(allParsed.sourceTs).toBeNull();
  });

  it('gives SOFRAI no rate, no percentiles and no plant update', () => {
    const sofrai = allParsed.rows.fixings.find((f) => f.rateCode === 'SOFRAI');
    expect(sofrai).toMatchObject({
      effectiveDate: '2026-09-15',
      rate: null,
      pct1: null,
      pct25: null,
      pct75: null,
      pct99: null,
      volumeBn: null,
      avg30d: 3.6485,
      avg90d: 3.64603,
      avg180d: 3.65767,
      indexValue: 1.25884091,
    });
    expect(allParsed.updates.map((u) => u.subject)).toEqual([
      'r:SOFR',
      'r:EFFR',
      'r:OBFR',
      'r:TGCR',
      'r:BGCR',
    ]);
    expect(allParsed.updates.some((u) => u.subject === 'r:SOFRAI')).toBe(false);
  });

  it('carries percentiles and volume on the five rate types, and a target range on EFFR alone', () => {
    const withPercentiles = allParsed.rows.fixings.filter((f) => f.pct1 !== null);
    expect(withPercentiles).toHaveLength(5);
    expect(
      withPercentiles.every((f) => f.pct25 !== null && f.pct75 !== null && f.pct99 !== null),
    ).toBe(true);
    expect(allParsed.rows.fixings.filter((f) => f.volumeBn !== null)).toHaveLength(5);
    const withTarget = allParsed.rows.fixings.filter((f) => f.targetFrom !== null);
    expect(withTarget.map((f) => f.rateCode)).toEqual(['EFFR']);
    expect(withTarget[0]).toMatchObject({ targetFrom: 3.5, targetTo: 3.75 });
    // p1 ≤ rate ≤ p99 on every fixing that has both — the band that §10.4 drops when it breaks.
    for (const fixing of withPercentiles) {
      expect(fixing.pct1 ?? 0).toBeLessThanOrEqual(fixing.rate ?? 0);
      expect(fixing.pct99 ?? 0).toBeGreaterThanOrEqual(fixing.rate ?? 0);
    }
  });

  it('publishes one SOFR_FIX curve point per SOFR day, and none for EFFR', () => {
    expect(sofrParsed.rows.fixings).toHaveLength(5);
    expect(sofrParsed.rows.fixings.map((f) => f.effectiveDate)).toEqual([
      '2026-09-14',
      '2026-09-11',
      '2026-09-10',
      '2026-09-09',
      '2026-09-08',
    ]);
    expect(sofrParsed.rows.curvePoints).toHaveLength(5);
    expect(sofrParsed.rows.curvePoints[0]).toEqual({
      curveId: 'SOFR_FIX',
      curveDate: '2026-09-14',
      tenor: 'ON',
      quoteType: 'fixing',
      vintageAt: new Date(sofr.raw.capturedAt).toISOString(),
      tenorDays: 1,
      value: 3.62,
      instrumentId: null,
      maturityDate: null,
    });
    expect(effrParsed.rows.fixings).toHaveLength(10);
    expect(effrParsed.rows.curvePoints).toEqual([]);
    expect(effrParsed.rows.fixings[0]?.effectiveDate).toBe('2026-09-14');
    expect(effrParsed.rows.fixings[9]?.effectiveDate).toBe('2026-08-31');
    expect(effrParsed.rows.fixings.every((f) => f.revisionIndicator === '')).toBe(true);
  });

  it('publishes the latest day of a multi-day response to the plant, once', () => {
    expect(sofrParsed.updates).toHaveLength(1);
    expect(sofrParsed.updates[0]).toMatchObject({
      subject: 'r:SOFR',
      instrumentId: 8101,
      mdLineId: 9101,
      assetClass: 'rate',
      tier: 'realtime',
      fields: {
        RATE: 3.62,
        RATE_P1: 3.57,
        RATE_P25: 3.6,
        RATE_P75: 3.67,
        RATE_P99: 3.7,
        RATE_VOLUME_BN: 2861,
      },
    });
    expect(sofrParsed.updates[0]?.ts).toEqual({ src: null, cap: sofr.raw.capturedAt, pub: 0 });
    expect(effrParsed.updates).toHaveLength(1);
    expect(effrParsed.updates[0]?.fields).toMatchObject({ TARGET_FROM: 3.5, TARGET_TO: 3.75 });
    // Without md lines there are no updates and the rows are unchanged.
    const bare = parseRefRates(sofr.raw, { ...sofr.ctx, lines: new Map() });
    expect(bare.updates).toEqual([]);
    expect(bare.rows.fixings).toHaveLength(5);
  });

  it('drops a percentile band that excludes its own rate, and keeps the rate', () => {
    const broken = {
      ...sofr.raw,
      body: Buffer.from(
        sofr.raw.body
          .toString('utf8')
          .replace('"percentPercentile1": 3.57', '"percentPercentile1": 3.99'),
      ),
    };
    const result = parseRefRates(broken, sofr.ctx);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.kind).toBe('parse_error');
    const first = result.rows.fixings[0];
    expect(first?.rate).toBe(3.62);
    expect(first?.pct1).toBeNull();
    expect(first?.pct99).toBeNull();
    expect(result.rows.fixings).toHaveLength(5);
  });

  it('never throws on a truncated, reordered or corrupted body', () => {
    for (const cut of [0, 1, 10, 200, sofr.raw.body.byteLength - 1]) {
      const broken = { ...sofr.raw, body: sofr.raw.body.subarray(0, cut) };
      const result = parseRefRates(broken, sofr.ctx);
      expect(result.problems.length).toBeGreaterThan(0);
      expect(result.rows.fixings).toEqual([]);
    }
    const unknownType = {
      ...sofr.raw,
      body: Buffer.from(
        '{"refRates":[{"type":"XYZ","effectiveDate":"2026-09-14","percentRate":1}]}',
      ),
    };
    const drifted = parseRefRates(unknownType, sofr.ctx);
    expect(drifted.rows.fixings).toEqual([]);
    expect(drifted.problems.map((p) => p.kind)).toEqual(['schema_drift', 'schema_drift']);
    expect(
      parseRefRates({ ...sofr.raw, body: Buffer.from('[]') }, sofr.ctx).problems[0]?.kind,
    ).toBe('parse_error');
  });

  it('registers under its own licence row', () => {
    const registry = registerNyFedAdapters(new ProviderRegistry());
    expect(registry.has('nyfed.rates')).toBe(true);
    expect(registry.isSchedulerOnly('nyfed.rates')).toBe(false);
    expect(nyFedRatesAdapter.sourceId).toBe('nyfed.rates');
    expect(nyFedRatesAdapter.adapterVersion).toBe('nyfed/1.0.0');
  });
});
