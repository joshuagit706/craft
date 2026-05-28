/**
 * Regional Auth Utilities
 * 
 * Provides shared authentication utilities for cross-region auth edge functions.
 * Handles JWT token generation, validation, and region-aware session management.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface RegionalAuthContext {
  region: string;
  timestamp: number;
  requestId: string;
}

export interface AuthResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
  metadata?: {
    region: string;
    processingTime: number;
    requestId: string;
  };
}

/**
 * Get Supabase client for the specified region
 * Each region maintains its own database connection pool
 */
export function getRegionalSupabaseClient(region: string) {
  // Region URLs should be stored in environment variables
  const regionUrls: Record<string, { url: string; key: string }> = {
    'us-east': {
      url: Deno.env.get('SUPABASE_URL_US_EAST') || Deno.env.get('SUPABASE_URL'),
      key: Deno.env.get('SUPABASE_ANON_KEY_US_EAST') || Deno.env.get('SUPABASE_ANON_KEY'),
    },
    'eu-west': {
      url: Deno.env.get('SUPABASE_URL_EU_WEST') || Deno.env.get('SUPABASE_URL'),
      key: Deno.env.get('SUPABASE_ANON_KEY_EU_WEST') || Deno.env.get('SUPABASE_ANON_KEY'),
    },
    'ap-southeast': {
      url: Deno.env.get('SUPABASE_URL_AP_SOUTHEAST') || Deno.env.get('SUPABASE_URL'),
      key: Deno.env.get('SUPABASE_ANON_KEY_AP_SOUTHEAST') || Deno.env.get('SUPABASE_ANON_KEY'),
    },
  };

  const regionConfig = regionUrls[region] || regionUrls['us-east'];
  
  return createClient(regionConfig.url, regionConfig.key);
}

/**
 * Get the admin Supabase client for the region
 * Used for operations that require admin privileges (like profile creation)
 */
export function getRegionalSupabaseAdmin(region: string) {
  const regionUrls: Record<string, { url: string; key: string }> = {
    'us-east': {
      url: Deno.env.get('SUPABASE_URL_US_EAST') || Deno.env.get('SUPABASE_URL'),
      key: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY_US_EAST') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    },
    'eu-west': {
      url: Deno.env.get('SUPABASE_URL_EU_WEST') || Deno.env.get('SUPABASE_URL'),
      key: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY_EU_WEST') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    },
    'ap-southeast': {
      url: Deno.env.get('SUPABASE_URL_AP_SOUTHEAST') || Deno.env.get('SUPABASE_URL'),
      key: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY_AP_SOUTHEAST') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    },
  };

  const regionConfig = regionUrls[region] || regionUrls['us-east'];

  return createClient(regionConfig.url, regionConfig.key);
}

/**
 * Extract region from request headers or request origin
 */
export function detectRegionFromRequest(req: Request): string {
  const origin = req.headers.get('origin') || '';
  const cfCountry = req.headers.get('cf-ipcountry') || '';
  const region = req.headers.get('x-region-override');

  // If region is explicitly specified, use it
  if (region && ['us-east', 'eu-west', 'ap-southeast'].includes(region)) {
    return region;
  }

  // Detect region from country code
  if (cfCountry) {
    if (['GB', 'FR', 'DE', 'IE', 'NL', 'BE'].includes(cfCountry)) {
      return 'eu-west';
    }
    if (['SG', 'AU', 'JP', 'KR', 'IN'].includes(cfCountry)) {
      return 'ap-southeast';
    }
  }

  // Default to us-east
  return 'us-east';
}

/**
 * Create auth response metadata with region and timing info
 */
export function createAuthResponse<T>(
  success: boolean,
  context: RegionalAuthContext,
  data?: T,
  error?: { code: string; message: string }
): AuthResponse<T> {
  const startTime = context.timestamp;
  const processingTime = Date.now() - startTime;

  return {
    success,
    data,
    error,
    metadata: {
      region: context.region,
      processingTime,
      requestId: context.requestId,
    },
  };
}

/**
 * Verify JWT signature is valid for the region
 * Ensures tokens from one region can be validated in another
 */
export async function verifyRegionalJWT(
  token: string,
  region: string
): Promise<{ valid: boolean; payload?: Record<string, unknown>; error?: string }> {
  try {
    const admin = getRegionalSupabaseAdmin(region);
    const {
      data: { user },
      error,
    } = await admin.auth.getUser(token);

    if (error || !user) {
      return { valid: false, error: error?.message || 'Invalid token' };
    }

    return { valid: true, payload: { user_id: user.id, email: user.email } };
  } catch (error) {
    return { valid: false, error: String(error) };
  }
}

/**
 * Sync user profile across regions for state consistency
 * Called after successful auth operations in one region
 */
export async function syncUserProfileAcrossRegions(
  userId: string,
  email: string,
  sourceRegion: string,
  profile: Record<string, unknown>
): Promise<{ synced: boolean; errors: Record<string, string> }> {
  const regions = ['us-east', 'eu-west', 'ap-southeast'];
  const errors: Record<string, string> = {};

  for (const region of regions) {
    if (region === sourceRegion) continue; // Skip source region

    try {
      const admin = getRegionalSupabaseAdmin(region);

      // Check if profile exists
      const { data: existingProfile } = await admin
        .from('profiles')
        .select('id')
        .eq('id', userId)
        .single();

      if (!existingProfile) {
        // Create profile in this region
        const { error } = await admin.from('profiles').insert({
          id: userId,
          ...profile,
        });

        if (error) {
          errors[region] = error.message;
        }
      } else {
        // Update profile with latest data
        const { error } = await admin
          .from('profiles')
          .update(profile)
          .eq('id', userId);

        if (error) {
          errors[region] = error.message;
        }
      }
    } catch (error) {
      errors[region] = String(error);
    }
  }

  return { synced: Object.keys(errors).length === 0, errors };
}

/**
 * Log auth event for audit trail and monitoring
 */
export async function logAuthEvent(
  userId: string | null,
  eventType: 'signin' | 'signup' | 'refresh' | 'logout' | 'failure',
  region: string,
  requestId: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    const admin = getRegionalSupabaseAdmin(region);

    await admin.from('auth_audit_logs').insert({
      user_id: userId,
      event_type: eventType,
      region,
      request_id: requestId,
      details,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    // Log to console but don't fail the auth operation
    console.error(`Failed to log auth event: ${String(error)}`);
  }
}
