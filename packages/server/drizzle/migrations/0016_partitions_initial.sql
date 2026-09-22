-- migration: 0016_partitions_initial.sql
CREATE TABLE bars_daily_pre2000 PARTITION OF bars_daily FOR VALUES FROM (MINVALUE) TO ('2000-01-01');
CREATE TABLE bars_daily_y2000 PARTITION OF bars_daily FOR VALUES FROM ('2000-01-01') TO ('2001-01-01');
CREATE TABLE bars_daily_y2001 PARTITION OF bars_daily FOR VALUES FROM ('2001-01-01') TO ('2002-01-01');
CREATE TABLE bars_daily_y2002 PARTITION OF bars_daily FOR VALUES FROM ('2002-01-01') TO ('2003-01-01');
CREATE TABLE bars_daily_y2003 PARTITION OF bars_daily FOR VALUES FROM ('2003-01-01') TO ('2004-01-01');
CREATE TABLE bars_daily_y2004 PARTITION OF bars_daily FOR VALUES FROM ('2004-01-01') TO ('2005-01-01');
CREATE TABLE bars_daily_y2005 PARTITION OF bars_daily FOR VALUES FROM ('2005-01-01') TO ('2006-01-01');
CREATE TABLE bars_daily_y2006 PARTITION OF bars_daily FOR VALUES FROM ('2006-01-01') TO ('2007-01-01');
CREATE TABLE bars_daily_y2007 PARTITION OF bars_daily FOR VALUES FROM ('2007-01-01') TO ('2008-01-01');
CREATE TABLE bars_daily_y2008 PARTITION OF bars_daily FOR VALUES FROM ('2008-01-01') TO ('2009-01-01');
CREATE TABLE bars_daily_y2009 PARTITION OF bars_daily FOR VALUES FROM ('2009-01-01') TO ('2010-01-01');
CREATE TABLE bars_daily_y2010 PARTITION OF bars_daily FOR VALUES FROM ('2010-01-01') TO ('2011-01-01');
CREATE TABLE bars_daily_y2011 PARTITION OF bars_daily FOR VALUES FROM ('2011-01-01') TO ('2012-01-01');
CREATE TABLE bars_daily_y2012 PARTITION OF bars_daily FOR VALUES FROM ('2012-01-01') TO ('2013-01-01');
CREATE TABLE bars_daily_y2013 PARTITION OF bars_daily FOR VALUES FROM ('2013-01-01') TO ('2014-01-01');
CREATE TABLE bars_daily_y2014 PARTITION OF bars_daily FOR VALUES FROM ('2014-01-01') TO ('2015-01-01');
CREATE TABLE bars_daily_y2015 PARTITION OF bars_daily FOR VALUES FROM ('2015-01-01') TO ('2016-01-01');
CREATE TABLE bars_daily_y2016 PARTITION OF bars_daily FOR VALUES FROM ('2016-01-01') TO ('2017-01-01');
CREATE TABLE bars_daily_y2017 PARTITION OF bars_daily FOR VALUES FROM ('2017-01-01') TO ('2018-01-01');
CREATE TABLE bars_daily_y2018 PARTITION OF bars_daily FOR VALUES FROM ('2018-01-01') TO ('2019-01-01');
CREATE TABLE bars_daily_y2019 PARTITION OF bars_daily FOR VALUES FROM ('2019-01-01') TO ('2020-01-01');
CREATE TABLE bars_daily_y2020 PARTITION OF bars_daily FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');
CREATE TABLE bars_daily_y2021 PARTITION OF bars_daily FOR VALUES FROM ('2021-01-01') TO ('2022-01-01');
CREATE TABLE bars_daily_y2022 PARTITION OF bars_daily FOR VALUES FROM ('2022-01-01') TO ('2023-01-01');
CREATE TABLE bars_daily_y2023 PARTITION OF bars_daily FOR VALUES FROM ('2023-01-01') TO ('2024-01-01');
CREATE TABLE bars_daily_y2024 PARTITION OF bars_daily FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE bars_daily_y2025 PARTITION OF bars_daily FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE bars_daily_y2026 PARTITION OF bars_daily FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE bars_daily_y2027 PARTITION OF bars_daily FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');
CREATE TABLE bars_intraday_m2026_08 PARTITION OF bars_intraday FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');
CREATE TABLE bars_intraday_m2026_09 PARTITION OF bars_intraday FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
CREATE TABLE bars_intraday_m2026_10 PARTITION OF bars_intraday FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE bars_intraday_m2026_11 PARTITION OF bars_intraday FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE quote_ticks_d2026_09_14 PARTITION OF quote_ticks FOR VALUES FROM ('2026-09-14 00:00:00+00') TO ('2026-09-15 00:00:00+00');
CREATE TABLE quote_ticks_d2026_09_15 PARTITION OF quote_ticks FOR VALUES FROM ('2026-09-15 00:00:00+00') TO ('2026-09-16 00:00:00+00');
CREATE TABLE quote_ticks_d2026_09_16 PARTITION OF quote_ticks FOR VALUES FROM ('2026-09-16 00:00:00+00') TO ('2026-09-17 00:00:00+00');
CREATE TABLE quote_ticks_d2026_09_17 PARTITION OF quote_ticks FOR VALUES FROM ('2026-09-17 00:00:00+00') TO ('2026-09-18 00:00:00+00');
CREATE TABLE quote_ticks_d2026_09_18 PARTITION OF quote_ticks FOR VALUES FROM ('2026-09-18 00:00:00+00') TO ('2026-09-19 00:00:00+00');
CREATE TABLE quote_ticks_d2026_09_19 PARTITION OF quote_ticks FOR VALUES FROM ('2026-09-19 00:00:00+00') TO ('2026-09-20 00:00:00+00');
CREATE TABLE quote_ticks_d2026_09_20 PARTITION OF quote_ticks FOR VALUES FROM ('2026-09-20 00:00:00+00') TO ('2026-09-21 00:00:00+00');
CREATE TABLE quote_ticks_d2026_09_21 PARTITION OF quote_ticks FOR VALUES FROM ('2026-09-21 00:00:00+00') TO ('2026-09-22 00:00:00+00');
CREATE TABLE option_quotes_d2026_09_15 PARTITION OF option_quotes FOR VALUES FROM ('2026-09-15 00:00:00+00') TO ('2026-09-16 00:00:00+00');
CREATE TABLE option_quotes_d2026_09_16 PARTITION OF option_quotes FOR VALUES FROM ('2026-09-16 00:00:00+00') TO ('2026-09-17 00:00:00+00');
CREATE TABLE option_quotes_d2026_09_17 PARTITION OF option_quotes FOR VALUES FROM ('2026-09-17 00:00:00+00') TO ('2026-09-18 00:00:00+00');
CREATE TABLE option_quotes_d2026_09_18 PARTITION OF option_quotes FOR VALUES FROM ('2026-09-18 00:00:00+00') TO ('2026-09-19 00:00:00+00');
CREATE TABLE option_quotes_d2026_09_19 PARTITION OF option_quotes FOR VALUES FROM ('2026-09-19 00:00:00+00') TO ('2026-09-20 00:00:00+00');
CREATE TABLE option_quotes_d2026_09_20 PARTITION OF option_quotes FOR VALUES FROM ('2026-09-20 00:00:00+00') TO ('2026-09-21 00:00:00+00');
CREATE TABLE option_quotes_d2026_09_21 PARTITION OF option_quotes FOR VALUES FROM ('2026-09-21 00:00:00+00') TO ('2026-09-22 00:00:00+00');
CREATE TABLE access_log_m2026_09 PARTITION OF access_log FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
CREATE TABLE access_log_m2026_10 PARTITION OF access_log FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE access_log_m2026_11 PARTITION OF access_log FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');
CREATE TABLE usage_events_m2026_09 PARTITION OF usage_events FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
CREATE TABLE usage_events_m2026_10 PARTITION OF usage_events FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
CREATE TABLE usage_events_m2026_11 PARTITION OF usage_events FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');

-- Ownership. `CREATE TABLE … PARTITION OF` gives the new child to its CREATOR, not to the parent's
-- owner, so every partition above belongs to the role that ran this migration (a superuser, locally)
-- rather than to `terminal_maint`. 0015's re-owning loop ran BEFORE this file and matched nothing.
-- Without this block `dropExpired()` fails as `terminal_maint` with 42501 'must be owner of table
-- <partition>' on all 54 of them, and STOR-07's licence-mandated deletion silently never happens.
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT c.relname FROM pg_class c
           JOIN pg_inherits i ON i.inhrelid = c.oid
           JOIN pg_class parent ON parent.oid = i.inhparent
           WHERE parent.relname IN ('bars_daily','bars_intraday','quote_ticks','option_quotes','access_log','usage_events')
             AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = 'terminal_maint')
  LOOP EXECUTE format('ALTER TABLE public.%I OWNER TO terminal_maint', p.relname); END LOOP;
END $$;
-- The default partitions created with the parents in 0007/0011/0014 are children too, so the loop
-- above covers them as well: `dropExpired` never drops a default, but `ensurePartitions` moves rows
-- out of one, which needs DELETE and is granted separately in 0015.
