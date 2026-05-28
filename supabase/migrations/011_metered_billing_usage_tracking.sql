-- Create usage_records table for metered billing
-- Tracks all billable API operations for Stripe metered billing

CREATE TABLE IF NOT EXISTS usage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'api_call',
    'deployment_create',
    'deployment_update', 
    'domain_config',
    'template_clone',
    'custom_domain',
    'deployment_preview',
    'github_sync',
    'vercel_deployment'
  )),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  metadata JSONB DEFAULT '{}'::jsonb,
  
  -- Idempotency key: operation_type-user_id-timestamp
  -- Prevents duplicate usage records within same second
  idempotency_key TEXT UNIQUE NOT NULL,
  
  -- Stripe reporting
  stripe_usage_record_id TEXT,
  reported_to_stripe BOOLEAN DEFAULT FALSE,
  report_error TEXT,
  reported_at TIMESTAMP WITH TIME ZONE,
  
  -- Billing period for aggregation
  billing_period_start DATE NOT NULL,
  billing_period_end DATE NOT NULL,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_usage_records_user_period 
  ON usage_records(user_id, billing_period_start, billing_period_end);

CREATE INDEX IF NOT EXISTS idx_usage_records_unreported 
  ON usage_records(user_id, reported_to_stripe) 
  WHERE reported_to_stripe = FALSE;

CREATE INDEX IF NOT EXISTS idx_usage_records_operation_type 
  ON usage_records(operation_type);

CREATE INDEX IF NOT EXISTS idx_usage_records_created_at 
  ON usage_records(created_at);

CREATE INDEX IF NOT EXISTS idx_usage_records_idempotency 
  ON usage_records(idempotency_key);

-- Enable row level security
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can view their own usage records
CREATE POLICY "usage_records_user_policy" ON usage_records
  FOR SELECT USING (
    auth.uid() = user_id OR
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.subscription_tier = 'enterprise'
    )
  );

-- RLS Policy: Service role can insert/update usage records
CREATE POLICY "usage_records_service_policy" ON usage_records
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "usage_records_update_policy" ON usage_records
  FOR UPDATE USING (auth.role() = 'service_role' OR auth.uid() = user_id)
  WITH CHECK (auth.role() = 'service_role' OR auth.uid() = user_id);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_usage_records_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for updated_at
DROP TRIGGER IF EXISTS usage_records_update_timestamp ON usage_records;
CREATE TRIGGER usage_records_update_timestamp
  BEFORE UPDATE ON usage_records
  FOR EACH ROW
  EXECUTE FUNCTION update_usage_records_timestamp();

-- Comment for documentation
COMMENT ON TABLE usage_records IS 'Tracks billable API operations for Stripe metered billing integration. Each record represents usage that should be reported to Stripe for usage-based billing.';
COMMENT ON COLUMN usage_records.idempotency_key IS 'Unique key combining operation type, user ID, and second timestamp. Ensures duplicate usage within same second is handled idempotently.';
COMMENT ON COLUMN usage_records.reported_to_stripe IS 'Whether this usage has been reported to Stripe. Used to track pending reports and implement retry logic.';
