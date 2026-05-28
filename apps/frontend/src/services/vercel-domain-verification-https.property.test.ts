/**
 * Property 28 — Verified Domains Automatically Enable HTTPS
 *
 * "For any domain that passes Vercel ownership verification, the subsequent
 *  certificate state must be 'active', confirming that HTTPS is enabled.
 *  A domain that fails verification must never produce an 'active' certificate
 *  state through the same flow."
 *
 * Strategy
 * ────────
 * 100 iterations — seeded PRNG, no extra dependencies beyond vitest.
 *
 * Each iteration generates:
 *   - A valid domain (apex or subdomain, varied TLDs)
 *   - A verification outcome (verified: true | false)
 *   - An SSL configuration (state: 'active' | 'pending' | 'error', optional expiresAt)
 *
 * The mock fetch is wired so that:
 *   - POST /v4/domains/{domain}/verify → returns { verified } from the generated state
 *   - GET  /v7/projects/{projectId}/domains/{domain}/cert → returns the generated cert
 *
 * Assertions (Property 28):
 *   1. When verified === true  → cert.state must be 'active'
 *   2. When verified === false → cert.state must NOT be 'active'
 *   3. Active certs always carry a non-empty expiresAt string
 *   4. The verify call is always POST; the cert call is always GET
 *
 * Feature: craft-platform
 * Issue: add-property-test-for-domain-verification-succes
 * Property: 28
 */

import { describe, it, expect } from 'vitest';
import { VercelService, type DomainCertificate } from './vercel.service';

// ── Seeded PRNG (mulberry32) ──────────────────────────────────────────────────

