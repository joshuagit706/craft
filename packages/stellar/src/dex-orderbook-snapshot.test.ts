/**
 * DEX Order Book Snapshot Tests for Price Feed Validation (Issue #091)
 *
 * Validates that computeDexPrice correctly interprets Stellar order book data
 * and computes accurate prices across various market conditions.
 *
 * Fixtures use the same shape as Horizon's order book API response so they
 * can be swapped for live snapshots without modifying the price logic.
 */

import { describe, it, expect } from 'vitest';
import {
    computeDexPrice,
    computeVwap,
    assertPriceClose,
    verifyOrderBookConsistency,
    PRICE_TOLERANCE,
    CONSISTENCY_TOLERANCE_PERCENT,
    type OrderBookSnapshot,
    type SnapshotWithMeta,
} from './dex-price-feed';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Thin market: a single bid and a single ask far apart. */
const THIN_BOOK: OrderBookSnapshot = {
    bids: [
        { price: '0.4000000', amount: '100.0000000', price_r: { n: 2, d: 5 } },
    ],
    asks: [
        { price: '0.6000000', amount: '100.0000000', price_r: { n: 3, d: 5 } },
    ],
};

/** Deep market: many levels, tight spread. */
const DEEP_BOOK: OrderBookSnapshot = {
    bids: [
        { price: '0.4998000', amount: '5000.0000000', price_r: { n: 4998, d: 10000 } },
        { price: '0.4990000', amount: '10000.0000000', price_r: { n: 499, d: 1000 } },
        { price: '0.4970000', amount: '20000.0000000', price_r: { n: 497, d: 1000 } },
    ],
    asks: [
        { price: '0.5002000', amount: '5000.0000000', price_r: { n: 5002, d: 10000 } },
        { price: '0.5010000', amount: '10000.0000000', price_r: { n: 501, d: 1000 } },
        { price: '0.5030000', amount: '20000.0000000', price_r: { n: 503, d: 1000 } },
    ],
};

/** Empty order book: no bids, no asks. */
const EMPTY_BOOK: OrderBookSnapshot = { bids: [], asks: [] };

/** Single-sided: bids only (no asks). */
const BIDS_ONLY_BOOK: OrderBookSnapshot = {
    bids: [{ price: '0.5000000', amount: '500.0000000', price_r: { n: 1, d: 2 } }],
    asks: [],
};

/** Single-sided: asks only (no bids). */
const ASKS_ONLY_BOOK: OrderBookSnapshot = {
    bids: [],
    asks: [{ price: '0.5000000', amount: '500.0000000', price_r: { n: 1, d: 2 } }],
};

/** Crossed market: best bid exceeds best ask (invalid state). */
const CROSSED_BOOK: OrderBookSnapshot = {
    bids: [{ price: '0.6000000', amount: '200.0000000', price_r: { n: 3, d: 5 } }],
    asks: [{ price: '0.4000000', amount: '200.0000000', price_r: { n: 2, d: 5 } }],
};

/** Exact mid-point book: symmetric spread around 1.0. */
const SYMMETRIC_BOOK: OrderBookSnapshot = {
    bids: [{ price: '0.9900000', amount: '1000.0000000', price_r: { n: 99, d: 100 } }],
    asks: [{ price: '1.0100000', amount: '1000.0000000', price_r: { n: 101, d: 100 } }],
};

// ── Thin market ───────────────────────────────────────────────────────────────

describe('thin order book', () => {
    it('returns correct bestBid and bestAsk', () => {
        const price = computeDexPrice(THIN_BOOK);
        expect(price.bestBid).toBeDefined();
        expect(price.bestAsk).toBeDefined();
        assertPriceClose(price.bestBid!, 0.4);
        assertPriceClose(price.bestAsk!, 0.6);
    });

    it('computes midPrice as arithmetic mean', () => {
        const price = computeDexPrice(THIN_BOOK);
        expect(price.midPrice).toBeDefined();
        assertPriceClose(price.midPrice!, 0.5);
    });

    it('computes spread correctly', () => {
        const price = computeDexPrice(THIN_BOOK);
        expect(price.spread).toBeDefined();
        assertPriceClose(price.spread!, 0.2);
    });

    it('computes spreadPercent (spread / midPrice * 100)', () => {
        const price = computeDexPrice(THIN_BOOK);
        expect(price.spreadPercent).toBeDefined();
        assertPriceClose(price.spreadPercent!, 40.0); // 0.2 / 0.5 * 100
    });

    it('is not empty and not crossed', () => {
        const price = computeDexPrice(THIN_BOOK);
        expect(price.empty).toBe(false);
        expect(price.crossed).toBe(false);
    });
});

