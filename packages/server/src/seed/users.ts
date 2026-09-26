// packages/server/src/seed/users.ts
//
// Seed module 12 of DATA_MODEL §18 (L2571): the desk itself — two firms, seven natural persons,
// their credentials, their entitlements, their quotas, two rooms, six messages and the MSG-02
// surveillance lexicon.
//
//   fixtures/seed/firms.json        → firms 2
//   fixtures/seed/users.json        → users 7, user_credentials 7, rooms 2, room_members, messages 6,
//                                     message_reads
//   fixtures/seed/entitlements.json → entitlement_grants 8, quota_limits 2, surveillance_lexicon 12
//
// This module is the one place in WP-15 where the fixture *is* the source: none of these rows comes
// from a provider, and none of these tables has a `provenance_id` column (0011, 0013) — a seat, a
// grant and a message are facts about the deployment, not observations of a market. DATA-10
// constrains seeded market values; this is the complement of that set, which is why it is checkable:
// the acceptance test walks the columns rather than a list, so a table that grows a
// `provenance_id` later cannot quietly opt out.
//
// **Nothing here is resolved from the security master**, deliberately. No message carries an MSG-04
// attachment and no grant names an instrument, so module 12 lands identically whether or not
// `seed/universe.ts` has run. That matters because `messages` is WORM and hash-chained (0013,
// 0017.f/g): a row cannot be amended, so an attachment that could only be resolved on a later run
// would either be permanently absent or arrive as a *seventh* message — and the second of those
// breaks the "twice writes zero rows" contract of §18 in a way no upsert can repair, because the
// chain trigger assigns `seq` and `hash` and refuses to go backwards.
//
// **Idempotence, per table.** `firms`, `rooms` and `portfolios` have no natural unique key that a
// name alone gives them, so each is looked up by name first and inserted only when absent; `users`
// upserts on `lower(email)`; `entitlement_grants`, `quota_limits` and `surveillance_lexicon` are
// matched on the tuple the fixture states and written only when that tuple is new or changed;
// `messages` is `ON CONFLICT (room_id, client_msg_id) DO NOTHING`, which is the same idempotent-send
// key the API uses, so the seeded conversation cannot fork its own hash chain on a second run.
//
// `user_credentials` deserves its own note. The hash is pgcrypto's `crypt(password,
// gen_salt('bf', 12))`, which draws a **random** salt: the same password hashes differently every
// time, so an upsert of the credential would write a row on every single run and the idempotence
// acceptance row could never pass. `http/auth/password.ts#setPassword` is a `DO UPDATE` because
// rotating a password is what it is for; the seed is not, so it is `DO NOTHING`. A password an
// operator has since changed is also not something a re-seed may quietly reset.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { openReplayStore } from '../providers/replayStore.js';

import type { SeedContext } from './index.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture access
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `fixtures/seed` directory, resolved from the replay store's root.
 *
 * Deliberately a second copy of `seed/fundamentals.ts#seedFixtureDir` rather than an import of it:
 * `fundamentals.ts` pulls in the whole SEC ingest graph, and `npm run db:seed users` would then load
 * and type-check four large jobs to read a 4 KB JSON file. `config.REPLAY_DIR` is the single setting
 * both copies read, so they cannot point at different fixture sets.
 */
export function seedFixtureDir(): string {
  return join(dirname(openReplayStore().dir), 'seed');
}

