// packages/sdk/test/wire-roundtrip.test.ts — WP-01 acceptance test (WORKPLAN §1.11).
//
// The wire schemas are the contract between the plant and every client. This file proves two
// things about them:
//
//   1. **The documented examples parse and round-trip.** Every frame of the API.md §6.8 exchange
//      (L1031-1056) and every complete JSON body of API.md §12 (L1394-1441) is carried here as the
//      document's own text, `JSON.parse`d, parsed by the schema that owns it, re-encoded with
//      `JSON.stringify` and parsed again. `parse → encode → parse` must be a fixed point, and the
//      decoded frame must preserve every key the document wrote.
//   2. **Every zod schema in `wire/**` is a usable parser.** The sweep walks every export of every
//      wire module — including the schemas hanging off the REST route descriptors — and drives
//      each one with a battery of hostile inputs. A schema that throws instead of returning a
//      `safeParse` result would take the server's error handler down with it.
//
// Elisions: API.md prints `…` inside some example values. `EXPANSIONS` below lists every one that
// had to be widened into a conforming value, with the reason; each expansion is asserted to have
// actually fired, so a change to the document cannot silently skip a case. Examples whose *shape*
// is elided (`"rows": [ … ]`) are named in the tests that skip them.

import { describe, expect, it } from 'vitest';

import * as dataRequest from '../src/wire/dataRequest.js';
import * as envelope from '../src/wire/envelope.js';
import * as reasonCodes from '../src/wire/reasonCodes.js';
// Type-only: the runtime import of the REST barrel is deliberately dynamic (see `rest()` below).
import type * as RestIndexModule from '../src/wire/rest/index.js';
import * as ws from '../src/wire/ws.js';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** The minimal surface every zod schema exposes; `wire/**` must not export anything else. */
interface Parser {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
}

const isParser = (v: unknown): v is Parser =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Partial<Parser>).parse === 'function' &&
  typeof (v as Partial<Parser>).safeParse === 'function';

/**
 * `parse → JSON round trip → parse` must be a fixed point, and the decoded value must keep every
 * key the wire carried. Returns the decoded value.
 */
function roundTrip(schema: Parser, wire: unknown, label: string): unknown {
  const parsed = schema.parse(wire);
  const encoded: unknown = JSON.parse(JSON.stringify(parsed));
  const reparsed = schema.parse(encoded);
  expect(reparsed, `${label} is not a round-trip fixed point`).toEqual(parsed);
  expectPreserves(wire, parsed, label);
  return parsed;
}

/**
 * Every key/value the document wrote survives decoding. (Schemas with `.default()` add keys —
 * `hello.resume`, `sub.subjects[].essential`, `DataRequest.usage` — so this is a containment
 * check, not equality.)
 */
function expectPreserves(source: unknown, decoded: unknown, path: string): void {
  if (Array.isArray(source)) {
    expect(Array.isArray(decoded), `${path} lost its array`).toBe(true);
    const target = decoded as unknown[];
    expect(target).toHaveLength(source.length);
    source.forEach((el, i) => {
      expectPreserves(el, target[i], `${path}[${String(i)}]`);
    });
    return;
  }
  if (typeof source === 'object' && source !== null) {
    expect(typeof decoded === 'object' && decoded !== null, `${path} lost its object`).toBe(true);
    const target = decoded as Record<string, unknown>;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      expect(Object.hasOwn(target, key), `${path}.${key} was dropped`).toBe(true);
      expectPreserves(value, target[key], `${path}.${key}`);
    }
    return;
  }
  expect(decoded, `${path} changed value`).toEqual(source);
}

/**
 * The elided values API.md prints as `…`, and the conforming value each is widened to.
 * The substitution is textual, so what the schema sees is otherwise the document's own bytes.
 */
const EXPANSIONS: readonly { readonly from: string; readonly to: string; readonly why: string }[] =
  [
    {
      from: '"5c0e…"',
      to: '"5c0e9d2b-6d6f-4f4a-9a1a-0b5a6c7d8e9f"',
      why: 'Meta.traceId is z.uuid(); §12.1 prints the first four characters of the trace id',
    },
    {
      from: '"6a1c…"',
      to: '"6a1c7f10-3b2e-4c5d-8e9f-1a2b3c4d5e6f"',
      why: 'SessionInfo.sessionId is z.uuid(); §12.1 prints it truncated',
    },
    {
      from: '"58b0…"',
      to: '"58b0a2c4-7d1e-4f3a-9b8c-2d4e6f8a0b1c"',
      why: 'the superseded session id is z.uuid(); §12.1 prints it truncated',
    },
    {
      from: '"9b1e…"',
      to: `"9b1e${'0'.repeat(60)}"`,
      why: 'EngineNote.inputsHash is char(64) (ANAL-08); §12.1 prints its first four characters',
    },
  ];

/**
 * Elided values the schema accepts as written, because the field is free text on the wire:
 * `welcome.sessionId` and `subAck.traceId` are `z.string()`, and `superseded.deviceId` is a
 * nullable string. They are listed so that "a `…` the table does not account for" stays an error.
 */
const BENIGN_ELISIONS: readonly string[] = ['"7f3c…"', '"…"', '"d_11aa…"'];

/** Parses a documented example: JSON text in, plain JS value out. */
const example = (text: string): unknown => JSON.parse(applyExpansions(text)) as unknown;

