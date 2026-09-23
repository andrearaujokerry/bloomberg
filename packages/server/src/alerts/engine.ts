/**
 * `alerts/engine.ts` — NEWS-07: the four alert kinds, `alert_events`, and the `alerts:me` fan-out.
 *
 * The engine is a sink, not a poller. Three of its four inputs are events the system already
 * produces — a plant delta, an ingested story, an accepted filing — and only the calendar kind is
 * driven by a tick, because "fifteen minutes before the CPI print" has no event of its own until
 * it happens. Nothing here reads a provider; nothing here invents a value.
 *
 * ## Firing exactly once
 *
 * A one-shot alert is claimed with a conditional `UPDATE … WHERE status = 'armed'`, and only the
 * statement that actually moved the row writes the event. Two deltas racing into the same alert
 * therefore produce one firing, not two, and the guarantee is the database's rather than a
 * best-effort in-memory flag. Repeating alerts are **edge-triggered**: a `PX_LAST >= 250` alert
 * fires when the price crosses into the condition, not on every tick it spends above it, which is
 * the difference between an alert and a firehose. `crosses` needs two observations by definition,
 * so the first delta after an alert is armed establishes the baseline and never fires.
 *
 * News, filing and calendar alerts dedupe on the subject of the firing — `newsId`, `accessionNo`,
 * `eventId` — read back out of `alert_events.payload`, so a re-ingest or a repeated tick cannot
 * re-notify.
 *
 * ## Delivery
 *
 * Every firing writes `alert_events` first and pushes afterwards. The durable row is the contract:
 * `GET /alerts/events` replays what a disconnected terminal missed, and the WS `alert` frame is an
 * optimisation on top of it. `delivered` records `inapp` when the owner asked for it; `email` and
 * `push` are recorded intents in v1 (API.md §5.11) and are written as `null` rather than as a
 * timestamp for a delivery that did not happen.
 *
 * ## Tenancy
 *
 * `alerts`, `alert_events` and `saved_searches` carry owner-scoped RLS policies (migration 0015
 * L142-146) that answer `app_user_id()`. The engine is a **fan-out**: one market event is evaluated
 * against every owner's alerts, so there is no `app_user_id()` it could adopt that would be honest,
 * and under a no-firm elevated context `alerts_owner` returns nothing at all — the engine used to
 * evaluate zero alerts in any deployment where RLS applied.
 *
 * Rather than hand `terminal_app` a blanket bypass on three tenant tables, migration 0017 §17.h
 * gives the engine four narrow SECURITY DEFINER entry points owned by the migration owner:
 * `armed_alerts` lists armed alerts of one kind, `alert_fired_on` answers the dedupe question,
 * `fire_alert` claims the alert and appends its event in one statement, and `saved_search_query`
 * reads a saved search **for a named owner**. Each is the smallest thing that does the job, and
 * none of them can read an owner's other rows.
 *
 * `saved_search_query` takes the owner because `criteriaFor` used to select
 * `saved_searches WHERE search_id = …` with no owner predicate: an alert could name *any* user's
 * saved search by id, and on the fan-out handle it was evaluated against that user's criteria —
 * a firm-B alert firing on a firm-A desk's private "Project Nova" search, which leaks what a rival
 * is watching for. An id is not an authorisation.
 */

import { sql } from 'drizzle-orm';

import type { Clock, QuoteState } from '@terminal/core';
import type { ServerMsg } from '@terminal/sdk/wire/ws';

import type { Db, Tx } from '../db/client.js';
import type { NewsItem } from '../data/news.js';
import { parseSubject } from '../plant/subjects.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type AlertKind = 'price' | 'news' | 'filing' | 'calendar';
export type AlertStatus = 'armed' | 'paused' | 'fired' | 'deleted';
export type PriceOp = '>=' | '<=' | 'crosses';
export type DeliveryChannel = 'inapp' | 'email' | 'push';

