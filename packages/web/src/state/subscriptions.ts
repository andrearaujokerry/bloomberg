// packages/web/src/state/subscriptions.ts — what the visible panels want off the wire.
//
// CLIENT.md §8 L597-604 and §9. Bookkeeping only: the SDK owns the socket, the ref counts and the
// `sub`/`unsub` batching (WP-13). This store answers the question one step earlier — given the
// `LiveSpec` a screen returned for the payload it just painted, WHAT should be asked for?
//
// The answer is not "whatever the screen said". API.md §6.1 gives each subject family a closed
// field set, and the plant rejects a `sub` that names a field outside it: `f: []` ("everything") is
// accepted only for `c:`, `e:`, `n:`, `sys:`, `alerts:` and `room:`, and a quote-family subject
// must name its fields explicitly (BUS-02). A screen that legitimately subscribes to both a quote
// and its forming bar — Q, GIP, GP intraday all do — writes ONE `LiveSpec` with the union of the
// two field sets, because `LiveSpec.fields` is flat. Sent as written, that asks `q:42` for
// `IS_FINAL` and `b1m:42` for `PX_BID`, and the whole `sub` frame is rejected for the offending
// field rather than trimmed: the panel then shows nothing at all, for a reason no part of the UI
// can see.
//
// So `planSubscription` intersects, per family, before anything is requested. `'*'` is kept as
// `'*'` for the families that accept it and expanded to the family's full set for the ones that do
// not. A subject whose intersection is empty is not sent at all, and is reported in `dropped` —
// silently dropping it is how a screen ends up permanently blank with no trace.
//
// No arithmetic and no formatting here; the values themselves never pass through this store.
import type { FieldId, LiveSpec } from '@terminal/core';
import type { SubscribeOptions, Subscription } from '@terminal/sdk';
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/* ---------------------------------------------------------------------------------------------- */
/* Subject families (API.md §6.1 L849-862)                                                          */
/* ---------------------------------------------------------------------------------------------- */

export type SubjectFamily = 'q' | 'l' | 'b1m' | 'oc' | 'c' | 'r' | 'e' | 'n' | 'alerts' | 'room' | 'sys';

/** `^(q|l|b1m|oc|c|r|e|n|alerts|room|sys):…` — the same grammar `SubjectId` enforces on the wire. */
const SUBJECT_RE = /^(q|l|b1m|oc|c|r|e|n|alerts|room|sys):[A-Za-z0-9_.:-]+$/;

export function familyOf(subject: string): SubjectFamily | null {
  const match = SUBJECT_RE.exec(subject);
  return match === null ? null : (match[1] as SubjectFamily);
}

/** The composite quote block; `r:` is an alias of `q:` for a rate instrument, so it shares it. */
const QUOTE_FIELDS: readonly FieldId[] = Object.freeze([
  'PX_LAST',
  'LAST_SIZE',
  'LAST_TRADE_TIME',
  'PX_BID',
  'PX_ASK',
  'BID_SIZE',
  'ASK_SIZE',
  'PX_OPEN',
  'PX_HIGH',
  'PX_LOW',
  'PX_CLOSE_1D',
  'PX_OFFICIAL_CLOSE',
  'PX_VOLUME',
  'VWAP',
  'CHG_NET_1D',
  'CHG_PCT_1D',
  'TICK_DIR',
  'IVOL_30D',
  'SESSION_STATE',
  // option contracts additionally
  'OPT_IV',
  'OPT_DELTA',
  'OPT_GAMMA',
  'OPT_VEGA',
  'OPT_THETA',
  'OPT_RHO',
  'OPT_OI',
  'OPT_THEO',
  'OPT_UNDL_PX',
  // rates additionally
  'RATE',
  'RATE_P1',
  'RATE_P25',
  'RATE_P75',
  'RATE_P99',
  'RATE_VOLUME_BN',
  'TARGET_FROM',
  'TARGET_TO',
]);

/**
 * API.md §6.1, one row per family. Not derived from the dictionary: a field's `assetClasses` says
 * where it is *meaningful*, not which subject carries it, and `PX_LAST` is meaningful on both the
 * quote and the forming bar. The table is asserted against the dictionary in the store's test, so
 * a renamed field cannot rot here unnoticed.
 */
