/**
 * Fault injection tests for HealthMonitorService
 *
 * Simulates failures in each monitored dependency — database, Vercel network,
 * Stellar network, Stripe endpoint — and verifies that the service reports the
 * correct degraded/unhealthy status and aggregates partial failures correctly.
 *
 * Dependency graph under test:
 *   HealthMonitorService
 *     ├── Supabase DB  (deployment URL lookup, uptime recording, owner lookup)
 *     ├── fetch()      (HEAD request to the monitored deployment URL)
 *     └── analyticsService.recordUptimeCheck()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthMonitorService } from './health-monitor.service';

// ── Supabase mock ─────────────────────────────────────────────────────────────

const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({ from: mockFrom }),
}));

// ── Analytics mock ────────────────────────────────────────────────────────────

const mockRecordUptimeCheck = vi.fn().mockResolvedValue(undefined);

vi.mock('./analytics.service', () => ({
    analyticsService: { recordUptimeCheck: mockRecordUptimeCheck },
}));

// ── fetch mock ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a supabase chain returning the given value from .single() */
function buildChain(resolvedValue: { data: unknown; error: unknown }) {
    return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue(resolvedValue),
    };
}

/** Healthy fetch response */
const OK_RESPONSE = { ok: true, status: 200 };

/** Network-level connection refused error */
const ECONNREFUSED = new Error('ECONNREFUSED — connection refused');

/** AbortSignal timeout error */
const TIMEOUT_ERROR = new Error('The operation was aborted due to timeout');
TIMEOUT_ERROR.name = 'TimeoutError';

// ── Individual dependency failure scenarios ───────────────────────────────────

describe('HealthMonitorService — fault injection: database dependency', () => {
    let service: HealthMonitorService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new HealthMonitorService();
    });

    it('reports unhealthy when Supabase returns null deployment (DB miss)', async () => {
        mockFrom.mockReturnValue(buildChain({ data: null, error: null }));

        const result = await service.checkDeploymentHealth('dep-db-miss');

        expect(result.isHealthy).toBe(false);
        expect(result.error).toMatch(/Deployment URL not found/);
        expect(result.statusCode).toBeNull();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('reports unhealthy when Supabase returns a database error object', async () => {
        mockFrom.mockReturnValue(
            buildChain({ data: null, error: { message: 'connection to server failed' } }),
        );

        const result = await service.checkDeploymentHealth('dep-db-error');

        expect(result.isHealthy).toBe(false);
        expect(result.statusCode).toBeNull();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('reports unhealthy when deployment_url field is missing in DB row', async () => {
        mockFrom.mockReturnValue(
            buildChain({ data: { deployment_url: undefined }, error: null }),
        );

        const result = await service.checkDeploymentHealth('dep-no-url');

        expect(result.isHealthy).toBe(false);
        expect(result.error).toMatch(/Deployment URL not found/);
    });

    it('returns empty array when DB returns null active-deployments list', async () => {
        const chain = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
        };
        mockFrom.mockReturnValue(chain);
        (chain.eq as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: null });

        const results = await service.checkAllDeployments();

        expect(results).toEqual([]);
    });

    it('does not call notifyDowntime when DB owner lookup returns null', async () => {
        const urlChain = buildChain({ data: { deployment_url: 'https://vercel.app/dep' }, error: null });
        const ownerChain = buildChain({ data: null, error: null });
        let callCount = 0;
        mockFrom.mockImplementation(() => (callCount++ === 0 ? urlChain : ownerChain));
        mockFetch.mockResolvedValue({ ok: false, status: 503 });

        const notifySpy = vi.spyOn(service, 'notifyDowntime');
        await service.monitorDeployment('dep-owner-miss');

        expect(notifySpy).not.toHaveBeenCalled();
    });
});

