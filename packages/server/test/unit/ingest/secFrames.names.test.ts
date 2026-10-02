/**
 * `test/unit/ingest/secFrames.names.test.ts` — DATA-07 / QA-02: `secFrames.ts#comparableName`, the
 * normaliser that decides whether `data[].entityName` and `issuers.name` are two spellings of one
 * filer or a hard disagreement worth a `reconcile_mismatch` row.
 *
 * ## Every pair below was read out of `dq_events`, not invented
 *
 * The job wrote **834** `reconcile_mismatch` rows against the seeded universe
 * (`bloomberg_seed_test`, `SELECT count(*) FROM dq_events WHERE kind = 'reconcile_mismatch'` is 894,
 * of which 834 carry `details.frameEntityName`; the other 60 are the curve cross-check). Each
 * `expect` below quotes one of those rows' two names verbatim, so a case that passes here is a row
 * that will not be written again — and a case that fails is a row that will.
 *
 * **Measured over all 5,287 resolved (CIK, frame name, issuer name) triples: 834 mismatches before,
 * 314 after, and zero pairs that agreed before that stop agreeing.** The two tables here are a
 * census of the *kinds* — one case per decoration the data actually contains, plus the two kinds
 * that survive — because the full 5,287 belong to the seed, not to a unit project with no database.
 *
 * The residue is deliberate. 173 of the 314 are a different company under the same CIK — the case
 * §7.4 exists to surface — and the other 141 are abbreviations (`FINL`, `Solutns`, `Cmpny Hldgs`) or
 * a bond description appended with no separator. A normaliser aggressive enough to fold those would
 * also fold `FRANKLIN RESOURCES` into `Franklin Templeton`, so the second table pins them open.
 */

import { describe, expect, it } from 'vitest';

import { comparableName } from '../../../src/ingest/jobs/secFrames.js';

/**
 * One filer, two spellings — the 520. `[frameEntityName, issuersName, why]`, where `why` names the
 * decoration, because the decoration is what the test is about.
 */
const SAME_FILER: readonly (readonly [string, string, string])[] = [
  // The ordering bug itself: punctuation replaced by spaces before the suffix strip turned `L.P.`
  // into `l p`, which `\b(lp)\b` cannot see.
  ['ALLIANCEBERNSTEIN HOLDING L.P.', 'Alliancebernstein Holding LP', 'L.P. against LP'],
  [
    'AMBITIONS ENTERPRISE MANAGEMENT CO. L.L.C',
    'Ambitions Enterprise Management Co LLC',
    'L.L.C against LLC',
  ],
  ['Akari Therapeutics, Plc', 'Akari Therapeutics PLC (ADR)', 'Plc against PLC, with a marker'],
  // A possessive apostrophe deleted rather than replaced by a space — and only a possessive one,
  // which is what keeps `O'Reilly` folding onto `O Reilly` in PREVIOUSLY_AGREED below.
  ['ALEXANDERS INC', "Alexander's Inc", 'a possessive on one side only'],
  ['ARTS WAY MANUFACTURING CO INC', "Art's Way Manufacturing Co Inc", 'a possessive mid-name'],
  ['THE BRINK’S COMPANY', 'Brinks Co', 'a typographic apostrophe and a leading "The"'],
  // Parentheticals: a share class, or where the listing file thinks the company is.
  ['AMBOW EDUCATION HOLDING LTD.', 'Ambow Education Holding Ltd (ADR)', '(ADR)'],
  ['Compugen Ltd', 'Compugen Ltd (USA)', '(USA)'],
  ['DREAM FINDERS HOMES, INC.', 'Dream Finders Homes Inc (Texas)', '(Texas)'],
  // EDGAR's conformed-name jurisdiction, after a slash or a backslash.
  ['AGCO CORP /DE', 'Agco Corp', '/DE'],
  ['FNB CORP/PA/', 'FNB Corp', '/PA/ with a trailing slash'],
  ['AMARIN CORP PLC\\UK', 'Amarin Corporation PLC', 'a backslash jurisdiction'],
  ['Alight, Inc. / Delaware', 'Alight Inc', 'a spaced / Delaware'],
  [
    'Columbus Acquisition Corp/Cayman Islands',
    'Columbus Acquisition Corp - Rights',
    'both at once',
  ],
  // The instrument description a listing file hangs off the issuer name after a spaced hyphen.
  ['111, Inc.', '111 Inc - ADR', '- ADR'],
  ['ACLARION, INC.', 'Aclarion, Inc. - Warrant', '- Warrant'],
  ['AINOS, INC.', 'Ainos, Inc. - warrants', '- warrants, lower case'],
  ['ADAMAS TRUST, INC.', 'Adamas Trust, Inc. - 9.125% Senior Notes Due 2030', '- a note series'],
  [
    'AGNC INVESTMENT CORP.',
    'AGNC Investment Corp. - Depositary Shares Each Representing a 1/1,000th Interest in a Share of 7.75%',
    '- a depositary-share description',
  ],
  [
    'ALTISOURCE PORTFOLIO SOLUTIONS S.A.',
    'Altisource Portfolio Solutions S.A. - Net Settle Stakeholder Warrants',
    'S.A. and a free-text warrant description',
  ],
  // The same markers with no separator at all, which is how the SPAC rows are spelled.
  ['Calisa Acquisition Corp', 'Calisa Acquisition Corp Right', 'a bare trailing Right'],
  ['Velos Acquisition I Corp.', 'Velos Acquisition I Corp. Units', 'a bare trailing Units'],
  [
    'Twelve Seas Investment Co III/Cayman',
    'Twelve Seas Investment Company III Rights',
    'Co against Company, a jurisdiction and a bare marker',
  ],
  ['Sea Limited', 'Sea Ltd (ADR)', 'a two-token name that survives the strip'],
];

