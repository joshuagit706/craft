import { describe, it, expect, vi } from 'vitest';
import { xdr, Account, Contract } from 'stellar-sdk';
import {
    getLedgerEntryTtl,
    buildTtlExtensionTransaction,
    buildContractInstanceKey,
    buildContractDataKey,
    checkContractTtl,
    DEFAULT_WARNING_LEDGERS,
    DEFAULT_EXTEND_TO_LEDGERS,
} from './soroban-ttl-manager';

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const SOURCE_KEY = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeKey(contractId: string = CONTRACT_ID): xdr.LedgerKey {
    return buildContractInstanceKey(contractId);
}

function makeTtlClient(liveUntil: number | null, currentLedger: number) {
    const key = makeKey();
    return {
        getLatestLedger: vi.fn().mockResolvedValue({ sequence: currentLedger }),
        getLedgerEntries: vi.fn().mockResolvedValue({
            entries: liveUntil !== null
                ? [{ key, xdr: {} as xdr.LedgerEntry, liveUntilLedgerSeq: liveUntil }]
                : [],
            latestLedger: currentLedger,
        }),
    };
}

function makeTxClient() {
    const fakeAccount = new Account(SOURCE_KEY, '1');
    const fakeTx = { toXDR: vi.fn().mockReturnValue('prepared-tx-xdr') };
    return {
        getAccount: vi.fn().mockResolvedValue(fakeAccount),
        prepareTransaction: vi.fn().mockResolvedValue(fakeTx),
    };
}

// ── buildContractInstanceKey ──────────────────────────────────────────────────

describe('buildContractInstanceKey', () => {
    it('returns an xdr.LedgerKey', () => {
        const key = buildContractInstanceKey(CONTRACT_ID);
        expect(key).toBeInstanceOf(xdr.LedgerKey);
    });

    it('produces the same key as Contract.getFootprint()', () => {
        const key = buildContractInstanceKey(CONTRACT_ID);
        const expected = new Contract(CONTRACT_ID).getFootprint();
        expect(key.toXDR('base64')).toBe(expected.toXDR('base64'));
    });
});

// ── buildContractDataKey ──────────────────────────────────────────────────────

describe('buildContractDataKey', () => {
    it('returns a persistent contract-data ledger key', () => {
        const storageKey = xdr.ScVal.scvSymbol('counter');
        const key = buildContractDataKey(CONTRACT_ID, storageKey);
        expect(key).toBeInstanceOf(xdr.LedgerKey);
        expect(key.switch().name).toBe('contractData');
        expect(key.contractData().durability().name).toBe('persistent');
    });
});

// ── getLedgerEntryTtl ─────────────────────────────────────────────────────────

describe('getLedgerEntryTtl', () => {
    it('returns correct remaining ledgers for a healthy entry', async () => {
        const currentLedger = 1000;
        const liveUntil = 2500;
        const client = makeTtlClient(liveUntil, currentLedger);
        const key = makeKey();

        const [info] = await getLedgerEntryTtl([key], {}, client);

        expect(info.currentLedger).toBe(currentLedger);
        expect(info.liveUntilLedger).toBe(liveUntil);
        expect(info.remainingLedgers).toBe(1500);
        expect(info.isExpired).toBe(false);
        expect(info.isNearExpiration).toBe(false);
    });

    it('sets isNearExpiration when remaining <= warningLedgers', async () => {
        const currentLedger = 1000;
        const liveUntil = 1000 + DEFAULT_WARNING_LEDGERS - 1;
        const client = makeTtlClient(liveUntil, currentLedger);
        const key = makeKey();

        const [info] = await getLedgerEntryTtl([key], {}, client);

        expect(info.isNearExpiration).toBe(true);
        expect(info.isExpired).toBe(false);
    });

    it('sets isNearExpiration=false at exactly the warning boundary', async () => {
        const currentLedger = 1000;
        const liveUntil = 1000 + DEFAULT_WARNING_LEDGERS;
        const client = makeTtlClient(liveUntil, currentLedger);
        const key = makeKey();

        const [info] = await getLedgerEntryTtl([key], {}, client);

        expect(info.isNearExpiration).toBe(false);
    });

    it('sets isExpired when liveUntilLedger <= currentLedger', async () => {
        const currentLedger = 2000;
        const liveUntil = 2000;
        const client = makeTtlClient(liveUntil, currentLedger);
        const key = makeKey();

        const [info] = await getLedgerEntryTtl([key], {}, client);

        expect(info.isExpired).toBe(true);
        expect(info.isNearExpiration).toBe(false);
    });

    it('handles missing entry (entry not returned by node)', async () => {
        const client = makeTtlClient(null, 1000);
        const key = makeKey();

        const [info] = await getLedgerEntryTtl([key], {}, client);

        expect(info.liveUntilLedger).toBeNull();
        expect(info.remainingLedgers).toBeNull();
        expect(info.isExpired).toBe(false);
        expect(info.isNearExpiration).toBe(false);
    });

    it('respects custom warningLedgers threshold', async () => {
        const currentLedger = 1000;
        const liveUntil = 1500;
        const client = makeTtlClient(liveUntil, currentLedger);
        const key = makeKey();

        const [info] = await getLedgerEntryTtl([key], { warningLedgers: 600 }, client);

        expect(info.isNearExpiration).toBe(true);
    });

    it('returns one result per key', async () => {
        const currentLedger = 1000;
        const liveUntil = 2000;

        const k1 = makeKey();
        const k2 = buildContractDataKey(CONTRACT_ID, xdr.ScVal.scvSymbol('balance'));

        const client = {
            getLatestLedger: vi.fn().mockResolvedValue({ sequence: currentLedger }),
            getLedgerEntries: vi.fn().mockResolvedValue({
                entries: [{ key: k1, xdr: {}, liveUntilLedgerSeq: liveUntil }],
                latestLedger: currentLedger,
            }),
        };

        const results = await getLedgerEntryTtl([k1, k2], {}, client);

        expect(results).toHaveLength(2);
        expect(results[0].liveUntilLedger).toBe(liveUntil);
        expect(results[1].liveUntilLedger).toBeNull();
    });
});