// ── Deep market ───────────────────────────────────────────────────────────────

describe('deep order book', () => {
    it('uses top-of-book price (not averaged)', () => {
        const price = computeDexPrice(DEEP_BOOK);
        assertPriceClose(price.bestBid!, 0.4998);
        assertPriceClose(price.bestAsk!, 0.5002);
    });

    it('has a tight midPrice near 0.5', () => {
        const price = computeDexPrice(DEEP_BOOK);
        assertPriceClose(price.midPrice!, 0.5, 1e-4);
    });

    it('has a small spread (< 1 %)', () => {
        const price = computeDexPrice(DEEP_BOOK);
        expect(price.spreadPercent).toBeDefined();
        expect(price.spreadPercent!).toBeLessThan(1.0);
    });

    it('is not empty and not crossed', () => {
        const price = computeDexPrice(DEEP_BOOK);
        expect(price.empty).toBe(false);
        expect(price.crossed).toBe(false);
    });
});

// ── Empty order book ──────────────────────────────────────────────────────────

describe('empty order book', () => {
    it('marks the book as empty', () => {
        const price = computeDexPrice(EMPTY_BOOK);
        expect(price.empty).toBe(true);
    });

    it('returns undefined for all price fields', () => {
        const price = computeDexPrice(EMPTY_BOOK);
        expect(price.bestBid).toBeUndefined();
        expect(price.bestAsk).toBeUndefined();
        expect(price.midPrice).toBeUndefined();
        expect(price.spread).toBeUndefined();
        expect(price.spreadPercent).toBeUndefined();
    });

    it('is not crossed', () => {
        expect(computeDexPrice(EMPTY_BOOK).crossed).toBe(false);
    });
});

// ── Single-sided order books ──────────────────────────────────────────────────

describe('bids-only order book', () => {
    it('returns bestBid but no bestAsk', () => {
        const price = computeDexPrice(BIDS_ONLY_BOOK);
        expect(price.bestBid).toBeDefined();
        assertPriceClose(price.bestBid!, 0.5);
        expect(price.bestAsk).toBeUndefined();
    });

    it('cannot compute midPrice, spread, or spreadPercent', () => {
        const price = computeDexPrice(BIDS_ONLY_BOOK);
        expect(price.midPrice).toBeUndefined();
        expect(price.spread).toBeUndefined();
        expect(price.spreadPercent).toBeUndefined();
    });

    it('is not empty and not crossed', () => {
        const price = computeDexPrice(BIDS_ONLY_BOOK);
        expect(price.empty).toBe(false);
        expect(price.crossed).toBe(false);
    });
});

describe('asks-only order book', () => {
    it('returns bestAsk but no bestBid', () => {
        const price = computeDexPrice(ASKS_ONLY_BOOK);
        expect(price.bestAsk).toBeDefined();
        assertPriceClose(price.bestAsk!, 0.5);
        expect(price.bestBid).toBeUndefined();
    });

    it('cannot compute midPrice or spread', () => {
        const price = computeDexPrice(ASKS_ONLY_BOOK);
        expect(price.midPrice).toBeUndefined();
        expect(price.spread).toBeUndefined();
    });
});

// ── Crossed market ────────────────────────────────────────────────────────────

describe('crossed order book', () => {
    it('detects the crossed condition', () => {
        const price = computeDexPrice(CROSSED_BOOK);
        expect(price.crossed).toBe(true);
    });

    it('still computes midPrice even when crossed', () => {
        const price = computeDexPrice(CROSSED_BOOK);
        expect(price.midPrice).toBeDefined();
        // midPrice = (0.6 + 0.4) / 2 = 0.5
        assertPriceClose(price.midPrice!, 0.5);
    });

    it('has a negative spread (bestAsk < bestBid)', () => {
        const price = computeDexPrice(CROSSED_BOOK);
        expect(price.spread).toBeDefined();
        expect(price.spread!).toBeLessThan(0);
    });
});

