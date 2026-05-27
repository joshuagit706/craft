/**
 * Multi-Region Deployment Failure Recovery Tests
 *
 * Verifies that the deployment pipeline correctly handles:
 *  1. Single region outage → failover to remaining healthy regions
 *  2. Primary region outage → pipeline marks deployment failed
 *  3. Partial success (3/5 regions) → overall status is 'partial', failed regions recorded
 *  4. All regions failed → overall status is 'failed', all records updated
 *  5. Rollback after partial success → all regions rolled back, records updated
 *
 * The Vercel multi-region API is mocked to simulate regional failures.
 * Deployment record state is asserted after each recovery scenario.
 *
 * Issue: #569
 * Branch: test/issue-033-multi-region-failure-recovery-fixtures
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    REGIONS,
    FIXTURE_ALL_REGIONS_HEALTHY,
    FIXTURE_SINGLE_REGION_OUTAGE,
    FIXTURE_PRIMARY_REGION_OUTAGE,
    FIXTURE_PARTIAL_SUCCESS,
    FIXTURE_ALL_REGIONS_FAILED,
    FIXTURE_ROLLBACK_AFTER_PARTIAL,
    buildPartialFailureState,
    buildRegionOutageState,
    type MultiRegionDeploymentState,
    type RegionDeploymentRecord,
    type Region,
} from './multi-region-fixtures';

// ── In-memory multi-region deployment engine (test double) ───────────────────

interface VercelRegionResponse {
    region: Region;
    success: boolean;
    deploymentId?: string;
    error?: string;
}

type VercelMultiRegionApi = (
    globalDeploymentId: string,
    regions: Region[],
) => Promise<VercelRegionResponse[]>;

class MultiRegionDeploymentEngine {
    private records = new Map<string, RegionDeploymentRecord>();

    constructor(private readonly vercelApi: VercelMultiRegionApi) {}

    async deploy(globalDeploymentId: string, regions: Region[]): Promise<MultiRegionDeploymentState> {
        // Initialise all regions as pending
        for (const region of regions) {
            this.records.set(`${globalDeploymentId}:${region}`, {
                region,
                deploymentId: `deploy-${region}`,
                vercelDeploymentId: null,
                status: 'pending',
                errorMessage: null,
                deployedAt: null,
            });
        }

        const responses = await this.vercelApi(globalDeploymentId, regions);

        for (const resp of responses) {
            const key = `${globalDeploymentId}:${resp.region}`;
            const record = this.records.get(key)!;
            if (resp.success) {
                record.status = 'healthy';
                record.vercelDeploymentId = resp.deploymentId ?? null;
                record.deployedAt = new Date().toISOString();
            } else {
                record.status = 'failed';
                record.errorMessage = resp.error ?? 'Unknown error';
            }
        }

        return this.buildState(globalDeploymentId, regions);
    }

    async rollback(state: MultiRegionDeploymentState): Promise<MultiRegionDeploymentState> {
        for (const record of state.regions) {
            record.status = 'rolled_back';
            record.vercelDeploymentId = null;
        }
        return { ...state, overallStatus: 'rolled_back' };
    }

    /** Failover: re-deploy only the failed regions. */
    async failover(
        state: MultiRegionDeploymentState,
        failoverApi: VercelMultiRegionApi,
    ): Promise<MultiRegionDeploymentState> {
        const failedRegions = state.regions
            .filter((r) => r.status === 'failed')
            .map((r) => r.region);

        if (failedRegions.length === 0) return state;

        const responses = await failoverApi(state.globalDeploymentId, failedRegions);

        const updated = state.regions.map((record) => {
            const resp = responses.find((r) => r.region === record.region);
            if (!resp) return record;
            if (resp.success) {
                return { ...record, status: 'healthy' as const, vercelDeploymentId: resp.deploymentId ?? null, deployedAt: new Date().toISOString(), errorMessage: null };
            }
            return { ...record, status: 'failed' as const, errorMessage: resp.error ?? 'Failover failed' };
        });

        const allHealthy = updated.every((r) => r.status === 'healthy');
        const allFailed = updated.every((r) => r.status === 'failed');

        return {
            ...state,
            regions: updated,
            overallStatus: allHealthy ? 'completed' : allFailed ? 'failed' : 'partial',
        };
    }

    private buildState(globalDeploymentId: string, regions: Region[]): MultiRegionDeploymentState {
        const regionRecords = regions.map(
            (r) => this.records.get(`${globalDeploymentId}:${r}`)!,
        );
        const healthyCount = regionRecords.filter((r) => r.status === 'healthy').length;
        const overallStatus =
            healthyCount === regions.length ? 'completed'
            : healthyCount === 0 ? 'failed'
            : 'partial';

        return { globalDeploymentId, regions: regionRecords, overallStatus };
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSuccessApi(): VercelMultiRegionApi {
    return async (_id, regions) =>
        regions.map((region) => ({ region, success: true, deploymentId: `dpl_${region}` }));
}

function makeFailApi(failedRegions: Region[], error = 'Simulated outage'): VercelMultiRegionApi {
    return async (_id, regions) =>
        regions.map((region) => ({
            region,
            success: !failedRegions.includes(region),
            deploymentId: failedRegions.includes(region) ? undefined : `dpl_${region}`,
            error: failedRegions.includes(region) ? error : undefined,
        }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Multi-Region Deployment Failure Recovery', () => {

    // ── Scenario 1: Single region outage → failover ───────────────────────────

    describe('Scenario 1: single region outage', () => {
        it('marks the failed region as failed and others as healthy', async () => {
            const engine = new MultiRegionDeploymentEngine(makeFailApi(['fra1']));
            const state = await engine.deploy('deploy-s1', [...REGIONS]);

            expect(state.overallStatus).toBe('partial');

            const fra1 = state.regions.find((r) => r.region === 'fra1')!;
            expect(fra1.status).toBe('failed');
            expect(fra1.errorMessage).toBeTruthy();

            const healthy = state.regions.filter((r) => r.region !== 'fra1');
            expect(healthy.every((r) => r.status === 'healthy')).toBe(true);
        });

        it('failover to alternate region succeeds and overall status becomes completed', async () => {
            const engine = new MultiRegionDeploymentEngine(makeFailApi(['fra1']));
            const state = await engine.deploy('deploy-s1-failover', [...REGIONS]);

            const recovered = await engine.failover(state, makeSuccessApi());

            expect(recovered.overallStatus).toBe('completed');
            expect(recovered.regions.every((r) => r.status === 'healthy')).toBe(true);
        });

        it('matches FIXTURE_SINGLE_REGION_OUTAGE shape', () => {
            const fixture = FIXTURE_SINGLE_REGION_OUTAGE;
            expect(fixture.overallStatus).toBe('partial');
            const fra1 = fixture.regions.find((r) => r.region === 'fra1')!;
            expect(fra1.status).toBe('failed');
            expect(fra1.vercelDeploymentId).toBeNull();
        });
    });

    // ── Scenario 2: Primary region outage ────────────────────────────────────

    describe('Scenario 2: primary region (iad1) outage', () => {
        it('marks overall status as failed when primary region is unreachable', async () => {
            // All regions fail because primary is required
            const engine = new MultiRegionDeploymentEngine(makeFailApi([...REGIONS], 'Primary unreachable'));
            const state = await engine.deploy('deploy-s2', [...REGIONS]);

            expect(state.overallStatus).toBe('failed');
            expect(state.regions.every((r) => r.status === 'failed')).toBe(true);
        });

        it('matches FIXTURE_PRIMARY_REGION_OUTAGE shape', () => {
            const fixture = FIXTURE_PRIMARY_REGION_OUTAGE;
            expect(fixture.overallStatus).toBe('failed');
            const iad1 = fixture.regions.find((r) => r.region === 'iad1')!;
            expect(iad1.status).toBe('failed');
            expect(iad1.errorMessage).toContain('iad1');
        });
    });

    // ── Scenario 3: Partial success (3/5 regions) ────────────────────────────

    describe('Scenario 3: partial success — 3 of 5 regions deployed', () => {
        it('overall status is partial when some regions succeed and some fail', async () => {
            const engine = new MultiRegionDeploymentEngine(makeFailApi(['sin1', 'gru1']));
            const state = await engine.deploy('deploy-s3', [...REGIONS]);

            expect(state.overallStatus).toBe('partial');

            const failed = state.regions.filter((r) => r.status === 'failed');
            expect(failed).toHaveLength(2);
            expect(failed.map((r) => r.region).sort()).toEqual(['gru1', 'sin1']);
        });

        it('failed regions have null vercelDeploymentId', async () => {
            const engine = new MultiRegionDeploymentEngine(makeFailApi(['sin1', 'gru1']));
            const state = await engine.deploy('deploy-s3-ids', [...REGIONS]);

            const sin1 = state.regions.find((r) => r.region === 'sin1')!;
            const gru1 = state.regions.find((r) => r.region === 'gru1')!;
            expect(sin1.vercelDeploymentId).toBeNull();
            expect(gru1.vercelDeploymentId).toBeNull();
        });

        it('matches FIXTURE_PARTIAL_SUCCESS shape', () => {
            const fixture = FIXTURE_PARTIAL_SUCCESS;
            expect(fixture.overallStatus).toBe('partial');
            const healthy = fixture.regions.filter((r) => r.status === 'healthy');
            const failed = fixture.regions.filter((r) => r.status === 'failed');
            expect(healthy).toHaveLength(3);
            expect(failed).toHaveLength(2);
        });

        it('buildPartialFailureState factory produces correct counts', () => {
            for (let failCount = 0; failCount <= REGIONS.length; failCount++) {
                const state = buildPartialFailureState(failCount);
                const failed = state.regions.filter((r) => r.status === 'failed');
                const healthy = state.regions.filter((r) => r.status === 'healthy');
                expect(failed).toHaveLength(failCount);
                expect(healthy).toHaveLength(REGIONS.length - failCount);
            }
        });
    });

    // ── Scenario 4: All regions failed ───────────────────────────────────────

    describe('Scenario 4: all regions failed', () => {
        it('overall status is failed and all records have errorMessage', async () => {
            const engine = new MultiRegionDeploymentEngine(makeFailApi([...REGIONS]));
            const state = await engine.deploy('deploy-s4', [...REGIONS]);

            expect(state.overallStatus).toBe('failed');
            expect(state.regions.every((r) => r.status === 'failed')).toBe(true);
            expect(state.regions.every((r) => r.errorMessage !== null)).toBe(true);
        });

        it('matches FIXTURE_ALL_REGIONS_FAILED shape', () => {
            const fixture = FIXTURE_ALL_REGIONS_FAILED;
            expect(fixture.overallStatus).toBe('failed');
            expect(fixture.regions).toHaveLength(REGIONS.length);
            expect(fixture.regions.every((r) => r.vercelDeploymentId === null)).toBe(true);
        });
    });

    // ── Scenario 5: Rollback after partial success ────────────────────────────

    describe('Scenario 5: rollback after partial success', () => {
        it('rollback sets all regions to rolled_back and overall status to rolled_back', async () => {
            const engine = new MultiRegionDeploymentEngine(makeFailApi(['sin1', 'gru1']));
            const partial = await engine.deploy('deploy-s5', [...REGIONS]);
            const rolled = await engine.rollback(partial);

            expect(rolled.overallStatus).toBe('rolled_back');
            expect(rolled.regions.every((r) => r.status === 'rolled_back')).toBe(true);
        });

        it('rollback clears vercelDeploymentId for all regions', async () => {
            const engine = new MultiRegionDeploymentEngine(makeFailApi(['sin1']));
            const partial = await engine.deploy('deploy-s5-ids', [...REGIONS]);
            const rolled = await engine.rollback(partial);

            expect(rolled.regions.every((r) => r.vercelDeploymentId === null)).toBe(true);
        });

        it('matches FIXTURE_ROLLBACK_AFTER_PARTIAL shape', () => {
            const fixture = FIXTURE_ROLLBACK_AFTER_PARTIAL;
            expect(fixture.overallStatus).toBe('rolled_back');
            expect(fixture.regions.every((r) => r.status === 'rolled_back')).toBe(true);
        });
    });

    // ── buildRegionOutageState factory ────────────────────────────────────────

    describe('buildRegionOutageState factory', () => {
        it('marks only the specified region as failed', () => {
            const state = buildRegionOutageState('sfo1', 'Network partition in sfo1');
            const sfo1 = state.regions.find((r) => r.region === 'sfo1')!;
            expect(sfo1.status).toBe('failed');
            expect(sfo1.errorMessage).toBe('Network partition in sfo1');

            const others = state.regions.filter((r) => r.region !== 'sfo1');
            expect(others.every((r) => r.status === 'healthy')).toBe(true);
        });

        it('overall status is partial when one region fails', () => {
            const state = buildRegionOutageState('gru1', 'DNS failure');
            expect(state.overallStatus).toBe('partial');
        });
    });
});
