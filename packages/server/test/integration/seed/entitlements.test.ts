/**
 * The ENTL-05 seat, against the REAL evaluator and the grants seed module 12 wrote.
 *
 * `fixtures/seed/entitlements.json` carries a `note` on every grant, and the note is not a comment
 * in a source file — it is a VALUE, written into `entitlement_grants.note` and therefore the
 * documentation of record for the seat. The `eod@demo` note used to describe behaviour the evaluator
 * does not have: it said intraday fields "come back null with reason TIER_EOD while
 * PX_OFFICIAL_CLOSE and the other end-of-day fields populate", and that export fails "rule 2/rule
 * 4". Driven over the seeded grants, the evaluator says something else on both counts, and this file
 * is the thing that keeps the note and the evaluator from drifting apart again.
 *
 * What it actually does, which is what is asserted below:
 *
 *  - **`maxTier: 'eod'` is a property of the GRANT, not of the field.** Every price field of
 *    `cboe.quotes` comes back `downgrade` / `NOT_ENTITLED_TIER` with `effectiveTier: 'eod'` when a
 *    screen asks for `realtime` or `delayed` — `PX_OFFICIAL_CLOSE` and `PX_CLOSE_1D` exactly like
 *    `PX_BID`. Nothing is singled out and nothing comes back `null`. A request that asks for the
 *    tier the seat HAS (`tier: 'eod'`) comes back `allow` / `OK`, which is the distinction the note
 *    was reaching for and got in the wrong place.
 *  - **`TIER_EOD` is the plant gate's code, not the evaluator's.** It is a real `ReasonCode` and it
 *    is emitted downstream, when the plant blanks the intraday cells of a read the evaluator has
 *    already downgraded. Attributing it to the evaluator sends the next reader to the wrong stage.
 *  - **Export is refused by rule 5, `NO_USER_ENTITLEMENT`.** The `demo` firm grant does permit
 *    export; it is this user's grant that does not, so `bestGrantTier` finds no applicable USER
 *    grant and rule 5 fires before the tier is ever considered. Rules 2 and 4 both pass.
 *
 * The grants are read from the database rather than from the fixture, and the evaluator is the
 * shipped one over the shipped `licence_registry` and `field_licence`, so a change to the terms,
 * to the grant rows or to the rule order fails here. No `log` is passed: rule 9's `access_log` write
 * is a different requirement with its own test (`integration/entitlements/evaluator.int.test.ts`),
 * and leaving it out keeps this file about the decision.
 *
 * This file runs in the `server-seed` project, against the seeded database (see the `server-seed`
 * comment in `vitest.config.ts`). It writes nothing.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { getConfig } from '../../../src/config.js';
import { evaluator } from '../../../src/entitlements/evaluator.js';
import { licenceRegistry } from '../../../src/entitlements/licenceRegistry.js';
import { seedUsers } from '../../../src/seed/users.js';
import { frozenClock, TEST_NOW } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';

import type { EntitlementRequest, FieldId, Tier, UsageType } from '@terminal/core';
import type { TestDb } from '../../../src/test/db.js';

/** The seat under test, by the email `fixtures/seed/users.json` gives it. */
const SEAT_EMAIL = 'eod@demo.terminal';

/**
 * The two fields the note singles out, plus a plainly intraday one for contrast.
 *
 * `PX_OFFICIAL_CLOSE` and `PX_CLOSE_1D` are the ones the old note claimed "populate", and `PX_BID`
 * is the one it claimed comes back null; the whole point is that the evaluator treats all three
 * identically, so all three are asserted rather than a representative.
 */
const PRICE_FIELDS = ['PX_LAST', 'PX_OFFICIAL_CLOSE', 'PX_CLOSE_1D', 'PX_BID'] as const;

async function seat(t: TestDb): Promise<{ userId: number; firmId: number }> {
  const res = await t.client.query<{ user_id: string; firm_id: string }>(
    `SELECT user_id::text, firm_id::text FROM users WHERE email = $1`,
    [SEAT_EMAIL],
  );
  const row = res.rows[0];
  if (row === undefined) {
    throw new Error(
      `seed module 12 wrote no user ${SEAT_EMAIL}; every assertion below would fail for that one ` +
        'reason rather than for its own. Run `npm run db:seed`.',
    );
  }
  return { userId: Number(row.user_id), firmId: Number(row.firm_id) };
}

function request(
  who: { userId: number; firmId: number },
  over: { tier: Tier; usage: UsageType },
): EntitlementRequest {
  return {
    userId: who.userId,
    firmId: who.firmId,
    sessionId: randomUUID(),
    instrumentId: null,
    assetClass: 'equity',
    fieldIds: [...PRICE_FIELDS] as FieldId[],
    tier: over.tier,
    usage: over.usage,
    purpose: 'DES',
    traceId: randomUUID(),
  };
}

