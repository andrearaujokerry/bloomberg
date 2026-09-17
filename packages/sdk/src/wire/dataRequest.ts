/**
 * `wire/dataRequest.ts` — the one request model (API-02), transcribed from API.md §4 L299-369.
 *
 * `POST /data` is the single data endpoint; the five kinds share `securities`, `fields`, `asOf` and
 * `usage`, and return one `DataResponse`. `kind:'realtime'` is the same object the SDK turns into a
 * WS `sub` (§6, §10): on REST it returns the plant's current entitlement-filtered view (one-shot)
 * plus the subjects to subscribe to, so a caller can prime a grid and then stream without a second
 * vocabulary. Convenience GETs (§5.4) build the same object and go through the same dispatcher
 * (`server/src/data/request.ts`).
 */
import { z } from 'zod';

import {
  AdjustPolicy,
  AsOf,
  ErrorCode,
  FieldId,
  FieldValue,
  InstrumentSummary,
  Meta,
  Periodicity,
  SecurityRefInput,
  SessionState,
  SubjectId,
  Tier,
  UsageType,
  ValueState,
} from './envelope.js';
import { ReasonCode } from './reasonCodes.js';

const Base = z.object({
  securities: z.array(SecurityRefInput).min(1),
  fields: z.array(FieldId).min(1),
  // REF-03: validAt = "as of when in the world", knownAt = "as of what we knew"
  asOf: AsOf.optional(),
  // bearer sessions are forced to 'api'; export routes force 'export'
  usage: UsageType.default('display'),
});

export const DataRequest = z.discriminatedUnion('kind', [
  // security master, terms, classifications, PIT fundamentals
  Base.extend({
    kind: z.literal('reference'),
    securities: z.array(SecurityRefInput).min(1).max(500),
    fields: z.array(FieldId).min(1).max(200),
  }),
  // bars_daily resampled; corporate actions applied on read (REF-09)
  Base.extend({
    kind: z.literal('historical'),
    securities: z.array(SecurityRefInput).min(1).max(50),
    fields: z
      .array(FieldId)
      .min(1)
      .max(20)
      .default(['PX_OPEN', 'PX_HIGH', 'PX_LOW', 'PX_LAST', 'PX_VOLUME']),
    start: z.iso.date(),
    end: z.iso.date().optional(), // end defaults to validAt's date
    periodicity: Periodicity.default('D'),
    adjust: AdjustPolicy.default('price'),
    currency: z.string().length(3).optional(), // convert via fx_rates at each session date
    fill: z.enum(['none', 'prev']).default('none'),
    // CHRT-03 multi-security alignment
    calendarAlign: z.enum(['primary', 'union', 'intersection']).default('primary'),
  }),
  // bars_intraday
  Base.extend({
    kind: z.literal('intraday'),
    securities: z.array(SecurityRefInput).min(1).max(20),
    fields: z
      .array(FieldId)
      .min(1)
      .max(10)
      .default(['PX_OPEN', 'PX_HIGH', 'PX_LOW', 'PX_LAST', 'PX_VOLUME']),
    start: z.iso.datetime(),
    end: z.iso.datetime().optional(),
    // 15m/1h resampled from 5m/1m on read
    interval: z.enum(['1m', '5m', '15m', '1h']).default('1m'),
    session: z.enum(['regular', 'extended']).default('regular'),
  }),
  // quote_ticks (delayed observations, STOR-01 analogue)
  Base.extend({
    kind: z.literal('tick'),
    securities: z.array(SecurityRefInput).min(1).max(5),
    fields: z
      .array(FieldId)
      .min(1)
      .max(20)
      .default(['PX_LAST', 'LAST_SIZE', 'PX_BID', 'PX_ASK', 'BID_SIZE', 'ASK_SIZE', 'PX_VOLUME']),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    kinds: z.array(z.enum(['trade', 'quote', 'summary'])).default(['trade', 'quote']),
    limit: z.number().int().min(1).max(100000).default(10000),
    cursor: z.string().optional(),
  }),
  // plant view now (REST) / subscription (WS)
  Base.extend({
    kind: z.literal('realtime'),
    securities: z.array(SecurityRefInput).min(1).max(10000),
    fields: z.array(FieldId).min(1).max(100),
    tier: Tier.optional(), // requested; effective tier is per-field in the response
    // used by the SDK when it opens the subscription
    conflationMs: z.number().int().min(50).max(5000).optional(),
    // which subject family to map securities onto (§6.1)
    subjectKind: z.enum(['q', 'l', 'b1m', 'oc']).default('q'),
  }),
]);
export type DataRequest = z.infer<typeof DataRequest>;
/** Caller-facing shape: every `.default()` field may be omitted. */
export type DataRequestInput = z.input<typeof DataRequest>;

