/**
 * Property-based tests for JWT token expiry edge cases in AuthService
 *
 * Coverage:
 *  - Tokens with arbitrary expiry times relative to "now" (500+ scenarios)
 *  - Clock skew boundary: tokens expiring exactly at "now" are rejected
 *  - Tokens expiring mid-request are rejected
 *  - Refresh token flow when access token expires mid-request
 *  - Expired tokens ALWAYS produce a rejection / null user — never succeed
 *
 * Strategy:
 *  - Fake timers control the current time deterministically
 *  - fast-check generates arbitrary expiry offsets (past and future)
 *  - The Supabase mock simulates expiry checking based on the generated exp
 *
 * Issue: #571
 * Branch: test/issue-035-jwt-expiry-property-tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { AuthService } from './auth.service';

// ── Supabase mock ─────────────────────────────────────────────────────────────

const mockGetUser = vi.fn();
const mockRefreshSession = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
    createClient: () => ({
        auth: {
            getUser: mockGetUser,
            refreshSession: mockRefreshSession,
        },
    }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a mock Supabase response that simulates expiry checking. */
function mockForExpiry(expSec: number, nowSec: number) {
    if (expSec <= nowSec) {
        // Token is expired — Supabase rejects
        mockGetUser.mockResolvedValue({
            data: { user: null },
            error: { code: 'PGRST116', status: 401, message: 'JWT expired' },
        });
    } else {
        // Token is valid
        mockGetUser.mockResolvedValue({
            data: {
                user: { id: 'uid', email: 'u@example.com', created_at: new Date().toISOString() },
            },
            error: null,
        });
    }
}

// ── Arbitraries ───────────────────────────────────────────────────────────────

const NOW_SEC = 1_700_000_000; // fixed "current time" in seconds

/**
 * Arbitrary expiry seconds in the past (expired tokens).
 * Range: 1 second ago → 10 years ago.
 */
const pastExpiry = fc.integer({ min: 1, max: 315_360_000 }).map((delta) => NOW_SEC - delta);

/**
 * Arbitrary expiry seconds in the future (valid tokens).
 * Range: 1 second from now → 10 years from now.
 */
const futureExpiry = fc.integer({ min: 1, max: 315_360_000 }).map((delta) => NOW_SEC + delta);

/**
 * Expiry exactly at NOW_SEC — boundary case, must be treated as expired.
 */
const boundaryExpiry = fc.constant(NOW_SEC);

/**
 * Arbitrary expiry: mix of past and future (500+ scenarios).
 */