describe('seed module 12 — the ENTL-05 seat behaves the way its own note says', () => {
  const t = withTxDb();

  async function decide(over: { tier: Tier; usage: UsageType }) {
    const who = await seat(t);
    const clock = frozenClock(TEST_NOW);
    const registry = licenceRegistry({ db: t.db, clock });
    await registry.reload();
    return evaluator({ db: t.db, clock, registry }).evaluate(request(who, over));
  }

  it('has the grant the note describes: eod tier, display only', async () => {
    const who = await seat(t);
    const res = await t.client.query<{
      max_tier: string;
      usage_display: boolean;
      usage_export: boolean;
      usage_api: boolean;
    }>(
      `SELECT max_tier, usage_display, usage_export, usage_api
         FROM entitlement_grants
        WHERE subject_kind = 'user' AND subject_id = $1::bigint AND valid_to = 'infinity'`,
      [String(who.userId)],
    );
    expect(res.rows).toEqual([
      { max_tier: 'eod', usage_display: true, usage_export: false, usage_api: false },
    ]);
  });

  it('downgrades EVERY price field to eod on a realtime display read, PX_OFFICIAL_CLOSE included', async () => {
    const decision = await decide({ tier: 'realtime', usage: 'display' });
    expect(decision.effectiveTier).toBe('eod');
    // Uniform, and that is the assertion: the old note described PX_OFFICIAL_CLOSE as populating
    // and PX_BID as null, and the evaluator makes no such distinction.
    expect(decision.fields.map((f) => [f.fieldId, f.decision, f.reason, f.effectiveTier])).toEqual(
      PRICE_FIELDS.map((fieldId) => [fieldId, 'downgrade', 'NOT_ENTITLED_TIER', 'eod']),
    );
    // Not the plant gate's code. `TIER_EOD` is real, and it is emitted a stage later.
    expect(decision.fields.some((f) => f.reason === 'TIER_EOD')).toBe(false);
    // Nothing "comes back null": a downgrade still serves a value, at the tier it may serve.
    expect(decision.fields.some((f) => f.decision === 'deny')).toBe(false);
  });

  it('downgrades a delayed read the same way — the tier is the grant, not the field', async () => {
    const decision = await decide({ tier: 'delayed', usage: 'display' });
    expect(decision.fields.map((f) => [f.decision, f.reason, f.effectiveTier])).toEqual(
      PRICE_FIELDS.map(() => ['downgrade', 'NOT_ENTITLED_TIER', 'eod']),
    );
  });

  it('allows the same fields when the read asks for the tier the seat has', async () => {
    const decision = await decide({ tier: 'eod', usage: 'display' });
    expect(decision.effectiveTier).toBe('eod');
    expect(decision.fields.map((f) => [f.decision, f.reason, f.effectiveTier])).toEqual(
      PRICE_FIELDS.map(() => ['allow', 'OK', 'eod']),
    );
  });

  it('refuses export by rule 5 (NO_USER_ENTITLEMENT), not by rule 2 or rule 4', async () => {
    for (const tier of ['realtime', 'delayed', 'eod'] as const) {
      const decision = await decide({ tier, usage: 'export' });
      expect(decision.effectiveTier).toBeNull();
      expect(decision.fields.map((f) => [f.decision, f.reason])).toEqual(
        PRICE_FIELDS.map(() => ['deny', 'NO_USER_ENTITLEMENT']),
      );
      // Rule 2 is the licence gate and rule 4 the firm contract; both PASS here, which is why
      // naming them in the note sent a reader to the wrong rule. `demo`'s firm grant permits
      // export — this is the only reason it is worth asserting the absence of those two codes.
      expect(decision.fields.some((f) => f.reason === 'LICENCE_FORBIDS_USAGE')).toBe(false);
      expect(decision.fields.some((f) => f.reason === 'NO_FIRM_ENTITLEMENT')).toBe(false);
    }
  });

  it('refuses api usage for the same reason: the seat has no api grant', async () => {
    const decision = await decide({ tier: 'eod', usage: 'api' });
    expect(decision.fields.map((f) => [f.decision, f.reason])).toEqual(
      PRICE_FIELDS.map(() => ['deny', 'NO_USER_ENTITLEMENT']),
    );
  });

  it('carries the corrected note into the database, so the row explains what the rows above do', async () => {
    // Module 12 is re-run inside this transaction so the note under test is the one
    // `fixtures/seed/entitlements.json` produces TODAY, not whatever the database happened to be
    // seeded with. Without it, editing the fixture back would leave this test green until somebody
    // dropped the database — and a grant note is the one comment in this repository that ships as a
    // value, so it is the one that most needs the fixture and the assertion tied together.
    await seedUsers({
      query: (text: string, values?: unknown[]) => t.client.query(text, values),
      db: t.db,
      config: getConfig(),
      clock: frozenClock(TEST_NOW),
      log: () => undefined,
    });

    const who = await seat(t);
    const res = await t.client.query<{ note: string | null }>(
      `SELECT note FROM entitlement_grants
        WHERE subject_kind = 'user' AND subject_id = $1::bigint AND valid_to = 'infinity'`,
      [String(who.userId)],
    );
    const note = res.rows[0]?.note ?? '';
    // The three claims the evaluator run above establishes, each pinned by the phrase that carries
    // it. Not a full-text equality: a note is prose and should be editable. What may not drift is
    // the code it names, the rule it blames, and the stage it attributes `TIER_EOD` to.
    expect(note).toContain('NOT_ENTITLED_TIER');
    expect(note).toContain('NO_USER_ENTITLEMENT');
    expect(note).toContain('plant gate');
    // The two things the old note said that the evaluator does not do.
    expect(note).not.toContain('rule 2/rule 4');
    expect(note).not.toMatch(/comes? back null with reason TIER_EOD/);
  });
});
