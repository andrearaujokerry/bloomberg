// packages/core/test/fields/dictionary.test.ts — WP-01 acceptance test (WORKPLAN §1.11).
//
// Two obligations:
//
//   1. **Every field id declared in the design resolves.** CONTRACTS §4.3 is the mechanical
//      extraction of every field id named anywhere in FUNCTIONS.md; the list below is copied from
//      it verbatim. A field id is a public contract (it appears in `POST /data`, in `GET /fields`,
//      in the CSV column header and in `field_licence`), so one that the design names but the
//      dictionary does not define is a broken contract, not a missing nice-to-have.
//
//   2. **`gen:fields` output matches the committed `fields.json`.** `packages/sdk/src/fields/
//      fields.json` is GENERATED from this dictionary (`scripts/gen-fields.ts`, WORKPLAN §1.10).
//      The generator writes `JSON.stringify({version, generatedAt, fields}, null, 2) + '\n'`, and
//      `--check` refuses to write and exits non-zero when either artefact is stale. Both are
//      asserted: the cheap structural comparison here, and the generator's own `--check` run,
//      which also validates the barrel and every definition.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  FIELD_DICTIONARY_GENERATED_AT,
  FIELD_DICTIONARY_VERSION,
  fieldDefs,
  fieldDictionary,
  fieldIds,
  getField,
  hasField,
  listFields,
  requireField,
} from '../../src/fields/dictionary.js';
import type { FieldDef } from '../../src/types/fields.js';

/** `packages/core/test/fields/` → the monorepo root. */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FIELDS_JSON = fileURLToPath(new URL('../../../sdk/src/fields/fields.json', import.meta.url));

/**
 * CONTRACTS.md §4.3 "Field ids declared so far", copied verbatim (94 ids, alphabetical).
 * Update this list only when CONTRACTS §4.3 itself changes.
 */
const CONTRACTS_FIELD_IDS: readonly string[] = `
ACCRUED ASK_SIZE BID_SIZE BS_TOT_ASSET BS_TOT_LIAB2 CF_CAP_EXPEND CF_CASH_FROM_OPER CHG_
CHG_NET_1D CHG_PCT_1D CPNTO CPN_FREQ CUR_MKT_CAP DUR_ADJ_MID DUR_MID DVD_SH_12M DVD_YIELD ECO_
ECO_PERIOD ECO_PRIOR ECO_RELEASE_DT ECO_VALUE ECO_VINTAGE EPS_BASIC EPS_DIL EQY_FLOAT_PCT
EQY_SH_OUT FX_MISSING FX_USD HIGH IDX_MEMBER_SHARES IDX_MEMBER_SINCE IDX_MEMBER_WEIGHT
IS_CORRECTION IS_EPS_DIL IS_FINAL IS_OPER_INC LAST_SIZE LAST_TRADE_TIME NET_INC NET_INCOME
NET_MARGIN NEWS_ID OPT_ OPT_BREAKEVEN OPT_CHARM OPT_CONT_SIZE OPT_DELTA OPT_DVD_YIELD_USED
OPT_EXPIRE_DT OPT_GAMMA OPT_IMPL_VOL_MID OPT_INTRINSIC OPT_IV OPT_MODEL_PX OPT_OI OPT_PUT_CALL
OPT_RATE_USED OPT_RHO OPT_STRIKE_PX OPT_THEO OPT_THETA OPT_TIME_VALUE OPT_UNDL_PX OPT_UNDL_TICKER
OPT_VANNA OPT_VEGA OPT_VOLGA PX_ASK PX_BID PX_CLEAN_MID PX_CLOSE_1D PX_DIRTY_MID PX_HIGH
PX_HIGH_52W PX_LAST PX_LOW PX_LOW_52W PX_OFFICIAL_CLOSE PX_OPEN PX_TO_BOOK_RATIO PX_TO_SALES_RATIO
PX_VOLUME SALES_GROWTH_YOY SALES_PS SALES_REV_TURN SPREAD SPREADS TOT_ASSETS TOT_LIAB
TOT_RETURN_INDEX VOLUME_AVG_30D VOL_30D YLD_YTM_MID
`
  .trim()
  .split(/\s+/);

/**
 * WP-02's analytics fields (WORKPLAN L465-466: `fields/defs/analytic.ts` and `fields/defs/derived.ts`
 * are owned by WP-02). CONTRACTS §4.3 harvested only the ids the design prose happened to name before
 * the analytics engines existed; these 68 are the ids WP-02's engines publish — bill/bond/curve/swap
 * analytics (ANAL-01/02), the SVI slice shape of `vol_surfaces.svi` (ANAL-04), the WIRP policy path,
 * the ANAL-07 statistics and the REF-09 adjustment factors. Listed here, sorted, so that the
 * "defines no field the design does not name" check below stays exhaustive: nothing reaches the
 * dictionary without appearing in one of these two lists.
 */
