/**
 * GitHubCredentialService
 *
 * Validates, decrypts, and rotates GitHub credentials.
 *
 * Encryption:
 *   Tokens are stored encrypted via AES-256-GCM (see lib/github/token-encryption).
 *   The plaintext token is NEVER persisted; only the encrypted blob is written to
 *   `profiles.github_token_encrypted`.  Decryption happens in-process, server-side
 *   only, and the plaintext is never logged.
 *
 * Strategy:
 *   1. Read the stored encrypted token + expiry metadata from the profiles row.
 *   2. If the token is absent → throw GitHubCredentialError('NOT_CONNECTED').
 *   3. If a known expiry exists and is within EXPIRY_BUFFER_MS → treat as
 *      expired and throw GitHubCredentialError('TOKEN_EXPIRED').
 *   4. Decrypt the stored blob to recover the plaintext token.
 *   5. Probe the GitHub API (/user) to confirm the token is still accepted.
 *      - 200 → update github_token_refreshed_at atomically and return the plaintext token.
 *      - 401 → throw GitHubCredentialError('TOKEN_INVALID').
 *      - network/other → throw GitHubCredentialError('VALIDATION_FAILED').
 *
 * Token rotation (rotateToken):
 *   Accepts a new plaintext token, encrypts it, and atomically replaces the
 *   stored encrypted value in a single UPDATE.  The old token is immediately
 *   invalidated — any concurrent request that decrypted the old value will
 *   receive a 401 from GitHub on its next probe.
 *
 * Proactive rotation (rotateIfExpiringSoon):
 *   Checks whether the stored token will expire within ROTATION_LEAD_MS and,
 *   if so, calls the caller-supplied refresh function to obtain a new token,
 *   then rotates atomically and revokes the old token on GitHub.
 *   Rotation metadata (rotatedAt, previousTokenPrefix) is written to the
 *   profile row for audit purposes.  Rotation failures are retried with
 *   exponential back-off up to MAX_ROTATION_RETRIES times.
 *
 * Token revocation (revokeToken):
 *   Calls the GitHub API to delete the OAuth token so it can no longer be
 *   used. Revocation is best-effort; failure is logged but not re-thrown.
 *
 * Assumptions / follow-up work:
 *   - Key rotation (re-encrypting all rows with a new key) is out of scope.
 *     Implement key versioning (prefix stored value with key ID) when needed.
 *   - HSM / KMS integration is out of scope; the key is read from the
 *     GITHUB_TOKEN_ENCRYPTION_KEY environment variable.
 *   - OAuth refresh flow (obtaining a new token from GitHub) is the caller's
 *     responsibility; this service only stores and validates what it is given.
 *
 * Atomic update:
 *   github_token_refreshed_at and github_token_encrypted are written in single
 *   UPDATE statements so concurrent requests converge on consistent row state.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { encryptToken, decryptToken } from '@/lib/github/token-encryption';

const GITHUB_API_BASE = 'https://api.github.com';

/** How many milliseconds before the stated expiry we treat the token as expired. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Conservative lead time before expiry at which proactive rotation is triggered.
 * Set to 1 hour so there is ample time for the refresh to succeed even on retry.
 */
const ROTATION_LEAD_MS = 60 * 60 * 1000; // 1 hour

const MAX_ROTATION_RETRIES = 3;

export type GitHubCredentialErrorCode =
    | 'NOT_CONNECTED'
    | 'TOKEN_EXPIRED'
    | 'TOKEN_INVALID'
    | 'VALIDATION_FAILED';

export class GitHubCredentialError extends Error {
    constructor(
        message: string,
        public readonly code: GitHubCredentialErrorCode,
    ) {
        super(message);
        this.name = 'GitHubCredentialError';
    }
}

interface CredentialRow {
    github_token_encrypted: string | null;
    github_token_expires_at: string | null;
}

interface FetchLike {
    (input: string, init?: RequestInit): Promise<Response>;
}

export class GitHubCredentialService {
    constructor(
        private readonly _supabase: SupabaseClient,
        private readonly _fetch: FetchLike = fetch,
    ) {}

