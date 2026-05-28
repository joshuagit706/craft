/**
 * Encrypted Audit Log Service
 *
 * Records all mutations to sensitive user configuration (tokens, billing,
 * domains) with tamper-evident, AES-256-GCM–encrypted payloads.
 *
 * Design:
 *   - Payloads are encrypted at rest using the same field-encryption approach
 *     as other sensitive columns (see lib/crypto/field-encryption.ts).
 *   - Each log entry captures: actor (userId), action, resourceType,
 *     resourceId, timestamp, and an encrypted before/after diff.
 *   - Logs are append-only; no update or delete paths are exposed.
 *   - Sensitive values (tokens, card numbers) must NEVER appear in plaintext
 *     before/after state — callers must redact them.
 *
 * Reference: docs/field-encryption.md
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { encrypt } from '@/lib/crypto/field-encryption';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AuditAction =
    | 'TOKEN_CREATED'
    | 'TOKEN_ROTATED'
    | 'TOKEN_REVOKED'
    | 'TOKEN_DISCONNECTED'
    | 'BILLING_PLAN_CHANGED'
    | 'BILLING_PAYMENT_METHOD_UPDATED'
    | 'DOMAIN_ADDED'
    | 'DOMAIN_REMOVED'
    | 'DOMAIN_VERIFIED'
    | 'PROFILE_SENSITIVE_UPDATED';

export type AuditResourceType = 'github_token' | 'billing' | 'domain' | 'profile';

export interface AuditLogEntry {
    /** ID of the user performing the action. */
    actorId: string;
    action: AuditAction;
    resourceType: AuditResourceType;
    /** ID of the affected resource (e.g. deploymentId, domainId). */
    resourceId: string;
    /**
     * Before-state snapshot. Must NOT contain raw secret values —
     * redact tokens to e.g. "***" before passing.
     */
    before?: Record<string, unknown>;
    /**
     * After-state snapshot. Must NOT contain raw secret values.
     */
    after?: Record<string, unknown>;
    /** Optional correlation / trace ID for cross-service correlation. */
    correlationId?: string;
}

interface StoredAuditRow {
    actor_id: string;
    action: string;
    resource_type: string;
    resource_id: string;
    /** AES-256-GCM encrypted JSON of { before, after, correlationId }. */
    encrypted_payload: string;
    created_at: string;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class AuditLogService {
    constructor(private readonly _supabase: SupabaseClient) {}

    /**
     * Appends an encrypted audit log entry for a sensitive config mutation.
     *
     * The before/after diff is encrypted at rest; the actor, action,
     * resource type and resource ID are stored as searchable plaintext columns.
     *
     * Never call this with unredacted tokens or payment card numbers.
     */
    async log(entry: AuditLogEntry): Promise<void> {
        const payload = {
            before: entry.before ?? null,
            after: entry.after ?? null,
            correlationId: entry.correlationId ?? null,
        };

        const encryptedPayload = encrypt(JSON.stringify(payload));

        const row: StoredAuditRow = {
            actor_id: entry.actorId,
            action: entry.action,
            resource_type: entry.resourceType,
            resource_id: entry.resourceId,
            encrypted_payload: encryptedPayload,
            created_at: new Date().toISOString(),
        };

        const { error } = await this._supabase
            .from('audit_logs')
            .insert(row);

        if (error) {
            // Log to server console but never surface details to the caller.
            console.error('[audit-log] Failed to persist audit entry', {
                action: entry.action,
                actorId: entry.actorId,
                error: error.message,
            });
        }
    }
}

/** Factory that creates an AuditLogService bound to the given Supabase client. */
export function createAuditLogService(supabase: SupabaseClient): AuditLogService {
    return new AuditLogService(supabase);
}
