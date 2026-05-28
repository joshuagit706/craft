/**
 * Unit tests for the request deduplication middleware — Issue #587
 *
 * Tests:
 *   - No key → handler always called
 *   - Same key + same user → cached response returned on second call
 *   - Same key + different user → separate deployments (no collision)
 *   - Different keys + same user → separate deployments
 *   - Idempotent-Replayed header present on cached responses
 *   - Non-2xx responses are not cached
 *   - Expired entries are not served (TTL respected)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import {
    withIdempotency,
    clearIdempotencyCache,
    IDEMPOTENCY_KEY_HEADER,
} from './idempotency';

function makeRequest(idempotencyKey?: string): NextRequest {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers[IDEMPOTENCY_KEY_HEADER] = idempotencyKey;

    return new NextRequest('http://localhost/api/deployments', {
        method: 'POST',
        headers,
        body: JSON.stringify({ templateId: 'tpl_1' }),
    });
}

function makeHandler(status: number, body: unknown) {
    return vi.fn().mockResolvedValue(NextResponse.json(body, { status }));
}

beforeEach(() => {
    clearIdempotencyCache();
    vi.unstubAllEnvs();
});

// ── No Idempotency-Key ────────────────────────────────────────────────────────

describe('withIdempotency — no key', () => {
    it('calls the handler on every request when no key is supplied', async () => {
        const handler = makeHandler(201, { id: 'dep_1' });
        const wrapped = withIdempotency('user_a', handler);

        await wrapped(makeRequest());
        await wrapped(makeRequest());

        expect(handler).toHaveBeenCalledTimes(2);
    });
});

// ── Same key + same user: deduplication ───────────────────────────────────────

describe('withIdempotency — duplicate key same user', () => {
    it('returns the original response on the second request without calling the handler again', async () => {
        const handler = makeHandler(201, { id: 'dep_1', status: 'pending' });
        const wrapped = withIdempotency('user_a', handler);

        const r1 = await wrapped(makeRequest('key-abc'));
        const r2 = await wrapped(makeRequest('key-abc'));

        expect(handler).toHaveBeenCalledTimes(1);
        expect(r2.status).toBe(201);
        expect(r2.headers.get('Idempotent-Replayed')).toBe('true');

        const body1 = await r1.json();
        const body2 = await r2.json();
        expect(body1).toEqual(body2);
    });

    it('does not set Idempotent-Replayed on the first (live) response', async () => {
        const handler = makeHandler(201, { id: 'dep_1' });
        const wrapped = withIdempotency('user_a', handler);

        const r1 = await wrapped(makeRequest('key-abc'));
        expect(r1.headers.get('Idempotent-Replayed')).toBeNull();
    });
});

// ── Cross-user key isolation ──────────────────────────────────────────────────

describe('withIdempotency — cross-user isolation', () => {
    it('same key string for different users creates separate deployments', async () => {
        const handlerA = makeHandler(201, { id: 'dep_for_a' });
        const handlerB = makeHandler(201, { id: 'dep_for_b' });

        const wrappedA = withIdempotency('user_a', handlerA);
        const wrappedB = withIdempotency('user_b', handlerB);

        await wrappedA(makeRequest('shared-key'));
        await wrappedB(makeRequest('shared-key'));

        // Both handlers called — no cross-tenant collision
        expect(handlerA).toHaveBeenCalledTimes(1);
        expect(handlerB).toHaveBeenCalledTimes(1);
    });

    it('cached response for user_a is not returned to user_b', async () => {
        const handlerA = makeHandler(201, { id: 'dep_for_a' });
        const handlerB = makeHandler(201, { id: 'dep_for_b' });

        const wrappedA = withIdempotency('user_a', handlerA);
        const wrappedB = withIdempotency('user_b', handlerB);

        await wrappedA(makeRequest('shared-key'));
        const rb = await wrappedB(makeRequest('shared-key'));

        const body = await rb.json();
        expect(body.id).toBe('dep_for_b');
        expect(rb.headers.get('Idempotent-Replayed')).toBeNull();
    });
});

// ── Different keys, same user ─────────────────────────────────────────────────

describe('withIdempotency — different keys same user', () => {
    it('different keys create separate cache entries and call the handler each time', async () => {
        const handler = makeHandler(201, { id: 'dep_1' });
        const wrapped = withIdempotency('user_a', handler);

        await wrapped(makeRequest('key-1'));
        await wrapped(makeRequest('key-2'));

        expect(handler).toHaveBeenCalledTimes(2);
    });
});

// ── Non-2xx responses not cached ──────────────────────────────────────────────

describe('withIdempotency — non-2xx not cached', () => {
    it('does not cache 4xx error responses', async () => {
        const handler = makeHandler(422, { error: 'Invalid config' });
        const wrapped = withIdempotency('user_a', handler);

        await wrapped(makeRequest('key-err'));
        await wrapped(makeRequest('key-err'));

        // Handler called twice — error was not cached
        expect(handler).toHaveBeenCalledTimes(2);
    });

    it('does not cache 5xx error responses', async () => {
        const handler = makeHandler(500, { error: 'Internal server error' });
        const wrapped = withIdempotency('user_a', handler);

        await wrapped(makeRequest('key-err'));
        await wrapped(makeRequest('key-err'));

        expect(handler).toHaveBeenCalledTimes(2);
    });
});

// ── TTL expiry ────────────────────────────────────────────────────────────────

describe('withIdempotency — TTL expiry', () => {
    it('re-calls the handler after the TTL has elapsed', async () => {
        // Set a very short TTL
        vi.stubEnv('IDEMPOTENCY_TTL_MS', '1');

        const handler = makeHandler(201, { id: 'dep_1' });
        const wrapped = withIdempotency('user_a', handler);

        await wrapped(makeRequest('key-ttl'));

        // Wait for expiry (1 ms TTL)
        await new Promise((r) => setTimeout(r, 10));

        await wrapped(makeRequest('key-ttl'));

        expect(handler).toHaveBeenCalledTimes(2);
    });
});
