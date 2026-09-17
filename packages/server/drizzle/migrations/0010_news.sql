-- migration: 0010_news.sql
CREATE TABLE topics (
  topic_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code            text NOT NULL UNIQUE,         -- 'MARKETS','ECO','POLITICS','TECH','WEALTH','INDUSTRIES','FED','FILINGS','EARNINGS','CA','RATES','FX','AI'
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('feed','sector','theme','region','event','release')),
  parent_topic_id bigint REFERENCES topics(topic_id),
  keywords        text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE news_items (
  news_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id      text NOT NULL,                 -- 'bbg.rss' | 'sec.atom' | 'fed.rss'
  feed           text NOT NULL,                 -- 'markets','economics','politics','technology','wealth','industries','8-K','press_all'
  provider_guid  text NOT NULL,                 -- RSS guid 'TLEUW0KGZAKZ00' | Atom id 'urn:tag:sec.gov,2008:accession-number=…' | Fed URL
  kind           text NOT NULL CHECK (kind IN ('story','video','filing','press_release','fed_release')),
  headline       text NOT NULL,
  summary        text,                          -- description / Atom summary (HTML stripped)
  url            text NOT NULL,
  author         text,                          -- dc:creator
  category       text,                          -- Fed <category>; SEC form type
  cik            char(10),                      -- SEC feed: filer CIK
  items_8k       text[],                        -- ['5.02','9.01']
  lang           char(2) NOT NULL DEFAULT 'en',
  published_at   timestamptz NOT NULL,          -- pubDate / <updated> (FEED-05 src)
  captured_at    timestamptz NOT NULL,          -- our receipt (cap)
  is_correction  boolean NOT NULL DEFAULT false,-- description starts with 'Correct:' / 'Fixes headline'
  machine_generated boolean NOT NULL DEFAULT false,   -- NEWS-08: always false in v1; the column exists so the render rule is enforceable
  tsv            tsvector GENERATED ALWAYS AS (
                   setweight(to_tsvector('english', coalesce(headline, '')), 'A') ||
                   setweight(to_tsvector('english', coalesce(summary, '')),  'B')) STORED,   -- two-arg to_tsvector is IMMUTABLE; STORED generated columns exist in PG 12+
  provenance_id  bigint NOT NULL REFERENCES provenance(provenance_id),
  UNIQUE (source_id, provider_guid)
);
CREATE INDEX news_items_tsv_idx       ON news_items USING gin (tsv);                              -- N full-text search
CREATE INDEX news_items_headline_trgm ON news_items USING gin (headline gin_trgm_ops);           -- fuzzy headline search
CREATE INDEX news_items_published_idx ON news_items (published_at DESC);                          -- TOP
CREATE INDEX news_items_feed_idx      ON news_items (feed, published_at DESC);                    -- n:feed:markets
CREATE INDEX news_items_cik_idx       ON news_items (cik, published_at DESC) WHERE cik IS NOT NULL;
CREATE TRIGGER news_items_source_known BEFORE INSERT ON news_items FOR EACH ROW EXECUTE FUNCTION assert_source_known();

CREATE TABLE news_entity_links (                -- NEWS-02 precision-first entity resolution (exact ticker/CIK/name only; no fuzzy links)
  news_id     bigint NOT NULL REFERENCES news_items(news_id) ON DELETE CASCADE,
  entity_kind entity_kind NOT NULL,             -- instrument | issuer | person | topic
  entity_id   bigint NOT NULL,
  confidence  real NOT NULL CHECK (confidence BETWEEN 0 AND 1),   -- 1.0 CIK/ticker exact; 0.95 name exact; 0.9 alias; links < 0.9 are never written
  method      text NOT NULL CHECK (method IN ('cik','ticker_exact','name_exact','name_alias','feed_topic','keyword','manual')),
  PRIMARY KEY (news_id, entity_kind, entity_id)
);
CREATE INDEX news_entity_links_entity_idx ON news_entity_links (entity_kind, entity_id, news_id DESC);   -- CN, n:inst:<id>, n:topic:<code>
