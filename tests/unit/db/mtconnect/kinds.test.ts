/**
 * Which surface lists which kind, held against the real resolvers rather than against a copy.
 *
 * The field under test is `enumeratedBy`, and the failure it causes is the kind this repository has
 * learned to distrust: MEASURED in main, a kind listed from the Keys panel that does not declare it
 * produces a red Schema Error after connect while every unit test stays green. The compiler says
 * nothing either way, because the field is optional.
 *
 * So this suite calls `enumerableKinds` and `keyBrowserKind` from `src/lib/db/object-kinds.ts` with
 * this provider's own kinds, and then breaks the declaration and shows the check going red
 * (decision K-120). A suite that only ever sees the correct declaration cannot tell a working check
 * from one that returns true.
 */
import { describe, expect, test } from "bun:test";
import { enumerableKinds, keyBrowserKind } from "@/lib/db/object-kinds";
import type { ObjectKindSpec, ProviderCapabilities } from "@/lib/db/types";
import {
  MTCONNECT_DECLARES_KEY_SCAN,
  MTCONNECT_OBJECT_KINDS,
} from "@/lib/db/providers/industrial/mtconnect/capabilities";

/**
 * The smallest capabilities object the two resolvers read. They take `objectKinds` and nothing else
 * here, so the rest is filled from a cast at this one boundary rather than by building a whole
 * provider, and the cast is named so that it cannot spread.
 */
function capabilitiesWith(kinds: readonly ObjectKindSpec[]): ProviderCapabilities {
  return { objectKinds: kinds } as unknown as ProviderCapabilities;
}

describe("the kinds this provider declares", () => {
  test("all three are listed from the tree, so all three are enumerable", () => {
    const enumerable = enumerableKinds(capabilitiesWith(MTCONNECT_OBJECT_KINDS));
    expect(enumerable.map((kind) => kind.id)).toEqual(["dataitem", "condition", "asset"]);
    // Three as a literal, not as `MTCONNECT_OBJECT_KINDS.length`: against its own length this would
    // hold for an empty declaration too, so the count would say nothing.
    expect(enumerable).toHaveLength(3);
  });

  test("no kind is listed from the Keys panel, and the provider says so by name", () => {
    expect(keyBrowserKind(capabilitiesWith(MTCONNECT_OBJECT_KINDS))).toBeUndefined();
    expect(MTCONNECT_DECLARES_KEY_SCAN).toBe(false);
  });

  test("the asset is the one kind with a document, and it names its language", () => {
    const asset = MTCONNECT_OBJECT_KINDS.find((kind) => kind.id === "asset");
    expect(asset?.hasSource).toBe(true);
    expect(asset?.sourceLanguage).toBe("xml");
    // The other two are a value and a timestamp, not a document, so neither claims a Source tab.
    for (const id of ["dataitem", "condition"]) {
      const kind = MTCONNECT_OBJECT_KINDS.find((candidate) => candidate.id === id);
      expect(kind?.hasSource).toBeUndefined();
      expect(kind?.sourceLanguage).toBeUndefined();
    }
  });
});

describe("the check goes red when the declaration is wrong", () => {
  test("a kind marked key-browser disappears from the tree, the inventory and the agent's walk", () => {
    const broken: readonly ObjectKindSpec[] = MTCONNECT_OBJECT_KINDS.map((kind) =>
      kind.id === "dataitem" ? { ...kind, enumeratedBy: "key-browser" as const } : kind,
    );

    const enumerable = enumerableKinds(capabilitiesWith(broken));
    // This is the damage, measured against the real resolver: the kind is gone from every surface
    // that walks all kinds, while `keyBrowserKind` now answers it.
    expect(enumerable.map((kind) => kind.id)).toEqual(["condition", "asset"]);
    expect(enumerable).not.toHaveLength(MTCONNECT_OBJECT_KINDS.length);
    expect(keyBrowserKind(capabilitiesWith(broken))?.id).toBe("dataitem");

    // And the expectation of the suite above would have caught it.
    expect(enumerable.map((kind) => kind.id)).not.toEqual(["dataitem", "condition", "asset"]);
  });

  test("marking every kind key-browser empties the tree entirely", () => {
    const broken: readonly ObjectKindSpec[] = MTCONNECT_OBJECT_KINDS.map((kind) => ({
      ...kind,
      enumeratedBy: "key-browser" as const,
    }));
    expect(enumerableKinds(capabilitiesWith(broken))).toHaveLength(0);
    // A tree with no kinds is what the red Schema Error after connect looks like from here.
    expect(keyBrowserKind(capabilitiesWith(broken))?.id).toBe("dataitem");
  });

  test("the resolvers are the repository's own, so this suite fails if their rule changes", () => {
    // If `enumerableKinds` stopped filtering on `enumeratedBy`, the first test of the broken block
    // would fail: a key-browser kind would still be enumerable.
    // Typed, not coerced: `as unknown as readonly ObjectKindSpec[]` stood here, and a coercion is how a
    // test stops looking. If `ObjectKindSpec` gained a required field, the coerced literal would still
    // compile and this suite would keep asserting about a shape the product no longer has.
    const onlyKeyBrowser: readonly ObjectKindSpec[] = [
      { id: "k", role: "relation", label: "K", labelPlural: "Ks", enumeratedBy: "key-browser" },
    ];
    expect(enumerableKinds(capabilitiesWith(onlyKeyBrowser))).toHaveLength(0);
    expect(keyBrowserKind(capabilitiesWith(onlyKeyBrowser))?.id).toBe("k");
  });
});
