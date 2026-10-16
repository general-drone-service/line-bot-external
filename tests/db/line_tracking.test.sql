-- Assertions for 003_line_tracking.sql; each failure raises and stops psql (ON_ERROR_STOP).
CREATE FUNCTION pg_temp.eq(actual TEXT, expected TEXT, label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL %: expected %, got %', label, expected, actual;
  END IF;
  RAISE NOTICE 'ok %', label;
END $$;

CREATE FUNCTION pg_temp.ev(p_id TEXT, p_type TEXT, p_user TEXT, p_msg TEXT, p_inquiry BOOLEAN, p_ms BIGINT DEFAULT 1760600000000)
RETURNS JSONB LANGUAGE sql AS $$
  SELECT jsonb_build_object('webhook_event_id', p_id, 'event_type', p_type, 'message_type', 'text',
    'source_type', 'user', 'timestamp_ms', p_ms, 'line_user_id', p_user, 'message_id', p_msg, 'is_inquiry', p_inquiry)
$$;

CREATE FUNCTION pg_temp.col(p_id TEXT, p_col TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v TEXT;
BEGIN
  EXECUTE format('SELECT %I::TEXT FROM line_tracking_events WHERE account_id = %L AND webhook_event_id = %L', p_col, 'Ubot', p_id) INTO v;
  RETURN v;
END $$;

INSERT INTO line_tracking_sources (source_key, crm_source_code, entry_type, label, enabled)
VALUES ('meta_facility_202610', 'meta', 'line_ad', 'test source', true),
       ('meta_disabled', 'meta', 'line_ad', 'disabled source', false);
INSERT INTO line_tracking_sources (source_key, crm_source_code, entry_type, label, enabled, is_test)
VALUES ('internal_test', 'meta', 'line_ad', 'internal test', true, true);

-- A05: redelivered event is stored once
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e1', 'message', 'U1', 'm1', true)));
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e1', 'message', 'U1', 'm1', true)));
SELECT pg_temp.eq((SELECT count(*)::TEXT FROM line_tracking_events WHERE webhook_event_id = 'e1'), '1', 'redelivery stored once');
SELECT pg_temp.eq(pg_temp.col('e1', 'event_at'), to_timestamp(1760600000)::TEXT, 'event_at from LINE timestamp');

-- A04: no token → unknown source, still recorded, first unknown inquiry goes to CRM
SELECT pg_temp.eq(line_tracking_process_event('Ubot', 'e1', NULL, false), 'no_token', 'no token');
SELECT pg_temp.eq(pg_temp.col('e1', 'crm_sync_status'), 'pending', 'first unknown inquiry queued for CRM');
SELECT pg_temp.eq(line_tracking_process_event('Ubot', 'e1', NULL, false), 'no_token', 'processing is idempotent');
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e2', 'message', 'U1', 'm2', true)));
SELECT line_tracking_process_event('Ubot', 'e2', NULL, false);
SELECT pg_temp.eq(pg_temp.col('e2', 'crm_sync_status'), 'not_applicable', 'second unknown inquiry of same person not re-queued');

-- A02: touch creation is idempotent per key; disabled/unknown sources create nothing
SELECT pg_temp.eq(
  (SELECT (SELECT touch_id FROM line_tracking_create_touch('meta_facility_202610', '00000000-0000-4000-8000-000000000001', 'hash-a', 30, 120))
        = (SELECT touch_id FROM line_tracking_create_touch('meta_facility_202610', '00000000-0000-4000-8000-000000000001', 'hash-a', 30, 120)))::TEXT,
  'true', 'same idempotency key returns same touch');
SELECT pg_temp.eq((SELECT count(*)::TEXT FROM line_tracking_touches), '1', 'retry does not add a touch');
SELECT pg_temp.eq((SELECT count(*)::TEXT FROM line_tracking_create_touch('meta_disabled', gen_random_uuid(), 'hash-x', 30, 120)), '0', 'disabled source rejected');
SELECT pg_temp.eq((SELECT count(*)::TEXT FROM line_tracking_create_touch('nope', gen_random_uuid(), 'hash-y', 30, 120)), '0', 'unknown source rejected');
DO $$ BEGIN
  PERFORM line_tracking_create_touch('meta_facility_202610', '00000000-0000-4000-8000-000000000001', 'hash-other', 30, 120);
  RAISE EXCEPTION 'FAIL reused idempotency key with different token accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'idempotency_conflict' THEN RAISE; END IF;
  RAISE NOTICE 'ok idempotency conflict raised';
END $$;

-- A03: matched token binds the person and queues a CRM inquiry for that source
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e3', 'message', 'U1', 'm3', true)));
SELECT pg_temp.eq(line_tracking_process_event('Ubot', 'e3', 'hash-a', false), 'matched', 'token matched');
SELECT pg_temp.eq(pg_temp.col('e3', 'source_key'), 'meta_facility_202610', 'source snapshot');
SELECT pg_temp.eq(pg_temp.col('e3', 'crm_source_code'), 'meta', 'crm source snapshot');
SELECT pg_temp.eq(pg_temp.col('e3', 'crm_sync_status'), 'pending', 'first inquiry for this source queued');
SELECT pg_temp.eq((SELECT bound_line_user_id FROM line_tracking_touches WHERE token_hash = 'hash-a'), 'U1', 'touch bound');

-- Same person re-sending the same token is idempotent
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e4', 'message', 'U1', 'm4', true)));
SELECT pg_temp.eq(line_tracking_process_event('Ubot', 'e4', 'hash-a', false), 'matched', 'same person re-send matched');
SELECT pg_temp.eq(pg_temp.col('e4', 'crm_sync_status'), 'not_applicable', 'same person+source not re-queued');

-- A08: another person using a bound token is a conflict; binding unchanged
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e5', 'message', 'U2', 'm5', true)));
SELECT pg_temp.eq(line_tracking_process_event('Ubot', 'e5', 'hash-a', false), 'conflict', 'conflict detected');
SELECT pg_temp.eq(pg_temp.col('e5', 'source_key'), NULL, 'conflict has no source');
SELECT pg_temp.eq((SELECT bound_line_user_id FROM line_tracking_touches WHERE token_hash = 'hash-a'), 'U1', 'binding not overwritten');

-- Unknown and expired tokens
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e6', 'message', 'U3', 'm6', true)));
SELECT pg_temp.eq(line_tracking_process_event('Ubot', 'e6', 'hash-missing', false), 'unknown_token', 'unknown token');
INSERT INTO line_tracking_touches (source_id, idempotency_key, token_hash, expires_at)
  SELECT id, gen_random_uuid(), 'hash-old', to_timestamp(1760000000) FROM line_tracking_sources WHERE source_key = 'meta_facility_202610';
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e7', 'message', 'U3', 'm7', true)));
SELECT pg_temp.eq(line_tracking_process_event('Ubot', 'e7', 'hash-old', false), 'expired', 'expired token');

-- A07: group message / sticker are recorded but not inquiries
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e8', 'message', 'U4', 'm8', false)));
SELECT pg_temp.eq(line_tracking_process_event('Ubot', 'e8', 'hash-a', false), 'not_inquiry', 'non-inquiry ignored');
SELECT pg_temp.eq(pg_temp.col('e8', 'crm_sync_status'), 'not_applicable', 'non-inquiry not queued');

-- S02: test touches and test users are flagged
SELECT line_tracking_create_touch('internal_test', gen_random_uuid(), 'hash-test', 30, 120);
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e9', 'message', 'U5', 'm9', true)));
SELECT line_tracking_process_event('Ubot', 'e9', 'hash-test', false);
SELECT pg_temp.eq(pg_temp.col('e9', 'is_test'), 'true', 'test source flags event');
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e10', 'message', 'U6', 'm10', true)));
SELECT line_tracking_process_event('Ubot', 'e10', NULL, true);
SELECT pg_temp.eq(pg_temp.col('e10', 'is_test'), 'true', 'test user flags event');

-- A12: unsend retracts the source binding and cancels an unsent CRM push
SELECT line_tracking_create_touch('meta_facility_202610', gen_random_uuid(), 'hash-b', 30, 120);
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e11', 'message', 'U7', 'm11', true)));
SELECT line_tracking_process_event('Ubot', 'e11', 'hash-b', false);
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e12', 'unsend', 'U7', 'm11', false)));
SELECT pg_temp.eq(line_tracking_process_event('Ubot', 'e12', NULL, false), 'unsend_applied', 'unsend applied');
SELECT pg_temp.eq(pg_temp.col('e11', 'tracking_status'), 'retracted', 'original message retracted');
SELECT pg_temp.eq(pg_temp.col('e11', 'crm_sync_status'), 'cancelled', 'pending CRM push cancelled');
SELECT pg_temp.eq((SELECT (revoked_at IS NOT NULL)::TEXT FROM line_tracking_touches WHERE token_hash = 'hash-b'), 'true', 'touch revoked');
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e13', 'message', 'U7', 'm13', true)));
SELECT pg_temp.eq(line_tracking_process_event('Ubot', 'e13', 'hash-b', false), 'revoked_token', 'revoked token no longer attributes');

-- Unsend arriving before the original message (A05 out of order)
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e14', 'unsend', 'U8', 'm14', false)));
SELECT line_tracking_process_event('Ubot', 'e14', NULL, false);
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e15', 'message', 'U8', 'm14', true)));
SELECT pg_temp.eq(line_tracking_process_event('Ubot', 'e15', NULL, false), 'retracted', 'late original after unsend retracted');
SELECT pg_temp.eq(pg_temp.col('e15', 'crm_sync_status'), 'not_applicable', 'late retracted message not queued');

-- Reply claim: atomic, single winner, resumable from pending, terminal otherwise
SELECT pg_temp.eq(line_tracking_claim_reply('Ubot', 'e1')::TEXT, '1', 'first claim wins (attempt 1)');
SELECT pg_temp.eq(line_tracking_claim_reply('Ubot', 'e1')::TEXT, '0', 'second claim loses');
SELECT line_tracking_finish_reply('Ubot', 'e1', 'pending');
SELECT pg_temp.eq(line_tracking_claim_reply('Ubot', 'e1')::TEXT, '2', 'released event can be reclaimed (attempt 2)');
SELECT line_tracking_finish_reply('Ubot', 'e1', 'sent');
SELECT pg_temp.eq(line_tracking_claim_reply('Ubot', 'e1')::TEXT, '0', 'sent is terminal');
SELECT line_tracking_finish_reply('Ubot', 'e2', 'sent');
SELECT pg_temp.eq(pg_temp.col('e2', 'reply_status'), 'pending', 'finish without claim is ignored');
-- Recorded but never claimed (crash before claim) is still claimable on redelivery
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e2', 'message', 'U1', 'm2', true)));
SELECT pg_temp.eq(line_tracking_claim_reply('Ubot', 'e2')::TEXT, '1', 'pending event recovered on redelivery');
DO $$ BEGIN
  PERFORM line_tracking_finish_reply('Ubot', 'e2', 'sending');
  RAISE EXCEPTION 'FAIL invalid finish status accepted';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT LIKE 'invalid reply status%' THEN RAISE; END IF;
  RAISE NOTICE 'ok invalid finish status rejected';
END $$;

-- CRM outbox: lease, backoff, terminal failure, success
-- e1, e3 (matched), e5 (conflict→unknown), e6, e9, e10, e13 (revoked→unknown); e11 was cancelled by unsend
SELECT pg_temp.eq((SELECT count(*)::TEXT FROM line_tracking_lease_crm(50, 300)), '7', 'due pending rows leased');
SELECT pg_temp.eq((SELECT count(*)::TEXT FROM line_tracking_lease_crm(50, 300)), '0', 'leased rows not re-leased');
UPDATE line_tracking_events SET crm_next_attempt_at = now() - INTERVAL '1 second' WHERE webhook_event_id = 'e3';
SELECT pg_temp.eq(
  (SELECT source_key || '|' || entry_type || '|' || attribution_status || '|' || (first_touch_at IS NOT NULL)::TEXT
   FROM line_tracking_lease_crm(50, 300)),
  'meta_facility_202610|line_ad|matched|true', 'lease payload for matched inquiry');
SELECT pg_temp.eq(line_tracking_claim_crm_send((SELECT id FROM line_tracking_events WHERE webhook_event_id = 'e3'), (SELECT crm_lease_token FROM line_tracking_events WHERE webhook_event_id = 'e3'))::TEXT, 'true', 'send claim under current lease');
SELECT line_tracking_finish_crm((SELECT id FROM line_tracking_events WHERE webhook_event_id = 'e3'), (SELECT crm_lease_token FROM line_tracking_events WHERE webhook_event_id = 'e3'), false, true, 'HTTP 503', 10);
SELECT pg_temp.eq(pg_temp.col('e3', 'crm_sync_status'), 'pending', 'retryable failure stays pending');
SELECT pg_temp.eq(pg_temp.col('e3', 'crm_sync_attempts'), '1', 'attempt counted');
SELECT pg_temp.eq(
  (SELECT (crm_next_attempt_at > now())::TEXT FROM line_tracking_events WHERE webhook_event_id = 'e3'), 'true', 'backoff scheduled');
-- Lease ownership: a stale token cannot finish or send a re-leased row
UPDATE line_tracking_events SET crm_next_attempt_at = now() - INTERVAL '1 second' WHERE webhook_event_id = 'e3';
CREATE TEMP TABLE old_lease AS SELECT crm_lease_token AS t FROM line_tracking_events WHERE webhook_event_id = 'e3';
SELECT count(*) FROM line_tracking_lease_crm(50, 300);
SELECT pg_temp.eq((SELECT line_tracking_claim_crm_send(id, (SELECT t FROM old_lease))::TEXT FROM line_tracking_events WHERE webhook_event_id = 'e3'), 'false', 'stale lease token cannot claim a send');
SELECT pg_temp.eq((SELECT line_tracking_claim_crm_send(id, crm_lease_token)::TEXT FROM line_tracking_events WHERE webhook_event_id = 'e3'), 'true', 'current lease token claims the send');
SELECT line_tracking_finish_crm((SELECT id FROM line_tracking_events WHERE webhook_event_id = 'e3'), (SELECT t FROM old_lease), false, false, 'late old worker', 10);
SELECT pg_temp.eq(pg_temp.col('e3', 'crm_sync_status'), 'sending', 'stale worker cannot finish the row');
SELECT line_tracking_finish_crm((SELECT id FROM line_tracking_events WHERE webhook_event_id = 'e3'), (SELECT crm_lease_token FROM line_tracking_events WHERE webhook_event_id = 'e3'), true, false, NULL, 10);
SELECT pg_temp.eq(pg_temp.col('e3', 'crm_sync_status'), 'sent', 'success marks sent');
SELECT line_tracking_claim_crm_send((SELECT id FROM line_tracking_events WHERE webhook_event_id = 'e1'), (SELECT crm_lease_token FROM line_tracking_events WHERE webhook_event_id = 'e1'));
SELECT line_tracking_finish_crm((SELECT id FROM line_tracking_events WHERE webhook_event_id = 'e1'), (SELECT crm_lease_token FROM line_tracking_events WHERE webhook_event_id = 'e1'), false, false, 'HTTP 400', 10);
SELECT pg_temp.eq(pg_temp.col('e1', 'crm_sync_status'), 'failed', 'non-retryable failure is terminal');
UPDATE line_tracking_events SET crm_sync_attempts = 9 WHERE webhook_event_id = 'e6';
SELECT line_tracking_claim_crm_send((SELECT id FROM line_tracking_events WHERE webhook_event_id = 'e6'), (SELECT crm_lease_token FROM line_tracking_events WHERE webhook_event_id = 'e6'));
SELECT line_tracking_finish_crm((SELECT id FROM line_tracking_events WHERE webhook_event_id = 'e6'), (SELECT crm_lease_token FROM line_tracking_events WHERE webhook_event_id = 'e6'), false, true, 'timeout', 10);
SELECT pg_temp.eq(pg_temp.col('e6', 'crm_sync_status'), 'failed', 'max attempts is terminal');

-- A row cancelled by unsend after leasing is no longer valid to send
SELECT line_tracking_create_touch('meta_facility_202610', gen_random_uuid(), 'hash-c', 30, 120);
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e20', 'message', 'U20', 'm20', true)));
SELECT line_tracking_process_event('Ubot', 'e20', 'hash-c', false);
SELECT count(*) FROM line_tracking_lease_crm(50, 300);
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e21', 'unsend', 'U20', 'm20', false)));
SELECT line_tracking_process_event('Ubot', 'e21', NULL, false);
SELECT pg_temp.eq((SELECT line_tracking_claim_crm_send(id, crm_lease_token)::TEXT FROM line_tracking_events WHERE webhook_event_id = 'e20'), 'false', 'unsent row cannot be claimed after lease');
SELECT pg_temp.eq(pg_temp.col('e20', 'crm_sync_status'), 'cancelled', 'unsent row stays cancelled');

-- Claim wins over a later unsend: the push started, so it is not reported as cancelled
SELECT line_tracking_create_touch('meta_facility_202610', gen_random_uuid(), 'hash-d', 30, 120);
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e25', 'message', 'U25', 'm25', true)));
SELECT line_tracking_process_event('Ubot', 'e25', 'hash-d', false);
SELECT count(*) FROM line_tracking_lease_crm(50, 300);
SELECT line_tracking_claim_crm_send((SELECT id FROM line_tracking_events WHERE webhook_event_id = 'e25'), (SELECT crm_lease_token FROM line_tracking_events WHERE webhook_event_id = 'e25'));
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e26', 'unsend', 'U25', 'm25', false)));
SELECT line_tracking_process_event('Ubot', 'e26', NULL, false);
SELECT pg_temp.eq(pg_temp.col('e25', 'crm_sync_status'), 'sending', 'claimed push not cancelled by later unsend');
SELECT pg_temp.eq(pg_temp.col('e25', 'tracking_status'), 'retracted', 'source still retracted locally');

-- A push in flight (sending) still counts as already pushed for that person+source
SELECT line_tracking_create_touch('meta_facility_202610', gen_random_uuid(), 'hash-f', 30, 120);
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e30', 'message', 'U30', 'm30', true)));
SELECT line_tracking_process_event('Ubot', 'e30', 'hash-f', false);
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e32', 'message', 'U32', 'm32', true)));
SELECT line_tracking_process_event('Ubot', 'e32', NULL, false);
SELECT count(*) FROM line_tracking_lease_crm(50, 300);
SELECT line_tracking_claim_crm_send((SELECT id FROM line_tracking_events WHERE webhook_event_id = 'e30'), (SELECT crm_lease_token FROM line_tracking_events WHERE webhook_event_id = 'e30'));
SELECT line_tracking_claim_crm_send((SELECT id FROM line_tracking_events WHERE webhook_event_id = 'e32'), (SELECT crm_lease_token FROM line_tracking_events WHERE webhook_event_id = 'e32'));
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e31', 'message', 'U30', 'm31', true)));
SELECT line_tracking_process_event('Ubot', 'e31', 'hash-f', false);
SELECT pg_temp.eq(pg_temp.col('e31', 'crm_sync_status'), 'not_applicable', 'matched source in flight not re-queued');
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e33', 'message', 'U32', 'm33', true)));
SELECT line_tracking_process_event('Ubot', 'e33', NULL, false);
SELECT pg_temp.eq(pg_temp.col('e33', 'crm_sync_status'), 'not_applicable', 'unknown source in flight not re-queued');

-- A push that was attempted and failed (possibly delivered) is not cancelled either
SELECT line_tracking_create_touch('meta_facility_202610', gen_random_uuid(), 'hash-e', 30, 120);
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e27', 'message', 'U27', 'm27', true)));
SELECT line_tracking_process_event('Ubot', 'e27', 'hash-e', false);
SELECT count(*) FROM line_tracking_lease_crm(50, 300);
SELECT line_tracking_claim_crm_send((SELECT id FROM line_tracking_events WHERE webhook_event_id = 'e27'), (SELECT crm_lease_token FROM line_tracking_events WHERE webhook_event_id = 'e27'));
SELECT line_tracking_finish_crm((SELECT id FROM line_tracking_events WHERE webhook_event_id = 'e27'), (SELECT crm_lease_token FROM line_tracking_events WHERE webhook_event_id = 'e27'), false, true, 'timeout', 10);
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e28', 'unsend', 'U27', 'm27', false)));
SELECT line_tracking_process_event('Ubot', 'e28', NULL, false);
SELECT pg_temp.eq(pg_temp.col('e27', 'crm_sync_status'), 'pending', 'previously attempted push not cancelled');

-- A worker that died after claiming leaves 'sending'; once the lease expires it is re-leased
UPDATE line_tracking_events SET crm_next_attempt_at = now() - INTERVAL '1 second' WHERE webhook_event_id = 'e25';
SELECT pg_temp.eq((SELECT count(*)::TEXT FROM line_tracking_lease_crm(50, 300) WHERE event_id = (SELECT id FROM line_tracking_events WHERE webhook_event_id = 'e25')), '1', 'abandoned sending row re-leased');

-- Test touches stay test in every branch (conflict, expired, revoked)
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e22', 'message', 'U22', 'm22', true)));
SELECT pg_temp.eq(line_tracking_process_event('Ubot', 'e22', 'hash-test', false), 'conflict', 'other user on bound test token');
SELECT pg_temp.eq(pg_temp.col('e22', 'is_test'), 'true', 'conflict on test token stays test');
INSERT INTO line_tracking_touches (source_id, idempotency_key, token_hash, expires_at, is_test)
  SELECT id, gen_random_uuid(), 'hash-test-old', to_timestamp(1760000000), true FROM line_tracking_sources WHERE source_key = 'internal_test';
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e23', 'message', 'U23', 'm23', true)));
SELECT pg_temp.eq(line_tracking_process_event('Ubot', 'e23', 'hash-test-old', false), 'expired', 'expired test token');
SELECT pg_temp.eq(pg_temp.col('e23', 'is_test'), 'true', 'expired test token stays test');
INSERT INTO line_tracking_touches (source_id, idempotency_key, token_hash, expires_at, revoked_at, is_test)
  SELECT id, gen_random_uuid(), 'hash-test-rev', now() + INTERVAL '1 day', now(), true FROM line_tracking_sources WHERE source_key = 'internal_test';
SELECT line_tracking_record_events('Ubot', jsonb_build_array(pg_temp.ev('e24', 'message', 'U24', 'm24', true)));
SELECT pg_temp.eq(line_tracking_process_event('Ubot', 'e24', 'hash-test-rev', false), 'revoked_token', 'revoked test token');
SELECT pg_temp.eq(pg_temp.col('e24', 'is_test'), 'true', 'revoked test token stays test');

-- Per-source cap on new touches; retries of an existing key still answered
INSERT INTO line_tracking_sources (source_key, crm_source_code, entry_type, label, enabled)
VALUES ('meta_capped', 'meta', 'line_ad', 'capped', true);
SELECT line_tracking_create_touch('meta_capped', '00000000-0000-4000-8000-0000000000c1', 'hash-cap-1', 30, 2);
SELECT line_tracking_create_touch('meta_capped', '00000000-0000-4000-8000-0000000000c2', 'hash-cap-2', 30, 2);
DO $$ BEGIN
  PERFORM line_tracking_create_touch('meta_capped', '00000000-0000-4000-8000-0000000000c3', 'hash-cap-3', 30, 2);
  RAISE EXCEPTION 'FAIL cap not enforced';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'rate_limited' THEN RAISE; END IF;
  RAISE NOTICE 'ok new touch over cap rejected';
END $$;
SELECT pg_temp.eq((SELECT count(*)::TEXT FROM line_tracking_create_touch('meta_capped', '00000000-0000-4000-8000-0000000000c1', 'hash-cap-1', 30, 2)), '1', 'retry of existing key answered while capped');

SELECT pg_temp.eq((SELECT source_conflicts::TEXT FROM line_tracking_health), '2', 'health view counts conflicts');

-- S01: API roles cannot read tables, view, or call functions
SET ROLE anon;
DO $$ BEGIN
  PERFORM 1 FROM line_tracking_events;
  RAISE EXCEPTION 'FAIL anon can read events';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok anon cannot read events'; END $$;
DO $$ BEGIN
  PERFORM 1 FROM line_tracking_touches;
  RAISE EXCEPTION 'FAIL anon can read touches';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok anon cannot read touches'; END $$;
DO $$ BEGIN
  PERFORM 1 FROM line_tracking_health;
  RAISE EXCEPTION 'FAIL anon can read health view';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok anon cannot read health view'; END $$;
DO $$ BEGIN
  PERFORM line_tracking_claim_reply('Ubot', 'e2');
  RAISE EXCEPTION 'FAIL anon can call functions';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok anon cannot call functions'; END $$;
RESET ROLE;
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM 1 FROM line_tracking_events;
  RAISE EXCEPTION 'FAIL authenticated can read events';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok authenticated cannot read events'; END $$;
DO $$ BEGIN
  PERFORM line_tracking_create_touch('meta_facility_202610', gen_random_uuid(), 'hash-z', 30, 120);
  RAISE EXCEPTION 'FAIL authenticated can create touches';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok authenticated cannot call functions'; END $$;
RESET ROLE;
SET ROLE service_role;
SELECT pg_temp.eq((SELECT count(*)::TEXT FROM line_tracking_create_touch('meta_facility_202610', gen_random_uuid(), 'hash-svc', 30, 120)), '1', 'service_role can create touches');
RESET ROLE;
