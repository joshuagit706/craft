/**
 * Multi-Region Deployment Failure Recovery — Test Fixtures
 *
 * Reusable constants and factory helpers for simulating regional outages,
 * partial deployments, and rollback scenarios against the deployment pipeline.
 *
 * Issue: #569
 * Branch: test/issue-033-multi-region-failure-recovery-fixtures
 */

// ── Region identifiers ────────────────────────────────────────────────────────

export const REGIONS = ['iad1', 'sfo1', 'fra1', 'sin1', 'gru1'] as const;
export type Region = (typeof REGIONS)[number];

// ── Deployment record shapes ──────────────────────────────────────────────────

export type RegionStatus = 'pending' | 'deploying' | 'healthy' | 'failed' | 'rolled_back';

export interface RegionDeploymentRecord {
    region: Region;
    deploymentId: string;
    vercelDeploymentId: string | null;
    status: RegionStatus;
    errorMessage: string | null;
    deployedAt: string | null;
}

export interface MultiRegionDeploymentState {
    globalDeploymentId: string;
    regions: RegionDeploymentRecord[];
    overallStatus: 'pending' | 'partial' | 'completed' | 'failed' | 'rolled_back';
}

// ── Fixture: all regions healthy ─────────────────────────────────────────────

export const FIXTURE_ALL_REGIONS_HEALTHY: MultiRegionDeploymentState = {
    globalDeploymentId: 'deploy-global-ok',
    overallStatus: 'completed',
    regions: REGIONS.map((region) => ({
        region,
        deploymentId: `deploy-${region}-ok`,
        vercelDeploymentId: `dpl_${region}_ok`,
        status: 'healthy',
        errorMessage: null,
        deployedAt: '2026-01-01T00:00:00Z',
    })),
};

// ── Fixture: single region outage ────────────────────────────────────────────

export const FIXTURE_SINGLE_REGION_OUTAGE: MultiRegionDeploymentState = {
    globalDeploymentId: 'deploy-global-partial',
    overallStatus: 'partial',
    regions: REGIONS.map((region) => ({
        region,
        deploymentId: `deploy-${region}`,
        vercelDeploymentId: region === 'fra1' ? null : `dpl_${region}`,
        status: region === 'fra1' ? 'failed' : 'healthy',
        errorMessage: region === 'fra1' ? 'Vercel region fra1 unavailable: 503' : null,
        deployedAt: region === 'fra1' ? null : '2026-01-01T00:00:00Z',
    })),
};

// ── Fixture: primary region outage (iad1) ────────────────────────────────────

export const FIXTURE_PRIMARY_REGION_OUTAGE: MultiRegionDeploymentState = {
    globalDeploymentId: 'deploy-global-primary-fail',
    overallStatus: 'failed',
    regions: REGIONS.map((region) => ({
        region,
        deploymentId: `deploy-${region}`,
        vercelDeploymentId: null,
        status: region === 'iad1' ? 'failed' : 'pending',
        errorMessage: region === 'iad1' ? 'Primary region iad1 unreachable: ECONNREFUSED' : null,
        deployedAt: null,
    })),
};

// ── Fixture: partial success (3 of 5 regions deployed) ───────────────────────

export const FIXTURE_PARTIAL_SUCCESS: MultiRegionDeploymentState = {
    globalDeploymentId: 'deploy-global-partial-3of5',
    overallStatus: 'partial',
    regions: [
        { region: 'iad1', deploymentId: 'deploy-iad1', vercelDeploymentId: 'dpl_iad1', status: 'healthy', errorMessage: null, deployedAt: '2026-01-01T00:00:00Z' },
        { region: 'sfo1', deploymentId: 'deploy-sfo1', vercelDeploymentId: 'dpl_sfo1', status: 'healthy', errorMessage: null, deployedAt: '2026-01-01T00:00:00Z' },
        { region: 'fra1', deploymentId: 'deploy-fra1', vercelDeploymentId: 'dpl_fra1', status: 'healthy', errorMessage: null, deployedAt: '2026-01-01T00:00:00Z' },
        { region: 'sin1', deploymentId: 'deploy-sin1', vercelDeploymentId: null, status: 'failed', errorMessage: 'Build timeout in sin1 after 300s', deployedAt: null },
        { region: 'gru1', deploymentId: 'deploy-gru1', vercelDeploymentId: null, status: 'failed', errorMessage: 'Rate limit exceeded in gru1: 429', deployedAt: null },
    ],
};

// ── Fixture: all regions failed ───────────────────────────────────────────────

export const FIXTURE_ALL_REGIONS_FAILED: MultiRegionDeploymentState = {
    globalDeploymentId: 'deploy-global-all-fail',
    overallStatus: 'failed',
    regions: REGIONS.map((region) => ({
        region,
        deploymentId: `deploy-${region}`,
        vercelDeploymentId: null,
        status: 'failed' as RegionStatus,
        errorMessage: `Vercel API returned 500 for region ${region}`,
        deployedAt: null,
    })),
};

// ── Fixture: rollback after partial success ───────────────────────────────────

export const FIXTURE_ROLLBACK_AFTER_PARTIAL: MultiRegionDeploymentState = {
    globalDeploymentId: 'deploy-global-rollback',
    overallStatus: 'rolled_back',
    regions: REGIONS.map((region, i) => ({
        region,
        deploymentId: `deploy-${region}`,
        vercelDeploymentId: i < 2 ? `dpl_${region}_prev` : null,
        status: 'rolled_back' as RegionStatus,
        errorMessage: i >= 2 ? `Deployment failed in ${region}: 503` : null,
        deployedAt: i < 2 ? '2026-01-01T00:00:00Z' : null,
    })),
};

// ── Factory helpers ───────────────────────────────────────────────────────────

/** Build a state where exactly `failCount` regions have failed. */
export function buildPartialFailureState(failCount: number): MultiRegionDeploymentState {
    if (failCount < 0 || failCount > REGIONS.length) {
        throw new RangeError(`failCount must be 0–${REGIONS.length}`);
    }
    const regions: RegionDeploymentRecord[] = REGIONS.map((region, i) => ({
        region,
        deploymentId: `deploy-${region}`,
        vercelDeploymentId: i < REGIONS.length - failCount ? `dpl_${region}` : null,
        status: i < REGIONS.length - failCount ? 'healthy' : 'failed',
        errorMessage: i < REGIONS.length - failCount ? null : `Simulated failure in ${region}`,
        deployedAt: i < REGIONS.length - failCount ? '2026-01-01T00:00:00Z' : null,
    }));

    const healthyCount = REGIONS.length - failCount;
    const overallStatus =
        failCount === 0 ? 'completed'
        : healthyCount === 0 ? 'failed'
        : 'partial';

    return {
        globalDeploymentId: `deploy-partial-${failCount}fail`,
        overallStatus,
        regions,
    };
}

/** Build a state where a specific region has failed with a given error. */
export function buildRegionOutageState(
    failedRegion: Region,
    errorMessage: string,
): MultiRegionDeploymentState {
    return {
        globalDeploymentId: `deploy-outage-${failedRegion}`,
        overallStatus: 'partial',
        regions: REGIONS.map((region) => ({
            region,
            deploymentId: `deploy-${region}`,
            vercelDeploymentId: region !== failedRegion ? `dpl_${region}` : null,
            status: region !== failedRegion ? 'healthy' : 'failed',
            errorMessage: region !== failedRegion ? null : errorMessage,
            deployedAt: region !== failedRegion ? '2026-01-01T00:00:00Z' : null,
        })),
    };
}
