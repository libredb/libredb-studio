/**
 * The process-wide registry of owner-scoped removals (src/lib/db/owner-removal.ts, spec 9.4): each copy of the provider
 * factory registers its `removeProvider`, because Next.js runs the governance loader in another bundle than the route
 * handlers that fill the caches, and the loader asks every copy to remove one subject's providers of a connection.
 *
 * No factory is loaded in this process, so every copy here is a double that records what it was asked.
 */
import { describe, expect, test } from "bun:test";
import { registerOwnerRemoval, removeOwnerProviders } from "@/lib/db/owner-removal";

describe("owner-scoped removal in every copy of the factory", () => {
  test("every registered copy is asked, one that unregistered is not, and with none left the call resolves", async () => {
    const asked: string[] = [];
    const unregisterFirst = registerOwnerRemoval(async (connectionId, { owner }) => {
      asked.push(`first: ${connectionId} of ${owner}`);
    });
    const unregisterSecond = registerOwnerRemoval(async (connectionId, { owner }) => {
      asked.push(`second: ${connectionId} of ${owner}`);
    });

    await removeOwnerProviders("seed:orders", "alice-subject");
    expect(asked).toEqual(["first: seed:orders of alice-subject", "second: seed:orders of alice-subject"]);

    unregisterFirst();
    await removeOwnerProviders("seed:billing", "bob-subject");
    expect(asked.slice(2)).toEqual(["second: seed:billing of bob-subject"]);

    unregisterSecond();
    await removeOwnerProviders("seed:crm", "carol-subject");
    expect(asked).toHaveLength(3);
  });

  test("a copy that fails rejects the call, after every copy was asked", async () => {
    const asked: string[] = [];
    const unregisterFailing = registerOwnerRemoval(async () => {
      throw new Error("the removal failed");
    });
    const unregisterOther = registerOwnerRemoval(async (connectionId) => {
      asked.push(connectionId);
    });
    try {
      await expect(removeOwnerProviders("seed:orders", "alice-subject")).rejects.toThrow("the removal failed");
      expect(asked).toEqual(["seed:orders"]);
    } finally {
      unregisterFailing();
      unregisterOther();
    }
  });

  test("the registry is one per process, kept under a registered symbol another bundle's copy finds", async () => {
    const asked: string[] = [];
    const unregister = registerOwnerRemoval(async (connectionId) => {
      asked.push(`this bundle: ${connectionId}`);
    });
    // Another bundle's copy of this module reaches the same set through the same registered symbol.
    const shared = (globalThis as Record<symbol, Set<(connectionId: string) => Promise<void>>>)[
      Symbol.for("libredb-studio.owner-removals")
    ];
    const remove = async (connectionId: string) => {
      asked.push(`another bundle: ${connectionId}`);
    };
    shared.add(remove);
    try {
      await removeOwnerProviders("seed:orders", "alice-subject");
      expect(asked).toEqual(["this bundle: seed:orders", "another bundle: seed:orders"]);
    } finally {
      shared.delete(remove);
      unregister();
    }
  });
});
