/**
 * GitHub-to-Vercel Deployment Trigger Service
 *
 * Triggers Vercel deployments in response to GitHub push events.
 * Stores deployment metadata in Supabase for tracking and observability.
 *
 * Responsibilities:
 *   - Trigger Vercel deployment via Vercel REST API
 *   - Capture deployment ID, URL, and status
 *   - Store deployment metadata in Supabase
 *   - Provide query endpoint for deployment tracking
 *   - Sync deployment status via Vercel API polling
 *
 * Security:
 *   - VERCEL_TOKEN is never exposed to frontend
 *   - All API calls are server-side only
 *   - Deployment metadata is stored securely in Supabase
 *
 * Environment variables required:
 *   - VERCEL_TOKEN: Vercel API token
 *   - VERCEL_PROJECT_ID: Vercel project ID to deploy
 *   - VERCEL_TEAM_ID: Optional Vercel team ID
 */

import { createClient } from '@/lib/supabase/server';
import { VercelService } from './vercel.service';
import { createLogger } from '@/lib/api/logger';
import { startTrace, newSpan, withSpan, type TraceContext } from '@/lib/tracing';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TriggerDeploymentRequest {
    /** GitHub repository full name (e.g., "owner/repo") */
    repoFullName: string;
    /** GitHub repository name (e.g., "my-app") */
    repoName: string;
    /** Branch name (e.g., "main") */
    branch: string;
    /** Git commit SHA */
    commitSha: string;
    /** Commit message */
    commitMessage: string;
    /** Pusher name */
    pusherName: string;
}

export interface TriggerDeploymentResult {
    success: boolean;
    deploymentId: string;
    deploymentUrl?: string;
    status?: string;
    errorMessage?: string;
    /** W3C traceparent identifying this deployment across all pipeline stages. */
    traceId?: string;
}

export interface DeploymentMetadata {
    id: string;
    repoFullName: string;
    repoName: string;
    branch: string;
    commitSha: string;
    commitMessage: string;
    pusherName: string;
    vercelDeploymentId: string;
    vercelDeploymentUrl: string;
    status: 'queued' | 'building' | 'ready' | 'error' | 'failed' | 'canceled';
    createdAt: string;
    updatedAt: string;
}

// ── Service ─────────────────────────────────────────────────────────────────────

export class GitHubToVercelDeploymentService {
    private readonly _vercelService: VercelService;

    constructor(vercelService?: VercelService) {
        this._vercelService = vercelService || new VercelService();
    }

    /**
     * Triggers a Vercel deployment for a GitHub push event.
     *
     * Process:
     *   1. Validate environment variables
     *   2. Trigger Vercel deployment via API
     *   3. Capture deployment ID, URL, and status
     *   4. Store deployment metadata in Supabase
     *   5. Return deployment details
     *
     * @param request - Deployment trigger request
     * @returns Deployment trigger result
     */
    async triggerDeployment(request: TriggerDeploymentRequest): Promise<TriggerDeploymentResult> {
        // Generate root trace context for this deployment — propagated through all stages.
        const trace = startTrace();
        const correlationId = crypto.randomUUID();
        const log = createLogger({ correlationId, service: 'github-to-vercel-deployment', traceId: trace.traceId });

        log.info('Deployment pipeline started', {
            traceId: trace.traceId,
            repoFullName: request.repoFullName,
            branch: request.branch,
            commitSha: request.commitSha.substring(0, 7),
        });

        // Stage 1: Validate environment
        const { result: vercelProjectId, durationMs: envMs } = await withSpan(
            'validate-env',
            trace.traceId,
            async (_span) => process.env.VERCEL_PROJECT_ID ?? null,
        );

        log.info('Stage: validate-env', { traceId: trace.traceId, durationMs: envMs });

        if (!vercelProjectId) {
            log.error('VERCEL_PROJECT_ID is not configured', undefined, { traceId: trace.traceId });
            return { success: false, deploymentId: '', errorMessage: 'VERCEL_PROJECT_ID is not configured', traceId: trace.traceId };
        }

        try {
            // Stage 2: Trigger Vercel deployment
            const { result: deployment, durationMs: vercelMs, spanId: vercelSpanId } = await withSpan(
                'trigger-vercel',
                trace.traceId,
                async (span) => {
                    log.info('Stage: trigger-vercel', { traceId: trace.traceId, spanId: span.spanId });
                    return this._vercelService.triggerDeployment(vercelProjectId, request.repoFullName);
                },
            );

            log.info('Vercel deployment triggered', {
                traceId: trace.traceId,
                spanId: vercelSpanId,
                durationMs: vercelMs,
                deploymentId: deployment.deploymentId,
                deploymentUrl: deployment.deploymentUrl,
                status: deployment.status,
            });

            // Stage 3: Persist metadata
            const deploymentId = crypto.randomUUID();
            const { durationMs: storeMs, spanId: storeSpanId } = await withSpan(
                'store-metadata',
                trace.traceId,
                async (span) => {
                    log.info('Stage: store-metadata', { traceId: trace.traceId, spanId: span.spanId });
                    const supabase = createClient();
                    const { error: insertError } = await supabase.from('github_vercel_deployments').insert({
                        id: deploymentId,
                        repo_full_name: request.repoFullName,
                        repo_name: request.repoName,
                        branch: request.branch,
                        commit_sha: request.commitSha,
                        commit_message: request.commitMessage,
                        pusher_name: request.pusherName,
                        vercel_deployment_id: deployment.deploymentId,
                        vercel_deployment_url: deployment.deploymentUrl,
                        status: this.mapVercelStatus(deployment.status),
                        trace_id: trace.traceId,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    });
                    if (insertError) {
                        log.error('Failed to store deployment metadata', insertError, { traceId: trace.traceId });
                    }
                    return null;
                },
            );

            log.info('Deployment pipeline complete', {
                traceId: trace.traceId,
                spanId: storeSpanId,
                durationMs: storeMs,
                deploymentId,
            });

            return {
                success: true,
                deploymentId,
                deploymentUrl: deployment.deploymentUrl,
                status: deployment.status,
                traceId: trace.traceId,
            };
        } catch (error: any) {
            log.error('Deployment pipeline failed', error, { traceId: trace.traceId });
            return {
                success: false,
                deploymentId: '',
                errorMessage: error.message || 'Failed to trigger deployment',
                traceId: trace.traceId,
            };
        }
    }

