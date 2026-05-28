-- Payment Idempotency Keys table
-- Ensures that retried payment operations do not create duplicate charges or subscription changes.
-- Each payment intent operation gets a unique idempotency key stored here.
-- Stripe API natively supports idempotency keys and will return the same result for the same key.

CREATE TABLE IF NOT EXISTS payment_idempotency_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL UNIQUE,
    operation_type TEXT NOT NULL CHECK (
        operation_type IN ('checkout_session', 'subscription', 'cancel', 'update')
    ),
    stripe_response JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

-- Index for fast lookup by user and key
CREATE INDEX idx_payment_idempotency_keys_user_id ON payment_idempotency_keys(user_id);
CREATE INDEX idx_payment_idempotency_keys_key ON payment_idempotency_keys(idempotency_key);
CREATE INDEX idx_payment_idempotency_keys_expires_at ON payment_idempotency_keys(expires_at);
