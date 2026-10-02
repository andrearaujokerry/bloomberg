/**
 * `test/unit/providers/licences.fieldMatrix.test.ts` — ENTL-05 / ARCHITECTURE §10 rule 1: the
 * `(field, asset class) → source` matrix that `seed/licences.ts` writes into `field_licence` and
 * that `entitlements/licenceRegistry.ts#fieldSource` is a lookup over.
 *
 * ## Why this file exists at all
 *
 * The matrix is derived, 744 rows wide, and had **no test**. It was built by expanding each field's
 * `sources` list, and a miss in rule 1 is a *denial* (`FIELD_UNKNOWN`), not a shrug — so every pair
 * the product asks about and the expansion did not produce was a field refused on one path. The
 * `sources` list is a record of the provider paths that happened to be observed; the field's own
 * `assetClasses` is the dictionary *stating* which classes the field is meaningful for, and
 * `POST /data` accepts every one of them. Those two lists disagree on 117 pairs.
 *
 * Two of the 117 were an entitlement bypass rather than a nuisance: `(BID_SIZE, index)` and
 * `(ASK_SIZE, index)` made the evaluator answer `FIELD_UNKNOWN` to the function runner — blanking
 * both size cells on `Q`'s SPX screen — while the WebSocket gateway, asked about the same user, the
 * same subject and the same two fields, sent 40 and 120 with no reason at all. One door refused the
 * value and the other served it. `test/parity/fn-parity.test.ts`'s live leg caught that pair after
 * the fact, against a seeded database, in a four-minute suite. The first assertion below catches the
 * whole class of it in four milliseconds, against the dictionary, which is where the gap lives.
 *
 * The rest of the file pins the three properties that make the repair safe rather than merely
 * larger: the gap fill may not restate a pair the expansion already decided (precedence), may not
 * invent a licence claim where there is no source to name, and may not drop a row.
 */

import { describe, expect, it } from 'vitest';

import { fieldDefs } from '@terminal/core';

import {
  buildFieldLicenceRows,
  entitlementCheckedPairs,
  fieldLicenceRows,
  getLicence,
  licenceSourceIds,
} from '../../../src/providers/licences.js';

/** `licence_registry`'s own source ids, which `assert_source_known` enforces at seed time. */
const licenceSourceIdSet = new Set(licenceSourceIds);

const key = (fieldId: string, assetClass: string): string => `${fieldId}:${assetClass}`;

/** The matrix as rule 1 indexes it. Two rows for one pair would be a seed conflict. */
const byPair = new Map(fieldLicenceRows.map((row) => [key(row.fieldId, row.assetClass), row]));

/**
 * The matrix as it was built before this repair: `sources` only, with no gap fill. Produced by
 * handing the builder an EMPTY requested-pair list, which is the injection point
 * `buildFieldLicenceRows`' second parameter exists for — not by a second copy of the expansion.
 */
const sourcesOnly = buildFieldLicenceRows(fieldDefs, []);

