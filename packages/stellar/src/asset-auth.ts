/**
 * Stellar Asset Issuance Authorization Flag Validation
 *
 * Validates authorization flag combinations for Stellar asset issuance,
 * ensuring that authorization settings are consistent and valid.
 *
 * Authorization Flags:
 * - AUTH_REQUIRED: Requires authorization for accounts to hold the asset
 * - AUTH_REVOCABLE: Allows issuer to revoke authorization
 * - AUTH_IMMUTABLE: Makes authorization settings permanent (cannot be changed)
 *
 * Flag Rules:
 * - AUTH_IMMUTABLE conflicts with AUTH_REVOCABLE (cannot be both immutable and revocable)
 * - AUTH_REVOCABLE requires AUTH_REQUIRED (cannot revoke if authorization not required)
 * - Once AUTH_IMMUTABLE is set, no flags can be changed
 */

export interface AssetAuthorizationFlags {
  authRequired?: boolean;
  authRevocable?: boolean;
  authImmutable?: boolean;
}

export interface AuthorizationValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

/**
 * Validates asset authorization flag combinations.
 *
 * @param flags - Authorization flags to validate
 * @returns Validation result with errors and warnings
 *
 * @example
 * ```typescript
 * const result = validateAuthorizationFlags({
 *   authRequired: true,
 *   authRevocable: true,
 *   authImmutable: false
 * });
 * if (!result.valid) {
 *   console.error('Invalid flags:', result.errors);
 * }
 * ```
 */
export function validateAuthorizationFlags(
  flags: AssetAuthorizationFlags
): AuthorizationValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const { authRequired, authRevocable, authImmutable } = flags;

  // Rule 1: AUTH_IMMUTABLE conflicts with AUTH_REVOCABLE
  if (authImmutable && authRevocable) {
    errors.push(
      'AUTH_IMMUTABLE and AUTH_REVOCABLE cannot both be enabled. ' +
      'An immutable asset cannot have revocable authorization.'
    );
  }

  // Rule 2: AUTH_REVOCABLE requires AUTH_REQUIRED
  if (authRevocable && !authRequired) {
    errors.push(
      'AUTH_REVOCABLE requires AUTH_REQUIRED to be enabled. ' +
      'Cannot revoke authorization if authorization is not required.'
    );
  }

  // Warning: AUTH_IMMUTABLE makes settings permanent
  if (authImmutable) {
    warnings.push(
      'AUTH_IMMUTABLE makes authorization settings permanent. ' +
      'Once set, flags cannot be changed. Ensure this is intended.'
    );
  }

  // Warning: AUTH_REQUIRED without AUTH_REVOCABLE
  if (authRequired && !authRevocable && !authImmutable) {
    warnings.push(
      'AUTH_REQUIRED is enabled without AUTH_REVOCABLE. ' +
      'Consider if you need the ability to revoke authorization in the future.'
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Validates authorization flags and throws if invalid.
 *
 * @param flags - Authorization flags to validate
 * @throws Error if flags are invalid
 *
 * @example
 * ```typescript
 * try {
 *   assertValidAuthorizationFlags({ authImmutable: true, authRevocable: true });
 * } catch (error) {
 *   console.error('Invalid configuration:', error.message);
 * }
 * ```
 */
export function assertValidAuthorizationFlags(
  flags: AssetAuthorizationFlags
): void {
  const result = validateAuthorizationFlags(flags);
  
  if (!result.valid) {
    throw new Error(
      `Invalid asset authorization flags:\n${result.errors.join('\n')}`
    );
  }
}

/**
 * Gets a human-readable description of authorization flag combination.
 *
 * @param flags - Authorization flags to describe
 * @returns Description of the authorization configuration
 *
 * @example
 * ```typescript
 * const desc = describeAuthorizationFlags({
 *   authRequired: true,
 *   authRevocable: false,
 *   authImmutable: true
 * });
 * console.log(desc);
 * // "Authorization required, not revocable, immutable (permanent)"
 * ```
 */
export function describeAuthorizationFlags(
  flags: AssetAuthorizationFlags
): string {
  const parts: string[] = [];

  if (flags.authRequired) {
    parts.push('authorization required');
  } else {
    parts.push('no authorization required');
  }

  if (flags.authRevocable) {
    parts.push('revocable');
  } else if (flags.authRequired) {
    parts.push('not revocable');
  }

  if (flags.authImmutable) {
    parts.push('immutable (permanent)');
  }

  return parts.join(', ').replace(/^./, str => str.toUpperCase());
}

/**
 * Checks if authorization flags represent a locked/immutable configuration.
 *
 * @param flags - Authorization flags to check
 * @returns True if configuration is immutable
 */
export function isImmutableConfiguration(
  flags: AssetAuthorizationFlags
): boolean {
  return flags.authImmutable === true;
}

/**
 * Checks if authorization flags allow the issuer to control access.
 *
 * @param flags - Authorization flags to check
 * @returns True if issuer has control over who can hold the asset
 */
export function hasIssuerControl(
  flags: AssetAuthorizationFlags
): boolean {
  return flags.authRequired === true;
}

/**
 * Checks if authorization flags allow the issuer to revoke access.
 *
 * @param flags - Authorization flags to check
 * @returns True if issuer can revoke authorization
 */
export function canRevokeAuthorization(
  flags: AssetAuthorizationFlags
): boolean {
  return flags.authRequired === true && flags.authRevocable === true;
}
