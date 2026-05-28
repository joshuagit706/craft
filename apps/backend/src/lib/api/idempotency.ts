/**
 * Request deduplication middleware using client-supplied idempotency keys.
 *
 * Reads the `Idempotency-Key` header on incoming requests. When a key is
 * present and a response for the same (userId, key) pair has been stored
 * within the TTL window, the cached response is returned immediately without
 * executing the handler again.
 *
 * Cache entries are scoped per authenticated user — keys from different users
 * never collide even if the raw key string is identical.
 *
 * Configuration:
 *   IDEMPOTENCY_TTL_MS — Cache TTL in milliseconds. Default: 86_400_000 (24 h)
 *
 * Usage:
 *   const handler = withIdempotency(userId, async (req) => { ... });
 *   return handler(req);
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

interface CachedResponse {
    status: number;
    body: unknown;
    storedAt: number;
}

// Module-level cache: survives across requests within a process.
const cache = new Map<string, CachedResponse>();

function ttlMs(): number {
    const val = parseInt(process.env.IDEMPOTENCY_TTL_MS ?? '86400000', 10);
    return Number.isFinite(val) && val > 0 ? val : 86_400_000;
}

function cacheKey(userId: string, idempotencyKey: string): string {
    return `${userId}:${idempotencyKey}`;
}

function evictExpired(): void {
    const now = Date.now();
    const ttl = ttlMs();
    for (const [key, entry] of cache) {
        if (now - entry.storedAt > ttl) cache.delete(key);
    }
}

export type IdempotentHandler = (req: NextRequest) => Promise<NextResponse>;

/**
 * Wrap a handler with idempotency deduplication.
 * If the request carries an `Idempotency-Key` header and a cached response
 * exists for (userId, key), returns the cached response. Otherwise executes
 * the handler and caches a 2xx response.
 */
export function withIdempotency(
    userId: string,
    handler: IdempotentHandler,
): IdempotentHandler {
    return async (req: NextRequest): Promise<NextResponse> => {
        const rawKey = req.headers.get(IDEMPOTENCY_KEY_HEADER);
        if (!rawKey) return handler(req);

        evictExpired();

        const key = cacheKey(userId, rawKey);
        const cached = cache.get(key);

        if (cached && Date.now() - cached.storedAt <= ttlMs()) {
            return NextResponse.json(cached.body, {
                status: cached.status,
                headers: { 'Idempotent-Replayed': 'true' },
            });
        }

        const response = await handler(req);

        if (response.status >= 200 && response.status < 300) {
            const body = await response.clone().json().catch(() => null);
            cache.set(key, { status: response.status, body, storedAt: Date.now() });
        }

        return response;
    };
}

/** Exposed for testing — clears all cached entries. */
export function clearIdempotencyCache(): void {
    cache.clear();
}
