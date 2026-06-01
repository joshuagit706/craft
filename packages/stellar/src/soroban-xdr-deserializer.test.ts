import { describe, it, expect } from 'vitest';
import { xdr, StrKey } from 'stellar-sdk';
import { deserializeScVal, deserializeScValAs, SorobanDeserializationError } from './soroban-xdr-deserializer';

// ── Scalar types ──────────────────────────────────────────────────────────────

describe('scvBool', () => {
    it('deserializes true', () => {
        expect(deserializeScVal(xdr.ScVal.scvBool(true))).toBe(true);
    });

    it('deserializes false', () => {
        expect(deserializeScVal(xdr.ScVal.scvBool(false))).toBe(false);
    });
});

describe('scvVoid', () => {
    it('deserializes to null', () => {
        expect(deserializeScVal(xdr.ScVal.scvVoid())).toBeNull();
    });
});

describe('scvU32 / scvI32', () => {
    it('deserializes u32', () => {
        expect(deserializeScVal(xdr.ScVal.scvU32(42))).toBe(42);
    });

    it('deserializes i32 (positive)', () => {
        expect(deserializeScVal(xdr.ScVal.scvI32(100))).toBe(100);
    });

    it('deserializes i32 (negative)', () => {
        expect(deserializeScVal(xdr.ScVal.scvI32(-7))).toBe(-7);
    });
});

describe('scvU64 / scvI64', () => {
    it('deserializes u64 to bigint', () => {
        const val = xdr.ScVal.scvU64(new xdr.Uint64(9_007_199_254_740_993n));
        expect(deserializeScVal(val)).toBe(9_007_199_254_740_993n);
    });

    it('deserializes i64 (positive) to bigint', () => {
        const val = xdr.ScVal.scvI64(new xdr.Int64(1_000_000_000n));
        expect(deserializeScVal(val)).toBe(1_000_000_000n);
    });

    it('deserializes i64 (negative) to bigint', () => {
        const val = xdr.ScVal.scvI64(new xdr.Int64(-1n));
        expect(deserializeScVal(val)).toBe(-1n);
    });

    it('deserializes i64 MIN_INT64', () => {
        const MIN = -9_223_372_036_854_775_808n;
        const val = xdr.ScVal.scvI64(new xdr.Int64(MIN));
        expect(deserializeScVal(val)).toBe(MIN);
    });
});

describe('scvTimepoint / scvDuration', () => {
    it('deserializes timepoint as bigint', () => {
        const val = xdr.ScVal.scvTimepoint(new xdr.TimePoint(12345n));
        expect(deserializeScVal(val)).toBe(12345n);
    });

    it('deserializes duration as bigint', () => {
        const val = xdr.ScVal.scvDuration(new xdr.Duration(99n));
        expect(deserializeScVal(val)).toBe(99n);
    });
});

describe('scvU128 / scvI128', () => {
    it('deserializes u128 (small value)', () => {
        const val = xdr.ScVal.scvU128(
            new xdr.UInt128Parts({ hi: new xdr.Uint64(0n), lo: new xdr.Uint64(255n) }),
        );
        expect(deserializeScVal(val)).toBe(255n);
    });

    it('deserializes u128 (value spanning hi and lo)', () => {
        // hi=1, lo=0 → 1 * 2^64
        const val = xdr.ScVal.scvU128(
            new xdr.UInt128Parts({ hi: new xdr.Uint64(1n), lo: new xdr.Uint64(0n) }),
        );
        expect(deserializeScVal(val)).toBe(1n << 64n);
    });

    it('deserializes i128 (positive)', () => {
        const val = xdr.ScVal.scvI128(
            new xdr.Int128Parts({ hi: new xdr.Int64(0n), lo: new xdr.Uint64(1000n) }),
        );
        expect(deserializeScVal(val)).toBe(1000n);
    });

    it('deserializes i128 (negative with sign in hi)', () => {
        // -1 in i128: hi = -1 (all ones in signed 64-bit), lo = 2^64 - 1
        const val = xdr.ScVal.scvI128(
            new xdr.Int128Parts({ hi: new xdr.Int64(-1n), lo: new xdr.Uint64(0xFFFFFFFFFFFFFFFFn) }),
        );
        expect(deserializeScVal(val)).toBe(-1n);
    });
});

describe('scvU256 / scvI256', () => {
    it('deserializes u256 (small value in loLo)', () => {
        const val = xdr.ScVal.scvU256(
            new xdr.UInt256Parts({
                hiHi: new xdr.Uint64(0n),
                hiLo: new xdr.Uint64(0n),
                loHi: new xdr.Uint64(0n),
                loLo: new xdr.Uint64(7n),
            }),
        );
        expect(deserializeScVal(val)).toBe(7n);
    });

    it('deserializes i256 (positive)', () => {
        const val = xdr.ScVal.scvI256(
            new xdr.Int256Parts({
                hiHi: new xdr.Int64(0n),
                hiLo: new xdr.Uint64(0n),
                loHi: new xdr.Uint64(0n),
                loLo: new xdr.Uint64(42n),
            }),
        );
        expect(deserializeScVal(val)).toBe(42n);
    });
});

// ── String-like types ─────────────────────────────────────────────────────────

