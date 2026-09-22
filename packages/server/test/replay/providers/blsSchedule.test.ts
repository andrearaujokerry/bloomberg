/**
 * QA-02 — `bls.schedule` over `bls-schedule.html`. WORKPLAN WP-05, PROVIDERS.b §10.6.
 *
 * This is the source that upgrades FRED's 08:30 default to a known release time, so the assertions
 * that matter most are about *time*: every event is Eastern converted to UTC with the US federal
 * DST rule, and `time_known` is true on all of them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BLS_ADAPTER_VERSION,
  blsScheduleAdapter,
  blsScheduleUrl,
} from '../../../src/providers/bls/adapter.js';
import {
  easternWallToUtcMs,
  isEasternDaylight,
  normaliseBlsSchedule,
  parseBlsSchedule,
  parseEasternClock,
  parseScheduleTitle,
} from '../../../src/providers/bls/parse.js';
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

const url = blsScheduleUrl(2026, 9);
const raw = store.replay({ providerId: 'bls.schedule', url });

describe('bls.schedule replay (§10.6)', () => {
  it('the adapter URL derives the recorded request key', () => {
    expect(url).toBe('https://www.bls.gov/schedule/news_release/september26.htm');
    expect(store.has(requestKey('bls.schedule', 'GET', url))).toBe(true);
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.body.length).toBe(57_216);
  });

  it('parse.ts equals the committed golden, byte for byte', () => {
    expect(serialise(normaliseBlsSchedule(raw, ctxOf(raw)))).toBe(goldenText('bls-schedule.html.json'));
  });

  it('measures what the capture actually contains', () => {
    const out = normaliseBlsSchedule(raw, ctxOf(raw));
    expect(out.rows.title).toBe('Schedule of Selected Releases for September 2026');
    expect(out.rows.year).toBe(2026);
    expect(out.rows.month).toBe(9);

    // 16 scheduled releases across 13 distinct release ids. The Labor Day holiday cell carries no
    // time and is not a release; the October 2 cell is `other-month` and keeps its own month.
    expect(out.rows.events).toHaveLength(16);
    expect(out.rows.releases).toHaveLength(13);
    expect(out.rows.releases.map((r) => r.providerReleaseId)).toEqual([
      'cpi',
      'ecec',
      'employeeBenefitsInTheUnitedStates',
      'employeeTenure',
      'empsit',
      'jobFlexibilitiesAndWorkSchedules',
      'jolts',
      'laus',
      'metro',
      'ppi',
      'prod2',
      'realer',
      'ximpim',
    ]);
    expect(out.rows.releases.find((r) => r.providerReleaseId === 'cpi')).toEqual({
      providerReleaseId: 'cpi',
      name: 'Consumer Price Index',
      country: 'US',
      url: 'https://www.bls.gov/schedule/news_release/cpi.htm',
    });

    // Ten of the thirteen are named in the page's own release index and carry its URL; three
    // (Employee Tenure, Job Flexibilities, Employee Benefits) are not, and say so as problems
    // rather than inventing a slug silently.
    expect(out.rows.releases.filter((r) => r.url === null)).toHaveLength(3);
    expect(out.problems).toHaveLength(3);
    expect(out.problems.every((p) => p.kind === 'field_dropped')).toBe(true);

    // Every event: time known, status scheduled, ET → UTC in September (EDT, UTC-4).
    expect(out.rows.events.every((e) => e.timeKnown)).toBe(true);
    expect(out.rows.events.every((e) => e.status === 'scheduled')).toBe(true);
    expect(out.rows.events.every((e) => e.periodLabel !== '')).toBe(true);
    expect(new Set(out.rows.events.map((e) => e.localTime))).toEqual(new Set(['08:30', '10:00']));
    expect(out.rows.events.filter((e) => e.localTime === '08:30')).toHaveLength(7);
    expect(out.rows.events.filter((e) => e.localTime === '10:00')).toHaveLength(9);

    const cpi = out.rows.events.find((e) => e.providerReleaseId === 'cpi');
    expect(cpi).toEqual({
      providerReleaseId: 'cpi',
      name: 'Consumer Price Index',
      scheduledAt: '2026-09-11T12:30:00Z',
      timeKnown: true,
      periodLabel: 'August 2026',
      status: 'scheduled',
      localDate: '2026-09-11',
      localTime: '08:30',
    });

    // The last row is the October cell, filed under October and not under September.
    expect(out.rows.events.at(-1)).toMatchObject({
      providerReleaseId: 'empsit',
      localDate: '2026-10-02',
      scheduledAt: '2026-10-02T12:30:00Z',
    });
    // Events are in ascending scheduled order, which is what ECO renders.
    expect(out.rows.events.map((e) => e.scheduledAt)).toEqual(
      [...out.rows.events.map((e) => e.scheduledAt)].sort(),
    );
  });

  it('converts Eastern wall time on both sides of the DST boundary', () => {
    // 2026: DST runs 8 March to 1 November.
    expect(isEasternDaylight(2026, 1, 15, 8, 30)).toBe(false);
    expect(isEasternDaylight(2026, 7, 15, 8, 30)).toBe(true);
    expect(isEasternDaylight(2026, 3, 8, 1, 59)).toBe(false);
    expect(isEasternDaylight(2026, 3, 8, 3, 0)).toBe(true);
    expect(isEasternDaylight(2026, 11, 1, 1, 59)).toBe(true);
    expect(isEasternDaylight(2026, 11, 1, 3, 0)).toBe(false);

    // A January 08:30 release is 13:30 UTC; a July one is 12:30 UTC. Same wall clock, different
    // instant — which is the whole reason the conversion is not a constant.
    expect(new Date(easternWallToUtcMs(2026, 1, 13, 8, 30)).toISOString()).toBe(
      '2026-01-13T13:30:00.000Z',
    );
    expect(new Date(easternWallToUtcMs(2026, 7, 14, 8, 30)).toISOString()).toBe(
      '2026-07-14T12:30:00.000Z',
    );
  });

  it('reads the clock and the title the way the page writes them', () => {
    expect(parseEasternClock('08:30 AM')).toEqual({ hour: 8, minute: 30 });
    expect(parseEasternClock('10:00 AM')).toEqual({ hour: 10, minute: 0 });
    expect(parseEasternClock('12:00 PM')).toEqual({ hour: 12, minute: 0 });
    expect(parseEasternClock('12:15 AM')).toEqual({ hour: 0, minute: 15 });
    expect(parseEasternClock('Holiday')).toBeNull();
    expect(parseScheduleTitle('Schedule of Selected Releases for September 2026')).toEqual({
      year: 2026,
      month: 9,
    });
    expect(parseScheduleTitle('404 Not Found')).toBeNull();
  });

  it('fails closed when the page is for a different month', () => {
    const { rows, problems } = parseBlsSchedule(raw.body, { year: 2026, month: 10 });
    expect(rows.events).toHaveLength(0);
    expect(rows.releases).toHaveLength(0);
    expect(problems[0]?.kind).toBe('schema_drift');
    expect(problems[0]?.detail).toContain('2026-10 was requested');
  });

  it('fails closed when too few rows parse', () => {
    const html =
      '<html><head><title>Schedule of Selected Releases for September 2026</title></head>' +
      '<body><table><tr><td id="d0901"><p class="day">1</p>' +
      '<p><strong>Only Release<br></strong>July 2026<br>10:00 AM</p></td></tr></table></body></html>';
    const { rows, problems } = parseBlsSchedule(html);
    expect(rows.events).toHaveLength(0);
    expect(problems.some((p) => p.kind === 'schema_drift' && p.detail.includes('fewer'))).toBe(
      true,
    );
  });

  it('registers under its licensed source id', () => {
    const registry = createProviderRegistry([blsScheduleAdapter]);
    expect(registry.ids()).toEqual(['bls.schedule']);
    expect(blsScheduleAdapter.adapterVersion).toBe(BLS_ADAPTER_VERSION);
  });

  it('never throws on truncated or corrupted input (QA-05 smoke)', () => {
    const text = raw.body.toString('utf8');
    for (const candidate of [
      '',
      '<html>',
      '<td id="d9999">',
      text.slice(0, 20_000),
      text.slice(1_000),
    ]) {
      expect(() => parseBlsSchedule(candidate)).not.toThrow();
    }
  });
});
