/**
 * Unit tests for VercelDomainLifecycleService.
 *
 * Tests the full lifecycle of custom domain management:
 *   1. ADD    — Register domain with Vercel and generate DNS instructions
 *   2. VERIFY — Check DNS propagation and TLS certificate status
 *   3. REMOVE — Delete domain and clean up deployment aliases
 *
 * Mocks:
 *   VercelDomainClient — narrow interface injected into the service
 *
 * Coverage:
 *   addDomainWithDns         — success with verification requirements,
 *                              success without verification, Vercel rejection,
 *                              network error, apex vs subdomain DNS records.
 *
 *   verifyDnsPropagation     — verified (domain + cert active), domain not verified,
 *                              cert pending, cert error, network error.
 *
 *   removeDomainWithCleanup  — success with no aliases, success with aliases removed,
 *                              domain removal failure, partial failure (domain removed
 *                              but alias cleanup failed), no deployment IDs provided.
 *
 *   getDnsRecords            — apex domain returns A/AAAA, subdomain returns CNAME.
 *
 * Issue: #652 — Vercel Project Domain Alias Lifecycle Management with DNS Automation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    VercelDomainLifecycleService,
    type VercelDomainClient,
    type AddDomainWithDnsResult,
    type DnsPropagationResult,
    type RemoveDomainResult,
} from './vercel-domain-lifecycle.service';
import type { AddDomainResult, DomainVerification, CertificateState } from './vercel.service';

// ── Mock VercelDomainClient ──────────────────────────────────────────────────

class MockVercelDomainClient implements VercelDomainClient {
    addDomain = vi.fn<
        [{ domain: string; projectId?: string; redirect?: boolean; forceHttps?: boolean }],
        Promise<AddDomainResult>
    >();
    verifyDomain = vi.fn<
        [string],
        Promise<{ verified: boolean; requirements?: DomainVerification[] }>
    >();
    getCertificate = vi.fn<
        [string, string],
        Promise<{ domain: string; state: CertificateState; expiresAt?: string; error?: string }>
    >();
    removeDomain = vi.fn<[string, string], Promise<void>>();
    listDeploymentAliases = vi.fn<
        [string],
        Promise<Array<{ uid: string; alias: string }>>
    >();
    listDomains = vi.fn<[string], Promise<Array<{ name: string }>>>();
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('VercelDomainLifecycleService', () => {
    let mockClient: MockVercelDomainClient;
    let service: VercelDomainLifecycleService;

    beforeEach(() => {
        mockClient = new MockVercelDomainClient();
        service = new VercelDomainLifecycleService(mockClient);
        vi.clearAllMocks();
    });

    // ── addDomainWithDns ──────────────────────────────────────────────────────

    describe('addDomainWithDns', () => {
        it('returns success with DNS records and verification requirements', async () => {
            const verificationReqs: DomainVerification[] = [
                {
                    domain: 'example.com',
                    type: 'TXT',
                    value: 'craft-verify-abc123',
                    name: '_craft-verify.example.com',
                },
            ];

            mockClient.addDomain.mockResolvedValue({
                success: true,
                domain: 'example.com',
                verification: verificationReqs,
            });

            const result = await service.addDomainWithDns('example.com', 'prj_123');

            expect(result.success).toBe(true);
            expect(result.domain).toBe('example.com');
            expect(result.dnsRecords.length).toBeGreaterThan(0);
            expect(result.providerInstructions.length).toBeGreaterThan(0);
            expect(result.verificationRequirements).toEqual(verificationReqs);
            expect(mockClient.addDomain).toHaveBeenCalledWith({
                domain: 'example.com',
                projectId: 'prj_123',
            });
        });

        it('returns success without verification requirements', async () => {
            mockClient.addDomain.mockResolvedValue({
                success: true,
                domain: 'app.example.com',
            });

            const result = await service.addDomainWithDns('app.example.com', 'prj_123');

            expect(result.success).toBe(true);
            expect(result.domain).toBe('app.example.com');
            expect(result.dnsRecords.length).toBeGreaterThan(0);
            expect(result.providerInstructions.length).toBeGreaterThan(0);
            expect(result.verificationRequirements).toBeUndefined();
        });

        it('returns failure when Vercel rejects the domain', async () => {
            mockClient.addDomain.mockResolvedValue({
                success: false,
                domain: 'example.com',
                error: 'Domain already exists',
                errorCode: 'DOMAIN_ALREADY_EXISTS',
            });

            const result = await service.addDomainWithDns('example.com', 'prj_123');

            expect(result.success).toBe(false);
            expect(result.domain).toBe('example.com');
            expect(result.dnsRecords).toEqual([]);
            expect(result.providerInstructions).toEqual([]);
            expect(result.error).toBe('Domain already exists');
        });

        it('returns failure when network error occurs', async () => {
            mockClient.addDomain.mockRejectedValue(new Error('Network timeout'));

            const result = await service.addDomainWithDns('example.com', 'prj_123');

            expect(result.success).toBe(false);
            expect(result.domain).toBe('example.com');
            expect(result.dnsRecords).toEqual([]);
            expect(result.providerInstructions).toEqual([]);
            expect(result.error).toBe('Network timeout');
        });

        it('generates A/AAAA records for apex domains', async () => {
            mockClient.addDomain.mockResolvedValue({
                success: true,
                domain: 'example.com',
            });

            const result = await service.addDomainWithDns('example.com', 'prj_123');

            expect(result.success).toBe(true);
            const recordTypes = result.dnsRecords.map((r) => r.type);
            expect(recordTypes).toContain('A');
            expect(recordTypes).toContain('AAAA');
            expect(recordTypes).not.toContain('CNAME');
        });

        it('generates CNAME record for subdomains', async () => {
            mockClient.addDomain.mockResolvedValue({
                success: true,
                domain: 'app.example.com',
            });

            const result = await service.addDomainWithDns('app.example.com', 'prj_123');

            expect(result.success).toBe(true);
            const recordTypes = result.dnsRecords.map((r) => r.type);
            expect(recordTypes).toContain('CNAME');
            expect(recordTypes).not.toContain('A');
            expect(recordTypes).not.toContain('AAAA');
        });
    });

    // ── verifyDnsPropagation ──────────────────────────────────────────────────

    describe('verifyDnsPropagation', () => {
        it('returns verified when domain and certificate are active', async () => {
            mockClient.verifyDomain.mockResolvedValue({ verified: true });
            mockClient.getCertificate.mockResolvedValue({
                domain: 'example.com',
                state: 'active',
                expiresAt: '2025-12-31T23:59:59Z',
            });

            const result = await service.verifyDnsPropagation('example.com', 'prj_123');

            expect(result.verified).toBe(true);
            expect(result.domain).toBe('example.com');
            expect(result.certState).toBe('active');
            expect(result.reason).toBeUndefined();
            expect(result.requirements).toBeUndefined();
        });

        it('returns not verified when domain ownership is not verified', async () => {
            const requirements: DomainVerification[] = [
                {
                    domain: 'example.com',
                    type: 'TXT',
                    value: 'craft-verify-abc123',
                    name: '_craft-verify.example.com',
                },
            ];

            mockClient.verifyDomain.mockResolvedValue({
                verified: false,
                requirements,
            });

            const result = await service.verifyDnsPropagation('example.com', 'prj_123');

            expect(result.verified).toBe(false);
            expect(result.domain).toBe('example.com');
            expect(result.certState).toBe('pending');
            expect(result.requirements).toEqual(requirements);
            expect(result.reason).toBe('Domain ownership not yet verified by Vercel');
        });

        it('returns not verified when certificate is pending', async () => {
            mockClient.verifyDomain.mockResolvedValue({ verified: true });
            mockClient.getCertificate.mockResolvedValue({
                domain: 'example.com',
                state: 'pending',
            });

            const result = await service.verifyDnsPropagation('example.com', 'prj_123');

            expect(result.verified).toBe(false);
            expect(result.domain).toBe('example.com');
            expect(result.certState).toBe('pending');
            expect(result.reason).toBe('TLS certificate is still being provisioned');
        });

        it('returns not verified when certificate provisioning failed', async () => {
            mockClient.verifyDomain.mockResolvedValue({ verified: true });
            mockClient.getCertificate.mockResolvedValue({
                domain: 'example.com',
                state: 'error',
                error: 'DNS records not found',
            });

            const result = await service.verifyDnsPropagation('example.com', 'prj_123');

            expect(result.verified).toBe(false);
            expect(result.domain).toBe('example.com');
            expect(result.certState).toBe('error');
            expect(result.reason).toBe('DNS records not found');
        });

        it('returns not verified when network error occurs', async () => {
            mockClient.verifyDomain.mockRejectedValue(new Error('API timeout'));

            const result = await service.verifyDnsPropagation('example.com', 'prj_123');

            expect(result.verified).toBe(false);
            expect(result.domain).toBe('example.com');
            expect(result.certState).toBe('pending');
            expect(result.reason).toBe('API timeout');
        });

        it('returns not verified when certificate check fails', async () => {
            mockClient.verifyDomain.mockResolvedValue({ verified: true });
            mockClient.getCertificate.mockRejectedValue(new Error('Certificate API error'));

            const result = await service.verifyDnsPropagation('example.com', 'prj_123');

            expect(result.verified).toBe(false);
            expect(result.domain).toBe('example.com');
            expect(result.certState).toBe('pending');
            expect(result.reason).toBe('Certificate API error');
        });
    });

    // ── removeDomainWithCleanup ───────────────────────────────────────────────

    describe('removeDomainWithCleanup', () => {
        it('returns success when domain is removed with no aliases', async () => {
            mockClient.removeDomain.mockResolvedValue(undefined);

            const result = await service.removeDomainWithCleanup(
                'example.com',
                'prj_123',
                [],
            );

            expect(result.success).toBe(true);
            expect(result.domain).toBe('example.com');
            expect(result.aliasesRemoved).toBe(0);
            expect(result.partialFailure).toBeUndefined();
            expect(mockClient.removeDomain).toHaveBeenCalledWith('example.com', 'prj_123');
        });

        it('returns success when domain is removed and aliases are cleaned up', async () => {
            mockClient.removeDomain.mockResolvedValue(undefined);
            mockClient.listDeploymentAliases
                .mockResolvedValueOnce([
                    { uid: 'alias_1', alias: 'example.com' },
                    { uid: 'alias_2', alias: 'www.example.com' },
                ])
                .mockResolvedValueOnce([
                    { uid: 'alias_3', alias: 'app.example.com' },
                ]);

            const result = await service.removeDomainWithCleanup(
                'example.com',
                'prj_123',
                ['dpl_1', 'dpl_2'],
            );

            expect(result.success).toBe(true);
            expect(result.domain).toBe('example.com');
            expect(result.aliasesRemoved).toBe(3);
            expect(result.partialFailure).toBeUndefined();
            expect(mockClient.listDeploymentAliases).toHaveBeenCalledTimes(2);
        });

        it('returns failure when domain removal fails', async () => {
            mockClient.removeDomain.mockRejectedValue(new Error('Vercel API error'));

            const result = await service.removeDomainWithCleanup(
                'example.com',
                'prj_123',
                ['dpl_1'],
            );

            expect(result.success).toBe(false);
            expect(result.domain).toBe('example.com');
            expect(result.aliasesRemoved).toBe(0);
            expect(result.partialFailureReason).toBe('Vercel API error');
            expect(mockClient.listDeploymentAliases).not.toHaveBeenCalled();
        });

        it('returns partial failure when domain is removed but alias cleanup fails', async () => {
            mockClient.removeDomain.mockResolvedValue(undefined);
            mockClient.listDeploymentAliases
                .mockResolvedValueOnce([{ uid: 'alias_1', alias: 'example.com' }])
                .mockRejectedValueOnce(new Error('Alias API error'));

            const result = await service.removeDomainWithCleanup(
                'example.com',
                'prj_123',
                ['dpl_1', 'dpl_2'],
            );

            expect(result.success).toBe(true);
            expect(result.domain).toBe('example.com');
            expect(result.aliasesRemoved).toBe(1);
            expect(result.partialFailure).toBe(true);
            expect(result.partialFailureReason).toContain('Alias cleanup encountered errors');
            expect(result.partialFailureReason).toContain('deployment dpl_2');
        });

        it('skips alias cleanup when no deployment IDs are provided', async () => {
            mockClient.removeDomain.mockResolvedValue(undefined);

            const result = await service.removeDomainWithCleanup(
                'example.com',
                'prj_123',
            );

            expect(result.success).toBe(true);
            expect(result.domain).toBe('example.com');
            expect(result.aliasesRemoved).toBe(0);
            expect(mockClient.listDeploymentAliases).not.toHaveBeenCalled();
        });

        it('counts only matching aliases for the domain', async () => {
            mockClient.removeDomain.mockResolvedValue(undefined);
            mockClient.listDeploymentAliases.mockResolvedValue([
                { uid: 'alias_1', alias: 'example.com' },
                { uid: 'alias_2', alias: 'other-domain.com' },
                { uid: 'alias_3', alias: 'app.example.com' },
            ]);

            const result = await service.removeDomainWithCleanup(
                'example.com',
                'prj_123',
                ['dpl_1'],
            );

            expect(result.success).toBe(true);
            expect(result.aliasesRemoved).toBe(2); // Only example.com and app.example.com
        });

        it('handles multiple deployment alias cleanup errors gracefully', async () => {
            mockClient.removeDomain.mockResolvedValue(undefined);
            mockClient.listDeploymentAliases
                .mockRejectedValueOnce(new Error('Error 1'))
                .mockRejectedValueOnce(new Error('Error 2'))
                .mockResolvedValueOnce([{ uid: 'alias_1', alias: 'example.com' }]);

            const result = await service.removeDomainWithCleanup(
                'example.com',
                'prj_123',
                ['dpl_1', 'dpl_2', 'dpl_3'],
            );

            expect(result.success).toBe(true);
            expect(result.aliasesRemoved).toBe(1);
            expect(result.partialFailure).toBe(true);
            expect(result.partialFailureReason).toContain('deployment dpl_1: Error 1');
            expect(result.partialFailureReason).toContain('deployment dpl_2: Error 2');
        });
    });

    // ── getDnsRecords ─────────────────────────────────────────────────────────

    describe('getDnsRecords', () => {
        it('returns A and AAAA records for apex domains', () => {
            const records = service.getDnsRecords('example.com');

            const types = records.map((r) => r.type);
            expect(types).toContain('A');
            expect(types).toContain('AAAA');
            expect(types).not.toContain('CNAME');
            expect(records.every((r) => r.host === '@')).toBe(true);
        });

        it('returns CNAME record for subdomains', () => {
            const records = service.getDnsRecords('app.example.com');

            expect(records).toHaveLength(1);
            expect(records[0].type).toBe('CNAME');
            expect(records[0].host).toBe('app');
            expect(records[0].value).toBe('cname.vercel-dns.com');
        });

        it('returns CNAME record for multi-level subdomains', () => {
            const records = service.getDnsRecords('api.staging.example.com');

            expect(records).toHaveLength(1);
            expect(records[0].type).toBe('CNAME');
            expect(records[0].host).toBe('api.staging');
            expect(records[0].value).toBe('cname.vercel-dns.com');
        });

        it('includes TTL in all records', () => {
            const apexRecords = service.getDnsRecords('example.com');
            const subRecords = service.getDnsRecords('app.example.com');

            expect(apexRecords.every((r) => r.ttl > 0)).toBe(true);
            expect(subRecords.every((r) => r.ttl > 0)).toBe(true);
        });
    });
});
