# Supabase Edge Functions

This directory contains Supabase Edge Functions for the CRAFT platform, including cross-region authentication services, health checks, and intelligent routing.

## Directory Structure

```
functions/
├── import_map.json                          # Deno import mappings
├── regional-auth/                           # Regional authentication services
│   ├── auth-utils.ts                       # Shared auth utilities
│   ├── sign-up.ts                          # User registration edge function
│   ├── sign-in.ts                          # User authentication edge function
│   ├── token-refresh.ts                    # Token refresh edge function
│   ├── consistency-validators.ts           # State consistency checking
│   └── regional-auth.test.ts              # Auth function tests
├── regional-health-check/                  # Regional health monitoring
│   ├── index.ts                            # Health check edge function
│   └── health-check.test.ts               # Health check tests
└── regional-router/                        # Intelligent request routing
    └── index.ts                            # Regional router edge function
```

## Edge Functions

### Regional Auth Functions

#### Sign-Up (`regional-auth/sign-up.ts`)

Creates new user accounts with cross-region state synchronization.

**Endpoint**: `POST /functions/v1/regional-auth-sign-up`

**Request**:
```json
{
  "email": "user@example.com",
  "password": "SecurePassword123",
  "metadata": {
    "firstName": "John",
    "lastName": "Doe"
  }
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "userId": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "createdAt": "2026-05-28T10:30:00Z"
  },
  "metadata": {
    "region": "us-east",
    "processingTime": 145,
    "requestId": "auth-1716883800000-abc123"
  }
}
```

**Features**:
- Email validation
- Password strength validation
- Cross-region profile synchronization
- Subscription tier assignment (default: free)
- Audit logging

#### Sign-In (`regional-auth/sign-in.ts`)

Authenticates users with automatic region detection and failover.

**Endpoint**: `POST /functions/v1/regional-auth-sign-in`

**Request**:
```json
{
  "email": "user@example.com",
  "password": "SecurePassword123",
  "region": "eu-west"  // Optional: override detected region
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "userId": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "refresh_token_xyz789...",
    "expiresIn": 3600,
    "region": "us-east"
  },
  "metadata": {
    "region": "us-east",
    "processingTime": 92,
    "requestId": "auth-1716883800000-def456"
  }
}
```

**Features**:
- Automatic region detection from request headers
- Regional failover support
- JWT token validation
- Cross-region authentication
- Detailed error reporting

#### Token Refresh (`regional-auth/token-refresh.ts`)

Refreshes expired access tokens with cross-region support.

**Endpoint**: `POST /functions/v1/regional-auth-token-refresh`

**Request**:
```json
{
  "refreshToken": "refresh_token_xyz789...",
  "region": "eu-west"  // Optional
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "userId": "550e8400-e29b-41d4-a716-446655440000",
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "new_refresh_token...",
    "expiresIn": 3600,
    "region": "us-east"
  },
  "metadata": {
    "region": "us-east",
    "processingTime": 78,
    "requestId": "auth-1716883800000-ghi789"
  }
}
```

**Features**:
- Token refresh with validation
- Regional failover for refresh tokens
- New JWT token generation
- Token consistency verification

### Health Check (`regional-health-check/index.ts`)

Monitors regional Supabase instance health and availability.

**Endpoint**: `GET /functions/v1/regional-health-check`

**Query Parameters**:
- `region`: Check specific region (us-east, eu-west, ap-southeast)
- `detailed`: Include detailed health information (true/false)

**Response** (all regions healthy):
```json
{
  "timestamp": "2026-05-28T10:30:00Z",
  "regions": [
    {
      "region": "us-east",
      "healthy": true,
      "responseTime": 45,
      "details": {
        "database": true,
        "auth": true
      }
    },
    {
      "region": "eu-west",
      "healthy": true,
      "responseTime": 73,
      "details": {
        "database": true,
        "auth": true
      }
    },
    {
      "region": "ap-southeast",
      "healthy": true,
      "responseTime": 82,
      "details": {
        "database": true,
        "auth": true
      }
    }
  ],
  "healthyRegions": ["us-east", "eu-west", "ap-southeast"],
  "allHealthy": true
}
```

**Features**:
- Database connectivity monitoring
- Auth service health checks
- Response time metrics
- Per-region or aggregate health status
- 10-second cache for performance

### Regional Router (`regional-router/index.ts`)

Intelligently routes auth requests to the nearest healthy region.

**Endpoint**: `POST /router/auth/{operation}`

**Operations**:
- `/router/auth/sign-in`
- `/router/auth/sign-up`
- `/router/auth/token-refresh`
- `/router/auth?info=true` (get routing decision without forwarding)

**Request Headers**:
- `cf-ipcountry`: Cloudflare country code (auto-detected)
- `x-timezone`: User timezone (fallback detection)
- `x-region-override`: Force specific region (us-east, eu-west, ap-southeast)

**Response Headers**:
- `x-served-by-region`: Region that handled the request
- `x-routing-metadata`: JSON with routing decision details

**Features**:
- Automatic region detection from IP/headers
- Health-based routing
- Latency optimization
- Failover to secondary regions
- Transparent request forwarding

## Shared Utilities

