# Stellar Network Configuration Reference

This document provides a comprehensive reference for Stellar network-specific configurations used in CRAFT deployments.

## Network Overview

CRAFT supports two Stellar networks:

| Property | Testnet | Mainnet |
|----------|---------|---------|
| **Network Name** | testnet | mainnet |
| **Purpose** | Development & Testing | Production |
| **Ledger Reset** | Periodic | Never |
| **Data Persistence** | Temporary | Permanent |

## Network Passphrases

The network passphrase is used to sign transactions and must match the target network exactly.

| Network | Passphrase |
|---------|-----------|
| **Testnet** | `Test SDF Network ; September 2015` |
| **Mainnet** | `Public Global Stellar Network ; September 2015` |

**Critical**: Mismatched passphrases will cause transaction submission failures.

## Horizon API Endpoints

Horizon is the REST API for interacting with the Stellar network.

| Network | Endpoint | Health Check |
|---------|----------|--------------|
| **Testnet** | `https://horizon-testnet.stellar.org` | `/health` |
| **Mainnet** | `https://horizon.stellar.org` | `/health` |

### Horizon Rate Limits

- **Testnet**: 3,600 requests per hour (1 req/sec)
- **Mainnet**: 3,600 requests per hour (1 req/sec)

## Soroban RPC Endpoints

Soroban RPC is used for smart contract interactions.

| Network | Endpoint |
|---------|----------|
| **Testnet** | `https://soroban-testnet.stellar.org` |
| **Mainnet** | `https://mainnet.stellar.validationcloud.io/v1/soroban/rpc` |

### Soroban RPC Methods

- `getNetwork` - Get network information
- `getLatestLedger` - Get latest ledger sequence
- `getTransaction` - Get transaction details
- `sendTransaction` - Submit transaction

## Network Parameters

These parameters are consistent across both networks:

| Parameter | Value |
|-----------|-------|
| **Base Reserve** | 0.5 XLM |
| **Base Fee** | 100 stroops (0.00001 XLM) |
| **Max Transaction Size** | 102,400 bytes |
| **Ledger Close Time** | ~5 seconds |

## Standard Asset Codes

| Asset | Code | Testnet Issuer | Mainnet Issuer |
|-------|------|---|---|
| **Stellar Lumens** | XLM | Native | Native |
| **USD Coin** | USDC | `GBBD47UZQ5SYWDRFGWCMA3BKPXZMBTUY3MQQ5DUMPYTSKZPNPS6BUUJM` | `GA5ZSEJYB37JRC5AVCIA5MOP4SHAIF5KVW5WO6YUWT33UKSCT6EPSESM` |
| **Euro Coin** | EURC | `GBBD47UZQ5SYWDRFGWCMA3BKPXZMBTUY3MQQ5DUMPYTSKZPNPS6BUUJM` | `GBBD47UZQ5SYWDRFGWCMA3BKPXZMBTUY3MQQ5DUMPYTSKZPNPS6BUUJM` |

## Configuration Validation

### Passphrase Mismatch Detection

CRAFT validates that the configured passphrase matches the target network:

```typescript
// ✅ Correct
const testnetConfig = {
  network: 'testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  horizonUrl: 'https://horizon-testnet.stellar.org',
};

// ❌ Incorrect - Passphrase mismatch
const invalidConfig = {
  network: 'testnet',
  networkPassphrase: 'Public Global Stellar Network ; September 2015', // Wrong!
  horizonUrl: 'https://horizon-testnet.stellar.org',
};
```

### Configuration Consistency Checks

CRAFT performs the following consistency checks:

1. **Network Name Validation**: Ensures network name is 'testnet' or 'mainnet'
2. **Passphrase Validation**: Verifies passphrase matches the network
3. **Horizon URL Validation**: Confirms Horizon URL is appropriate for the network
4. **Soroban RPC URL Validation**: Confirms Soroban RPC URL is appropriate for the network
5. **HTTPS Requirement**: All endpoints must use HTTPS

## Environment Configuration

### Setting the Network

Configure the network via environment variables:

```bash
# Testnet (default)
STELLAR_NETWORK=testnet
NEXT_PUBLIC_STELLAR_NETWORK=testnet

# Mainnet
STELLAR_NETWORK=mainnet
NEXT_PUBLIC_STELLAR_NETWORK=mainnet
```

### Configuration Resolution

CRAFT resolves the network configuration in this order:

1. `STELLAR_NETWORK` environment variable
2. `NEXT_PUBLIC_STELLAR_NETWORK` environment variable
3. Default: `testnet`

## Testing Considerations

### Testnet Testing

- Use testnet for development and testing
- Testnet is periodically reset (check Stellar docs for schedule)
- Testnet funds are free via the Friendbot faucet
- Testnet data is not persistent

### Mainnet Considerations

- Use mainnet only for production deployments
- Mainnet transactions are permanent and irreversible
- Mainnet requires real XLM for transaction fees
- Mainnet data is persistent forever

## Common Configuration Errors

### Error: "Passphrase mismatch"

**Cause**: The configured passphrase doesn't match the target network.

**Solution**: Verify the passphrase matches:
- Testnet: `Test SDF Network ; September 2015`
- Mainnet: `Public Global Stellar Network ; September 2015`

### Error: "Horizon endpoint unreachable"

**Cause**: The Horizon URL is incorrect or the endpoint is down.

**Solution**: Verify the Horizon URL:
- Testnet: `https://horizon-testnet.stellar.org`
- Mainnet: `https://horizon.stellar.org`

### Error: "Invalid asset issuer"

**Cause**: The asset issuer is not valid for the target network.

**Solution**: Use the correct issuer for the network:
- Testnet: Use testnet issuers
- Mainnet: Use mainnet issuers

## Network Divergence

The following values differ between testnet and mainnet:

| Property | Testnet | Mainnet |
|----------|---------|---------|
| Network Passphrase | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |
| Horizon URL | `https://horizon-testnet.stellar.org` | `https://horizon.stellar.org` |
| Soroban RPC URL | `https://soroban-testnet.stellar.org` | `https://mainnet.stellar.validationcloud.io/v1/soroban/rpc` |
| Asset Issuers | Testnet-specific | Mainnet-specific |

## References

- [Stellar Documentation](https://developers.stellar.org/)
- [Horizon API Reference](https://developers.stellar.org/api/introduction/authentication/)
- [Soroban Documentation](https://soroban.stellar.org/)
- [Network Passphrases](https://developers.stellar.org/docs/glossary/network-passphrase)
