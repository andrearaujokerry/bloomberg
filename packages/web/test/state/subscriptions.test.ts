/**
 * packages/web/test/state/subscriptions.test.ts — API.md §6.1, CLIENT.md §8 L597-604, §9.
 *
 * The acceptance row is the field intersection: a quote subject is never asked for a bar field.
 * The case is not hypothetical and not one this test invented — `GIP`'s shipped manifest returns
 * ONE `LiveSpec` whose `subjects` are `b1m:<id>` and `q:<id>` and whose `fields` are the union of
 * the bar block and the quote block, because `LiveSpec.fields` is flat. Sent as written, that asks
 * `q:` for `IS_FINAL` and `b1m:` for `CHG_PCT_1D`, and the plant rejects the frame (BUS-02).
 *
 * So the spec under test is the real one, read from the shipped manifest against its committed
 * golden. The only thing normalised is the golden's symbolic instrument id (`<AAPL>`), which the
 * fixtures use in place of a number and which is not what this file is about.
 */
import { hasField, manifests } from '@terminal/core';
import type { LiveSpec } from '@terminal/core';
import type { Subscription } from '@terminal/sdk';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ALL_FIELDS_FAMILIES,
  SUBJECT_FAMILY_FIELDS,
  familyOf,
  planSubscription,
  selectFieldsOf,
  selectSubjects,
  useSubscriptionsStore,
} from '../../src/state/subscriptions.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(dirname(dirname(TEST_DIR))));
const GOLDEN_DIR = join(REPO_ROOT, 'fixtures', 'golden', 'functions');

function golden(name: string): unknown {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8'));
}

/**
 * `q:<AAPL>` → `q:42`: the goldens carry a symbolic id where a real payload carries a number.
 * Distinct placeholders get distinct ids, so two md lines stay two subjects.
 */
function withRealIds(spec: LiveSpec): LiveSpec {
  const ids = new Map<string, string>();
  const real = (subject: string): string =>
    subject.replace(/<[^>]+>/g, (token) => {
      const seen = ids.get(token);
      if (seen !== undefined) return seen;
      const id = String(42 + ids.size);
      ids.set(token, id);
      return id;
    });
  const subjects = spec.subjects.map(real);
  return spec.essential === undefined
    ? { ...spec, subjects }
    : { ...spec, subjects, essential: spec.essential.map(real) };
}

/** The real manifest's `LiveSpec` for a committed golden, with the fixture's ids made numeric. */
function liveSpecOf(manifest: { live: ((p: never, t: never) => LiveSpec | null) | null }, file: string): LiveSpec {
  if (manifest.live === null) throw new Error(`${file}: manifest declares no live()`);
  const spec = manifest.live(undefined as never, golden(file) as never);
  if (spec === null) throw new Error(`${file}: live() returned null`);
  return withRealIds(spec);
}

function fakeSubscription(unsubscribe: () => void): Subscription {
  const sub: Subscription = {
    id: 1,
    subjects: [],
    fields: [],
    ack: Promise.resolve({ accepted: [], rejected: [] }),
    on: () => (): void => undefined,
    unsubscribe,
  };
  return sub;
}

beforeEach(() => {
  useSubscriptionsStore.getState().reset();
});

describe('subject families', () => {
  it('names every field the dictionary knows', () => {
    // The table is API.md §6.1 transcribed. If a field is renamed in the dictionary and not here,
    // this store would ask for a field that no longer exists — silently, one subject at a time.
    for (const [family, fields] of Object.entries(SUBJECT_FAMILY_FIELDS)) {
      for (const field of fields) {
        expect(hasField(field), `${family}: ${field}`).toBe(true);
      }
    }
  });

  it('parses the subject grammar and rejects what is not one', () => {
    expect(familyOf('q:42')).toBe('q');
    expect(familyOf('b1m:42')).toBe('b1m');
    expect(familyOf('n:inst:42')).toBe('n');
    expect(familyOf('room:7')).toBe('room');
    expect(familyOf('c:UST_PAR')).toBe('c');
    expect(familyOf('nope:42')).toBeNull();
    expect(familyOf('q:<AAPL>')).toBeNull();
    expect(familyOf('42')).toBeNull();
  });
});

