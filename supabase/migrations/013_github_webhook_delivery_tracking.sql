-- Migration 013: GitHub Webhook Delivery Tracking and Replay
--
-- Enables tracking of expected vs received GitHub webhook deliveries,
-- detection of missed deliveries, and replay mechanism for failed/missed events.
--
-- Features:
--   1. Persistent webhook delivery log (all received deliveries)
--   2. Delivery status tracking (received, processed, failed, replayed)
--   3. Idempotency using delivery_id (survives server restarts)
--   4. Missed delivery detection by comparing against GitHub's delivery log
--   5. Replay mechanism with idempotent reprocessing
--
-- Issue: #653 — GitHub Webhook Delivery Replay Implementation

-- ── Webhook Deliveries Table ─────────────────────────────────────────────────

/**
 * Stores all received GitHub webhook deliveries for tracking and replay.
 *
 * delivery_id: GitHub's x-github-delivery header (unique per delivery)
 * event_type: GitHub's x-github-event header (push, installation, etc.)
 * payload: Full webhook payload (JSON)
 * headers: Request headers (JSON) for signature verification on replay
 * status: Processing status (received, processed, failed, replayed)
 * processing_error: Error message if processing failed
 * processed_at: Timestamp when successfully processed
 * replayed_from_delivery_id: If this is a replay, the original delivery_id
 */
CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    headers JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'received' CHECK (
        status IN ('received', 'processed', 'failed', 'replayed')
    ),
    processing_error TEXT,
    processed_at TIMESTAMPTZ,
    replayed_from_delivery_id TEXT REFERENCES github_webhook_deliveries(delivery_id),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_github_webhook_deliveries_delivery_id
    ON github_webhook_deliveries(delivery_id);

CREATE INDEX IF NOT EXISTS idx_github_webhook_deliveries_event_type
    ON github_webhook_deliveries(event_type);

CREATE INDEX IF NOT EXISTS idx_github_webhook_deliveries_status
    ON github_webhook_deliveries(status);

CREATE INDEX IF NOT EXISTS idx_github_webhook_deliveries_created_at
    ON github_webhook_deliveries(created_at DESC);

-- Composite index for missed delivery detection
CREATE INDEX IF NOT EXISTS idx_github_webhook_deliveries_event_created
    ON github_webhook_deliveries(event_type, created_at DESC);

-- Updated_at trigger
CREATE TRIGGER update_github_webhook_deliveries_updated_at
    BEFORE UPDATE ON github_webhook_deliveries
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ── Missed Deliveries Tracking ───────────────────────────────────────────────

/**
 * Stores deliveries detected as missing by comparing against GitHub's delivery log.
 *
 * github_delivery_id: Delivery ID from GitHub's API
 * event_type: Event type from GitHub's API
 * delivered_at: Timestamp from GitHub's API
 * detected_at: When we detected it was missing
 * replayed: Whether we've replayed this delivery
 * replay_delivery_id: The delivery_id of the replayed event
 */
CREATE TABLE IF NOT EXISTS github_webhook_missed_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    github_delivery_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    delivered_at TIMESTAMPTZ NOT NULL,
    detected_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    replayed BOOLEAN DEFAULT FALSE,
    replay_delivery_id TEXT REFERENCES github_webhook_deliveries(delivery_id),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_github_webhook_missed_deliveries_replayed
    ON github_webhook_missed_deliveries(replayed)
    WHERE replayed = FALSE;

CREATE INDEX IF NOT EXISTS idx_github_webhook_missed_deliveries_detected_at
    ON github_webhook_missed_deliveries(detected_at DESC);

-- Updated_at trigger
CREATE TRIGGER update_github_webhook_missed_deliveries_updated_at
    BEFORE UPDATE ON github_webhook_missed_deliveries
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ── Delivery Statistics View ─────────────────────────────────────────────────

/**
 * Aggregated statistics for webhook delivery health monitoring.
 */
CREATE OR REPLACE VIEW github_webhook_delivery_stats AS
SELECT
    event_type,
    COUNT(*) AS total_deliveries,
    COUNT(*) FILTER (WHERE status = 'processed') AS processed_count,
    COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
    COUNT(*) FILTER (WHERE status = 'replayed') AS replayed_count,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE status = 'processed') / NULLIF(COUNT(*), 0),
        2
    ) AS success_rate_pct,
    MAX(created_at) AS last_delivery_at,
    MIN(created_at) FILTER (WHERE status = 'failed') AS first_failure_at
FROM github_webhook_deliveries
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY event_type
ORDER BY total_deliveries DESC;

-- Grant access to monitoring view
GRANT SELECT ON github_webhook_delivery_stats TO authenticated;

-- ── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Check if a delivery has been received (idempotency check).
 *
 * Returns TRUE if delivery_id exists in the deliveries table.
 */
