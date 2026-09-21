/**
 * `data/fundamentals.ts` — the point-in-time fundamentals reader (STOR-06).
 *
 * WORKPLAN WP-04 L717-720 ("`fundamentals` (point-in-time read on `filed_at`)"),
 * DATA_MODEL §8.1 L1358-1365 (the declaration this file implements), FUNCTIONS §1.4.2 L296-300
 * (`DataServices.fundamentals`), FUNCTIONS_TIER2 FA/EE/EQS/RV, FUNCTIONS_TIER1 DES.
 *
 * ## Why `knownAt` is a required parameter and never an option
 *
 * `xbrl_facts.filed_at` and `fin_statements.filed_at` are the *knowledge* axis of the SEC data:
 * a restatement does not overwrite the number a company reported in February, it adds a row
 * filed in July that covers the same `period_end`. A reader that ignores `filed_at` therefore
 * answers a 2025 question with a 2026 number, and every backtest, every EQS screen re-run and
 * every "what did the screen show that day" reconciliation silently becomes wrong — the failure
 * is invisible because the shape of the answer is right. That is why ARCHITECTURE §13 states
 * that `fundamentals.facts(…, knownAt)` has **no overload without `knownAt`**, and why every
 * public read in this file takes it as a positional, non-optional argument. There is deliberately
 * no default, no `knownAt = new Date()` and no `latest()` shortcut: a caller that wants today's
 * view passes `ctx.asOf.knownAt`, which for an interactive request *is* today.
 *
 * ## The read
 *
 * Both reads are `DISTINCT ON (<period key>) … ORDER BY <period key>, filed_at DESC` over rows
 * with `filed_at <= knownAt`: per period, the newest version that was already public at
 * `knownAt`. `filed_at` is a `date` (the SEC publishes a filing date, not an instant), so the
 * comparison is made on the UTC calendar day of `knownAt` — a filing is knowable from the start
 * of the day it was filed. The finer instant, `filings.accepted_at`, is what
 * `data/filings.ts` exposes and what a news/earnings-timing caller should use.
 *
 * `statements()` additionally reports `restated`: true when more than one version of that period
 * was already public at `knownAt`, which is what FA's "restated" marker renders (FUNCTIONS_TIER2
 * L80). It is computed by a window `count(*) OVER (PARTITION BY period_end)` evaluated *before*
 * `DISTINCT ON` collapses the versions, so it costs no second round trip.
 *
 * ## Signature reconciliation (§18)
 *
 * DATA_MODEL §8.1 keys `statements` on `issuer_id` (the table's own key) while FUNCTIONS §1.4.2
 * keys it on `cik` (what a resolver holds). Both are implemented and neither is a wrapper with a
 * different meaning: {@link FundamentalsService.statements} is the DATA_MODEL declaration and
 * {@link FundamentalsService.statementsForCik} is the FUNCTIONS one, resolving `cik → issuer_id`
 * through the bitemporal `issuers` table as of the same instant. `frames()` takes `knownAt` as a
 * third argument, which FUNCTIONS §1.4.2 omits: `xbrl_frames` carries `captured_at` and a
 * nullable `filed_at`, so a frame read can be point-in-time too and the rule above admits no
 * exception. `FactsQuery.unit` is optional here although DATA_MODEL §8.1 declares it required —
 * DES asks for `dei:EntityCommonStockSharesOutstanding` (shares) and `dei:EntityPublicFloat`
 * (USD) in one call (FUNCTIONS_TIER1 L242), which a single required unit cannot express.
 *
 * Money and per-share columns are returned as `number | null`. `numeric` reaches the driver as a
 * string; every consumer of this service divides one column by another (PE, margins, growth —
 * FUNCTIONS_TIER2 L383), so the parse happens once here rather than in six resolvers, and a
 * value that does not parse finitely raises instead of becoming `NaN`.
 */

import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  lte,
  not,
  sql,
} from 'drizzle-orm';

