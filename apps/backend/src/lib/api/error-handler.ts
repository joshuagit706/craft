/**
 * Centralized error handler for all backend API routes.
 *
 * Maps thrown errors to typed ApiErrorResponse payloads with stable error
 * codes, categories, and correct HTTP status codes. No stack traces are ever
 * included in API responses.
 *
 * Usage:
 *   import { handleApiError } from '@/lib/api/error-handler';
 *   catch (err) { return handleApiError(err, correlationId); }
 */

import { NextResponse } from 'next/server';
import type { ErrorCode, ApiErrorResponse } from '@craft/types';
import { ERROR_CODE_META } from '@craft/types';

// ── Typed application errors ─────────────────────────────────────────────────

export class AppError extends Error {
    constructor(
        public readonly code: ErrorCode,
        message: string,
        public readonly details?: Record<string, unknown>,
    ) {
        super(message);
        this.name = 'AppError';
    }
}

// ── Error → (code, message) heuristics ──────────────────────────────────────

function classifyUnknown(err: unknown): { code: ErrorCode; message: string } {
    if (err instanceof AppError) {
        return { code: err.code, message: err.message };
    }

    if (err instanceof Error) {
        const msg = err.message.toLowerCase();

        // Auth
        if (msg.includes('unauthorized') || msg.includes('unauthenticated')) {
            return { code: 'AUTH_UNAUTHENTICATED', message: 'Authentication required.' };
        }
        if (msg.includes('forbidden')) {
            return { code: 'AUTH_FORBIDDEN', message: 'Access denied.' };
        }

        // GitHub credential errors (re-exported from github-credential.service)
        if (err.constructor?.name === 'GitHubCredentialError') {
            const anyErr = err as any;
            switch (anyErr.code) {
                case 'NOT_CONNECTED':  return { code: 'AUTH_TOKEN_NOT_CONNECTED', message: err.message };
                case 'TOKEN_EXPIRED':  return { code: 'AUTH_TOKEN_EXPIRED',       message: err.message };
                case 'TOKEN_INVALID':  return { code: 'AUTH_TOKEN_INVALID',        message: err.message };
                default:               return { code: 'GITHUB_AUTH_FAILED',         message: err.message };
            }
        }

        // External service signals
        if (msg.includes('rate limit') || msg.includes('rate-limit') || msg.includes('429')) {
            if (msg.includes('github')) return { code: 'GITHUB_RATE_LIMITED', message: err.message };
            if (msg.includes('vercel')) return { code: 'VERCEL_RATE_LIMITED',  message: err.message };
            return { code: 'GITHUB_RATE_LIMITED', message: err.message };
        }
        if (msg.includes('network') || msg.includes('fetch') || msg.includes('econnrefused')) {
            if (msg.includes('github')) return { code: 'GITHUB_NETWORK_ERROR', message: 'Could not reach GitHub.' };
            if (msg.includes('vercel')) return { code: 'VERCEL_NETWORK_ERROR',  message: 'Could not reach Vercel.' };
            if (msg.includes('stellar')) return { code: 'STELLAR_ENDPOINT_UNREACHABLE', message: 'Could not reach Stellar.' };
            return { code: 'INTERNAL_SERVER_ERROR', message: 'A network error occurred.' };
        }
        if (msg.includes('database') || msg.includes('supabase') || msg.includes('postgres')) {
            return { code: 'INTERNAL_DATABASE_ERROR', message: 'A database error occurred.' };
        }
    }

    return { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred.' };
}

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Convert any thrown value into a typed NextResponse with the correct HTTP
 * status code. Stack traces are never included.
 */
export function handleApiError(
    err: unknown,
    correlationId?: string,
): NextResponse<ApiErrorResponse> {
    const { code, message } = classifyUnknown(err);
    const meta = ERROR_CODE_META[code];

    const details = err instanceof AppError ? err.details : undefined;

    const body: ApiErrorResponse = {
        code,
        category: meta.category,
        message,
        ...(details && { details }),
        ...(correlationId && { correlationId }),
    };

    return NextResponse.json(body, { status: meta.httpStatus });
}

/**
 * Build a validation error response (400) with field-level details.
 */
export function validationError(
    details: Record<string, unknown>,
    correlationId?: string,
): NextResponse<ApiErrorResponse> {
    const body: ApiErrorResponse = {
        code: 'VALIDATION_SCHEMA_ERROR',
        category: 'validation',
        message: 'Validation failed.',
        details,
        ...(correlationId && { correlationId }),
    };
    return NextResponse.json(body, { status: 400 });
}

/**
 * Build a 401 Unauthorized response.
 */
export function unauthorizedError(correlationId?: string): NextResponse<ApiErrorResponse> {
    const body: ApiErrorResponse = {
        code: 'AUTH_UNAUTHENTICATED',
        category: 'auth',
        message: 'Authentication required.',
        ...(correlationId && { correlationId }),
    };
    return NextResponse.json(body, { status: 401 });
}