describe('planSubscription — the intersection (API.md §6.1)', () => {
  it("never asks a quote subject for a bar field, on GIP's own shipped LiveSpec", () => {
    const spec = liveSpecOf(manifests.GIP, 'GIP.intraday.json');
    // The spec really does mix the two field sets — if this ever stops being true the test below
    // is proving nothing.
    expect(spec.fields).toContain('IS_FINAL');
    expect(spec.fields).toContain('CHG_PCT_1D');

    const plan = planSubscription(spec);
    const bar = plan.requests.find((r) => r.family === 'b1m');
    const quote = plan.requests.find((r) => r.family === 'q');

    expect(bar?.fields).toEqual(['BAR_TS', 'PX_OPEN', 'PX_HIGH', 'PX_LOW', 'PX_LAST', 'PX_VOLUME', 'IS_FINAL']);
    expect(bar?.fields).not.toContain('CHG_PCT_1D');
    expect(quote?.fields).toEqual(['PX_OPEN', 'PX_HIGH', 'PX_LOW', 'PX_LAST', 'PX_VOLUME', 'PX_CLOSE_1D', 'CHG_NET_1D', 'CHG_PCT_1D', 'SESSION_STATE']);
    expect(quote?.fields).not.toContain('IS_FINAL');
    expect(quote?.fields).not.toContain('BAR_TS');
    expect(plan.dropped).toEqual([]);
  });

  it("carries Q's conflation and essential flags onto the right subjects", () => {
    const spec = liveSpecOf(manifests.Q, 'Q.quote.json');
    const plan = planSubscription(spec);

    // `q:` and `l:` share the quote field set but not the essential flag: the composite must never
    // be shed, the per-venue lines may be.
    const essential = plan.requests.filter((r) => r.options.essential);
    const sheddable = plan.requests.filter((r) => !r.options.essential);
    expect(essential.flatMap((r) => r.subjects)).toEqual(['q:42']);
    expect(sheddable.flatMap((r) => r.subjects)).toEqual(['l:43', 'l:44']);
    for (const request of plan.requests) expect(request.options.conflationMs).toBe(100);
  });

  it("expands '*' for the families that may not send it and keeps it for the ones that may", () => {
    const plan = planSubscription({ subjects: ['q:42', 'n:inst:42', 'sys:status'], fields: '*' });
    const quote = plan.requests.find((r) => r.family === 'q');
    expect(quote?.fields).toEqual(SUBJECT_FAMILY_FIELDS.q);
    expect(plan.requests.find((r) => r.family === 'n')?.fields).toBe('*');
    expect(plan.requests.find((r) => r.family === 'sys')?.fields).toBe('*');
    expect(ALL_FIELDS_FAMILIES.has('q')).toBe(false);
  });

  it('asks an open family for everything when the named fields are not its own', () => {
    // A screen that lists a curve beside its quotes names quote fields; the curve still wants its
    // own stream, and `f: []` is legal for `c:` (API.md §6.1 L864).
    const plan = planSubscription({ subjects: ['c:UST_PAR', 'q:42'], fields: ['PX_LAST'] });
    expect(plan.requests.find((r) => r.family === 'c')?.fields).toBe('*');
    expect(plan.requests.find((r) => r.family === 'q')?.fields).toEqual(['PX_LAST']);
  });

  it('drops what it cannot subscribe to, and says why', () => {
    const plan = planSubscription({ subjects: ['q:<AAPL>', 'b1m:42'], fields: ['PX_BID'] });
    expect(plan.requests).toEqual([]);
    expect(plan.dropped).toEqual([
      { subject: 'q:<AAPL>', reason: 'unknown-family' },
      { subject: 'b1m:42', reason: 'no-fields-in-family' },
    ]);
  });

  it('de-duplicates subjects a payload named twice', () => {
    const plan = planSubscription({ subjects: ['q:42', 'q:42', 'q:7'], fields: ['PX_LAST'] });
    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0]?.subjects).toEqual(['q:42', 'q:7']);
  });
});

describe('subscriptionsStore — bookkeeping', () => {
  const spec: LiveSpec = { subjects: ['q:42'], fields: ['PX_LAST', 'IS_FINAL'] };

  it('subscribes through the attached live client and releases the previous one per panel', () => {
    const unsubs = [vi.fn(), vi.fn()];
    const subs = unsubs.map((fn) => fakeSubscription(fn));
    let n = 0;
    const subscribe = vi.fn(() => subs[n++] ?? fakeSubscription(vi.fn()));
    useSubscriptionsStore.getState().attach({ subscribe });

    useSubscriptionsStore.getState().acquire('p1', spec);
    expect(subscribe).toHaveBeenCalledTimes(1);
    // The bar field never reached the wire.
    expect(subscribe.mock.calls[0]?.[1]).toEqual(['PX_LAST']);

    // Re-painting the same screen is not a re-subscription.
    useSubscriptionsStore.getState().acquire('p1', { ...spec });
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsubs[0]).not.toHaveBeenCalled();

    // A different screen in the same panel replaces the subscription.
    useSubscriptionsStore.getState().acquire('p1', { subjects: ['q:7'], fields: ['PX_LAST'] });
    expect(unsubs[0]).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(2);

    useSubscriptionsStore.getState().release('p1');
    expect(unsubs[1]).toHaveBeenCalledTimes(1);
    expect(useSubscriptionsStore.getState().byPanel.p1).toBeUndefined();
  });

  it('works with no live client attached — it decides what, not how', () => {
    const plan = useSubscriptionsStore.getState().acquire('p1', spec);
    expect(plan.requests[0]?.fields).toEqual(['PX_LAST']);
    expect(selectSubjects(useSubscriptionsStore.getState())).toEqual(['q:42']);
    expect(selectFieldsOf('q:42')(useSubscriptionsStore.getState())).toEqual(['PX_LAST']);
  });

  it('merges the fields two panels want for the same subject', () => {
    useSubscriptionsStore.getState().acquire('p1', { subjects: ['q:42'], fields: ['PX_LAST'] });
    useSubscriptionsStore.getState().acquire('p2', { subjects: ['q:42'], fields: ['PX_BID', 'PX_ASK'] });
    expect(selectFieldsOf('q:42')(useSubscriptionsStore.getState())).toEqual([
      'PX_LAST',
      'PX_BID',
      'PX_ASK',
    ]);
  });

  it('tracks shed subjects and pushes the effective conflation to the client', () => {
    const setConflation = vi.fn();
    useSubscriptionsStore.getState().attach({ subscribe: () => fakeSubscription(vi.fn()), setConflation });

    useSubscriptionsStore.getState().markShed('q:42', true);
    expect([...useSubscriptionsStore.getState().shed]).toEqual(['q:42']);
    useSubscriptionsStore.getState().markShed('q:42', false);
    expect(useSubscriptionsStore.getState().shed.size).toBe(0);

    useSubscriptionsStore.getState().setEffective(1_000);
    useSubscriptionsStore.getState().setEffective(1_000);
    expect(setConflation).toHaveBeenCalledTimes(1);
    expect(useSubscriptionsStore.getState().effectiveConflationMs).toBe(1_000);
  });
});
