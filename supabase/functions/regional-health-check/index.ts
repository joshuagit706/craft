/**
 * Regional Health Check Edge Function
 * 
 * Monitors regional Supabase instances and provides health status.
 * Used by client SDKs to determine which regions are healthy
 * and to implement intelligent failover routing.
 */

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import {
  getRegionalSupabaseClient,
  type RegionalAuthContext,
} from './regional-auth/auth-utils.ts';

interface RegionHealthStatus {
  region: string;
  healthy: boolean;
  responseTime: number;
  timestamp: string;
  details?: {
    database: boolean;
    auth: boolean;
    error?: string;
  };
}

interface HealthCheckResponse {
  timestamp: string;
  regions: RegionHealthStatus[];
  healthyRegions: string[];
  allHealthy: boolean;
}

/**
 * Check health of a specific region
 */
async function checkRegionHealth(region: string): Promise<RegionHealthStatus> {
  const startTime = Date.now();

  try {
    const supabase = getRegionalSupabaseClient(region);

    // Test 1: Database connectivity by querying auth schema
    const { data, error } = await supabase
      .from('profiles')
      .select('count', { count: 'exact', head: true });

    const dbHealthy = !error;

    // Test 2: Auth service connectivity
    let authHealthy = true;
    try {
      // Try to check auth connection without actual authentication
      const { error: authError } = await supabase.auth.getSession();
      authHealthy = authError === null;
    } catch {
      authHealthy = false;
    }

    const responseTime = Date.now() - startTime;
    const healthy = dbHealthy && authHealthy;

    return {
      region,
      healthy,
      responseTime,
      timestamp: new Date().toISOString(),
      details: {
        database: dbHealthy,
        auth: authHealthy,
        error: !healthy ? `DB: ${dbHealthy}, Auth: ${authHealthy}` : undefined,
      },
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;

    return {
      region,
      healthy: false,
      responseTime,
      timestamp: new Date().toISOString(),
      details: {
        database: false,
        auth: false,
        error: String(error),
      },
    };
  }
}

/**
 * Check health of all regions in parallel
 */
async function checkAllRegionsHealth(): Promise<RegionHealthStatus[]> {
  const regions = ['us-east', 'eu-west', 'ap-southeast'];

  // Check all regions in parallel for faster response
  const healthChecks = await Promise.all(
    regions.map((region) => checkRegionHealth(region))
  );

  return healthChecks;
}

/**
 * Health check handler
 */
async function handleHealthCheck(req: Request): Promise<Response> {
  try {
    // Get query parameters
    const url = new URL(req.url);
    const region = url.searchParams.get('region');
    const detailed = url.searchParams.get('detailed') === 'true';

    let regionStatuses: RegionHealthStatus[];

    if (region && ['us-east', 'eu-west', 'ap-southeast'].includes(region)) {
      // Check specific region
      const status = await checkRegionHealth(region);
      regionStatuses = [status];
    } else {
      // Check all regions
      regionStatuses = await checkAllRegionsHealth();
    }

    const healthyRegions = regionStatuses
      .filter((r) => r.healthy)
      .map((r) => r.region);

    const response: HealthCheckResponse = {
      timestamp: new Date().toISOString(),
      regions: detailed ? regionStatuses : regionStatuses.map(({ region, healthy, responseTime }) => ({ region, healthy, responseTime, timestamp: new Date().toISOString() })),
      healthyRegions,
      allHealthy: healthyRegions.length === regionStatuses.length,
    };

    const status = healthyRegions.length > 0 ? 200 : 503;

    return new Response(JSON.stringify(response), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Health check error:', error);

    return new Response(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        regions: [],
        healthyRegions: [],
        allHealthy: false,
        error: 'Health check failed',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Handle OPTIONS requests for CORS
 */
function handleOptions(req: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

/**
 * Main edge function handler
 */
serve(async (req: Request) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return handleOptions(req);
  }

  // Only accept GET requests
  if (req.method !== 'GET') {
    return new Response(
      JSON.stringify({
        error: 'Only GET requests are allowed',
      }),
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const response = await handleHealthCheck(req);

  // Add CORS headers
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Cache-Control', 'no-cache, max-age=10');

  return response;
});
