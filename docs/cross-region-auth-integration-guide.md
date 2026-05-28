# Cross-Region Auth Integration Guide

## Quick Start

### 1. Using the Regional Router (Recommended)

The Regional Router automatically detects your location and routes to the nearest region.

#### Client-Side

```typescript
// Initialize with router endpoint
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://api.example.com', // Your API base URL
  'YOUR_ANON_KEY'
);

// Sign up - automatically routes to nearest region
const { data, error } = await supabase.auth.signUp({
  email: 'user@example.com',
  password: 'SecurePassword123',
});

if (error) console.error('Signup failed:', error.message);
else console.log('User created:', data.user?.id);

// Sign in - automatically routes to nearest region
const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
  email: 'user@example.com',
  password: 'SecurePassword123',
});

if (signInError) console.error('Signin failed:', signInError.message);
else console.log('Logged in as:', signInData.user?.email);

// Token refresh - automatically routes to nearest region
const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession({
  refresh_token: currentRefreshToken,
});

if (refreshError) console.error('Refresh failed:', refreshError.message);
else console.log('Token refreshed');
```

### 2. Direct Regional Endpoints

For server-side operations or when you need explicit region control:

```typescript
// Specify region explicitly
const makeAuthRequest = async (endpoint: string, body: any, region?: string) => {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (region) {
    headers['x-region-override'] = region;
  }

  const response = await fetch(
    `https://api.example.com/functions/v1/regional-auth${endpoint}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }
  );

  return response.json();
};

// Sign up with explicit region
const signUpResult = await makeAuthRequest('/sign-up', {
  email: 'user@example.com',
  password: 'SecurePassword123',
  metadata: {
    firstName: 'John',
    lastName: 'Doe',
  },
}, 'eu-west');

// Sign in with automatic fallback (omit region parameter)
const signInResult = await makeAuthRequest('/sign-in', {
  email: 'user@example.com',
  password: 'SecurePassword123',
});

// Token refresh
const refreshResult = await makeAuthRequest('/token-refresh', {
  refreshToken: 'your_refresh_token_here',
});
```

## Advanced Usage

### Region Detection

The system automatically detects your region using:

1. **Cloudflare Headers** (if behind Cloudflare)
   - `cf-ipcountry`: Your country code
   - Automatically mapped to nearest region

2. **Timezone Header**
   - `x-timezone`: Your timezone (e.g., `Europe/London`)
   - Used as fallback for region detection

3. **Explicit Override**
   - `x-region-override`: Force specific region
   - Useful for testing or specific requirements

### Check Regional Health

Monitor which regions are healthy:

```typescript
const checkHealth = async (detailed = false) => {
  const url = new URL('https://api.example.com/functions/v1/regional-health-check');
  
  if (detailed) {
    url.searchParams.set('detailed', 'true');
  }

  const response = await fetch(url.toString());
  return response.json();
};

// Check all regions
const health = await checkHealth(true);
console.log('Healthy regions:', health.healthyRegions);
console.log('All healthy:', health.allHealthy);

health.regions.forEach(region => {
  console.log(`${region.region}: ${region.responseTime}ms`);
});
```

### Get Routing Decision

See which region you'll be routed to without making the actual request:

```typescript
const getRoutingInfo = async () => {
  const response = await fetch(
    'https://api.example.com/router/auth?info=true'
  );
  return response.json();
};

const decision = await getRoutingInfo();
console.log('Target region:', decision.targetRegion);
console.log('Reason:', decision.reason);
console.log('Response time:', decision.endpoints[0].responseTime);
```

### Request Tracing

Every auth request returns headers with routing information:

```typescript
const makeAuthRequest = async (email: string, password: string) => {
  const response = await fetch(
    'https://api.example.com/functions/v1/regional-auth/sign-in',
    {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }
  );

  // Extract routing information
  const servedBy = response.headers.get('x-served-by-region');
  const routingMetadata = response.headers.get('x-routing-metadata');

  console.log('Served by region:', servedBy);
  console.log('Routing details:', JSON.parse(routingMetadata || '{}'));

  return response.json();
};
```

## Error Handling

### Handle Region Failover

The system automatically fails over, but you should handle the response metadata:

```typescript
const authenticateWithFallback = async (email: string, password: string) => {
  try {
    const response = await fetch(
      'https://api.example.com/functions/v1/regional-auth/sign-in',
      {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }
    );

    const data = await response.json();

    if (data.success) {
      // Check which region handled the request
      const region = data.metadata?.region;
      console.log(`Authenticated via ${region} region`);
      return data.data;
    } else {
      // Handle auth failure
      console.error('Auth failed:', data.error?.message);
      throw new Error(data.error?.message);
    }
  } catch (error) {
    console.error('Auth request failed:', error);
    throw error;
  }
};
```

### Handle Token Refresh Failures

Token refresh might fail if refresh token is invalid or expired:

```typescript
const refreshTokenSafely = async (refreshToken: string) => {
  try {
    const response = await fetch(
      'https://api.example.com/functions/v1/regional-auth/token-refresh',
      {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
      }
    );

    const data = await response.json();

    if (data.success) {
      return data.data;
    } else {
      // Refresh failed - user needs to sign in again
      if (data.error?.code === 'REFRESH_FAILED') {
        console.log('Session expired, please sign in again');
        // Clear local auth state
        // Redirect to login page
      }
      throw new Error(data.error?.message);
    }
  } catch (error) {
    console.error('Token refresh error:', error);
    throw error;
  }
};
```

## Best Practices

### 1. Cache Health Status

Don't call health check on every request:

```typescript
class RegionalAuthClient {
  private healthCache: Map<string, { status: any; timestamp: number }> = new Map();
  private CACHE_TTL = 30000; // 30 seconds

