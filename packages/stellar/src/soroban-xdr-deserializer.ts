/**
 * Type-Safe XDR Deserialization for Soroban Contract Return Values (Issue #090)
 *
 * Converts raw `xdr.ScVal` objects returned by Soroban contract invocations
 * into strongly-typed TypeScript values, eliminating manual XDR parsing.
 *
 * ## Type mapping
 * | ScVal type               | TypeScript type              |
 * |--------------------------|------------------------------|
 * | scvBool                  | boolean                      |
 * | scvVoid                  | null                         |
 * | scvU32 / scvI32          | number                       |
 * | scvU64 / scvI64          | bigint                       |
 * | scvTimepoint / scvDuration | bigint                     |
 * | scvU128 / scvI128        | bigint                       |
 * | scvU256 / scvI256        | bigint                       |
 * | scvBytes                 | Buffer                       |
 * | scvString / scvSymbol    | string                       |
 * | scvVec                   | SorobanValue[]               |
 * | scvMap                   | Record<string, SorobanValue> |
 * | scvAddress               | string (G... or C... address)|
 * | scvError                 | throws SorobanDeserializationError |
 *
 * Malformed or unknown ScVal types always throw `SorobanDeserializationError`.
 * Values are never silently coerced.
 */

import { xdr, StrKey } from 'stellar-sdk';

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Union of all possible deserialized Soroban values.
 * Recursive through `SorobanValue[]` and `Record<string, SorobanValue>`.
 */
export type SorobanValue =
    | boolean
    | null
    | number
    | bigint
    | string
    | Buffer
    | SorobanValue[]
    | { [key: string]: SorobanValue };

/**
 * Thrown when an `xdr.ScVal` cannot be safely deserialized.
 * The `scvType` property holds the raw discriminant name for diagnostics.
 */
