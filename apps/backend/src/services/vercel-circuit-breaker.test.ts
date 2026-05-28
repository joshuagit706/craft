/**
 * Circuit Breaker integration tests for VercelService — Issue #588
 *
 * Tests all state transitions:
 *   CLOSED → OPEN      (failure threshold reached)
 *   OPEN   → HALF_OPEN (cooldown elapsed)
 *   HALF_OPEN → CLOSED (probe success)
 *   HALF_OPEN → OPEN   (probe failure)
 *
 * Tests fail-fast behaviour when the circuit is OPEN.
 * Tests that the onStateChange callback fires on every transition.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '@/lib/api/circuit-breaker';
import { VercelService, VercelApiError } from './vercel.service';

function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k: string) => headers[k] ?? null },
        json: async () => body,
    };
}

function makeServiceWithBreaker(breakerOverrides: ConstructorParameters<typeof CircuitBreaker>[0]) {
    const mockFetch = vi.fn();
    const breaker = new CircuitBreaker(breakerOverrides);
    const svc = new VercelService(mockFetch as any, breaker);
    return { svc, mockFetch, breaker };
}

beforeEach(() => {
    vi.stubEnv('VERCEL_TOKEN', 'test-token');
});

// ── CLOSED → OPEN ─────────────────────────────────────────────────────────────

describe('circuit breaker: CLOSED → OPEN transition', () => {
    it('opens after reaching the failure threshold', async () => {
        const stateChanges: string[] = [];
        const { svc, mockFetch, breaker } = makeServiceWithBreaker({
            name: 'vercel-test',
            failureThreshold: 3,
            resetTimeoutMs: 30_000,
            onStateChange: (name, from, to) => stateChanges.push(`${from}→${to}`),
        });

        mockFetch.mockResolvedValue(makeResponse(500, { message: 'Server error' }));

        for (let i = 0; i < 3; i++) {
            await svc.createProject({ name: 'p', gitRepo: 'o/r', envVars: [] }).catch(() => {});
        }

        expect(breaker.currentState).toBe('OPEN');
        expect(stateChanges).toContain('CLOSED→OPEN');
    });

    it('stays CLOSED while below the failure threshold', async () => {
        const { svc, mockFetch, breaker } = makeServiceWithBreaker({
            name: 'vercel-test',
            failureThreshold: 5,
            resetTimeoutMs: 30_000,
        });

        mockFetch.mockResolvedValue(makeResponse(500, { message: 'err' }));

        for (let i = 0; i < 4; i++) {
            await svc.createProject({ name: 'p', gitRepo: 'o/r', envVars: [] }).catch(() => {});
        }

        expect(breaker.currentState).toBe('CLOSED');
    });

    it('resets failure count on a successful call (stays CLOSED)', async () => {
        const { svc, mockFetch, breaker } = makeServiceWithBreaker({
            name: 'vercel-test',
            failureThreshold: 3,
            resetTimeoutMs: 30_000,
        });

        // 2 failures then 1 success
        mockFetch
            .mockResolvedValueOnce(makeResponse(500, { message: 'err' }))
            .mockResolvedValueOnce(makeResponse(500, { message: 'err' }))
            .mockResolvedValueOnce(makeResponse(200, { id: 'prj_1', name: 'p' }));

        for (let i = 0; i < 2; i++) {
            await svc.createProject({ name: 'p', gitRepo: 'o/r', envVars: [] }).catch(() => {});
        }
        await svc.createProject({ name: 'p', gitRepo: 'o/r', envVars: [] }).catch(() => {});

        expect(breaker.currentState).toBe('CLOSED');
    });
});

// ── OPEN: fail-fast ───────────────────────────────────────────────────────────

describe('circuit breaker: fail-fast when OPEN', () => {
    it('throws CircuitOpenError without calling fetch', async () => {
        const { svc, mockFetch, breaker } = makeServiceWithBreaker({
            name: 'vercel-test',
            failureThreshold: 1,
            resetTimeoutMs: 30_000,
        });

        mockFetch.mockResolvedValue(makeResponse(500, { message: 'err' }));

        // Trip the breaker
        await svc.createProject({ name: 'p', gitRepo: 'o/r', envVars: [] }).catch(() => {});
        expect(breaker.currentState).toBe('OPEN');

        mockFetch.mockClear();

        await expect(
            svc.createProject({ name: 'p', gitRepo: 'o/r', envVars: [] }),
        ).rejects.toBeInstanceOf(CircuitOpenError);

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fail-fast applies to all VercelService methods', async () => {
        const { svc, mockFetch, breaker } = makeServiceWithBreaker({
            name: 'vercel-test',
            failureThreshold: 1,
            resetTimeoutMs: 30_000,
        });

        mockFetch.mockResolvedValue(makeResponse(500, { message: 'err' }));
        await svc.triggerDeployment('prj_1', 'owner/repo').catch(() => {});
        expect(breaker.currentState).toBe('OPEN');

        mockFetch.mockClear();
        await expect(svc.triggerDeployment('prj_1', 'owner/repo')).rejects.toBeInstanceOf(CircuitOpenError);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

// ── OPEN → HALF_OPEN ──────────────────────────────────────────────────────────

describe('circuit breaker: OPEN → HALF_OPEN transition', () => {
    it('transitions to HALF_OPEN after the cooldown elapses', async () => {
        let time = 0;
        const stateChanges: string[] = [];
        const { svc, mockFetch, breaker } = makeServiceWithBreaker({
            name: 'vercel-test',
            failureThreshold: 1,
            resetTimeoutMs: 1_000,
            now: () => time,
            onStateChange: (_n, from, to) => stateChanges.push(`${from}→${to}`),
        });

        mockFetch.mockResolvedValueOnce(makeResponse(500, { message: 'err' }));
        await svc.createProject({ name: 'p', gitRepo: 'o/r', envVars: [] }).catch(() => {});
        expect(breaker.currentState).toBe('OPEN');

        // Advance past cooldown
        time = 1_001;

        // Next call triggers the OPEN→HALF_OPEN check; if the probe succeeds → CLOSED
        mockFetch.mockResolvedValueOnce(makeResponse(200, { id: 'prj_1', name: 'p' }));
        await svc.createProject({ name: 'p', gitRepo: 'o/r', envVars: [] });

        expect(breaker.currentState).toBe('CLOSED');
        expect(stateChanges).toContain('OPEN→HALF_OPEN');
        expect(stateChanges).toContain('HALF_OPEN→CLOSED');
    });
});

// ── HALF_OPEN → CLOSED ────────────────────────────────────────────────────────

describe('circuit breaker: HALF_OPEN → CLOSED on probe success', () => {
    it('closes on a successful probe request', async () => {
        let time = 0;
        const stateChanges: string[] = [];
        const { svc, mockFetch, breaker } = makeServiceWithBreaker({
            name: 'vercel-test',
            failureThreshold: 1,
            resetTimeoutMs: 1_000,
            now: () => time,
            onStateChange: (_n, from, to) => stateChanges.push(`${from}→${to}`),
        });

        mockFetch.mockResolvedValueOnce(makeResponse(500, { message: 'err' }));
        await svc.createProject({ name: 'p', gitRepo: 'o/r', envVars: [] }).catch(() => {});

        time = 1_001;
        mockFetch.mockResolvedValueOnce(makeResponse(200, { id: 'prj_1', name: 'p' }));
        await svc.createProject({ name: 'p', gitRepo: 'o/r', envVars: [] });

        expect(breaker.currentState).toBe('CLOSED');
        expect(stateChanges).toEqual(['CLOSED→OPEN', 'OPEN→HALF_OPEN', 'HALF_OPEN→CLOSED']);
    });
});

// ── HALF_OPEN → OPEN ──────────────────────────────────────────────────────────

describe('circuit breaker: HALF_OPEN → OPEN on probe failure', () => {
    it('re-opens when the probe request fails', async () => {
        let time = 0;
        const stateChanges: string[] = [];
        const { svc, mockFetch, breaker } = makeServiceWithBreaker({
            name: 'vercel-test',
            failureThreshold: 1,
            resetTimeoutMs: 1_000,
            now: () => time,
            onStateChange: (_n, from, to) => stateChanges.push(`${from}→${to}`),
        });

        mockFetch.mockResolvedValueOnce(makeResponse(500, { message: 'err' }));
        await svc.createProject({ name: 'p', gitRepo: 'o/r', envVars: [] }).catch(() => {});

        time = 1_001;
        mockFetch.mockResolvedValueOnce(makeResponse(500, { message: 'still down' }));
        await svc.createProject({ name: 'p', gitRepo: 'o/r', envVars: [] }).catch(() => {});

        expect(breaker.currentState).toBe('OPEN');
        expect(stateChanges).toEqual(['CLOSED→OPEN', 'OPEN→HALF_OPEN', 'HALF_OPEN→OPEN']);
    });
});

// ── onStateChange callback ────────────────────────────────────────────────────

describe('circuit breaker: onStateChange callback', () => {
    it('fires with correct metadata when circuit opens', async () => {
        const calls: Array<{ name: string; from: string; to: string; meta?: Record<string, unknown> }> = [];

        const { svc, mockFetch } = makeServiceWithBreaker({
            name: 'vercel-test',
            failureThreshold: 2,
            resetTimeoutMs: 5_000,
            onStateChange: (name, from, to, meta) => calls.push({ name, from, to, meta }),
        });

        mockFetch.mockResolvedValue(makeResponse(500, { message: 'err' }));
        for (let i = 0; i < 2; i++) {
            await svc.createProject({ name: 'p', gitRepo: 'o/r', envVars: [] }).catch(() => {});
        }

        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe('vercel-test');
        expect(calls[0].from).toBe('CLOSED');
        expect(calls[0].to).toBe('OPEN');
        expect(calls[0].meta).toMatchObject({ resetTimeoutMs: 5_000 });
    });
});
