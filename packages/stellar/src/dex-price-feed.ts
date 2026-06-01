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

// ── Internal helpers ──────────────────────────────────────────────────────────

function topPrice(levels: OrderBookLevel[]): number | undefined {
    if (levels.length === 0) return undefined;
    const p = parseFloat(levels[0].price);
    return isFinite(p) ? p : undefined;
}
