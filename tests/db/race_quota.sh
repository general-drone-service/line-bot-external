#!/usr/bin/env bash
# Two connections race for the last touch slot of a source with different idempotency keys:
# exactly one may succeed. Sourced by scripts/test-db.sh (psql_run is defined there).
set -euo pipefail

psql_run -o /dev/null -c "
  INSERT INTO line_tracking_sources (source_key, crm_source_code, entry_type, label, enabled)
  VALUES ('meta_race_cap', 'meta', 'line_ad', 'race cap', true);
  SELECT line_tracking_create_touch('meta_race_cap', gen_random_uuid(), 'hash-rq-0', 30, 2);"

psql_run -o /dev/null -c "BEGIN;
  SELECT line_tracking_create_touch('meta_race_cap', '00000000-0000-4000-8000-0000000000d1', 'hash-rq-1', 30, 2);
  SELECT pg_sleep(2);
  COMMIT;" &
a=$!
sleep 0.5
b_out="$(psql_run -o /dev/null -c "SELECT line_tracking_create_touch('meta_race_cap', '00000000-0000-4000-8000-0000000000d2', 'hash-rq-2', 30, 2);" 2>&1 || true)"
wait "$a"

count="$(psql_run -At -c "SELECT count(*) FROM line_tracking_touches t JOIN line_tracking_sources s ON s.id = t.source_id WHERE s.source_key = 'meta_race_cap';")"
if [ "$count" != "2" ] || [[ "$b_out" != *rate_limited* ]]; then
  echo "FAIL quota race: expected 2 touches and rate_limited for the second connection, got $count / $b_out"
  exit 1
fi
echo "NOTICE:  ok concurrent requests cannot exceed the per-source touch cap"
