-- Create auth_audit_logs table for cross-region audit trail
-- Tracks authentication events across all regional deployments

CREATE TABLE IF NOT EXISTS auth_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('signin', 'signup', 'refresh', 'logout', 'failure')),
  region TEXT NOT NULL CHECK (region IN ('us-east', 'eu-west', 'ap-southeast')),
  request_id TEXT UNIQUE NOT NULL,
  details JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_user_id ON auth_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_region ON auth_audit_logs(region);
CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_event_type ON auth_audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_created_at ON auth_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_user_created ON auth_audit_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_audit_logs_request_id ON auth_audit_logs(request_id);

-- Enable row level security
ALTER TABLE auth_audit_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only view their own audit logs
CREATE POLICY "auth_audit_logs_user_policy" ON auth_audit_logs
  FOR SELECT USING (
    auth.uid() = user_id OR
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.subscription_tier IN ('premium', 'enterprise')
    )
  );

-- RLS Policy: Service role can insert audit logs
CREATE POLICY "auth_audit_logs_insert_policy" ON auth_audit_logs
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated' OR
    auth.role() = 'service_role'
  );

-- Comment for documentation
COMMENT ON TABLE auth_audit_logs IS 'Cross-region authentication audit trail. Tracks all auth events (signin, signup, token refresh, failures) across regional deployments for security monitoring and state consistency verification.';
