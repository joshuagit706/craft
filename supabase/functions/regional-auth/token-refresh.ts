/**
 * Regional Token Refresh Edge Function
 * 
 * Handles JWT token refresh with cross-region state verification.
 * Ensures refresh tokens are valid across regions and generates
 * new access tokens without requiring re-authentication.
 */

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import {
  getRegionalSupabaseClient,
  detectRegionFromRequest,
  createAuthResponse,
  logAuthEvent,
  verifyRegionalJWT,
  type RegionalAuthContext,
} from './auth-utils.ts';

interface RefreshRequest {
  refreshToken: string;
  region?: string;
}

interface RefreshResponse {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  region: string;
}

/**
 * Generate request ID for tracing
 */
function generateRequestId(): string {
  return `auth-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Refresh token in a specific region
 */
async function refreshTokenInRegion(
  region: string,
  refreshToken: string
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const supabase = getRegionalSupabaseClient(region);

    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    if (!data.session || !data.user) {
      return { success: false, error: 'No session created' };
    }

    return {
      success: true,
      data: {
        user: data.user,
        session: data.session,
      },
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Refresh token with fallback to other regions
 */
async function refreshTokenWithFallback(
  refreshToken: string,
  primaryRegion: string
): Promise<{ success: boolean; data?: any; region?: string; error?: string }> {
  const allRegions = ['us-east', 'eu-west', 'ap-southeast'];

  // Reorder regions to try primary first
  const regionsInOrder = [
    primaryRegion,
    ...allRegions.filter((r) => r !== primaryRegion),
  ];

  for (const region of regionsInOrder) {
    try {
      const result = await refreshTokenInRegion(region, refreshToken);

      if (result.success) {
        return {
          success: true,
          data: result.data,
          region,
        };
      }

      // If token not found or invalid, continue to next region
      if (
        result.error?.includes('Invalid Refresh Token') ||
        result.error?.includes('Token expired')
      ) {
        continue;
      }
    } catch (error) {
      console.warn(`Token refresh attempt failed in region ${region}:`, error);
      continue;
    }
  }

  return {
    success: false,
    error: 'Token refresh failed in all regions. Refresh token may be invalid or expired.',
  };
}

/**
 * Token refresh handler
 */
async function handleRefresh(req: Request): Promise<Response> {
  const requestId = generateRequestId();
  const startTime = Date.now();

  try {
    // Detect user's region from request
    const detectedRegion = detectRegionFromRequest(req);

    const context: RegionalAuthContext = {
      region: detectedRegion,
      timestamp: startTime,
      requestId,
    };

    // Parse request body
    let body: RefreshRequest;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify(
          createAuthResponse(false, context, undefined, {
            code: 'INVALID_REQUEST',
            message: 'Invalid JSON in request body',
          })
        ),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Validate input
    if (!body.refreshToken) {
      return new Response(
        JSON.stringify(
          createAuthResponse(false, context, undefined, {
            code: 'MISSING_FIELDS',
            message: 'Refresh token is required',
          })
        ),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Attempt token refresh with regional fallback
    const refreshResult = await refreshTokenWithFallback(
      body.refreshToken,
      body.region || detectedRegion
    );

    if (!refreshResult.success) {
      await logAuthEvent(null, 'failure', detectedRegion, requestId, {
        reason: refreshResult.error,
        type: 'token_refresh',
      });

      return new Response(
        JSON.stringify(
          createAuthResponse(false, context, undefined, {
            code: 'REFRESH_FAILED',
            message: refreshResult.error || 'Token refresh failed',
          })
        ),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { user, session } = refreshResult.data;
    const refreshRegion = refreshResult.region || detectedRegion;

    // Update context with actual refresh region
    context.region = refreshRegion;

    // Verify new token is valid
    const tokenVerification = await verifyRegionalJWT(session.access_token, refreshRegion);

    if (!tokenVerification.valid) {
      await logAuthEvent(user.id, 'failure', refreshRegion, requestId, {
        reason: 'New token verification failed',
      });

      return new Response(
        JSON.stringify(
          createAuthResponse(false, context, undefined, {
            code: 'TOKEN_ERROR',
            message: 'Failed to verify new authentication token',
          })
        ),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Log successful token refresh
    await logAuthEvent(user.id, 'refresh', refreshRegion, requestId, {
      userId: user.id,
    });

    const responseData: RefreshResponse = {
      userId: user.id,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresIn: session.expires_in,
      region: refreshRegion,
    };

    return new Response(
      JSON.stringify(createAuthResponse(true, context, responseData)),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Token refresh error:', error);

    const context: RegionalAuthContext = {
      region: 'unknown',
      timestamp: startTime,
      requestId,
    };

    return new Response(
      JSON.stringify(
        createAuthResponse(false, context, undefined, {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        })
      ),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Handle OPTIONS requests for CORS
 */
function handleOptions(req: Request): Response {
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    ...(Deno.env.get('ALLOWED_ORIGINS')?.split(',') || []),
  ];

  const origin = req.headers.get('origin') || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true',
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

  // Only accept POST requests
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'Only POST requests are allowed',
        },
      }),
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Add CORS headers to all responses
  const corsHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': req.headers.get('origin') || '*',
  };

  const response = await handleRefresh(req);

  // Add CORS headers to response
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }

  return response;
});
