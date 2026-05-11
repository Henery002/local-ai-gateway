import { describe, expect, it } from "vitest";

import {
  deleteSelectedPools,
  normalizePoolSelection,
} from "../apps/desktop/src/pool-bulk-actions.js";

describe("desktop pool bulk actions", () => {
  it("removes selected pools and preserves the remaining order", () => {
    const pools = [
      { id: "pool-a", name: "A" },
      { id: "pool-b", name: "B" },
      { id: "pool-c", name: "C" },
      { id: "pool-d", name: "D" },
    ];

    const result = deleteSelectedPools(pools, new Set(["pool-b", "pool-d"]));

    expect(result.remainingPools.map((pool) => pool.id)).toEqual([
      "pool-a",
      "pool-c",
    ]);
    expect(result.deletedPools.map((pool) => pool.id)).toEqual([
      "pool-b",
      "pool-d",
    ]);
  });

  it("ignores stale selections that no longer exist in the pool list", () => {
    const pools = [
      { id: "pool-a", name: "A" },
      { id: "pool-b", name: "B" },
    ];

    const selectedIds = normalizePoolSelection(pools, [
      "pool-b",
      "pool-missing",
    ]);
    const result = deleteSelectedPools(pools, selectedIds);

    expect([...selectedIds]).toEqual(["pool-b"]);
    expect(result.remainingPools.map((pool) => pool.id)).toEqual(["pool-a"]);
    expect(result.deletedPools.map((pool) => pool.id)).toEqual(["pool-b"]);
  });
});
