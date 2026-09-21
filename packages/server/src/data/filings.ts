/**
 * `data/filings.ts` — the SEC EDGAR filing index reader (WORKPLAN WP-04 L719, DATA-06/NEWS-04).
 *
 * FUNCTIONS §1.4.2 L303: `filings.list(cik, { forms?, from?, to?, cursor?, limit })` →
 * `{ items, nextCursor, total }`. Consumed by DES (recent filings), FA (fund documents), EE
 * (the 8-K item 2.02 that carries an earnings release), CN (the NEWS-04 filings fold-in) and
 * CACS (8-K/A corrections) — FUNCTIONS_TIER1 L241/L446, FUNCTIONS_TIER2 L91/L216/L725/L904.
 *
 * ## Ordering and the cursor
 *
 * Newest first, `(filed_date DESC, accession_no DESC)`. `filed_date` is a day, so it is not a
 * unique sort key; the accession number breaks the tie and, because EDGAR allocates it
 * monotonically per filer per year, does so in filing order. The pair is also the cursor: keyset
 * pagination, `WHERE filed_date < d OR (filed_date = d AND accession_no < a)`, so a page boundary
 * can neither skip nor repeat a filing when rows are ingested between two pages — which OFFSET
 * would do on exactly the table that grows at the head.
 *
 * The cursor is opaque to the caller (API.md L27: `{ items, nextCursor }`), base64url over
 * `<filed_date>|<accession_no>`, and is validated on the way back in: a malformed or foreign
 * cursor raises {@link FilingsError} rather than degrading into "page 1 again".
 *
 * ## Knowledge time
 *
 * `filings` is not bitemporal — a filing is a published, immutable document, and a correction is
 * a *new* filing whose form ends in `/A` (which is why `isCorrection` is derived from the form
 * rather than stored). The knowledge instant is therefore `accepted_at`, EDGAR's
 * `acceptanceDateTime`: the moment the document became public, and the instant WP-15's seed and
 * the bitemporal writer use as `txFrom` for anything derived from it. `filed_date` is the
 * calendar day and is what `data/fundamentals.ts` keys its point-in-time read on.
 */