  async getHealthStatus() {
    const cached = this.healthCache.get('health');
    const now = Date.now();

    if (cached && now - cached.timestamp < this.CACHE_TTL) {
      return cached.status;
    }

    const response = await fetch(
      'https://api.example.com/functions/v1/regional-health-check'
    );
    const status = await response.json();

    this.healthCache.set('health', { status, timestamp: now });
    return status;
  }
}
```

### 2. Implement Request Retry Logic

Retry transient failures with exponential backoff:

```typescript
async function retryableAuth(
  email: string,
  password: string,
  maxRetries = 3
) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(
        'https://api.example.com/functions/v1/regional-auth/sign-in',
        {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        }
      );

      if (response.ok) {
        return response.json();
      }

      // Retry on 5xx or timeout
      if (response.status >= 500) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Don't retry on 4xx (client errors)
      throw new Error(`Auth failed: ${response.statusText}`);
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;

      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
```

### 3. Monitor Request Latency

Track auth latency to identify issues:

```typescript
class LatencyMonitor {
  private metrics: number[] = [];

  async recordAuthLatency() {
    const start = performance.now();

    try {
      const response = await fetch(
        'https://api.example.com/functions/v1/regional-health-check'
      );
      const latency = performance.now() - start;

      this.metrics.push(latency);

      // Log high latency
      if (latency > 500) {
        console.warn(`High auth latency: ${latency.toFixed(2)}ms`);
      }

      return latency;
    } catch (error) {
      console.error('Latency measurement failed:', error);
      throw error;
    }
  }

  getAverageLatency() {
    if (this.metrics.length === 0) return 0;
    const sum = this.metrics.reduce((a, b) => a + b, 0);
    return sum / this.metrics.length;
  }
}
```

### 4. Handle CORS Properly

Ensure CORS is configured correctly on the client:

```typescript
// Add CORS headers to requests
const makeRequest = async (endpoint: string, body: any) => {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // CORS headers are sent automatically
    },
    body: JSON.stringify(body),
    credentials: 'include', // Include credentials if needed
  });
};
```

## Testing the Cross-Region Setup

### Test Regional Routing

```bash
# Check health of all regions
curl https://api.example.com/functions/v1/regional-health-check

# Check specific region
curl 'https://api.example.com/functions/v1/regional-health-check?region=eu-west'

# Get detailed health info
curl 'https://api.example.com/functions/v1/regional-health-check?detailed=true'
```

### Test Explicit Region Override

```bash
# Force routing to EU region
curl https://api.example.com/functions/v1/regional-auth/sign-in \
  -H "Content-Type: application/json" \
  -H "x-region-override: eu-west" \
  -d '{"email": "user@example.com", "password": "password123"}'

# Force routing to AP region
curl https://api.example.com/functions/v1/regional-auth/sign-in \
  -H "Content-Type: application/json" \
  -H "x-region-override: ap-southeast" \
  -d '{"email": "user@example.com", "password": "password123"}'
```

### Test Failover

```typescript
// Simulate region failure by checking that fallback works
const testFailover = async () => {
  // Make request without specifying region
  const response = await fetch(
    'https://api.example.com/functions/v1/regional-auth/sign-in',
    {
      method: 'POST',
      body: JSON.stringify({
        email: 'test@example.com',
        password: 'password123',
      }),
    }
  );

  const data = await response.json();
  const region = data.metadata?.region;

  console.log(`Request handled by: ${region}`);
  console.log(`Processing time: ${data.metadata?.processingTime}ms`);
};
```

## Troubleshooting

### All Regions Returning 502

1. Check if edge functions are deployed
2. Verify environment variables are set
3. Check Supabase service status
4. Review function logs

### Users in Specific Region Experiencing Failures

1. Check regional health: `curl https://api.example.com/functions/v1/regional-health-check`
2. Verify that region is showing as healthy
3. Check if region-specific configuration is missing
4. Review regional logs for errors

### Slow Authentication

1. Check latency by region: `curl https://api.example.com/functions/v1/regional-health-check?detailed=true`
2. Verify routing decision: Check `x-served-by-region` response header
3. Monitor network connectivity between regions
4. Check database query performance

## Support

For issues or questions:
1. Check [Cross-Region Auth Deployment Documentation](./cross-region-auth-deployment.md)
2. Review edge function logs in Supabase dashboard
3. Check audit logs: `SELECT * FROM auth_audit_logs WHERE user_id = 'your-user-id'`
4. Monitor health checks regularly