// ── Symmetric mid-point ───────────────────────────────────────────────────────

describe('symmetric book (spread equidistant from 1.0)', () => {
    it('midPrice is exactly 1.0', () => {
        const price = computeDexPrice(SYMMETRIC_BOOK);
        assertPriceClose(price.midPrice!, 1.0);
    });

    it('spread is 0.02', () => {
        const price = computeDexPrice(SYMMETRIC_BOOK);
        assertPriceClose(price.spread!, 0.02);
    });

    it('spreadPercent is 2 %', () => {
        const price = computeDexPrice(SYMMETRIC_BOOK);
        assertPriceClose(price.spreadPercent!, 2.0);
    });
});

// ── PRICE_TOLERANCE constant ──────────────────────────────────────────────────

describe('PRICE_TOLERANCE', () => {
    it('is defined and small', () => {
        expect(PRICE_TOLERANCE).toBeGreaterThan(0);
        expect(PRICE_TOLERANCE).toBeLessThan(1e-5);
    });
});

// ── Multi-endpoint consistency verification (#781) ────────────────────────────

/** A slightly shifted copy of DEEP_BOOK: mid-price ≈ 0.505 (< 1% from 0.5). */
const NEAR_DEEP_BOOK: OrderBookSnapshot = {
    bids: [{ price: '0.5048000', amount: '5000.0000000', price_r: { n: 5048, d: 10000 } }],
    asks: [{ price: '0.5052000', amount: '5000.0000000', price_r: { n: 5052, d: 10000 } }],
};

describe('verifyOrderBookConsistency (#781)', () => {
    it('is consistent when divergence is within 1% tolerance', () => {
        // DEEP_BOOK midPrice ≈ 0.5000, NEAR_DEEP_BOOK midPrice = 0.505
        // divergence ≈ 0.995% < 1%
        const primary: SnapshotWithMeta = { snapshot: DEEP_BOOK, ledgerSequence: 100 };
        const secondary: SnapshotWithMeta = { snapshot: NEAR_DEEP_BOOK, ledgerSequence: 100 };

        const result = verifyOrderBookConsistency(primary, secondary);
        expect(result.consistent).toBe(true);
        expect(result.divergencePercent).toBeDefined();
        expect(result.divergencePercent!).toBeLessThanOrEqual(CONSISTENCY_TOLERANCE_PERCENT);
        expect(result.selectedSnapshot).toBe(primary.snapshot);
    });

    it('is inconsistent when divergence exceeds 1% tolerance', () => {
        // THIN_BOOK midPrice = 0.5, SYMMETRIC_BOOK midPrice = 1.0  →  divergence ≈ 66.7%
        const primary: SnapshotWithMeta = { snapshot: THIN_BOOK, ledgerSequence: 100 };
        const secondary: SnapshotWithMeta = { snapshot: SYMMETRIC_BOOK, ledgerSequence: 100 };

        const result = verifyOrderBookConsistency(primary, secondary);
        expect(result.consistent).toBe(false);
        expect(result.divergencePercent).toBeDefined();
        expect(result.divergencePercent!).toBeGreaterThan(CONSISTENCY_TOLERANCE_PERCENT);
    });

    it('calls onViolation with a description when divergence exceeds tolerance', () => {
        const primary: SnapshotWithMeta = { snapshot: THIN_BOOK, ledgerSequence: 100 };
        const secondary: SnapshotWithMeta = { snapshot: SYMMETRIC_BOOK, ledgerSequence: 100 };

        const violations: string[] = [];
        verifyOrderBookConsistency(primary, secondary, msg => violations.push(msg));

        expect(violations).toHaveLength(1);
        expect(violations[0]).toContain('divergence');
    });

    it('selects the secondary snapshot when secondary has a higher ledger sequence', () => {
        const primary: SnapshotWithMeta = { snapshot: THIN_BOOK, ledgerSequence: 100 };
        const secondary: SnapshotWithMeta = { snapshot: SYMMETRIC_BOOK, ledgerSequence: 200 };

        const result = verifyOrderBookConsistency(primary, secondary);
        expect(result.consistent).toBe(false);
        expect(result.selectedSnapshot).toBe(secondary.snapshot);
    });

    it('selects the primary snapshot when primary has a higher ledger sequence', () => {
        const primary: SnapshotWithMeta = { snapshot: THIN_BOOK, ledgerSequence: 200 };
        const secondary: SnapshotWithMeta = { snapshot: SYMMETRIC_BOOK, ledgerSequence: 100 };

        const result = verifyOrderBookConsistency(primary, secondary);
        expect(result.consistent).toBe(false);
        expect(result.selectedSnapshot).toBe(primary.snapshot);
    });

    it('selects the primary snapshot when both snapshots have equal ledger sequence', () => {
        const primary: SnapshotWithMeta = { snapshot: THIN_BOOK, ledgerSequence: 150 };
        const secondary: SnapshotWithMeta = { snapshot: SYMMETRIC_BOOK, ledgerSequence: 150 };

        const result = verifyOrderBookConsistency(primary, secondary);
        expect(result.consistent).toBe(false);
        expect(result.selectedSnapshot).toBe(primary.snapshot);
    });

    it('is consistent and selects primary when either book is empty', () => {
        const primary: SnapshotWithMeta = { snapshot: EMPTY_BOOK, ledgerSequence: 100 };
        const secondary: SnapshotWithMeta = { snapshot: THIN_BOOK, ledgerSequence: 200 };

        const result = verifyOrderBookConsistency(primary, secondary);
        expect(result.consistent).toBe(true);
        expect(result.selectedSnapshot).toBe(primary.snapshot);
    });

    it('does not call onViolation when snapshots are within tolerance', () => {
        const primary: SnapshotWithMeta = { snapshot: DEEP_BOOK, ledgerSequence: 100 };
        const secondary: SnapshotWithMeta = { snapshot: NEAR_DEEP_BOOK, ledgerSequence: 100 };

        const violations: string[] = [];
        verifyOrderBookConsistency(primary, secondary, msg => violations.push(msg));

        expect(violations).toHaveLength(0);
    });
});

