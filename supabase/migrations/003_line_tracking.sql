-- LINE 來源追蹤：入口 touch、webhook 事件（去重、回覆狀態、CRM outbox）、撤回 tombstone。
-- 只供後端 service role 使用：RLS 開啟且不建 policy，並撤銷 API 角色（anon／authenticated）的權限。
-- 來源由營運以 SQL 新增，例如：
--   insert into line_tracking_sources (source_key, crm_source_code, entry_type, label, enabled)
--   values ('meta_facility_202610', 'meta', 'line_ad', 'Meta 廣告／企業設施管理／202610', true);

CREATE TABLE IF NOT EXISTS line_tracking_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key TEXT NOT NULL UNIQUE CHECK (source_key ~ '^[a-z0-9_]{1,64}$'),
  crm_source_code TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('line_ad', 'form_to_line')),
  label TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  is_test BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS line_tracking_touches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES line_tracking_sources (id),
  idempotency_key UUID NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  bound_line_user_id TEXT,
  bound_message_id TEXT,
  bound_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  is_test BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS line_tracking_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id TEXT NOT NULL,
  webhook_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message_type TEXT,
  source_type TEXT,
  event_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_redelivery BOOLEAN NOT NULL DEFAULT false,
  is_unblocked BOOLEAN,
  line_user_id TEXT,
  message_id TEXT,
  is_inquiry BOOLEAN NOT NULL DEFAULT false,
  touch_id UUID REFERENCES line_tracking_touches (id),
  -- Snapshot at attribution time so later source edits never rewrite history
  source_key TEXT,
  crm_source_code TEXT,
  tracking_status TEXT NOT NULL DEFAULT 'recorded' CHECK (tracking_status IN (
    'recorded', 'not_inquiry', 'no_token', 'matched', 'unknown_token', 'expired',
    'revoked_token', 'conflict', 'retracted', 'unsend_applied'
  )),
  reply_status TEXT NOT NULL DEFAULT 'pending' CHECK (reply_status IN (
    'pending', 'sending', 'skipped', 'sent', 'failed', 'unknown'
  )),
  reply_attempts INTEGER NOT NULL DEFAULT 0,
  reply_updated_at TIMESTAMPTZ,
  -- sending = a push has started (claimed); from then on an unsend no longer cancels it
  crm_sync_status TEXT NOT NULL DEFAULT 'not_applicable' CHECK (crm_sync_status IN (
    'not_applicable', 'pending', 'sending', 'sent', 'failed', 'cancelled'
  )),
  crm_sync_attempts INTEGER NOT NULL DEFAULT 0,
  crm_next_attempt_at TIMESTAMPTZ,
  crm_last_error TEXT,
  crm_synced_at TIMESTAMPTZ,
  crm_lease_token UUID,
  retracted_at TIMESTAMPTZ,
  is_test BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (account_id, webhook_event_id)
);

CREATE INDEX IF NOT EXISTS idx_line_tracking_events_user ON line_tracking_events (account_id, line_user_id);
CREATE INDEX IF NOT EXISTS idx_line_tracking_events_message ON line_tracking_events (account_id, message_id)
  WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_line_tracking_touches_source_created ON line_tracking_touches (source_id, created_at);
CREATE INDEX IF NOT EXISTS idx_line_tracking_events_crm_pending ON line_tracking_events (crm_next_attempt_at)
  WHERE crm_sync_status IN ('pending', 'sending');

CREATE TABLE IF NOT EXISTS line_tracking_unsent (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  unsent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, message_id)
);

ALTER TABLE line_tracking_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_tracking_touches ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_tracking_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_tracking_unsent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON line_tracking_sources, line_tracking_touches, line_tracking_events, line_tracking_unsent
  FROM anon, authenticated;

-- ─── Write path (called by the bot with the service role) ────────────────────