import { and, asc, count, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';

import type { SQL } from 'drizzle-orm';

import type { Tx } from '../db/client.js';
import { filings } from '../db/schema/fundamentals.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Raised on a cursor that did not come from this service, or an unusable limit. */
export class FilingsError extends Error {
  constructor(
    readonly code: 'bad_cursor' | 'bad_limit',
    message: string,
  ) {
    super(message);
    this.name = 'FilingsError';
  }
}

/** One `filings` row. */
export interface Filing {
  accessionNo: string;
  cik: string;
  /** `null` until the issuer's master row exists (DATA_MODEL §8). */
  issuerId: number | null;
  /** `'10-K'`, `'8-K'`, `'8-K/A'`, `'NPORT-P'`, … */
  form: string;
  filedDate: string;
  /** `acceptanceDateTime` — the public-knowledge instant. `null` on older index rows. */
  acceptedAt: string | null;
  reportDate: string | null;
  /** 8-K item numbers: `['2.02','9.01']`. Empty for forms that carry none. */
  items: string[];
  primaryDoc: string | null;
  primaryDocDesc: string | null;
  isXbrl: boolean;
  isInlineXbrl: boolean;
  sizeBytes: number | null;
  url: string;
  capturedAt: string;
  provenanceId: number;
  /** `form` ends in `/A`: an amendment of an earlier filing (CN `isCorrection`). */
  isCorrection: boolean;
}

/** FUNCTIONS §1.4.2 `filings.list` query. */
export interface FilingsQuery {
  /** Form allow-list. Omitted, or empty, means every form. */
  forms?: string[];
  /** Inclusive ISO day bounds on `filed_date`. */
  from?: string;
  to?: string;
  /** Only 8-K-style filings carrying **all** of these item numbers (`['2.02']` — EE, CACS). */
  items?: string[];
  cursor?: string;
  limit: number;
}

/** One page. `total` counts the whole filtered set, not the page (API.md §2). */
export interface FilingsPage {
  items: Filing[];
  nextCursor: string | null;
  total: number;
}

/** The largest page this service will serve; a caller asking for more gets this many. */
export const MAX_FILINGS_LIMIT = 1000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cursor
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface FilingsCursor {
  filedDate: string;
  accessionNo: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `<filed_date>|<accession_no>`, base64url. Exported for the dispatcher's tests. */
export function encodeFilingsCursor(c: FilingsCursor): string {
  return Buffer.from(`${c.filedDate}|${c.accessionNo}`, 'utf8').toString('base64url');
}

/** @throws FilingsError when the cursor is not one {@link encodeFilingsCursor} produced. */
export function decodeFilingsCursor(cursor: string): FilingsCursor {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const bar = decoded.indexOf('|');
  const filedDate = bar < 0 ? '' : decoded.slice(0, bar);
  const accessionNo = bar < 0 ? '' : decoded.slice(bar + 1);
  if (!ISO_DAY.test(filedDate) || accessionNo === '') {
    throw new FilingsError(
      'bad_cursor',
      `'${cursor}' is not a filings cursor: expected base64url '<YYYY-MM-DD>|<accession-no>'`,
    );
  }
  return { filedDate, accessionNo };
}

function pageSize(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) {
    throw new FilingsError('bad_limit', `limit must be a positive integer, got ${String(limit)}`);
  }
  return Math.min(Math.trunc(limit), MAX_FILINGS_LIMIT);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One instance per transaction, like every repository in this package. */
export class FilingsService {
  constructor(private readonly tx: Tx) {}

  /** FUNCTIONS §1.4.2 `list(cik, q)` — one filer's filings, newest first. */
  list(cik: string, q: FilingsQuery): Promise<FilingsPage> {
    return this.page(eq(filings.cik, cik), q);
  }

  /**
   * The same page keyed on the resolved issuer rather than the CIK. A filer may carry more than
   * one CIK over its life (a reorganisation keeps the issuer and changes the CIK), so this is the
   * read to use once an `InstrumentDetail` is in hand.
   */
  listByIssuer(issuerId: number, q: FilingsQuery): Promise<FilingsPage> {
    return this.page(eq(filings.issuerId, issuerId), q);
  }

  /** One filing by its accession number, or `null`. */
  async get(accessionNo: string): Promise<Filing | null> {
    const rows = await this.tx
      .select()
      .from(filings)
      .where(eq(filings.accessionNo, accessionNo))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toFiling(row);
  }

  private async page(scope: SQL, q: FilingsQuery): Promise<FilingsPage> {
    const limit = pageSize(q.limit);
    const filters: (SQL | undefined)[] = [scope];
    if (q.forms !== undefined && q.forms.length > 0) filters.push(inArray(filings.form, q.forms));
    if (q.from !== undefined) filters.push(gte(filings.filedDate, q.from));
    if (q.to !== undefined) filters.push(lte(filings.filedDate, q.to));
    if (q.items !== undefined && q.items.length > 0) {
      // `items` is a text[]; `@>` is what `filings_items_idx` (GIN) answers. `sql.param` keeps
      // the array ONE parameter: a bare array inside a template is expanded by drizzle to
      // `(a, b, c)`, which is a row constructor and not a `text[]` (SQLSTATE 22P02).
      filters.push(sql`${filings.items} @> ${sql.param(q.items)}::text[]`);
    }
    const where = and(...filters);

    const totalRows = await this.tx.select({ n: count() }).from(filings).where(where);
    const total = Number(totalRows[0]?.n ?? 0);

    const paged: (SQL | undefined)[] = [where];
    if (q.cursor !== undefined) {
      const c = decodeFilingsCursor(q.cursor);
      // Keyset, not OFFSET: rows ingested at the head between two pages cannot shift the boundary.
      // `accession_no` is char(20) and every accession number is exactly 20 characters, so the
      // bpchar comparison never sees padding.
      paged.push(
        or(
          sql`${filings.filedDate} < ${c.filedDate}::date`,
          and(eq(filings.filedDate, c.filedDate), sql`${filings.accessionNo} < ${c.accessionNo}`),
        ),
      );
    }

    // One row more than asked for: its existence is what decides `nextCursor`, so an exactly-full
    // last page does not hand out a cursor that would resolve to an empty page.
    const rows = await this.tx
      .select()
      .from(filings)
      .where(and(...paged))
      .orderBy(desc(filings.filedDate), desc(filings.accessionNo))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(toFiling);
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? encodeFilingsCursor({ filedDate: last.filedDate, accessionNo: last.accessionNo })
        : null;
    return { items, nextCursor, total };
  }

  /**
   * The forms of one filer in filing order, oldest first — the shape the symbology and
   * fundamentals ingest jobs walk. Bounded by `limit` like every other read here.
   */
  async oldestFirst(cik: string, q: FilingsQuery): Promise<Filing[]> {
    const limit = pageSize(q.limit);
    const filters: (SQL | undefined)[] = [eq(filings.cik, cik)];
    if (q.forms !== undefined && q.forms.length > 0) filters.push(inArray(filings.form, q.forms));
    if (q.from !== undefined) filters.push(gte(filings.filedDate, q.from));
    if (q.to !== undefined) filters.push(lte(filings.filedDate, q.to));
    const rows = await this.tx
      .select()
      .from(filings)
      .where(and(...filters))
      .orderBy(asc(filings.filedDate), asc(filings.accessionNo))
      .limit(limit);
    return rows.map(toFiling);
  }
}

function toFiling(r: typeof filings.$inferSelect): Filing {
  return {
    accessionNo: r.accessionNo,
    cik: r.cik,
    issuerId: r.issuerId === null ? null : Number(r.issuerId),
    form: r.form,
    filedDate: r.filedDate,
    acceptedAt: r.acceptedAt,
    reportDate: r.reportDate,
    items: r.items,
    primaryDoc: r.primaryDoc,
    primaryDocDesc: r.primaryDocDesc,
    isXbrl: r.isXbrl,
    isInlineXbrl: r.isInlineXbrl,
    sizeBytes: r.sizeBytes,
    url: r.url,
    capturedAt: r.capturedAt,
    provenanceId: Number(r.provenanceId),
    isCorrection: r.form.endsWith('/A'),
  };
}