/**
 * Two filers under one CIK, and the abbreviation gaps — the 314. These MUST stay unequal: they are
 * what §7.4 is for, and a normaliser that closed them would have made the check worthless.
 */
const DIFFERENT_FILER: readonly (readonly [string, string, string])[] = [
  ['A-Mark Precious Metals, Inc.', 'Gold.com Inc', 'a different company under the same CIK'],
  ['AB International Group Corp.', 'AI Era Corp', 'a different company under the same CIK'],
  ['ALIXO-YOLLOO CORPORATION', 'Made in USA Inc', 'a different company under the same CIK'],
  ['FRANKLIN RESOURCES, INC.', 'Franklin Templeton, Inc.', 'a sibling brand, not the registrant'],
  ['21Shares Ethereum ETF', '21Shares Ethereum Staking ETF', 'a different fund, one word apart'],
  [
    'ARTIFICIAL INTELLIGENCE TECHNOLOGY SOLUTIONS INC.',
    'Artificial Intelligence Tech Solutns Inc',
    'abbreviated words this does not expand',
  ],
  [
    'AMERICAN FINANCIAL GROUP, INC.',
    'AMERICAN FINL GROUP INC OHIO 5.875 SB NT 59',
    'an abbreviation plus a bond description with no separator',
  ],
];

/**
 * The nine pairs that agreed under the SHIPPED normaliser and that the first draft of this repair
 * broke. They are here because a fix measured only on its own 834 is half a measurement: the first
 * draft deleted every `.` and `'`, which folds `L.B. FOSTER COMPANY` to `lb foster` while
 * `L B Foster Co` stays `l b foster`, and it bounded EDGAR's jurisdiction by length, which ate the
 * `/O Corp` of `Data I/O Corp`. Both were found by re-running the *whole* 5,287-triple comparison
 * rather than the failures, and both are why the shipped rules are a single-letter-run collapse and
 * an explicit jurisdiction list.
 */
