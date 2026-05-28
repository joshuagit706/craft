/**
 * Regional Sign-In Edge Function
 * 
 * Handles user authentication with automatic region detection.
 * Routes authentication to the nearest region and validates
 * credentials across regional boundaries with fallback support.
 */

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import {
  getRegionalSupabaseClient,
  detectRegionFromRequest,
  createAuthResponse,
  logAuthEvent,
  verifyRegionalJWT,
  type RegionalAuthContext,
  type AuthResponse,
} from './auth-utils.ts';

interface SignInRequest {
  email: string;
  password: string;
  region?: string;
}

interface SignInResponse {
  userId: string;
  email: string;
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
 * Try sign-in in a specific region
 */
async function signInInRegion(
  region: string,
  email: string,
  password: string
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const supabase = getRegionalSupabaseClient(region);

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    if (!data.user || !data.session) {
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
 * Try sign-in with fallback to other regions
 * Returns successful login or tries next region
 */
async function signInWithRegionalFallback(
  email: string,
  password: string,
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
      const result = await signInInRegion(region, email, password);

      if (result.success) {
        return {
          success: true,
          data: result.data,
          region,
        };
      }

      // If user not found in this region, continue to next
      if (result.error?.includes('Invalid login credentials')) {
        continue;
      }
    } catch (error) {
      console.warn(`Sign-in attempt failed in region ${region}:`, error);
      continue;
    }
  }

  return {
    success: false,
    error: 'Authentication failed in all regions. Invalid credentials.',
  };
}

/**
 * Sign-in handler
 */
async function handleSignIn(req: Request): Promise<Response> {
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
    let body: SignInRequest;
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
    if (!body.email || !body.password) {
      await logAuthEvent(null, 'failure', detectedRegion, requestId, {
        reason: 'Missing email or password',
      });

      return new Response(
        JSON.stringify(
          createAuthResponse(false, context, undefined, {
            code: 'MISSING_FIELDS',
            message: 'Email and password are required',
          })
        ),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Attempt sign-in with regional fallback
    const signInResult = await signInWithRegionalFallback(
      body.email,
      body.password,
      body.region || detectedRegion
    );

    if (!signInResult.success) {
      await logAuthEvent(null, 'failure', detectedRegion, requestId, {
        reason: signInResult.error,
        email: body.email,
      });

      return new Response(
        JSON.stringify(
          createAuthResponse(false, context, undefined, {
            code: 'AUTH_FAILED',
            message: signInResult.error || 'Authentication failed',
          })
        ),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { user, session } = signInResult.data;
    const signinRegion = signInResult.region || detectedRegion;

    // Update context with actual signin region
    context.region = signinRegion;

    // Verify token is valid
    const tokenVerification = await verifyRegionalJWT(session.access_token, signinRegion);

    if (!tokenVerification.valid) {
      await logAuthEvent(user.id, 'failure', signinRegion, requestId, {
        reason: 'Token verification failed',
      });

      return new Response(
        JSON.stringify(
          createAuthResponse(false, context, undefined, {
            code: 'TOKEN_ERROR',
            message: 'Failed to verify authentication token',
          })
        ),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Log successful signin
    await logAuthEvent(user.id, 'signin', signinRegion, requestId, {
      email: user.email,
    });

    const responseData: SignInResponse = {
      userId: user.id,
      email: user.email || body.email,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresIn: session.expires_in,
      region: signinRegion,
    };

    return new Response(
      JSON.stringify(createAuthResponse(true, context, responseData)),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Sign-in error:', error);

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

  const response = await handleSignIn(req);

  // Add CORS headers to response
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }

  return response;
});
