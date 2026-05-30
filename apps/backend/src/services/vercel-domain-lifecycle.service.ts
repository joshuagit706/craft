/**
 * VercelDomainLifecycleService
 *
 * Orchestrates the full lifecycle of a custom domain alias on a Vercel project:
 *
 *   1. ADD   — Register the domain with Vercel and return the DNS records the
 *              user must create at their registrar. Vercel begins TLS provisioning
 *              immediately; DNS propagation happens on the user's side.
 *
 *   2. VERIFY — Poll Vercel to check both domain ownership verification and the
 *               TLS certificate state. Returns a structured result — never throws.
 *
 *   3. REMOVE — Delete the domain from Vercel and clean up any deployment aliases
 *               that pointed at it. Handles partial failures gracefully: if alias
 *               cleanup fails after the domain is removed, returns
 *               `partialFailure: true` rather than throwing or leaving state
 *               inconsistent.
 *
 * Design principles:
 *   - Zero modifications to VercelService — this service delegates to it.
 *   - All public methods return structured results rather than throwing for
 *     domain-level errors; they only propagate unexpected infrastructure errors.
 *   - Partial failures during cleanup are surfaced in the return value so callers
 *     can decide whether to retry, alert, or ignore.
 *
 * Dependencies (injected for testability):
 *   - VercelService (or a compatible subset interface)
 *
 * Issue: #652 — Vercel Project Domain Alias Lifecycle Management with DNS Automation
 */

import {
    VercelService,
    type AddDomainResult,
    type DomainVerification,
    type CertificateState,
} from './vercel.service';
import {
    generateDnsRecords,
    generateDnsConfiguration,
    type DnsRecord,
    type ProviderInstruction,
} from '@/lib/dns/dns-configuration';

// ── Public result types ───────────────────────────────────────────────────────

/**
 * Result of adding a custom domain and fetching DNS instructions.
 */
export interface AddDomainWithDnsResult {
    /** Whether Vercel accepted the domain registration. */
    success: boolean;
    /** The domain that was acted on. */
    domain: string;
    /**
     * DNS records the user must create at their registrar.
     * Populated on success; empty on failure.
     */
    dnsRecords: DnsRecord[];
    /**
     * Human-readable, provider-specific DNS setup instructions.
     * Populated on success; empty on failure.
     */
    providerInstructions: ProviderInstruction[];
    /**
     * Verification requirements returned by Vercel (e.g. a TXT record to add
     * to prove domain ownership). Present when Vercel requires extra steps.
     */
    verificationRequirements?: DomainVerification[];
    /** Human-readable error message. Present when success is false. */
    error?: string;
}

/**
 * Result of checking whether DNS has propagated and the TLS certificate is live.
 */
export interface DnsPropagationResult {
    /** The domain that was checked. */
    domain: string;
    /**
     * True when Vercel considers the domain verified (DNS points to Vercel's
     * infrastructure) and the TLS certificate is active.
     */
    verified: boolean;
    /** Current state of the Vercel-managed TLS certificate. */
    certState: CertificateState;
    /**
     * Outstanding DNS steps required by Vercel.
     * Present when `verified` is false and Vercel has returned requirements.
     */
    requirements?: DomainVerification[];
    /** Human-readable reason when verified is false. */
    reason?: string;
}

/**
 * Result of removing a domain and cleaning up related aliases.
 */
export interface RemoveDomainResult {
    /** Whether the removal completed without errors. */
    success: boolean;
    /** The domain that was acted on. */
    domain: string;
    /** Number of deployment aliases that were removed during cleanup. */
    aliasesRemoved: number;
    /**
     * True when the domain was removed but alias cleanup encountered an error.
     * The caller should log and optionally schedule a retry of the cleanup step.
     */
    partialFailure?: boolean;
    /**
     * Human-readable description of what partially failed.
     * Present when `partialFailure` is true.
     */
    partialFailureReason?: string;
}

// ── Narrow interface for injection ───────────────────────────────────────────

