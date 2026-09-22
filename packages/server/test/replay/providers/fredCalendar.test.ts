/**
 * `fred.calendar` — QA-02 over **both** recorded pages of this source:
 * `raw/fred-cal` → `fixtures/providers/normalised/fred-cal.json` (the ECO calendar) and
 * `raw/fred-releases.html` → `fred-releases.html.json` (the release catalogue), byte for byte.
 *
 * Measured from the captures:
 *
 *  - the calendar page advertises **34 economic release dates** in its own `<meta name="description">`
 *    and **34 rows are parsed**, every one of them carrying an `rid`. The equality of those two
 *    numbers is the only contract these pages have, and the parse fails closed when it breaks:
 *    the mutation test below changes the advertised count and gets **no rows at all**, which is
 *    what keeps ECO from ever showing a partially parsed day;
 *  - **14 of the 34 events carry a published time and 20 do not.** PROVIDERS §10.2 says FRED
 *    publishes no time of day and pins everything at 08:30 ET with `time_known = false`; the
 *    recorded page *does* publish times (`1:00 am` … `7:00 pm`), printed once per time group and
 *    blank on the rows that share it. The parser reads them, inherits down the group, and falls
 *    back to the specified 08:30 ET for the `N/A` group. Both behaviours are pinned here;
 *  - Eastern time is converted with the US federal DST rule, not with the machine's zone:
 *    2026-09-15 is EDT, so `1:00 am ET` is `05:00Z` and the 08:30 ET default is `12:30Z`;
 *  - the catalogue page is **paged** — `Releases 1 - 50 of 332` — so the invariant checked there
 *    is the pager's own slice: 50 rows between row 1 and row 50, and `332` recorded as the size of
 *    the whole catalogue for the job that walks `pageID=2…7`.
 */

import { describe, expect, it } from 'vitest';

import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import {
  FRED_CALENDAR_URL,
  FRED_RELEASES_URL,
  fredCalendarAdapter,
  fredCatalogueUrl,
  isCalendarPage,
  registerFredAdapters,
} from '../../../src/providers/fred/adapter.js';
import {
  NO_CONSENSUS_REASON,
  advertisedRowCount,
  easternInstant,
  easternOffset,
  normaliseCalendar,
  parseCalendarTime,
  parseReleaseCatalogue,
  ridOf,
} from '../../../src/providers/fred/parse.js';
import { readGolden, serialiseGolden, toGolden } from './golden.js';
import type { NormaliseContext } from '../../../src/providers/types.js';

const store = openReplayStore();

const calendarRaw = store.replay({ providerId: 'fred.calendar', url: FRED_CALENDAR_URL });
const catalogueRaw = store.replay({ providerId: 'fred.calendar', url: FRED_RELEASES_URL });

const ctx: NormaliseContext = {
  provenanceId: 1,
  capturedAt: calendarRaw.capturedAt,
  lines: new Map(),
};

const calendar = normaliseCalendar(calendarRaw, ctx);
const catalogue = parseReleaseCatalogue(catalogueRaw, {
  ...ctx,
  capturedAt: catalogueRaw.capturedAt,
});