const WP02_ANALYTIC_FIELD_IDS: readonly string[] = `
ACCRUED_DAYS ADJ_FACTOR_PX ADJ_FACTOR_VOL ADJ_POLICY BETA_1Y BEY CONVEXITY_MID CORR_1Y CRV_10Y
CRV_1M CRV_1Y CRV_20Y CRV_2M CRV_2Y CRV_30Y CRV_3M CRV_3Y CRV_5Y CRV_6M CRV_7Y CURVE_DF
CURVE_FWD_3M CURVE_PAR CURVE_ZERO DAYS_TO_MTY DAY_CNT_FRAC DISC_RATE DV01 DV01_PER_100
INFO_RATIO_1Y IVOL_30D KRD_10Y KRD_2Y KRD_30Y KRD_5Y MAX_DD_1Y MM_YIELD OPT_FWD_PX OPT_LOG_MNY
RET_1D RET_1M RET_1W RET_1Y RET_YTD SHARPE_1Y SORTINO_1Y SPRD_TO_BENCH SPRD_TO_CRV SVI_A SVI_B
SVI_M SVI_N SVI_RHO SVI_RMSE SVI_SIGMA SWAP_ACCRUED SWAP_FIXED_RATE SWAP_NPV SWAP_PAR_RATE
SWAP_PV01 VOL_90D WIRP_IMPL_RATE WIRP_MOVE_BP WIRP_PROB_CUT WIRP_PROB_HIKE WIRP_PROB_HOLD
YLD_VAL_32ND Z_SPRD_MID
`
  .trim()
  .split(/\s+/);

/**
 * WP-03's reference surface (WORKPLAN L558-622: `fields/defs/reference.ts` is WP-03's). CONTRACTS
 * §4.3 harvested only the reference ids the design prose happened to name; these 95 are the
 * security-master fields the DES, SECF, MEMB, HDS and CACS screens read — identifiers and names,
 * sector and classification codes, exchange/MIC/calendar, currency and country, listing and issue
 * attributes, Treasury terms (REF-04), option terms (REF-05), index-membership attributes (REF-07)
 * and the corporate-action descriptors (REF-09, DATA-08). API-07 requires the dictionary to be
 * complete, so they are listed here, sorted, and the exhaustiveness check below still holds:
 * nothing reaches the dictionary without appearing in one of these three lists.
 */
const WP03_REFERENCE_FIELD_IDS: readonly string[] = `
AMT_OUTSTANDING ASSET_CLASS BOND_TYPE BUSINESS_DAY_CONV CA_AMOUNT CA_CRNCY CA_DECLARED_DT
CA_EFFECTIVE_DT CA_EX_DT CA_FREQUENCY CA_GROSS_NET CA_NEW_TICKER CA_PAY_DT CA_RATIO_NEW
CA_RATIO_OLD CA_RECORD_DT CA_STATUS CA_TYPE CNTRY_OF_DOMICILE CNTRY_OF_ISSUE COMPANY_WEB_ADDRESS
CPN CPN_TYP CRNCY DATED_DT DAY_CNT EXCH_CALENDAR_ID EXCH_CODE EXCH_TIMEZONE FIRST_CPN_DT
FIRST_TRADE_DT FISCAL_YEAR_END FLT_SPREAD GICS_INDUSTRY_CODE GICS_INDUSTRY_GROUP_NAME
GICS_INDUSTRY_NAME GICS_SECTOR_CODE GICS_SECTOR_NAME GICS_SUB_INDUSTRY_NAME HLD_AS_OF_DT
HLD_HOLDER_NAME HLD_MKT_VAL HLD_PCT_OUT HLD_SHARES_HELD IDX_MEMBER_ASOF IDX_MEMBER_COUNT
IDX_MEMBER_MKT_VAL IDX_MEMBER_SOURCE IDX_PROVIDER IDX_PROXY_FUND IDX_RATIO_BASE ID_BB_GLOBAL
ID_BB_SHARE_CLASS ID_CIK ID_CUSIP ID_EXCH_TICKER ID_FIGI_LISTING ID_ISIN ID_LEI ID_OCC ID_SEDOL
ID_TICKER ISSUER_TYPE ISSUE_DT IS_CALLABLE LISTING_STATUS LONG_COMP_NAME MARKET_SECTOR_DES
MATURITY MIN_INCREMENT MIN_PIECE NAME NXT_CPN_DT ON_THE_RUN OPT_AM_PM OPT_EXER_TYP OPT_IS_WEEKLY
OPT_LAST_TRADE_DT OPT_MULTIPLIER OPT_ROOT OPT_SETTLE_TYP OPT_TICK_SIZE PARSEKYABLE_DES PAR_VALUE
PRIM_EXCH_MIC PRIM_EXCH_NAME REFERENCE_INDEX SECURITY_STATUS SECURITY_TERM SECURITY_TYP
SETTLE_CALENDAR SETTLE_DAYS SIC_CODE SIC_DESCRIPTION STATE_OF_INCORPORATION
`
  .trim()
  .split(/\s+/);

