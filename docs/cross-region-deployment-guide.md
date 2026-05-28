# Cross-Region Edge Function Deployment Guide

## Overview

This guide walks through deploying the cross-region authentication edge functions to production Supabase instances across multiple regions (us-east, eu-west, ap-southeast).

## Prerequisites

- Supabase CLI installed: `npm install -g supabase`
- Access to Supabase projects in all regions
- API tokens for each regional project
- Git repository with the craft project

## Deployment Steps

### Step 1: Prepare Deployment Configuration

Create `.env.regional` file with regional Supabase URLs and keys:

```bash
# .env.regional
SUPABASE_URL_US_EAST=https://your-project-us-east.supabase.co
SUPABASE_ANON_KEY_US_EAST=your-us-east-anon-key
SUPABASE_SERVICE_ROLE_KEY_US_EAST=your-us-east-service-role-key

SUPABASE_URL_EU_WEST=https://your-project-eu-west.supabase.co
SUPABASE_ANON_KEY_EU_WEST=your-eu-west-anon-key
SUPABASE_SERVICE_ROLE_KEY_EU_WEST=your-eu-west-service-role-key

SUPABASE_URL_AP_SOUTHEAST=https://your-project-ap-southeast.supabase.co
SUPABASE_ANON_KEY_AP_SOUTHEAST=your-ap-southeast-anon-key
SUPABASE_SERVICE_ROLE_KEY_AP_SOUTHEAST=your-ap-southeast-service-role-key

# Edge function URLs for routing
EDGE_FUNCTION_URL_US_EAST=https://your-project-us-east.functions.supabase.co
EDGE_FUNCTION_URL_EU_WEST=https://your-project-eu-west.functions.supabase.co
EDGE_FUNCTION_URL_AP_SOUTHEAST=https://your-project-ap-southeast.functions.supabase.co

# Shared JWT secret (same across all regions)
SUPABASE_JWT_SECRET=your-shared-jwt-secret

# CORS configuration
ALLOWED_ORIGINS=https://app.example.com,https://staging.example.com
```

### Step 2: Deploy Database Migrations

Deploy the auth audit logs table to all regions:

```bash
# US-EAST
export SUPABASE_URL=$SUPABASE_URL_US_EAST
export SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY_US_EAST

supabase db pull # For first-time setup
supabase migration up

# EU-WEST
export SUPABASE_URL=$SUPABASE_URL_EU_WEST
export SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY_EU_WEST

supabase db pull
supabase migration up

# AP-SOUTHEAST
export SUPABASE_URL=$SUPABASE_URL_AP_SOUTHEAST
export SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY_AP_SOUTHEAST

supabase db pull
supabase migration up
```

Or use the SQL migration directly:

```bash
# For each region's Supabase project:
psql -h your-region.db.supabase.co -U postgres -d postgres < supabase/migrations/010_auth_audit_logs_cross_region.sql
```

### Step 3: Deploy Edge Functions

Deploy the edge functions to each region:

#### Deploy to US-EAST

```bash
export SUPABASE_URL=$SUPABASE_URL_US_EAST
export SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY_US_EAST

# Deploy auth functions
supabase functions deploy regional-auth-sign-up --import-map=supabase/functions/import_map.json
supabase functions deploy regional-auth-sign-in --import-map=supabase/functions/import_map.json
supabase functions deploy regional-auth-token-refresh --import-map=supabase/functions/import_map.json

# Deploy health check
supabase functions deploy regional-health-check

# Deploy router
supabase functions deploy regional-router

# Set function secrets
supabase secrets set --env-file .env.regional
```

#### Deploy to EU-WEST

```bash
export SUPABASE_URL=$SUPABASE_URL_EU_WEST
export SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY_EU_WEST

supabase functions deploy regional-auth-sign-up
supabase functions deploy regional-auth-sign-in
supabase functions deploy regional-auth-token-refresh
supabase functions deploy regional-health-check
supabase functions deploy regional-router

supabase secrets set --env-file .env.regional
```

#### Deploy to AP-SOUTHEAST

```bash
export SUPABASE_URL=$SUPABASE_URL_AP_SOUTHEAST
export SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY_AP_SOUTHEAST

supabase functions deploy regional-auth-sign-up
supabase functions deploy regional-auth-sign-in
supabase functions deploy regional-auth-token-refresh
supabase functions deploy regional-health-check
supabase functions deploy regional-router

supabase secrets set --env-file .env.regional
```

### Step 4: Verify Deployments

#### Check Function Status

```bash
# For each region:
supabase functions list

# Expected output:
# regional-auth-sign-up      (deployed)
# regional-auth-sign-in      (deployed)
# regional-auth-token-refresh (deployed)
# regional-health-check       (deployed)
# regional-router             (deployed)
```

#### Test Health Checks

```bash
# Test each region's health
curl https://your-project-us-east.functions.supabase.co/functions/v1/regional-health-check
curl https://your-project-eu-west.functions.supabase.co/functions/v1/regional-health-check
curl https://your-project-ap-southeast.functions.supabase.co/functions/v1/regional-health-check

# All should return: "allHealthy": true
```

#### Test Sign-Up Flow

```bash
# Test sign-up in each region
curl https://your-project-us-east.functions.supabase.co/functions/v1/regional-auth-sign-up \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "TestPass123"}'

# Should return: "success": true
```

### Step 5: Configure API Gateway

Set up API gateway or CDN to route requests to the regional router:

#### Using Cloudflare

1. Go to Cloudflare Dashboard
2. Create routing rule to detect geography
3. Route requests based on country to nearest region:

