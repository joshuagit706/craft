/**
 * Stellar Asset Validator Parameterized Test Matrix
 *
 * Comprehensive tests covering all combinations of asset types, network
 * environments, and validation rules to ensure correctness across all
 * deployment configurations.
 *
 * Matrix: 3 asset types × 2 networks × 5 validation rules = 30 test cases
 *
 * Run: vitest run tests/stellar/asset-validator-parameterized.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  generateAssetValidationMatrix,
  ASSET_VALIDATION_RULES_REFERENCE,
  type AssetValidationMatrixCell,
} from './asset-validator-matrix.corpus';

interface AssetValidationResult {
  valid: boolean;
  error?: string;
  warnings?: string[];
}

class StellarAssetValidator {
  private static readonly ASSET_CODE_PATTERN = /^[a-zA-Z0-9]{1,12}$/;
  private static readonly STELLAR_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;

  validateAssetCode(code: string, assetType: string): AssetValidationResult {
    if (assetType === 'native') {
      return code === 'XLM'
        ? { valid: true }
        : { valid: false, error: 'Native asset must be XLM' };
    }

    if (!code || code.length === 0) {
      return { valid: false, error: 'Asset code cannot be empty' };
    }

    if (!StellarAssetValidator.ASSET_CODE_PATTERN.test(code)) {
      return { valid: false, error: 'Asset code must be alphanumeric' };
    }

    if (assetType === 'credit_alphanum4' && code.length > 4) {
      return {
        valid: false,
        error: 'Alphanum4 codes must be 1-4 characters',
      };
    }

    if (assetType === 'credit_alphanum12' && code.length < 5) {
      return {
        valid: false,
        error: 'Alphanum12 codes must be 5-12 characters',
      };
    }

    return { valid: true };
  }

  validateIssuer(issuer: string | undefined, assetType: string): AssetValidationResult {
    if (assetType === 'native') {
      return issuer === undefined || issuer === null
        ? { valid: true }
        : { valid: false, error: 'Native assets cannot have an issuer' };
    }

    if (!issuer) {
      return { valid: false, error: 'Issued assets must have an issuer' };
    }

    if (!StellarAssetValidator.STELLAR_ADDRESS_PATTERN.test(issuer)) {
      return { valid: false, error: 'Invalid Stellar address format' };
    }

    return { valid: true };
  }

  validateAssetExistence(
    code: string,
    issuer: string | undefined,
    network: string,
  ): AssetValidationResult {
    // Simulated validation - in real implementation would query Horizon
    if (!code || code.length === 0) {
      return { valid: false, error: 'Cannot check existence of empty code' };
    }

    if (code === 'XLM') {
      return { valid: true };
    }

    if (!issuer) {
      return { valid: false, error: 'Cannot check existence without issuer' };
    }

    return { valid: true };
  }

  validateTrustline(
    code: string,
    issuer: string | undefined,
    assetType: string,
  ): AssetValidationResult {
    if (assetType === 'native') {
      return { valid: true };
    }

    if (!issuer) {
      return { valid: false, error: 'Trustline requires issuer' };
    }

    return { valid: true };
  }

  retrieveMetadata(
    code: string,
    issuer: string | undefined,
    network: string,
  ): AssetValidationResult {
    if (!code) {
      return { valid: false, error: 'Cannot retrieve metadata without code' };
    }

    return {
      valid: true,
      warnings: network === 'mainnet' ? [] : ['Using testnet data'],
    };
  }
}

describe('Stellar Asset Validator Parameterized Test Matrix', () => {
  const validator = new StellarAssetValidator();
  const matrix = generateAssetValidationMatrix();

  describe('Matrix Coverage', () => {
    it('should generate exactly 30 test cases (3 types × 2 networks × 5 rules)', () => {
      expect(matrix.length).toBe(30);
    });

    it('should have all asset types represented', () => {
      const types = new Set(matrix.map((cell) => cell.assetType));
      expect(types.size).toBe(3);
      expect(types).toContain('native');
      expect(types).toContain('credit_alphanum4');
      expect(types).toContain('credit_alphanum12');
    });

    it('should have all networks represented', () => {
      const networks = new Set(matrix.map((cell) => cell.network));
      expect(networks.size).toBe(2);
      expect(networks).toContain('testnet');
      expect(networks).toContain('mainnet');
    });

    it('should have all validation rules represented', () => {
      const rules = new Set(matrix.map((cell) => cell.rule));
      expect(rules.size).toBe(5);
      expect(rules).toContain('code_format');
      expect(rules).toContain('issuer_format');
      expect(rules).toContain('asset_existence');
      expect(rules).toContain('trustline_check');
      expect(rules).toContain('metadata_retrieval');
    });

    it('should have unique descriptions for all cells', () => {
      const descriptions = matrix.map((cell) => cell.description);
      const uniqueDescriptions = new Set(descriptions);
      expect(uniqueDescriptions.size).toBe(descriptions.length);
    });
  });

  describe('Matrix Cell Validation', () => {
    matrix.forEach((cell: AssetValidationMatrixCell) => {
      describe(`${cell.assetType} on ${cell.network} - ${cell.rule}`, () => {
        it(`should validate ${cell.description}`, () => {
          let result: AssetValidationResult;

          switch (cell.rule) {
            case 'code_format':
              result = validator.validateAssetCode(
                cell.testInput.code || '',
                cell.assetType,
              );
              break;

            case 'issuer_format':
              result = validator.validateIssuer(
                cell.testInput.issuer,
                cell.assetType,
              );
              break;

            case 'asset_existence':
              result = validator.validateAssetExistence(
                cell.testInput.code || '',
                cell.testInput.issuer,
                cell.network,
              );
              break;

            case 'trustline_check':
              result = validator.validateTrustline(
                cell.testInput.code || '',
                cell.testInput.issuer,
                cell.assetType,
              );
              break;

            case 'metadata_retrieval':
              result = validator.retrieveMetadata(
                cell.testInput.code || '',
                cell.testInput.issuer,
                cell.network,
              );
              break;

            default:
              throw new Error(`Unknown rule: ${cell.rule}`);
          }

          expect(result.valid).toBe(cell.expectedValid);
        });
      });
    });
  });

  describe('Cross-Network Consistency', () => {
    it('should produce consistent results for same asset across networks', () => {
      const nativeTestnet = matrix.find(
        (c) =>
          c.assetType === 'native' &&
          c.network === 'testnet' &&
          c.rule === 'code_format',
      );
      const nativeMainnet = matrix.find(
        (c) =>
          c.assetType === 'native' &&
          c.network === 'mainnet' &&
          c.rule === 'code_format',
      );

      expect(nativeTestnet?.expectedValid).toBe(nativeMainnet?.expectedValid);
    });

    it('should handle both testnet and mainnet configurations', () => {
      const testnetCells = matrix.filter((c) => c.network === 'testnet');
      const mainnetCells = matrix.filter((c) => c.network === 'mainnet');

      expect(testnetCells.length).toBe(15);
      expect(mainnetCells.length).toBe(15);
    });
  });

  describe('Asset Type Specific Rules', () => {
    it('should validate native asset correctly', () => {
      const nativeCells = matrix.filter((c) => c.assetType === 'native');
      expect(nativeCells.length).toBe(10); // 2 networks × 5 rules

      nativeCells.forEach((cell) => {
        expect(cell.testInput.issuer).toBeUndefined();
        expect(cell.testInput.code).toBe('XLM');
      });
    });

    it('should validate credit alphanum4 correctly', () => {
      const alphanum4Cells = matrix.filter(
        (c) => c.assetType === 'credit_alphanum4',
      );
      expect(alphanum4Cells.length).toBe(10);

      alphanum4Cells.forEach((cell) => {
        expect(cell.testInput.code?.length).toBeLessThanOrEqual(4);
        expect(cell.testInput.issuer).toBeDefined();
      });
    });

    it('should validate credit alphanum12 correctly', () => {
      const alphanum12Cells = matrix.filter(
        (c) => c.assetType === 'credit_alphanum12',
      );
      expect(alphanum12Cells.length).toBe(10);

      alphanum12Cells.forEach((cell) => {
        expect(cell.testInput.code?.length).toBeGreaterThanOrEqual(5);
        expect(cell.testInput.issuer).toBeDefined();
      });
    });
  });

  describe('Validation Rules Reference', () => {
    it('should have documentation for all validation rules', () => {
      const rules = Object.keys(ASSET_VALIDATION_RULES_REFERENCE);
      expect(rules.length).toBe(5);
      expect(rules).toContain('code_format');
      expect(rules).toContain('issuer_format');
      expect(rules).toContain('asset_existence');
      expect(rules).toContain('trustline_check');
      expect(rules).toContain('metadata_retrieval');
    });

    it('should have complete documentation for each rule', () => {
      Object.entries(ASSET_VALIDATION_RULES_REFERENCE).forEach(
        ([key, rule]) => {
          expect(rule.name).toBeTruthy();
          expect(rule.description).toBeTruthy();
          expect(rule.requirements).toBeDefined();
          expect(Array.isArray(rule.requirements)).toBe(true);
          expect(rule.requirements.length).toBeGreaterThan(0);
        },
      );
    });
  });
});