describe('scvBytes', () => {
    it('deserializes bytes to Buffer', () => {
        const buf = Buffer.from([1, 2, 3]);
        const val = xdr.ScVal.scvBytes(buf);
        const result = deserializeScVal(val);
        expect(Buffer.isBuffer(result)).toBe(true);
        expect(result).toEqual(buf);
    });
});

describe('scvString', () => {
    it('deserializes to string', () => {
        expect(deserializeScVal(xdr.ScVal.scvString('hello'))).toBe('hello');
    });

    it('deserializes empty string', () => {
        expect(deserializeScVal(xdr.ScVal.scvString(''))).toBe('');
    });
});

describe('scvSymbol', () => {
    it('deserializes to string', () => {
        expect(deserializeScVal(xdr.ScVal.scvSymbol('transfer'))).toBe('transfer');
    });
});

// ── Collection types ──────────────────────────────────────────────────────────

describe('scvVec', () => {
    it('deserializes an empty vector', () => {
        expect(deserializeScVal(xdr.ScVal.scvVec([]))).toEqual([]);
    });

    it('deserializes a vector of scalars', () => {
        const val = xdr.ScVal.scvVec([xdr.ScVal.scvU32(1), xdr.ScVal.scvU32(2), xdr.ScVal.scvU32(3)]);
        expect(deserializeScVal(val)).toEqual([1, 2, 3]);
    });

    it('deserializes a nested vector', () => {
        const inner = xdr.ScVal.scvVec([xdr.ScVal.scvBool(true)]);
        const outer = xdr.ScVal.scvVec([inner, xdr.ScVal.scvVoid()]);
        expect(deserializeScVal(outer)).toEqual([[true], null]);
    });
});

describe('scvMap', () => {
    it('deserializes an empty map', () => {
        expect(deserializeScVal(xdr.ScVal.scvMap([]))).toEqual({});
    });

    it('deserializes a map with symbol keys', () => {
        const entry = new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol('balance'),
            val: xdr.ScVal.scvU32(500),
        });
        expect(deserializeScVal(xdr.ScVal.scvMap([entry]))).toEqual({ balance: 500 });
    });

    it('deserializes a map with string keys', () => {
        const entry = new xdr.ScMapEntry({
            key: xdr.ScVal.scvString('name'),
            val: xdr.ScVal.scvString('Alice'),
        });
        expect(deserializeScVal(xdr.ScVal.scvMap([entry]))).toEqual({ name: 'Alice' });
    });

    it('deserializes a map with mixed value types', () => {
        const entries = [
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('count'), val: xdr.ScVal.scvU32(3) }),
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('active'), val: xdr.ScVal.scvBool(true) }),
        ];
        const result = deserializeScVal(xdr.ScVal.scvMap(entries)) as Record<string, unknown>;
        expect(result.count).toBe(3);
        expect(result.active).toBe(true);
    });
});

// ── Address type ──────────────────────────────────────────────────────────────

describe('scvAddress', () => {
    it('deserializes an account address to G... string', () => {
        const pubKey = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ';
        const keyBytes = StrKey.decodeEd25519PublicKey(pubKey);
        const addr = xdr.ScAddress.scAddressTypeAccount(
            xdr.AccountId.publicKeyTypeEd25519(keyBytes),
        );
        const val = xdr.ScVal.scvAddress(addr);
        expect(deserializeScVal(val)).toBe(pubKey);
    });

    it('deserializes a contract address to C... string', () => {
        const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
        const contractBytes = StrKey.decodeContract(contractId);
        const addr = xdr.ScAddress.scAddressTypeContract(contractBytes);
        const val = xdr.ScVal.scvAddress(addr);
        expect(deserializeScVal(val)).toBe(contractId);
    });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('scvError', () => {
    it('throws SorobanDeserializationError', () => {
        // Build a minimal error ScVal using the available API
        const errVal = xdr.ScVal.scvError(
            xdr.ScError.sceValue(xdr.ScErrorCode.scecArithDomain()),
        );
        expect(() => deserializeScVal(errVal)).toThrow(SorobanDeserializationError);
    });

    it('error has scvType set to scvError', () => {
        const errVal = xdr.ScVal.scvError(
            xdr.ScError.sceValue(xdr.ScErrorCode.scecArithDomain()),
        );
        try {
            deserializeScVal(errVal);
            expect.fail('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(SorobanDeserializationError);
            expect((e as SorobanDeserializationError).scvType).toBe('scvError');
        }
    });
});

// ── deserializeScValAs ────────────────────────────────────────────────────────

describe('deserializeScValAs', () => {
    it('returns typed value when guard passes', () => {
        const val = xdr.ScVal.scvU32(99);
        const result = deserializeScValAs<number>(val, (v): v is number => typeof v === 'number');
        expect(result).toBe(99);
    });

    it('throws when guard fails', () => {
        const val = xdr.ScVal.scvU32(99);
        expect(() =>
            deserializeScValAs<string>(val, (v): v is string => typeof v === 'string'),
        ).toThrow(SorobanDeserializationError);
    });

    it('works without guard (plain type cast)', () => {
        const val = xdr.ScVal.scvBool(false);
        expect(deserializeScValAs(val)).toBe(false);
    });
});