// ── buildTtlExtensionTransaction ──────────────────────────────────────────────

describe('buildTtlExtensionTransaction', () => {
    it('returns a non-empty XDR string', async () => {
        const client = makeTxClient();
        const key = makeKey();

        const xdrStr = await buildTtlExtensionTransaction([key], SOURCE_KEY, {}, client);

        expect(typeof xdrStr).toBe('string');
        expect(xdrStr.length).toBeGreaterThan(0);
    });

    it('calls prepareTransaction once', async () => {
        const client = makeTxClient();
        const key = makeKey();

        await buildTtlExtensionTransaction([key], SOURCE_KEY, {}, client);

        expect(client.prepareTransaction).toHaveBeenCalledOnce();
    });

    it('fetches the source account', async () => {
        const client = makeTxClient();
        const key = makeKey();

        await buildTtlExtensionTransaction([key], SOURCE_KEY, {}, client);

        expect(client.getAccount).toHaveBeenCalledWith(SOURCE_KEY);
    });
});

// ── checkContractTtl ──────────────────────────────────────────────────────────

describe('checkContractTtl', () => {
    it('returns ok:true with healthy TTL and no extension tx', async () => {
        const currentLedger = 1000;
        const liveUntil = 5000;
        const ttlClient = makeTtlClient(liveUntil, currentLedger);

        const result = await checkContractTtl(CONTRACT_ID, SOURCE_KEY, {}, ttlClient);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.status.extensionTxXdr).toBeNull();
            expect(result.status.instanceTtl.isNearExpiration).toBe(false);
        }
    });

    it('builds an extension tx when entry is near expiration', async () => {
        const currentLedger = 1000;
        const liveUntil = 1000 + DEFAULT_WARNING_LEDGERS - 1;
        const ttlClient = makeTtlClient(liveUntil, currentLedger);
        const txClient = makeTxClient();

        const result = await checkContractTtl(CONTRACT_ID, SOURCE_KEY, {}, ttlClient, txClient);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.status.extensionTxXdr).toBe('prepared-tx-xdr');
            expect(result.status.instanceTtl.isNearExpiration).toBe(true);
        }
    });

    it('builds an extension tx when entry is already expired', async () => {
        const currentLedger = 2000;
        const liveUntil = 1999;
        const ttlClient = makeTtlClient(liveUntil, currentLedger);
        const txClient = makeTxClient();

        const result = await checkContractTtl(CONTRACT_ID, SOURCE_KEY, {}, ttlClient, txClient);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.status.extensionTxXdr).not.toBeNull();
            expect(result.status.instanceTtl.isExpired).toBe(true);
        }
    });

    it('returns ok:false when the RPC call fails', async () => {
        const ttlClient = {
            getLatestLedger: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
            getLedgerEntries: vi.fn(),
        };

        const result = await checkContractTtl(CONTRACT_ID, SOURCE_KEY, {}, ttlClient);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(typeof result.error).toBe('string');
            expect(result.error.length).toBeGreaterThan(0);
        }
    });

    it('includes the contractId in the status', async () => {
        const ttlClient = makeTtlClient(5000, 1000);

        const result = await checkContractTtl(CONTRACT_ID, SOURCE_KEY, {}, ttlClient);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.status.contractId).toBe(CONTRACT_ID);
        }
    });
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe('TTL constants', () => {
    it('DEFAULT_WARNING_LEDGERS is positive and meaningful', () => {
        expect(DEFAULT_WARNING_LEDGERS).toBeGreaterThan(0);
    });

    it('DEFAULT_EXTEND_TO_LEDGERS exceeds DEFAULT_WARNING_LEDGERS', () => {
        expect(DEFAULT_EXTEND_TO_LEDGERS).toBeGreaterThan(DEFAULT_WARNING_LEDGERS);
    });
});
