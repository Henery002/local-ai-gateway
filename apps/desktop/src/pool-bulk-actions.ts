export type PoolWithId = {
  id: string;
};

export function normalizePoolSelection<TPool extends PoolWithId>(
  pools: readonly TPool[],
  selectedIds: Iterable<string>,
): Set<string> {
  const availableIds = new Set(pools.map((pool) => pool.id));
  const normalized = new Set<string>();
  for (const id of selectedIds) {
    if (availableIds.has(id)) {
      normalized.add(id);
    }
  }
  return normalized;
}

export function deleteSelectedPools<TPool extends PoolWithId>(
  pools: readonly TPool[],
  selectedIds: Iterable<string>,
): { remainingPools: TPool[]; deletedPools: TPool[] } {
  const normalizedSelection = normalizePoolSelection(pools, selectedIds);
  const remainingPools: TPool[] = [];
  const deletedPools: TPool[] = [];

  for (const pool of pools) {
    if (normalizedSelection.has(pool.id)) {
      deletedPools.push(pool);
    } else {
      remainingPools.push(pool);
    }
  }

  return {
    remainingPools,
    deletedPools,
  };
}