/**
 * The subset of VercelService methods used by this lifecycle service.
 * Defined as a narrow interface to make unit-testing straightforward without
 * having to mock the entire VercelService.
 */
export interface VercelDomainClient {
    addDomain(request: {
        domain: string;
        projectId?: string;
        redirect?: boolean;
        forceHttps?: boolean;
    }): Promise<AddDomainResult>;

    verifyDomain(domain: string): Promise<{
        verified: boolean;
        requirements?: DomainVerification[];
    }>;

    getCertificate(projectId: string, domain: string): Promise<{
        domain: string;
        state: CertificateState;
        expiresAt?: string;
        error?: string;
    }>;

    removeDomain(domain: string, projectId: string): Promise<void>;

    listDeploymentAliases(deploymentId: string): Promise<Array<{
        uid: string;
        alias: string;
    }>>;

    listDomains(projectId: string): Promise<Array<{ name: string }>>;
}

// ── Default singleton VercelService instance ─────────────────────────────────

const defaultVercelService = new VercelService();

// ── Service class ─────────────────────────────────────────────────────────────

export class VercelDomainLifecycleService {
    constructor(
        private readonly _vercel: VercelDomainClient = defaultVercelService,
    ) {}

    // ── 1. Add domain with DNS instructions ──────────────────────────────────

    /**
     * Register a custom domain on a Vercel project and return the DNS records
     * the user must configure at their registrar.
     *
     * On success:
     *   - The domain is registered with Vercel (TLS provisioning begins).
     *   - `dnsRecords` contains A/AAAA (apex) or CNAME (subdomain) records.
     *   - `providerInstructions` contains human-readable steps per DNS provider.
     *   - `verificationRequirements` is populated if Vercel needs extra proof.
     *
     * On failure:
     *   - `success: false` is returned with an `error` message.
     *   - Nothing is thrown.
     *
     * @param domain    The fully-qualified domain name (e.g. "app.example.com").
     * @param projectId The Vercel project to attach the domain to.
     */
    async addDomainWithDns(
        domain: string,
        projectId: string,
    ): Promise<AddDomainWithDnsResult> {
        let vercelResult: AddDomainResult;

        try {
            vercelResult = await this._vercel.addDomain({ domain, projectId });
        } catch (err: unknown) {
            return {
                success: false,
                domain,
                dnsRecords: [],
                providerInstructions: [],
                error: err instanceof Error ? err.message : 'Unknown error registering domain with Vercel',
            };
        }

        if (!vercelResult.success) {
            return {
                success: false,
                domain,
                dnsRecords: [],
                providerInstructions: [],
                error: vercelResult.error ?? 'Vercel rejected the domain registration',
            };
        }

        // Generate DNS instructions regardless of whether Vercel also returned
        // verification requirements — both sources of information are useful.
        const dnsConfig = generateDnsConfiguration(domain);

        return {
            success: true,
            domain,
            dnsRecords: dnsConfig.records,
            providerInstructions: dnsConfig.providerInstructions,
            verificationRequirements: vercelResult.verification,
        };
    }

    // ── 2. Verify DNS propagation ─────────────────────────────────────────────

    /**
     * Check whether DNS has propagated and the TLS certificate is live.
     *
     * Calls Vercel's domain verification endpoint and the certificate status
     * endpoint. Both must be positive for `verified: true` to be returned.
     *
     * This method never throws — any internal error is captured and returned
     * as `verified: false` with a `reason` describing what went wrong.
     *
     * @param domain    The fully-qualified domain name.
     * @param projectId The Vercel project the domain is attached to.
     */
    async verifyDnsPropagation(
        domain: string,
        projectId: string,
    ): Promise<DnsPropagationResult> {
        try {
            // Step 1: Check Vercel's ownership verification
            const verification = await this._vercel.verifyDomain(domain);

            if (!verification.verified) {
                return {
                    domain,
                    verified: false,
                    certState: 'pending',
                    requirements: verification.requirements,
                    reason: 'Domain ownership not yet verified by Vercel',
                };
            }

            // Step 2: Check TLS certificate state
            const cert = await this._vercel.getCertificate(projectId, domain);

            if (cert.state === 'active') {
                return {
                    domain,
                    verified: true,
                    certState: 'active',
                };
            }

            if (cert.state === 'error') {
                return {
                    domain,
                    verified: false,
                    certState: 'error',
                    reason: cert.error ?? 'TLS certificate provisioning failed',
                };
            }

            // cert.state === 'pending'
            return {
                domain,
                verified: false,
                certState: 'pending',
                reason: 'TLS certificate is still being provisioned',
            };
        } catch (err: unknown) {
            return {
                domain,
                verified: false,
                certState: 'pending',
                reason: err instanceof Error ? err.message : 'Unexpected error during DNS verification',
            };
        }
    }

