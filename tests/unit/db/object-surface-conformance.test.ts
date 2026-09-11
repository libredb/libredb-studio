import { describe, test, expect } from "bun:test";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";

function fakeProvider(overrides: Record<string, unknown> = {}) {
  return {
    getCapabilities: () => ({
      queryLanguage: "sql",
      containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
      objectKinds: [
        { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
        { id: "view", role: "relation", label: "View", labelPlural: "Views" },
      ],
    }),
    listContainers: async () => [{ path: ["app"], name: "app", level: 0 }],
    countObjects: async () => ({ table: { count: 2 }, view: { count: 4 } }),
    listObjects: async (_c: readonly string[], kind: string) =>
      kind === "view" ? [{ path: ["app", "order_summary"], name: "order_summary", kind: "view" }] : [],
    describeObject: async (path: readonly string[]) => ({ path, columns: [], indexes: [], foreignKeys: [] }),
    ...overrides,
  };
}

describe("assertObjectSurface", () => {
  test("passes a provider whose four methods agree with its declarations", async () => {
    await assertObjectSurface(fakeProvider() as never, {
      containers: [["app"]],
      kinds: { table: 2, view: 4 },
      sampleObject: { path: ["app", "order_summary"], kind: "view" },
    });
  });

  test("rejects a count for a kind the provider never declared", async () => {
    const provider = fakeProvider({ countObjects: async () => ({ package: { count: 1 } }) });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        kinds: { package: 1 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/undeclared kind "package"/);
  });

  test("rejects an object whose path does not start with its container", async () => {
    const provider = fakeProvider({
      listObjects: async () => [{ path: ["other", "x"], name: "x", kind: "view" }],
    });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        kinds: { table: 2, view: 4 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/path \["other","x"\] is not inside container \["app"\]/);
  });

  test("rejects a kind declared with no counterpart in countObjects", async () => {
    const provider = fakeProvider({ countObjects: async () => ({ table: { count: 2 } }) });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        kinds: { table: 2 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/declared kind "view" is missing from countObjects/);
  });

  // Not in the task brief. Five of the engines this helper is written for declare no
  // container level at all, so `expected.containers` is empty and every object is
  // addressed at the root container `[]`. That is the arm the `?? []` fallback exists
  // for, and no test in the brief reaches it.
  test("an engine with no container level reads its objects at the root container", async () => {
    const provider = fakeProvider({
      getCapabilities: () => ({
        queryLanguage: "sql",
        objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
      }),
      listContainers: async () => [],
      countObjects: async (container: readonly string[]) => {
        expect(container).toEqual([]);
        return { table: { count: 1 } };
      },
      listObjects: async () => [{ path: ["users"], name: "users", kind: "table" }],
    });
    await assertObjectSurface(provider as never, {
      containers: [],
      kinds: { table: 1 },
      sampleObject: { path: ["users"], kind: "table" },
    });
  });

  // Not in the task brief. A refused read is the third state `KindCount` exists to
  // carry, and a provider that reports it where the expectation names a number has not
  // met the expectation: the engine's own sentence has to reach the failure message
  // rather than being compared against a number as if it were zero.
  test("rejects a refused count and carries the engine's own sentence into the failure", async () => {
    const provider = fakeProvider({
      countObjects: async () => ({
        table: { unavailable: "permission denied for schema app" },
        view: { count: 4 },
      }),
    });
    await expect(
      assertObjectSurface(provider as never, {
        containers: [["app"]],
        kinds: { table: 2, view: 4 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/kind "table" was unavailable: permission denied for schema app/);
  });

  // Not in the task brief. This is the caller's own mistake rather than a provider
  // defect, and it is the one a per-engine caller actually makes: a kind id typed into
  // the expectation that this engine never declares. Without the explicit throw it
  // surfaces as `Cannot use 'in' operator ... in undefined`, which names neither the
  // kind nor the expectation.
  test("rejects an expectation naming a kind that countObjects never answered for", async () => {
    await expect(
      assertObjectSurface(fakeProvider() as never, {
        containers: [["app"]],
        kinds: { materialized_view: 1 },
        sampleObject: { path: ["app", "order_summary"], kind: "view" },
      }),
    ).rejects.toThrow(/countObjects returned nothing for expected kind "materialized_view"/);
  });
});