import type { SQL } from 'drizzle-orm';

import { asOf, bitemporal } from '../db/bitemporal.js';
import type { AsOf } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';
import { finStatements, xbrlFacts, xbrlFrames } from '../db/schema/fundamentals.js';
import { issuers } from '../db/schema/reference.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Raised instead of returning a guess or a `NaN`. */
export class FundamentalsError extends Error {
  constructor(
    readonly code: 'bad_known_at' | 'bad_concept' | 'bad_numeric' | 'ambiguous_cik',
    message: string,
  ) {
    super(message);
    this.name = 'FundamentalsError';
  }
}

/** `'Q' | 'FY' | 'instant'` — DATA_MODEL §8.1. `'instant'` is a balance-sheet fact (no period start). */
export type PeriodSpec = 'Q' | 'FY' | 'instant' | 'any';

/** `'Q' | 'FY' | 'TTM'` — the `fin_statements.period_type` CHECK. */
export type StatementPeriodType = 'Q' | 'FY' | 'TTM';

/** The `statement` selector of FUNCTIONS §1.4.2; every one of them is a column of the same row. */
export type StatementKind = 'IS' | 'BS' | 'CF' | 'RATIOS' | 'PER_SHARE';

/** DATA_MODEL §8.1 `FactsQuery`, with `unit` optional (see the header, §18). */
export interface FactsQuery {
  /** Zero-padded 10-character CIK, as `issuers.cik` and `xbrl_facts.cik` store it. */
  cik: string;
  /** `'us-gaap:Revenues'`, or a bare `'Revenues'` which matches in any taxonomy. */
  concepts: string[];
  /** `'USD'`, `'shares'`, `'USD/shares'`, `'pure'`. Omitted → every unit. */
  unit?: string;
  periods: PeriodSpec;
  /** Inclusive ISO day bounds on `period_end`. */
  from?: string;
  to?: string;
  /** Applied after point-in-time selection and ordering (newest period first). */
  limit?: number;
}

/** One `xbrl_facts` row, point-in-time selected. */
export interface XbrlFact {
  factId: number;
  cik: string;
  issuerId: number | null;
  taxonomy: string;
  concept: string;
  unit: string;
  periodStart: string | null;
  periodEnd: string;
  fy: number | null;
  fp: string | null;
  form: string;
  accessionNo: string;
  /** The point-in-time key: the day this number became public. */
  filedAt: string;
  frame: string | null;
  value: number;
  capturedAt: string;
  provenanceId: number;
}

/** One `fin_statements` row: all five statement views are columns of it (FUNCTIONS_TIER2 L80). */
export interface FinStatement {
  issuerId: number;
  periodEnd: string;
  periodType: StatementPeriodType;
  /** The filing that produced this version. A restatement is a different row, not an update. */
  filedAt: string;
  mappingVersion: string;
  fiscalYear: number | null;
  fiscalPeriod: string | null;
  accessionNo: string;
  currency: string;
  /** More than one version of this `period_end` was already public at `knownAt`. */
  restated: boolean;
  /** How many versions qualified, including this one. */
  versions: number;
  derivedQ4: boolean;
  /** `{ standard_item: { concept, value, fact_id } }` — the FA "as reported" toggle. */
  asReported: Record<string, unknown>;
  builtAt: string;
  engine: { name: string; version: string; inputsHash: string };
  provenanceIds: number[];
  revenue: number | null;
  cogs: number | null;
  grossProfit: number | null;
  opex: number | null;
  rnd: number | null;
  operInc: number | null;
  intExp: number | null;
  pretaxInc: number | null;
  tax: number | null;
  netInc: number | null;
  epsBasic: number | null;
  epsDil: number | null;
  sharesDil: number | null;
  totAssets: number | null;
  totLiab: number | null;
  equity: number | null;
  cash: number | null;
  ltDebt: number | null;
  cfo: number | null;
  capex: number | null;
  fcf: number | null;
  divPaid: number | null;
  buyback: number | null;
  dps: number | null;
  dda: number | null;
}

