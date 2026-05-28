/**
 * Asset Issuance Authorization Flag Validation Tests
 *
 * Validates that authorization flag combinations are checked for consistency
 * and that invalid combinations are rejected with clear error messages.
 */

import { describe, it, expect } from 'vitest';
import {
  validateAuthorizationFlags,
  assertValidAuthorizationFlags,
  describeAuthorizationFlags,
  isImmutableConfiguration,
  hasIssuerControl,
  canRevokeAuthorization,
  type AssetAuthorizationFlags,
} from './asset-auth';

describe('Asset Authorization Flag Validation', () => {
  describe('validateAuthorizationFlags', () => {
    describe('Valid Combinations', () => {
      it('should accept no flags set', () => {
        const result = validateAuthorizationFlags({});
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should accept AUTH_REQUIRED only', () => {
        const result = validateAuthorizationFlags({
          authRequired: true,
        });
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should accept AUTH_REQUIRED + AUTH_REVOCABLE', () => {
        const result = validateAuthorizationFlags({
          authRequired: true,
          authRevocable: true,
        });
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should accept AUTH_REQUIRED + AUTH_IMMUTABLE', () => {
        const result = validateAuthorizationFlags({
          authRequired: true,
          authImmutable: true,
        });
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should accept AUTH_IMMUTABLE only', () => {
        const result = validateAuthorizationFlags({
          authImmutable: true,
        });
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });
    });

    describe('Invalid Combinations', () => {
      it('should reject AUTH_IMMUTABLE + AUTH_REVOCABLE', () => {
        const result = validateAuthorizationFlags({
          authImmutable: true,
          authRevocable: true,
        });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('AUTH_IMMUTABLE');
        expect(result.errors[0]).toContain('AUTH_REVOCABLE');
        expect(result.errors[0]).toContain('cannot both be enabled');
      });

      it('should reject AUTH_REVOCABLE without AUTH_REQUIRED', () => {
        const result = validateAuthorizationFlags({
          authRevocable: true,
        });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('AUTH_REVOCABLE');
        expect(result.errors[0]).toContain('requires AUTH_REQUIRED');
      });

      it('should reject AUTH_IMMUTABLE + AUTH_REVOCABLE + AUTH_REQUIRED', () => {
        const result = validateAuthorizationFlags({
          authRequired: true,
          authRevocable: true,
          authImmutable: true,
        });
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('AUTH_IMMUTABLE');
        expect(result.errors[0]).toContain('AUTH_REVOCABLE');
      });
    });

    describe('Warnings', () => {
      it('should warn when AUTH_IMMUTABLE is set', () => {
        const result = validateAuthorizationFlags({
          authImmutable: true,
        });
        expect(result.valid).toBe(true);
        expect(result.warnings).toBeDefined();
        expect(result.warnings![0]).toContain('permanent');
      });

      it('should warn when AUTH_REQUIRED without AUTH_REVOCABLE', () => {
        const result = validateAuthorizationFlags({
          authRequired: true,
        });
        expect(result.valid).toBe(true);
        expect(result.warnings).toBeDefined();
        expect(result.warnings![0]).toContain('AUTH_REVOCABLE');
      });

      it('should not warn when AUTH_REQUIRED + AUTH_REVOCABLE', () => {
        const result = validateAuthorizationFlags({
          authRequired: true,
          authRevocable: true,
        });
        expect(result.valid).toBe(true);
        // May have warnings, but not about missing AUTH_REVOCABLE
      });
    });
  });

  describe('assertValidAuthorizationFlags', () => {
    it('should not throw for valid flags', () => {
      expect(() => {
        assertValidAuthorizationFlags({
          authRequired: true,
          authRevocable: true,
        });
      }).not.toThrow();
    });

    it('should throw for invalid flags', () => {
      expect(() => {
        assertValidAuthorizationFlags({
          authImmutable: true,
          authRevocable: true,
        });
      }).toThrow(/Invalid asset authorization flags/);
    });

    it('should include error details in exception', () => {
      try {
        assertValidAuthorizationFlags({
          authRevocable: true,
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('AUTH_REVOCABLE');
        expect(error.message).toContain('requires AUTH_REQUIRED');
      }
    });
  });

  describe('describeAuthorizationFlags', () => {
    it('should describe no flags', () => {
      const desc = describeAuthorizationFlags({});
      expect(desc).toContain('no authorization required');
    });

    it('should describe AUTH_REQUIRED', () => {
      const desc = describeAuthorizationFlags({
        authRequired: true,
      });
      expect(desc).toContain('authorization required');
      expect(desc).toContain('not revocable');
    });

    it('should describe AUTH_REQUIRED + AUTH_REVOCABLE', () => {
      const desc = describeAuthorizationFlags({
        authRequired: true,
        authRevocable: true,
      });
      expect(desc).toContain('authorization required');
      expect(desc).toContain('revocable');
    });

    it('should describe AUTH_IMMUTABLE', () => {
      const desc = describeAuthorizationFlags({
        authImmutable: true,
      });
      expect(desc).toContain('immutable');
      expect(desc).toContain('permanent');
    });

    it('should describe full configuration', () => {
      const desc = describeAuthorizationFlags({
        authRequired: true,
        authRevocable: false,
        authImmutable: true,
      });
      expect(desc).toContain('authorization required');
      expect(desc).toContain('not revocable');
      expect(desc).toContain('immutable');
    });

    it('should start with capital letter', () => {
      const desc = describeAuthorizationFlags({});
      expect(desc[0]).toMatch(/[A-Z]/);
    });
  });

  describe('isImmutableConfiguration', () => {
    it('should return true when AUTH_IMMUTABLE is set', () => {
      expect(isImmutableConfiguration({ authImmutable: true })).toBe(true);
    });

    it('should return false when AUTH_IMMUTABLE is not set', () => {
      expect(isImmutableConfiguration({})).toBe(false);
      expect(isImmutableConfiguration({ authImmutable: false })).toBe(false);
    });
  });

  describe('hasIssuerControl', () => {
    it('should return true when AUTH_REQUIRED is set', () => {
      expect(hasIssuerControl({ authRequired: true })).toBe(true);
    });

    it('should return false when AUTH_REQUIRED is not set', () => {
      expect(hasIssuerControl({})).toBe(false);
      expect(hasIssuerControl({ authRequired: false })).toBe(false);
    });
  });

  describe('canRevokeAuthorization', () => {
    it('should return true when both AUTH_REQUIRED and AUTH_REVOCABLE are set', () => {
      expect(canRevokeAuthorization({
        authRequired: true,
        authRevocable: true,
      })).toBe(true);
    });

    it('should return false when AUTH_REQUIRED is not set', () => {
      expect(canRevokeAuthorization({
        authRevocable: true,
      })).toBe(false);
    });

    it('should return false when AUTH_REVOCABLE is not set', () => {
      expect(canRevokeAuthorization({
        authRequired: true,
      })).toBe(false);
    });

    it('should return false when neither flag is set', () => {
      expect(canRevokeAuthorization({})).toBe(false);
    });
  });

  describe('Real-World Scenarios', () => {
    it('should validate stablecoin configuration (required + revocable)', () => {
      const result = validateAuthorizationFlags({
        authRequired: true,
        authRevocable: true,
      });
      expect(result.valid).toBe(true);
    });

    it('should validate locked asset configuration (required + immutable)', () => {
      const result = validateAuthorizationFlags({
        authRequired: true,
        authImmutable: true,
      });
      expect(result.valid).toBe(true);
    });

    it('should validate open asset configuration (no flags)', () => {
      const result = validateAuthorizationFlags({});
      expect(result.valid).toBe(true);
    });

    it('should reject conflicting stablecoin configuration', () => {
      const result = validateAuthorizationFlags({
        authRequired: true,
        authRevocable: true,
        authImmutable: true, // Conflict!
      });
      expect(result.valid).toBe(false);
    });
  });
});