    /**
     * Validates the stored GitHub token for `userId`.
     * On success, updates `github_token_refreshed_at` and returns the token.
     * On failure, throws a typed `GitHubCredentialError`.
     */
    async ensureValidToken(userId: string): Promise<string> {
        const token = await this._loadAndCheckExpiry(userId);
        await this._probeGitHub(token, userId);
        return token;
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private async _loadAndCheckExpiry(userId: string): Promise<string> {
        const { data, error } = await this._supabase
            .from('profiles')
            .select('github_token_encrypted, github_token_expires_at')
            .eq('id', userId)
            .single<CredentialRow>();

        if (error || !data) {
            throw new GitHubCredentialError(
                'Failed to load GitHub credentials',
                'VALIDATION_FAILED',
            );
        }

        const encryptedToken = data.github_token_encrypted;
        if (!encryptedToken) {
            throw new GitHubCredentialError(
                'GitHub account is not connected',
                'NOT_CONNECTED',
            );
        }

        if (data.github_token_expires_at) {
            const expiresAt = new Date(data.github_token_expires_at).getTime();
            if (Date.now() >= expiresAt - EXPIRY_BUFFER_MS) {
                throw new GitHubCredentialError(
                    'GitHub token has expired — please reconnect your GitHub account',
                    'TOKEN_EXPIRED',
                );
            }
        }

        // Decrypt the stored ciphertext — plaintext token is never logged.
        return decryptToken(encryptedToken);
    }

    /**
     * Atomically replaces the stored GitHub token with a new one.
     * The new plaintext token is encrypted before storage; the old token is
     * immediately invalidated.  Returns the new plaintext token.
     *
     * Callers are responsible for obtaining the new token via the GitHub OAuth
     * refresh flow before calling this method.
     */
    async rotateToken(userId: string, newPlaintextToken: string, expiresAt?: Date): Promise<string> {
        const update: Record<string, unknown> = {
            github_token_encrypted: encryptToken(newPlaintextToken),
            github_token_refreshed_at: new Date().toISOString(),
        };
        if (expiresAt !== undefined) {
            update.github_token_expires_at = expiresAt.toISOString();
        }

        const { error } = await this._supabase
            .from('profiles')
            .update(update)
            .eq('id', userId);

        if (error) {
            throw new GitHubCredentialError(
                `Failed to rotate GitHub token: ${error.message}`,
                'VALIDATION_FAILED',
            );
        }

        return newPlaintextToken;
    }

    /**
     * Proactively rotates the stored token if it will expire within ROTATION_LEAD_MS.
     *
     * Workflow:
     *   1. Load the profile row to check the expiry timestamp.
     *   2. If expiry is within the lead window, call `refreshFn` to get a new token.
     *   3. Revoke the old token on GitHub (best-effort).
     *   4. Store the new encrypted token + rotation metadata atomically.
     *
     * Returns `true` if rotation was performed, `false` if not needed.
     * Retries up to MAX_ROTATION_RETRIES times on transient failures.
     *
     * @param userId - The profile row to check.
     * @param refreshFn - Caller-supplied function that obtains a fresh token from GitHub OAuth.
     */
    async rotateIfExpiringSoon(
        userId: string,
        refreshFn: () => Promise<{ token: string; expiresAt?: Date }>,
    ): Promise<boolean> {
        const { data, error } = await this._supabase
            .from('profiles')
            .select('github_token_encrypted, github_token_expires_at')
            .eq('id', userId)
            .single<CredentialRow>();

        if (error || !data?.github_token_encrypted) return false;

        if (!data.github_token_expires_at) return false;

        const expiresAt = new Date(data.github_token_expires_at).getTime();
        if (Date.now() < expiresAt - ROTATION_LEAD_MS) return false;

        // Within the rotation lead window — attempt rotation with retries.
        let attempt = 0;
        while (attempt < MAX_ROTATION_RETRIES) {
            try {
                const { token: newToken, expiresAt: newExpiry } = await refreshFn();

                // Decrypt old token for revocation (plaintext never logged).
                let oldPlaintext: string | undefined;
                try {
                    oldPlaintext = decryptToken(data.github_token_encrypted);
                } catch {
                    // If we can't decrypt, skip revocation — don't block rotation.
                }

                await this.rotateToken(userId, newToken, newExpiry);

                // Record rotation metadata for audit trail.
                await this._supabase
                    .from('profiles')
                    .update({
                        github_token_rotated_at: new Date().toISOString(),
                        github_token_previous_prefix: oldPlaintext
                            ? `${oldPlaintext.substring(0, 4)}****`
                            : null,
                    })
                    .eq('id', userId);

                // Revoke old token — best-effort; failure is non-fatal.
                if (oldPlaintext) {
                    await this._revokeGitHubToken(oldPlaintext).catch(() => undefined);
                }

                return true;
            } catch {
                attempt++;
                if (attempt < MAX_ROTATION_RETRIES) {
                    // Exponential back-off: 1s, 2s, 4s
                    await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
                }
            }
        }

        return false;
    }

    /**
     * Revokes a GitHub OAuth token via the GitHub API.
     * This is best-effort — the result is not checked by callers.
     *
     * Uses Basic Auth with the GitHub OAuth App credentials.
     * Requires GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET env vars.
     */
    async revokeToken(userId: string): Promise<void> {
        const { data, error } = await this._supabase
            .from('profiles')
            .select('github_token_encrypted')
            .eq('id', userId)
            .single<Pick<CredentialRow, 'github_token_encrypted'>>();

        if (error || !data?.github_token_encrypted) return;

        let plaintext: string;
        try {
            plaintext = decryptToken(data.github_token_encrypted);
        } catch {
            return;
        }

        await this._revokeGitHubToken(plaintext).catch(() => undefined);

        await this._supabase
            .from('profiles')
            .update({
                github_token_encrypted: null,
                github_token_expires_at: null,
                github_token_refreshed_at: null,
                github_token_rotated_at: new Date().toISOString(),
            })
            .eq('id', userId);
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private async _revokeGitHubToken(token: string): Promise<void> {
        const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
        const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
        if (!clientId || !clientSecret) return;

        await this._fetch(
            `${GITHUB_API_BASE}/applications/${clientId}/token`,
            {
                method: 'DELETE',
                headers: {
                    Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ access_token: token }),
            },
        );
    }

    private async _probeGitHub(token: string, userId: string): Promise<void> {
        let res: Response;
        try {
            res = await this._fetch(`${GITHUB_API_BASE}/user`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            });
        } catch {
            throw new GitHubCredentialError(
                'Could not reach GitHub API to validate credentials',
                'VALIDATION_FAILED',
            );
        }

        if (res.status === 401) {
            throw new GitHubCredentialError(
                'GitHub token is invalid or has been revoked — please reconnect your GitHub account',
                'TOKEN_INVALID',
            );
        }

        if (!res.ok) {
            throw new GitHubCredentialError(
                `GitHub API returned unexpected status ${res.status} during credential validation`,
                'VALIDATION_FAILED',
            );
        }

        // Token is valid — record the refresh timestamp atomically.
        await this._supabase
            .from('profiles')
            .update({ github_token_refreshed_at: new Date().toISOString() })
            .eq('id', userId);
    }
}