/** FUNCTIONS §1.4.2 `statements(cik, q)`. */
export interface StatementsQuery {
  /** Kept for call-site clarity; all five selections read the same row, so it changes no SQL. */
  statement?: StatementKind;
  periodType: StatementPeriodType;
  /** How many periods, newest first. */
  periods: number;
  knownAt: Date;
  /** Pin the standardisation mapping (`'std-map/2026.09'`); omitted → the newest per period. */
  mappingVersion?: string;
  /** Inclusive upper bound on `period_end`. */
  to?: string;
  /** As-of instant for the `cik → issuer_id` lookup; omitted → `(knownAt, knownAt)`. */
  at?: AsOf;
}

/** One `xbrl_frames` row — the EQS cross-section (FUNCTIONS_TIER2 L384). */
export interface FrameValue {
  taxonomy: string;
  concept: string;
  unit: string;
  frame: string;
  cik: string;
  issuerId: number | null;
  accessionNo: string;
  periodEnd: string;
  value: number;
  /** `null` when the frames API did not carry one — then the row is *not* point-in-time. */
  filedAt: string | null;
  capturedAt: string;
  provenanceId: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

const btIssuers = bitemporal(issuers, 'issuerId');

/**
 * The UTC calendar day of `knownAt` — what `filed_at <= …` compares against.
 *
 * @throws FundamentalsError when `knownAt` is not a usable instant, rather than letting an
 *         `Invalid Date` turn into `'Invalid Date'.slice(0,10)` and a SQL type error.
 */
export function knownAtDay(knownAt: Date): string {
  const t = knownAt.getTime();
  if (!Number.isFinite(t)) {
    throw new FundamentalsError(
      'bad_known_at',
      'knownAt must be a valid Date: the point-in-time key of every fundamentals read (STOR-06)',
    );
  }
  return new Date(t).toISOString().slice(0, 10);
}

/** A NOT NULL `numeric` column. */
function numRequired(value: string, column: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new FundamentalsError(
      'bad_numeric',
      `${column} = ${JSON.stringify(value)} does not parse as a finite number`,
    );
  }
  return n;
}

function num(value: string | null, column: string): number | null {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new FundamentalsError(
      'bad_numeric',
      `fin_statements.${column} = ${JSON.stringify(value)} does not parse as a finite number`,
    );
  }
  return n;
}

/** `'us-gaap:Revenues'` → `{ taxonomy: 'us-gaap', concept: 'Revenues' }`; `'Revenues'` → any taxonomy. */
export function parseConceptRef(ref: string): { taxonomy: string | null; concept: string } {
  const trimmed = ref.trim();
  if (trimmed === '') {
    throw new FundamentalsError('bad_concept', 'an empty string is not an XBRL concept');
  }
  const colon = trimmed.indexOf(':');
  if (colon < 0) return { taxonomy: null, concept: trimmed };
  const taxonomy = trimmed.slice(0, colon);
  const concept = trimmed.slice(colon + 1);
  if (taxonomy === '' || concept === '') {
    throw new FundamentalsError(
      'bad_concept',
      `'${ref}' is not a '<taxonomy>:<concept>' reference (e.g. 'us-gaap:Revenues')`,
    );
  }
  return { taxonomy, concept };
}

/** `'us-gaap:Assets/USD'` → taxonomy, concept and unit (FUNCTIONS_TIER2 L384). */
export function parseFrameConcept(ref: string): {
  taxonomy: string | null;
  concept: string;
  unit: string | null;
} {
  const slash = ref.lastIndexOf('/');
  if (slash < 0) return { ...parseConceptRef(ref), unit: null };
  return { ...parseConceptRef(ref.slice(0, slash)), unit: ref.slice(slash + 1) };
}

