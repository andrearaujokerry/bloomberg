/**
 * QA-05 — **every** `parse.ts`, plus the four shared parsers `xml/html/csv/xlsx`, must return a
 * parse-error *result* on truncated, reordered or corrupted input and must never throw
 * (WORKPLAN WP-05 acceptance table; PROVIDERS.a §1.2).
 *
 * ## Why this file and not the per-adapter suites
 *
 * Seven of the twenty-nine adapters fuzzed themselves inside their own replay test. That covers
 * the seven somebody remembered, on the day they remembered. This file takes the coverage from
 * the two artefacts that already have to be complete — the provider **registry** and the fixture
 * **manifest** — so a new adapter is fuzzed the day its capture lands rather than the day someone
 * adds a test for it. {@link ADAPTERS} is the registry's input, and the first `it` below fails if
 * the manifest names a provider the registry does not hold.
 *
 * ## What "never throws" buys
 *
 * A pure parser that throws takes the ingest worker's run down with a stack instead of writing a
 * `dq_events kind='parse_error'`, and the screen shows yesterday's number with no explanation. So
 * the assertion is threefold: the call returns, `updates` and `problems` are arrays, and `rows`
 * survives `JSON.stringify` (a parser that returns a cyclic or `BigInt`-bearing object fails at
 * the golden, not here, which is far too late).
 *
 * And one more, which is the reason this file exists at all: **a parse that yields nothing must
 * say why.** An adapter that returns zero rows and zero problems from a corrupted body reads
 * downstream as "the source published nothing today" — no `dq_events` row, no stale flag, an
 * empty screen that looks like real data. `fred.calendar` did exactly that on 14 of 27 corrupted
 * bodies before this file was written. {@link SILENT_EMPTY_ALLOWED} lists the two sources for
 * which an empty-but-quiet parse is a truthful answer, and every other adapter must speak up.
 */

import { describe, expect, it } from 'vitest';

import { bbgRssAdapter } from '../../../src/providers/bbgRss/adapter.js';
import { blsScheduleAdapter, blsTimeseriesAdapter } from '../../../src/providers/bls/adapter.js';
import {
  cboeEuIndicesAdapter,
  cboeOptionsAdapter,
  cboeQuotesAdapter,
  cboeSymbolBookAdapter,
} from '../../../src/providers/cboe/adapter.js';
import { coingeckoAdapter } from '../../../src/providers/coingecko/adapter.js';
import { parseCsv, parseCsvTable } from '../../../src/providers/csv.js';
import { fedH15Adapter } from '../../../src/providers/fedH15/adapter.js';
import { fedRssAdapter } from '../../../src/providers/fedRss/adapter.js';
import { finraShortInterestAdapter } from '../../../src/providers/finra/adapter.js';
import { frankfurterAdapter } from '../../../src/providers/frankfurter/adapter.js';
import { fredCalendarAdapter, fredCsvAdapter } from '../../../src/providers/fred/adapter.js';
import { anchors, documentTitle, extractTables, metaContent } from '../../../src/providers/html.js';
import { imfAdapter } from '../../../src/providers/imf/adapter.js';
import { nyFedRatesAdapter } from '../../../src/providers/nyfed/adapter.js';
import { openFigiAdapter } from '../../../src/providers/openfigi/adapter.js';
import { createProviderRegistry } from '../../../src/providers/registry.js';
import { openReplayStore } from '../../../src/providers/replayStore.js';
import {
  secArchivesAdapter,
  secAtomAdapter,
  secCompanyFactsAdapter,
  secFramesAdapter,
  secSubmissionsAdapter,
  secTickersAdapter,
} from '../../../src/providers/sec/adapter.js';
import { ssgaHoldingsAdapter } from '../../../src/providers/ssga/adapter.js';
import { readXlsx } from '../../../src/providers/ssga/xlsx.js';
import {
  treasuryBillsAdapter,
  treasuryYieldCurveAdapter,
} from '../../../src/providers/treasury/adapter.js';
import { isProviderId } from '../../../src/providers/types.js';
import { worldBankAdapter } from '../../../src/providers/worldbank/adapter.js';
import { yahooChartAdapter, yahooSearchAdapter } from '../../../src/providers/yahoo/adapter.js';
import { parseXmlBuffer } from '../../../src/providers/xml.js';
import { corruptions, replayContext } from '../../replay/providers/golden.js';

import type { AnyProviderAdapter, ProviderId, RawRecord } from '../../../src/providers/types.js';

/**
 * Every adapter in the system. The registry built from it is compared against the manifest below,
 * so a new adapter that ships with a capture and is not added here fails this suite by name.
 */
const ADAPTERS: readonly AnyProviderAdapter[] = [
  cboeQuotesAdapter,
  cboeOptionsAdapter,
  cboeSymbolBookAdapter,
  cboeEuIndicesAdapter,
  yahooChartAdapter,
  yahooSearchAdapter,
  openFigiAdapter,
  secTickersAdapter,
  secSubmissionsAdapter,
  secCompanyFactsAdapter,
  secFramesAdapter,
  secAtomAdapter,
  secArchivesAdapter,
  fredCsvAdapter,
  fredCalendarAdapter,
  nyFedRatesAdapter,
  fedH15Adapter,
  fedRssAdapter,
  treasuryYieldCurveAdapter,
  treasuryBillsAdapter,
  blsTimeseriesAdapter,
  blsScheduleAdapter,
  worldBankAdapter,
  imfAdapter,
  frankfurterAdapter,
  finraShortInterestAdapter,
  bbgRssAdapter,
  coingeckoAdapter,
  ssgaHoldingsAdapter,
];

const registry = createProviderRegistry(ADAPTERS);
const store = openReplayStore();