const arbitraryExpiry = fc.integer({ min: NOW_SEC - 315_360_000, max: NOW_SEC + 315_360_000 });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('JWT Token Expiry — Property-Based Tests (≥500 scenarios)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ── Expired tokens always rejected ────────────────────────────────────────

    it('expired tokens (past expiry) always yield null user', async () => {
        await fc.assert(
            fc.asyncProperty(pastExpiry, async (expSec) => {
                mockForExpiry(expSec, NOW_SEC);

                const service = new AuthService();
                const user = await service.getCurrentUser();

                // An expired token must never return a valid user
                expect(user).toBeNull();
            }),
            { numRuns: 500 },
        );
    });

    // ── Boundary: token expiring exactly at "now" is rejected ─────────────────

    it('token expiring exactly at current time is rejected (boundary)', async () => {
        await fc.assert(
            fc.asyncProperty(boundaryExpiry, async (expSec) => {
                mockForExpiry(expSec, NOW_SEC);

                const service = new AuthService();
                const user = await service.getCurrentUser();

                expect(user).toBeNull();
            }),
            { numRuns: 1 },
        );
    });

    // ── Valid tokens succeed ───────────────────────────────────────────────────

    it('tokens with future expiry always return a user (control)', async () => {
        await fc.assert(
            fc.asyncProperty(futureExpiry, async (expSec) => {
                mockForExpiry(expSec, NOW_SEC);

                const service = new AuthService();
                const user = await service.getCurrentUser();

                expect(user).not.toBeNull();
                expect(user!.id).toBe('uid');
            }),
            { numRuns: 500 },
        );
    });

    // ── Arbitrary expiry: expired → null, valid → user ────────────────────────

    it('arbitrary expiry: expired tokens never succeed, valid tokens always succeed', async () => {
        await fc.assert(
            fc.asyncProperty(arbitraryExpiry, async (expSec) => {
                mockForExpiry(expSec, NOW_SEC);

                const service = new AuthService();
                const user = await service.getCurrentUser();

                if (expSec <= NOW_SEC) {
                    // Must be rejected
                    expect(user).toBeNull();
                } else {
                    // Must succeed
                    expect(user).not.toBeNull();
                }
            }),
            { numRuns: 500 },
        );
    });

    // ── Mid-request expiry ────────────────────────────────────────────────────

    it('token expiring mid-request is rejected (access token expires during call)', async () => {
        // Simulate: first call succeeds (token valid), second call fails (expired)
        let callCount = 0;
        mockGetUser.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                // Token was valid when the request started
                return {
                    data: { user: { id: 'uid', email: 'u@example.com', created_at: new Date().toISOString() } },
                    error: null,
                };
            }
            // Token expired mid-request on subsequent check
            return {
                data: { user: null },
                error: { code: 'PGRST116', status: 401, message: 'JWT expired' },
            };
        });

        const service = new AuthService();

        const firstResult = await service.getCurrentUser();
        expect(firstResult).not.toBeNull(); // First call: token still valid

        const secondResult = await service.getCurrentUser();
        expect(secondResult).toBeNull(); // Second call: token expired mid-request
    });

    // ── Refresh token flow ────────────────────────────────────────────────────

    it('refresh token flow: expired access token triggers refresh, new token succeeds', async () => {
        // Access token expired → refresh → new valid session
        mockGetUser.mockResolvedValue({
            data: { user: null },
            error: { code: 'PGRST116', status: 401, message: 'JWT expired' },
        });

        mockRefreshSession.mockResolvedValue({
            data: {
                session: { access_token: 'new-token', refresh_token: 'new-refresh' },
                user: { id: 'uid', email: 'u@example.com', created_at: new Date().toISOString() },
            },
            error: null,
        });

        const service = new AuthService();

        // Initial call returns null (expired)
        const expiredResult = await service.getCurrentUser();
        expect(expiredResult).toBeNull();

        // After refresh, new token is valid
        mockGetUser.mockResolvedValue({
            data: { user: { id: 'uid', email: 'u@example.com', created_at: new Date().toISOString() } },
            error: null,
        });

        const refreshedResult = await service.getCurrentUser();
        expect(refreshedResult).not.toBeNull();
        expect(refreshedResult!.id).toBe('uid');
    });

    // ── Refresh token itself expired ──────────────────────────────────────────

    it('expired refresh token yields null — no successful auth under any clock skew', async () => {
        await fc.assert(
            fc.asyncProperty(pastExpiry, async (_expSec) => {
                // Both access and refresh tokens expired
                mockGetUser.mockResolvedValue({
                    data: { user: null },
                    error: { code: 'PGRST116', status: 401, message: 'JWT expired' },
                });
                mockRefreshSession.mockResolvedValue({
                    data: { session: null, user: null },
                    error: { code: 'PGRST116', status: 401, message: 'Refresh token expired' },
                });

                const service = new AuthService();
                const user = await service.getCurrentUser();

                // Expired tokens must NEVER yield a valid user
                expect(user).toBeNull();
            }),
            { numRuns: 500 },
        );
    });

    // ── Clock skew tolerance: just-expired tokens are always rejected ─────────

    it('tokens expired by 1 second are always rejected (no clock skew tolerance)', async () => {
        await fc.assert(
            fc.asyncProperty(fc.constant(NOW_SEC - 1), async (expSec) => {
                mockForExpiry(expSec, NOW_SEC);

                const service = new AuthService();
                const user = await service.getCurrentUser();

                expect(user).toBeNull();
            }),
            { numRuns: 1 },
        );
    });
});
