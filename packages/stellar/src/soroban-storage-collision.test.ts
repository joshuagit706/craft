/**
 * Tests for Soroban storage key namespace collision detection (#616)
 */
import { describe, it, expect } from 'vitest';
import {
    detectStorageKeyCollisions,
    assertNoStorageKeyCollisions,
    StorageKeyCollisionError,
} from './soroban';

describe('detectStorageKeyCollisions (#616)', () => {
    it('returns empty array when no collisions exist', () => {
        const result = detectStorageKeyCollisions([
            { owner: 'TokenA', key: 'balance' },
            { owner: 'TokenB', key: 'allowance' },
        ]);
        expect(result).toHaveLength(0);
    });

    it('detects a single collision', () => {
        const result = detectStorageKeyCollisions([
            { owner: 'TokenA', key: 'balance' },
            { owner: 'TokenB', key: 'balance' },
        ]);
        expect(result).toHaveLength(1);
        expect(result[0].key).toBe('balance');
        expect(result[0].owners).toContain('TokenA');
        expect(result[0].owners).toContain('TokenB');
    });

    it('detects multiple collisions', () => {
        const result = detectStorageKeyCollisions([
            { owner: 'A', key: 'foo' },
            { owner: 'B', key: 'foo' },
            { owner: 'C', key: 'bar' },
            { owner: 'D', key: 'bar' },
        ]);
        expect(result).toHaveLength(2);
    });

    it('handles three-way collision', () => {
        const result = detectStorageKeyCollisions([
            { owner: 'X', key: 'state' },
            { owner: 'Y', key: 'state' },
            { owner: 'Z', key: 'state' },
        ]);
        expect(result[0].owners).toHaveLength(3);
    });

    it('returns empty array for empty input', () => {
        expect(detectStorageKeyCollisions([])).toHaveLength(0);
    });
});

describe('assertNoStorageKeyCollisions (#616)', () => {
    it('does not throw when there are no collisions', () => {
        expect(() =>
            assertNoStorageKeyCollisions([
                { owner: 'A', key: 'alpha' },
                { owner: 'B', key: 'beta' },
            ])
        ).not.toThrow();
    });

    it('throws StorageKeyCollisionError when collisions exist', () => {
        expect(() =>
            assertNoStorageKeyCollisions([
                { owner: 'A', key: 'shared' },
                { owner: 'B', key: 'shared' },
            ])
        ).toThrow(StorageKeyCollisionError);
    });

    it('error message names the colliding key and owners', () => {
        try {
            assertNoStorageKeyCollisions([
                { owner: 'FeatureX', key: 'counter' },
                { owner: 'FeatureY', key: 'counter' },
            ]);
        } catch (e) {
            expect(e).toBeInstanceOf(StorageKeyCollisionError);
            const err = e as StorageKeyCollisionError;
            expect(err.message).toContain('counter');
            expect(err.message).toContain('FeatureX');
            expect(err.message).toContain('FeatureY');
            expect(err.collisions).toHaveLength(1);
        }
    });
});
