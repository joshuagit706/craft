import { NextRequest, NextResponse } from 'next/server';
import { analyticsService } from '@/services/analytics.service';
import { withCronAuth } from '@/lib/api/cron-auth';

/**
 * Cron: purge old deployment_analytics rows
 *
 * Deletes records from the deployment_analytics table that are older than
 * ANALYTICS_RETENTION_DAYS (default: 90). This prevents the table from
 * growing unbounded and degrading query performance over time.
 *
 * Set ANALYTICS_RETENTION_DAYS=0 to disable deletion entirely.
 *
 * Scheduled daily via vercel.json. Protected by CRON_SECRET.
 */
async function handleAnalyticsPurge(req: NextRequest) {
    const retentionDays = parseInt(process.env.ANALYTICS_RETENTION_DAYS ?? '90', 10);

    try {
        const deleted = await analyticsService.applyRetentionPolicy(retentionDays);
        return NextResponse.json({ deleted });
    } catch (error: any) {
        console.error('Error running analytics retention purge:', error);
        return NextResponse.json({ error: error.message || 'Purge failed' }, { status: 500 });
    }
}

export const GET = withCronAuth(handleAnalyticsPurge);