export type DataKind = DataRequest['kind'];
export const DATA_KINDS = [
  'reference',
  'historical',
  'intraday',
  'tick',
  'realtime',
] as const satisfies readonly DataKind[];
export type DataRequestOf<K extends DataKind> = Extract<DataRequest, { kind: K }>;

/** historical / intraday: column-major-friendly, one block per security */
export const SeriesBlock = z.object({
  columns: z.array(FieldId),
  // 'YYYY-MM-DD' (historical) or ISO datetime (intraday, bar start UTC)
  index: z.array(z.string()),
  // rows[i][j] = value of columns[j] at index[i]
  rows: z.array(z.array(z.number().nullable())),
  adjust: AdjustPolicy.optional(),
  currency: z.string().length(3),
  // meta.provenance indexes cited by this block
  provIdx: z.array(z.number().int()),
});
export type SeriesBlock = z.infer<typeof SeriesBlock>;

/** quote_ticks columns (DATA_MODEL §7.2) */
export const TickRow = z.object({
  // FEED-05
  capTs: z.iso.datetime(),
  srcTs: z.iso.datetime().nullable(),
  pubTs: z.iso.datetime().nullable(),
  kind: z.enum(['trade', 'quote', 'summary']),
  srcSeq: z.number().int().nullable(),
  mdLineId: z.number().int(),
  // the requested fields present on this tick
  f: z.record(z.string(), FieldValue),
  conditions: z.array(z.string()),
  provIdx: z.number().int(),
});
export type TickRow = z.infer<typeof TickRow>;

export const RealtimeSubject = z.object({
  subject: SubjectId,
  fields: z.array(FieldId),
  tier: Tier,
  reason: ReasonCode,
});
export type RealtimeSubject = z.infer<typeof RealtimeSubject>;

export const DataResult = z.object({
  security: SecurityRefInput, // echoed request
  instrument: InstrumentSummary.nullable(), // null + error when unresolved
  error: z
    .object({
      code: ErrorCode,
      message: z.string(),
      candidates: z.array(InstrumentSummary).optional(),
    })
    .optional(),
  // kind:'reference' | 'realtime'
  fields: z.record(z.string(), FieldValue).optional(), // null = blank (see r) or not applicable
  r: z.record(z.string(), ReasonCode).optional(), // per-field reason when null (ENTL-05)
  fts: z.record(z.string(), z.iso.datetime()).optional(), // per-field source timestamp
  // per-field provenance idx (reference: each field may come from a different source)
  fprov: z.record(z.string(), z.number().int()).optional(),
  // kind:'historical' | 'intraday'
  series: SeriesBlock.optional(),
  // kind:'tick'
  ticks: z.array(TickRow).optional(),
  nextCursor: z.string().nullable().optional(),
  // kind:'realtime'
  subject: RealtimeSubject.optional(),
  tier: Tier,
  st: ValueState,
  session: SessionState.optional(),
  // FEED-05 (reference/realtime)
  ts: z
    .object({
      src: z.iso.datetime().nullable(),
      cap: z.iso.datetime(),
      pub: z.iso.datetime(),
    })
    .optional(),
});
export type DataResult = z.infer<typeof DataResult>;

export const DataResponse = z.object({ meta: Meta, results: z.array(DataResult) });
export type DataResponse = z.infer<typeof DataResponse>;
