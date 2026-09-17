// packages/core/src/fields/format.ts
//
// THE formatter (ARCHITECTURE §15, API.md §7). A field is rendered the same way on the screen, in
// the HELP overlay and in the SDK because every one of them calls this function; the CSV is the one
// place that deliberately does not (it emits full stored precision — FUNCTIONS.md §1.6 rule 2).
//
// Constraints this file lives under:
//   * `packages/core` is pure and has no ambient clock — the `Date` global is banned by ESLint, so
//     every epoch-millisecond conversion below is arithmetic (Howard Hinnant's civil-from-days).
//   * Numbers arrive as numbers *or* as strings: `numeric` columns are read out of Postgres as
//     strings and parsed exactly once, here, at the API boundary (DATA_MODEL.md L2635).

import type { FieldDef, FieldId, FieldValue } from '../types/fields.js';
import { getField } from './dictionary.js';

/** The nine renderings a cell can ask for (`Cell.fmt`, FUNCTIONS.md §1.5). */
export type FieldFormat =
  'px' | 'pct' | 'bp' | 'int' | 'ccy' | 'date' | 'datetime' | 'text' | 'shares';

export interface FormatOptions {
  /** Override the rendering the dictionary implies (a `Cell.fmt` always wins over the unit). */
  fmt?: FieldFormat;
  /** Override the decimal count (a `Cell.decimals` always wins over the dictionary). */
  decimals?: number;
  /** `instruments.price_decimals`, used for `px` fields whose dictionary `decimals` is null. */
  priceDecimals?: number;
  /** BCP-47 tag. Omitted → a deterministic en-US-shaped grouping that never depends on ICU data. */
  locale?: string;
  /** ISO code for `ccy` cells; `instruments.currency` at the call site. */
  currency?: string;
  /** Rendering for `null`/unparseable values (TERM-12 shows an em dash). */
  blank?: string;
  /** Force a leading `+` on positive numbers (the `CHG_*` cells do). */
  signed?: boolean;
  /** Abbreviate large `shares`/`ccy`/`int` magnitudes as 1.23K/M/B/T. */
  compact?: boolean;
}

const DEFAULT_BLANK = '—';

const DEFAULT_DECIMALS: Readonly<Record<FieldFormat, number>> = {
  px: 2,
  pct: 2,
  bp: 1,
  int: 0,
  ccy: 2,
  shares: 0,
  date: 0,
  datetime: 0,
  text: 0,
};

const CURRENCY_SYMBOL: Readonly<Record<string, string>> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
  CHF: 'CHF ',
  CAD: 'C$',
  AUD: 'A$',
  HKD: 'HK$',
};

/** unit → rendering; the field's `type` decides when the unit is null (API.md §7). */
const formatOfDef = (def: FieldDef): FieldFormat => {
  switch (def.unit) {
    case 'price':
      return 'px';
    case 'pct':
      return 'pct';
    case 'bp':
      return 'bp';
    case 'shares':
      return 'shares';
    case 'ccy':
      return 'ccy';
    case 'contracts':
    case 'days':
    case 'count':
      return 'int';
    case 'ratio':
    case 'years':
    case 'bn':
      return 'px';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'text':
    case 'enum':
      return 'text';
    case null:
      break;
  }
  switch (def.type) {
    case 'integer':
      return 'int';
    case 'number':
      return 'px';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    default:
      return 'text';
  }
};

/** The rendering a field id implies, before any `Cell.fmt` override. */
export function formatOf(fieldId: FieldId): FieldFormat {
  const def = getField(fieldId);
  return def === undefined ? 'text' : formatOfDef(def);
}

/** The dictionary decimals of a field; `null` means "instrument price decimals or unit default". */
export function decimalsOf(fieldId: FieldId): number | null {
  return getField(fieldId)?.decimals ?? null;
}

/**
 * Render one field value.
 *
 * Unknown field ids do not throw — a screen may cite a field the dictionary has not caught up with
 * yet — they fall back to `opts.fmt`, then to the shape of the value itself.
 */
export function format(fieldId: FieldId, value: FieldValue, opts: FormatOptions = {}): string {
  const def = getField(fieldId);
  const fmt = opts.fmt ?? (def === undefined ? inferFormat(value) : formatOfDef(def));
  const decimals = opts.decimals ?? def?.decimals ?? undefined;
  return formatAs(fmt, value, decimals === undefined ? opts : { ...opts, decimals });
}

/** Render a value with an explicit rendering, for cells that carry `fmt` but no `fieldId`. */
export function formatAs(fmt: FieldFormat, value: FieldValue, opts: FormatOptions = {}): string {
  const blank = opts.blank ?? DEFAULT_BLANK;
  const v: unknown = value;
  if (v === null || v === undefined || v === '') return blank;

  switch (fmt) {
    case 'date':
      return toIsoDate(v) ?? blank;
    case 'datetime':
      return toIsoDateTime(v) ?? blank;
    case 'text':
      return asText(v);
    default:
      break;
  }

  const n = toNumber(v);
  if (n === null) return typeof v === 'string' ? v : blank;

  const decimals = opts.decimals ?? defaultDecimals(fmt, opts);
  switch (fmt) {
    case 'px':
      return signed(n, fixed(n, decimals, opts), opts);
    case 'pct':
      return `${signed(n, fixed(n, decimals, opts), opts)}%`;
    case 'bp':
      return `${signed(n, fixed(n, decimals, opts), opts)} bp`;
    case 'int':
      return signed(n, magnitude(Math.round(n), 0, opts), opts);
    case 'shares':
      return signed(n, magnitude(n, decimals, opts), opts);
    case 'ccy':
      return currency(n, decimals, opts);
    default:
      // 'date' | 'datetime' | 'text' already returned above; kept total for exhaustiveness.
      return asText(v);
  }
}

