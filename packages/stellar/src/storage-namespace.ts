/**
 * Soroban Storage Key Namespace Isolation (#778)
 *
 * Prefixes all storage keys with the contract ID to prevent cross-contract
 * key collisions, and provides a collision detector that scans multiple
 * contract ABIs for shared unprefixed keys.
 */

export type StorageDurability = 'Persistent' | 'Temporary' | 'Instance';

export interface StorageKeyEntry {
  /** Contract or module that owns this key (used for collision reporting). */
  owner: string;
  /** Unprefixed storage key name. */
  key: string;
  /** Optional durability type for context; does not affect collision detection. */
  durability?: StorageDurability;
}

export interface StorageKeyCollision {
  /** The unprefixed key that appears in multiple contracts. */
  key: string;
  /** All owners that declare this key. */
  owners: string[];
}

/**
 * Thrown by {@link assertNoStorageKeyCollisions} when collisions are found.
 */
export class StorageKeyCollisionError extends Error {
  readonly collisions: StorageKeyCollision[];

  constructor(collisions: StorageKeyCollision[]) {
    const desc = collisions
      .map(c => `"${c.key}" (used by: ${c.owners.join(', ')})`)
      .join('; ');
    super(`Storage key collisions detected: ${desc}`);
    this.name = 'StorageKeyCollisionError';
    this.collisions = collisions;
  }
}

/**
 * Prefix a storage key with the contract ID for namespace isolation.
 * Transparent to callers: the prefixed key is used internally while the
 * unprefixed key is the public API.
 *
 * @param contractId - The contract address (C...)
 * @param key - The unprefixed storage key
 * @returns Namespaced key in the form `{contractId}:{key}`
 */
export function namespaceKey(contractId: string, key: string): string {
  return `${contractId}:${key}`;
}

/**
 * Strip the contract-ID prefix from a namespaced key.
 *
 * @param namespacedKey - A key previously returned by {@link namespaceKey}
 * @returns The original unprefixed key
 */
export function stripNamespace(namespacedKey: string): string {
  const colonIdx = namespacedKey.indexOf(':');
  return colonIdx >= 0 ? namespacedKey.slice(colonIdx + 1) : namespacedKey;
}

/**
 * Scan a list of storage key entries for unprefixed keys that are used by
 * more than one contract/module.
 *
 * @param entries - Flat list of (owner, key) pairs from all contracts under test
 * @returns Array of collisions; empty when there are none
 */
export function detectStorageKeyCollisions(entries: StorageKeyEntry[]): StorageKeyCollision[] {
  const keyMap = new Map<string, string[]>();

  for (const { owner, key } of entries) {
    const owners = keyMap.get(key) ?? [];
    owners.push(owner);
    keyMap.set(key, owners);
  }

  const collisions: StorageKeyCollision[] = [];
  for (const [key, owners] of keyMap) {
    if (owners.length > 1) {
      collisions.push({ key, owners });
    }
  }

  return collisions;
}

/**
 * Assert that no two entries share an unprefixed storage key.
 * Throws {@link StorageKeyCollisionError} if any collisions are found.
 *
 * @param entries - Flat list of (owner, key) pairs from all contracts under test
 * @throws {@link StorageKeyCollisionError}
 */
export function assertNoStorageKeyCollisions(entries: StorageKeyEntry[]): void {
  const collisions = detectStorageKeyCollisions(entries);
  if (collisions.length > 0) {
    throw new StorageKeyCollisionError(collisions);
  }
}