/** Applies {@link EXPANSIONS}; asserts each one that appears in `text` actually fired. */
function applyExpansions(text: string): string {
  let out = text;
  for (const { from, to, why } of EXPANSIONS) {
    if (!out.includes(from)) continue;
    out = out.split(from).join(to);
    expect(out.includes(from), `expansion for ${from} (${why}) did not fire`).toBe(false);
  }
  let residue = out;
  for (const benign of BENIGN_ELISIONS) residue = residue.split(benign).join('""');
  expect(
    residue,
    'an elision in this example is in neither EXPANSIONS nor BENIGN_ELISIONS',
  ).not.toContain('…');
  return out;
}

// ---------------------------------------------------------------------------------------------
// API.md §6.8 — the recorded `cboe-quote-AAPL.json` exchange (L1031-1056)
// ---------------------------------------------------------------------------------------------

/** `→` client-to-server frames, verbatim from the document. */
const CLIENT_FRAMES: readonly { readonly name: string; readonly json: string }[] = [
  {
    name: 'hello',
    json: '{"t":"hello","protocol":1,"client":"web/0.1.0","conflationMs":250}',
  },
  {
    name: 'sub #1',
    json: '{"t":"sub","id":1,"subjects":[{"s":"q:42","f":["PX_LAST","PX_BID","PX_ASK","PX_VOLUME","CHG_PCT_1D"]}]}',
  },
  {
    name: 'essential (row scrolled out of the viewport)',
    json: '{"t":"essential","subjects":["q:42"],"essential":false}',
  },
  {
    name: 'sub #2 (row visible again, with known)',
    json: '{"t":"sub","id":2,"subjects":[{"s":"q:42","f":["PX_LAST","PX_BID","PX_ASK","PX_VOLUME","CHG_PCT_1D"],"known":4185}]}',
  },
];

/** `←` server-to-client frames, verbatim from the document. */
const SERVER_FRAMES: readonly { readonly name: string; readonly json: string }[] = [
  {
    name: 'welcome',
    json: '{"t":"welcome","sessionId":"7f3c…","serverTime":1789497943123,"protocol":1,"conflationMs":250,"heartbeatMs":15000,"limits":{"maxSubscriptions":10000,"maxFields":100}}',
  },
  {
    name: 'subAck #1',
    json: '{"t":"subAck","id":1,"accepted":[{"s":"q:42","tier":"delayed","reason":"SOURCE_TIER_CAP"}],"rejected":[],"traceId":"…"}',
  },
  {
    name: 'batch(snap)',
    json:
      '{"t":"batch","m":[{"t":"snap","s":"q:42","seq":4182,"tier":"delayed","reason":"SOURCE_TIER_CAP",' +
      '"f":{"PX_LAST":330.27,"PX_BID":330.25,"PX_ASK":330.28,"PX_VOLUME":16591786,"CHG_PCT_1D":-0.8436},' +
      '"fts":{"PX_LAST":1789489586000,"PX_BID":1789489586000,"PX_ASK":1789489586000,"PX_VOLUME":1789489586000,"CHG_PCT_1D":1789489586000},' +
      '"ts":{"src":1789489586000,"cap":1789497688412,"pub":1789497688413},"st":"live","session":"open",' +
      '"prov":{"p":"cboe.quotes","id":88213,"seq":15972883317},"ac":"equity","id":42}]}',
  },
  {
    name: 'batch(delta)',
    json:
      '{"t":"batch","m":[{"t":"delta","s":"q:42","seq":4185,"prev":4182,"f":{"PX_LAST":330.31,"PX_VOLUME":16601102},' +
      '"ts":{"src":1789489601000,"cap":1789497703400,"pub":1789497703401},"st":"live"}]}',
  },
  {
    name: 'notice',
    json: '{"t":"notice","kind":"slow-consumer","action":"conflation-widened","conflationMs":500}',
  },
  {
    name: 'status',
    json: '{"t":"status","s":"q:42","st":"shed","reason":"SLOW_CONSUMER","ts":1789497720000}',
  },
  {
    name: 'subAck #2',
    json: '{"t":"subAck","id":2,"accepted":[{"s":"q:42","tier":"delayed","reason":"SOURCE_TIER_CAP"}],"rejected":[],"traceId":"…"}',
  },
  {
    // API.md L1054, the `eod`-only variant of the same exchange, written as prose:
    // `downgrade {s:"q:42",from:"delayed",to:"eod",reason:"NOT_ENTITLED_TIER"}`.
    name: 'downgrade (L1054)',
    json: '{"t":"downgrade","s":"q:42","from":"delayed","to":"eod","reason":"NOT_ENTITLED_TIER"}',
  },
];