export const SUBJECT_FAMILY_FIELDS: Readonly<Record<SubjectFamily, readonly FieldId[]>> =
  Object.freeze({
    q: QUOTE_FIELDS,
    l: QUOTE_FIELDS,
    r: QUOTE_FIELDS,
    b1m: Object.freeze(['BAR_TS', 'PX_OPEN', 'PX_HIGH', 'PX_LOW', 'PX_LAST', 'PX_VOLUME', 'IS_FINAL']),
    oc: Object.freeze(['EXPIRIES', 'ATM_IV', 'PUT_CALL_RATIO', 'CONTRACT_COUNT', 'UNDL_PX']),
    c: Object.freeze(['TENORS', 'RATES', 'BUILD_ID', 'BUILD_TS', 'CURVE_DATE']),
    e: Object.freeze(['VALUE', 'PERIOD', 'RELEASED_AT', 'PREV', 'REVISED', 'STATUS']),
    n: Object.freeze([
      'NEWS_ID',
      'HEADLINE',
      'PUBLISHED_AT',
      'SOURCE_ID',
      'LINK',
      'KIND',
      'IS_CORRECTION',
    ]),
    sys: Object.freeze([
      'PLANT_STATE',
      'CONFLATION_FLOOR_MS',
      'PROVIDERS_DOWN',
      'SESSION_NYSE',
      'SESSION_SIFMA',
      'SESSION_FX',
      'SERVER_TIME',
      'OPEN_INCIDENTS',
      'MIN_CLIENT_VERSION',
    ]),
    // Message-bearing subjects carry no fields at all (API.md §6.1: `alert` / `msg` frames).
    alerts: Object.freeze([]),
    room: Object.freeze([]),
  });

/** The families for which `f: []` / `'*'` is accepted (API.md §6.1 L864-866). */
export const ALL_FIELDS_FAMILIES: ReadonlySet<SubjectFamily> = new Set<SubjectFamily>([
  'c',
  'e',
  'n',
  'sys',
  'alerts',
  'room',
]);

/** A `sub` frame names at most 100 fields per subject (API.md §6.2 `ClientMsg`). */
export const MAX_FIELDS_PER_SUBJECT = 100;

/* ---------------------------------------------------------------------------------------------- */
/* The plan                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/** One `sdk.live.subscribe(subjects, fields, opts)` call, ready to make. */
export interface SubscriptionRequest {
  family: SubjectFamily;
  subjects: string[];
  fields: FieldId[] | '*';
  options: SubscribeOptions;
}

export interface DroppedSubject {
  subject: string;
  reason: 'unknown-family' | 'no-fields-in-family';
}

export interface SubscriptionPlan {
  requests: SubscriptionRequest[];
  dropped: DroppedSubject[];
}

/**
 * Group a `LiveSpec` by subject family and intersect its fields with each family's set, preserving
 * the order the screen asked in (a stable plan is a diffable plan).
 */
export function planSubscription(spec: LiveSpec): SubscriptionPlan {
  const byFamily = new Map<SubjectFamily, string[]>();
  const dropped: DroppedSubject[] = [];
  const seen = new Set<string>();

  for (const subject of spec.subjects) {
    if (seen.has(subject)) continue;
    seen.add(subject);
    const family = familyOf(subject);
    if (family === null) {
      dropped.push({ subject, reason: 'unknown-family' });
      continue;
    }
    const list = byFamily.get(family);
    if (list === undefined) byFamily.set(family, [subject]);
    else list.push(subject);
  }

  const essential = spec.essential === undefined ? null : new Set(spec.essential);
  const requests: SubscriptionRequest[] = [];

  for (const [family, subjects] of byFamily) {
    const allowed = SUBJECT_FAMILY_FIELDS[family];
    let fields: FieldId[] | '*';
    if (spec.fields === '*') {
      // '*' is only legal on the wire for the open families; everywhere else it is spelled out.
      fields = ALL_FIELDS_FAMILIES.has(family) ? '*' : [...allowed];
    } else {
      const allowedSet = new Set(allowed);
      fields = spec.fields.filter((f) => allowedSet.has(f));
      if (fields.length === 0 && ALL_FIELDS_FAMILIES.has(family)) {
        // `alerts:`/`room:` carry no fields, and a `c:`/`e:`/`n:` subject named alongside quote
        // fields still wants its own stream: ask for everything it has, which is legal here.
        fields = '*';
      }
    }
    if (fields !== '*' && fields.length === 0) {
      for (const subject of subjects) dropped.push({ subject, reason: 'no-fields-in-family' });
      continue;
    }
    if (fields !== '*' && fields.length > MAX_FIELDS_PER_SUBJECT) {
      fields = fields.slice(0, MAX_FIELDS_PER_SUBJECT);
    }
    // `essential` is per subscription, so a family whose subjects disagree splits: essential
    // subjects must never be shed, and shedding one because it shared a request would lose the
    // very cells the rule protects (API.md §10.2).
    const groups =
      essential === null
        ? [{ subjects, essential: true }]
        : [
            { subjects: subjects.filter((s) => essential.has(s)), essential: true },
            { subjects: subjects.filter((s) => !essential.has(s)), essential: false },
          ];
    for (const group of groups) {
      if (group.subjects.length === 0) continue;
      const options: SubscribeOptions = { essential: group.essential };
      if (spec.conflationMs !== undefined) options.conflationMs = spec.conflationMs;
      requests.push({
        family,
        subjects: group.subjects,
        fields: fields === '*' ? '*' : [...fields],
        options,
      });
    }
  }

  return { requests, dropped };
}