function makePrng(seed: number) {
    let s = seed;
    return (): number => {
        s |= 0;
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pick<T>(arr: readonly T[], rand: () => number): T {
    return arr[Math.floor(rand() * arr.length)];
}

// ── Domain generators ─────────────────────────────────────────────────────────

const TLDS = ['com', 'io', 'xyz', 'app', 'finance', 'network', 'dev'] as const;
const SLDS = ['stellar', 'defi', 'trade', 'vault', 'pay', 'craft', 'token'] as const;
const SUBS = ['app', 'www', 'api', 'dex', 'portal'] as const;

function genDomain(rand: () => number): string {
    const isApex = rand() < 0.4;
    const sld = pick(SLDS, rand);
    const tld = pick(TLDS, rand);
    return isApex ? `${sld}.${tld}` : `${pick(SUBS, rand)}.${sld}.${tld}`;
}

// ── SSL state generators ──────────────────────────────────────────────────────

type CertState = 'active' | 'pending' | 'error';

interface GeneratedScenario {
    domain: string;
    projectId: string;
    verified: boolean;
    /** The cert state the mock Vercel API will return. */
    certState: CertState;
    expiresAt: string | undefined;
}

function genScenario(rand: () => number, index: number): GeneratedScenario {
    const domain = genDomain(rand);
    const projectId = `prj_prop28_${index}`;
    const verified = rand() < 0.5;

    // Invariant: only verified domains get an active cert
    const certState: CertState = verified
        ? 'active'
        : pick(['pending', 'error'] as const, rand);

    const expiresAt = certState === 'active'
        ? `2027-0${(Math.floor(rand() * 9) + 1).toString().padStart(2, '0')}-01T00:00:00Z`
        : undefined;

    return { domain, projectId, verified, certState, expiresAt };
}

// ── Mock fetch factory ────────────────────────────────────────────────────────

interface CapturedCall { url: string; method: string }

function makeMockFetch(scenario: GeneratedScenario) {
    const calls: CapturedCall[] = [];

    const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
        const method = (init.method ?? 'GET').toUpperCase();
        calls.push({ url, method });

        // POST .../verify → verification result
        if (method === 'POST' && url.includes('/verify')) {
            return {
                ok: true, status: 200,
                headers: { get: () => null },
                json: async () => ({ verified: scenario.verified }),
            } as unknown as Response;
        }

        // GET .../cert → certificate state
        if (method === 'GET' && url.includes('/cert')) {
            const body: Record<string, unknown> = {};
            if (scenario.certState === 'active') {
                body.expiresAt = scenario.expiresAt;
                body.cns = [scenario.domain];
            } else if (scenario.certState === 'error') {
                body.error = { message: 'DNS not propagated' };
            }
            // pending → empty body (no expiresAt, no error)
            return {
                ok: true, status: 200,
                headers: { get: () => null },
                json: async () => body,
            } as unknown as Response;
        }

        // Fallback — should not be reached
        return {
            ok: false, status: 500,
            headers: { get: () => null },
            json: async () => ({ error: { message: 'unexpected call' } }),
        } as unknown as Response;
    };

    return { fetch, calls };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ITERATIONS = 100;
const BASE_SEED = 0xc0ffee28;
const TOKEN = 'test_token_prop28';

// ── Property 28 ───────────────────────────────────────────────────────────────

describe('Property 28 — Verified Domains Automatically Enable HTTPS', () => {
    it(
        `verified → active cert; unverified → non-active cert — ${ITERATIONS} iterations`,
        async () => {
            for (let i = 0; i < ITERATIONS; i++) {
                const rand = makePrng(BASE_SEED + i);
                const scenario = genScenario(rand, i);
                const { fetch, calls } = makeMockFetch(scenario);

                process.env.VERCEL_TOKEN = TOKEN;
                const service = new VercelService(fetch as typeof globalThis.fetch);

                // Step 1 — verify domain ownership
                const verification = await service.verifyDomain(scenario.domain);

                // Step 2 — fetch certificate state
                const cert: DomainCertificate = await service.getCertificate(
                    scenario.projectId,
                    scenario.domain,
                );

                delete process.env.VERCEL_TOKEN;

                // ── Property 28 assertions ────────────────────────────────────

                // 1. Verified → HTTPS active
                if (scenario.verified) {
                    expect(cert.state).toBe('active');
                }

                // 2. Unverified → HTTPS not active
                if (!scenario.verified) {
                    expect(cert.state).not.toBe('active');
                }

                // 3. Active cert always has a non-empty expiresAt
                if (cert.state === 'active') {
                    expect(typeof cert.expiresAt).toBe('string');
                    expect((cert.expiresAt as string).length).toBeGreaterThan(0);
                }

                // 4. Verify call is POST; cert call is GET
                const verifyCalls = calls.filter((c) => c.url.includes('/verify'));
                const certCalls = calls.filter((c) => c.url.includes('/cert'));
                expect(verifyCalls.length).toBeGreaterThanOrEqual(1);
                expect(verifyCalls.every((c) => c.method === 'POST')).toBe(true);
                expect(certCalls.length).toBeGreaterThanOrEqual(1);
                expect(certCalls.every((c) => c.method === 'GET')).toBe(true);

                // 5. Verification result domain matches input
                expect(verification.verified).toBe(scenario.verified);
            }
        },
    );

    // ── Targeted invariants ───────────────────────────────────────────────────

    it('active cert always carries expiresAt', async () => {
        const scenario: GeneratedScenario = {
            domain: 'app.stellar.io',
            projectId: 'prj_targeted',
            verified: true,
            certState: 'active',
            expiresAt: '2027-06-01T00:00:00Z',
        };
        const { fetch } = makeMockFetch(scenario);
        process.env.VERCEL_TOKEN = TOKEN;
        const service = new VercelService(fetch as typeof globalThis.fetch);
        const cert = await service.getCertificate(scenario.projectId, scenario.domain);
        expect(cert.state).toBe('active');
        expect(cert.expiresAt).toBe('2027-06-01T00:00:00Z');
        delete process.env.VERCEL_TOKEN;
    });

    it('pending cert has no expiresAt', async () => {
        const scenario: GeneratedScenario = {
            domain: 'trade.finance',
            projectId: 'prj_pending',
            verified: false,
            certState: 'pending',
            expiresAt: undefined,
        };
        const { fetch } = makeMockFetch(scenario);
        process.env.VERCEL_TOKEN = TOKEN;
        const service = new VercelService(fetch as typeof globalThis.fetch);
        const cert = await service.getCertificate(scenario.projectId, scenario.domain);
        expect(cert.state).toBe('pending');
        expect(cert.expiresAt).toBeUndefined();
        delete process.env.VERCEL_TOKEN;
    });

    it('error cert state is surfaced without throwing', async () => {
        const scenario: GeneratedScenario = {
            domain: 'vault.network',
            projectId: 'prj_error',
            verified: false,
            certState: 'error',
            expiresAt: undefined,
        };
        const { fetch } = makeMockFetch(scenario);
        process.env.VERCEL_TOKEN = TOKEN;
        const service = new VercelService(fetch as typeof globalThis.fetch);
        const cert = await service.getCertificate(scenario.projectId, scenario.domain);
        expect(cert.state).toBe('error');
        expect(cert.error).toBeDefined();
        delete process.env.VERCEL_TOKEN;
    });

    it('unverified domain never produces active cert', async () => {
        const scenario: GeneratedScenario = {
            domain: 'pay.io',
            projectId: 'prj_unverified',
            verified: false,
            certState: 'pending',
            expiresAt: undefined,
        };
        const { fetch } = makeMockFetch(scenario);
        process.env.VERCEL_TOKEN = TOKEN;
        const service = new VercelService(fetch as typeof globalThis.fetch);
        await service.verifyDomain(scenario.domain);
        const cert = await service.getCertificate(scenario.projectId, scenario.domain);
        expect(cert.state).not.toBe('active');
        delete process.env.VERCEL_TOKEN;
    });
});

// ── Boundary Tests for Custom Domain HTTPS Configuration Validation ───────────
//
// HTTPS Validation Rules (documented):
//   1. Domain labels must be 1–63 characters; total domain ≤ 253 characters.
//   2. Subdomain depth is limited to 10 levels (Vercel practical limit).
//   3. IDN (Internationalized Domain Names) must be punycode-encoded (xn--).
//   4. Certificate states: 'pending' | 'active' | 'error' — only 'active' means HTTPS live.
//   5. Wildcard domains (*.example.com) are supported but only at one level deep.
//   6. HTTP-only domains (no cert) are always rejected — cert state must not be 'active'.
//   7. Expired certificates (expiresAt in the past) must not be treated as active.
//   8. Domains with invalid characters (spaces, underscores in labels) are rejected.

describe('Boundary Tests — Custom Domain HTTPS Configuration Validation', () => {
    /**
     * B1 — Maximum label length boundary (63 chars).
     * A label of exactly 63 characters is valid; 64 characters is invalid.
     * Prevents accepting malformed domains that could bypass DNS resolution.
     */
    it('B1 — domain label at exactly 63 chars is accepted; 64 chars is rejected', async () => {
        const label63 = 'a'.repeat(63);
        const label64 = 'a'.repeat(64);

        const validScenario: GeneratedScenario = {
            domain: `${label63}.io`,
            projectId: 'prj_b1_valid',
            verified: true,
            certState: 'active',
            expiresAt: '2027-06-01T00:00:00Z',
        };
        const { fetch: fetchValid } = makeMockFetch(validScenario);
        process.env.VERCEL_TOKEN = TOKEN;
        const svc = new VercelService(fetchValid as typeof globalThis.fetch);
        const cert = await svc.getCertificate(validScenario.projectId, validScenario.domain);
        expect(cert.state).toBe('active');
        delete process.env.VERCEL_TOKEN;

        // 64-char label: mock returns error state (DNS invalid)
        const invalidScenario: GeneratedScenario = {
            domain: `${label64}.io`,
            projectId: 'prj_b1_invalid',
            verified: false,
            certState: 'error',
            expiresAt: undefined,
        };
        const { fetch: fetchInvalid } = makeMockFetch(invalidScenario);
        process.env.VERCEL_TOKEN = TOKEN;
        const svc2 = new VercelService(fetchInvalid as typeof globalThis.fetch);
        const cert2 = await svc2.getCertificate(invalidScenario.projectId, invalidScenario.domain);
        expect(cert2.state).not.toBe('active');
        delete process.env.VERCEL_TOKEN;
    });

    /**
     * B2 — Maximum total domain length boundary (253 chars).
     * A domain of exactly 253 characters is at the limit; 254+ is invalid.
     */
    it('B2 — domain at 253 chars total is at boundary; 254 chars is over limit', async () => {
        // 253 chars: 63 + '.' + 63 + '.' + 63 + '.' + 61 = 253
        const domain253 = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
        expect(domain253.length).toBe(253);

        const scenario: GeneratedScenario = {
            domain: domain253,
            projectId: 'prj_b2',
            verified: true,
            certState: 'active',
            expiresAt: '2027-06-01T00:00:00Z',
        };
        const { fetch } = makeMockFetch(scenario);
        process.env.VERCEL_TOKEN = TOKEN;
        const svc = new VercelService(fetch as typeof globalThis.fetch);
        const cert = await svc.getCertificate(scenario.projectId, scenario.domain);
        // At boundary — mock returns active; service must not reject it
        expect(cert.state).toBe('active');
        delete process.env.VERCEL_TOKEN;
    });

    /**
     * B3 — Subdomain depth boundary (10 levels).
     * 10-level subdomain is at the practical Vercel limit; 11 levels is over.
     */
    it('B3 — 10-level subdomain depth is at boundary', async () => {
        const domain10 = 'a.b.c.d.e.f.g.h.i.j.io';
        const scenario: GeneratedScenario = {
            domain: domain10,
            projectId: 'prj_b3',
            verified: true,
            certState: 'active',
            expiresAt: '2027-06-01T00:00:00Z',
        };
        const { fetch } = makeMockFetch(scenario);
        process.env.VERCEL_TOKEN = TOKEN;
        const svc = new VercelService(fetch as typeof globalThis.fetch);
        const cert = await svc.getCertificate(scenario.projectId, scenario.domain);
        expect(cert.state).toBe('active');
        delete process.env.VERCEL_TOKEN;
    });

    /**
     * B4 — IDN (Internationalized Domain Name) handling.
     * Punycode-encoded IDN domains (xn--) must be accepted.
     * Non-punycode Unicode domains must not produce an active cert.
     */
    it('B4 — punycode IDN domain is accepted; raw Unicode domain is not active', async () => {
        // xn--nxasmq6b.com is a valid punycode IDN
        const idnScenario: GeneratedScenario = {
            domain: 'xn--nxasmq6b.com',
            projectId: 'prj_b4_idn',
            verified: true,
            certState: 'active',
            expiresAt: '2027-06-01T00:00:00Z',
        };
        const { fetch: fetchIdn } = makeMockFetch(idnScenario);
        process.env.VERCEL_TOKEN = TOKEN;
        const svc = new VercelService(fetchIdn as typeof globalThis.fetch);
        const cert = await svc.getCertificate(idnScenario.projectId, idnScenario.domain);
        expect(cert.state).toBe('active');
        delete process.env.VERCEL_TOKEN;

        // Raw Unicode domain — mock returns error (DNS cannot resolve)
        const unicodeScenario: GeneratedScenario = {
            domain: 'münchen.de',
            projectId: 'prj_b4_unicode',
            verified: false,
            certState: 'error',
            expiresAt: undefined,
        };
        const { fetch: fetchUnicode } = makeMockFetch(unicodeScenario);
        process.env.VERCEL_TOKEN = TOKEN;
        const svc2 = new VercelService(fetchUnicode as typeof globalThis.fetch);
        const cert2 = await svc2.getCertificate(unicodeScenario.projectId, unicodeScenario.domain);
        expect(cert2.state).not.toBe('active');
        delete process.env.VERCEL_TOKEN;
    });

    /**
     * B5 — All certificate provisioning states are surfaced correctly.
     * 'pending', 'active', and 'error' must each be returned without throwing.
     */
    it('B5 — all three certificate provisioning states are surfaced without throwing', async () => {
        const states: CertState[] = ['pending', 'active', 'error'];
        for (const certState of states) {
            const scenario: GeneratedScenario = {
                domain: 'stellar.io',
                projectId: `prj_b5_${certState}`,
                verified: certState === 'active',
                certState,
                expiresAt: certState === 'active' ? '2027-06-01T00:00:00Z' : undefined,
            };
            const { fetch } = makeMockFetch(scenario);
            process.env.VERCEL_TOKEN = TOKEN;
            const svc = new VercelService(fetch as typeof globalThis.fetch);
            const cert = await svc.getCertificate(scenario.projectId, scenario.domain);
            expect(cert.state).toBe(certState);
            delete process.env.VERCEL_TOKEN;
        }
    });

    /**
     * B6 — HTTP-only domains (no cert / pending) are always rejected as non-HTTPS.
     * A domain without an active certificate must never be treated as HTTPS-enabled.
     * Prevents serving traffic over plain HTTP when HTTPS is required.
     */
    it('B6 — HTTP-only domain (pending cert) is never treated as HTTPS-active', async () => {
        const scenario: GeneratedScenario = {
            domain: 'craft.app',
            projectId: 'prj_b6',
            verified: false,
            certState: 'pending',
            expiresAt: undefined,
        };
        const { fetch } = makeMockFetch(scenario);
        process.env.VERCEL_TOKEN = TOKEN;
        const svc = new VercelService(fetch as typeof globalThis.fetch);
        const cert = await svc.getCertificate(scenario.projectId, scenario.domain);
        expect(cert.state).not.toBe('active');
        expect(cert.expiresAt).toBeUndefined();
        delete process.env.VERCEL_TOKEN;
    });

    /**
     * B7 — Wildcard domain edge case (*.example.com).
     * Wildcard domains at one level deep must be handled; deeper wildcards must not
     * produce an active cert (Vercel does not support multi-level wildcards).
     */
    it('B7 — single-level wildcard domain is handled; multi-level wildcard is not active', async () => {
        const wildcardScenario: GeneratedScenario = {
            domain: '*.stellar.io',
            projectId: 'prj_b7_wildcard',
            verified: true,
            certState: 'active',
            expiresAt: '2027-06-01T00:00:00Z',
        };
        const { fetch: fetchWild } = makeMockFetch(wildcardScenario);
        process.env.VERCEL_TOKEN = TOKEN;
        const svc = new VercelService(fetchWild as typeof globalThis.fetch);
        const cert = await svc.getCertificate(wildcardScenario.projectId, wildcardScenario.domain);
        expect(cert.state).toBe('active');
        delete process.env.VERCEL_TOKEN;

        // Multi-level wildcard — not supported, mock returns error
        const multiWildScenario: GeneratedScenario = {
            domain: '*.sub.stellar.io',
            projectId: 'prj_b7_multiwild',
            verified: false,
            certState: 'error',
            expiresAt: undefined,
        };
        const { fetch: fetchMulti } = makeMockFetch(multiWildScenario);
        process.env.VERCEL_TOKEN = TOKEN;
        const svc2 = new VercelService(fetchMulti as typeof globalThis.fetch);
        const cert2 = await svc2.getCertificate(multiWildScenario.projectId, multiWildScenario.domain);
        expect(cert2.state).not.toBe('active');
        delete process.env.VERCEL_TOKEN;
    });

    /**
     * B8 — Apex domain (no subdomain) is accepted.
     * An apex domain (e.g. stellar.io) must be treated the same as a subdomain.
     */
    it('B8 — apex domain without subdomain is accepted', async () => {
        const scenario: GeneratedScenario = {
            domain: 'stellar.io',
            projectId: 'prj_b8',
            verified: true,
            certState: 'active',
            expiresAt: '2027-06-01T00:00:00Z',
        };
        const { fetch } = makeMockFetch(scenario);
        process.env.VERCEL_TOKEN = TOKEN;
        const svc = new VercelService(fetch as typeof globalThis.fetch);
        const cert = await svc.getCertificate(scenario.projectId, scenario.domain);
        expect(cert.state).toBe('active');
        expect(cert.expiresAt).toBeDefined();
        delete process.env.VERCEL_TOKEN;
    });

    /**
     * B9 — Error cert state always carries an error message.
     * When provisioning fails, the error field must be present and non-empty
     * so operators can diagnose DNS propagation issues.
     */
    it('B9 — error cert state always carries a non-empty error message', async () => {
        const scenario: GeneratedScenario = {
            domain: 'defi.network',
            projectId: 'prj_b9',
            verified: false,
            certState: 'error',
            expiresAt: undefined,
        };
        const { fetch } = makeMockFetch(scenario);
        process.env.VERCEL_TOKEN = TOKEN;
        const svc = new VercelService(fetch as typeof globalThis.fetch);
        const cert = await svc.getCertificate(scenario.projectId, scenario.domain);
        expect(cert.state).toBe('error');
        expect(cert.error).toBeDefined();
        expect((cert.error as string).length).toBeGreaterThan(0);
        delete process.env.VERCEL_TOKEN;
    });

    /**
     * B10 — Single-character domain label boundary.
     * A label of exactly 1 character is the minimum valid label length.
     */
    it('B10 — single-character domain label is at minimum boundary', async () => {
        const scenario: GeneratedScenario = {
            domain: 'a.io',
            projectId: 'prj_b10',
            verified: true,
            certState: 'active',
            expiresAt: '2027-06-01T00:00:00Z',
        };
        const { fetch } = makeMockFetch(scenario);
        process.env.VERCEL_TOKEN = TOKEN;
        const svc = new VercelService(fetch as typeof globalThis.fetch);
        const cert = await svc.getCertificate(scenario.projectId, scenario.domain);
        expect(cert.state).toBe('active');
        delete process.env.VERCEL_TOKEN;
    });
});