/** Every id the design names, from any of the three sources. */
const DESIGNED_FIELD_IDS: readonly string[] = [
  ...CONTRACTS_FIELD_IDS,
  ...WP02_ANALYTIC_FIELD_IDS,
  ...WP03_REFERENCE_FIELD_IDS,
];

/** The dictionary's total size: CONTRACTS §4.3's 94, WP-02's 68 analytics and WP-03's 95 reference. */
const FIELD_COUNT = 257;

// ---------------------------------------------------------------------------------------------
// 1. Every field id in CONTRACTS §4.3 resolves
// ---------------------------------------------------------------------------------------------

describe('field dictionary — CONTRACTS §4.3 coverage', () => {
  it('declares 94 ids in CONTRACTS §4.3, 68 in WP-02 analytics and 95 in WP-03 reference', () => {
    expect(CONTRACTS_FIELD_IDS).toHaveLength(94);
    expect(WP02_ANALYTIC_FIELD_IDS).toHaveLength(68);
    expect(WP03_REFERENCE_FIELD_IDS).toHaveLength(95);
    expect(new Set(DESIGNED_FIELD_IDS).size).toBe(FIELD_COUNT);
  });

  it('resolves every id through getField / hasField / requireField', () => {
    const unresolved = DESIGNED_FIELD_IDS.filter((id) => getField(id) === undefined);
    expect(unresolved).toEqual([]);

    for (const id of DESIGNED_FIELD_IDS) {
      expect(hasField(id)).toBe(true);
      expect(requireField(id).id).toBe(id);
    }
  });

  it('defines no field the design does not name, and names none it does not define', () => {
    const declared = new Set(DESIGNED_FIELD_IDS);
    const defined = new Set(fieldIds());
    expect([...declared].filter((id) => !defined.has(id))).toEqual([]);
    expect([...defined].filter((id) => !declared.has(id))).toEqual([]);
  });

  it('throws a diagnosable error for an id the dictionary does not know', () => {
    expect(getField('NOT_A_FIELD')).toBeUndefined();
    expect(hasField('NOT_A_FIELD')).toBe(false);
    expect(() => requireField('NOT_A_FIELD')).toThrow(/unknown field id 'NOT_A_FIELD'/);
    expect(() => requireField('NOT_A_FIELD')).toThrow(FIELD_DICTIONARY_VERSION);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Dictionary invariants the generator and `GET /fields` both rely on
// ---------------------------------------------------------------------------------------------

describe('field dictionary — invariants', () => {
  it('is sorted by id and free of duplicates', () => {
    const ids = fieldIds();
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a fixed generatedAt — the /fields ETag depends on it being reproducible', () => {
    expect(FIELD_DICTIONARY_GENERATED_AT).toBe('2026-09-17T00:00:00.000Z');
    expect(FIELD_DICTIONARY_VERSION).toMatch(/^\d{4}\.\d{2}\.\d+$/);
    expect(fieldDictionary.version).toBe(FIELD_DICTIONARY_VERSION);
    expect(fieldDictionary.generatedAt).toBe(FIELD_DICTIONARY_GENERATED_AT);
    expect(fieldDictionary.fields).toBe(fieldDefs);
  });

  it('gives every definition the shape scripts/gen-fields.ts validates', () => {
    const FIELD_ID_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
    const problems: string[] = [];
    for (const def of fieldDefs) {
      const at = (msg: string): void => void problems.push(`${def.id}: ${msg}`);
      if (!FIELD_ID_RE.test(def.id)) at('id does not match the field-id pattern');
      if (def.label.trim() === '') at('label is empty');
      if (def.definition.trim() === '') at('definition is empty');
      if (def.decimals !== null && !(Number.isInteger(def.decimals) && def.decimals >= 0)) {
        at('decimals is neither null nor a non-negative integer');
      }
      if (def.type === 'enum' && (def.enumValues ?? []).length === 0) {
        at("type 'enum' without enumValues");
      }
      if (def.type !== 'enum' && def.enumValues !== undefined) {
        at("enumValues on a non-'enum' type");
      }
      if (new Set(def.assetClasses).size !== def.assetClasses.length) at('assetClasses repeats');
      if (def.since === '') at('since is empty');
    }
    expect(problems).toEqual([]);
  });

  it('gives every real field a source, and every sourceless entry is a deprecated placeholder', () => {
    // CONTRACTS §4.3 was harvested mechanically from prose, so it contains family prefixes
    // (`CHG_`, `ECO_`, `OPT_`), a screener token (`CPNTO`) and formula/section names (`SPREAD`,
    // `SPREADS`). The dictionary keeps them so the harvested list resolves, but marks them
    // deprecated with no asset class and no source — they must never look like real fields.
    const sourceless = fieldDefs.filter((d) => d.sources.length === 0);
    expect(sourceless.map((d) => d.id)).toEqual([
      'CHG_',
      'CPNTO',
      'ECO_',
      'OPT_',
      'SPREAD',
      'SPREADS',
    ]);
    for (const def of sourceless) {
      expect(def.deprecated, `${def.id} must be marked deprecated`).toBeDefined();
      expect(def.assetClasses, `${def.id} must claim no asset class`).toEqual([]);
      expect(def.definition.startsWith('Not a field')).toBe(true);
    }
    for (const def of fieldDefs) {
      if (sourceless.includes(def)) continue;
      expect(def.sources.length, `${def.id} has no source`).toBeGreaterThan(0);
      for (const src of def.sources) {
        expect(src.sourceId).not.toBe('');
        expect(src.endpoint).not.toBe('');
      }
    }
  });

  it('groups every field under one of the eight field classes', () => {
    const classes = [
      'price',
      'reference',
      'fundamental',
      'econ',
      'news',
      'analytic',
      'derived',
      'portfolio',
    ] as const;
    const seen = new Set(fieldDefs.map((d) => d.fieldClass));
    expect([...seen].filter((c) => !classes.includes(c))).toEqual([]);

    for (const fieldClass of seen) {
      const filtered = listFields({ fieldClass });
      expect(filtered.every((d) => d.fieldClass === fieldClass)).toBe(true);
      expect(filtered).toHaveLength(fieldDefs.filter((d) => d.fieldClass === fieldClass).length);
    }
  });

  it('filters by asset class, and a subject-only field matches no asset class', () => {
    const equity = listFields({ assetClass: 'equity' });
    expect(equity.every((d) => d.assetClasses.includes('equity'))).toBe(true);
    const subjectOnly = fieldDefs.filter((d) => d.assetClasses.length === 0);
    for (const def of subjectOnly) {
      expect(equity.some((d) => d.id === def.id)).toBe(false);
    }
    expect(listFields()).toEqual([...fieldDefs]);
  });

  it('returns a copy from listFields, so a caller cannot corrupt the dictionary', () => {
    const list = listFields();
    list.length = 0;
    expect(fieldDefs.length).toBe(FIELD_COUNT);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. gen:fields output === the committed fields.json
// ---------------------------------------------------------------------------------------------

describe('gen:fields — the committed artefact is in sync', () => {
  const committed = readFileSync(FIELDS_JSON, 'utf8');

  it('matches what scripts/gen-fields.ts writes, byte for byte', () => {
    const expected = `${JSON.stringify(
      {
        version: fieldDictionary.version,
        generatedAt: fieldDictionary.generatedAt,
        fields: fieldDictionary.fields,
      },
      null,
      2,
    )}\n`;
    expect(committed).toBe(expected);
  });

  it('parses to the same field set the dictionary exposes', () => {
    const parsed = JSON.parse(committed) as {
      version: string;
      generatedAt: string;
      fields: FieldDef[];
    };
    expect(parsed.version).toBe(FIELD_DICTIONARY_VERSION);
    expect(parsed.generatedAt).toBe(FIELD_DICTIONARY_GENERATED_AT);
    expect(parsed.fields.map((f) => f.id)).toEqual(fieldIds());
    expect(parsed.fields.map((f) => f.id)).toEqual([...DESIGNED_FIELD_IDS].sort());
  });

  it('passes `gen:fields --check` (which also validates defs/*.ts and the generated barrel)', () => {
    // `tsx` runs the generator's TypeScript directly; `--check` writes nothing and exits
    // non-zero when either generated artefact is stale.
    const output = execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
        'scripts/gen-fields.ts',
        '--check',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(output).toContain(`${FIELD_COUNT} fields in 8 classes`);
    expect(output).toContain(`dictionary v${FIELD_DICTIONARY_VERSION}`);
    expect(output).not.toContain('STALE');
  }, 120_000);
});