/* ---------------------------------------------------------------------------------------------- */
/* The store                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** The slice of `LiveClient` this store calls. WP-13 implements it; until then it is simply unset. */
export interface LiveSubscriber {
  subscribe(subjects: string[], fields: FieldId[] | '*', opts?: SubscribeOptions): Subscription;
  setConflation?(ms: number): void;
}

export interface PanelSubscription {
  spec: LiveSpec;
  plan: SubscriptionPlan;
  /** Live handles, when a `LiveSubscriber` is attached; empty until WP-13 wires one in. */
  subs: Subscription[];
}

export interface SubscriptionsStore {
  byPanel: Record<string, PanelSubscription | null>;
  /** Subjects the plant is currently shedding; re-subscribed when the row is visible again. */
  shed: ReadonlySet<string>;
  effectiveConflationMs: number;

  /** Attach the live client (WP-13's `rt/wsBridge.ts`). */
  attach(live: LiveSubscriber | null): void;
  acquire(panelId: string, spec: LiveSpec): SubscriptionPlan;
  release(panelId: string): void;
  releaseAll(): void;
  setEffective(ms: number): void;
  markShed(subject: string, shed: boolean): void;
  reset(): void;
}

let live: LiveSubscriber | null = null;

/** Same subjects, same fields, same options → nothing to do (a repaint is not a resubscribe). */
function samePlan(a: SubscriptionPlan, b: SubscriptionPlan): boolean {
  if (a.requests.length !== b.requests.length) return false;
  return a.requests.every((req, i) => {
    const other = b.requests[i];
    if (other === undefined) return false;
    if (req.family !== other.family) return false;
    if (req.subjects.length !== other.subjects.length) return false;
    if (!req.subjects.every((s, j) => s === other.subjects[j])) return false;
    if (req.fields === '*' || other.fields === '*') return req.fields === other.fields;
    if (req.fields.length !== other.fields.length) return false;
    if (!req.fields.every((f, j) => f === other.fields[j])) return false;
    return (
      req.options.essential === other.options.essential &&
      req.options.conflationMs === other.options.conflationMs
    );
  });
}

export const useSubscriptionsStore = create<SubscriptionsStore>()(
  subscribeWithSelector((set, get) => ({
    byPanel: {},
    shed: new Set<string>(),
    effectiveConflationMs: 250,

    attach(next) {
      live = next;
    },

    acquire(panelId, spec) {
      const plan = planSubscription(spec);
      const previous = get().byPanel[panelId] ?? null;
      if (previous !== null && samePlan(previous.plan, plan)) return previous.plan;

      // One panel, one subscription set: the previous one goes before the new one is made, so a
      // panel that re-paints in a loop cannot accumulate ref counts on the socket.
      if (previous !== null) for (const sub of previous.subs) sub.unsubscribe();

      const subs: Subscription[] = [];
      if (live !== null) {
        for (const request of plan.requests) {
          subs.push(live.subscribe([...request.subjects], request.fields, request.options));
        }
      }
      set({ byPanel: { ...get().byPanel, [panelId]: { spec, plan, subs } } });
      return plan;
    },

    release(panelId) {
      const current = get().byPanel[panelId] ?? null;
      if (current === null) return;
      for (const sub of current.subs) sub.unsubscribe();
      const byPanel = { ...get().byPanel };
      delete byPanel[panelId];
      set({ byPanel });
    },

    releaseAll() {
      for (const entry of Object.values(get().byPanel)) {
        if (entry === null) continue;
        for (const sub of entry.subs) sub.unsubscribe();
      }
      set({ byPanel: {}, shed: new Set<string>() });
    },

    setEffective(ms) {
      if (get().effectiveConflationMs === ms) return;
      set({ effectiveConflationMs: ms });
      live?.setConflation?.(ms);
    },

    markShed(subject, isShed) {
      const shed = new Set(get().shed);
      if (isShed) shed.add(subject);
      else shed.delete(subject);
      set({ shed });
    },

    reset() {
      live = null;
      set({ byPanel: {}, shed: new Set<string>(), effectiveConflationMs: 250 });
    },
  })),
);

/* ---------------------------------------------------------------------------------------------- */
/* Selectors                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** Every subject any panel currently wants — what the status bar counts (API-06). */
export const selectSubjects = (s: SubscriptionsStore): string[] => {
  const out = new Set<string>();
  for (const entry of Object.values(s.byPanel)) {
    if (entry === null) continue;
    for (const request of entry.plan.requests) for (const subject of request.subjects) out.add(subject);
  }
  return [...out];
};

/** The fields one subject is subscribed to, merged across panels. */
export const selectFieldsOf =
  (subject: string) =>
  (s: SubscriptionsStore): FieldId[] | '*' => {
    const out = new Set<FieldId>();
    for (const entry of Object.values(s.byPanel)) {
      if (entry === null) continue;
      for (const request of entry.plan.requests) {
        if (!request.subjects.includes(subject)) continue;
        if (request.fields === '*') return '*';
        for (const field of request.fields) out.add(field);
      }
    }
    return [...out];
  };