describe('fred.calendar replay — the ECO calendar', () => {
  it('reads the recorded capture, never a socket', () => {
    expect(calendarRaw.origin).toBe('replay');
    expect(calendarRaw.providerId).toBe('fred.calendar');
    expect(calendarRaw.status).toBe(200);
    expect(calendarRaw.requestKey).toBe(requestKey('fred.calendar', 'GET', FRED_CALENDAR_URL));
    expect(calendarRaw.sha256).toBe(
      '1633727eca1121a1d270a09bdf3843e11c2cee120d4d759cfad4982891ef9bc2',
    );
    expect(calendarRaw.body.byteLength).toBe(76_534);
    expect(isCalendarPage(calendarRaw.url)).toBe(true);
  });

  it('matches the committed golden exactly', () => {
    const golden = serialiseGolden(
      toGolden(
        'fred-cal',
        fredCalendarAdapter.id,
        calendarRaw.requestKey,
        fredCalendarAdapter.adapterVersion,
        calendar,
      ),
    );
    expect(golden).toBe(readGolden('fred-cal.json'));
  });

  it('parses exactly the 34 rows the page advertises', () => {
    expect(calendar.problems).toEqual([]);
    expect(calendar.rows.advertisedCount).toBe(34);
    expect(calendar.rows.parsedCount).toBe(34);
    expect(calendar.rows.events).toHaveLength(34);
    expect(calendar.rows.releases).toHaveLength(34);
    expect(advertisedRowCount(calendarRaw.body.toString('utf8'))).toBe(34);
    expect(new Set(calendar.rows.releases.map((r) => r.providerReleaseId)).size).toBe(34);
    expect(calendar.rows.releases[0]).toEqual({
      sourceId: 'fred.calendar',
      providerReleaseId: '502',
      name: 'Euro Short Term Rate',
      country: 'US',
      url: 'https://fred.stlouisfed.org/release?rid=502',
      importance: 2,
    });
  });

  it('reads the published time, inherits it down the group, and falls back to 08:30 ET', () => {
    const byRid = new Map(calendar.rows.events.map((e) => [e.providerReleaseId, e]));
    // Printed times.
    expect(byRid.get('502')).toMatchObject({
      scheduledAt: '2026-09-15T05:00:00.000Z',
      timeKnown: true,
    });
    expect(byRid.get('483')).toMatchObject({
      scheduledAt: '2026-09-15T11:00:00.000Z',
      timeKnown: true,
    });
    // Blank time cell: inherited from the 7:00 am row above it, not defaulted.
    expect(byRid.get('445')).toMatchObject({
      scheduledAt: '2026-09-15T11:00:00.000Z',
      timeKnown: true,
    });
    expect(byRid.get('441')).toMatchObject({
      scheduledAt: '2026-09-15T23:00:00.000Z',
      timeKnown: true,
    });
    // 'N/A' and everything inheriting from it: the §10.2 default, 08:30 ET.
    expect(byRid.get('476')).toMatchObject({
      scheduledAt: '2026-09-15T12:30:00.000Z',
      timeKnown: false,
    });
    expect(byRid.get('101')).toMatchObject({
      scheduledAt: '2026-09-15T12:30:00.000Z',
      timeKnown: false,
    });
    expect(calendar.rows.events.filter((e) => e.timeKnown)).toHaveLength(14);
    expect(calendar.rows.events.filter((e) => !e.timeKnown)).toHaveLength(20);
    for (const event of calendar.rows.events) {
      expect(event.status).toBe('scheduled');
      expect(event.consensus).toBeNull();
      expect(event.consensusUnavailableReason).toBe(NO_CONSENSUS_REASON);
      expect(event.periodLabel).toBe('');
      expect(event.scheduledAt.startsWith('2026-09-15T')).toBe(true);
    }
  });

  it('converts Eastern time by rule, not by the machine zone', () => {
    expect(easternOffset('2026-09-15')).toBe('-04:00');
    expect(easternOffset('2026-01-15')).toBe('-05:00');
    // 2026: DST runs 8 March – 1 November.
    expect(easternOffset('2026-03-07')).toBe('-05:00');
    expect(easternOffset('2026-03-08')).toBe('-04:00');
    expect(easternOffset('2026-10-31')).toBe('-04:00');
    expect(easternOffset('2026-11-01')).toBe('-05:00');
    expect(easternInstant('2026-09-15', '08:30')).toBe('2026-09-15T12:30:00.000Z');
    expect(easternInstant('2026-01-15', '08:30')).toBe('2026-01-15T13:30:00.000Z');
    expect(parseCalendarTime('12:00 am')).toBe('00:00');
    expect(parseCalendarTime('12:00 pm')).toBe('12:00');
    expect(parseCalendarTime('3:15 pm')).toBe('15:15');
    expect(parseCalendarTime('N/A')).toBeNull();
    expect(ridOf('/release?rid=10')).toBe('10');
    expect(ridOf('/releases/calendar')).toBeNull();
  });

  it('fails closed when the advertised count and the parsed count disagree', () => {
    const drifted = {
      ...calendarRaw,
      body: Buffer.from(
        calendarRaw.body
          .toString('utf8')
          .replace('34 economic release dates', '35 economic release dates'),
      ),
    };
    const result = normaliseCalendar(drifted, ctx);
    expect(result.rows.releases).toEqual([]);
    expect(result.rows.events).toEqual([]);
    expect(result.rows.advertisedCount).toBe(35);
    expect(result.rows.parsedCount).toBe(34);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.kind).toBe('parse_error');
    expect(result.problems[0]?.detail).toMatch(/advertises 35 .* and 34 were parsed/);

    // No description at all is the same verdict: the count cannot be verified.
    const stripped = {
      ...calendarRaw,
      body: Buffer.from(
        calendarRaw.body.toString('utf8').replace('name="description"', 'name="not-description"'),
      ),
    };
    const blind = normaliseCalendar(stripped, ctx);
    expect(blind.rows.events).toEqual([]);
    expect(blind.problems[0]?.detail).toMatch(/carries no <meta name="description"/);
  });

  it('never throws on a truncated or corrupted page', () => {
    for (const cut of [0, 1, 1_000, 40_000, calendarRaw.body.byteLength - 1]) {
      const broken = { ...calendarRaw, body: calendarRaw.body.subarray(0, cut) };
      expect(() => normaliseCalendar(broken, ctx)).not.toThrow();
    }
  });
});

