-- migration: 0013_messaging.sql
CREATE TABLE rooms (
  room_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('dm','group','firm','helpdesk')),
  name           text,
  firm_id        bigint REFERENCES firms(firm_id),   -- NULL for cross-firm dm/group rooms (policy checked per member firm)
  scope          text NOT NULL DEFAULT 'internal' CHECK (scope IN ('internal','external')),
  created_by     bigint NOT NULL REFERENCES users(user_id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  retention_days int NOT NULL DEFAULT 2557,          -- MSG-03 / REG-01: ≥ firm retention; purge never below 7 years
  disclaimer     text,                               -- MSG-03 shown on join
  wall_tag       text,                               -- MSG-03 / SEC-06 ethical wall: members' desks must all carry this tag (enforced by messaging/service.ts)
  policy         jsonb NOT NULL DEFAULT '{}'         -- {permittedFirms:[], allowExternal:false}
);

CREATE TABLE room_members (
  room_id   bigint NOT NULL REFERENCES rooms(room_id),
  user_id   bigint NOT NULL REFERENCES users(user_id),
  role      text NOT NULL DEFAULT 'member' CHECK (role IN ('member','owner','supervisor')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at   timestamptz,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX room_members_user_idx ON room_members (user_id) WHERE left_at IS NULL;

CREATE TABLE messages (                         -- MSG-02 / REG-01 WORM: append-only, hash-chained per room (trigger + REVOKE in §15)
  message_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id        bigint NOT NULL REFERENCES rooms(room_id),
  seq            bigint NOT NULL,                    -- per-room sequence, assigned by the chain trigger
  sender_user_id bigint NOT NULL REFERENCES users(user_id),
  sender_firm_id bigint NOT NULL,
  sent_at        timestamptz NOT NULL DEFAULT now(),
  body           text NOT NULL,
  attachments    jsonb NOT NULL DEFAULT '[]',        -- MSG-04: [{kind:'security'|'chart'|'function'|'portfolio'|'watchlist', ref:{…}, params}] rendered live within the recipient's entitlements
  structured     jsonb,                              -- MSG-06 shape only: {type:'ioi'|'rfq', side, instrumentId, qty, price} — display only, no execution
  client_msg_id  uuid NOT NULL,                      -- idempotent send
  prev_hash      bytea,
  hash           bytea NOT NULL,                     -- sha256(prev_hash || room_id || seq || sender || sent_at || body || attachments)
  trace_id       uuid,
  UNIQUE (room_id, seq),
  UNIQUE (room_id, client_msg_id)
);
CREATE INDEX messages_room_time_idx ON messages (room_id, sent_at DESC);
CREATE INDEX messages_fts_idx       ON messages USING gin (to_tsvector('english', body));   -- supervisory search / production on request

CREATE TABLE message_reads (
  room_id       bigint NOT NULL,
  user_id       bigint NOT NULL,
  last_read_seq bigint NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE legal_holds (                      -- MSG-02: while open, nothing in scope may be purged (partitions.ts and retentionPurge check this)
  hold_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id     bigint NOT NULL REFERENCES firms(firm_id),
  scope       jsonb NOT NULL,                        -- {userIds:[], roomIds:[], from, to}
  reason      text NOT NULL,
  created_by  bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by bigint
);
CREATE INDEX legal_holds_open_idx ON legal_holds (firm_id) WHERE released_at IS NULL;

CREATE TABLE surveillance_lexicon (             -- MSG-02 lexicon-based surveillance
  term_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id  bigint REFERENCES firms(firm_id),         -- NULL = global list
  pattern  text NOT NULL,                            -- case-insensitive regex
  severity smallint NOT NULL DEFAULT 2 CHECK (severity BETWEEN 1 AND 3),
  active   boolean NOT NULL DEFAULT true,
  note     text
);

CREATE TABLE surveillance_hits (
  hit_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id    bigint NOT NULL REFERENCES messages(message_id),
  term_id       bigint NOT NULL REFERENCES surveillance_lexicon(term_id),
  matched_text  text NOT NULL,
  detected_at   timestamptz NOT NULL DEFAULT now(),
  review_status text NOT NULL DEFAULT 'open' CHECK (review_status IN ('open','escalated','cleared')),
  reviewed_by   bigint,
  reviewed_at   timestamptz,
  reviewer_note text,
  UNIQUE (message_id, term_id)
);
CREATE INDEX surveillance_hits_open_idx ON surveillance_hits (detected_at DESC) WHERE review_status = 'open';

CREATE TABLE message_reviews (                  -- supervisory review queue (random sample + manual flags)
  review_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id       bigint NOT NULL REFERENCES messages(message_id),
  flagged_by       text NOT NULL CHECK (flagged_by IN ('lexicon','random_sample','manual')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','escalated')),
  reviewer_user_id bigint,
  reviewed_at      timestamptz,
  note             text
);