describe('HealthMonitorService — fault injection: Vercel network dependency', () => {
    let service: HealthMonitorService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new HealthMonitorService();
        mockFrom.mockReturnValue(
            buildChain({ data: { deployment_url: 'https://my-project.vercel.app' }, error: null }),
        );
    });

    it('reports unhealthy when Vercel endpoint returns 502 Bad Gateway', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 502 });

        const result = await service.checkDeploymentHealth('dep-vercel-502');

        expect(result.isHealthy).toBe(false);
        expect(result.statusCode).toBe(502);
        expect(result.error).toBeNull();
    });

    it('reports unhealthy when Vercel endpoint returns 503 Service Unavailable', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 503 });

        const result = await service.checkDeploymentHealth('dep-vercel-503');

        expect(result.isHealthy).toBe(false);
        expect(result.statusCode).toBe(503);
    });

    it('reports unhealthy and zero responseTime on Vercel connection refused', async () => {
        mockFetch.mockRejectedValue(ECONNREFUSED);

        const result = await service.checkDeploymentHealth('dep-vercel-refused');

        expect(result.isHealthy).toBe(false);
        expect(result.statusCode).toBeNull();
        expect(result.responseTime).toBe(0);
        expect(result.error).toMatch(/ECONNREFUSED/);
    });

    it('reports unhealthy on Vercel request timeout', async () => {
        mockFetch.mockRejectedValue(TIMEOUT_ERROR);

        const result = await service.checkDeploymentHealth('dep-vercel-timeout');

        expect(result.isHealthy).toBe(false);
        expect(result.statusCode).toBeNull();
        expect(result.error).toMatch(/timeout|aborted/i);
    });

    it('records downtime with analytics on Vercel failure', async () => {
        mockFetch.mockRejectedValue(ECONNREFUSED);

        await service.checkDeploymentHealth('dep-vercel-down');

        expect(mockRecordUptimeCheck).toHaveBeenCalledWith('dep-vercel-down', false);
    });
});

describe('HealthMonitorService — fault injection: Stellar network dependency', () => {
    let service: HealthMonitorService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new HealthMonitorService();
        mockFrom.mockReturnValue(
            buildChain({ data: { deployment_url: 'https://horizon.stellar.org/health' }, error: null }),
        );
    });

    it('reports unhealthy when Stellar Horizon returns 503', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 503 });

        const result = await service.checkDeploymentHealth('dep-stellar-503');

        expect(result.isHealthy).toBe(false);
        expect(result.statusCode).toBe(503);
    });

    it('reports unhealthy on Stellar network timeout', async () => {
        mockFetch.mockRejectedValue(TIMEOUT_ERROR);

        const result = await service.checkDeploymentHealth('dep-stellar-timeout');

        expect(result.isHealthy).toBe(false);
        expect(result.error).toMatch(/timeout|aborted/i);
    });

    it('records downtime with analytics when Stellar is unreachable', async () => {
        mockFetch.mockRejectedValue(new Error('Network request failed'));

        await service.checkDeploymentHealth('dep-stellar-unreachable');

        expect(mockRecordUptimeCheck).toHaveBeenCalledWith('dep-stellar-unreachable', false);
    });
});

describe('HealthMonitorService — fault injection: Stripe endpoint dependency', () => {
    let service: HealthMonitorService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new HealthMonitorService();
        mockFrom.mockReturnValue(
            buildChain({ data: { deployment_url: 'https://api.stripe.com/healthcheck' }, error: null }),
        );
    });

    it('reports unhealthy when Stripe API returns 500 Internal Server Error', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 500 });

        const result = await service.checkDeploymentHealth('dep-stripe-500');

        expect(result.isHealthy).toBe(false);
        expect(result.statusCode).toBe(500);
    });

    it('reports unhealthy when Stripe is rate-limited (429)', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 429 });

        const result = await service.checkDeploymentHealth('dep-stripe-429');

        expect(result.isHealthy).toBe(false);
        expect(result.statusCode).toBe(429);
    });

    it('reports unhealthy on Stripe connection timeout', async () => {
        mockFetch.mockRejectedValue(TIMEOUT_ERROR);

        const result = await service.checkDeploymentHealth('dep-stripe-timeout');

        expect(result.isHealthy).toBe(false);
        expect(result.responseTime).toBe(0);
    });
});

// ── Partial failure scenarios ─────────────────────────────────────────────────