-- Idempotent batch insert; redelivered events keep their original row and statuses.
CREATE OR REPLACE FUNCTION line_tracking_record_events(p_account_id TEXT, p_events JSONB)
RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO line_tracking_events (
    account_id, webhook_event_id, event_type, message_type, source_type, event_at,
    is_redelivery, is_unblocked, line_user_id, message_id, is_inquiry
  )
  SELECT p_account_id, e->>'webhook_event_id', e->>'event_type', e->>'message_type', e->>'source_type',
         to_timestamp((e->>'timestamp_ms')::BIGINT / 1000.0),
         COALESCE((e->>'is_redelivery')::BOOLEAN, false), (e->>'is_unblocked')::BOOLEAN,
         e->>'line_user_id', e->>'message_id', COALESCE((e->>'is_inquiry')::BOOLEAN, false)
  FROM jsonb_array_elements(p_events) AS e
  ON CONFLICT (account_id, webhook_event_id) DO NOTHING
$$;

-- Resolves attribution once per event (resumable: only acts while tracking_status = 'recorded').
CREATE OR REPLACE FUNCTION line_tracking_process_event(
  p_account_id TEXT, p_webhook_event_id TEXT, p_token_hash TEXT, p_is_test_user BOOLEAN
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  ev line_tracking_events%ROWTYPE;
  t line_tracking_touches%ROWTYPE;
  s line_tracking_sources%ROWTYPE;
  v_status TEXT;
  v_touch_id UUID;
  v_source_key TEXT;
  v_crm_source_code TEXT;
  v_is_test BOOLEAN := COALESCE(p_is_test_user, false);
  v_crm TEXT := 'not_applicable';
BEGIN
  -- A message and its unsend may be processed concurrently; serialize them on the message id
  -- (immutable, so read without a lock) BEFORE taking any row lock, so both paths lock in the
  -- same order: advisory lock, then rows. The unsend then always sees (and revokes) the binding
  -- the message made, or the message sees the tombstone.
  SELECT * INTO ev FROM line_tracking_events
    WHERE account_id = p_account_id AND webhook_event_id = p_webhook_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'line tracking event not recorded: %', p_webhook_event_id;
  END IF;
  IF ev.message_id IS NOT NULL AND ev.event_type IN ('message', 'unsend') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_account_id || ':' || ev.message_id, 0));
  END IF;
  SELECT * INTO ev FROM line_tracking_events WHERE id = ev.id FOR UPDATE;
  IF ev.tracking_status <> 'recorded' THEN
    RETURN ev.tracking_status;
  END IF;

  IF ev.event_type = 'unsend' THEN
    INSERT INTO line_tracking_unsent (account_id, message_id) VALUES (p_account_id, ev.message_id)
      ON CONFLICT DO NOTHING;
    UPDATE line_tracking_touches SET revoked_at = COALESCE(revoked_at, now())
      WHERE bound_message_id = ev.message_id AND bound_line_user_id = ev.line_user_id;
    UPDATE line_tracking_events
      SET tracking_status = 'retracted', retracted_at = now(),
          -- Only a push that was never attempted can be cancelled; once started it may have reached CRM
          crm_sync_status = CASE WHEN crm_sync_status = 'pending' AND crm_sync_attempts = 0
                                 THEN 'cancelled' ELSE crm_sync_status END
      WHERE account_id = p_account_id AND message_id = ev.message_id AND event_type = 'message';
    v_status := 'unsend_applied';
  ELSIF NOT ev.is_inquiry THEN
    v_status := 'not_inquiry';
  ELSIF EXISTS (SELECT 1 FROM line_tracking_unsent WHERE account_id = p_account_id AND message_id = ev.message_id) THEN
    v_status := 'retracted';
  ELSIF p_token_hash IS NULL THEN
    v_status := 'no_token';
  ELSE
    SELECT * INTO t FROM line_tracking_touches WHERE token_hash = p_token_hash FOR UPDATE;
    IF FOUND THEN
      v_is_test := v_is_test OR t.is_test; -- test entries stay test even when expired, revoked or in conflict
    END IF;
    IF NOT FOUND THEN
      v_status := 'unknown_token';
    ELSIF t.revoked_at IS NOT NULL THEN
      v_status := 'revoked_token';
    ELSIF t.expires_at < ev.event_at THEN
      v_status := 'expired';
    ELSIF t.bound_line_user_id IS NOT NULL AND t.bound_line_user_id <> ev.line_user_id THEN
      v_status := 'conflict';
      v_touch_id := t.id; -- kept for audit; the original binding is never overwritten
    ELSE
      IF t.bound_line_user_id IS NULL THEN
        UPDATE line_tracking_touches
          SET bound_line_user_id = ev.line_user_id, bound_message_id = ev.message_id, bound_at = now()
          WHERE id = t.id;
      END IF;
      SELECT * INTO s FROM line_tracking_sources WHERE id = t.source_id;
      v_status := 'matched';
      v_touch_id := t.id;
      v_source_key := s.source_key;
      v_crm_source_code := s.crm_source_code;
    END IF;
  END IF;

  -- One CRM inquiry per person per source (unknown counts as its own source)
  IF ev.is_inquiry AND v_status NOT IN ('retracted') AND ev.line_user_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM line_tracking_events o
       WHERE o.account_id = p_account_id AND o.line_user_id = ev.line_user_id
         AND o.source_key IS NOT DISTINCT FROM v_source_key
         AND o.crm_sync_status IN ('pending', 'sending', 'sent') AND o.id <> ev.id
     ) THEN
    v_crm := 'pending';
  END IF;

  UPDATE line_tracking_events SET
    tracking_status = v_status,
    touch_id = v_touch_id,
    source_key = v_source_key,
    crm_source_code = v_crm_source_code,
    is_test = v_is_test,
    crm_sync_status = v_crm,
    crm_next_attempt_at = CASE WHEN v_crm = 'pending' THEN now() END
  WHERE id = ev.id;

  RETURN v_status;