const PREVIOUSLY_AGREED: readonly (readonly [string, string, string])[] = [
  ['L.B. FOSTER COMPANY', 'L B Foster Co', 'initials dotted on one side, spaced on the other'],
  ['J.B. HUNT TRANSPORT SERVICES, INC.', 'J B Hunt Transport Services Inc', 'the same, mid-name'],
  ['THE E.W. SCRIPPS COMPANY', 'E W Scripps Co', 'the same, with a leading "The"'],
  ['W. P. Carey Inc.', 'W.p. Carey Inc', 'initials spaced AND dotted on both sides, differently'],
  ['O Reilly Automotive Inc', "O'Reilly Automotive Inc", 'an apostrophe that is not a possessive'],
  ['DATA I/O CORPORATION', 'Data I/O Corp', 'a slash inside the name, not a jurisdiction'],
  ['QUAD/GRAPHICS, INC.', 'Quad/Graphics Inc', 'the same, with the comma on one side only'],
  ['1 800 FLOWERS COM INC', '1-800-Flowers.Com Inc', 'hyphens and a dot against spaces'],
  [
    'One and one Green Technologies. INC',
    'One and one Green Technologies.INC',
    'a full stop with and without the space after it',
  ],
];

describe('secFrames#comparableName (DATA-07)', () => {
  it('folds the 520 spelling differences the seeded universe actually contains', () => {
    const disagreed = SAME_FILER.filter(([a, b]) => comparableName(a) !== comparableName(b)).map(
      ([a, b, why]) => `${why}: "${a}" → "${comparableName(a)}" vs "${b}" → "${comparableName(b)}"`,
    );
    expect(disagreed).toEqual([]);
  });

  it('still reports the 314 that are not formatting', () => {
    const agreed = DIFFERENT_FILER.filter(([a, b]) => comparableName(a) === comparableName(b)).map(
      ([a, b, why]) => `${why}: "${a}" and "${b}" both → "${comparableName(a)}"`,
    );
    expect(agreed).toEqual([]);
  });

  it('keeps folding the nine pairs an earlier draft of this repair broke', () => {
    const broken = PREVIOUSLY_AGREED.filter(
      ([a, b]) => comparableName(a) !== comparableName(b),
    ).map(
      ([a, b, why]) => `${why}: "${a}" → "${comparableName(a)}" vs "${b}" → "${comparableName(b)}"`,
    );
    expect(broken).toEqual([]);
  });

  it('strips the suffix from an abbreviation, which is the ordering the bug inverted', () => {
    // The whole defect in one assertion: `L.P.` has to survive as the single token `lp` long enough
    // for `\b(lp)\b` to remove it. Replacing `.` with a space first yields `l p`, which does not
    // match, and the suffix then survives on whichever side spelled it with periods.
    expect(comparableName('Brookfield Renewable Partners L.P.')).toBe(
      'brookfield renewable partners',
    );
    expect(comparableName('Brookfield Renewable Partners LP')).toBe(
      'brookfield renewable partners',
    );
    expect(comparableName('Acme S.A.')).toBe('acme');
    expect(comparableName('Acme N.V.')).toBe('acme');
    expect(comparableName('Acme P.L.C.')).toBe('acme');
  });

  it('never reduces a name to the empty string, which would make two names agree by accident', () => {
    // "The Trust Company" is nothing but suffixes; so is "Holdings Group Inc". If both folded to ''
    // they would compare equal and the mismatch would be silently swallowed — worse than reporting
    // a mismatch that is not one, because nothing downstream can tell it happened.
    expect(comparableName('The Trust Company')).toBe('the trust company');
    expect(comparableName('Holdings Group Inc')).toBe('holdings group inc');
    expect(comparableName('The Trust Company')).not.toBe(comparableName('Holdings Group Inc'));
  });

  it('reads EDGAR’s jurisdiction decoration, and only that', () => {
    expect(comparableName('Devon Energy Corp/DE')).toBe('devon energy');
    expect(comparableName('New Providence Acquisition Corp. III/Marshall Islands')).toBe(
      'new providence acquisition iii',
    );
    // Not a decoration: `S Dampskibsselskabet` is not a jurisdiction, so the name after the slash
    // survives. This is the case the earlier length-bounded rule got wrong, in the shape that
    // matters — a slash inside the name rather than at the end of it.
    expect(comparableName('A/S Dampskibsselskabet Torm')).toBe('as dampskibsselskabet torm');
    expect(comparableName('Nordic Shipping A/S Holdings Trust Inc')).toBe('nordic shipping as');
  });
});