describe('HealthMonitorService — fault injection: partial failures', () => {
    let service: HealthMonitorService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new HealthMonitorService();
    });

    it('correctly aggregates when one of three deployments is unhealthy', async () => {
        const deployments = [
            { id: 'dep-vercel', deployment_url: 'https://app.vercel.app' },
            { id: 'dep-stellar', deployment_url: 'https://horizon.stellar.org/health' },
            { id: 'dep-stripe', deployment_url: 'https://api.stripe.com/healthcheck' },
        ];

        // DB query for the active deployments list
        const listChain = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
        };
        (listChain.eq as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: deployments.map(d => ({ id: d.id })),
            error: null,
        });

        // Per-deployment URL lookups
        let urlCallCount = 0;
        mockFrom.mockImplementation(() => {
            if (urlCallCount === 0) {
                urlCallCount++;
                return listChain;
            }
            const dep = deployments[urlCallCount - 1];
            urlCallCount++;
            return buildChain({ data: { deployment_url: dep?.deployment_url }, error: null });
        });

        // Vercel healthy, Stellar down, Stripe healthy
        mockFetch
            .mockResolvedValueOnce({ ok: true, status: 200 })
            .mockRejectedValueOnce(new Error('Stellar unreachable'))
            .mockResolvedValueOnce({ ok: true, status: 200 });

        const results = await service.checkAllDeployments();

        expect(results).toHaveLength(3);
        const stellar = results.find(r => r.deploymentId === 'dep-stellar');
        const vercel = results.find(r => r.deploymentId === 'dep-vercel');
        const stripe = results.find(r => r.deploymentId === 'dep-stripe');

        expect(stellar?.isHealthy).toBe(false);
        expect(vercel?.isHealthy).toBe(true);
        expect(stripe?.isHealthy).toBe(true);
    });

    it('reports all unhealthy when every dependency fails simultaneously', async () => {
        const deploymentIds = ['dep-a', 'dep-b', 'dep-c'];

        const listChain = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
        };
        (listChain.eq as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: deploymentIds.map(id => ({ id })),
            error: null,
        });

        let callCount = 0;
        mockFrom.mockImplementation(() => {
            if (callCount === 0) {
                callCount++;
                return listChain;
            }
            callCount++;
            return buildChain({ data: { deployment_url: 'https://example.com' }, error: null });
        });

        mockFetch.mockRejectedValue(new Error('All services down'));

        const results = await service.checkAllDeployments();

        expect(results).toHaveLength(3);
        expect(results.every(r => r.isHealthy === false)).toBe(true);
    });

    it('records uptime check for each dependency independently', async () => {
        const ids = ['dep-healthy', 'dep-down'];
        const listChain = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
        };
        (listChain.eq as ReturnType<typeof vi.fn>).mockResolvedValue({
            data: ids.map(id => ({ id })),
            error: null,
        });

        let callCount = 0;
        mockFrom.mockImplementation(() => {
            if (callCount === 0) {
                callCount++;
                return listChain;
            }
            callCount++;
            return buildChain({ data: { deployment_url: 'https://example.com' }, error: null });
        });

        mockFetch
            .mockResolvedValueOnce({ ok: true, status: 200 })
            .mockRejectedValueOnce(new Error('connection refused'));

        await service.checkAllDeployments();

        expect(mockRecordUptimeCheck).toHaveBeenCalledWith('dep-healthy', true);
        expect(mockRecordUptimeCheck).toHaveBeenCalledWith('dep-down', false);
    });
});

// ── Combined dependency failures ──────────────────────────────────────────────

describe('HealthMonitorService — fault injection: combined failures', () => {
    let service: HealthMonitorService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new HealthMonitorService();
    });

    it('handles DB failure gracefully when analytics write also fails', async () => {
        mockFrom.mockReturnValue(buildChain({ data: null, error: null }));
        mockRecordUptimeCheck.mockRejectedValueOnce(new Error('analytics unavailable'));

        // DB miss means analytics is never called; no throw should propagate
        const result = await service.checkDeploymentHealth('dep-combined-db-analytics');

        expect(result.isHealthy).toBe(false);
        expect(result.error).toMatch(/Deployment URL not found/);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns unhealthy when network fails and still reports responseTime as 0', async () => {
        mockFrom.mockReturnValue(
            buildChain({ data: { deployment_url: 'https://my-app.vercel.app' }, error: null }),
        );
        mockFetch.mockRejectedValue(ECONNREFUSED);

        const result = await service.checkDeploymentHealth('dep-combined-net');

        expect(result.isHealthy).toBe(false);
        expect(result.responseTime).toBe(0);
        expect(result.statusCode).toBeNull();
    });

    it('notifies downtime owner when network is down and DB owner lookup succeeds', async () => {
        const urlChain = buildChain({ data: { deployment_url: 'https://my-app.vercel.app' }, error: null });
        const ownerChain = buildChain({ data: { user_id: 'user-42' }, error: null });
        let callCount = 0;
        mockFrom.mockImplementation(() => (callCount++ === 0 ? urlChain : ownerChain));
        mockFetch.mockRejectedValue(ECONNREFUSED);

        const notifySpy = vi.spyOn(service, 'notifyDowntime').mockResolvedValue(undefined);
        await service.monitorDeployment('dep-notify');

        expect(notifySpy).toHaveBeenCalledWith('dep-notify', 'user-42');
    });
});