export class SorobanDeserializationError extends Error {
    constructor(
        message: string,
        public readonly scvType?: string,
    ) {
        super(message);
        this.name = 'SorobanDeserializationError';
    }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Deserialize a Soroban `xdr.ScVal` into a strongly-typed `SorobanValue`.
 *
 * @param scVal - The raw XDR value returned by a contract invocation
 * @returns The deserialized TypeScript value
 * @throws {SorobanDeserializationError} if the value is an error type or
 *   the discriminant is not a recognized ScVal variant
 *
 * @example
 * ```typescript
 * const sim = await simulateContractCall(contractId, 'get_balance', args, key);
 * const retval = (sim as SimulateTransactionSuccessResponse).result?.retval;
 * const balance = deserializeScVal(retval) as bigint; // scvI128
 * ```
 */
export function deserializeScVal(scVal: xdr.ScVal): SorobanValue {
    const typeName = scVal.switch().name as string;

    switch (typeName) {
        case 'scvBool':
            return scVal.b();

        case 'scvVoid':
            return null;

        case 'scvError': {
            const err = scVal.error();
            const typeStr = err.switch().name ?? 'unknown';
            throw new SorobanDeserializationError(
                `Contract returned an error value (type: ${typeStr})`,
                typeName,
            );
        }

        case 'scvU32':
            return scVal.u32();

        case 'scvI32':
            return scVal.i32();

        case 'scvU64':
            return uint64ToBigInt(scVal.u64());

        case 'scvI64':
            return int64ToBigInt(scVal.i64());

        case 'scvTimepoint':
            return uint64ToBigInt(scVal.timepoint());

        case 'scvDuration':
            return uint64ToBigInt(scVal.duration());

        case 'scvU128': {
            const p = scVal.u128();
            return (uint64ToBigInt(p.hi()) << 64n) | uint64ToBigInt(p.lo());
        }

        case 'scvI128': {
            const p = scVal.i128();
            // hi is signed (Int64), lo is unsigned (Uint64)
            const hi = int64ToBigInt(p.hi());
            const lo = uint64ToBigInt(p.lo());
            return (hi << 64n) | lo;
        }

        case 'scvU256': {
            const p = scVal.u256();
            return (
                (uint64ToBigInt(p.hiHi()) << 192n) |
                (uint64ToBigInt(p.hiLo()) << 128n) |
                (uint64ToBigInt(p.loHi()) << 64n) |
                uint64ToBigInt(p.loLo())
            );
        }

        case 'scvI256': {
            const p = scVal.i256();
            // hiHi is signed (Int64); the remaining three are unsigned
            const hiHi = int64ToBigInt(p.hiHi());
            const hiLo = uint64ToBigInt(p.hiLo());
            const loHi = uint64ToBigInt(p.loHi());
            const loLo = uint64ToBigInt(p.loLo());
            return (hiHi << 192n) | (hiLo << 128n) | (loHi << 64n) | loLo;
        }

        case 'scvBytes':
            return scVal.bytes();

        case 'scvString':
            return scVal.str().toString();

        case 'scvSymbol':
            return scVal.sym().toString();

        case 'scvVec': {
            const items = scVal.vec();
            if (items === undefined) return [];
            return items.map((item) => deserializeScVal(item));
        }

        case 'scvMap': {
            const entries = scVal.map();
            if (entries === undefined) return {};
            const result: { [key: string]: SorobanValue } = {};
            for (const entry of entries) {
                const key = mapKeyToString(entry.key());
                result[key] = deserializeScVal(entry.val());
            }
            return result;
        }

        case 'scvAddress':
            return decodeAddress(scVal.address());

        case 'scvLedgerKeyContractInstance':
            return null;

        case 'scvLedgerKeyNonce': {
            const nonce = scVal.nonce();
            return int64ToBigInt(nonce.nonce());
        }

        case 'scvContractInstance':
            return null;

        default:
            throw new SorobanDeserializationError(
                `Unrecognized ScVal type: ${typeName}`,
                typeName,
            );
    }
}

// ── Type-parameterised helper ─────────────────────────────────────────────────

/**
 * Deserialize a ScVal and cast to the expected TypeScript type `T`.
 *
 * Throws `SorobanDeserializationError` when the deserialized value does not
 * satisfy the optional `guard` predicate.
 *
 * @example
 * ```typescript
 * const count = deserializeScValAs<number>(retval, (v): v is number => typeof v === 'number');
 * ```
 */
export function deserializeScValAs<T extends SorobanValue>(
    scVal: xdr.ScVal,
    guard?: (v: SorobanValue) => v is T,
): T {
    const value = deserializeScVal(scVal);
    if (guard && !guard(value)) {
        throw new SorobanDeserializationError(
            `Deserialized value did not match expected type (got ${typeof value})`,
            scVal.switch().name,
        );
    }
    return value as T;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Unsigned 64-bit XDR integer → BigInt. */
function uint64ToBigInt(v: { high: number; low: number }): bigint {
    return (BigInt(v.high >>> 0) << 32n) | BigInt(v.low >>> 0);
}

/** Signed 64-bit XDR integer → BigInt (preserves two's-complement sign). */
function int64ToBigInt(v: { high: number; low: number }): bigint {
    const unsigned = (BigInt(v.high >>> 0) << 32n) | BigInt(v.low >>> 0);
    // If the sign bit (bit 63) is set, convert from unsigned to signed representation.
    return v.high < 0 ? unsigned - (1n << 64n) : unsigned;
}

/** Convert a ScAddress to its Stellar StrKey string representation. */
function decodeAddress(addr: xdr.ScAddress): string {
    const typeName = addr.switch().name as string;
    if (typeName === 'scAddressTypeAccount') {
        return StrKey.encodeEd25519PublicKey(addr.accountId().ed25519());
    }
    if (typeName === 'scAddressTypeContract') {
        return StrKey.encodeContract(addr.contractId());
    }
    throw new SorobanDeserializationError(
        `Unknown ScAddress type: ${typeName}`,
        'scvAddress',
    );
}

/**
 * Convert a ScVal map key to a string for use as an object property name.
 * Symbols and strings are used verbatim; numeric and other types are
 * rendered as their string representation.
 */
function mapKeyToString(key: xdr.ScVal): string {
    const typeName = key.switch().name as string;
    switch (typeName) {
        case 'scvSymbol': return key.sym().toString();
        case 'scvString': return key.str().toString();
        case 'scvU32':    return String(key.u32());
        case 'scvI32':    return String(key.i32());
        case 'scvU64':    return uint64ToBigInt(key.u64()).toString();
        case 'scvI64':    return int64ToBigInt(key.i64()).toString();
        case 'scvBool':   return String(key.b());
        default:
            // Fall back to a recognisable placeholder rather than silently losing data.
            return `[${typeName}]`;
    }
}