/** The period predicate of `FactsQuery.periods`. */
function periodPredicate(periods: PeriodSpec): SQL | undefined {
  switch (periods) {
    // A balance-sheet fact: one instant, so no period start.
    case 'instant':
      return isNull(xbrlFacts.periodStart);
    // Duration facts. `fp` is the SEC's own fiscal-period tag; a quarterly fact carries Q1..Q4
    // and an annual one carries FY, which is more reliable than measuring the day span (a 10-K
    // covers 52 or 53 weeks and a transition period covers neither).
    case 'Q':
      return and(
        not(isNull(xbrlFacts.periodStart)),
        inArray(xbrlFacts.fp, ['Q1', 'Q2', 'Q3', 'Q4']),
      );
    case 'FY':
      return and(not(isNull(xbrlFacts.periodStart)), eq(xbrlFacts.fp, 'FY'));
    case 'any':
      return undefined;
  }
}

/** The `(taxonomy, concept)` disjunction for a concept list. */
function conceptPredicate(concepts: readonly string[]): SQL {
  const parsed = concepts.map(parseConceptRef);
  if (parsed.length === 0) {
    throw new FundamentalsError('bad_concept', 'facts() needs at least one concept');
  }
  const bare = parsed.filter((p) => p.taxonomy === null).map((p) => p.concept);
  const qualified = parsed.filter(
    (p): p is { taxonomy: string; concept: string } => p.taxonomy !== null,
  );
  const terms: SQL[] = [];
  if (bare.length > 0) terms.push(sql`(${inArray(xbrlFacts.concept, bare)})`);
  for (const q of qualified) {
    terms.push(
      sql`(${eq(xbrlFacts.taxonomy, q.taxonomy)} AND ${eq(xbrlFacts.concept, q.concept)})`,
    );
  }
  // Parenthesised as a whole: drizzle's `and()` brackets the conjunction, not each operand, so a
  // bare `a OR b` here would bind as `… AND a OR b …` and quietly widen every other filter.
  return sql`(${sql.join(terms, sql` OR `)})`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The fundamentals reader. One instance per transaction, like every other repository in this
 * package: `new FundamentalsService(tx)` inside `withTx`.
 */
export class FundamentalsService {
  constructor(private readonly tx: Tx) {}

  /**
   * DATA_MODEL §8.1 `facts(q, knownAt)` — the XBRL facts for `q.concepts`, one row per
   * `(taxonomy, concept, unit, period)`: the newest version filed on or before `knownAt`.
   *
   * Newest period first. A concept with no qualifying fact is simply absent from the result —
   * the caller reports `NO_SOURCE` for the field it wanted, it is never a zero.
   */
  async facts(q: FactsQuery, knownAt: Date): Promise<XbrlFact[]> {
    const day = knownAtDay(knownAt);
    const filters: (SQL | undefined)[] = [
      eq(xbrlFacts.cik, q.cik),
      conceptPredicate(q.concepts),
      lte(xbrlFacts.filedAt, day),
      periodPredicate(q.periods),
    ];
    if (q.unit !== undefined) filters.push(eq(xbrlFacts.unit, q.unit));
    if (q.from !== undefined) filters.push(gte(xbrlFacts.periodEnd, q.from));
    if (q.to !== undefined) filters.push(lte(xbrlFacts.periodEnd, q.to));

    const rows = await this.tx
      .selectDistinctOn([
        xbrlFacts.taxonomy,
        xbrlFacts.concept,
        xbrlFacts.unit,
        xbrlFacts.periodStart,
        xbrlFacts.periodEnd,
      ])
      .from(xbrlFacts)
      .where(and(...filters))
      .orderBy(
        asc(xbrlFacts.taxonomy),
        asc(xbrlFacts.concept),
        asc(xbrlFacts.unit),
        asc(xbrlFacts.periodStart),
        asc(xbrlFacts.periodEnd),
        // …and, within one period, the latest filing that was public at knownAt. `fact_id`
        // breaks a tie between two facts of the same filing day deterministically.
        desc(xbrlFacts.filedAt),
        desc(xbrlFacts.factId),
      );

    const facts = rows.map((r): XbrlFact => ({
      factId: Number(r.factId),
      cik: r.cik,
      issuerId: r.issuerId === null ? null : Number(r.issuerId),
      taxonomy: r.taxonomy,
      concept: r.concept,
      unit: r.unit,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      fy: r.fy,
      fp: r.fp,
      form: r.form,
      accessionNo: r.accessionNo,
      filedAt: r.filedAt,
      frame: r.frame,
      value: numRequired(r.value, 'xbrl_facts.value'),
      capturedAt: r.capturedAt,
      provenanceId: Number(r.provenanceId),
    }));

    // `DISTINCT ON` fixes the SQL ordering; the caller wants newest period first.
    facts.sort((a, b) => {
      if (a.periodEnd !== b.periodEnd) return a.periodEnd < b.periodEnd ? 1 : -1;
      if (a.concept !== b.concept) return a.concept < b.concept ? -1 : 1;
      return a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0;
    });
    return q.limit === undefined ? facts : facts.slice(0, Math.max(0, q.limit));
  }

  /**
   * Every stored vintage of one concept and period, oldest filing first — the restatement
   * history itself, for FA's "as reported" audit view and for the STOR-06 test.
   *
   * `knownAt` still bounds it: a vintage filed after `knownAt` was not knowable then.
   */
  async factVintages(
    q: { cik: string; concept: string; unit?: string; periodEnd: string; periodStart?: string },
    knownAt: Date,
  ): Promise<XbrlFact[]> {
    const day = knownAtDay(knownAt);
    const filters: (SQL | undefined)[] = [
      eq(xbrlFacts.cik, q.cik),
      conceptPredicate([q.concept]),
      eq(xbrlFacts.periodEnd, q.periodEnd),
      lte(xbrlFacts.filedAt, day),
    ];
    if (q.unit !== undefined) filters.push(eq(xbrlFacts.unit, q.unit));
    if (q.periodStart !== undefined) filters.push(eq(xbrlFacts.periodStart, q.periodStart));

    const rows = await this.tx
      .select()
      .from(xbrlFacts)
      .where(and(...filters))
      .orderBy(asc(xbrlFacts.filedAt), asc(xbrlFacts.factId));

    return rows.map((r): XbrlFact => ({
      factId: Number(r.factId),
      cik: r.cik,
      issuerId: r.issuerId === null ? null : Number(r.issuerId),
      taxonomy: r.taxonomy,
      concept: r.concept,
      unit: r.unit,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      fy: r.fy,
      fp: r.fp,
      form: r.form,
      accessionNo: r.accessionNo,
      filedAt: r.filedAt,
      frame: r.frame,
      value: numRequired(r.value, 'xbrl_facts.value'),
      capturedAt: r.capturedAt,
      provenanceId: Number(r.provenanceId),
    }));
  }

  /**
   * DATA_MODEL §8.1 `statements(issuerId, periodType, knownAt, n?)` — the `n` newest periods,
   * each at the newest version public at `knownAt`.
   *
   * @param n how many periods; default 8 (two years of quarters, FA's default page).
   */
  async statements(
    issuerId: number,
    periodType: StatementPeriodType,
    knownAt: Date,
    n = 8,
    opts: { mappingVersion?: string; to?: string } = {},
  ): Promise<FinStatement[]> {
    const day = knownAtDay(knownAt);
    const filters: (SQL | undefined)[] = [
      eq(finStatements.issuerId, issuerId),
      eq(finStatements.periodType, periodType),
      lte(finStatements.filedAt, day),
    ];
    if (opts.mappingVersion !== undefined) {
      filters.push(eq(finStatements.mappingVersion, opts.mappingVersion));
    }
    if (opts.to !== undefined) filters.push(lte(finStatements.periodEnd, opts.to));

    const rows = await this.tx
      .selectDistinctOn([finStatements.periodEnd], {
        ...getTableColumns(finStatements),
        // Window functions are evaluated before DISTINCT ON, so this counts every version of the
        // period that was public at knownAt — not the one version DISTINCT ON keeps.
        versions: sql<string>`count(*) OVER (PARTITION BY ${finStatements.periodEnd})`.as(
          'versions',
        ),
      })
      .from(finStatements)
      .where(and(...filters))
      .orderBy(
        desc(finStatements.periodEnd),
        desc(finStatements.filedAt),
        desc(finStatements.mappingVersion),
      )
      .limit(Math.max(0, n));

    return rows.map((r) => toFinStatement(r));
  }

  /**
   * FUNCTIONS §1.4.2 `statements(cik, q)` — the same read keyed on the CIK a resolver holds.
   *
   * Returns `[]` when the CIK has no issuer at `q.at` (a company whose master row has not been
   * written yet); call {@link resolveIssuerId} to tell that apart from "issuer known, no
   * statements ingested", which is the distinction FA needs for its `NO_SOURCE` detail.
   */
  async statementsForCik(cik: string, q: StatementsQuery): Promise<FinStatement[]> {
    const at = q.at ?? { validAt: q.knownAt, knownAt: q.knownAt };
    const issuerId = await this.resolveIssuerId(cik, at);
    if (issuerId === null) return [];
    const opts: { mappingVersion?: string; to?: string } = {};
    if (q.mappingVersion !== undefined) opts.mappingVersion = q.mappingVersion;
    if (q.to !== undefined) opts.to = q.to;
    return this.statements(issuerId, q.periodType, q.knownAt, q.periods, opts);
  }

  /**
   * `cik → issuer_id` through the bitemporal `issuers` table, as of `at`.
   *
   * @throws FundamentalsError when the CIK maps to more than one issuer at that instant —
   *         a master-data defect, never resolved by picking one (REF-01).
   */
  async resolveIssuerId(cik: string, at: AsOf): Promise<number | null> {
    const rows = await this.tx
      .select({ issuerId: issuers.issuerId })
      .from(issuers)
      .where(and(eq(issuers.cik, cik), asOf(btIssuers, at)))
      .orderBy(asc(issuers.issuerId));
    const first = rows[0];
    if (first === undefined) return null;
    if (rows.length > 1) {
      throw new FundamentalsError(
        'ambiguous_cik',
        `CIK ${cik} resolves to ${String(rows.length)} issuers as of ` +
          `${at.validAt.toISOString()} / ${at.knownAt.toISOString()}; a CIK identifies one filer, ` +
          'so this is a master-data defect and is not resolved by guessing',
      );
    }
    return Number(first.issuerId);
  }

  /**
   * DATA_MODEL §8.1 `crossSection(concept, frame, knownAt)` — the EQS cross-section.
   *
   * `xbrl_frames` is not versioned per filing (the SEC frames API publishes one value per CIK per
   * canonical period), so the point-in-time bound is `captured_at <= knownAt` plus, where the row
   * carries one, `filed_at <= knownAt`. A row with `filed_at IS NULL` is *not* point-in-time;
   * it is returned with `filedAt: null` so the caller can raise `FRAMES_NOT_POINT_IN_TIME`
   * (DATA_MODEL §20 decision 4, FUNCTIONS_TIER2 L384).
   */
  async crossSection(concept: string, frame: string, knownAt: Date): Promise<FrameValue[]> {
    const day = knownAtDay(knownAt);
    const ref = parseFrameConcept(concept);
    const filters: (SQL | undefined)[] = [
      eq(xbrlFrames.concept, ref.concept),
      eq(xbrlFrames.frame, frame),
      lte(xbrlFrames.capturedAt, knownAt.toISOString()),
      sql`(${xbrlFrames.filedAt} IS NULL OR ${xbrlFrames.filedAt} <= ${day})`,
    ];
    if (ref.taxonomy !== null) filters.push(eq(xbrlFrames.taxonomy, ref.taxonomy));
    if (ref.unit !== null) filters.push(eq(xbrlFrames.unit, ref.unit));

    const rows = await this.tx
      .select()
      .from(xbrlFrames)
      .where(and(...filters))
      .orderBy(asc(xbrlFrames.cik));

    return rows.map((r): FrameValue => ({
      taxonomy: r.taxonomy,
      concept: r.concept,
      unit: r.unit,
      frame: r.frame,
      cik: r.cik,
      issuerId: r.issuerId === null ? null : Number(r.issuerId),
      accessionNo: r.accessionNo,
      periodEnd: r.periodEnd,
      value: numRequired(r.value, 'xbrl_frames.value'),
      filedAt: r.filedAt,
      capturedAt: r.capturedAt,
      provenanceId: Number(r.provenanceId),
    }));
  }

  /**
   * FUNCTIONS §1.4.2 `frames(concept, period)` — `cik → value`, with the `knownAt` bound this
   * file admits no exception to (§18). Duplicate CIKs cannot occur: `(taxonomy, concept, unit,
   * frame, cik)` is the primary key.
   */
  async frames(concept: string, frame: string, knownAt: Date): Promise<Map<string, number>> {
    const rows = await this.crossSection(concept, frame, knownAt);
    return new Map(rows.map((r) => [r.cik, r.value]));
  }
}

type FinStatementRow = typeof finStatements.$inferSelect & { versions: string };

function toFinStatement(r: FinStatementRow): FinStatement {
  const versions = Number(r.versions);
  const periodType = r.periodType;
  if (periodType !== 'Q' && periodType !== 'FY' && periodType !== 'TTM') {
    throw new FundamentalsError(
      'bad_numeric',
      `fin_statements.period_type = ${JSON.stringify(periodType)} is outside the CHECK constraint`,
    );
  }
  return {
    issuerId: Number(r.issuerId),
    periodEnd: r.periodEnd,
    periodType,
    filedAt: r.filedAt,
    mappingVersion: r.mappingVersion,
    fiscalYear: r.fiscalYear,
    fiscalPeriod: r.fiscalPeriod,
    accessionNo: r.accessionNo,
    currency: r.currency,
    restated: versions > 1,
    versions,
    derivedQ4: r.derivedQ4,
    asReported: (r.asReported ?? {}) as Record<string, unknown>,
    builtAt: r.builtAt,
    engine: { name: r.engineName, version: r.engineVersion, inputsHash: r.inputsHash },
    provenanceIds: r.provenanceIds.map((id) => Number(id)),
    revenue: num(r.revenue, 'revenue'),
    cogs: num(r.cogs, 'cogs'),
    grossProfit: num(r.grossProfit, 'gross_profit'),
    opex: num(r.opex, 'opex'),
    rnd: num(r.rnd, 'rnd'),
    operInc: num(r.operInc, 'oper_inc'),
    intExp: num(r.intExp, 'int_exp'),
    pretaxInc: num(r.pretaxInc, 'pretax_inc'),
    tax: num(r.tax, 'tax'),
    netInc: num(r.netInc, 'net_inc'),
    epsBasic: num(r.epsBasic, 'eps_basic'),
    epsDil: num(r.epsDil, 'eps_dil'),
    sharesDil: num(r.sharesDil, 'shares_dil'),
    totAssets: num(r.totAssets, 'tot_assets'),
    totLiab: num(r.totLiab, 'tot_liab'),
    equity: num(r.equity, 'equity'),
    cash: num(r.cash, 'cash'),
    ltDebt: num(r.ltDebt, 'lt_debt'),
    cfo: num(r.cfo, 'cfo'),
    capex: num(r.capex, 'capex'),
    fcf: num(r.fcf, 'fcf'),
    divPaid: num(r.divPaid, 'div_paid'),
    buyback: num(r.buyback, 'buyback'),
    dps: num(r.dps, 'dps'),
    dda: num(r.dda, 'dda'),
  };
}