```
if (cf.country == "GB" or cf.country == "FR") {
  route to EU-WEST region
} else if (cf.country == "SG" or cf.country == "AU") {
  route to AP-SOUTHEAST region
} else {
  route to US-EAST region
}
```

#### Using AWS CloudFront

1. Create distribution with multiple origins
2. Configure geo-routing:
   - EU requests → eu-west endpoint
   - Asia-Pacific requests → ap-southeast endpoint
   - Default → us-east endpoint

### Step 6: Set Environment Variables in Your App

Update your application environment variables:

```bash
# Frontend
VITE_AUTH_ENDPOINT=https://api.example.com/functions/v1/regional-auth
VITE_ROUTER_ENDPOINT=https://api.example.com/router/auth

# Backend
AUTH_ENDPOINT=https://api.example.com/functions/v1/regional-auth
ROUTER_ENDPOINT=https://api.example.com/router/auth
```

### Step 7: Run Integration Tests

```bash
# Run edge function tests
npm test -- supabase/functions

# Run auth integration tests
npm test -- apps/backend/src/services/auth.integration.test.ts

# Run cross-region tests
npm test -- supabase/functions/regional-health-check/health-check.test.ts
npm test -- supabase/functions/regional-auth/regional-auth.test.ts
```

## Post-Deployment Verification

### Health Monitoring

Monitor regional health in real-time:

```bash
# Check all regions
watch -n 10 'curl -s https://api.example.com/functions/v1/regional-health-check | jq'

# Expected healthy status
{
  "allHealthy": true,
  "healthyRegions": ["us-east", "eu-west", "ap-southeast"],
  "regions": [
    {"region": "us-east", "healthy": true, "responseTime": 50},
    {"region": "eu-west", "healthy": true, "responseTime": 75},
    {"region": "ap-southeast", "healthy": true, "responseTime": 85}
  ]
}
```

### Audit Trail Verification

Verify audit logs are being recorded:

```sql
-- Check recent auth events
SELECT * FROM auth_audit_logs
ORDER BY created_at DESC
LIMIT 10;

-- Should see events from different regions:
-- us-east, eu-west, ap-southeast
```

### Latency Verification

Measure actual latency improvements:

```typescript
// Test from different locations
const testLatency = async (email: string, password: string) => {
  const start = performance.now();
  
  const response = await fetch(
    'https://api.example.com/functions/v1/regional-auth/sign-in',
    {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }
  );
  
  const latency = performance.now() - start;
  const region = response.headers.get('x-served-by-region');
  
  console.log(`Region: ${region}, Latency: ${latency}ms`);
};
```

## Rollback Procedure

If issues occur, rollback to previous version:

```bash
# List function versions
supabase functions versions list

# Revert to previous version for each region
for region in us-east eu-west ap-southeast; do
  export SUPABASE_URL=$(eval echo \$SUPABASE_URL_${region^^})
  export SUPABASE_SERVICE_ROLE_KEY=$(eval echo \$SUPABASE_SERVICE_ROLE_KEY_${region^^})
  
  supabase functions delete regional-auth-sign-up
  supabase functions delete regional-auth-sign-in
  supabase functions delete regional-auth-token-refresh
  supabase functions delete regional-health-check
  supabase functions delete regional-router
done

# Re-deploy previous versions from git
git checkout v0.x.x -- supabase/functions/
```

## Troubleshooting Deployment

### Functions Not Showing in Dashboard

1. Verify API token has correct permissions
2. Check function names match configuration
3. Review deployment logs: `supabase functions list --verbose`

### Health Checks Failing

1. Verify database migrations applied
2. Check JWT secret is consistent across regions
3. Review function logs in Supabase dashboard

### Routing Not Working

1. Verify router function deployed successfully
2. Check regional endpoint URLs in environment variables
3. Test router info endpoint: `curl https://api.example.com/router/auth?info=true`

### High Latency After Deployment

1. Verify regional deployments are complete
2. Check health of each region
3. Review function execution times in logs
4. Verify routing is sending to nearest region

## Maintenance

### Regular Health Checks

```bash
# Schedule daily health checks
0 */6 * * * curl -s https://api.example.com/functions/v1/regional-health-check | \
  jq -r 'if .allHealthy then "✓ All healthy" else "✗ Issues detected: \(.regions[] | select(.healthy==false) | .region)" end' | \
  mail -s "Regional Auth Health Report" ops@example.com
```

### Audit Log Cleanup

Archive old audit logs for compliance:

```sql
-- Archive logs older than 90 days
INSERT INTO auth_audit_logs_archive
SELECT * FROM auth_audit_logs
WHERE created_at < NOW() - INTERVAL '90 days';

DELETE FROM auth_audit_logs
WHERE created_at < NOW() - INTERVAL '90 days';
```

### Performance Monitoring

Set up alerts for slow requests:

```sql
-- Find slow auth operations
SELECT 
  region,
  AVG((details->>'responseTime')::numeric) as avg_latency,
  MAX((details->>'responseTime')::numeric) as max_latency
FROM auth_audit_logs
WHERE created_at > NOW() - INTERVAL '1 hour'
AND event_type IN ('signin', 'signup')
GROUP BY region
HAVING AVG((details->>'responseTime')::numeric) > 500;
```

## Documentation References

- [Cross-Region Auth Deployment](./cross-region-auth-deployment.md)
- [Integration Guide](./cross-region-auth-integration-guide.md)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Supabase CLI](https://supabase.com/docs/guides/cli)