describe('the field_licence matrix (ENTL-05, ARCHITECTURE §10 rule 1)', () => {
  it('has a row for every (field, asset class) the dictionary declares', () => {
    // THE assertion. `fieldSource` will not fall back to another class's row — deliberately, since
    // that would make an asset-class-scoped grant portable to a source the contract never bought —
    // so a declared pair with no row is a field the evaluator denies for FIELD_UNKNOWN on every
    // path that names that class. Reported as the list, not as a count, because the names are what
    // a reader needs: this is how `(BID_SIZE, index)` would have been found.
    const missing = [...new Set(entitlementCheckedPairs(fieldDefs).map(([f, a]) => key(f, a)))]
      .filter((k) => !byPair.has(k))
      .sort();
    expect(missing).toEqual([]);
  });

  it('closed 117 gaps the sources expansion left, and the two that were a bypass', () => {
    // The size of the hole, so that a dictionary change which reopens it is visible as a number and
    // not only as the list above. Measured on the shipped dictionary: 627 rows from `sources`, 737
    // distinct declared pairs, 117 of them with no row.
    const have = new Set(sourcesOnly.map((row) => key(row.fieldId, row.assetClass)));
    const declared = new Set(entitlementCheckedPairs(fieldDefs).map(([f, a]) => key(f, a)));
    expect(sourcesOnly.length).toBe(627);
    expect(declared.size).toBe(737);
    expect([...declared].filter((k) => !have.has(k))).toHaveLength(117);
    expect(fieldLicenceRows).toHaveLength(744);

    // Named, because these two are the finding and not an example of it: both resolve to
    // `cboe.quotes`, the same feed at the same tier that already supplies an equity's sizes, so
    // naming them widens nothing — a row is added and the six rules still decide.
    for (const fieldId of ['BID_SIZE', 'ASK_SIZE']) {
      expect(have.has(key(fieldId, 'index'))).toBe(false);
      expect(byPair.get(key(fieldId, 'index'))?.sourceId).toBe('cboe.quotes');
      expect(byPair.get(key(fieldId, 'equity'))?.sourceId).toBe('cboe.quotes');
    }
  });

  it('never restates a pair the sources expansion already decided', () => {
    // Precedence is "the first source listed on the field wins", dictionary order being
    // primary-source order. The gap fill reaches for the same first source, so it must be unable to
    // reach a pair that already has a row — otherwise a field whose `sources` name `yahoo.chart`
    // for an ETF would silently be re-attributed to whatever it lists first, and the licence gate,
    // the tier cap and the attribution line would all move with it.
    const moved = sourcesOnly
      .filter((row) => byPair.get(key(row.fieldId, row.assetClass))?.sourceId !== row.sourceId)
      .map((row) => `${key(row.fieldId, row.assetClass)}: ${row.sourceId}`);
    expect(moved).toEqual([]);
    // And nothing is dropped: the fill is additive, so every sources-only pair survives.
    for (const row of sourcesOnly) expect(byPair.has(key(row.fieldId, row.assetClass))).toBe(true);
  });

  it('invents no row for a field with no source and no row for a field outside the dictionary', () => {
    // Six dictionary entries cite no source at all — the formula-language and prefix-placeholder
    // entries, `SPREAD` among them. Naming `internal.derived` on a guess would put a licence claim
    // in the registry that nobody made, so the builder skips them; all six also declare no asset
    // class, so they contribute no pair either. Asserted in both directions so that a future entry
    // which gains a class cannot quietly acquire a fabricated source.
    const sourceless = fieldDefs.filter((def) => def.sources.length === 0).map((def) => def.id);
    expect(sourceless.length).toBeGreaterThan(0);
    for (const fieldId of sourceless) {
      expect(fieldLicenceRows.filter((row) => row.fieldId === fieldId)).toEqual([]);
    }

    // A requested pair naming a field the dictionary does not hold is the startup validation's
    // business (ARCHITECTURE §12.1 step 3), not the builder's: inventing a row would hide the
    // inconsistency behind a licence claim.
    const invented = buildFieldLicenceRows(fieldDefs, [['NOT_A_FIELD', 'equity']]);
    expect(invented.filter((row) => row.fieldId === 'NOT_A_FIELD')).toEqual([]);
    expect(invented).toHaveLength(sourcesOnly.length);
  });

  it('attributes every filled gap to the field\u2019s primary feed, and says what that claims', () => {
    // THE COST OF THE REPAIR, asserted so that the docstring's account of it cannot drift. Each filled
    // pair inherits `def.sources[0]`, which is an attribution the `sources` list never observed: ten of
    // the 117 land on `cboe.quotes`, and `(PX_BID, crypto)` among them states that Cboe supplies a
    // crypto bid, where `PX_BID`'s observed paths are equity/etf/index -> `cboe.quotes` and option ->
    // `cboe.options` and nothing else. `providers/licences.ts`' docstring refuses to make exactly that
    // kind of statement for the 71 MANIFEST pairs, and the asymmetry is argued there; this is the half
    // that was accepted, pinned by name rather than left to a reader to rediscover.
    const have = new Set(sourcesOnly.map((row) => key(row.fieldId, row.assetClass)));
    const filled = fieldLicenceRows.filter((row) => !have.has(key(row.fieldId, row.assetClass)));
    expect(filled).toHaveLength(117);

    const byId = new Map(fieldDefs.map((def) => [def.id, def]));
    for (const row of filled) {
      const primary = byId.get(row.fieldId)?.sources[0];
      expect(primary, `${row.fieldId} was filled with no primary source`).toBeDefined();
      expect(row.sourceId, key(row.fieldId, row.assetClass)).toBe(primary?.sourceId);
      // And the attribution is one the field's own `sources` never recorded for THAT class — which is
      // what makes it a new claim rather than a restatement. (`'*'` sources expand to every declared
      // class, so a field with one of those leaves no gap to fill and cannot reach this loop.)
      const observed = byId
        .get(row.fieldId)
        ?.sources.some((src) => src.assetClass === row.assetClass || src.assetClass === '*');
      expect(observed, key(row.fieldId, row.assetClass)).toBe(false);
    }

    expect(
      filled.filter((row) => row.sourceId === 'cboe.quotes').map((row) => key(row.fieldId, row.assetClass)).sort(),
    ).toEqual([
      'ASK_SIZE:index',
      'BID_SIZE:index',
      'LAST_SIZE:index',
      'LAST_SIZE:option',
      'LAST_TRADE_TIME:option',
      'PX_ASK:crypto',
      'PX_ASK:fx',
      'PX_BID:crypto',
      'PX_BID:fx',
      'PX_LAST:future',
    ]);

    // The tier half of the docstring's argument against the manifest pairs does NOT separate the two
    // cases, and the number is here so that nobody can claim it does: most of what was filled names a
    // source that caps below `realtime`, exactly as nine of the 71 would have.
    const capped = filled.filter((row) => getLicence(row.sourceId)?.maxTier !== 'realtime');
    expect(capped).toHaveLength(87);
  });

  it('names a source that the licence registry actually holds', () => {
    // A row pointing at an unknown `source_id` is rejected by `assert_source_known` at seed time
    // with P0001, which is a 157-second seed failing on row 700 of 744. Cheaper here.
    const unknown = [
      ...new Set(
        fieldLicenceRows
          .filter((row) => !licenceSourceIdSet.has(row.sourceId))
          .map((row) => row.sourceId),
      ),
    ];
    expect(unknown).toEqual([]);
  });
});