    /**
     * Syncs deployment status from Vercel API.
     *
     * Polls Vercel API for the current status of a deployment and updates
     * the stored metadata in Supabase.
     *
     * @param vercelDeploymentId - Vercel deployment ID
     * @returns Updated deployment metadata or null if not found
     */
    async syncDeploymentStatus(vercelDeploymentId: string, existingTraceId?: string): Promise<DeploymentMetadata | null> {
        const correlationId = crypto.randomUUID();
        const traceCtx = existingTraceId ? newSpan(existingTraceId) : startTrace();
        const log = createLogger({ correlationId, service: 'github-to-vercel-deployment-sync', traceId: traceCtx.traceId });

        log.info('Syncing deployment status', { vercelDeploymentId, traceId: traceCtx.traceId });

        try {
            // Get deployment status from Vercel
            const status = await this._vercelService.getDeploymentStatus(vercelDeploymentId);

            log.info('Vercel deployment status retrieved', {
                vercelDeploymentId,
                status: status.status,
                url: status.url,
            });

            // Update metadata in Supabase
            const supabase = createClient();

            const { data, error } = await supabase
                .from('github_vercel_deployments')
                .update({
                    status: this.mapVercelStatus(status.status),
                    updated_at: new Date().toISOString(),
                })
                .eq('vercel_deployment_id', vercelDeploymentId)
                .select()
                .single();

            if (error || !data) {
                log.error('Failed to update deployment status', error);
                return null;
            }

            log.info('Deployment status synced', { id: data.id });

            return this.mapToDeploymentMetadata(data);
        } catch (error: any) {
            // Handle edge case: Vercel project or deployment deleted externally
            if (error?.code === 'NOT_FOUND') {
                log.warn('Deployment not found on Vercel, marking as failed', { vercelDeploymentId });
                
                const supabase = createClient();
                const { data, error: updateError } = await supabase
                    .from('github_vercel_deployments')
                    .update({
                        status: 'failed',
                        updated_at: new Date().toISOString(),
                    })
                    .eq('vercel_deployment_id', vercelDeploymentId)
                    .select()
                    .single();

                if (!updateError && data) {
                    return this.mapToDeploymentMetadata(data);
                }
            }

            log.error('Failed to sync deployment status', error);
            return null;
        }
    }

    /**
     * Retrieves deployment metadata by Vercel deployment ID.
     *
     * @param vercelDeploymentId - Vercel deployment ID
     * @returns Deployment metadata or null if not found
     */
    async getDeploymentByVercelId(vercelDeploymentId: string): Promise<DeploymentMetadata | null> {
        const supabase = createClient();

        const { data, error } = await supabase
            .from('github_vercel_deployments')
            .select('*')
            .eq('vercel_deployment_id', vercelDeploymentId)
            .single();

        if (error || !data) {
            return null;
        }

        return this.mapToDeploymentMetadata(data);
    }

    /**
     * Retrieves recent deployments for a repository.
     *
     * @param repoFullName - GitHub repository full name
     * @param limit - Maximum number of deployments to return
     * @returns Array of deployment metadata
     */
    async getRecentDeployments(repoFullName: string, limit: number = 10): Promise<DeploymentMetadata[]> {
        const supabase = createClient();

        const { data, error } = await supabase
            .from('github_vercel_deployments')
            .select('*')
            .eq('repo_full_name', repoFullName)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error || !data) {
            return [];
        }

        return data.map((d: any) => this.mapToDeploymentMetadata(d));
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    private mapVercelStatus(vercelStatus: string): DeploymentMetadata['status'] {
        const statusMap: Record<string, DeploymentMetadata['status']> = {
            'QUEUED': 'queued',
            'BUILDING': 'building',
            'READY': 'ready',
            'ERROR': 'error',
            'FAILED': 'failed',
            'CANCELED': 'canceled',
        };
        return statusMap[vercelStatus] || 'queued';
    }

    private mapToDeploymentMetadata(data: any): DeploymentMetadata {
        return {
            id: data.id,
            repoFullName: data.repo_full_name,
            repoName: data.repo_name,
            branch: data.branch,
            commitSha: data.commit_sha,
            commitMessage: data.commit_message,
            pusherName: data.pusher_name,
            vercelDeploymentId: data.vercel_deployment_id,
            vercelDeploymentUrl: data.vercel_deployment_url,
            status: data.status,
            createdAt: data.created_at,
            updatedAt: data.updated_at,
        };
    }
}

export const githubToVercelDeploymentService = new GitHubToVercelDeploymentService();
