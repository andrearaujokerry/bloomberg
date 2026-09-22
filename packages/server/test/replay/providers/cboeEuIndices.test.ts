/**
 * `cboe.euIndices` over `cboe-eu-indices` — QA-02, PROVIDERS.a §5.4.
 *
 * This is its own adapter because all three of its differences from §5.1 are traps: the top-level
 * timestamp is a bare `"16:59:53"` with no date and cannot be `provenance.source_ts`;
 * `last_trade_time` carries an explicit UTC offset instead of being naive ET, so the §5.1 reader
 * would move it five hours; and the index publishes no book, no volume and no IV, all as zeros
 * that must never reach a screen.
 */

import { describe, expect, it } from 'vitest';

import { cboeEuIndicesAdapter, cboeEuIndexUrl } from '../../../src/providers/cboe/adapter.js';
import { normaliseEuIndex, parseCboeOffsetMs } from '../../../src/providers/cboe/parse.js';
import type { RawRecord } from '../../../src/providers/types.js';
import {
  CAPTURES,
  capture,
  euContext,
  goldenOf,
  keyFor,
  readGolden,
  serialiseGolden,
  store,
} from './cboeFixtures.js';

const spec = CAPTURES.euIndices;
const raw = capture(spec.providerId, spec.url);
const result = normaliseEuIndex(raw, euContext(raw), { sourceId: 'cboe.euIndices' });

describe('cboe.euIndices — the recorded capture', () => {
  it('reads the capture through the replay store', () => {
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.body.byteLength).toBe(534);
    expect(raw.requestKey).toBe(keyFor(spec.providerId, spec.url));
    // §5.4's open question, settled by the manifest: the European endpoint is **not** under
    // `/api/global/delayed_quotes/`. Any other spelling misses the wall.
    expect(cboeEuIndexUrl('BUK100P')).toBe(
      'https://cdn.cboe.com/api/global/european_indices/index_quotes/BUK100P.json',
    );
    expect(store.entry(raw.requestKey)?.url).toBe(cboeEuIndexUrl('BUK100P'));
    expect(cboeEuIndicesAdapter.sourceId).toBe('cboe.euIndices');
    // The capture carries no `sourceTs` in the manifest: the transport could not read one from a
    // bare time, which is precisely why the normaliser has to supply it.
    expect(raw.sourceTs).toBeNull();
  });

  it('parse.ts over the capture equals the committed golden', () => {
    expect(serialiseGolden(result)).toBe(readGolden(spec.golden));
    expect(goldenOf(result)).toEqual(JSON.parse(readGolden(spec.golden)));
  });
});

describe('cboe.euIndices — §5.4 parse rules', () => {
  it('keys the md line on data.index, not on data.symbol', () => {
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]!.subject).toBe('q:401');
    expect(result.updates[0]!.mdLineId).toBe(5401);
    expect(result.rows.crossChecks[0]!.providerSymbol).toBe('BUK100P');
    // `^BUK100P-SL` is the provider's own form and is recorded as an identifier (§5.4).
    expect(result.rows.identifiers).toEqual([
      {
        entityKind: 'instrument',
        entityId: 401,
        scheme: 'PROVIDER_SYMBOL',
        value: '^BUK100P-SL',
        qualifier: 'cboe.euIndices',
        isPrimary: false,
      },
    ]);
    expect(result.rows.crossChecks[0]!.exchangeId).toBe(115);
  });

  it('takes source_ts from last_trade_time, offset honoured to the millisecond', () => {
    // "2026-09-15T15:30:04.900000+00:00" — sub-second precision truncated to ms, not rounded.
    expect(result.sourceTs?.toISOString()).toBe('2026-09-15T15:30:04.900Z');
    expect(result.updates[0]!.ts.src).toBe(Date.parse('2026-09-15T15:30:04.900Z'));
    expect(result.rows.quoteTicks[0]!.sourceTs).toBe('2026-09-15T15:30:04.900Z');
    // The offset is read, never assumed: the same wall clock at +01:00 is an hour earlier.
    expect(parseCboeOffsetMs('2026-09-15T15:30:04.900000+01:00')).toBe(
      Date.parse('2026-09-15T14:30:04.900Z'),
    );
    expect(parseCboeOffsetMs('2026-09-15T15:30:04Z')).toBe(Date.parse('2026-09-15T15:30:04Z'));
    // The §5.1 naive-ET form has no offset and is not accepted here.
    expect(parseCboeOffsetMs('2026-09-15T15:30:04')).toBeNull();
  });

  it('records the bare top-level time and reports that it disagrees', () => {
    expect(result.rows.status).toEqual({
      code: 'C',
      session: 'closed',
      payloadTime: '16:59:53',
      skewMs: 5_388_100,
    });
    // 89 minutes: far past the 5-minute limit of §5.4, so the job has a `dq_events` detail to
    // write — but the bare time is still never used as an instant.
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!.kind).toBe('schema_drift');
    expect(result.problems[0]!.path).toBe('/timestamp');
    expect(result.problems[0]!.detail).toContain('16:59:53');
  });

  it('drops the book, the volume and the IV a European index does not publish', () => {
    expect(result.updates[0]!.fields).toEqual({
      PX_LAST: 1059.4557,
      LAST_TRADE_TIME: Date.parse('2026-09-15T15:30:04.900Z'),
      PX_HIGH: 1063.1155,
      PX_LOW: 1052.4221,
      PX_CLOSE_1D: 1063.1155,
    });
    const row = result.rows.quoteTicks[0]!;
    // `open: 0` before the open, `bid/ask/sizes: 0`, `volume: 0`, `iv30: 0` — all absent.
    expect([row.open, row.bid, row.ask, row.bidSize, row.askSize, row.volume, row.iv30]).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(row.srcSeq).toBe(153_004);
    expect(row.conditions).toEqual(['delayed']);
  });

  it('publishes the official close only once the XLON session is stated closed', () => {
    const blind = normaliseEuIndex(raw, euContext(raw));
    expect(blind.updates[0]!.fields.PX_OFFICIAL_CLOSE).toBeUndefined();
    // The calendar is authoritative; `data.status 'C'` is only a hint the job cross-checks.
    const closed = normaliseEuIndex(raw, euContext(raw), { session: 'closed' });
    expect(closed.updates[0]!.fields.PX_OFFICIAL_CLOSE).toBe(1059.4557);
    expect(closed.rows.status.session).toBe('closed');
  });

  it('never throws on a corrupted payload (QA-05)', () => {
    const text = raw.body.toString('utf8');
    const mutate = (body: string): RawRecord => ({ ...raw, body: Buffer.from(body, 'utf8') });
    for (let i = 0; i <= text.length; i++) {
      const bad = normaliseEuIndex(mutate(text.slice(0, i)), euContext(raw));
      expect(Array.isArray(bad.problems)).toBe(true);
    }
    for (const body of [
      '{"timestamp":"25:99:99","data":{"index":"BUK100P","status":"X"}}',
      '{"data":{"index":"BUK100P"}}',
      '{"timestamp":"16:59:53","data":[]}',
    ]) {
      const bad = normaliseEuIndex(mutate(body), euContext(raw));
      expect(Array.isArray(bad.rows.identifiers)).toBe(true);
    }
    // An unknown status letter is reported, not guessed into a session.
    const odd = normaliseEuIndex(
      mutate('{"timestamp":"16:59:53","data":{"index":"BUK100P","status":"X","current_price":1}}'),
      euContext(raw),
    );
    expect(odd.rows.status).toMatchObject({ code: 'X', session: null });
    expect(odd.problems.some((p) => p.kind === 'schema_drift')).toBe(true);
  });
});