// ── assertPriceClose ──────────────────────────────────────────────────────────

describe('assertPriceClose', () => {
    it('does not throw when prices match within tolerance', () => {
        expect(() => assertPriceClose(0.5000001, 0.5)).not.toThrow();
    });

    it('throws when deviation exceeds tolerance', () => {
        expect(() => assertPriceClose(0.6, 0.5)).toThrow();
    });
});

// ── computeVwap ───────────────────────────────────────────────────────────────

describe('computeVwap', () => {
    it('returns undefined for an empty level list', () => {
        expect(computeVwap([])).toBeUndefined();
    });

    it('returns single-level price when only one level', () => {
        const levels = [{ price: '0.5', amount: '100', price_r: { n: 1, d: 2 } }];
        expect(computeVwap(levels)).toBeCloseTo(0.5, 7);
    });

    it('weights levels by volume', () => {
        const levels = [
            { price: '1.0', amount: '100', price_r: { n: 1, d: 1 } },
            { price: '2.0', amount: '100', price_r: { n: 2, d: 1 } },
        ];
        // VWAP = (1.0*100 + 2.0*100) / 200 = 1.5
        expect(computeVwap(levels)).toBeCloseTo(1.5, 7);
    });

    it('respects maxVolume cap', () => {
        const levels = [
            { price: '1.0', amount: '100', price_r: { n: 1, d: 1 } },
            { price: '3.0', amount: '100', price_r: { n: 3, d: 1 } },
        ];
        // With maxVolume=100, only first level is consumed → VWAP = 1.0
        expect(computeVwap(levels, 100)).toBeCloseTo(1.0, 7);
    });

    it('handles partial consumption of a level', () => {
        const levels = [
            { price: '1.0', amount: '100', price_r: { n: 1, d: 1 } },
            { price: '2.0', amount: '100', price_r: { n: 2, d: 1 } },
        ];
        // maxVolume=150: consume all 100 at 1.0, then 50 at 2.0
        // VWAP = (100*1.0 + 50*2.0) / 150 = 200/150 ≈ 1.3333
        expect(computeVwap(levels, 150)).toBeCloseTo(200 / 150, 7);
    });
});
