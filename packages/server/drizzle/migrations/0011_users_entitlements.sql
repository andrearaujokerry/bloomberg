-- migration: 0011_users_entitlements.sql
CREATE TABLE firms (
  firm_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text NOT NULL,
  lei            char(20),
  contract_ref   text,
  seat_count     int NOT NULL DEFAULT 1,                 -- reconciled against declarations (ENTL-06)
  retention_days int NOT NULL DEFAULT 2557,              -- messages / access-log retention floor: 7 years (MSG-03, REG-01)
  data_residency text NOT NULL DEFAULT 'us',             -- REG-07 recorded; single region in v1
  policy         jsonb NOT NULL DEFAULT '{}',            -- MSG-03: {permittedCounterpartyFirms:[], disclaimer, ethicalWalls:[{deskA,deskB}]}
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (                            -- a natural person (ENTL-03, SEC-01); personal data — lawful basis in §19
  user_id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id               bigint NOT NULL REFERENCES firms(firm_id),
  email                 text NOT NULL,
  display_name          text NOT NULL,
  desk                  text,                            -- 'Equities PM','Rates' (ethical-wall unit, MSG-03)
  role                  text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','compliance','dataops','helpdesk','newsroom')),   -- 'newsroom' = SEC-06 wall
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended','deprovisioned')),
  person_verified_at    timestamptz,                     -- SEC-01 onboarding evidence
  verified_by           bigint,
  mfa_required          boolean NOT NULL DEFAULT false,  -- SEC-02: WebAuthn required when true
  sanctions_screened_at timestamptz,                     -- REG-06 mechanism (manual attestation in v1)
  sanctions_status      text CHECK (sanctions_status IN ('clear','review','blocked')),
  scim_external_id      text,                            -- SEC-01 SSO/SCIM (out of scope; column reserved)
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_login_at         timestamptz,
  deprovisioned_at      timestamptz,
  anonymised_at         timestamptz                      -- REG-04 erasure: email/display_name replaced by 'user-<id>'; access_log kept
);
CREATE UNIQUE INDEX users_email_uniq ON users (lower(email));
CREATE INDEX users_firm_idx ON users (firm_id);

CREATE TABLE user_credentials (                 -- SEC-02 FIDO2/WebAuthn; password kept for dev fallback only
  credential_pk  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES users(user_id),
  kind           text NOT NULL CHECK (kind IN ('password','webauthn')),
  credential_id  bytea,                                  -- WebAuthn credential id (NULL for password)
  public_key     bytea,
  sign_count     bigint NOT NULL DEFAULT 0,
  transports     text[],
  aaguid         uuid,
  secret_hash    text,                                   -- crypt(password, gen_salt('bf', 12)) via pgcrypto (password kind only)
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  CONSTRAINT user_credentials_shape CHECK ((kind = 'webauthn' AND credential_id IS NOT NULL AND public_key IS NOT NULL AND secret_hash IS NULL)
                                        OR (kind = 'password' AND secret_hash IS NOT NULL AND credential_id IS NULL))
);
CREATE UNIQUE INDEX user_credentials_webauthn_uniq ON user_credentials (credential_id) WHERE credential_id IS NOT NULL;
CREATE UNIQUE INDEX user_credentials_password_uniq ON user_credentials (user_id) WHERE kind = 'password' AND revoked_at IS NULL;

CREATE TABLE sessions (                         -- ENTL-03 / SEC-03: one active web session per natural person; a new login supersedes the old (4003)
  session_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          bigint NOT NULL REFERENCES users(user_id),
  token_hash       bytea NOT NULL UNIQUE,                -- digest(token, 'sha256'); the token itself is never stored
  client_kind      text NOT NULL CHECK (client_kind IN ('web','api')),
  api_key_id       bigint,                               -- api sessions: api_keys.api_key_id (FK added below)
  device_id        text,                                 -- client-generated stable id (localStorage)
  ip               inet,
  user_agent       text,
  mfa_verified     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoke_reason    text CHECK (revoke_reason IN ('logout','superseded','expired','admin','deprovisioned')),
  superseded_count int NOT NULL DEFAULT 0                -- how many later logins displaced this one's predecessors (ARCHITECTURE §10.7)
);
CREATE UNIQUE INDEX sessions_one_active_web ON sessions (user_id) WHERE client_kind = 'web' AND revoked_at IS NULL;   -- the SEC-03 invariant
CREATE INDEX sessions_user_idx ON sessions (user_id, created_at DESC);

CREATE TABLE api_keys (                         -- API-01: bearer keys bound to a natural person's entitlements
  api_key_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(user_id),
  key_hash     bytea NOT NULL UNIQUE,
  label        text NOT NULL,
  scopes       text[] NOT NULL DEFAULT '{data:read,fn:run,ws:subscribe}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
ALTER TABLE sessions ADD CONSTRAINT sessions_api_key_fk FOREIGN KEY (api_key_id) REFERENCES api_keys(api_key_id);

CREATE TABLE entitlement_grants (               -- ENTL-02: effective = licence cap ∩ firm grant ∩ user grant (evaluator rules 3–6)
  grant_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_kind  text NOT NULL CHECK (subject_kind IN ('user','firm')),
  subject_id    bigint NOT NULL,
  source_id     text,                                    -- NULL = all sources
  asset_class   asset_class,                             -- NULL = all
  field_class   field_class,                             -- NULL = all
  max_tier      tier NOT NULL,
  usage_display boolean NOT NULL DEFAULT true,
  usage_export  boolean NOT NULL DEFAULT false,
  usage_api     boolean NOT NULL DEFAULT false,
  valid_from    timestamptz NOT NULL DEFAULT now(),
  valid_to      timestamptz NOT NULL DEFAULT 'infinity',
  granted_by    bigint,
  contract_ref  text,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlement_grants_range CHECK (valid_from < valid_to)
);
CREATE INDEX entitlement_grants_subject_idx ON entitlement_grants (subject_kind, subject_id) WHERE valid_to = 'infinity';
CREATE INDEX entitlement_grants_source_idx  ON entitlement_grants (source_id) WHERE source_id IS NOT NULL;

CREATE SEQUENCE access_log_id_seq;
CREATE TABLE access_log (                       -- ENTL-04: every data access decision; batched insert; monthly partitions; append-only (§15)
  log_id        bigint NOT NULL DEFAULT nextval('access_log_id_seq'),
  ts            timestamptz NOT NULL,
  user_id       bigint NOT NULL,
  firm_id       bigint NOT NULL,
  session_id    uuid,
  instrument_id bigint,                                  -- NULL for non-instrument reads (econ series id in details)
  field_id      text NOT NULL,
  field_class   field_class NOT NULL,
  source_id     text NOT NULL,
  requested_tier tier NOT NULL,
  tier          tier,                                    -- granted tier (NULL on deny)
  usage         usage_type NOT NULL,
  purpose       text NOT NULL,                           -- function code | route id | 'ws.sub'
  decision      entl_decision NOT NULL,
  reason        text NOT NULL DEFAULT 'OK',              -- core ReasonCode
  trace_id      uuid,
  details       jsonb,
  PRIMARY KEY (ts, log_id)
) PARTITION BY RANGE (ts);
CREATE TABLE access_log_default PARTITION OF access_log DEFAULT;
CREATE INDEX access_log_user_idx    ON access_log (user_id, ts);
CREATE INDEX access_log_declare_idx ON access_log (source_id, field_class, tier, usage, ts);   -- monthly declarations
CREATE INDEX access_log_trace_idx   ON access_log (trace_id) WHERE trace_id IS NOT NULL;

CREATE TABLE usage_declarations (               -- ENTL-06 / DATA-02: generated monthly from access_log by entitlements/declarations.ts
  declaration_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  month            date NOT NULL,                        -- first day of month
  source_id        text NOT NULL,
  firm_id          bigint NOT NULL REFERENCES firms(firm_id),
  field_class      field_class NOT NULL,
  tier             tier NOT NULL,
  display_users    int NOT NULL,
  export_users     int NOT NULL,
  api_users        int NOT NULL,
  distinct_users   int NOT NULL,
  instrument_count int NOT NULL,
  data_points      bigint NOT NULL,
  seat_count       int NOT NULL,                         -- firms.seat_count at generation (reconciliation input)
  query_sql_hash   char(64) NOT NULL,                    -- sha256 of the SQL text that produced the row
  generated_at     timestamptz NOT NULL DEFAULT now(),
  reconciled_at    timestamptz,
  billing_ref      text,
  UNIQUE (month, source_id, firm_id, field_class, tier)
);

CREATE TABLE quota_limits (                     -- API-06 (defaults: 500 daily unique instruments, 2 000 000 monthly datapoints, 2 000 concurrent API subs)
  subject_kind             text NOT NULL CHECK (subject_kind IN ('user','firm')),
  subject_id               bigint NOT NULL,
  daily_unique_instruments int NOT NULL DEFAULT 500,
  monthly_data_points      bigint NOT NULL DEFAULT 2000000,
  concurrent_subscriptions int NOT NULL DEFAULT 2000,
  PRIMARY KEY (subject_kind, subject_id)
);
CREATE TABLE quota_counters (
  user_id      bigint NOT NULL REFERENCES users(user_id),
  window_kind  text NOT NULL CHECK (window_kind IN ('day','month')),
  window_start date NOT NULL,
  data_points  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, window_kind, window_start)
);
CREATE TABLE quota_instruments_seen (
  user_id       bigint NOT NULL,
  day           date NOT NULL,
  instrument_id bigint NOT NULL,
  PRIMARY KEY (user_id, day, instrument_id)
);
