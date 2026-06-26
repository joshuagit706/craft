/**
 * Stellar DEX Price Feed — Order Book Price Computation (Issue #091)
 *
 * Computes price metrics from Stellar Horizon DEX order book snapshots.
 * All functions are pure and stateless; no network calls are made here.
 *
 * ## Price metrics returned
 * - bestBid / bestAsk: top-of-book prices (highest bid, lowest ask)
 * - midPrice: arithmetic mean of bestBid and bestAsk
 * - spread: absolute difference (bestAsk − bestBid)
 * - spreadPercent: spread as a percentage of midPrice
 *
 * ## Edge-case handling
 * | Condition           | Behaviour                                       |
 * |---------------------|-------------------------------------------------|
 * | Empty order book    | midPrice, spread, spreadPercent all undefined   |
 * | Bids only           | bestAsk, midPrice, spread, spreadPercent undefined |
 * | Asks only           | bestBid, midPrice, spread, spreadPercent undefined |
 * | Crossed book        | midPrice computed, `crossed: true` flag set     |
 */

// ── Input types (mirror Horizon order book API) ───────────────────────────────

export interface OrderBookLevel {
    /** Price as a decimal string, e.g. "0.5000000" */
    price: string;
    /** Volume at this price level as a decimal string */
    amount: string;
    /** Rational representation { n, d } where price = n / d */
    price_r: { n: number; d: number };
}

export interface OrderBookSnapshot {
    /** Bids sorted descending by price (best bid first). */
    bids: OrderBookLevel[];
    /** Asks sorted ascending by price (best ask first). */
    asks: OrderBookLevel[];
}

// ── Output types ──────────────────────────────────────────────────────────────

export interface DexPriceResult {
    /** Highest bid price (undefined when no bids). */
    bestBid: number | undefined;
    /** Lowest ask price (undefined when no asks). */
    bestAsk: number | undefined;
    /**
     * Arithmetic mid-price = (bestBid + bestAsk) / 2.
     * Defined only when both sides are present.
     */
    midPrice: number | undefined;
    /**
     * Absolute spread = bestAsk − bestBid.
     * Defined only when both sides are present.
     */
    spread: number | undefined;
    /**
     * Spread as a percentage of midPrice.
     * Defined only when both sides are present and midPrice > 0.
     */
    spreadPercent: number | undefined;
    /** true when bestBid >= bestAsk (invalid/crossed market). */
    crossed: boolean;
    /** true when both bids and asks arrays are empty. */
    empty: boolean;
}

// ── Price tolerance ───────────────────────────────────────────────────────────

/**
 * Maximum relative deviation allowed when asserting price accuracy in tests.
 * Value of 1e-6 (1 part per million) covers floating-point rounding across
 * the seven decimal places used by Horizon's fixed-point format.
 */
export const PRICE_TOLERANCE = 1e-6;

// ── Core computation ──────────────────────────────────────────────────────────

/**
 * Compute price metrics from a Stellar DEX order book snapshot.
 *
 * @param book - An order book snapshot (bids + asks arrays)
 * @returns Computed price metrics; fields that cannot be derived are `undefined`
 *
 * @example
 * ```typescript
 * const book = await server.orderbook(selling, buying).call();
 * const price = computeDexPrice(book);
 * if (!price.empty) {
 *   console.log('Mid price:', price.midPrice);
 * }
 * ```
 */
export function computeDexPrice(book: OrderBookSnapshot): DexPriceResult {
    const bestBid = topPrice(book.bids);
    const bestAsk = topPrice(book.asks);
    const empty = bestBid === undefined && bestAsk === undefined;
    const crossed = bestBid !== undefined && bestAsk !== undefined && bestBid >= bestAsk;

    let midPrice: number | undefined;
    let spread: number | undefined;
    let spreadPercent: number | undefined;

    if (bestBid !== undefined && bestAsk !== undefined) {
        midPrice = (bestBid + bestAsk) / 2;
        spread = bestAsk - bestBid;
        spreadPercent = midPrice > 0 ? (spread / midPrice) * 100 : undefined;
    }

    return { bestBid, bestAsk, midPrice, spread, spreadPercent, crossed, empty };
}

/**
 * Compute the volume-weighted average price (VWAP) for one side of the book
 * up to a given depth (in quote asset volume).
 *
 * @param levels - Sorted price levels (bids desc, asks asc)
 * @param maxVolume - Maximum base-asset volume to consume (unbounded when omitted)
 * @returns VWAP across consumed levels, or `undefined` when levels is empty
 */