/** Stringify a field value without ever falling back to `[object Object]`. */
const asText = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v) ?? '';
};

const defaultDecimals = (fmt: FieldFormat, opts: FormatOptions): number =>
  fmt === 'px' ? (opts.priceDecimals ?? DEFAULT_DECIMALS.px) : DEFAULT_DECIMALS[fmt];

const inferFormat = (value: FieldValue): FieldFormat => {
  const v: unknown = value;
  if (typeof v === 'number') return 'px';
  if (typeof v === 'string' && isIsoDateTime(v)) return 'datetime';
  if (typeof v === 'string' && isIsoDate(v)) return 'date';
  return 'text';
};

// ── numbers ───────────────────────────────────────────────────────────────────────────────────

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Parse a field value into a finite number, or `null` when it is not one. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const text = value.trim();
    return NUMERIC.test(text) ? asFinite(Number(text)) : null;
  }
  return null;
}

const asFinite = (n: number): number | null => (Number.isFinite(n) ? n : null);

const signed = (n: number, text: string, opts: FormatOptions): string =>
  opts.signed === true && n > 0 ? `+${text}` : text;

const fixed = (n: number, decimals: number, opts: FormatOptions): string =>
  group(n === 0 ? 0 : n, decimals, opts.locale);

const COMPACT_UNITS: readonly { limit: number; suffix: string }[] = [
  { limit: 1e12, suffix: 'T' },
  { limit: 1e9, suffix: 'B' },
  { limit: 1e6, suffix: 'M' },
  { limit: 1e3, suffix: 'K' },
];

/** Grouped integer/decimal, abbreviated to K/M/B/T when `compact` is set. */
const magnitude = (n: number, decimals: number, opts: FormatOptions): string => {
  if (opts.compact !== true) return group(n === 0 ? 0 : n, decimals, opts.locale);
  const abs = Math.abs(n);
  for (const { limit, suffix } of COMPACT_UNITS) {
    if (abs >= limit) return `${group(n / limit, 2, opts.locale)}${suffix}`;
  }
  return group(n === 0 ? 0 : n, decimals, opts.locale);
};

const currency = (n: number, decimals: number, opts: FormatOptions): string => {
  const code = opts.currency;
  const body = magnitude(Math.abs(n), decimals, opts);
  const symbol = code === undefined ? '' : (CURRENCY_SYMBOL[code] ?? `${code} `);
  const sign = n < 0 ? '-' : opts.signed === true && n > 0 ? '+' : '';
  return `${sign}${symbol}${body}`;
};

/**
 * Fixed-decimal rendering with thousands separators. Without a `locale` the grouping is done here
 * (`1,234.50`) so output never varies with the host's ICU data; with one, `Intl` decides.
 */
const group = (n: number, decimals: number, locale?: string): string => {
  if (locale !== undefined && typeof Intl !== 'undefined') {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: true,
    }).format(n);
  }
  const text = n.toFixed(decimals);
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const dot = body.indexOf('.');
  const whole = dot === -1 ? body : body.slice(0, dot);
  const rest = dot === -1 ? '' : body.slice(dot);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${rest}`;
};

// ── dates, without the `Date` global ──────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

const isIsoDate = (text: string): boolean => ISO_DATE.test(text);
const isIsoDateTime = (text: string): boolean => ISO_DATETIME.test(text);

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** Howard Hinnant's `civil_from_days`: days since 1970-01-01 → calendar date, no `Date` needed. */
const civilFromDays = (z: number): { y: number; m: number; d: number } => {
  const shifted = z + 719_468;
  const era = Math.floor(shifted / 146_097);
  const doe = shifted - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
};

/** Epoch milliseconds → `YYYY-MM-DD` (UTC). */
export function isoDateFromEpochMs(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const days = Math.floor(ms / MS_PER_DAY);
  const { y, m, d } = civilFromDays(days);
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/** Epoch milliseconds → `YYYY-MM-DDTHH:MM:SSZ` (UTC; milliseconds kept when non-zero). */
export function isoDateTimeFromEpochMs(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const days = Math.floor(ms / MS_PER_DAY);
  const rest = ms - days * MS_PER_DAY;
  const millis = Math.floor(rest % 1000);
  const seconds = Math.floor(rest / 1000) % 60;
  const minutes = Math.floor(rest / 60_000) % 60;
  const hours = Math.floor(rest / 3_600_000);
  const fraction = millis === 0 ? '' : `.${pad(millis, 3)}`;
  return `${isoDateFromEpochMs(ms)}T${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${fraction}Z`;
}

const toIsoDate = (v: unknown): string | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? isoDateFromEpochMs(v) : null;
  if (typeof v === 'string' && isIsoDate(v)) return v.slice(0, 10);
  return null;
};

const toIsoDateTime = (v: unknown): string | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? isoDateTimeFromEpochMs(v) : null;
  if (typeof v !== 'string') return null;
  if (isIsoDateTime(v)) return v.trim().replace(' ', 'T');
  if (isIsoDate(v)) return `${v.slice(0, 10)}T00:00:00Z`;
  return null;
};
