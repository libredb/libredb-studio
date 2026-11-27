import { describe, test, expect } from "bun:test";
import {
  type ContainerEnumeration,
  type ContainerSource,
  describeNamedContainers,
  enumerateContainers,
  namedContainerListings,
  enumerationOf,
  kindsByContainer,
  scopeGroundingContainers,
  scopeReadsUnder,
  sessionDefaultContainer,
} from "@/lib/db/container-walk";
import type { Container, ContainerLevels } from "@/lib/db/types";
import { declaredObjectModel } from "@/lib/provider-host/legacy-object-model";
import { createMockProvider } from "../../helpers/mock-provider";

const container = (name: string, isSessionDefault?: boolean): Container => ({
  path: [name],
  name,
  level: 0,
  ...(isSessionDefault === undefined ? {} : { isSessionDefault }),
});

/**
 * The arm the fleet's provider suites never reach (#789). Every engine that marks a session
 * default marks exactly one, so a live walk exercises the one-default and the no-default cases
 * and nothing else: the two-defaults case is a PROVIDER DEFECT, and what this pins is that the
 * shared rule declines rather than picking one.
 */
describe("sessionDefaultContainer", () => {
  test("answers the one container that says it is the session's", () => {
    expect(sessionDefaultContainer([container("app", true), container("sales")])).toEqual(["app"]);
  });

  test("answers nothing when no container says so, which several engines cannot", () => {
    expect(sessionDefaultContainer([container("app"), container("sales")])).toBeUndefined();
  });

  test("answers nothing when TWO containers say so, rather than picking one", () => {
    // A tie-breaker that guesses is worse than one that declines: the consumer's refusal is
    // correct and its guess is not, and two flagged containers is a provider defect rather
    // than a state any engine really has.
    expect(sessionDefaultContainer([container("app", true), container("sales", true)])).toBeUndefined();
  });

  test("an empty level has no default, which is not the same as the root container", () => {
    expect(sessionDefaultContainer([])).toBeUndefined();
  });

  // `isSessionDefault` is optional and a provider that omits it means "not the session's".
  // `=== true` rather than truthiness, so a provider that writes a string cannot flag one.
  test("only a literal true flags a container", () => {
    const claimed = { path: ["app"], name: "app", level: 0, isSessionDefault: "yes" } as unknown as Container;
    expect(sessionDefaultContainer([claimed])).toBeUndefined();
  });
});

const NAMESPACE_LEVEL = { id: "schema", label: "Namespace", labelPlural: "Namespaces" } as const;

/**
 * A provider's container source, as the three walks that read a provider build it: its capabilities as the object
 * model, and its containers answering as given, recording every parent it was asked about. It declares
 * `containersNameKinds` unless told not to, which is the engine a named container is listed for.
 */
function walked(
  levels: ContainerLevels,
  answer: (parent?: readonly string[]) => Container[],
  namesKinds = true,
): { readonly provider: ContainerSource; readonly asked: (readonly string[] | undefined)[] } {
  const asked: (readonly string[] | undefined)[] = [];
  const provider = createMockProvider({
    capabilities: { containerLevels: levels, ...(namesKinds ? { containersNameKinds: true as const } : {}) },
  });
  provider.listContainers = async (parent?: readonly string[]) => {
    asked.push(parent);
    return answer(parent);
  };
  return {
    provider: { objectModel: provider.getCapabilities(), listContainers: provider.listContainers.bind(provider) },
    asked,
  };
}

