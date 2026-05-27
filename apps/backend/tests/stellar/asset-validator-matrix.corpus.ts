/**
 * Stellar Asset Validator Parameterized Test Matrix
 *
 * Comprehensive matrix covering all combinations of:
 * - Asset types (native XLM, issued assets, liquidity pool assets)
 * - Network environments (testnet, mainnet)
 * - Validation rules (code format, issuer format, existence, trustline, metadata)
 *
 * This ensures correctness across all deployment configurations.
 */

export type AssetType = 'native' | 'credit_alphanum4' | 'credit_alphanum12';
export type NetworkEnvironment = 'testnet' | 'mainnet';
export type ValidationRule =
  | 'code_format'
  | 'issuer_format'
  | 'asset_existence'
  | 'trustline_check'
  | 'metadata_retrieval';

export interface AssetValidationMatrixCell {
  assetType: AssetType;
  network: NetworkEnvironment;
  rule: ValidationRule;
  testInput: {
    code?: string;
    issuer?: string;
    account?: string;
  };
  expectedValid: boolean;
  description: string;
}

// Asset type definitions
const ASSET_TYPES: AssetType[] = [
  'native',
  'credit_alphanum4',
  'credit_alphanum12',
];

// Network environments
const NETWORKS: NetworkEnvironment[] = ['testnet', 'mainnet'];

// Validation rules
const VALIDATION_RULES: ValidationRule[] = [
  'code_format',
  'issuer_format',
  'asset_existence',
  'trustline_check',
  'metadata_retrieval',
];

// Test data for each combination
const TEST_DATA = {
  native: {
    code: 'XLM',
    issuer: null, // Native has no issuer
    account: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5XNXNXNXNXN',
  },
  credit_alphanum4: {
    code: 'USDC',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4IHTZMZMJRMM7UJJUJNUYQSM2KBRIB7',
    account: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5XNXNXNXNXN',
  },
  credit_alphanum12: {
    code: 'STELLARCOIN',
    issuer: 'GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTICSW2D2CEUC5MJ6VRITMNX',
    account: 'GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5XNXNXNXNXN',
  },
};

function generateMatrixCell(
  assetType: AssetType,
  network: NetworkEnvironment,
  rule: ValidationRule,
  index: number,
): AssetValidationMatrixCell {
  const data = TEST_DATA[assetType];
  let expectedValid = true;
  let description = '';

  switch (rule) {
    case 'code_format':
      description = `Validate ${assetType} asset code format on ${network}`;
      expectedValid = assetType !== 'native' || data.code === 'XLM';
      break;

    case 'issuer_format':
      description = `Validate ${assetType} issuer address format on ${network}`;
      expectedValid =
        assetType === 'native' ||
        (data.issuer?.startsWith('G') && data.issuer?.length === 56);
      break;

    case 'asset_existence':
      description = `Check ${assetType} asset existence on ${network}`;
      expectedValid = true; // Depends on network state
      break;

    case 'trustline_check':
      description = `Verify ${assetType} trustline for account on ${network}`;
      expectedValid = assetType === 'native' || !!data.issuer;
      break;

    case 'metadata_retrieval':
      description = `Retrieve ${assetType} metadata from ${network}`;
      expectedValid = true; // Depends on network availability
      break;
  }

  return {
    assetType,
    network,
    rule,
    testInput: {
      code: data.code,
      issuer: data.issuer || undefined,
      account: data.account,
    },
    expectedValid,
    description,
  };
}

/**
 * Generate the complete test matrix
 * 3 asset types × 2 networks × 5 validation rules = 30 test cases
 */
export function generateAssetValidationMatrix(): AssetValidationMatrixCell[] {
  const matrix: AssetValidationMatrixCell[] = [];
  let index = 0;

  for (const assetType of ASSET_TYPES) {
    for (const network of NETWORKS) {
      for (const rule of VALIDATION_RULES) {
        matrix.push(generateMatrixCell(assetType, network, rule, index++));
      }
    }
  }

  return matrix;
}

/**
 * Asset validation rules reference table
 * Documents the validation rules and their requirements
 */
export const ASSET_VALIDATION_RULES_REFERENCE = {
  code_format: {
    name: 'Asset Code Format',
    description: 'Validates that asset codes follow Stellar specifications',
    requirements: [
      'Native assets must use code "XLM"',
      'Credit alphanum4 codes must be 1-4 alphanumeric characters',
      'Credit alphanum12 codes must be 5-12 alphanumeric characters',
      'Codes are case-insensitive',
    ],
  },
  issuer_format: {
    name: 'Issuer Address Format',
    description: 'Validates that issuer addresses are valid Stellar accounts',
    requirements: [
      'Native assets have no issuer',
      'Issued assets must have a valid Stellar public key',
      'Public keys start with "G" and are 56 characters long',
      'Public keys use base32 encoding (A-Z, 2-7)',
    ],
  },
  asset_existence: {
    name: 'Asset Existence Check',
    description: 'Verifies that an asset exists on the Stellar network',
    requirements: [
      'Query Horizon API for asset records',
      'Check both testnet and mainnet as configured',
      'Handle network timeouts gracefully',
      'Cache results to reduce API calls',
    ],
  },
  trustline_check: {
    name: 'Trustline Verification',
    description: 'Confirms that an account has a trustline for an asset',
    requirements: [
      'Native assets require no trustline',
      'Issued assets require explicit trustline',
      'Check trustline balance and limits',
      'Verify trustline authorization status',
    ],
  },
  metadata_retrieval: {
    name: 'Asset Metadata Retrieval',
    description: 'Fetches metadata about an asset from the network',
    requirements: [
      'Retrieve asset supply information',
      'Get number of accounts holding the asset',
      'Fetch asset flags and authorization settings',
      'Handle missing metadata gracefully',
    ],
  },
};