/** What the gateway offers the engine (`ws/gateway.ts#sendToUser` — the `alerts:me` fan-out). */
export interface AlertGateway {
  sendToUser(userId: number, msg: ServerMsg): number;
}

/** One accepted filing, as `ingest/jobs/secFilings` hands it on (NEWS-04). */
export interface FilingEvent {
  accessionNo: string;
  cik: string | null;
  form: string;
  items: readonly string[] | null;
  filedDate: string;
  /** Instruments the filer maps to, when the issuer is resolved. */
  instrumentIds?: readonly number[];
  provenanceId?: number;
}

/** `alert_events.payload` (API.md §5.11). `summary` is what the terminal shows in the toast. */
export interface AlertEventPayload {
  summary: string;
  value?: number;
  newsId?: number;
  accessionNo?: string;
  eventId?: number;
  provenanceId?: number;
}

export interface AlertFiring {
  eventId: number;
  alertId: number;
  ownerUserId: number;
  firedAt: string;
  payload: AlertEventPayload;
  delivered: Record<string, string | null>;
  /** How many live sessions the `alert` frame reached. */
  sessions: number;
}

export interface AlertEngineStats {
  /** Alerts examined against an input. */
  evaluated: number;
  /** Firings that wrote an `alert_events` row. */
  fired: number;
  /** Firings that reached at least one live session. */
  delivered: number;
  /** Firings a concurrent claim had already taken. */
  raced: number;
  /** Inputs discarded before evaluation (unparseable subject, malformed condition). */
  skipped: number;
  errors: number;
}

export interface AlertEngine {
  onPlantDelta(subject: string, state: QuoteState): Promise<void>;
  onNews(item: NewsItem): Promise<void>;
  onFiling(filing: FilingEvent): Promise<void>;
  onCalendarTick(nowMs: number): Promise<void>;
  stats(): AlertEngineStats;
}