### Auth Utils (`regional-auth/auth-utils.ts`)

Provides shared utilities for all auth operations:

```typescript
// Get regional Supabase client
getRegionalSupabaseClient(region: string): SupabaseClient

// Get admin client for privileged operations
getRegionalSupabaseAdmin(region: string): SupabaseClient

// Detect region from request
detectRegionFromRequest(req: Request): string

// Create standardized response
createAuthResponse<T>(success: boolean, context: RegionalAuthContext, data?: T): AuthResponse<T>

// Verify JWT across regions
verifyRegionalJWT(token: string, region: string): Promise<TokenVerification>

// Sync profile across regions
syncUserProfileAcrossRegions(userId: string, sourceRegion: string): Promise<SyncResult>

// Log audit event
logAuthEvent(userId: string | null, eventType: string, region: string, requestId: string): Promise<void>
```

### Consistency Validators (`regional-auth/consistency-validators.ts`)

Ensures auth state consistency across regions:

```typescript
// Check if user profiles are consistent
validateUserStateConsistency(userId: string): Promise<ConsistencyCheckResult>

// Check if tokens are valid in all regions
validateTokenConsistency(userId: string, token: string): Promise<TokenValidation>

// Sync user profile to all regions
syncUserProfileToAllRegions(userId: string, sourceRegion: string): Promise<SyncResult>

// Repair inconsistent state
repairUserStateConsistency(userId: string, authorityRegion?: string): Promise<RepairResult>

// Validate audit log consistency
validateAuditLogConsistency(userId: string, timeWindowMinutes?: number): Promise<AuditValidation>
```

## Configuration

### Environment Variables

Each edge function requires these environment variables (set per-region):

```bash
# Regional Supabase URLs
SUPABASE_URL_US_EAST=https://project-us-east.supabase.co
SUPABASE_URL_EU_WEST=https://project-eu-west.supabase.co
SUPABASE_URL_AP_SOUTHEAST=https://project-ap-southeast.supabase.co

# Anon keys
SUPABASE_ANON_KEY_US_EAST=...
SUPABASE_ANON_KEY_EU_WEST=...
SUPABASE_ANON_KEY_AP_SOUTHEAST=...

# Service role keys
SUPABASE_SERVICE_ROLE_KEY_US_EAST=...
SUPABASE_SERVICE_ROLE_KEY_EU_WEST=...
SUPABASE_SERVICE_ROLE_KEY_AP_SOUTHEAST=...

# Edge function URLs for routing
EDGE_FUNCTION_URL_US_EAST=https://project-us-east.functions.supabase.co
EDGE_FUNCTION_URL_EU_WEST=https://project-eu-west.functions.supabase.co
EDGE_FUNCTION_URL_AP_SOUTHEAST=https://project-ap-southeast.functions.supabase.co

# CORS configuration
ALLOWED_ORIGINS=https://app.example.com,https://staging.example.com
```

### Database Schema

New table `auth_audit_logs` for cross-region audit trail:

```sql
CREATE TABLE auth_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,  -- signin, signup, refresh, logout, failure
  region TEXT NOT NULL,       -- us-east, eu-west, ap-southeast
  request_id TEXT UNIQUE NOT NULL,
  details JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## Testing

### Unit Tests

```bash
# Run all tests
npm test -- supabase/functions

# Run specific test suite
npm test -- supabase/functions/regional-auth/regional-auth.test.ts
npm test -- supabase/functions/regional-health-check/health-check.test.ts
```

### Manual Testing

```bash
# Check health of all regions
curl https://api.example.com/functions/v1/regional-health-check | jq

# Test sign-up
curl https://api.example.com/functions/v1/regional-auth-sign-up \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "Test123"}'

# Test sign-in
curl https://api.example.com/functions/v1/regional-auth-sign-in \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "Test123"}'

# Force routing to specific region
curl https://api.example.com/functions/v1/regional-auth-sign-in \
  -H "x-region-override: eu-west" \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "Test123"}'
```

## Deployment

See [Cross-Region Deployment Guide](../docs/cross-region-deployment-guide.md) for detailed deployment instructions.

## Monitoring

### Health Checks

Regularly monitor edge function health:

```bash
# Check all regions
watch -n 10 'curl -s https://api.example.com/functions/v1/regional-health-check | jq'
```

### Audit Logs

Query auth events for analysis:

```sql
SELECT * FROM auth_audit_logs
WHERE created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;
```

### Performance Metrics

Track response times and latency by region:

```sql
SELECT 
  region,
  event_type,
  COUNT(*) as count,
  AVG((details->>'processingTime')::numeric) as avg_time,
  MAX((details->>'processingTime')::numeric) as max_time
FROM auth_audit_logs
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY region, event_type;
```

## Troubleshooting

See [Cross-Region Auth Deployment](../docs/cross-region-auth-deployment.md#troubleshooting) for troubleshooting guide.

## Related Documentation

- [Cross-Region Auth Deployment](../docs/cross-region-auth-deployment.md)
- [Integration Guide](../docs/cross-region-auth-integration-guide.md)
- [Deployment Guide](../docs/cross-region-deployment-guide.md)
- [Supabase Edge Functions Docs](https://supabase.com/docs/guides/functions)
