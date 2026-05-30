// @vitest-environment node
/**
 * GitHubDeliveryFetcherService Tests
 *
 * Tests GitHub API integration for fetching delivery logs and detecting missed deliveries.
 *
 * Run: vitest run src/services/github-delivery-fetcher.service.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubDeliveryFetcherService } from './github-delivery-fetcher.service';
import { getGitHubAppAuthClient } from '@/lib/github/app-auth';

// ── Mock Supabase ─────────────────────────────────────────────────────────────

const mockFrom = vi.fn();
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockEq = vi.fn();
const mockGte = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: vi.fn(() => ({
        from: mockFrom,
    })),
}));

// ── Mock GitHub App Auth Client ──────────────────────────────────────────────

vi.mock('@/lib/github/app-auth', () => {
    const mockRequestWithInstallationAuth = vi.fn();
    return {
        getGitHubAppAuthClient: vi.fn(() => ({
            requestWithInstallationAuth: mockRequestWithInstallationAuth,
        })),
        mockRequestWithInstallationAuth, // Export for test access
    };
});

// ── Setup ─────────────────────────────────────────────────────────────────────

// Get the mock function from the mocked module
const getMockRequestWithInstallationAuth = () => {
    const client = getGitHubAppAuthClient() as any;
    return client.requestWithInstallationAuth as ReturnType<typeof vi.fn>;
};

beforeEach(() => {
    vi.clearAllMocks();

    mockFrom.mockReturnValue({
        select: mockSelect,
        insert: mockInsert,
        update: mockUpdate,
    });

    mockSelect.mockReturnValue({
        gte: mockGte,
    });

    mockInsert.mockResolvedValue({
        data: null,
        error: null,
    });

    mockUpdate.mockReturnValue({
        eq: mockEq,
    });

    mockEq.mockResolvedValue({
        data: null,
        error: null,
    });

    mockGte.mockResolvedValue({
        data: [],
        error: null,
    });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GitHubDeliveryFetcherService', () => {
    describe('fetchDeliveryLog', () => {
        it('fetches delivery log from GitHub API', async () => {
            const service = new GitHubDeliveryFetcherService();
            const mockRequestWithInstallationAuth = getMockRequestWithInstallationAuth();

            const mockGitHubResponse = [
                {
                    id: 12345,
                    guid: 'del-abc-123',
                    delivered_at: '2024-01-01T00:00:00Z',
                    redelivery: false,
                    duration: 0.5,
                    status: 'OK',
                    status_code: 200,
                    event: 'push',
                    action: null,
                    installation_id: 67890,
                    repository_id: 11111,
                },
            ];

            mockRequestWithInstallationAuth.mockResolvedValue({
                ok: true,
                json: vi.fn().mockResolvedValue(mockGitHubResponse),
            });

            const result = await service.fetchDeliveryLog(1234);

            expect(result.success).toBe(true);
            expect(result.deliveries).toHaveLength(1);
            expect(result.deliveries?.[0].guid).toBe('del-abc-123');
            expect(result.deliveries?.[0].event).toBe('push');
            expect(mockRequestWithInstallationAuth).toHaveBeenCalledWith(
                '/app/hooks/1234/deliveries?per_page=100',
                { method: 'GET' }
            );
        });

        it('filters deliveries by since parameter', async () => {
            const service = new GitHubDeliveryFetcherService();
            const mockRequestWithInstallationAuth = getMockRequestWithInstallationAuth();

            const mockGitHubResponse = [
                {
                    id: 1,
                    guid: 'del-old',
                    delivered_at: '2024-01-01T00:00:00Z',
                    event: 'push',
                },
                {
                    id: 2,
                    guid: 'del-new',
                    delivered_at: '2024-01-02T00:00:00Z',
                    event: 'push',
                },
            ];

            mockRequestWithInstallationAuth.mockResolvedValue({
                ok: true,
                json: vi.fn().mockResolvedValue(mockGitHubResponse),
            });

            const result = await service.fetchDeliveryLog(1234, '2024-01-01T12:00:00Z');

            expect(result.success).toBe(true);
            expect(result.deliveries).toHaveLength(1);
            expect(result.deliveries?.[0].guid).toBe('del-new');
        });

        it('handles GitHub API error', async () => {
            const service = new GitHubDeliveryFetcherService();
            const mockRequestWithInstallationAuth = getMockRequestWithInstallationAuth();

            mockRequestWithInstallationAuth.mockResolvedValue({
                ok: false,
                status: 404,
                text: vi.fn().mockResolvedValue('Not found'),
            });

            const result = await service.fetchDeliveryLog(1234);

            expect(result.success).toBe(false);
            expect(result.error).toContain('404');
        });

        it('handles network error', async () => {
            const service = new GitHubDeliveryFetcherService();
            const mockRequestWithInstallationAuth = getMockRequestWithInstallationAuth();

            mockRequestWithInstallationAuth.mockRejectedValue(new Error('Network error'));

            const result = await service.fetchDeliveryLog(1234);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Network error');
        });
    });

    describe('getDeliveryDetail', () => {
        it('fetches detailed delivery information', async () => {
            const service = new GitHubDeliveryFetcherService();
            const mockRequestWithInstallationAuth = getMockRequestWithInstallationAuth();

            const mockGitHubResponse = {
                id: 12345,
                guid: 'del-abc-123',
                delivered_at: '2024-01-01T00:00:00Z',
                redelivery: false,
                duration: 0.5,
                status: 'OK',
                status_code: 200,
                event: 'push',
                action: null,
                installation_id: 67890,
                repository_id: 11111,
                request: {
                    headers: { 'x-github-event': 'push' },
                    payload: { ref: 'refs/heads/main' },
                },
                response: {
                    headers: { 'content-type': 'application/json' },
                    payload: '{"received":true}',
                },
            };

            mockRequestWithInstallationAuth.mockResolvedValue({
                ok: true,
                json: vi.fn().mockResolvedValue(mockGitHubResponse),
            });

            const result = await service.getDeliveryDetail(1234, 12345);

            expect(result.success).toBe(true);
            expect(result.delivery).toBeDefined();
            expect(result.delivery?.guid).toBe('del-abc-123');
            expect(result.delivery?.request.payload).toEqual({ ref: 'refs/heads/main' });
            expect(mockRequestWithInstallationAuth).toHaveBeenCalledWith(
                '/app/hooks/1234/deliveries/12345',
                { method: 'GET' }
            );
        });

        it('handles GitHub API error', async () => {
            const service = new GitHubDeliveryFetcherService();
            const mockRequestWithInstallationAuth = getMockRequestWithInstallationAuth();

            mockRequestWithInstallationAuth.mockResolvedValue({
                ok: false,
                status: 404,
                text: vi.fn().mockResolvedValue('Not found'),
            });

            const result = await service.getDeliveryDetail(1234, 12345);

            expect(result.success).toBe(false);
            expect(result.error).toContain('404');
        });
    });

    describe('detectMissedDeliveries', () => {
        it('detects missed deliveries by comparing GitHub log vs database', async () => {
            const service = new GitHubDeliveryFetcherService();
            const mockRequestWithInstallationAuth = getMockRequestWithInstallationAuth();

            // Use dates that won't be filtered by the lookback window
            const now = new Date();
            const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
            const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
            const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();

            // Mock GitHub API response with 3 deliveries
            const mockGitHubResponse = [
                { id: 1, guid: 'del-1', delivered_at: oneHourAgo, event: 'push' },
                { id: 2, guid: 'del-2', delivered_at: twoHoursAgo, event: 'push' },
                { id: 3, guid: 'del-3', delivered_at: threeHoursAgo, event: 'push' },
            ];

            mockRequestWithInstallationAuth.mockResolvedValue({
                ok: true,
                json: vi.fn().mockResolvedValue(mockGitHubResponse),
            });

            // Mock database response with only 2 deliveries (del-1 and del-3 are recorded)
            mockGte.mockResolvedValue({
                data: [{ delivery_id: 'del-1' }, { delivery_id: 'del-3' }],
                error: null,
            });

            // Mock insert for missed delivery
            mockInsert.mockResolvedValue({ data: null, error: null });

            const result = await service.detectMissedDeliveries(1234, 24);

            expect(result.success).toBe(true);
            expect(result.missedCount).toBe(1); // del-2 is missing
            expect(mockInsert).toHaveBeenCalledTimes(1);
        });

        it('detects no missed deliveries when all are recorded', async () => {
            const service = new GitHubDeliveryFetcherService();
            const mockRequestWithInstallationAuth = getMockRequestWithInstallationAuth();

            const mockGitHubResponse = [
                { id: 1, guid: 'del-1', delivered_at: '2024-01-01T00:00:00Z', event: 'push' },
                { id: 2, guid: 'del-2', delivered_at: '2024-01-01T01:00:00Z', event: 'push' },
            ];

            mockRequestWithInstallationAuth.mockResolvedValue({
                ok: true,
                json: vi.fn().mockResolvedValue(mockGitHubResponse),
            });

            mockGte.mockResolvedValue({
                data: [{ delivery_id: 'del-1' }, { delivery_id: 'del-2' }],
                error: null,
            });

            const result = await service.detectMissedDeliveries(1234, 24);

            expect(result.success).toBe(true);
            expect(result.missedCount).toBe(0);
            expect(mockInsert).not.toHaveBeenCalled();
        });

        it('handles GitHub API error during detection', async () => {
            const service = new GitHubDeliveryFetcherService();
            const mockRequestWithInstallationAuth = getMockRequestWithInstallationAuth();

            mockRequestWithInstallationAuth.mockResolvedValue({
                ok: false,
                status: 500,
                text: vi.fn().mockResolvedValue('Internal server error'),
            });

            const result = await service.detectMissedDeliveries(1234, 24);

            expect(result.success).toBe(false);
            expect(result.error).toContain('500');
        });

        it('handles database error during detection', async () => {
            const service = new GitHubDeliveryFetcherService();
            const mockRequestWithInstallationAuth = getMockRequestWithInstallationAuth();

            mockRequestWithInstallationAuth.mockResolvedValue({
                ok: true,
                json: vi.fn().mockResolvedValue([]),
            });

            mockGte.mockResolvedValue({
                data: null,
                error: { message: 'Database error' },
            });

            const result = await service.detectMissedDeliveries(1234, 24);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Database error');
        });
    });

    describe('recordMissedDelivery', () => {
        it('records a missed delivery', async () => {
            const service = new GitHubDeliveryFetcherService();

            mockInsert.mockResolvedValue({ data: null, error: null });

            const result = await service.recordMissedDelivery(
                'del-missed',
                'push',
                '2024-01-01T00:00:00Z'
            );

            expect(result.success).toBe(true);
            expect(mockInsert).toHaveBeenCalled();
        });

        it('handles duplicate missed delivery (already recorded)', async () => {
            const service = new GitHubDeliveryFetcherService();

            mockInsert.mockResolvedValue({
                data: null,
                error: { code: '23505', message: 'duplicate key' },
            });

            const result = await service.recordMissedDelivery(
                'del-missed',
                'push',
                '2024-01-01T00:00:00Z'
            );

            expect(result.success).toBe(true); // Duplicate is not an error
        });

        it('handles database error', async () => {
            const service = new GitHubDeliveryFetcherService();

            mockInsert.mockResolvedValue({
                data: null,
                error: { code: 'PGRST116', message: 'Database error' },
            });

            const result = await service.recordMissedDelivery(
                'del-missed',
                'push',
                '2024-01-01T00:00:00Z'
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe('Database error');
        });
    });

    describe('markMissedDeliveryReplayed', () => {
        it('marks a missed delivery as replayed', async () => {
            const service = new GitHubDeliveryFetcherService();

            mockEq.mockResolvedValue({ data: null, error: null });

            const result = await service.markMissedDeliveryReplayed('del-missed', 'replay-123');

            expect(result.success).toBe(true);
            expect(mockUpdate).toHaveBeenCalled();
        });

        it('handles database error', async () => {
            const service = new GitHubDeliveryFetcherService();

            mockEq.mockResolvedValue({
                data: null,
                error: { message: 'Database error' },
            });

            const result = await service.markMissedDeliveryReplayed('del-missed', 'replay-123');

            expect(result.success).toBe(false);
            expect(result.error).toBe('Database error');
        });
    });
});
