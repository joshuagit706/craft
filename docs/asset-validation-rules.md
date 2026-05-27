# Stellar Asset Validation Rules Reference

This document describes the validation rules used by the Stellar Asset Validator service across all deployment configurations.

## Overview

The asset validator ensures that Stellar assets are correctly formatted and exist on the network. It covers three asset types across two network environments with five distinct validation rules.

### Test Matrix Coverage

- **Asset Types**: 3 (native, credit_alphanum4, credit_alphanum12)
- **Networks**: 2 (testnet, mainnet)
- **Validation Rules**: 5
- **Total Test Cases**: 30 (3 × 2 × 5)

## Validation Rules

### 1. Asset Code Format

**Name**: Asset Code Format  
**Description**: Validates that asset codes follow Stellar specifications

#### Requirements

- Native assets must use code "XLM"
- Credit alphanum4 codes must be 1-4 alphanumeric characters
- Credit alphanum12 codes must be 5-12 alphanumeric characters
- Codes are case-insensitive
- Only alphanumeric characters (A-Z, 0-9) are allowed

#### Examples

| Asset Type | Valid Codes | Invalid Codes |
| --- | --- | --- |
| Native | XLM | USD, STELLAR |
| Alphanum4 | USD, USDC, EUR, BTC | USDCOIN, 12345 |
| Alphanum12 | STELLARCOIN, MYTOKEN123 | XLM, VERYLONGCOINNAME |

### 2. Issuer Address Format

**Name**: Issuer Address Format  
**Description**: Validates that issuer addresses are valid Stellar accounts

#### Requirements

- Native assets have no issuer
- Issued assets must have a valid Stellar public key
- Public keys start with "G" and are 56 characters long
- Public keys use base32 encoding (A-Z, 2-7)
- Issuer addresses must be checksummed correctly

#### Examples

| Asset Type | Valid Issuer | Invalid Issuer |
| --- | --- | --- |
| Native | (none) | GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5XNXNXNXNXN |
| Alphanum4 | GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5XNXNXNXNXN | invalid-address |
| Alphanum12 | GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBTICSW2D2CEUC5MJ6VRITMNX | GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5XNXNXNXNXO |

### 3. Asset Existence Check

**Name**: Asset Existence Check  
**Description**: Verifies that an asset exists on the Stellar network

#### Requirements

- Query Horizon API for asset records
- Check both testnet and mainnet as configured
- Handle network timeouts gracefully (5-second timeout)
- Cache results to reduce API calls (1-hour TTL)
- Return supply information when available

#### Network Endpoints

- **Testnet**: `https://horizon-testnet.stellar.org`
- **Mainnet**: `https://horizon.stellar.org`

#### Response Format

```json
{
  "exists": true,
  "assetCode": "USDC",
  "issuer": "GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5XNXNXNXNXN",
  "supply": "1000000.0000000"
}
```

### 4. Trustline Verification

**Name**: Trustline Verification  
**Description**: Confirms that an account has a trustline for an asset

#### Requirements

- Native assets (XLM) require no trustline
- Issued assets require explicit trustline establishment
- Check trustline balance and limits
- Verify trustline authorization status
- Detect frozen trustlines

#### Trustline States

| State | Description | Can Trade |
| --- | --- | --- |
| Authorized | Trustline is active and authorized | Yes |
| Unauthorized | Trustline exists but not authorized | No |
| Frozen | Trustline is frozen by issuer | No |
| Non-existent | No trustline established | No |

### 5. Asset Metadata Retrieval

**Name**: Asset Metadata Retrieval  
**Description**: Fetches metadata about an asset from the network

#### Requirements

- Retrieve asset supply information
- Get number of accounts holding the asset
- Fetch asset flags and authorization settings
- Handle missing metadata gracefully
- Support both testnet and mainnet queries

#### Metadata Fields

```json
{
  "code": "USDC",
  "issuer": "GBRPYHIL2CI3WHZDTOOQFC6EB4KJJGUJJBBX7UYXNMWX5XNXNXNXNXN",
  "supply": "1000000.0000000",
  "numAccounts": 5000,
  "flags": {
    "authRequired": false,
    "authRevocable": false,
    "authImmutable": false
  }
}
```

## Cross-Network Validation

The validator ensures consistent behavior across testnet and mainnet:

- **Code Format**: Same rules apply to both networks
- **Issuer Format**: Same validation rules for both networks
- **Asset Existence**: Queries appropriate network endpoint
- **Trustline Check**: Validates against correct network
- **Metadata**: Retrieves from correct network

## Error Handling

All validation errors return typed `AssetValidationResult` objects:

```typescript
interface AssetValidationResult {
  valid: boolean;
  error?: string;
  warnings?: string[];
}
```

### Common Error Messages

| Error | Cause | Resolution |
| --- | --- | --- |
| "Asset code cannot be empty" | Code is missing or empty | Provide a valid asset code |
| "Asset code must be alphanumeric" | Code contains invalid characters | Use only A-Z and 0-9 |
| "Invalid Stellar address format" | Issuer is not a valid public key | Use a valid Stellar account address |
| "Native assets cannot have an issuer" | XLM asset has issuer specified | Remove issuer for native assets |
| "Issued assets must have an issuer" | Non-native asset missing issuer | Provide issuer address |

## Testing

The asset validator is tested using a parameterized test matrix covering all 30 combinations:

```bash
# Run all asset validator tests
npm run test -- tests/stellar/asset-validator-parameterized.test.ts

# Run specific asset type tests
npm run test -- tests/stellar/asset-validator-parameterized.test.ts -t "native"

# Run specific network tests
npm run test -- tests/stellar/asset-validator-parameterized.test.ts -t "mainnet"

# Run specific rule tests
npm run test -- tests/stellar/asset-validator-parameterized.test.ts -t "code_format"
```

## Implementation Notes

- All validators are synchronous except for `validateAssetExistence` and `retrieveMetadata`
- Network calls include exponential backoff retry logic
- Results are cached to minimize API calls
- Validators throw no exceptions; all errors are returned in the result object