describe('API.md §6.8 — the recorded exchange', () => {
  it.each(CLIENT_FRAMES)('ClientMsg parses and round-trips $name', ({ name, json }) => {
    roundTrip(ws.ClientMsg, example(json), `ClientMsg ${name}`);
  });

  it.each(SERVER_FRAMES)('ServerMsg parses and round-trips $name', ({ name, json }) => {
    roundTrip(ws.ServerMsg, example(json), `ServerMsg ${name}`);
  });

  it('decodes the snap exactly as the fixture recorded it', () => {
    const frame = ws.ServerMsg.parse(example(SERVER_FRAMES[2]!.json));
    expect(frame.t).toBe('batch');
    if (frame.t !== 'batch') throw new Error('unreachable');
    const snap = ws.Snap.parse(frame.m[0]);
    expect(snap.s).toBe('q:42');
    expect(snap.seq).toBe(4182);
    expect(snap.tier).toBe('delayed');
    expect(snap.reason).toBe('SOURCE_TIER_CAP');
    expect(snap.f.PX_LAST).toBe(330.27);
    expect(snap.f.CHG_PCT_1D).toBe(-0.8436);
    // FEED-05: three timestamps, source before capture before publication.
    expect(snap.ts.src).not.toBeNull();
    expect(snap.ts.src!).toBeLessThan(snap.ts.cap);
    expect(snap.ts.cap).toBeLessThan(snap.ts.pub);
    expect(snap.prov).toEqual({ p: 'cboe.quotes', id: 88213, seq: 15972883317 });
    expect(snap.ac).toBe('equity');
    expect(snap.id).toBe(42);
  });

  it('applies hello and sub defaults without losing what the client sent', () => {
    const hello = ws.ClientMsg.parse(example(CLIENT_FRAMES[0]!.json));
    expect(hello).toEqual({
      t: 'hello',
      protocol: 1,
      client: 'web/0.1.0',
      conflationMs: 250,
      resume: false, // `.default(false)`
    });

    const sub = ws.ClientMsg.parse(example(CLIENT_FRAMES[3]!.json));
    if (sub.t !== 'sub') throw new Error('unreachable');
    expect(sub.subjects[0]).toEqual({
      s: 'q:42',
      f: ['PX_LAST', 'PX_BID', 'PX_ASK', 'PX_VOLUME', 'CHG_PCT_1D'],
      essential: true, // `.default(true)`
      known: 4185,
    });
  });

  it('round-trips the eod-only snap of L1055-1056, with its per-field reasons', () => {
    // Built from the §6.8 snap with the three overrides L1055-1056 states in prose:
    // `f` blanked except PX_VOLUME, an `r` map of TIER_EOD reasons, and `st:"closed"`.
    const eodSnap = {
      t: 'snap',
      s: 'q:42',
      seq: 4182,
      tier: 'eod',
      reason: 'NOT_ENTITLED_TIER',
      f: {
        PX_LAST: null,
        PX_BID: null,
        PX_ASK: null,
        PX_VOLUME: 16591786,
        CHG_PCT_1D: null,
      },
      r: {
        PX_LAST: 'TIER_EOD',
        PX_BID: 'TIER_EOD',
        PX_ASK: 'TIER_EOD',
        CHG_PCT_1D: 'TIER_EOD',
      },
      ts: { src: 1789489586000, cap: 1789497688412, pub: 1789497688413 },
      st: 'closed',
      session: 'closed',
      prov: { p: 'cboe.quotes', id: 88213 },
      ac: 'equity',
      id: 42,
    };
    const snap = roundTrip(ws.Snap, eodSnap, 'eod snap') as ws.Snap;
    expect(snap.f.PX_VOLUME).toBe(16591786);
    expect(snap.f.PX_LAST).toBeNull();
    expect(snap.r?.PX_LAST).toBe('TIER_EOD');
    // ENTL-05: a field carrying a reason must be blank.
    for (const fieldId of Object.keys(snap.r ?? {})) {
      expect(snap.f[fieldId]).toBeNull();
    }
    // The accepted-tier line of L1054.
    roundTrip(
      ws.ServerMsg,
      {
        t: 'subAck',
        id: 1,
        accepted: [{ s: 'q:42', tier: 'eod', reason: 'NOT_ENTITLED_TIER' }],
        rejected: [],
        traceId: 'trace',
      },
      'eod subAck',
    );
  });

  it('rejects the frames §6.7 says are protocol errors', () => {
    expect(ws.ClientMsg.safeParse({ t: 'hello', protocol: 2, client: 'web/0.1.0' }).success).toBe(
      false, // 4010 PROTOCOL_VERSION
    );
    expect(ws.ClientMsg.safeParse({ t: 'nope' }).success).toBe(false); // 4002 PROTOCOL_ERROR
    expect(
      ws.ClientMsg.safeParse({ t: 'sub', id: 1, subjects: [{ s: 'nope:42', f: ['PX_LAST'] }] })
        .success,
    ).toBe(false); // subject grammar (ARCHITECTURE §6.1)
    expect(
      ws.ClientMsg.safeParse({ t: 'sub', id: 1, subjects: [{ s: 'q:42', f: ['px_last'] }] })
        .success,
    ).toBe(false); // FIELD_ID_PATTERN is uppercase
    expect(
      ws.ClientMsg.safeParse({
        t: 'sub',
        id: 1,
        subjects: [{ s: 'q:42', f: Array.from({ length: 101 }, () => 'PX_LAST') }],
      }).success,
    ).toBe(false); // maxFields = 100 (§6.7)
    expect(ws.ClientMsg.safeParse({ t: 'conflation', ms: 10 }).success).toBe(false); // 50..5000
  });
});

// ---------------------------------------------------------------------------------------------
// API.md §6.7 — limits and close codes (L1012-1029)
// ---------------------------------------------------------------------------------------------

