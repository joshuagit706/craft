/**
 * Tests for Horizon multi-endpoint failover (#615)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHorizonFailover } from './config';

describe('createHorizonFailover (#615)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('throws when no endpoints are provided', () => {
        expect(() => createHorizonFailover({ endpoints: [] })).toThrow();
    });

    it('returns the primary endpoint when all are healthy', () => {
        const f = createHorizonFailover({ endpoints: ['https://primary.example.com', 'https://secondary.example.com'] });
        expect(f.selectEndpoint()).toBe('https://primary.example.com');
    });

    it('fails over to secondary when primary is marked unhealthy', () => {
        const f = createHorizonFailover({ endpoints: ['https://primary.example.com', 'https://secondary.example.com'] });
        f.markUnhealthy('https://primary.example.com');
        expect(f.selectEndpoint()).toBe('https://secondary.example.com');
    });

    it('recovers to primary after recoveryMs elapses', () => {
        const f = createHorizonFailover({
            endpoints: ['https://primary.example.com', 'https://secondary.example.com'],
            recoveryMs: 5_000,
        });
        f.markUnhealthy('https://primary.example.com');
        expect(f.selectEndpoint()).toBe('https://secondary.example.com');

        vi.advanceTimersByTime(5_001);
        expect(f.selectEndpoint()).toBe('https://primary.example.com');
    });

    it('returns primary as last resort when all endpoints are unhealthy', () => {
        const f = createHorizonFailover({ endpoints: ['https://primary.example.com', 'https://secondary.example.com'] });
        f.markUnhealthy('https://primary.example.com');
        f.markUnhealthy('https://secondary.example.com');
        expect(f.selectEndpoint()).toBe('https://primary.example.com');
    });

    it('markHealthy restores an endpoint immediately', () => {
        const f = createHorizonFailover({ endpoints: ['https://primary.example.com', 'https://secondary.example.com'] });
        f.markUnhealthy('https://primary.example.com');
        expect(f.selectEndpoint()).toBe('https://secondary.example.com');
        f.markHealthy('https://primary.example.com');
        expect(f.selectEndpoint()).toBe('https://primary.example.com');
    });

    it('works with a single endpoint', () => {
        const f = createHorizonFailover({ endpoints: ['https://only.example.com'] });
        expect(f.selectEndpoint()).toBe('https://only.example.com');
        f.markUnhealthy('https://only.example.com');
        // Falls back to primary (only option)
        expect(f.selectEndpoint()).toBe('https://only.example.com');
    });
});
