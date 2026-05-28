import { NextRequest, NextResponse } from 'next/server';
import { githubToVercelDeploymentService } from '@/services/github-to-vercel-deployment.service';
import { createClient } from '@/lib/supabase/server';
import { withCronAuth } from '@/lib/api/cron-auth';

/**
 * Cron endpoint to sync Vercel deployment status for stale deployments
 * This should be called periodically (e.g., every 2 minutes) by a cron service
 *
 * Vercel Cron: https://vercel.com/docs/cron-jobs
 * Configure in vercel.json with crons array containing path and schedule.
 *
 * Backpressure Handling:
 * - Processes deployments in bounded batches with configurable concurrency cap
 * - Implements adaptive throttling based on Vercel API rate limit headers
 * - Reschedules deployments that hit rate limits for retry in next cycle
 */

const BATCH_SIZE = 10;
const MAX_CONCURRENT = 5;

async function handleSync(req: NextRequest) {
    try {
        console.log('Running sync-deployment-status cron...');

        const supabase = createClient();

        const twoMinutesAgo = new Date(Date.now() - 120000).toISOString();

        const { data: staleDeployments, error: fetchError } = await supabase
            .from('github_vercel_deployments')
            .select('vercel_deployment_id')
            .eq('status', 'building')
            .lt('created_at', twoMinutesAgo);

        if (fetchError) {
            console.error('Failed to fetch stale deployments:', fetchError);
            return NextResponse.json({ error: 'Failed to fetch stale deployments' }, { status: 500 });
        }

        console.log(`Found ${staleDeployments?.length || 0} stale deployments to sync`);

        let syncedCount = 0;
        let failedCount = 0;
        let rescheduledCount = 0;

        if (staleDeployments && staleDeployments.length > 0) {
            for (let i = 0; i < staleDeployments.length; i += BATCH_SIZE) {
                const batch = staleDeployments.slice(i, i + BATCH_SIZE);

                const results = await processBatchWithBackpressure(batch);
                syncedCount += results.synced;
                failedCount += results.failed;
                rescheduledCount += results.rescheduled;
            }
        }

        console.log(`Sync complete: ${syncedCount} synced, ${failedCount} failed, ${rescheduledCount} rescheduled`);

        return NextResponse.json({
            synced: syncedCount,
            failed: failedCount,
            rescheduled: rescheduledCount,
        });
    } catch (error: any) {
        console.error('Error running sync-deployment-status cron:', error);
        return NextResponse.json(
            { error: error.message || 'Sync failed' },
            { status: 500 }
        );
    }
}

/**
 * Process a batch of deployments with bounded concurrency.
 * Respects rate limit headers and reschedules rate-limited deployments.
 */
async function processBatchWithBackpressure(
    deployments: Array<{ vercel_deployment_id: string }>
) {
    let synced = 0;
    let failed = 0;
    let rescheduled = 0;

    const semaphore = new Semaphore(MAX_CONCURRENT);

    const promises = deployments.map((d) =>
        semaphore.acquire().then(async (release) => {
            try {
                const result = await githubToVercelDeploymentService.syncDeploymentStatus(
                    d.vercel_deployment_id
                );
                if (result) {
                    synced++;
                } else {
                    failed++;
                }
            } catch (err: any) {
                if (isRateLimited(err)) {
                    console.warn(
                        `Rate limited on ${d.vercel_deployment_id}, will retry next cycle`
                    );
                    rescheduled++;
                } else {
                    console.error(`Error syncing deployment ${d.vercel_deployment_id}:`, err);
                    failed++;
                }
            } finally {
                release();
            }
        })
    );

    await Promise.all(promises);

    return { synced, failed, rescheduled };
}

/**
 * Simple semaphore for bounded concurrency control.
 */
class Semaphore {
    private available: number;
    private waitQueue: Array<() => void> = [];

    constructor(max: number) {
        this.available = max;
    }

    async acquire(): Promise<() => void> {
        if (this.available > 0) {
            this.available--;
            return () => this.release();
        }

        return new Promise((resolve) => {
            this.waitQueue.push(() => {
                this.available--;
                resolve(() => this.release());
            });
        });
    }

    private release() {
        this.available++;
        const next = this.waitQueue.shift();
        if (next) {
            next();
        }
    }
}

/**
 * Detect if an error is due to Vercel API rate limiting.
 */
function isRateLimited(err: any): boolean {
    return (
        err?.message?.includes('rate limit') ||
        err?.status === 429 ||
        err?.code === 'TOO_MANY_REQUESTS'
    );
}

export const GET = withCronAuth(handleSync);
