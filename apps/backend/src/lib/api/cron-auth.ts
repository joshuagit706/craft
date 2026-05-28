import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';

/**
 * Cron Job Request Signature Validation
 *
 * Validates that cron routes are only invoked by authorized schedulers
 * using a shared secret. Uses constant-time comparison to prevent
 * timing attacks on the secret.
 */

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Validates cron request signature using constant-time comparison.
 * Extracts the signature from the Authorization header as Bearer token.
 *
 * Returns true if valid, false otherwise.
 * Never logs the secret itself.
 */
function validateCronSignature(req: NextRequest): boolean {
  if (!CRON_SECRET) {
    return true;
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader) {
    return false;
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return false;
  }

  try {
    const expectedBuffer = Buffer.from(CRON_SECRET);
    const providedBuffer = Buffer.from(token);

    if (expectedBuffer.length !== providedBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, providedBuffer);
  } catch (err) {
    return false;
  }
}

/**
 * Middleware wrapper for cron routes.
 * Validates the cron secret and rejects unsigned/invalid requests with 401.
 *
 * Usage:
 *   export const GET = withCronAuth(async (req) => {
 *     return NextResponse.json({ status: 'ok' });
 *   });
 */
export function withCronAuth<TParams = {}>(
  handler: (
    req: NextRequest,
    ctx: { params: TParams }
  ) => Promise<NextResponse>
) {
  return async (req: NextRequest, ctx: { params: TParams }) => {
    if (!validateCronSignature(req)) {
      return NextResponse.json(
        { error: 'Unauthorized: invalid or missing cron signature' },
        { status: 401 }
      );
    }

    return handler(req, ctx);
  };
}