/** Read and parse one `fixtures/seed/*.json`. A malformed or missing file fails the seed. */
export function readSeedFixture<T>(name: string): T {
  const path = join(seedFixtureDir(), name);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `seed fixture ${name} is missing at ${path} — WP-15 owns fixtures/seed/* and a module may ` +
        `not fall back to invented data (DATA_MODEL §18): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(
      `seed fixture ${name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tenant context
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The identity the RLS policies of 0015 §15.f read (DATA_MODEL §15.1). */
export interface SeedTenant {
  userId: number;
  firmId: number;
  role: string;
}

/**
 * Run `fn` with `app.user_id` / `app.firm_id` / `app.role` set for the rest of this transaction,
 * then clear them.
 *
 * `seed/index.ts` says the seed "runs as the database owner and the tenant policies do not apply to
 * it", and on a local dev cluster that is true because the owner is a superuser and a superuser
 * bypasses RLS even under `FORCE`. It is **not** true of an owner that is not a superuser, which is
 * the deployment DATA_MODEL §20 actually asks for ("the server never connects as the owner"), and
 * `messages`, `portfolios`, `positions` and `lots` are all `FORCE ROW LEVEL SECURITY`. A seed that
 * only works because the local dev role happens to be a superuser is a seed that fails the first
 * time somebody provisions the database properly, with a `42501` naming a policy rather than
 * anything about seeding.
 *
 * So the writes to tenant tables adopt the identity that actually owns the row — `messages` under
 * its sender, a workspace under its user — which satisfies the `WITH CHECK` clauses by telling the
 * truth rather than by holding a privilege. `set_config(..., true)` is transaction-scoped, and the
 * settings are cleared to `''` afterwards because `app_user_id()` is `NULLIF(current_setting(…),
 * '')::bigint`: an empty string is "no context", which is what every later statement in the module
 * should see.
 */
export async function withTenant<T>(
  ctx: SeedContext,
  tenant: SeedTenant,
  fn: () => Promise<T>,
): Promise<T> {
  await ctx.query(
    `SELECT set_config('app.user_id', $1, true), set_config('app.firm_id', $2, true), set_config('app.role', $3, true)`,
    [String(tenant.userId), String(tenant.firmId), tenant.role],
  );
  try {
    return await fn();
  } finally {
    await ctx.query(
      `SELECT set_config('app.user_id', '', true), set_config('app.firm_id', '', true), set_config('app.role', '', true)`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface FirmFixtureRow {
  key: string;
  name: string;
  lei: string | null;
  contractRef: string | null;
  seatCount: number;
  retentionDays: number;
  dataResidency: string;
  status: string;
  policy: Record<string, unknown>;
}

interface FirmsFixture {
  firms: FirmFixtureRow[];
}

interface UserFixtureRow {
  key: string;
  firm: string;
  email: string;
  displayName: string;
  desk: string;
  role: string;
  status: string;
  sanctionsStatus: string;
}

interface RoomFixtureRow {
  key: string;
  kind: string;
  name: string | null;
  firm: string;
  scope: string;
  createdBy: string;
  retentionDays: number;
  disclaimer: string | null;
  wallTag: string | null;
  policy: Record<string, unknown>;
  members: { user: string; role: string }[];
}

interface MessageFixtureRow {
  room: string;
  sender: string;
  sentAt: string;
  clientMsgId: string;
  body: string;
}

interface UsersFixture {
  password: string;
  verifiedAt: string;
  users: UserFixtureRow[];
  rooms: RoomFixtureRow[];
  messages: MessageFixtureRow[];
  reads: { room: string; user: string; lastReadSeq: number }[];
}

interface GrantFixtureRow {
  subjectKind: 'user' | 'firm';
  subject: string;
  sourceId: string | null;
  assetClass: string | null;
  fieldClass: string | null;
  maxTier: string;
  usageDisplay: boolean;
  usageExport: boolean;
  usageApi: boolean;
  contractRef: string | null;
  note: string;
}

interface QuotaFixtureRow {
  subjectKind: 'user' | 'firm';
  subject: string;
  dailyUniqueInstruments: number;
  monthlyDataPoints: number;
  concurrentSubscriptions: number;
}

interface LexiconFixtureRow {
  pattern: string;
  severity: number;
  note: string;
}

interface EntitlementsFixture {
  grants: GrantFixtureRow[];
  quotaLimits: QuotaFixtureRow[];
  surveillanceLexicon: LexiconFixtureRow[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** First column of the first row, or `undefined` when the statement returned none. */
function firstId(result: { rows: unknown[] }, column: string): number | undefined {
  const row = result.rows[0] as Record<string, string | number> | undefined;
  if (row === undefined) return undefined;
  const value = row[column];
  return value === undefined ? undefined : Number(value);
}

/**
 * Look up `key` in `map` or fail with a message naming the fixture field.
 *
 * A fixture that references a firm or user key that does not exist is a typo, and the alternatives
 * are both worse than an exception: `undefined` would become a NULL in a NOT NULL column (a
 * constraint error naming a column, not the typo) or, worse, silently skip the row.
 */
function required<T>(map: ReadonlyMap<string, T>, key: string, what: string): T {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(
      `fixtures/seed references ${what} '${key}', which no fixture row defines — check the ` +
        '`key` fields of firms.json and users.json',
    );
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The module
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SeedUsersResult {
  firmsInserted: number;
  usersInserted: number;
  usersUpdated: number;
  credentialsInserted: number;
  grantsInserted: number;
  grantsUpdated: number;
  quotaLimitsWritten: number;
  lexiconInserted: number;
  roomsInserted: number;
  roomMembersInserted: number;
  messagesInserted: number;
  readsWritten: number;
}

export async function seedUsers(ctx: SeedContext): Promise<SeedUsersResult> {
  const firmsFixture = readSeedFixture<FirmsFixture>('firms.json');
  const usersFixture = readSeedFixture<UsersFixture>('users.json');
  const entitlements = readSeedFixture<EntitlementsFixture>('entitlements.json');

  const result: SeedUsersResult = {
    firmsInserted: 0,
    usersInserted: 0,
    usersUpdated: 0,
    credentialsInserted: 0,
    grantsInserted: 0,
    grantsUpdated: 0,
    quotaLimitsWritten: 0,
    lexiconInserted: 0,
    roomsInserted: 0,
    roomMembersInserted: 0,
    messagesInserted: 0,
    readsWritten: 0,
  };

  // ── firms ───────────────────────────────────────────────────────────────────────────────────
  //
  // `firms` has no unique constraint on `name` (0011), so this is a select-then-insert rather than
  // an upsert. Inside one transaction with one writer that is sound; two concurrent seeds would
  // race, and they are not a supported configuration (§18: the seed runs as the owner).
  const firmIds = new Map<string, number>();
  for (const firm of firmsFixture.firms) {
    const existing = await ctx.query(`SELECT firm_id FROM firms WHERE name = $1`, [firm.name]);
    let firmId = firstId(existing, 'firm_id');
    if (firmId === undefined) {
      const inserted = await ctx.query(
        `INSERT INTO firms (name, lei, contract_ref, seat_count, retention_days, data_residency, policy, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING firm_id`,
        [
          firm.name,
          firm.lei,
          firm.contractRef,
          firm.seatCount,
          firm.retentionDays,
          firm.dataResidency,
          JSON.stringify(firm.policy),
          firm.status,
        ],
      );
      firmId = firstId(inserted, 'firm_id');
      result.firmsInserted += 1;
    }
    if (firmId === undefined) throw new Error(`the firms insert for ${firm.name} returned no id`);
    firmIds.set(firm.key, firmId);
  }
  ctx.log(`firms +${String(result.firmsInserted)} of ${String(firmsFixture.firms.length)}`);

  // ── users ───────────────────────────────────────────────────────────────────────────────────
  //
  // `users_email_uniq` is an index on `lower(email)`, so it is a legal conflict target and the
  // upsert is one statement. The `DO UPDATE … WHERE` is what keeps a re-seed free: without the
  // predicate Postgres reports every row as affected even when it set each column to the value it
  // already held.
  const userIds = new Map<string, number>();
  for (const user of usersFixture.users) {
    const firmId = required(firmIds, user.firm, 'firm');
    const written = await ctx.query(
      `INSERT INTO users (firm_id, email, display_name, desk, role, status,
                          person_verified_at, mfa_required, sanctions_screened_at, sanctions_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, false, $7::timestamptz, $8)
       ON CONFLICT (lower(email)) DO UPDATE
          SET firm_id = EXCLUDED.firm_id, display_name = EXCLUDED.display_name,
              desk = EXCLUDED.desk, role = EXCLUDED.role, status = EXCLUDED.status,
              person_verified_at = EXCLUDED.person_verified_at,
              sanctions_screened_at = EXCLUDED.sanctions_screened_at,
              sanctions_status = EXCLUDED.sanctions_status
        WHERE users.firm_id               IS DISTINCT FROM EXCLUDED.firm_id
           OR users.display_name          IS DISTINCT FROM EXCLUDED.display_name
           OR users.desk                  IS DISTINCT FROM EXCLUDED.desk
           OR users.role                  IS DISTINCT FROM EXCLUDED.role
           OR users.status                IS DISTINCT FROM EXCLUDED.status
           OR users.person_verified_at    IS DISTINCT FROM EXCLUDED.person_verified_at
           OR users.sanctions_screened_at IS DISTINCT FROM EXCLUDED.sanctions_screened_at
           OR users.sanctions_status      IS DISTINCT FROM EXCLUDED.sanctions_status
       RETURNING user_id, (xmax = 0) AS was_insert`,
      [
        firmId,
        user.email,
        user.displayName,
        user.desk,
        user.role,
        user.status,
        usersFixture.verifiedAt,
        user.sanctionsStatus,
      ],
    );

    const row = written.rows[0] as { user_id: string | number; was_insert: boolean } | undefined;
    let userId: number;
    if (row === undefined) {
      // The `WHERE` suppressed the update, so the statement returned nothing: the row is already
      // exactly what the fixture says. Read the id back rather than treating it as a failure.
      const existing = await ctx.query(`SELECT user_id FROM users WHERE lower(email) = lower($1)`, [
        user.email,
      ]);
      const found = firstId(existing, 'user_id');
      if (found === undefined) throw new Error(`the users upsert for ${user.email} returned no id`);
      userId = found;
    } else {
      userId = Number(row.user_id);
      if (row.was_insert) result.usersInserted += 1;
      else result.usersUpdated += 1;
    }
    userIds.set(user.key, userId);

    // `WHERE NOT EXISTS` rather than `ON CONFLICT … DO NOTHING`, and the difference is measurable:
    // Postgres evaluates the VALUES list before it tests the conflict, so the `DO NOTHING` form
    // still computes a 4,096-round bcrypt per user on every run — 1.8 s of work on a re-seed that
    // writes nothing. The guard skips the hash as well as the row.
    const credential = await ctx.query(
      `INSERT INTO user_credentials (user_id, kind, secret_hash)
       SELECT $1, 'password', crypt($2, gen_salt('bf', 12))
        WHERE NOT EXISTS (
          SELECT 1 FROM user_credentials
           WHERE user_id = $1 AND kind = 'password' AND revoked_at IS NULL)
       RETURNING credential_pk`,
      [userId, usersFixture.password],
    );
    result.credentialsInserted += credential.rows.length;
  }
  ctx.log(
    `users +${String(result.usersInserted)} ~${String(result.usersUpdated)}, ` +
      `credentials +${String(result.credentialsInserted)}`,
  );

  // ── entitlement_grants ──────────────────────────────────────────────────────────────────────
  //
  // The table has no unique constraint: a subject legitimately holds several grants, and two rows
  // differing only in `valid_from` are a contract renewal, not a duplicate (0011, and DATA_MODEL
  // §20's "non-bitemporal valid_from/valid_to rows"). So the seeded row is identified by the tuple
  // the fixture states — subject, scope and usage — and an open-ended grant matching it is left
  // alone. `valid_from` is the fixture's own instant rather than `now()`, or every run would write a
  // new grant and the evaluator would see two.
  const grantValidFrom = usersFixture.verifiedAt;
  for (const grant of entitlements.grants) {
    const subjectId =
      grant.subjectKind === 'firm'
        ? required(firmIds, grant.subject, 'firm')
        : required(userIds, grant.subject, 'user');

    const existing = await ctx.query(
      `SELECT grant_id, max_tier::text AS max_tier, usage_display, usage_export, usage_api,
              contract_ref, note
         FROM entitlement_grants
        WHERE subject_kind = $1 AND subject_id = $2
          AND source_id   IS NOT DISTINCT FROM $3
          AND asset_class IS NOT DISTINCT FROM $4::asset_class
          AND field_class IS NOT DISTINCT FROM $5::field_class
          AND valid_to = 'infinity'`,
      [grant.subjectKind, subjectId, grant.sourceId, grant.assetClass, grant.fieldClass],
    );

    const row = existing.rows[0] as
      | {
          grant_id: string | number;
          max_tier: string;
          usage_display: boolean;
          usage_export: boolean;
          usage_api: boolean;
          contract_ref: string | null;
          note: string | null;
        }
      | undefined;

    if (row === undefined) {
      await ctx.query(
        `INSERT INTO entitlement_grants (subject_kind, subject_id, source_id, asset_class, field_class,
                                         max_tier, usage_display, usage_export, usage_api,
                                         valid_from, contract_ref, note)
         VALUES ($1, $2, $3, $4::asset_class, $5::field_class, $6::tier, $7, $8, $9, $10::timestamptz, $11, $12)`,
        [
          grant.subjectKind,
          subjectId,
          grant.sourceId,
          grant.assetClass,
          grant.fieldClass,
          grant.maxTier,
          grant.usageDisplay,
          grant.usageExport,
          grant.usageApi,
          grantValidFrom,
          grant.contractRef,
          grant.note,
        ],
      );
      result.grantsInserted += 1;
      continue;
    }

    // `note` and `contract_ref` are part of the comparison, not just of the UPDATE, and that is the
    // repair of a real hole: the UPDATE always wrote `note`, but `changed` only looked at the tier
    // and the three usages, so a CORRECTED note never reached a row that already existed. That
    // matters here more than it would elsewhere — `entitlement_grants.note` is not a comment in a
    // source file, it is the documentation of record for the seat, carried into the database as a
    // value and read by whoever is next debugging an entitlement decision. The `eod@demo` note
    // described behaviour the evaluator does not have for three work packages; with the old
    // comparison, fixing the fixture would have left every already-seeded database saying the wrong
    // thing forever, and `test/integration/seed/entitlements.test.ts` could not have told anyone.
    const changed =
      row.max_tier !== grant.maxTier ||
      row.usage_display !== grant.usageDisplay ||
      row.usage_export !== grant.usageExport ||
      row.usage_api !== grant.usageApi ||
      (row.contract_ref ?? null) !== (grant.contractRef ?? null) ||
      (row.note ?? null) !== (grant.note ?? null);
    if (changed) {
      await ctx.query(
        `UPDATE entitlement_grants
            SET max_tier = $2::tier, usage_display = $3, usage_export = $4, usage_api = $5,
                contract_ref = $6, note = $7
          WHERE grant_id = $1`,
        [
          row.grant_id,
          grant.maxTier,
          grant.usageDisplay,
          grant.usageExport,
          grant.usageApi,
          grant.contractRef,
          grant.note,
        ],
      );
      result.grantsUpdated += 1;
    }
  }
  ctx.log(
    `entitlement_grants +${String(result.grantsInserted)} ~${String(result.grantsUpdated)} ` +
      `of ${String(entitlements.grants.length)}`,
  );

  // ── quota_limits ────────────────────────────────────────────────────────────────────────────
  for (const quota of entitlements.quotaLimits) {
    const subjectId =
      quota.subjectKind === 'firm'
        ? required(firmIds, quota.subject, 'firm')
        : required(userIds, quota.subject, 'user');
    const written = await ctx.query(
      `INSERT INTO quota_limits (subject_kind, subject_id, daily_unique_instruments,
                                 monthly_data_points, concurrent_subscriptions)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (subject_kind, subject_id) DO UPDATE
          SET daily_unique_instruments = EXCLUDED.daily_unique_instruments,
              monthly_data_points      = EXCLUDED.monthly_data_points,
              concurrent_subscriptions = EXCLUDED.concurrent_subscriptions
        WHERE quota_limits.daily_unique_instruments IS DISTINCT FROM EXCLUDED.daily_unique_instruments
           OR quota_limits.monthly_data_points      IS DISTINCT FROM EXCLUDED.monthly_data_points
           OR quota_limits.concurrent_subscriptions IS DISTINCT FROM EXCLUDED.concurrent_subscriptions
       RETURNING subject_id`,
      [
        quota.subjectKind,
        subjectId,
        quota.dailyUniqueInstruments,
        quota.monthlyDataPoints,
        quota.concurrentSubscriptions,
      ],
    );
    result.quotaLimitsWritten += written.rows.length;
  }
  ctx.log(
    `quota_limits ~${String(result.quotaLimitsWritten)} of ${String(entitlements.quotaLimits.length)}`,
  );

  // ── surveillance_lexicon ────────────────────────────────────────────────────────────────────
  //
  // The table has no unique key either, so the pattern itself identifies a global term. Matching on
  // `firm_id IS NULL AND pattern = $1` rather than on the pattern alone keeps a firm's own copy of a
  // global term intact — a firm may legitimately run the same regex at a different severity.
  for (const term of entitlements.surveillanceLexicon) {
    const existing = await ctx.query(
      `SELECT term_id, severity FROM surveillance_lexicon WHERE firm_id IS NULL AND pattern = $1`,
      [term.pattern],
    );
    const row = existing.rows[0] as { term_id: string | number; severity: number } | undefined;
    if (row === undefined) {
      await ctx.query(
        `INSERT INTO surveillance_lexicon (firm_id, pattern, severity, active, note)
         VALUES (NULL, $1, $2, true, $3)`,
        [term.pattern, term.severity, term.note],
      );
      result.lexiconInserted += 1;
    } else if (Number(row.severity) !== term.severity) {
      await ctx.query(
        `UPDATE surveillance_lexicon SET severity = $2, note = $3 WHERE term_id = $1`,
        [row.term_id, term.severity, term.note],
      );
    }
  }
  ctx.log(
    `surveillance_lexicon +${String(result.lexiconInserted)} of ` +
      `${String(entitlements.surveillanceLexicon.length)}`,
  );

  // ── rooms and members ───────────────────────────────────────────────────────────────────────
  //
  // A dm has no name, so a room is identified by `(firm_id, kind, created_by)` plus its name — which
  // for the two seeded rooms is unique. `retention_days` is written as the fixture states it and the
  // table's own CHECK (0017.a: `>= 2557`) is the backstop, so a fixture that lowered it below seven
  // years would fail the seed rather than quietly under-retain a regulated archive (REG-01).
  const roomIds = new Map<string, number>();
  for (const room of usersFixture.rooms) {
    const firmId = required(firmIds, room.firm, 'firm');
    const createdBy = required(userIds, room.createdBy, 'user');
    const existing = await ctx.query(
      `SELECT room_id FROM rooms
        WHERE firm_id = $1 AND kind = $2 AND created_by = $3 AND name IS NOT DISTINCT FROM $4`,
      [firmId, room.kind, createdBy, room.name],
    );
    let roomId = firstId(existing, 'room_id');
    if (roomId === undefined) {
      const inserted = await ctx.query(
        `INSERT INTO rooms (kind, name, firm_id, scope, created_by, retention_days, disclaimer, wall_tag, policy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         RETURNING room_id`,
        [
          room.kind,
          room.name,
          firmId,
          room.scope,
          createdBy,
          room.retentionDays,
          room.disclaimer,
          room.wallTag,
          JSON.stringify(room.policy),
        ],
      );
      roomId = firstId(inserted, 'room_id');
      result.roomsInserted += 1;
    }
    if (roomId === undefined) throw new Error(`the rooms insert for ${room.key} returned no id`);
    roomIds.set(room.key, roomId);

    for (const member of room.members) {
      const written = await ctx.query(
        `INSERT INTO room_members (room_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (room_id, user_id) DO UPDATE SET role = EXCLUDED.role
          WHERE room_members.role IS DISTINCT FROM EXCLUDED.role
         RETURNING user_id`,
        [roomId, required(userIds, member.user, 'user'), member.role],
      );
      result.roomMembersInserted += written.rows.length;
    }
  }
  ctx.log(
    `rooms +${String(result.roomsInserted)}, room_members ~${String(result.roomMembersInserted)}`,
  );

  // ── messages ────────────────────────────────────────────────────────────────────────────────
  //
  // `seq`, `prev_hash` and `hash` are NOT written here: the `messages_chain` trigger assigns them
  // under a per-room advisory lock (DATA_MODEL §20), and `rooms.last_seq`/`last_hash` are the anchor
  // it maintains (0017.g). `hash` is NOT NULL, so the INSERT must still name a value — the trigger
  // overwrites it, and passing a placeholder rather than computing a chain here is the point: two
  // implementations of a hash chain is exactly how an archive comes to have a chain that verifies
  // only for the code that wrote it.
  //
  // The messages are inserted in fixture order so that `seq` follows the conversation, and each one
  // under its own sender's identity (see {@link withTenant}) so that `messages_member`'s WITH CHECK
  // — `sender_user_id = app_user_id() AND sender_firm_id = app_firm_id() AND is_room_member(…)` —
  // is satisfied by the row being true rather than by the writer being a superuser.
  const usersByKey = new Map(usersFixture.users.map((u) => [u.key, u]));
  for (const message of usersFixture.messages) {
    const sender = required(usersByKey, message.sender, 'user');
    const senderId = required(userIds, message.sender, 'user');
    const senderFirmId = required(firmIds, sender.firm, 'firm');
    const written = await withTenant(
      ctx,
      { userId: senderId, firmId: senderFirmId, role: sender.role },
      () =>
        ctx.query(
          `INSERT INTO messages (room_id, seq, sender_user_id, sender_firm_id, sent_at, body, client_msg_id, hash)
           VALUES ($1, 0, $2, $3, $4::timestamptz, $5, $6::uuid, '\\x00'::bytea)
           ON CONFLICT (room_id, client_msg_id) DO NOTHING
           RETURNING message_id`,
          [
            required(roomIds, message.room, 'room'),
            senderId,
            senderFirmId,
            message.sentAt,
            message.body,
            message.clientMsgId,
          ],
        ),
    );
    result.messagesInserted += written.rows.length;
  }
  ctx.log(
    `messages +${String(result.messagesInserted)} of ${String(usersFixture.messages.length)}`,
  );

  // ── message_reads ───────────────────────────────────────────────────────────────────────────
  for (const read of usersFixture.reads) {
    const written = await ctx.query(
      `INSERT INTO message_reads (room_id, user_id, last_read_seq)
       VALUES ($1, $2, $3)
       ON CONFLICT (room_id, user_id) DO UPDATE SET last_read_seq = EXCLUDED.last_read_seq
        WHERE message_reads.last_read_seq IS DISTINCT FROM EXCLUDED.last_read_seq
       RETURNING user_id`,
      [
        required(roomIds, read.room, 'room'),
        required(userIds, read.user, 'user'),
        read.lastReadSeq,
      ],
    );
    result.readsWritten += written.rows.length;
  }
  ctx.log(`message_reads ~${String(result.readsWritten)} of ${String(usersFixture.reads.length)}`);

  return result;
}

/** Module 12 of the ordered seed runner (`seed/index.ts`). */
export const usersSeedModule = {
  order: 12,
  name: 'users',
  run: seedUsers,
} as const;