export interface AlertEngineDeps {
  /** The transaction the engine reads and writes on; its `app.*` context decides what it sees. */
  db: Db | Tx;
  clock: Clock;
  /** Omitted, firings are durable but silent — `GET /alerts/events` still returns them. */
  gateway?: AlertGateway;
  onError?: (err: unknown, detail: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rows and conditions
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface AlertRow {
  alert_id: string;
  owner_user_id: string;
  firm_id: string;
  kind: string;
  instrument_id: string | null;
  condition: unknown;
  delivery: string[];
  one_shot: boolean;
}

interface LoadedAlert {
  alertId: number;
  ownerUserId: number;
  firmId: number;
  kind: AlertKind;
  instrumentId: number | null;
  condition: Record<string, unknown>;
  delivery: DeliveryChannel[];
  oneShot: boolean;
}

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const DEFAULT_MINUTES_BEFORE = 15;
const CHANNELS: readonly DeliveryChannel[] = ['inapp', 'email', 'push'];

const asRows = <T>(result: { rows: unknown[] }): T[] => result.rows as T[];

function toAlert(row: AlertRow): LoadedAlert {
  const condition =
    row.condition !== null && typeof row.condition === 'object' && !Array.isArray(row.condition)
      ? (row.condition as Record<string, unknown>)
      : {};
  return {
    alertId: Number(row.alert_id),
    ownerUserId: Number(row.owner_user_id),
    firmId: Number(row.firm_id),
    kind: row.kind as AlertKind,
    instrumentId: row.instrument_id === null ? null : Number(row.instrument_id),
    condition,
    delivery: row.delivery.filter((d): d is DeliveryChannel =>
      (CHANNELS as readonly string[]).includes(d),
    ),
    oneShot: row.one_shot,
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
const numList = (v: unknown): number[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : undefined;

/** `{field, op, value}` — `kind` and the security live in their own columns (DATA_MODEL §12). */
interface PriceCondition {
  field: string;
  op: PriceOp;
  value: number;
}

function priceCondition(condition: Record<string, unknown>): PriceCondition | null {
  const op = str(condition.op);
  const value = num(condition.value);
  if (value === undefined) return null;
  if (op !== '>=' && op !== '<=' && op !== 'crosses') return null;
  return { field: str(condition.field) ?? 'PX_LAST', op, value };
}

/** The news filter of a saved search or an inline condition (API.md §5.6 `NewsQuery` subset). */
interface NewsCriteria {
  q?: string;
  instrumentId?: number;
  topic?: string;
  feed?: string;
}

function newsCriteria(raw: unknown): NewsCriteria | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const criteria: NewsCriteria = {};
  // `saved_searches.query` for `kind:'news'` is `{text, instrumentIds[], topics[], feeds[]}`
  // (DATA_MODEL §16); an inline alert condition uses the singular `NewsQuery` names. Both are
  // accepted, because both reach this function from the same column.
  const text = str(record.q) ?? str(record.text);
  if (text !== undefined && text.trim() !== '') criteria.q = text.trim();
  const instrumentId = num(record.instrumentId) ?? numList(record.instrumentIds)?.[0];
  if (instrumentId !== undefined) criteria.instrumentId = instrumentId;
  const topic = str(record.topic) ?? strList(record.topics)?.[0];
  if (topic !== undefined) criteria.topic = topic;
  const feed = str(record.feed) ?? strList(record.feeds)?.[0];
  if (feed !== undefined) criteria.feed = feed;
  return Object.keys(criteria).length === 0 ? null : criteria;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The engine
// ─────────────────────────────────────────────────────────────────────────────────────────────

export function alertEngine(deps: AlertEngineDeps): AlertEngine {
  const db = deps.db;
  const report = deps.onError ?? ((): void => undefined);
  const counters: AlertEngineStats = {
    evaluated: 0,
    fired: 0,
    delivered: 0,
    raced: 0,
    skipped: 0,
    errors: 0,
  };

  /** Last observed value per `subject|field`, for `crosses` and for edge-triggered repeats. */
  const lastValue = new Map<string, number>();
  /** Whether a repeating alert's condition held at the previous observation. */
  const lastSatisfied = new Map<number, boolean>();
  /** `topics.code` → `topic_id`, refreshed once on a miss. */
  const topicIds = new Map<string, number>();
  let topicsLoaded = false;

  /** One at a time: two deltas for the same subject must not interleave their claims. */
  let tail: Promise<void> = Promise.resolve();
  function serial(fn: () => Promise<void>): Promise<void> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function armed(kind: AlertKind, instrumentId?: number): Promise<LoadedAlert[]> {
    const result = await db.execute(sql`
      SELECT alert_id::text AS alert_id, owner_user_id::text AS owner_user_id,
             firm_id::text AS firm_id, kind, instrument_id::text AS instrument_id,
             condition, delivery, one_shot
        FROM armed_alerts(${kind}::text, ${instrumentId ?? null}::bigint)`);
    return asRows<AlertRow>(result).map(toAlert);
  }

  /** Has this alert already fired on this subject? `key` is a `payload` field name. */
  async function alreadyFired(alertId: number, key: string, value: string): Promise<boolean> {
    const result = await db.execute(sql`
      SELECT alert_fired_on(${alertId}::bigint, ${key}::text, ${value}::text) AS present`);
    return asRows<{ present: boolean }>(result)[0]?.present === true;
  }

  /**
   * Claim the alert, write the event, push the frame. Returns `null` when a concurrent firing
   * already claimed it — the claim is the `UPDATE`'s own `WHERE status = 'armed'`.
   */
  async function fire(alert: LoadedAlert, payload: AlertEventPayload): Promise<AlertFiring | null> {
    const firedAt = new Date(deps.clock.now()).toISOString();
    const delivered: Record<string, string | null> = {};
    for (const channel of alert.delivery) delivered[channel] = channel === 'inapp' ? firedAt : null;

    // The claim and the event row are one statement (`fire_alert`, 0017 §17.h): the `UPDATE …
    // WHERE status = 'armed'` is still what makes a one-shot alert fire exactly once, and no
    // second fan-out can squeeze between the claim and the row that records it. An empty result
    // means the alert was no longer armed.
    const inserted = await db.execute(sql`
      SELECT event_id::text AS event_id,
             to_char(fired_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS fired_at
        FROM fire_alert(${alert.alertId}::bigint, ${firedAt}::timestamptz,
                        ${JSON.stringify(payload)}::jsonb, ${JSON.stringify(delivered)}::jsonb)`);
    const row = asRows<{ event_id: string; fired_at: string }>(inserted)[0];
    if (row === undefined) {
      counters.raced += 1;
      return null;
    }

    counters.fired += 1;
    const firing: AlertFiring = {
      eventId: Number(row.event_id),
      alertId: alert.alertId,
      ownerUserId: alert.ownerUserId,
      firedAt: row.fired_at,
      payload,
      delivered,
      sessions: 0,
    };

    if (deps.gateway !== undefined) {
      try {
        // API.md §6.9: the `alerts:me` subject is a per-user fan-out, and its frame carries the
        // REST `AlertEvent` verbatim so the client has one shape for live and replayed alerts.
        firing.sessions = deps.gateway.sendToUser(alert.ownerUserId, {
          t: 'alert',
          alertId: String(alert.alertId),
          firedAt: Date.parse(row.fired_at),
          payload: {
            eventId: firing.eventId,
            alertId: alert.alertId,
            firedAt: row.fired_at,
            payload,
            delivered,
            acknowledgedAt: null,
          },
        });
        if (firing.sessions > 0) counters.delivered += 1;
      } catch (err) {
        counters.errors += 1;
        report(err, `alerts: pushing alert ${String(alert.alertId)} to alerts:me`);
      }
    }
    return firing;
  }

  function satisfied(
    op: PriceOp,
    value: number,
    threshold: number,
    previous: number | undefined,
  ): boolean {
    switch (op) {
      case '>=':
        return value >= threshold;
      case '<=':
        return value <= threshold;
      case 'crosses':
        if (previous === undefined) return false;
        return (
          (previous < threshold && value >= threshold) ||
          (previous > threshold && value <= threshold)
        );
    }
  }

  async function topicIdFor(code: string): Promise<number | undefined> {
    const wanted = code.toLowerCase();
    if (!topicsLoaded || !topicIds.has(wanted)) {
      const result = await db.execute(sql`SELECT topic_id::text AS topic_id, code FROM topics`);
      topicIds.clear();
      for (const row of asRows<{ topic_id: string; code: string }>(result)) {
        topicIds.set(row.code.toLowerCase(), Number(row.topic_id));
      }
      topicsLoaded = true;
    }
    return topicIds.get(wanted);
  }

  async function criteriaFor(alert: LoadedAlert): Promise<NewsCriteria | null> {
    const inline = newsCriteria(alert.condition.query);
    if (inline !== null) return inline;
    const savedSearchId = num(alert.condition.savedSearchId);
    if (savedSearchId === undefined) return newsCriteria(alert.condition);
    // The owner is part of the predicate. A `savedSearchId` naming somebody else's search resolves
    // to nothing, rather than to their criteria evaluated under this alert's name.
    const result = await db.execute(sql`
      SELECT saved_search_query(${savedSearchId}::bigint, ${alert.ownerUserId}::bigint,
                                'news'::text) AS query`);
    const query = asRows<{ query: unknown }>(result)[0]?.query;
    return query === undefined || query === null ? null : newsCriteria(query);
  }

  async function matchesNews(item: NewsItem, criteria: NewsCriteria): Promise<boolean> {
    if (criteria.feed !== undefined && item.feed !== criteria.feed) return false;
    if (criteria.q !== undefined) {
      const haystack = `${item.headline} ${item.summary ?? ''}`.toLowerCase();
      if (!haystack.includes(criteria.q.toLowerCase())) return false;
    }
    if (criteria.instrumentId !== undefined) {
      const linked = item.links.some(
        (l) => l.entityKind === 'instrument' && l.entityId === criteria.instrumentId,
      );
      if (!linked) return false;
    }
    if (criteria.topic !== undefined) {
      const topicId = await topicIdFor(criteria.topic);
      if (topicId === undefined) return false;
      const linked = item.links.some((l) => l.entityKind === 'topic' && l.entityId === topicId);
      if (!linked) return false;
    }
    return true;
  }

  function matchesFiling(filing: FilingEvent, condition: Record<string, unknown>): boolean {
    const forms = strList(condition.forms) ?? ['8-K'];
    if (!forms.some((form) => form.toUpperCase() === filing.form.toUpperCase())) return false;

    const ciks = strList(condition.ciks);
    const instrumentIds = numList(condition.instrumentIds);
    if (ciks !== undefined && ciks.length > 0) {
      const wanted = new Set(ciks.map((cik) => cik.replace(/\D/g, '').padStart(10, '0')));
      const filed = filing.cik === null ? null : filing.cik.replace(/\D/g, '').padStart(10, '0');
      const byCik = filed !== null && wanted.has(filed);
      const byInstrument =
        instrumentIds !== undefined &&
        (filing.instrumentIds ?? []).some((id) => instrumentIds.includes(id));
      if (!byCik && !byInstrument) return false;
    } else if (instrumentIds !== undefined && instrumentIds.length > 0) {
      if (!(filing.instrumentIds ?? []).some((id) => instrumentIds.includes(id))) return false;
    }

    const items = strList(condition.items);
    if (items !== undefined && items.length > 0) {
      const filed = new Set(filing.items ?? []);
      if (!items.some((item) => filed.has(item))) return false;
    }
    return true;
  }

  return {
    stats: (): AlertEngineStats => ({ ...counters }),

    onPlantDelta(subject: string, state: QuoteState): Promise<void> {
      return serial(async () => {
        const parsed = parseSubject(subject);
        if (parsed?.family !== 'q') {
          counters.skipped += 1;
          return;
        }
        const alerts = await armed('price', parsed.instrumentId);
        if (alerts.length === 0) return;

        const fields = state.fields as Record<string, unknown>;
        const observed = new Map<string, number>();
        for (const alert of alerts) {
          counters.evaluated += 1;
          const condition = priceCondition(alert.condition);
          if (condition === null) {
            counters.skipped += 1;
            continue;
          }
          const value = num(fields[condition.field]);
          if (value === undefined) continue;
          observed.set(condition.field, value);

          const key = `${subject}|${condition.field}`;
          const previous = lastValue.get(key);
          const now = satisfied(condition.op, value, condition.value, previous);
          const before = lastSatisfied.get(alert.alertId) ?? false;
          lastSatisfied.set(alert.alertId, now);
          // Edge-triggered: a repeating alert fires on entry to the condition, not on every tick
          // it stays there. `crosses` is an edge by construction and needs no extra latch.
          if (!now || (condition.op !== 'crosses' && before)) continue;

          try {
            const firing = await fire(alert, {
              summary: `${condition.field} ${condition.op} ${String(condition.value)} (${String(value)})`,
              value,
              ...(state.prov.provenanceId > 0 ? { provenanceId: state.prov.provenanceId } : {}),
            });
            if (firing !== null && alert.oneShot) lastSatisfied.delete(alert.alertId);
          } catch (err) {
            counters.errors += 1;
            report(err, `alerts: firing price alert ${String(alert.alertId)}`);
          }
        }
        for (const [field, value] of observed) lastValue.set(`${subject}|${field}`, value);
      });
    },

    onNews(item: NewsItem): Promise<void> {
      return serial(async () => {
        const alerts = await armed('news');
        for (const alert of alerts) {
          counters.evaluated += 1;
          try {
            const criteria = await criteriaFor(alert);
            if (criteria === null) {
              counters.skipped += 1;
              continue;
            }
            if (!(await matchesNews(item, criteria))) continue;
            if (await alreadyFired(alert.alertId, 'newsId', String(item.newsId))) continue;
            await fire(alert, {
              summary: item.headline,
              newsId: item.newsId,
              provenanceId: item.provenanceId,
            });
          } catch (err) {
            counters.errors += 1;
            report(err, `alerts: firing news alert ${String(alert.alertId)}`);
          }
        }
      });
    },

    onFiling(filing: FilingEvent): Promise<void> {
      return serial(async () => {
        const alerts = await armed('filing');
        for (const alert of alerts) {
          counters.evaluated += 1;
          try {
            if (!matchesFiling(filing, alert.condition)) continue;
            if (await alreadyFired(alert.alertId, 'accessionNo', filing.accessionNo)) continue;
            await fire(alert, {
              summary: `${filing.form} filed ${filing.filedDate}`,
              accessionNo: filing.accessionNo,
              ...(filing.provenanceId === undefined ? {} : { provenanceId: filing.provenanceId }),
            });
          } catch (err) {
            counters.errors += 1;
            report(err, `alerts: firing filing alert ${String(alert.alertId)}`);
          }
        }
      });
    },

    onCalendarTick(nowMs: number): Promise<void> {
      return serial(async () => {
        const now = new Date(nowMs).toISOString();
        const result = await db.execute(sql`
          SELECT a.alert_id::text AS alert_id, a.owner_user_id::text AS owner_user_id,
                 a.firm_id::text AS firm_id, a.kind, a.instrument_id::text AS instrument_id,
                 a.condition, a.delivery, a.one_shot,
                 e.event_id::text AS event_id, r.name AS release_name,
                 to_char(e.scheduled_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS scheduled_at
            FROM armed_alerts('calendar'::text, NULL::bigint) a
            JOIN econ_release_events e
              ON e.release_id = (a.condition->>'releaseId')::bigint
            JOIN econ_releases r ON r.release_id = e.release_id
           WHERE e.status = 'scheduled'
             AND e.scheduled_at > ${now}::timestamptz
             AND e.scheduled_at <= ${now}::timestamptz
                 + make_interval(mins => coalesce((a.condition->>'minutesBefore')::int,
                                                  ${DEFAULT_MINUTES_BEFORE}))
           ORDER BY a.alert_id, e.event_id`);
        const rows = asRows<
          AlertRow & { event_id: string; release_name: string; scheduled_at: string }
        >(result);

        for (const row of rows) {
          const alert = toAlert(row);
          counters.evaluated += 1;
          try {
            if (await alreadyFired(alert.alertId, 'eventId', row.event_id)) continue;
            const minutes = num(alert.condition.minutesBefore) ?? DEFAULT_MINUTES_BEFORE;
            await fire(alert, {
              summary: `${row.release_name} in ${String(minutes)} minutes (${row.scheduled_at})`,
              eventId: Number(row.event_id),
            });
          } catch (err) {
            counters.errors += 1;
            report(err, `alerts: firing calendar alert ${String(alert.alertId)}`);
          }
        }
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Runtime wiring (NEWS-07)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What {@link attachAlertEngine} needs from the process it runs in. */
export interface AlertRuntimeDeps {
  /** The plant whose deltas drive price alerts. */
  plant: {
    subscribe(listener: (event: { subject: string; seq: number }) => void): () => void;
    snapshot(subject: string): QuoteState | undefined;
  };
  clock: Clock;
  gateway?: AlertGateway;
  /** Opens one transaction per batch of work; `index.ts` passes `withTx(null, fn)`. */
  withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Milliseconds between calendar ticks. `0` disables the tick. */
  calendarTickMs?: number;
  onError?: (err: unknown, detail: string) => void;
}

/** A running engine, and the handle that stops it. */
export interface AlertRuntime {
  /** Deliver one story to the engine — `newsRss.ts` calls this after a story is linked. */
  onNews(item: NewsItem): Promise<void>;
  /** Deliver one accepted filing. */
  onFiling(filing: FilingEvent): Promise<void>;
  /** Run one calendar tick now, rather than waiting for the timer. */
  tick(): Promise<void>;
  stats(): AlertEngineStats;
  stop(): Promise<void>;
}

/** The default calendar cadence: a minute is finer than any `minutesBefore` a user can set. */
export const CALENDAR_TICK_MS = 60_000;

/**
 * Start the engine against the live plant and a calendar tick, and return the handle the rest of
 * the process feeds news and filings through.
 *
 * Until this existed the engine was constructed only in tests — `grep -rn alertEngine src` matched
 * its own definition and nothing else — so NEWS-07 alerts never fired in a running server. The
 * wiring is here rather than in `index.ts` because the shape of the work is the engine's business:
 * one transaction per delta, errors reported and swallowed (an alert that cannot be evaluated must
 * not take a quote update with it), and a timer that is unref'd so it can never hold the process
 * open at shutdown.
 *
 * Each delta opens its own transaction with **no** request context, which is what the SECURITY
 * DEFINER read path of migration 0017 §17.h is for: the engine fans out across every owner, so
 * there is no `app.user_id` it could honestly adopt.
 */
export function attachAlertEngine(deps: AlertRuntimeDeps): AlertRuntime {
  const report = deps.onError ?? ((): void => undefined);
  const tickMs = deps.calendarTickMs ?? CALENDAR_TICK_MS;
  let stopped = false;

  const run = async (
    detail: string,
    fn: (engine: AlertEngine) => Promise<void>,
  ): Promise<void> => {
    if (stopped) return;
    try {
      await deps.withTx(async (tx) => {
        const engine = alertEngine({
          db: tx,
          clock: deps.clock,
          ...(deps.gateway === undefined ? {} : { gateway: deps.gateway }),
          onError: report,
        });
        await fn(engine);
        const batch = engine.stats();
        totals.evaluated += batch.evaluated;
        totals.fired += batch.fired;
        totals.delivered += batch.delivered;
        totals.raced += batch.raced;
        totals.skipped += batch.skipped;
        totals.errors += batch.errors;
      });
    } catch (err) {
      totals.errors += 1;
      report(err, detail);
    }
  };

  const totals: AlertEngineStats = {
    evaluated: 0,
    fired: 0,
    delivered: 0,
    raced: 0,
    skipped: 0,
    errors: 0,
  };

  // Price alerts. A delta arrives synchronously on the plant's fan-out, which must not be blocked
  // by a database round trip, so the work is detached and its failure reported rather than thrown
  // into the publisher.
  const unsubscribe = deps.plant.subscribe((event) => {
    if (stopped || !event.subject.startsWith('q:')) return;
    const state = deps.plant.snapshot(event.subject);
    if (state === undefined) return;
    void run(`alerts: plant delta on ${event.subject}`, (engine) =>
      engine.onPlantDelta(event.subject, state),
    );
  });

  const timer =
    tickMs > 0
      ? setInterval(() => {
          void run('alerts: calendar tick', (engine) =>
            engine.onCalendarTick(deps.clock.now()),
          );
        }, tickMs)
      : undefined;
  timer?.unref();

  return {
    onNews: (item) => run(`alerts: news ${String(item.newsId)}`, (e) => e.onNews(item)),
    onFiling: (filing) =>
      run(`alerts: filing ${filing.accessionNo}`, (e) => e.onFiling(filing)),
    tick: () => run('alerts: calendar tick', (e) => e.onCalendarTick(deps.clock.now())),
    stats: () => ({ ...totals }),
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      unsubscribe();
      await Promise.resolve();
    },
  };
}
