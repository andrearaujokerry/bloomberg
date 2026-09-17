/**
 * Drizzle mirror of migration 0011_users_entitlements.sql — firms, natural persons,
 * credentials, sessions and API keys. The entitlement/quota tables of the same migration
 * live in `entitlements.ts`.
 *
 * RLS policies (migration 0015) are not declared here; they are allowlisted in the drift test.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea } from './provenance.js';

/** The subscribing legal entity (tenant boundary for RLS). */
export const firms = pgTable(
  'firms',
  {
    firmId: bigint('firm_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    name: text('name').notNull(),
    lei: char('lei', { length: 20 }),
    contractRef: text('contract_ref'),
    /** Reconciled against usage declarations (ENTL-06). */
    seatCount: integer('seat_count').notNull().default(1),
    /** Messages / access-log retention floor: 7 years (MSG-03, REG-01). */
    retentionDays: integer('retention_days').notNull().default(2557),
    dataResidency: text('data_residency').notNull().default('us'),
    /** `{permittedCounterpartyFirms:[], disclaimer, ethicalWalls:[{deskA,deskB}]}` */
    policy: jsonb('policy').notNull().default({}),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('firms_status_check', sql`${t.status} IN ('active','suspended','closed')`)],
);

/** A natural person (ENTL-03, SEC-01). */
export const users = pgTable(
  'users',
  {
    userId: bigint('user_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    firmId: bigint('firm_id', { mode: 'number' })
      .notNull()
      .references(() => firms.firmId),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    /** Ethical-wall unit (MSG-03). */
    desk: text('desk'),
    role: text('role').notNull().default('user'),
    status: text('status').notNull().default('active'),
    personVerifiedAt: timestamp('person_verified_at', { withTimezone: true }),
    verifiedBy: bigint('verified_by', { mode: 'number' }),
    mfaRequired: boolean('mfa_required').notNull().default(false),
    sanctionsScreenedAt: timestamp('sanctions_screened_at', { withTimezone: true }),
    sanctionsStatus: text('sanctions_status'),
    scimExternalId: text('scim_external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    deprovisionedAt: timestamp('deprovisioned_at', { withTimezone: true }),
    /** REG-04 erasure: email/display_name replaced by `user-<id>`; access_log kept. */
    anonymisedAt: timestamp('anonymised_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('users_email_uniq').on(sql`lower(${t.email})`),
    index('users_firm_idx').on(t.firmId),
    check(
      'users_role_check',
      sql`${t.role} IN ('user','admin','compliance','dataops','helpdesk','newsroom')`,
    ),
    check(
      'users_status_check',
      sql`${t.status} IN ('invited','active','suspended','deprovisioned')`,
    ),
    check(
      'users_sanctions_status_check',
      sql`${t.sanctionsStatus} IN ('clear','review','blocked')`,
    ),
  ],
);

/** SEC-02 FIDO2/WebAuthn credentials; the password kind is a dev fallback only. */
export const userCredentials = pgTable(
  'user_credentials',
  {
    credentialPk: bigint('credential_pk', { mode: 'number' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.userId),
    kind: text('kind').notNull(),
    credentialId: bytea('credential_id'),
    publicKey: bytea('public_key'),
    signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
    transports: text('transports').array(),
    aaguid: uuid('aaguid'),
    /** `crypt(password, gen_salt('bf', 12))` via pgcrypto (password kind only). */
    secretHash: text('secret_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('user_credentials_webauthn_uniq')
      .on(t.credentialId)
      .where(sql`${t.credentialId} IS NOT NULL`),
    uniqueIndex('user_credentials_password_uniq')
      .on(t.userId)
      .where(sql`${t.kind} = 'password' AND ${t.revokedAt} IS NULL`),
    check('user_credentials_kind_check', sql`${t.kind} IN ('password','webauthn')`),
    check(
      'user_credentials_shape',
      sql`(${t.kind} = 'webauthn' AND ${t.credentialId} IS NOT NULL AND ${t.publicKey} IS NOT NULL AND ${t.secretHash} IS NULL)
          OR (${t.kind} = 'password' AND ${t.secretHash} IS NOT NULL AND ${t.credentialId} IS NULL)`,
    ),
  ],
);

/** API-01: bearer keys bound to a natural person's entitlements. */
export const apiKeys = pgTable(
  'api_keys',
  {
    apiKeyId: bigint('api_key_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.userId),
    keyHash: bytea('key_hash').notNull(),
    label: text('label').notNull(),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`'{data:read,fn:run,ws:subscribe}'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [unique('api_keys_key_hash_key').on(t.keyHash)],
);

/** ENTL-03 / SEC-03: one active web session per natural person. */
export const sessions = pgTable(
  'sessions',
  {
    sessionId: uuid('session_id').primaryKey().defaultRandom(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.userId),
    /** `digest(token, 'sha256')`; the token itself is never stored. */
    tokenHash: bytea('token_hash').notNull(),
    clientKind: text('client_kind').notNull(),
    apiKeyId: bigint('api_key_id', { mode: 'number' }),
    deviceId: text('device_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    mfaVerified: boolean('mfa_verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason'),
    supersededCount: integer('superseded_count').notNull().default(0),
  },
  (t) => [
    unique('sessions_token_hash_key').on(t.tokenHash),
    foreignKey({
      name: 'sessions_api_key_fk',
      columns: [t.apiKeyId],
      foreignColumns: [apiKeys.apiKeyId],
    }),
    // The SEC-03 invariant.
    uniqueIndex('sessions_one_active_web')
      .on(t.userId)
      .where(sql`${t.clientKind} = 'web' AND ${t.revokedAt} IS NULL`),
    index('sessions_user_idx').on(t.userId, t.createdAt.desc()),
    check('sessions_client_kind_check', sql`${t.clientKind} IN ('web','api')`),
    check(
      'sessions_revoke_reason_check',
      sql`${t.revokeReason} IN ('logout','superseded','expired','admin','deprovisioned')`,
    ),
  ],
);
