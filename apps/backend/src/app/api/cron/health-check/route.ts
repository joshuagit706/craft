import { NextRequest, NextResponse } from 'next/server';
import { healthMonitorService } from '@/services/health-monitor.service';
import { VercelService } from '@/services/vercel.service';
import { withCronAuth } from '@/lib/api/cron-auth';

/**
 * Cron endpoint to check health of all deployments
 * This should be called periodically (e.g., every 5 minutes) by a cron service
 *
 * Vercel Cron: https://vercel.com/docs/cron-jobs
 * Configure in vercel.json with crons array containing path and schedule.
 */
async function handleHealthCheck(req: NextRequest) {
    try {
        console.log('Running health check for all deployments...');

        const results = await healthMonitorService.checkAllDeployments();

        const unhealthyCount = results.filter((r) => !r.isHealthy).length;

        console.log(
            `Health check complete: ${results.length} deployments checked, ${unhealthyCount} unhealthy`
        );

        return NextResponse.json({
            success: true,
            totalChecked: results.length,
            unhealthyCount,
            results,
            vercelCircuitState: new VercelService().breaker.currentState,
        });
    } catch (error: any) {
        console.error('Error running health check cron:', error);
        return NextResponse.json(
            { error: error.message || 'Health check failed' },
            { status: 500 }
        );
    }
}

export const GET = withCronAuth(handleHealthCheck);
