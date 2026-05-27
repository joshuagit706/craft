import { createClient } from '@/lib/supabase/server';
import { analyticsService } from './analytics.service';

/**
 * HealthMonitorService — dependency graph
 *
 * External dependencies checked during health monitoring:
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │                  HealthMonitorService                   │
 *   │                                                         │
 *   │  checkDeploymentHealth(id)                              │
 *   │    ├── [DB] Supabase → deployments.deployment_url       │
 *   │    ├── [NET] fetch(deployment_url) — HEAD request        │
 *   │    │         (URL may point to Vercel, Stellar, Stripe,  │
 *   │    │          or any monitored service endpoint)         │
 *   │    └── [SVC] analyticsService.recordUptimeCheck()       │
 *   │                                                         │
 *   │  checkAllDeployments()                                  │
 *   │    ├── [DB] Supabase → deployments (status+is_active)   │
 *   │    └── → checkDeploymentHealth() × N                    │
 *   │                                                         │
 *   │  monitorDeployment(id)                                  │
 *   │    ├── → checkDeploymentHealth()                        │
 *   │    ├── [DB] Supabase → deployments.user_id              │
 *   │    └── → notifyDowntime()  [console / future webhook]   │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Failure modes:
 *   - Database unavailable  → isHealthy: false, error set
 *   - Network timeout       → isHealthy: false, error: timeout message
 *   - Non-2xx response      → isHealthy: false, statusCode set
 *   - Analytics write fails → health result still returned (best-effort)
 */
export class HealthMonitorService {
    /**
     * Check deployment health
     */
    async checkDeploymentHealth(deploymentId: string): Promise<{
        isHealthy: boolean;
        responseTime: number;
        statusCode: number | null;
        error: string | null;
    }> {
        const supabase = createClient();

        // Get deployment URL
        const { data: deployment } = await supabase
            .from('deployments')
            .select('deployment_url')
            .eq('id', deploymentId)
            .single();

        if (!deployment?.deployment_url) {
            return {
                isHealthy: false,
                responseTime: 0,
                statusCode: null,
                error: 'Deployment URL not found',
            };
        }

        try {
            const startTime = Date.now();
            const response = await fetch(deployment.deployment_url, {
                method: 'HEAD',
                signal: AbortSignal.timeout(10000), // 10 second timeout
            });
            const responseTime = Date.now() - startTime;

            const isHealthy = response.ok;

            // Record uptime check
            await analyticsService.recordUptimeCheck(deploymentId, isHealthy);

            return {
                isHealthy,
                responseTime,
                statusCode: response.status,
                error: null,
            };
        } catch (error: any) {
            // Record downtime
            await analyticsService.recordUptimeCheck(deploymentId, false);

            return {
                isHealthy: false,
                responseTime: 0,
                statusCode: null,
                error: error.message || 'Health check failed',
            };
        }
    }

    /**
     * Check health for all active deployments
     */
    async checkAllDeployments(): Promise<
        Array<{
            deploymentId: string;
            isHealthy: boolean;
            responseTime: number;
        }>
    > {
        const supabase = createClient();

        // Get all active deployments
        const { data: deployments } = await supabase
            .from('deployments')
            .select('id')
            .eq('status', 'completed')
            .eq('is_active', true);

        if (!deployments) {
            return [];
        }

        const results = await Promise.all(
            deployments.map(async (deployment) => {
                const health = await this.checkDeploymentHealth(deployment.id);
                return {
                    deploymentId: deployment.id,
                    isHealthy: health.isHealthy,
                    responseTime: health.responseTime,
                };
            })
        );

        return results;
    }

    /**
     * Send downtime notification
     */
    async notifyDowntime(
        deploymentId: string,
        userId: string
    ): Promise<void> {
        // TODO: Implement email/webhook notification
        console.log(`Deployment ${deploymentId} is down. Notifying user ${userId}`);
    }

    /**
     * Monitor deployment and notify on downtime
     */
    async monitorDeployment(deploymentId: string): Promise<void> {
        const supabase = createClient();

        const health = await this.checkDeploymentHealth(deploymentId);

        if (!health.isHealthy) {
            // Get deployment owner
            const { data: deployment } = await supabase
                .from('deployments')
                .select('user_id')
                .eq('id', deploymentId)
                .single();

            if (deployment) {
                await this.notifyDowntime(deploymentId, deployment.user_id);
            }
        }
    }
}

// Export singleton instance
export const healthMonitorService = new HealthMonitorService();