describe('API.md §6.7 — close codes', () => {
  it('carries every code of the table, with the documented name', () => {
    expect(ws.WS_CLOSE).toEqual({
      NORMAL: 1000,
      SERVER_SHUTDOWN: 1001,
      IDLE: 4000,
      AUTH_REQUIRED: 4001,
      PROTOCOL_ERROR: 4002,
      SESSION_SUPERSEDED: 4003,
      SLOW_CONSUMER: 4008,
      PROTOCOL_VERSION: 4010,
      SUBSCRIPTION_LIMIT: 4011,
      RATE_LIMITED: 4029,
    });
    // CONTRACTS §2.2 L570 lists the eight application codes (1000/1001 are RFC 6455's).
    expect(ws.WS_CLOSE_TABLE.map((r) => r.code).filter((c) => c >= 4000)).toEqual([
      4000, 4001, 4002, 4003, 4008, 4010, 4011, 4029,
    ]);
    expect(ws.WS_CLOSE_TABLE.map((r) => r.code)).toEqual(Object.values(ws.WS_CLOSE));
  });

  it('names a code and knows which are retryable', () => {
    expect(ws.wsCloseName(4008)).toBe('SLOW_CONSUMER');
    expect(ws.wsCloseName(1234)).toBeUndefined();
    // Terminal: reconnecting without new credentials or a new build would loop.
    for (const code of [
      ws.WS_CLOSE.AUTH_REQUIRED,
      ws.WS_CLOSE.PROTOCOL_ERROR,
      ws.WS_CLOSE.PROTOCOL_VERSION,
      ws.WS_CLOSE.SESSION_SUPERSEDED,
    ]) {
      expect(ws.wsCloseIsRetryable(code)).toBe(false);
    }
    for (const code of [
      ws.WS_CLOSE.SERVER_SHUTDOWN,
      ws.WS_CLOSE.IDLE,
      ws.WS_CLOSE.SLOW_CONSUMER,
      ws.WS_CLOSE.SUBSCRIPTION_LIMIT,
      ws.WS_CLOSE.RATE_LIMITED,
    ]) {
      expect(ws.wsCloseIsRetryable(code)).toBe(true);
    }
  });

  it('round-trips a bye frame carrying the code in-band', () => {
    for (const row of ws.WS_CLOSE_TABLE) {
      roundTrip(ws.ServerMsg, { t: 'bye', code: row.code, reason: row.name }, `bye ${row.name}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// CONTRACTS §2.2 — the message-type inventory
// ---------------------------------------------------------------------------------------------

describe('CONTRACTS §2.2 — message types', () => {
  it('ClientMsg has exactly the seven documented members', () => {
    expect([...ws.CLIENT_MSG_TYPES]).toEqual([
      'hello',
      'sub',
      'unsub',
      'resync',
      'conflation',
      'essential',
      'ping',
    ]);
  });

  it('ServerMsg has exactly the fourteen documented members', () => {
    expect([...ws.SERVER_MSG_TYPES].sort()).toEqual(
      [
        'welcome',
        'subAck',
        'batch',
        'downgrade',
        'resync',
        'notice',
        'alert',
        'msg',
        'err',
        'pong',
        'bye',
        'snap',
        'delta',
        'status',
      ].sort(),
    );
  });

  it('every declared type is actually reachable through the union', () => {
    const minimal: Record<string, unknown> = {
      hello: { t: 'hello', protocol: 1, client: 'web/0.1.0' },
      sub: { t: 'sub', id: 1, subjects: [] },
      unsub: { t: 'unsub', subjects: ['q:42'] },
      resync: { t: 'resync', subjects: ['q:42'] },
      conflation: { t: 'conflation', ms: 250 },
      essential: { t: 'essential', subjects: ['q:42'], essential: true },
      ping: { t: 'ping', n: 1 },
    };
    for (const t of ws.CLIENT_MSG_TYPES) {
      const parsed = ws.ClientMsg.parse(minimal[t]);
      expect(parsed.t).toBe(t);
      roundTrip(ws.ClientMsg, minimal[t], `ClientMsg ${t}`);
    }

    const ts = { src: 1, cap: 2, pub: 3 };
    const prov = { p: 'cboe.quotes', id: 1 };
    const serverMinimal: Record<string, unknown> = {
      welcome: {
        t: 'welcome',
        sessionId: 's',
        serverTime: 1,
        protocol: 1,
        conflationMs: 250,
        heartbeatMs: 15000,
        limits: { maxSubscriptions: 10000, maxFields: 100 },
      },
      subAck: { t: 'subAck', id: 1, accepted: [], rejected: [], traceId: 't' },
      snap: {
        t: 'snap',
        s: 'q:42',
        seq: 1,
        tier: 'delayed',
        reason: 'OK',
        f: { PX_LAST: 1 },
        ts,
        st: 'live',
        session: 'open',
        prov,
        ac: 'equity',
        id: 42,
      },
      delta: { t: 'delta', s: 'q:42', seq: 2, prev: 1, f: { PX_LAST: 2 }, ts, st: 'live' },
      status: { t: 'status', s: 'q:42', st: 'halted', ts: 1 },
      batch: { t: 'batch', m: [] },
      downgrade: { t: 'downgrade', from: 'delayed', to: 'eod', reason: 'NOT_ENTITLED_TIER' },
      resync: { t: 'resync' },
      notice: { t: 'notice', kind: 'overload', action: 'shed' },
      alert: { t: 'alert', alertId: 'a1', firedAt: 1, payload: { any: 'shape' } },
      msg: { t: 'msg', room: 'room:1', message: { any: 'shape' } },
      err: { t: 'err', code: 'PROTOCOL_ERROR', message: 'bad frame', traceId: 't', fatal: true },
      pong: { t: 'pong', n: 1, serverTime: 2 },
      bye: { t: 'bye', code: 4000, reason: 'IDLE' },
    };
    for (const t of ws.SERVER_MSG_TYPES) {
      const parsed = ws.ServerMsg.parse(serverMinimal[t]);
      expect(parsed.t).toBe(t);
      roundTrip(ws.ServerMsg, serverMinimal[t], `ServerMsg ${t}`);
    }
  });

  it('a batch carries snap, delta and status frames', () => {
    const batch = {
      t: 'batch',
      m: [
        {
          t: 'snap',
          s: 'q:42',
          seq: 1,
          tier: 'delayed',
          reason: 'OK',
          f: { PX_LAST: 1 },
          ts: { src: 1, cap: 2, pub: 3 },
          st: 'live',
          session: 'open',
          prov: { p: 'cboe.quotes', id: 1 },
          ac: 'equity',
          id: 42,
        },
        {
          t: 'delta',
          s: 'q:42',
          seq: 2,
          prev: 1,
          f: { PX_LAST: 2 },
          ts: { src: 1, cap: 2, pub: 3 },
          st: 'live',
        },
        { t: 'status', s: 'q:42', st: 'closed', ts: 4 },
      ],
    };
    const parsed = roundTrip(ws.ServerMsg, batch, 'batch of three') as { m: { t: string }[] };
    expect(parsed.m.map((m) => m.t)).toEqual(['snap', 'delta', 'status']);
  });

  it('WS_PROTOCOL_VERSION is the single version v1 serves', () => {
    expect(ws.WS_PROTOCOL_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// API.md §12.1 — login, then a historical read with adjustment (L1396-1432)
// ---------------------------------------------------------------------------------------------

const LOGIN_REQUEST = `
{ "email": "pm@demo.terminal", "password": "correct horse battery staple", "deviceId": "d_9f3a1c2b7e" }
`;

const LOGIN_RESPONSE = `
{ "session": { "sessionId": "6a1c…", "userId": 2, "firmId": 1, "firmName": "Demo Capital", "email": "pm@demo.terminal", "displayName": "Demo PM",
    "desk": "Equities PM", "role": "user", "clientKind": "web", "mfaRequired": false, "mfaVerified": false, "webauthnEnrolled": false,
    "createdAt": "2026-09-15T18:40:00Z", "expiresAt": "2026-09-22T18:40:00Z",
    "entitlementSummary": { "defaultTier": "delayed", "exportAllowed": true, "apiAllowed": true },
    "quotas": { "dailyUniqueInstruments": { "used": 0, "limit": 500, "resetsAt": "2026-09-16T00:00:00Z" }, "monthlyDataPoints": { "used": 0, "limit": 2000000, "resetsAt": "2026-10-01T00:00:00Z" },
                "concurrentSubscriptions": { "used": 0, "limit": 10000, "resetsAt": "2026-09-15T18:40:00Z" } },
    "protocol": 1, "serverVersion": "0.1.0", "minClientVersion": "0.1.0", "dictionaryVersion": "2026.09.1" },
  "mfaRequired": false,
  "superseded": { "sessionId": "58b0…", "deviceId": "d_11aa…", "deviceLabel": "Chrome on macOS", "lastSeenAt": "2026-09-15T17:02:11Z" } }
`;

const DATA_REQUEST = `
{ "kind": "historical", "securities": [{ "ref": "AAPL US Equity" }], "fields": ["PX_LAST"], "start": "2020-08-27", "end": "2020-09-01",
  "adjust": "price", "asOf": { "knownAt": "2026-09-15T00:00:00Z" } }
`;

const DATA_RESPONSE = `
{ "meta": { "traceId": "5c0e…", "asOf": { "validAt": "2026-09-15T18:41:30.002Z", "knownAt": "2026-09-15T00:00:00Z" }, "tier": "eod", "staleness": "closed",
            "provenance": [{ "idx": 0, "sourceId": "yahoo.chart", "provenanceId": 91177, "capturedAt": "2026-09-15T18:41:28Z", "sourceTs": null, "attribution": "Yahoo Finance chart v8 (unofficial; 15-min delayed)" }],
            "entitlement": [], "unavailable": [], "engines": [{ "name": "adjust", "version": "1.0.0", "inputsHash": "9b1e…" }],
            "adjustments": [{ "beforeDate": "2020-08-31", "priceFactor": 0.25, "volumeFactor": 4, "kind": "split" }],
            "servedAt": "2026-09-15T18:41:30.002Z", "quota": { "dataPointsCharged": 4, "uniqueInstrumentsAdded": 1 } },
  "results": [{ "security": { "ref": "AAPL US Equity" },
                "instrument": { "instrumentId": 42, "assetClass": "equity", "marketSector": "Equity", "display": "AAPL US Equity", "name": "Apple Inc", "currency": "USD",
                                "primaryListingId": 7, "mdLineIds": [101, 102], "ticker": "AAPL", "exchCode": "US", "securityType": "Common Stock", "compositeFigi": "BBG000B9XRY4", "status": "active", "priceDecimals": 2 },
                "series": { "columns": ["PX_LAST"], "index": ["2020-08-27","2020-08-28","2020-08-31","2020-09-01"], "rows": [[125.0100],[124.8075],[129.04],[134.18]], "adjust": "price", "currency": "USD", "provIdx": [0] },
                "tier": "eod", "st": "closed" }] }
`;

/** §12.2 L1437-1438 — the only complete JSON body of that example; the 200 response is elided. */
const FUNCTION_RUN_REQUEST = `
{ "security": { "ref": "AAPL US Equity" }, "params": { "range": "1M", "periodicity": "D", "adjust": "price" }, "panelId": "p1", "launchKind": "launch" }
`;

/** `wire/rest/*` is loaded lazily so a resolution failure names the module rather than the file. */
type RestIndex = typeof RestIndexModule;
let restCache: Promise<RestIndex> | undefined;
const rest = async (): Promise<RestIndex> => {
  restCache ??= import('../src/wire/rest/index.js');
  return restCache;
};

describe('API.md §12.1 — login, then a historical read', () => {
  it('POST /auth/login body parses as Rest.Auth.LoginRequest', async () => {
    const { auth } = await rest();
    const body = roundTrip(auth.LoginRequest, example(LOGIN_REQUEST), 'LoginRequest') as {
      email: string;
      deviceId: string;
    };
    expect(body.email).toBe('pm@demo.terminal');
    expect(body.deviceId).toBe('d_9f3a1c2b7e');
  });

  it('the 200 body parses as Rest.Auth.LoginResponse', async () => {
    const { auth } = await rest();
    const body = roundTrip(auth.LoginResponse, example(LOGIN_RESPONSE), 'LoginResponse') as {
      session: {
        userId: number;
        role: string;
        clientKind: string;
        protocol: number;
        dictionaryVersion: string;
        entitlementSummary: { defaultTier: string };
        quotas: { monthlyDataPoints: { limit: number } };
      };
      mfaRequired: boolean;
      superseded: { deviceLabel: string } | null;
    };
    expect(body.session.userId).toBe(2);
    expect(body.session.role).toBe('user');
    expect(body.session.clientKind).toBe('web');
    expect(body.session.protocol).toBe(ws.WS_PROTOCOL_VERSION);
    expect(body.session.dictionaryVersion).toBe('2026.09.1');
    expect(body.session.entitlementSummary.defaultTier).toBe('delayed');
    expect(body.session.quotas.monthlyDataPoints.limit).toBe(2_000_000);
    expect(body.mfaRequired).toBe(false);
    // SEC-03: the web session this login displaced.
    expect(body.superseded?.deviceLabel).toBe('Chrome on macOS');
  });

  it('POST /data body parses as DataRequest and takes the documented defaults', () => {
    const decoded = roundTrip(
      dataRequest.DataRequest,
      example(DATA_REQUEST),
      'DataRequest',
    ) as dataRequest.DataRequestOf<'historical'>;
    expect(decoded.kind).toBe('historical');
    expect(decoded.securities).toEqual([{ ref: 'AAPL US Equity' }]);
    expect(decoded.fields).toEqual(['PX_LAST']);
    expect(decoded.start).toBe('2020-08-27');
    expect(decoded.end).toBe('2020-09-01');
    expect(decoded.adjust).toBe('price');
    expect(decoded.asOf).toEqual({ knownAt: '2026-09-15T00:00:00Z' });
    // Defaults the document relies on without printing them (API.md §4).
    expect(decoded.usage).toBe('display');
    expect(decoded.periodicity).toBe('D');
    expect(decoded.fill).toBe('none');
    expect(decoded.calendarAlign).toBe('primary');
  });

  it('the 200 body parses as DataResponse, adjustments and provenance included', () => {
    const decoded = roundTrip(
      dataRequest.DataResponse,
      example(DATA_RESPONSE),
      'DataResponse',
    ) as dataRequest.DataResponse;

    expect(decoded.meta.tier).toBe('eod');
    expect(decoded.meta.staleness).toBe('closed');
    expect(decoded.meta.provenance).toHaveLength(1);
    expect(decoded.meta.provenance[0]!.sourceId).toBe('yahoo.chart');
    expect(decoded.meta.provenance[0]!.attribution).toContain('Yahoo Finance');
    // REF-09: the 4:1 split of 2020-08-31.
    expect(decoded.meta.adjustments).toEqual([
      { beforeDate: '2020-08-31', priceFactor: 0.25, volumeFactor: 4, kind: 'split' },
    ]);
    expect(decoded.meta.quota).toEqual({ dataPointsCharged: 4, uniqueInstrumentsAdded: 1 });

    const result = decoded.results[0]!;
    expect(result.instrument?.display).toBe('AAPL US Equity');
    expect(result.instrument?.compositeFigi).toBe('BBG000B9XRY4');
    expect(result.series?.columns).toEqual(['PX_LAST']);
    expect(result.series?.index).toEqual(['2020-08-27', '2020-08-28', '2020-08-31', '2020-09-01']);
    expect(result.series?.rows).toEqual([[125.01], [124.8075], [129.04], [134.18]]);
    // DATA-10: every value block cites an index into meta.provenance.
    for (const idx of result.series?.provIdx ?? []) {
      expect(decoded.meta.provenance[idx]).toBeDefined();
    }
  });

  it('parses the individual envelope schemas the response is assembled from', () => {
    const wire = example(DATA_RESPONSE) as {
      meta: Record<string, unknown>;
      results: Record<string, unknown>[];
    };
    roundTrip(envelope.Meta, wire.meta, 'Meta');
    roundTrip(envelope.AsOf, wire.meta.asOf, 'AsOf');
    for (const p of wire.meta.provenance as unknown[]) {
      roundTrip(envelope.ProvenanceRef, p, 'ProvenanceRef');
    }
    for (const e of wire.meta.engines as unknown[]) {
      roundTrip(envelope.EngineNote, e, 'EngineNote');
    }
    for (const a of wire.meta.adjustments as unknown[]) {
      roundTrip(envelope.AdjustmentStep, a, 'AdjustmentStep');
    }
    const result = wire.results[0]!;
    roundTrip(dataRequest.DataResult, result, 'DataResult');
    roundTrip(dataRequest.SeriesBlock, result.series, 'SeriesBlock');
    roundTrip(envelope.InstrumentSummary, result.instrument, 'InstrumentSummary');
    roundTrip(envelope.SecurityRefInput, result.security, 'SecurityRefInput');
  });

  it('rejects the elided values the document prints, which is why EXPANSIONS exists', () => {
    // Guards the expansion table: if these ever became valid the elisions would be hiding a
    // weakened schema rather than a truncated document.
    expect(
      envelope.Meta.safeParse({
        ...(example(DATA_RESPONSE) as { meta: object }).meta,
        traceId: '5c0e…',
      }).success,
    ).toBe(false);
    expect(
      envelope.EngineNote.safeParse({ name: 'adjust', version: '1.0.0', inputsHash: '9b1e…' })
        .success,
    ).toBe(false);
  });
});

describe('API.md §12.2 — function run', () => {
  it('POST /functions/HP/run body parses as Rest.Functions.FunctionRunRequest', async () => {
    const { functions } = await rest();
    const decoded = roundTrip(
      functions.FunctionRunRequest,
      example(FUNCTION_RUN_REQUEST),
      'FunctionRunRequest',
    ) as {
      security: unknown;
      params: Record<string, unknown>;
      panelId: string;
      launchKind: string;
    };
    expect(decoded.security).toEqual({ ref: 'AAPL US Equity' });
    expect(decoded.params).toEqual({ range: '1M', periodicity: 'D', adjust: 'price' });
    expect(decoded.panelId).toBe('p1');
    expect(decoded.launchKind).toBe('launch');
  });

  it('parses the §12.2 payload envelope once its elided members are supplied', async () => {
    const { functions } = await rest();
    // L1440-1441 prints `"data": { "variant": "equity", "rows": [ … ], "columns": [ … ] }` and a
    // `meta` with `"asOf": { … }`: the shape is elided, not just a value, so the concrete members
    // below stand in. `data` is `z.unknown()` on the wire — the manifest types it on the SDK side.
    const payload = {
      data: { variant: 'equity', rows: [], columns: [] },
      meta: {
        resultId: '01J8ZC5Q9W3F5X0T6M2N4V8Y7A',
        traceId: '5c0e9d2b-6d6f-4f4a-9a1a-0b5a6c7d8e9f',
        asOf: { validAt: '2026-09-15T18:41:30.002Z', knownAt: '2026-09-15T00:00:00Z' },
        tier: 'delayed',
        staleness: 'closed',
        provenance: [],
        entitlement: [],
        unavailable: [],
        engines: [],
        servedAt: '2026-09-15T18:41:30.002Z',
      },
    };
    const decoded = roundTrip(functions.Payload, payload, 'Payload') as {
      meta: { resultId: string };
    };
    // The ULID the CSV route of L1443 is fetched by.
    expect(decoded.meta.resultId).toBe('01J8ZC5Q9W3F5X0T6M2N4V8Y7A');
    roundTrip(envelope.PayloadMeta, payload.meta, 'PayloadMeta');
  });
});

// ---------------------------------------------------------------------------------------------
// Every zod schema in wire/**
// ---------------------------------------------------------------------------------------------

/** Collects every parser reachable from a module namespace, route descriptors included. */
function collectParsers(
  value: unknown,
  path: string,
  out: Map<string, Parser>,
  depth = 0,
): Map<string, Parser> {
  if (isParser(value)) {
    out.set(path, value);
    return out;
  }
  if (depth >= 4 || typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectParsers(child, path === '' ? key : `${path}.${key}`, out, depth + 1);
  }
  return out;
}

/** Inputs that must never make a schema throw; `safeParse` has to answer for all of them. */
const HOSTILE: readonly unknown[] = [
  undefined,
  null,
  0,
  -1,
  Number.NaN,
  '',
  'PX_LAST',
  true,
  [],
  [null],
  {},
  { t: 'not-a-member' },
  { kind: 'not-a-member' },
  new Date(0),
];

describe('wire/** — every exported zod schema', () => {
  it('exposes schemas from all four core wire modules and all seventeen REST modules', async () => {
    const { restModules } = await rest();
    expect(Object.keys(restModules)).toHaveLength(17);

    const all = new Map<string, Parser>();
    collectParsers(envelope, 'envelope', all);
    collectParsers(reasonCodes, 'reasonCodes', all);
    collectParsers(ws, 'ws', all);
    collectParsers(dataRequest, 'dataRequest', all);
    for (const [name, mod] of Object.entries(restModules)) {
      collectParsers(mod, `rest.${name}`, all);
    }

    // A tripwire, not a target: 691 parsers were reachable when this was written, so a collapse
    // to a handful means a module stopped exporting its schemas rather than that one was removed.
    expect(all.size).toBeGreaterThanOrEqual(600);
    for (const key of [
      'ws.ClientMsg',
      'ws.ServerMsg',
      'envelope.Meta',
      'dataRequest.DataRequest',
    ]) {
      expect(all.has(key)).toBe(true);
    }
  });

  it('answers safeParse for every hostile input without throwing', async () => {
    const { restModules } = await rest();
    const all = new Map<string, Parser>();
    collectParsers(envelope, 'envelope', all);
    collectParsers(reasonCodes, 'reasonCodes', all);
    collectParsers(ws, 'ws', all);
    collectParsers(dataRequest, 'dataRequest', all);
    for (const [name, mod] of Object.entries(restModules)) {
      collectParsers(mod, `rest.${name}`, all);
    }

    const failures: string[] = [];
    for (const [name, schema] of all) {
      for (const input of HOSTILE) {
        try {
          const result = schema.safeParse(input);
          if (typeof result.success !== 'boolean') {
            failures.push(`${name}: safeParse(${String(input)}) returned no success flag`);
          }
        } catch (err) {
          failures.push(`${name}: safeParse(${String(input)}) threw ${String(err)}`);
        }
      }
      // `parse` must throw rather than return on a value `safeParse` rejects.
      if (!schema.safeParse(Symbol.iterator).success) {
        expect(() => schema.parse(Symbol.iterator)).toThrow();
      }
    }
    expect(failures).toEqual([]);
  });

  it('gives every REST route descriptor a response schema', async () => {
    const { restModules } = await rest();
    const problems: string[] = [];
    for (const [modName, mod] of Object.entries(restModules)) {
      for (const [exportName, exported] of Object.entries(mod as Record<string, unknown>)) {
        if (typeof exported !== 'object' || exported === null || isParser(exported)) continue;
        for (const [routeName, route] of Object.entries(exported as Record<string, unknown>)) {
          if (typeof route !== 'object' || route === null) continue;
          const r = route as Record<string, unknown>;
          if (typeof r.method !== 'string' || typeof r.path !== 'string') continue;
          const at = `${modName}.${exportName}.${routeName}`;
          if (!isParser(r.response)) problems.push(`${at}: response is not a zod schema`);
          for (const slot of ['params', 'query', 'body'] as const) {
            if (r[slot] !== undefined && !isParser(r[slot])) {
              problems.push(`${at}: ${slot} is not a zod schema`);
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The common vocabulary the examples lean on
// ---------------------------------------------------------------------------------------------

describe('wire/envelope + wire/reasonCodes — the shared vocabulary', () => {
  it('accepts the subject ids of ARCHITECTURE §6.1 and rejects the rest', () => {
    for (const s of [
      'q:42',
      'l:42',
      'b1m:42',
      'oc:AAPL.2026-09-16',
      'c:1',
      'r:42',
      'e:CPIAUCSL',
      'n:1',
      'alerts:7',
      'room:12',
      'sys:status',
    ]) {
      expect(envelope.SubjectId.safeParse(s).success, s).toBe(true);
    }
    for (const s of ['q', 'q:', 'x:42', 'Q:42', 'q:42/7', '']) {
      expect(envelope.SubjectId.safeParse(s).success, s).toBe(false);
    }
  });

  it('accepts the field ids of the dictionary and rejects malformed ones', () => {
    for (const f of ['PX_LAST', 'CHG_PCT_1D', 'OPT_IMPL_VOL_MID', 'BS_TOT_LIAB2']) {
      expect(envelope.FieldId.safeParse(f).success, f).toBe(true);
    }
    for (const f of ['px_last', '1PX', 'P', '', 'A'.repeat(41)]) {
      expect(envelope.FieldId.safeParse(f).success, f).toBe(false);
    }
  });

  it('carries all thirteen reason codes, and the wire union re-exports the same enum', () => {
    expect([...reasonCodes.REASON_CODES]).toEqual([
      'OK',
      'SOURCE_TIER_CAP',
      'NOT_ENTITLED_TIER',
      'NO_FIRM_ENTITLEMENT',
      'NO_USER_ENTITLEMENT',
      'LICENCE_FORBIDS_USAGE',
      'TIER_EOD',
      'CONCURRENT_SESSION',
      'QUOTA_EXCEEDED',
      'PROVIDER_DOWN',
      'SUBJECT_UNKNOWN',
      'FIELD_UNKNOWN',
      'NOT_IN_UNIVERSE',
    ]);
    for (const code of reasonCodes.REASON_CODES) {
      expect(reasonCodes.REASON_CODE_MEANINGS[code]).toBeTruthy();
      expect(envelope.ReasonCode.safeParse(code).success).toBe(true);
    }
  });

  it('maps every error code to an HTTP status and marks the retryable ones', () => {
    for (const code of envelope.ErrorCode.options) {
      const status = envelope.ERROR_CODE_STATUS[code];
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
    }
    for (const code of envelope.RETRYABLE_ERROR_CODES) {
      expect(envelope.ErrorCode.safeParse(code).success, code).toBe(true);
    }
  });

  it('round-trips an error envelope', () => {
    roundTrip(
      envelope.ErrorEnvelope,
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'body failed validation',
          traceId: '5c0e9d2b-6d6f-4f4a-9a1a-0b5a6c7d8e9f',
          retryable: false,
          details: { location: 'body' },
        },
      },
      'ErrorEnvelope',
    );
  });

  it('accepts exactly the three security-ref forms', () => {
    for (const ref of [
      { id: 42 },
      { ref: 'AAPL US Equity' },
      { formula: 'RATIO(AAPL US Equity, SPX Index)' },
    ]) {
      roundTrip(envelope.SecurityRefInput, ref, 'SecurityRefInput');
    }
    expect(envelope.SecurityRefInput.safeParse({ id: 0 }).success).toBe(false);
    expect(envelope.SecurityRefInput.safeParse({ ref: '' }).success).toBe(false);
  });

  it('round-trips one request of every DataRequest kind', () => {
    const base = { securities: [{ ref: 'AAPL US Equity' }], fields: ['PX_LAST'] };
    const byKind: Record<dataRequest.DataKind, unknown> = {
      reference: { ...base, kind: 'reference' },
      historical: { ...base, kind: 'historical', start: '2020-08-27' },
      intraday: { ...base, kind: 'intraday', start: '2026-09-15T13:30:00Z' },
      tick: {
        ...base,
        kind: 'tick',
        start: '2026-09-15T13:30:00Z',
        end: '2026-09-15T20:00:00Z',
      },
      realtime: { ...base, kind: 'realtime' },
    };
    for (const kind of dataRequest.DATA_KINDS) {
      const decoded = roundTrip(dataRequest.DataRequest, byKind[kind], `DataRequest ${kind}`) as {
        kind: string;
        usage: string;
      };
      expect(decoded.kind).toBe(kind);
      expect(decoded.usage).toBe('display');
    }
  });
});