END;
$$;

-- Atomic claim: only one worker may move a pending reply to sending.
-- Returns the attempt number (1 = first try) or 0 when not claimed.
CREATE OR REPLACE FUNCTION line_tracking_claim_reply(p_account_id TEXT, p_webhook_event_id TEXT)
RETURNS INTEGER LANGUAGE sql AS $$
  WITH claimed AS (
    UPDATE line_tracking_events
    SET reply_status = 'sending', reply_attempts = reply_attempts + 1, reply_updated_at = now()
    WHERE account_id = p_account_id AND webhook_event_id = p_webhook_event_id AND reply_status = 'pending'
    RETURNING reply_attempts
  )
  SELECT COALESCE((SELECT reply_attempts FROM claimed), 0)
$$;

CREATE OR REPLACE FUNCTION line_tracking_finish_reply(p_account_id TEXT, p_webhook_event_id TEXT, p_status TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_status NOT IN ('pending', 'skipped', 'sent', 'failed', 'unknown') THEN
    RAISE EXCEPTION 'invalid reply status: %', p_status;
  END IF;
  UPDATE line_tracking_events SET reply_status = p_status, reply_updated_at = now()
    WHERE account_id = p_account_id AND webhook_event_id = p_webhook_event_id AND reply_status = 'sending';
END;
$$;

-- Idempotent touch creation; returns no row when the source is unknown or disabled.
-- New touches are capped per source per minute (raises 'rate_limited') so the public endpoint
-- cannot grow the table without bound; retries of an existing key are always answered.
CREATE OR REPLACE FUNCTION line_tracking_create_touch(
  p_source_key TEXT, p_idempotency_key UUID, p_token_hash TEXT, p_ttl_days INTEGER, p_max_per_minute INTEGER
) RETURNS TABLE (touch_id UUID, expires_at TIMESTAMPTZ) LANGUAGE plpgsql AS $$
DECLARE
  s line_tracking_sources%ROWTYPE;
  r line_tracking_touches%ROWTYPE;
BEGIN
  SELECT * INTO s FROM line_tracking_sources WHERE source_key = p_source_key AND enabled;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  -- Serialize new touches per source so the count and the insert below are atomic
  PERFORM pg_advisory_xact_lock(hashtextextended('line-touch-source:' || s.id::TEXT, 0));
  IF NOT EXISTS (SELECT 1 FROM line_tracking_touches t WHERE t.idempotency_key = p_idempotency_key)
     AND (SELECT count(*) FROM line_tracking_touches t
          WHERE t.source_id = s.id AND t.created_at > now() - INTERVAL '1 minute') >= p_max_per_minute THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  INSERT INTO line_tracking_touches (source_id, idempotency_key, token_hash, expires_at, is_test)
    VALUES (s.id, p_idempotency_key, p_token_hash, now() + make_interval(days => p_ttl_days), s.is_test)
    ON CONFLICT (idempotency_key) DO NOTHING;
  SELECT * INTO r FROM line_tracking_touches t WHERE t.idempotency_key = p_idempotency_key;
  IF r.source_id <> s.id OR r.token_hash <> p_token_hash THEN
    RAISE EXCEPTION 'idempotency_conflict';
  END IF;
  RETURN QUERY SELECT r.id, r.expires_at;
END;
$$;

-- ─── CRM outbox ──────────────────────────────────────────────────────────────

-- Leases due rows so concurrent flushers skip them. Each lease gets a fresh token: only the
-- current holder may finish a row, and a row cancelled (unsend) after leasing is never sent.
CREATE OR REPLACE FUNCTION line_tracking_lease_crm(p_limit INTEGER, p_lease_seconds INTEGER)
RETURNS TABLE (
  event_id UUID, lease_token UUID, account_id TEXT, line_user_id TEXT, source_key TEXT, crm_source_code TEXT,
  entry_type TEXT, attribution_status TEXT, first_touch_at TIMESTAMPTZ, first_inquiry_at TIMESTAMPTZ,
  is_test BOOLEAN
) LANGUAGE sql AS $$
  WITH token AS (SELECT gen_random_uuid() AS v), due AS (
    SELECT id FROM line_tracking_events
    -- An expired 'sending' row is a worker that died mid-push; resending is safe (CRM dedupes botEventRef)
    WHERE crm_sync_status IN ('pending', 'sending') AND COALESCE(crm_next_attempt_at, '-infinity') <= now()
    ORDER BY crm_next_attempt_at NULLS FIRST
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), leased AS (
    UPDATE line_tracking_events e
    SET crm_next_attempt_at = now() + make_interval(secs => p_lease_seconds), crm_lease_token = token.v
    FROM due, token WHERE e.id = due.id
    RETURNING e.*
  )
  SELECT l.id, l.crm_lease_token, l.account_id, l.line_user_id, l.source_key, l.crm_source_code,
         CASE WHEN l.source_key IS NOT NULL THEN s.entry_type END,
         l.tracking_status,
         CASE WHEN l.source_key IS NOT NULL THEN t.created_at END,
         l.event_at, l.is_test
  FROM leased l
  LEFT JOIN line_tracking_touches t ON t.id = l.touch_id
  LEFT JOIN line_tracking_sources s ON s.id = t.source_id
$$;

-- The decision point right before each push: atomically pending/sending -> sending under our
-- unexpired lease. Races with the unsend cancellation on the same row; whichever commits first wins.
CREATE OR REPLACE FUNCTION line_tracking_claim_crm_send(p_event_id UUID, p_lease_token UUID)
RETURNS BOOLEAN LANGUAGE sql AS $$
  WITH claimed AS (
    UPDATE line_tracking_events SET crm_sync_status = 'sending'
    WHERE id = p_event_id AND crm_sync_status IN ('pending', 'sending') AND crm_lease_token = p_lease_token
      AND crm_next_attempt_at > now()
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed)
$$;

CREATE OR REPLACE FUNCTION line_tracking_finish_crm(
  p_event_id UUID, p_lease_token UUID, p_ok BOOLEAN, p_retryable BOOLEAN, p_error TEXT, p_max_attempts INTEGER
) RETURNS VOID LANGUAGE sql AS $$
  UPDATE line_tracking_events SET
    crm_sync_attempts = crm_sync_attempts + 1,
    crm_sync_status = CASE
      WHEN p_ok THEN 'sent'
      WHEN NOT p_retryable OR crm_sync_attempts + 1 >= p_max_attempts THEN 'failed'
      ELSE 'pending' END,
    crm_synced_at = CASE WHEN p_ok THEN now() ELSE crm_synced_at END,
    crm_last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END,
    -- Exponential backoff: 1, 2, 4 … minutes, capped at 6 hours
    crm_next_attempt_at = CASE WHEN p_ok THEN NULL
      ELSE now() + LEAST(make_interval(mins => power(2, crm_sync_attempts)::INTEGER), INTERVAL '6 hours') END
  WHERE id = p_event_id AND crm_sync_status = 'sending' AND crm_lease_token = p_lease_token
$$;

-- ─── Diagnostics ─────────────────────────────────────────────────────────────

-- shortcut: full scan of line_tracking_events; add a time window once volume grows past ~100k rows
CREATE OR REPLACE VIEW line_tracking_health WITH (security_invoker = true) AS
SELECT
  count(*) FILTER (WHERE tracking_status = 'recorded' AND received_at < now() - INTERVAL '10 minutes') AS tracking_stuck,
  count(*) FILTER (WHERE reply_status = 'sending' AND reply_updated_at < now() - INTERVAL '10 minutes') AS reply_stuck_sending,
  count(*) FILTER (WHERE reply_status = 'unknown') AS reply_unknown,
  count(*) FILTER (WHERE reply_status = 'failed') AS reply_failed,
  count(*) FILTER (WHERE crm_sync_status IN ('pending', 'sending')) AS crm_pending,
  count(*) FILTER (WHERE crm_sync_status = 'failed') AS crm_failed,
  count(*) FILTER (WHERE tracking_status = 'conflict') AS source_conflicts,
  max(received_at) AS last_event_received_at
FROM line_tracking_events;

REVOKE ALL ON line_tracking_health FROM anon, authenticated;

REVOKE ALL ON FUNCTION
  line_tracking_record_events(TEXT, JSONB),
  line_tracking_process_event(TEXT, TEXT, TEXT, BOOLEAN),
  line_tracking_claim_reply(TEXT, TEXT),
  line_tracking_finish_reply(TEXT, TEXT, TEXT),
  line_tracking_create_touch(TEXT, UUID, TEXT, INTEGER, INTEGER),
  line_tracking_lease_crm(INTEGER, INTEGER),
  line_tracking_claim_crm_send(UUID, UUID),
  line_tracking_finish_crm(UUID, UUID, BOOLEAN, BOOLEAN, TEXT, INTEGER)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  line_tracking_record_events(TEXT, JSONB),
  line_tracking_process_event(TEXT, TEXT, TEXT, BOOLEAN),
  line_tracking_claim_reply(TEXT, TEXT),
  line_tracking_finish_reply(TEXT, TEXT, TEXT),
  line_tracking_create_touch(TEXT, UUID, TEXT, INTEGER, INTEGER),
  line_tracking_lease_crm(INTEGER, INTEGER),
  line_tracking_claim_crm_send(UUID, UUID),
  line_tracking_finish_crm(UUID, UUID, BOOLEAN, BOOLEAN, TEXT, INTEGER)
TO service_role;
