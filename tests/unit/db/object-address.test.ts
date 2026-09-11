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

/**
 * The tie-breaker, which the rule used to throw away (#789, address fix round 1).
 *
 * Every consumer of this rule holds more than the spelling. A foreign key is declared BY an
 * object that sits in a container, and the engine itself resolves an unqualified target in
 * that container; the object browser's flat reading is pinned to the session default
 * container. The rule saw neither, so `app.orders -> customers` on a server holding `app`
 * and `app_test` refused, and every such refusal cost a diagram an edge or a row its kind.
 *
 * It breaks a TIE and it never promotes: the preferred container is consulted only among
 * the candidates that already share the best rank, so a more qualified match still wins
 * outright over a less qualified one sitting in the preferred container.
 */
describe("resolveObjectAddress takes the container its caller is resolving from", () => {
  test("a tie is broken in favour of the preferred container", () => {
    const resolution = resolveObjectAddress(
      [item("test", "app_test", "customers"), item("app", "app", "customers")],
      segmentsOf,
      "customers",
      ["app"],
    );
    if (resolution.kind !== "resolved") throw new Error(`expected a resolution, got ${resolution.kind}`);
    expect(resolution.object.id).toBe("app");
  });

  test("and in the other arrival order, so it is the container and not the loop deciding", () => {
    const resolution = resolveObjectAddress(
      [item("app", "app", "customers"), item("test", "app_test", "customers")],
      segmentsOf,
      "customers",
      ["app"],
    );
    if (resolution.kind !== "resolved") throw new Error(`expected a resolution, got ${resolution.kind}`);
    expect(resolution.object.id).toBe("app");
  });

  test("a two-level container is compared segment by segment, not by its last segment", () => {
    // SQL Server's session default is `[catalog, dbo]`, and a `dbo` schema exists in every
    // catalog on the server: comparing the last segment alone would tie all of them again.
    const resolution = resolveObjectAddress(
      [item("other", "other", "dbo", "orders"), item("shop", "shop", "dbo", "orders")],
      segmentsOf,
      "orders",
      ["shop", "dbo"],
    );
    if (resolution.kind !== "resolved") throw new Error(`expected a resolution, got ${resolution.kind}`);
    expect(resolution.object.id).toBe("shop");
  });

  test("a tie where NEITHER candidate is in the preferred container still REFUSES", () => {
    // The direction that must not move: making a tie resolvable may not make a genuine
    // ambiguity resolvable. Nothing here says which of the two the spelling meant.
    const resolution = resolveObjectAddress(
      [item("hive", "hive", "sales", "orders"), item("iceberg", "iceberg", "sales", "orders")],
      segmentsOf,
      "sales.orders",
      ["warehouse", "sales"],
    );
    expect(resolution.kind).toBe("ambiguous");
  });

  test("the preferred container NEVER promotes a worse-ranked match", () => {
    // `sales.orders` is an exact address and outranks `warehouse.sales.orders`, and it
    // still does when the preferred container is the deeper one's.
    const resolution = resolveObjectAddress(
      [item("deep", "warehouse", "sales", "orders"), item("exact", "sales", "orders")],
      segmentsOf,
      "sales.orders",
      ["warehouse", "sales"],
    );
    if (resolution.kind !== "resolved") throw new Error(`expected a resolution, got ${resolution.kind}`);
    expect(resolution.object.id).toBe("exact");
  });

  test("the CONTAINER is what is compared, never the whole address", () => {
    // A preferred container spelled as the candidate's own full path matches nothing: the
    // container of `[app, customers]` is `[app]`, and reading the path itself would make
    // every object its own container and break every tie in favour of the first candidate.
    const resolution = resolveObjectAddress(
      [item("app", "app", "customers"), item("test", "app_test", "customers")],
      segmentsOf,
      "customers",
      ["app", "customers"],
    );
    expect(resolution.kind).toBe("ambiguous");
  });

  test("two candidates BOTH in the preferred container still refuse", () => {
    // The tie-break resolves only when the preferred container holds exactly one of them.
    // Choosing the first would file a row under an object nobody named.
    const resolution = resolveObjectAddress(
      [item("first", "app", "customers"), item("second", "app", "customers")],
      segmentsOf,
      "customers",
      ["app"],
    );
    expect(resolution.kind).toBe("ambiguous");
  });

  test("a caller with no container keeps today's behaviour, which is a refusal", () => {
    const resolution = resolveObjectAddress(
      [item("app", "app", "customers"), item("test", "app_test", "customers")],
      segmentsOf,
      "customers",
    );
    expect(resolution.kind).toBe("ambiguous");
  });

  test("a resolution that needed no tie-break is unaffected by the context", () => {
    const resolution = resolveObjectAddress([item("only", "app", "orders")], segmentsOf, "orders", ["elsewhere"]);
    if (resolution.kind !== "resolved") throw new Error(`expected a resolution, got ${resolution.kind}`);
    expect(resolution.object.id).toBe("only");
  });
});

describe("an ambiguous outcome names the candidates", () => {
  test("every item that answered the spelling at the winning rank, by reference", () => {
    // The consumer that answers a model has to say WHICH objects are spelled that way: an
    // ambiguity is repairable by qualifying the spelling and an absence is not, so the two
    // candidates are the whole of the help. By reference, so the caller can read the kind
    // and the address off each.
    const hive = item("hive", "hive", "sales", "orders");
    const iceberg = item("iceberg", "iceberg", "sales", "orders");
    const resolution = resolveObjectAddress(
      [hive, iceberg, item("other", "sales", "customers")],
      segmentsOf,
      "sales.orders",
    );
    if (resolution.kind !== "ambiguous") throw new Error(`expected ambiguous, got ${resolution.kind}`);
    expect(resolution.candidates).toEqual([hive, iceberg]);
  });

  test("a worse-ranked match is NOT a candidate, because it never contested", () => {
    const hive = item("hive", "hive", "sales", "orders");
    const iceberg = item("iceberg", "iceberg", "sales", "orders");
    const resolution = resolveObjectAddress(
      [hive, iceberg, item("deeper", "a", "b", "sales", "orders")],
      segmentsOf,
      "sales.orders",
    );
    if (resolution.kind !== "ambiguous") throw new Error(`expected ambiguous, got ${resolution.kind}`);
    expect(resolution.candidates.map((candidate) => candidate.id)).toEqual(["hive", "iceberg"]);
  });

  test("a tie the preferred container failed to break still names the whole tied set", () => {
    const hive = item("hive", "hive", "sales", "orders");
    const iceberg = item("iceberg", "iceberg", "sales", "orders");
    const resolution = resolveObjectAddress([hive, iceberg], segmentsOf, "sales.orders", ["warehouse", "sales"]);
    if (resolution.kind !== "ambiguous") throw new Error(`expected ambiguous, got ${resolution.kind}`);
    expect(resolution.candidates).toEqual([hive, iceberg]);
  });
});
