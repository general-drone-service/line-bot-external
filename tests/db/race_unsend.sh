#!/usr/bin/env bash
# Two real connections: A binds a token inside a slow transaction while B processes the unsend
# for the same message. Without serialization B misses the binding and the touch stays usable.
# Sourced by scripts/test-db.sh (psql_run is defined there).
set -euo pipefail

psql_run -o /dev/null -c "
  SELECT line_tracking_create_touch('meta_facility_202610', gen_random_uuid(), 'hash-race', 30, 120);
  SELECT line_tracking_record_events('Ubot', jsonb_build_array(
    jsonb_build_object('webhook_event_id', 'race-msg', 'event_type', 'message', 'message_type', 'text',
      'source_type', 'user', 'timestamp_ms', 1760600000000, 'line_user_id', 'Urace', 'message_id', 'm-race', 'is_inquiry', true),
    jsonb_build_object('webhook_event_id', 'race-unsend', 'event_type', 'unsend',
      'source_type', 'user', 'timestamp_ms', 1760600001000, 'line_user_id', 'Urace', 'message_id', 'm-race', 'is_inquiry', false)));"

psql_run -o /dev/null -c "BEGIN;
  SELECT line_tracking_process_event('Ubot', 'race-msg', 'hash-race', false);
  SELECT pg_sleep(2);
  COMMIT;" &
a=$!
sleep 0.5
psql_run -o /dev/null -c "SELECT line_tracking_process_event('Ubot', 'race-unsend', NULL, false);"
wait "$a"

result="$(psql_run -At -c "
  SELECT (t.revoked_at IS NOT NULL) || '|' || e.tracking_status || '|' || e.crm_sync_status
  FROM line_tracking_touches t, line_tracking_events e
  WHERE t.token_hash = 'hash-race' AND e.webhook_event_id = 'race-msg';")"
if [ "$result" != "true|retracted|cancelled" ]; then
  echo "FAIL concurrent unsend: expected true|retracted|cancelled, got $result"
  exit 1
fi
echo "NOTICE:  ok concurrent unsend revokes the binding made by the in-flight message"

# Reverse order: the unsend holds the lock in a slow transaction while the original message arrives.
psql_run -o /dev/null -c "
  SELECT line_tracking_create_touch('meta_facility_202610', gen_random_uuid(), 'hash-race2', 30, 120);
  SELECT line_tracking_record_events('Ubot', jsonb_build_array(
    jsonb_build_object('webhook_event_id', 'race2-msg', 'event_type', 'message', 'message_type', 'text',
      'source_type', 'user', 'timestamp_ms', 1760600000000, 'line_user_id', 'Urace2', 'message_id', 'm-race2', 'is_inquiry', true),
    jsonb_build_object('webhook_event_id', 'race2-unsend', 'event_type', 'unsend',
      'source_type', 'user', 'timestamp_ms', 1760600001000, 'line_user_id', 'Urace2', 'message_id', 'm-race2', 'is_inquiry', false)));"
psql_run -o /dev/null -c "BEGIN;
  SELECT line_tracking_process_event('Ubot', 'race2-unsend', NULL, false);
  SELECT pg_sleep(2);
  COMMIT;" &
u=$!
sleep 0.5
psql_run -o /dev/null -c "SELECT line_tracking_process_event('Ubot', 'race2-msg', 'hash-race2', false);"
wait "$u"
result="$(psql_run -At -c "
  SELECT (t.bound_line_user_id IS NULL) || '|' || e.tracking_status || '|' || e.crm_sync_status
  FROM line_tracking_touches t, line_tracking_events e
  WHERE t.token_hash = 'hash-race2' AND e.webhook_event_id = 'race2-msg';")"
if [ "$result" != "true|retracted|not_applicable" ]; then
  echo "FAIL unsend-first race: expected true|retracted|not_applicable, got $result"
  exit 1
fi
echo "NOTICE:  ok message arriving while the unsend holds the lock is retracted and binds nothing"