describe('fred.calendar replay — the release catalogue', () => {
  it('reads the recorded capture, never a socket', () => {
    expect(catalogueRaw.origin).toBe('replay');
    expect(catalogueRaw.status).toBe(200);
    expect(catalogueRaw.requestKey).toBe(requestKey('fred.calendar', 'GET', FRED_RELEASES_URL));
    expect(catalogueRaw.sha256).toBe(
      '12e6f7e509d1ab5593da840f2697e1d202c350ef59e29994069ae83eeac382c7',
    );
    expect(catalogueRaw.body.byteLength).toBe(45_467);
    expect(isCalendarPage(catalogueRaw.url)).toBe(false);
    expect(fredCatalogueUrl()).toBe(FRED_RELEASES_URL);
    expect(fredCatalogueUrl(2)).toBe(`${FRED_RELEASES_URL}?pageID=2`);
  });

  it('matches the committed golden exactly', () => {
    const golden = serialiseGolden(
      toGolden(
        'fred-releases.html',
        fredCalendarAdapter.id,
        catalogueRaw.requestKey,
        fredCalendarAdapter.adapterVersion,
        catalogue,
      ),
    );
    expect(golden).toBe(readGolden('fred-releases.html.json'));
  });

  it('parses page 1 of 7: 50 of the 332 releases', () => {
    expect(catalogue.problems).toEqual([]);
    expect(catalogue.rows.advertisedTotal).toBe(332);
    expect(catalogue.rows.pageFirst).toBe(1);
    expect(catalogue.rows.pageLast).toBe(50);
    expect(catalogue.rows.releases).toHaveLength(50);
    expect(new Set(catalogue.rows.releases.map((r) => r.providerReleaseId)).size).toBe(50);
    expect(catalogue.rows.releases[0]).toEqual({
      sourceId: 'fred.calendar',
      providerReleaseId: '489',
      name: 'AD&Co US Mortgage High Yield Index',
      country: 'US',
      url: 'https://fred.stlouisfed.org/release?rid=489',
      importance: 2,
    });
    // Entities are decoded by the tokeniser: `AD&amp;Co` is `AD&Co`, never `AD&amp;Co`.
    expect(catalogue.rows.releases[0]?.name).not.toContain('&amp;');
  });

  it('fails closed when the pager and the row count disagree', () => {
    const drifted = {
      ...catalogueRaw,
      body: Buffer.from(
        catalogueRaw.body
          .toString('utf8')
          .replace('Releases 1 - 50 of 332', 'Releases 1 - 51 of 332'),
      ),
    };
    const result = parseReleaseCatalogue(drifted, ctx);
    expect(result.rows.releases).toEqual([]);
    expect(result.problems[0]?.kind).toBe('parse_error');
    expect(result.problems[0]?.detail).toMatch(/releases 1–51 \(51 rows\) and 50 were parsed/);
  });

  it('the adapter routes each page to its own parser', () => {
    const registry = registerFredAdapters(new ProviderRegistry());
    expect(registry.has('fred.calendar')).toBe(true);
    expect(fredCalendarAdapter.sourceId).toBe('fred.calendar');
    expect(fredCalendarAdapter.adapterVersion).toBe('fred/1.0.0');
    const asCalendar = fredCalendarAdapter.normalise(calendarRaw, ctx);
    expect('advertisedCount' in asCalendar.rows).toBe(true);
    const asCatalogue = fredCalendarAdapter.normalise(catalogueRaw, ctx);
    expect('advertisedTotal' in asCatalogue.rows).toBe(true);
  });
});