CREATE OR REPLACE FUNCTION has_received_delivery(p_delivery_id TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1 FROM github_webhook_deliveries
        WHERE delivery_id = p_delivery_id
    );
$$;

/**
 * Record a new webhook delivery.
 *
 * Returns the created delivery record.
 */
CREATE OR REPLACE FUNCTION record_webhook_delivery(
    p_delivery_id TEXT,
    p_event_type TEXT,
    p_payload JSONB,
    p_headers JSONB
)
RETURNS github_webhook_deliveries
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_delivery github_webhook_deliveries;
BEGIN
    INSERT INTO github_webhook_deliveries (
        delivery_id,
        event_type,
        payload,
        headers,
        status
    ) VALUES (
        p_delivery_id,
        p_event_type,
        p_payload,
        p_headers,
        'received'
    )
    ON CONFLICT (delivery_id) DO NOTHING
    RETURNING * INTO v_delivery;

    RETURN v_delivery;
END;
$$;

/**
 * Mark a delivery as processed successfully.
 */
CREATE OR REPLACE FUNCTION mark_delivery_processed(p_delivery_id TEXT)
RETURNS VOID
LANGUAGE SQL
SECURITY DEFINER
AS $$
    UPDATE github_webhook_deliveries
    SET status = 'processed',
        processed_at = NOW()
    WHERE delivery_id = p_delivery_id;
$$;

/**
 * Mark a delivery as failed with error message.
 */
CREATE OR REPLACE FUNCTION mark_delivery_failed(
    p_delivery_id TEXT,
    p_error_message TEXT
)
RETURNS VOID
LANGUAGE SQL
SECURITY DEFINER
AS $$
    UPDATE github_webhook_deliveries
    SET status = 'failed',
        processing_error = p_error_message
    WHERE delivery_id = p_delivery_id;
$$;

/**
 * Get deliveries that need replay (failed or missed).
 *
 * Returns deliveries with status = 'failed' or missed deliveries not yet replayed.
 */
CREATE OR REPLACE FUNCTION get_deliveries_for_replay()
RETURNS TABLE (
    delivery_id TEXT,
    event_type TEXT,
    payload JSONB,
    headers JSONB,
    source TEXT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
AS $$
    -- Failed deliveries
    SELECT
        d.delivery_id,
        d.event_type,
        d.payload,
        d.headers,
        'failed'::TEXT AS source
    FROM github_webhook_deliveries d
    WHERE d.status = 'failed'

    UNION ALL

    -- Missed deliveries (detected but not yet replayed)
    SELECT
        m.github_delivery_id AS delivery_id,
        m.event_type,
        NULL::JSONB AS payload,
        NULL::JSONB AS headers,
        'missed'::TEXT AS source
    FROM github_webhook_missed_deliveries m
    WHERE m.replayed = FALSE;
$$;

-- ── Row Level Security ────────────────────────────────────────────────────────

ALTER TABLE github_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_webhook_missed_deliveries ENABLE ROW LEVEL SECURITY;

-- Service role can manage all webhook delivery records
CREATE POLICY "Service role can manage github_webhook_deliveries"
    ON github_webhook_deliveries
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Service role can manage github_webhook_missed_deliveries"
    ON github_webhook_missed_deliveries
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Authenticated users can read webhook delivery records
CREATE POLICY "Authenticated users can read github_webhook_deliveries"
    ON github_webhook_deliveries
    FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Authenticated users can read github_webhook_missed_deliveries"
    ON github_webhook_missed_deliveries
    FOR SELECT
    TO authenticated
    USING (true);

-- ── Comments ──────────────────────────────────────────────────────────────────

COMMENT ON TABLE github_webhook_deliveries IS
    'Persistent log of all received GitHub webhook deliveries for tracking and replay';

COMMENT ON TABLE github_webhook_missed_deliveries IS
    'Deliveries detected as missing by comparing against GitHub''s delivery log';

COMMENT ON VIEW github_webhook_delivery_stats IS
    'Aggregated webhook delivery health metrics over the last 30 days';

COMMENT ON FUNCTION has_received_delivery(TEXT) IS
    'Check if a delivery has been received (idempotency check)';

COMMENT ON FUNCTION record_webhook_delivery(TEXT, TEXT, JSONB, JSONB) IS
    'Record a new webhook delivery with payload and headers';

COMMENT ON FUNCTION mark_delivery_processed(TEXT) IS
    'Mark a delivery as successfully processed';

COMMENT ON FUNCTION mark_delivery_failed(TEXT, TEXT) IS
    'Mark a delivery as failed with error message';

COMMENT ON FUNCTION get_deliveries_for_replay() IS
    'Get all deliveries that need replay (failed or missed)';