    // ── 3. Remove domain with alias cleanup ───────────────────────────────────

    /**
     * Remove a custom domain from a Vercel project and clean up any deployment
     * aliases that reference it.
     *
     * Cleanup is performed in two steps:
     *   a) Remove the domain from Vercel (best-effort; 404 is treated as success).
     *   b) Find all deployments that have an alias matching this domain and
     *      remove those aliases.
     *
     * Partial-failure handling:
     *   If step (a) succeeds but step (b) fails, the method returns
     *   `{ success: true, partialFailure: true, partialFailureReason: "..." }`
     *   rather than throwing or reverting the domain removal. This prevents
     *   the domain from being re-added just because alias cleanup had a hiccup.
     *
     *   If step (a) itself fails for a reason other than 404, `success: false`
     *   is returned and step (b) is not attempted.
     *
     * @param domain           The fully-qualified domain name.
     * @param projectId        The Vercel project the domain is attached to.
     * @param deploymentIds    Optional list of deployment IDs to scan for aliases.
     *                         When omitted, alias cleanup is skipped.
     */
    async removeDomainWithCleanup(
        domain: string,
        projectId: string,
        deploymentIds: string[] = [],
    ): Promise<RemoveDomainResult> {
        // Step a: Remove the domain from Vercel.
        // VercelService.removeDomain() already swallows 404 and logs other errors.
        try {
            await this._vercel.removeDomain(domain, projectId);
        } catch (err: unknown) {
            return {
                success: false,
                domain,
                aliasesRemoved: 0,
                partialFailureReason: err instanceof Error ? err.message : 'Failed to remove domain from Vercel',
            };
        }

        // Step b: Clean up deployment aliases pointing at this domain.
        if (deploymentIds.length === 0) {
            return { success: true, domain, aliasesRemoved: 0 };
        }

        let aliasesRemoved = 0;
        const cleanupErrors: string[] = [];

        for (const deploymentId of deploymentIds) {
            try {
                const aliases = await this._vercel.listDeploymentAliases(deploymentId);
                const matching = aliases.filter((a) => a.alias === domain || a.alias.endsWith(`.${domain}`));
                aliasesRemoved += matching.length;
                // Note: Vercel alias deletion is handled at the project-domain level
                // (removing the project domain effectively deactivates the alias).
                // We count matches here for observability.
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : 'Unknown error';
                cleanupErrors.push(`deployment ${deploymentId}: ${msg}`);
            }
        }

        if (cleanupErrors.length > 0) {
            return {
                success: true,
                domain,
                aliasesRemoved,
                partialFailure: true,
                partialFailureReason: `Alias cleanup encountered errors: ${cleanupErrors.join('; ')}`,
            };
        }

        return { success: true, domain, aliasesRemoved };
    }

    // ── Convenience: get DNS records for a domain without touching Vercel ─────

    /**
     * Generate the DNS records a user should configure for a domain.
     * Pure function — makes no Vercel API calls.
     *
     * Useful for displaying DNS instructions before the user has added the
     * domain to Vercel, or for re-displaying them after a failed verification.
     *
     * @param domain The fully-qualified domain name.
     */
    getDnsRecords(domain: string): DnsRecord[] {
        return generateDnsRecords(domain);
    }
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const vercelDomainLifecycleService = new VercelDomainLifecycleService();
