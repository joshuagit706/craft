/**
 * Usage Tracking Middleware
 * 
 * Tracks API usage for metered billing.
 * Records operations like API calls, deployments, domain configs, etc.
 */

import { NextRequest, NextResponse } from 'next/server';
import { meterService } from '@/services/metered-billing.service';
import type { User } from '@supabase/supabase-js';

export type UsageTrackedRouteContext = {
  operationType: string;
  quantity?: number;
  metadata?: Record<string, unknown>;
};

/**
 * Determine operation type from route
 */
export function detectOperationType(pathname: string): string {
  if (pathname.includes('/deployments') && pathname.includes('/preview')) {
    return 'deployment_preview';
  }
  if (pathname.includes('/deployments') && pathname.includes('POST')) {
    return 'deployment_create';
  }
  if (pathname.includes('/deployments') && pathname.includes('PUT')) {
    return 'deployment_update';
  }
  if (pathname.includes('/https') || pathname.includes('/dns')) {
    return 'domain_config';
  }
  if (pathname.includes('/templates') && pathname.includes('/clone')) {
    return 'template_clone';
  }
  if (pathname.includes('/custom-domain')) {
    return 'custom_domain';
  }
  if (pathname.includes('/github')) {
    return 'github_sync';
  }
  // Default: generic API call
  return 'api_call';
}

/**
 * Middleware to track API usage for metered billing
 */
export async function withUsageTracking<TParams = {}>(
  handler: (
    req: NextRequest,
    ctx: { user: User; params: TParams; operationType: string }
  ) => Promise<NextResponse>,
  operationType?: string
) {
  return async (req: NextRequest, { params }: { params: TParams }) => {
    // This middleware requires withAuth to be applied first
    // to have the user available in the context
    // See: apps/backend/src/lib/api/with-auth.ts

    const opType = operationType || detectOperationType(req.nextUrl.pathname);

    try {
      const response = await handler(req, { user: {} as any, params, operationType: opType });

      // Track usage after successful response
      // This requires user context - would be injected by withAuth
      // TODO: Extract user from session/JWT and track usage
      // For now, this is a placeholder for the full implementation

      return response;
    } catch (error) {
      throw error;
    }
  };
}

/**
 * Standalone function to track usage
 * Can be called from within route handlers
 */
export async function trackUsage(
  userId: string,
  operationType: string,
  quantity: number = 1,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await meterService.recordUsage(userId, operationType, quantity, metadata);
  } catch (error) {
    // Log but don't fail the request if usage tracking fails
    console.error(`Failed to track usage for ${operationType}:`, error);
  }
}

/**
 * Standalone function to report pending usage to Stripe
 */
export async function reportPendingUsage(userId: string): Promise<void> {
  try {
    const result = await meterService.reportPendingUsageToStripe(userId);

    if (result.failed > 0) {
      console.warn(
        `Failed to report ${result.failed} usage records for user ${userId}:`,
        result.errors
      );
    }

    if (result.reported > 0) {
      console.log(
        `Successfully reported ${result.reported} usage records for user ${userId}`
      );
    }
  } catch (error) {
    console.error(`Failed to report pending usage for user ${userId}:`, error);
  }
}
