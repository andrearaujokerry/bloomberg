-- migration: 0014_ops.sql
CREATE SEQUENCE usage_events_id_seq;
CREATE TABLE usage_events (                     -- FUNC-04: every launch, param change, page, export, help, search selection …
  event_id      bigint NOT NULL DEFAULT nextval('usage_events_id_seq'),
  ts            timestamptz NOT NULL,
  user_id       bigint NOT NULL,
  firm_id       bigint NOT NULL,
  session_id    uuid,
  panel_id      text,
  kind          text NOT NULL CHECK (kind IN ('fn.launch','fn.param','fn.page','fn.export','fn.help','search.select','cmd.parse_error',
                                              'panel.switch','ws.subscribe','ws.slow','ws.resync','ticket.open')),
  code          text,                           -- function code
  params_hash   text,                           -- sha256 of canonical params JSON
  instrument_id bigint,
  duration_ms   int,
  trace_id      uuid,
  details       jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (ts, event_id)
) PARTITION BY RANGE (ts);
CREATE TABLE usage_events_default PARTITION OF usage_events DEFAULT;
CREATE INDEX usage_events_code_idx  ON usage_events (kind, code, ts);      -- the roadmap query (ARCHITECTURE §11)
CREATE INDEX usage_events_user_idx  ON usage_events (user_id, ts);
CREATE INDEX usage_events_trace_idx ON usage_events (trace_id) WHERE trace_id IS NOT NULL;

CREATE TABLE help_tickets (                     -- TERM-09: second HELP press opens a ticket record (no live analyst in v1)
  ticket_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users(user_id),
  firm_id       bigint NOT NULL,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  panel_id      text,
  function_code text,
  instrument_id bigint,
  params        jsonb,
  screen_state  jsonb NOT NULL DEFAULT '{}',    -- visible fields + their provenance indexes
  trace_id      uuid,
  question      text NOT NULL,
  room_id       bigint REFERENCES rooms(room_id),   -- helpdesk room created for the ticket
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  answer        text,
  answered_by   bigint,
  answered_at   timestamptz
);
CREATE INDEX help_tickets_open_idx ON help_tickets (opened_at DESC) WHERE status = 'open';

CREATE TABLE ingest_runs (                      -- one row per scheduler job run (ARCHITECTURE §7.1)
  run_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id      text NOT NULL,                    -- 'cboe.quotes.poll', 'yahooDaily', 'partitionMaintenance' …
  source_id   text,                             -- NULL for internal jobs
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  status      text NOT NULL CHECK (status IN ('running','ok','failed','skipped')),
  fetched     int NOT NULL DEFAULT 0,
  inserted    int NOT NULL DEFAULT 0,
  updated     int NOT NULL DEFAULT 0,
  skipped     int NOT NULL DEFAULT 0,
  errors      jsonb NOT NULL DEFAULT '[]',      -- JobError[] {code, message, url?, requestKey?}
  trace_id    uuid
);
CREATE INDEX ingest_runs_job_idx ON ingest_runs (job_id, started_at DESC);
ALTER TABLE provenance ADD CONSTRAINT provenance_run_fk FOREIGN KEY (run_id) REFERENCES ingest_runs(run_id);

CREATE TABLE dq_events (                        -- OPS-03 / QA-03 / BUS-04 (every widen/shed/close is a row)
  dq_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts            timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL CHECK (kind IN ('stale_tick','cross_source_divergence','missing_close','field_population','poll_anomaly',
                                              'provider_circuit_open','reconcile_mismatch','parse_error','default_partition_nonempty',
                                              'ref_orphans','ws_backpressure','plant_degraded','replay_diff')),
  severity      text NOT NULL CHECK (severity IN ('info','warn','error')),
  instrument_id bigint,
  md_line_id    bigint,
  source_id     text,
  subject       text,                           -- plant subject or table name
  details       jsonb NOT NULL DEFAULT '{}',    -- {expected, actual, diffPct, sessionId …}
  resolved_at   timestamptz
);
CREATE INDEX dq_events_open_idx ON dq_events (kind, ts DESC) WHERE resolved_at IS NULL;
CREATE INDEX dq_events_ts_idx   ON dq_events (ts DESC);

CREATE TABLE data_exceptions (                  -- REF-10 exception queue: source conflicts, parse failures, manual review, reported errors, with SLA
  exception_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at       timestamptz NOT NULL DEFAULT now(),
  kind             text NOT NULL CHECK (kind IN ('source_conflict','missing_field','parse_error','manual_review','reported_error','unresolved_identifier','ca_review')),
  entity_kind      entity_kind,
  entity_id        bigint,
  field            text,
  candidates       jsonb NOT NULL DEFAULT '[]', -- [{sourceId, provenanceId, value}]
  reported_by      bigint,                      -- users.user_id for reported errors
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','rejected')),
  assignee_user_id bigint,
  resolved_by      bigint,
  resolution       jsonb,                       -- {chosenProvenanceId, versionId, note}
  resolved_at      timestamptz,
  sla_due_at       timestamptz
);
CREATE INDEX data_exceptions_open_idx ON data_exceptions (sla_due_at) WHERE status = 'open';

CREATE TABLE status_incidents (                 -- OPS-04 status page
  incident_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  component   text NOT NULL,                    -- 'provider:cboe.quotes','plant','ws','db'
  severity    text NOT NULL CHECK (severity IN ('info','degraded','outage')),
  title       text NOT NULL,
  updates     jsonb NOT NULL DEFAULT '[]'       -- [{ts, text}]
);

CREATE TABLE schema_meta (                      -- 'field_dictionary_version','concept_map_version','seed_fixture_sha'
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE config_versions (                  -- in-memory caches (licenceRegistry.ts, evaluator) reload when a version changes
  name       text PRIMARY KEY,                  -- 'entitlements', 'calendars', 'universe'
  version    bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO config_versions (name) VALUES ('entitlements'), ('calendars'), ('universe');

CREATE FUNCTION bump_config_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO config_versions (name, version, updated_at) VALUES (TG_ARGV[0], 1, now())
  ON CONFLICT (name) DO UPDATE SET version = config_versions.version + 1, updated_at = now();
  RETURN NULL;
END $$;
CREATE TRIGGER licence_registry_bump   AFTER INSERT OR UPDATE ON licence_registry   FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version('entitlements');
CREATE TRIGGER field_licence_bump      AFTER INSERT OR UPDATE OR DELETE ON field_licence FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version('entitlements');
CREATE TRIGGER entitlement_grants_bump AFTER INSERT OR UPDATE OR DELETE ON entitlement_grants FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version('entitlements');
CREATE TRIGGER calendar_holidays_bump  AFTER INSERT OR UPDATE OR DELETE ON calendar_holidays FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version('calendars');
