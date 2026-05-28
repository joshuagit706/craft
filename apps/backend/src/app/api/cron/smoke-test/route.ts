import { NextRequest, NextResponse } from 'next/server';
import { withCronAuth } from '@/lib/api/cron-auth';

interface SmokeResult {
    name: string;
    passed: boolean;
    status?: number;
    error?: string;
}

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:4001';

async function probe(name: string, path: string, init?: RequestInit): Promise<SmokeResult> {
    try {
        const res = await fetch(`${BASE_URL}${path}`, {
            ...init,
            signal: AbortSignal.timeout(10_000),
        });
        return { name, passed: res.ok || res.status === 401, status: res.status };
    } catch (err: any) {
        return { name, passed: false, error: err.message };
    }
}

/**
 * GET /api/cron/smoke-test
 *
 * Runs lightweight smoke checks against the running application and returns
 * a summary.  Intended to be called immediately after a production deployment
 * (e.g. via a Vercel deploy hook or post-deploy script).
 *
 * Protected by CRON_SECRET.  Returns 200 when all checks pass, 503 otherwise.
 */
async function handleSmokeTest(req: NextRequest) {
    const checks = await Promise.all([
        // Auth endpoints responsive
        probe('auth:signup-rejects-invalid', '/api/auth/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'bad', password: 'x' }),
        }),
        probe('auth:user-requires-auth', '/api/auth/user'),

        // Database connectivity
        probe('db:templates-list', '/api/templates'),

        // External service integrations
        probe('stripe:checkout-requires-auth', '/api/payments/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ priceId: 'price_smoke' }),
        }),
        probe('stripe:subscription-requires-auth', '/api/payments/subscription'),
    ]);

    const failed = checks.filter((c) => !c.passed);
    const allPassed = failed.length === 0;

    const body = {
        passed: allPassed,
        total: checks.length,
        failedCount: failed.length,
        results: checks,
        timestamp: new Date().toISOString(),
    };

    if (!allPassed) {
        console.error('Smoke tests FAILED:', JSON.stringify(failed, null, 2));
    }

    return NextResponse.json(body, { status: allPassed ? 200 : 503 });
}

export const GET = withCronAuth(handleSmokeTest);