/**
 * Sources for which "zero rows, zero problems" is a truthful answer to a broken body, because the
 * payload they parse legitimately carries nothing at all:
 *
 *  - `openfigi.mapping` answers a *batch*; an empty array is OpenFIGI saying "no match", and the
 *    unmatched jobs are the caller's `exceptions` rows, not a parse problem;
 *  - `yahoo.search` returns an empty `quotes` array for a query nothing matches.
 *
 * Nothing else may be silent. This list is deliberately short and deliberately argued.
 */
const SILENT_EMPTY_ALLOWED: ReadonlySet<ProviderId> = new Set<ProviderId>([
  'openfigi.mapping',
  'yahoo.search',
]);

/** Every recorded exchange, grouped by the adapter that owns it. */
function capturesByProvider(): Map<ProviderId, RawRecord[]> {
  const out = new Map<ProviderId, RawRecord[]>();
  for (const [key, entry] of Object.entries(store.manifest)) {
    if (!isProviderId(entry.providerId)) continue;
    for (let index = 0; index < entry.captures.length; index += 1) {
      const raw = store.lookup(key, index);
      if (raw === null) continue;
      const list = out.get(entry.providerId);
      if (list === undefined) out.set(entry.providerId, [raw]);
      else list.push(raw);
    }
  }
  return out;
}

const captures = capturesByProvider();

/** Rows that carry nothing at all — the shape a silent failure takes. */
function isEmptyRows(rows: unknown): boolean {
  if (rows === null || rows === undefined) return true;
  if (Array.isArray(rows)) return rows.length === 0;
  if (typeof rows !== 'object') return false;
  const arrays = Object.values(rows).filter((value): value is unknown[] => Array.isArray(value));
  return arrays.length > 0 && arrays.every((value) => value.length === 0);
}

describe('QA-05 — the fuzz target is the registry, not a hand-kept list', () => {
  it('holds an adapter for every provider the fixture manifest records', () => {
    const recorded = [...captures.keys()].sort();
    const missing = recorded.filter((id) => !registry.has(id));
    expect(missing).toEqual([]);
    // 29 of the 30 declared ids have an adapter and a capture; `fed.fomc` has neither yet.
    expect(registry.size).toBe(29);
    expect(registry.missing()).toEqual(['fed.fomc']);
    expect(recorded).toHaveLength(29);
  });
});

describe.each(registry.all().map((adapter) => [adapter.id, adapter] as const))(
  'QA-05 %s',
  (id, adapter) => {
    const recorded = captures.get(id) ?? [];

    it('has at least one recorded capture to corrupt', () => {
      expect(recorded.length).toBeGreaterThan(0);
    });

    it('never throws on a truncated, reordered or corrupted body', () => {
      for (const raw of recorded) {
        for (const body of corruptions(raw.body, 4)) {
          const out = adapter.normalise({ ...raw, body }, replayContext(raw));
          expect(Array.isArray(out.updates)).toBe(true);
          expect(Array.isArray(out.problems)).toBe(true);
          expect(() => JSON.stringify(out.rows)).not.toThrow();
        }
      }
    });

    it('never fails silently: an empty parse carries a problem', () => {
      if (SILENT_EMPTY_ALLOWED.has(id)) return;
      for (const raw of recorded) {
        for (const body of corruptions(raw.body, 4)) {
          const out = adapter.normalise({ ...raw, body }, replayContext(raw));
          if (out.updates.length > 0 || !isEmptyRows(out.rows)) continue;
          expect(
            out.problems.length,
            `${id} returned no rows and no problems for a corrupted body of ` +
              `${String(raw.body.length)} bytes — downstream that reads as "the source published ` +
              'nothing", which raises no dq_events and shows an empty screen as real data',
          ).toBeGreaterThan(0);
        }
      }
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The four shared parsers, fuzzed directly: every adapter above is built on one of them.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One representative capture per shared parser, by the format it is in. */
const SHARED_BODIES: readonly { name: string; body: Buffer }[] = [
  ...[...captures.values()].flatMap((list) => (list[0] === undefined ? [] : [list[0]])),
].map((raw) => ({ name: raw.providerId, body: raw.body }));

describe('QA-05 — xml/html/csv/xlsx never throw', () => {
  it('parseXmlBuffer returns a result for every corrupted body', () => {
    for (const { body } of SHARED_BODIES) {
      for (const corrupted of corruptions(body, 2)) {
        const out = parseXmlBuffer(corrupted);
        expect(typeof out.ok).toBe('boolean');
      }
    }
  });

  it('the html scanner returns for every corrupted body', () => {
    for (const { body } of SHARED_BODIES) {
      for (const corrupted of corruptions(body, 2)) {
        const text = corrupted.toString('utf8');
        expect(() => extractTables(text)).not.toThrow();
        expect(() => anchors(text)).not.toThrow();
        expect(() => documentTitle(text)).not.toThrow();
        expect(() => metaContent(text, 'description')).not.toThrow();
      }
    }
  });

  it('parseCsv and parseCsvTable return a result for every corrupted body', () => {
    for (const { body } of SHARED_BODIES) {
      for (const corrupted of corruptions(body, 2)) {
        const text = corrupted.toString('utf8');
        expect(typeof parseCsv(text).ok).toBe('boolean');
        expect(typeof parseCsvTable(text).ok).toBe('boolean');
      }
    }
  });

  it('readXlsx returns a failure rather than throwing on a broken zip', () => {
    const xlsx = captures.get('ssga.holdings')?.[0];
    expect(xlsx).toBeDefined();
    for (const corrupted of corruptions(xlsx!.body, 8)) {
      const out = readXlsx(corrupted);
      expect(typeof out.ok).toBe('boolean');
      if (!out.ok) expect(typeof out.problem.detail).toBe('string');
    }
  });
});