export function computeVwap(levels: OrderBookLevel[], maxVolume?: number): number | undefined {
    if (levels.length === 0) return undefined;

    let weightedSum = 0;
    let totalVolume = 0;
    const limit = maxVolume ?? Infinity;

    for (const level of levels) {
        const price = parseFloat(level.price);
        const amount = parseFloat(level.amount);
        if (!isFinite(price) || !isFinite(amount) || amount <= 0) continue;

        const consumed = Math.min(amount, limit - totalVolume);
        weightedSum += price * consumed;
        totalVolume += consumed;
        if (totalVolume >= limit) break;
    }

    return totalVolume > 0 ? weightedSum / totalVolume : undefined;
}

/**
 * Assert that two prices are within `PRICE_TOLERANCE` relative error.
 * Useful in snapshot tests to account for floating-point rounding.
 */
export function assertPriceClose(actual: number, expected: number, tolerance = PRICE_TOLERANCE): void {
    const relErr = Math.abs(actual - expected) / (Math.abs(expected) || 1);
    if (relErr > tolerance) {
        throw new Error(
            `Price assertion failed: actual=${actual}, expected=${expected}, relErr=${relErr.toExponential(3)}`,
        );
    }
}

// ── Multi-endpoint consistency verification (#781) ────────────────────────────

/** Maximum relative price divergence (%) allowed between two Horizon endpoints. */
export const CONSISTENCY_TOLERANCE_PERCENT = 1.0;

export interface SnapshotWithMeta {
    /** The order book snapshot from this endpoint. */
    snapshot: OrderBookSnapshot;
    /** Ledger sequence number at the time the snapshot was taken. */
    ledgerSequence: number;
}

export interface ConsistencyResult {
    /** true when the two endpoints agree within {@link CONSISTENCY_TOLERANCE_PERCENT}. */
    consistent: boolean;
    /** Percentage divergence between mid-prices; undefined when a mid-price cannot be computed. */
    divergencePercent: number | undefined;
    /** The snapshot to use: primary when consistent or when primary is more recent; otherwise secondary. */
    selectedSnapshot: OrderBookSnapshot;
    /** Human-readable explanation of why this snapshot was selected. */
    reason: string;
}

/**
 * Compare two order book snapshots from different Horizon endpoints and detect
 * stale data caused by network splits.
 *
 * Algorithm:
 * 1. Compute mid-price for each snapshot.
 * 2. Calculate relative divergence = |p1 − p2| / avg(p1, p2) × 100.
 * 3. If divergence ≤ {@link CONSISTENCY_TOLERANCE_PERCENT} (1%), return primary.
 * 4. Otherwise log a violation via `onViolation` and return the snapshot with
 *    the higher ledger sequence (more recent data wins).
 *
 * @param primary - Snapshot from the primary Horizon endpoint.
 * @param secondary - Snapshot from the secondary Horizon endpoint.
 * @param onViolation - Optional callback invoked with a description when
 *   divergence exceeds the tolerance (use for analytics / logging).
 */
export function verifyOrderBookConsistency(
    primary: SnapshotWithMeta,
    secondary: SnapshotWithMeta,
    onViolation?: (message: string) => void,
): ConsistencyResult {
    const primaryPrice = computeDexPrice(primary.snapshot);
    const secondaryPrice = computeDexPrice(secondary.snapshot);

    if (
        primaryPrice.midPrice === undefined ||
        secondaryPrice.midPrice === undefined
    ) {
        return {
            consistent: true,
            divergencePercent: undefined,
            selectedSnapshot: primary.snapshot,
            reason: 'Cannot compute mid-price for one or both endpoints; defaulting to primary',
        };
    }

    const avg = (primaryPrice.midPrice + secondaryPrice.midPrice) / 2;
    const divergencePercent =
        avg > 0
            ? (Math.abs(primaryPrice.midPrice - secondaryPrice.midPrice) / avg) * 100
            : 0;

    if (divergencePercent <= CONSISTENCY_TOLERANCE_PERCENT) {
        return {
            consistent: true,
            divergencePercent,
            selectedSnapshot: primary.snapshot,
            reason: 'Endpoints within tolerance; using primary snapshot',
        };
    }

    const msg =
        `Order book consistency violation: ${divergencePercent.toFixed(4)}% divergence ` +
        `exceeds ${CONSISTENCY_TOLERANCE_PERCENT}% tolerance ` +
        `(primary ledger ${primary.ledgerSequence}, secondary ledger ${secondary.ledgerSequence})`;
    onViolation?.(msg);

    const useSecondary = secondary.ledgerSequence > primary.ledgerSequence;
    return {
        consistent: false,
        divergencePercent,
        selectedSnapshot: useSecondary ? secondary.snapshot : primary.snapshot,
        reason: useSecondary
            ? `Selected secondary (ledger ${secondary.ledgerSequence} > ${primary.ledgerSequence})`
            : `Selected primary (ledger ${primary.ledgerSequence} >= ${secondary.ledgerSequence})`,
    };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function topPrice(levels: OrderBookLevel[]): number | undefined {
    if (levels.length === 0) return undefined;
    const p = parseFloat(levels[0].price);
    return isFinite(p) ? p : undefined;
}