describe("the kinds a container walk carries", () => {
  test("a level whose containers name no kinds enumerates exactly as it did before the field existed", () => {
    expect(enumerationOf([container("app", true), container("sales")])).toEqual({
      containers: [["app"], ["sales"]],
      defaultContainer: ["app"],
    });
    expect("containerKinds" in enumerationOf([container("app")])).toBe(false);
  });

  test("a level where one container names kinds carries every container's answer, aligned by index", () => {
    const cluster: Container = { path: ["Cluster"], name: "Cluster", level: 0, kinds: ["nodes"] };
    expect(enumerationOf([cluster, container("shop")])).toEqual({
      containers: [["Cluster"], ["shop"]],
      containerKinds: [["nodes"], undefined],
    });
  });

  test("enumerateContainers reads the kinds off the deepest level it walked", async () => {
    const { provider } = walked([NAMESPACE_LEVEL], () => [
      { path: ["Cluster"], name: "Cluster", level: 0, kinds: ["nodes"] },
      { path: ["shop"], name: "shop", level: 0, kinds: ["pods"], isSessionDefault: true },
    ]);
    expect(await enumerateContainers(provider)).toEqual({
      containers: [["Cluster"], ["shop"]],
      containerKinds: [["nodes"], ["pods"]],
      defaultContainer: ["shop"],
    });
  });

  test("kindsByContainer keys each path once, the first answer winning, and leaves out a container that named none", () => {
    const byPath = kindsByContainer({
      containers: [["Cluster"], ["shop"], ["Cluster"]],
      containerKinds: [["nodes"], undefined, ["pods"]],
    });
    expect([...byPath.entries()]).toEqual([['["Cluster"]', ["nodes"]]]);
    expect(kindsByContainer({ containers: [["app"]] }).size).toBe(0);
  });

  test("named containers are described with one listing per distinct parent, and keep the provider's kinds", async () => {
    const { provider, asked } = walked([NAMESPACE_LEVEL], () => [
      { path: ["Cluster"], name: "Cluster", level: 0, kinds: ["nodes"] },
      { path: ["shop"], name: "shop", level: 0, kinds: ["pods"] },
    ]);
    expect(await describeNamedContainers(provider, [["shop"], ["Cluster"], ["gone"]])).toEqual({
      enumeration: {
        containers: [["shop"], ["Cluster"], ["gone"]],
        containerKinds: [["pods"], ["nodes"], undefined],
      },
      // Not in the listing, so the kinds it holds are unknown: the caller is told rather than guessing.
      unlisted: [["gone"]],
    });
    // One call, with no argument, because every named path hangs under the root.
    expect(asked).toEqual([undefined]);
  });

  test("an engine that does not declare containersNameKinds is never asked, and its named containers keep every kind", async () => {
    const { provider, asked } = walked(
      [NAMESPACE_LEVEL],
      () => {
        throw new Error("an engine that names no container kinds was asked for its containers");
      },
      false,
    );
    expect(await describeNamedContainers(provider, [["shop"], ["gone"]])).toEqual({
      enumeration: { containers: [["shop"], ["gone"]] },
      unlisted: [],
    });
    expect(asked).toEqual([]);
  });

  test("named containers two levels deep ask each distinct parent once", async () => {
    const { provider, asked } = walked(
      [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
      ],
      (parent) => (parent === undefined ? [] : [{ path: [...parent, "app"], name: "app", level: 1 }]),
    );
    expect(
      await describeNamedContainers(provider, [
        ["main", "app"],
        ["main", "ops"],
        ["other", "app"],
      ]),
    ).toEqual({
      enumeration: {
        containers: [
          ["main", "app"],
          ["main", "ops"],
          ["other", "app"],
        ],
      },
      unlisted: [["main", "ops"]],
    });
    expect(asked).toEqual([["main"], ["other"]]);
  });

  test("a listing that repeats a path keeps its first answer, as kindsByContainer does", async () => {
    const { provider } = walked([NAMESPACE_LEVEL], () => [
      { path: ["shop"], name: "shop", level: 0, kinds: ["pods"] },
      { path: ["shop"], name: "shop", level: 0, kinds: ["nodes"] },
    ]);
    expect((await describeNamedContainers(provider, [["shop"]])).enumeration.containerKinds).toEqual([["pods"]]);
  });

  test("namedContainerListings counts the listings describeNamedContainers would issue, before any of them", () => {
    const twoLevels: ContainerLevels = [
      { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
      { id: "schema", label: "Schema", labelPlural: "Schemas" },
    ];
    const refuse = () => {
      throw new Error("counting the listings issued one");
    };
    const named = [
      ["main", "app"],
      ["main", "ops"],
      ["other", "app"],
    ];
    expect(namedContainerListings(walked(twoLevels, refuse).provider, named)).toBe(2);
    expect(namedContainerListings(walked([NAMESPACE_LEVEL], refuse).provider, [["shop"], ["Cluster"]])).toBe(1);
    expect(namedContainerListings(walked(twoLevels, refuse, false).provider, named)).toBe(0);
    expect(namedContainerListings(walked([], refuse).provider, [[]])).toBe(0);
  });

  test("an engine with no container level is never asked to list containers", async () => {
    const { provider, asked } = walked([], () => {
      throw new Error("an engine with no container level was asked for its containers");
    });
    expect(await describeNamedContainers(provider, [[]])).toEqual({ enumeration: { containers: [[]] }, unlisted: [] });
    expect(asked).toEqual([]);
  });

  test("the walk reads any container source, not only a provider", async () => {
    const levels: ContainerLevels = [{ id: "catalog", label: "Database", labelPlural: "Databases" }, NAMESPACE_LEVEL];
    const answer = (parent?: readonly string[]): Container[] =>
      parent === undefined
        ? [{ path: ["db"], name: "db", level: 0 }]
        : [{ path: [...parent, "app"], name: "app", level: 1, kinds: ["table"], isSessionDefault: true }];
    const { provider, asked } = walked(levels, answer);
    const read: (readonly string[] | undefined)[] = [];
    // Two closures, as the object tree's caller facade holds them: no provider members, no `this`.
    const source: ContainerSource = {
      objectModel: { ...provider.objectModel },
      listContainers: async (parent?: readonly string[]) => {
        read.push(parent);
        return answer(parent);
      },
    };

    expect(await enumerateContainers(source)).toEqual(await enumerateContainers(provider));
    expect(await describeNamedContainers(source, [["db", "app"]])).toEqual(
      await describeNamedContainers(provider, [["db", "app"]]),
    );
    expect(read).toEqual(asked);
  });
});

describe("the object model a walk reads", () => {
  test("a walk reads its depth and its kind-naming containers from its source's object model", async () => {
    const levels: ContainerLevels = [{ id: "catalog", label: "Database", labelPlural: "Databases" }, NAMESPACE_LEVEL];
    const answer = (parent?: readonly string[]): Container[] =>
      parent === undefined
        ? [{ path: ["db"], name: "db", level: 0, isSessionDefault: true }]
        : [{ path: [...parent, "app"], name: "app", level: 1, kinds: ["item"], isSessionDefault: true }];
    const asked: (readonly string[] | undefined)[] = [];
    const listContainers = async (parent?: readonly string[]) => {
      asked.push(parent);
      return answer(parent);
    };
    // The session's model in the declaration's form, every member written out, null where the model has none.
    const model = declaredObjectModel({
      containerLevels: levels,
      containersNameKinds: true,
    } as unknown as Parameters<typeof declaredObjectModel>[0]);
    const flat = declaredObjectModel({} as unknown as Parameters<typeof declaredObjectModel>[0]);

    expect(await enumerateContainers({ objectModel: model, listContainers })).toEqual({
      containers: [["db", "app"]],
      containerKinds: [["item"]],
      defaultContainer: ["db", "app"],
    });
    expect(await describeNamedContainers({ objectModel: model, listContainers }, [["db", "app"]])).toEqual({
      enumeration: { containers: [["db", "app"]], containerKinds: [["item"]] },
      unlisted: [],
    });
    expect(namedContainerListings({ objectModel: model, listContainers }, [["db", "app"]])).toBe(1);
    expect(asked).toEqual([undefined, ["db"], ["db"]]);

    // A model of no level is one container, the connection itself, and is never asked to list one.
    expect(await enumerateContainers({ objectModel: flat, listContainers })).toEqual({
      containers: [[]],
      defaultContainer: [],
    });
    expect(
      namedContainerListings({ objectModel: { ...model, containersNameKinds: false }, listContainers }, [
        ["db", "app"],
      ]),
    ).toBe(0);
    expect(asked).toHaveLength(3);
  });
});

describe("scopeGroundingContainers", () => {
  const enumeration: ContainerEnumeration = {
    containers: [["Cluster"], ["default"], ["shop"], ["billing"]],
    containerKinds: [["nodes"], ["pods"], ["pods"], ["pods"]],
    defaultContainer: ["default"],
  };

  test("no scope keeps the whole enumeration and leaves nothing unread", () => {
    expect(scopeGroundingContainers(enumeration, undefined)).toEqual({ enumeration, unread: 0 });
  });

  test("a scope keeps the default and the named containers in walk order, each with its own kinds", () => {
    expect(scopeGroundingContainers(enumeration, { mode: "session-default", alsoWalk: [["Cluster"]] })).toEqual({
      enumeration: {
        containers: [["Cluster"], ["default"]],
        containerKinds: [["nodes"], ["pods"]],
        defaultContainer: ["default"],
      },
      unread: 2,
    });
  });

  test("a named container the enumeration does not hold is not invented", () => {
    const scoped = scopeGroundingContainers(enumeration, { mode: "session-default", alsoWalk: [["kube-system"]] });
    expect(scoped.enumeration.containers).toEqual([["default"]]);
    expect(scoped.unread).toBe(3);
  });

  test("with no session default, only the named containers are read", () => {
    const noDefault: ContainerEnumeration = {
      containers: enumeration.containers,
      containerKinds: enumeration.containerKinds,
    };
    const scoped = scopeGroundingContainers(noDefault, { mode: "session-default", alsoWalk: [["Cluster"]] });
    expect(scoped.enumeration).toEqual({ containers: [["Cluster"]], containerKinds: [["nodes"]] });
    expect(scoped.unread).toBe(3);
  });

  describe("with the parent-default fallback", () => {
    const fallback = {
      mode: "session-default",
      whenNoDefault: { walk: "parent-default-children", skip: ["INFORMATION_SCHEMA"] },
    } as const;
    const twoLevels: ContainerEnumeration = {
      containers: [
        ["OTHER", "PUBLIC"],
        ["SALES", "INFORMATION_SCHEMA"],
        ["SALES", "PUBLIC"],
        ["SALES", "RAW"],
        ["OTHER", "RAW"],
      ],
    };

    test("a deepest default present is read alone, as without the fallback", () => {
      const withDefault: ContainerEnumeration = { ...twoLevels, defaultContainer: ["SALES", "RAW"] };
      expect(scopeGroundingContainers(withDefault, fallback, ["SALES"])).toEqual(
        scopeGroundingContainers(withDefault, { mode: "session-default" }),
      );
      expect(scopeGroundingContainers(withDefault, fallback, ["SALES"]).enumeration.containers).toEqual([
        ["SALES", "RAW"],
      ]);
    });

    test("no deepest default and one parent default reads that parent's children in walk order, minus the skipped", () => {
      expect(scopeGroundingContainers(twoLevels, fallback, ["SALES"])).toEqual({
        enumeration: {
          containers: [
            ["SALES", "PUBLIC"],
            ["SALES", "RAW"],
          ],
        },
        unread: 3,
      });
    });

    test("no deepest default and no parent default reads nothing, as today", () => {
      expect(scopeGroundingContainers(twoLevels, fallback, undefined)).toEqual({
        enumeration: { containers: [] },
        unread: 5,
      });
    });

    test("more than one parent flagged is answered as no parent default, so nothing is read", () => {
      const level: Container[] = [
        { path: ["SALES"], name: "SALES", level: 0, isSessionDefault: true },
        { path: ["OTHER"], name: "OTHER", level: 0, isSessionDefault: true },
      ];
      expect(
        scopeGroundingContainers(twoLevels, fallback, sessionDefaultContainer(level)).enumeration.containers,
      ).toEqual([]);
    });

    test("a parent default without the fallback declared reads nothing, as today", () => {
      expect(
        scopeGroundingContainers(twoLevels, { mode: "session-default" }, ["SALES"]).enumeration.containers,
      ).toEqual([]);
    });
  });

  test("an enumeration that carries no kinds stays without them", () => {
    const noKinds: ContainerEnumeration = {
      containers: enumeration.containers,
      defaultContainer: enumeration.defaultContainer,
    };
    expect(scopeGroundingContainers(noKinds, { mode: "session-default" }).enumeration).toEqual({
      containers: [["default"]],
      defaultContainer: ["default"],
    });
  });
});

describe("scopeReadsUnder", () => {
  const fallback = { mode: "session-default", whenNoDefault: { walk: "parent-default-children" } } as const;
  const named = { mode: "session-default", alsoWalk: [["SHARED", "PUBLIC"]] } as const;

  test("no scope reads under every parent", () => {
    expect(scopeReadsUnder(undefined, container("OTHER"))).toBe(true);
    expect(scopeReadsUnder(undefined, container("OTHER", false))).toBe(true);
  });

  test("a scope reads under the parent marked as the session's, which is also the one its fallback reads", () => {
    expect(scopeReadsUnder({ mode: "session-default" }, container("SALES", true))).toBe(true);
    expect(scopeReadsUnder(fallback, container("SALES", true))).toBe(true);
  });

  test("a scope reads under a parent on the path of a container it names", () => {
    expect(scopeReadsUnder(named, container("SHARED"))).toBe(true);
  });

  test("a scope reads nothing under a parent that is not the session's and not on a named path", () => {
    expect(scopeReadsUnder(fallback, container("OTHER", false))).toBe(false);
    expect(scopeReadsUnder(named, container("OTHER"))).toBe(false);
  });

  test("a named path is matched segment by segment, not as text", () => {
    expect(scopeReadsUnder(named, container("SHARE"))).toBe(false);
    expect(scopeReadsUnder(named, container("SHAREDX"))).toBe(false);
  });
});
