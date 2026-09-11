import { describe, expect, test } from "bun:test";
import { addressKeys, resolveObjectAddress } from "@/lib/db/object-address";

/**
 * The one address-resolution rule, asserted where it lives (#789, fix round 2).
 *
 * Its two consumers pin it through their own shapes: `tests/unit/db/detailed-object.test.ts`
 * drives it through the object browser's join with the spellings four named engines produce,
 * and `tests/unit/lib/agent/er-diagram.test.ts` drives it through a foreign key target. This
 * file asserts the rule itself, including the two cases neither consumer can reach through
 * its own fixture: a spelling that is not a suffix at a segment boundary, and an item with no
 * segments at all.
 */

interface Item {
  readonly id: string;
  readonly path: readonly string[];
}

const segmentsOf = (item: Item) => item.path;
const item = (id: string, ...path: string[]): Item => ({ id, path });

describe("addressKeys spells an address every way it can be addressed", () => {
  test("most qualified first, one key per segment dropped", () => {
    expect(addressKeys(["shop", "sales", "orders"])).toEqual(["shop.sales.orders", "sales.orders", "orders"]);
  });

  test("a one-segment address has exactly one spelling", () => {
    expect(addressKeys(["orders"])).toEqual(["orders"]);
  });

  test("no segments is no spellings, which is what makes an empty path address nothing", () => {
    expect(addressKeys([])).toEqual([]);
  });
});

describe("resolveObjectAddress", () => {
  test("an exact address resolves", () => {
    const resolution = resolveObjectAddress([item("a", "sales", "orders")], segmentsOf, "sales.orders");
    expect(resolution).toEqual({ kind: "resolved", object: item("a", "sales", "orders") });
  });

  test("a suffix resolves, at any depth the address has", () => {
    const objects = [item("a", "shop", "sales", "orders")];
    for (const spelling of ["shop.sales.orders", "sales.orders", "orders"]) {
      const resolution = resolveObjectAddress(objects, segmentsOf, spelling);
      if (resolution.kind !== "resolved") throw new Error(`${spelling} did not resolve`);
      expect(resolution.object.id).toBe("a");
    }
  });

  test("the MIDDLE suffix is the one a two-level engine writes, and it is not a special case", () => {
    // The whole defect this rule replaced: the first spelling compared the joined path and
    // the last segment only, so `sales.orders` against `[shop, sales, orders]` missed twice.
    const resolution = resolveObjectAddress([item("a", "shop", "sales", "orders")], segmentsOf, "sales.orders");
    if (resolution.kind !== "resolved") throw new Error("the middle suffix did not resolve");
    expect(resolution.object.id).toBe("a");
  });

  test("the most qualified match wins OUTRIGHT rather than contesting with a deeper one", () => {
    const resolution = resolveObjectAddress(
      [item("deep", "warehouse", "sales", "orders"), item("exact", "sales", "orders")],
      segmentsOf,
      "sales.orders",
    );
    if (resolution.kind !== "resolved") throw new Error("an exact address was not taken");
    expect(resolution.object.id).toBe("exact");
  });

  test("and it wins whichever order the items arrive in", () => {
    // The rank comparison, not the iteration order: a first-wins loop would answer `deep`
    // for one of these two orderings and nothing in the caller says which order it gets.
    const resolution = resolveObjectAddress(
      [item("exact", "sales", "orders"), item("deep", "warehouse", "sales", "orders")],
      segmentsOf,
      "sales.orders",
    );
    if (resolution.kind !== "resolved") throw new Error("an exact address was not taken");
    expect(resolution.object.id).toBe("exact");
  });

  test("two items answering one spelling at the same length are AMBIGUOUS, never chosen between", () => {
    const resolution = resolveObjectAddress(
      [item("hive", "hive", "sales", "orders"), item("iceberg", "iceberg", "sales", "orders")],
      segmentsOf,
      "sales.orders",
    );
    expect(resolution.kind).toBe("ambiguous");
  });

  test("a closer match later in the list clears an ambiguity the longer spellings had", () => {
    // Ambiguity is a property of the WINNING rank, not a latch: two three-segment addresses
    // both end `sales.orders`, and an address that IS `sales.orders` outranks both.
    const resolution = resolveObjectAddress(
      [
        item("hive", "hive", "sales", "orders"),
        item("iceberg", "iceberg", "sales", "orders"),
        item("exact", "sales", "orders"),
      ],
      segmentsOf,
      "sales.orders",
    );
    if (resolution.kind !== "resolved") throw new Error(`expected a resolution, got ${resolution.kind}`);
    expect(resolution.object.id).toBe("exact");
  });

  test("a spelling nothing ends with is ABSENT, which is a different fact from ambiguous", () => {
    expect(resolveObjectAddress([item("a", "sales", "orders")], segmentsOf, "customers")).toEqual({ kind: "absent" });
  });

  test("an empty reading answers absent rather than throwing", () => {
    expect(resolveObjectAddress([], segmentsOf, "orders")).toEqual({ kind: "absent" });
  });

  test("a suffix that is not a SEGMENT boundary does not resolve", () => {
    // `ders` ends the joined string and is not an address. The keys are built from the
    // segments, so a substring match is impossible by construction; this pins that it is.
    expect(resolveObjectAddress([item("a", "sales", "orders")], segmentsOf, "ders")).toEqual({ kind: "absent" });
    expect(resolveObjectAddress([item("a", "sales", "orders")], segmentsOf, "es.orders")).toEqual({ kind: "absent" });
  });

  test("an item with NO segments answers nothing, not even the empty spelling", () => {
    // An empty joined name would otherwise collect every segment-less item under `""`.
    expect(resolveObjectAddress([item("empty")], segmentsOf, "")).toEqual({ kind: "absent" });
  });

  test("the item is returned by reference, so a caller can read whatever else it carries", () => {
    const only = item("a", "sales", "orders");
    const resolution = resolveObjectAddress([only], segmentsOf, "orders");
    if (resolution.kind !== "resolved") throw new Error("expected a resolution");
    expect(resolution.object).toBe(only);
  });
});
