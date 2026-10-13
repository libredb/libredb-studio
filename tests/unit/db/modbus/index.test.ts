/**
 * The provider class, and the one gap it carries on purpose.
 *
 * THE GAP. This provider declares no `queryDialect`. It cannot: the dialect union is itself a
 * registration surface, a member arrives with three records, and
 * `docs/ADDING_A_PROVIDER.md:1088` says "the build fails until all three exist". Measured:
 * declaring `queryDialect: "modbus"` before those records exist does not typecheck.
 *
 * The cost is not hidden. A `json` provider with no dialect of its own is given MongoDB's tab
 * type, so until the registration change lands this provider's console reads as MongoDB. The test
 * below pins the absence, which means the registration change CANNOT land without turning this
 * test red and making someone decide deliberately. That is the point: a gap nobody is forced to
 * look at is a gap that ships.
 */
import { describe, expect, test } from "bun:test";
import {
  MODBUS_NO_REVOCATION_SENTENCE,
  MODBUS_READ_ONLY_HINT,
  ModbusProvider,
} from "@/lib/db/providers/industrial/modbus/index";
import { QueryError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";

const connection = (extra: Record<string, unknown> = {}) =>
  ({
    id: "c1",
    name: "plant",
    type: "postgres",
    host: "10.0.0.5",
    port: 502,
    ...extra,
  }) as unknown as DatabaseConnection;

const provider = (extra: Record<string, unknown> = {}) => new ModbusProvider(connection(extra));

const MAP = JSON.stringify([
  { name: "run", unitId: 1, table: "coil", address: 0, type: "bool" },
  { name: "volts", unitId: 1, table: "holding_register", address: 100, type: "uint16" },
  { name: "far", unitId: 10, table: "holding_register", address: 300, type: "uint16" },
]);

describe("the declared gap: no query dialect yet", () => {
  test("getCapabilities declares no queryDialect, and this is pinned on purpose", () => {
    const caps = provider().getCapabilities();
    expect(caps.queryDialect).toBeUndefined();
    expect(caps.queryLanguage).toBe("json");
  });

  test("the registration change has to turn this test red to proceed", () => {
    // If a future change adds `queryDialect`, this assertion fails and the comment above is read.
    expect(Object.hasOwn(provider().getCapabilities(), "queryDialect")).toBe(false);
  });
});

describe("the declarations", () => {
  test("read only is enforced and no maintenance is offered", () => {
    const caps = provider().getCapabilities();
    expect(caps.enforcesReadOnly).toBe(true);
    expect(caps.supportsMaintenance).toBe(false);
    expect(caps.maintenanceOperations).toEqual([]);
  });

  test("the default port is the registered one and the tree never refreshes itself", () => {
    const caps = provider().getCapabilities();
    expect(caps.defaultPort).toBe(502);
    expect(caps.schemaRefreshPattern).toBe("(?!)");
  });

  test("each object kind carries the role the specification settled on", () => {
    for (const kind of provider().getCapabilities().objectKinds ?? []) {
      expect(kind.role).toBe("relation");
    }
  });
});

describe("the tree comes from the map, with no device traffic", () => {
  test("a connection with no map lists no unit and no object", async () => {
    const p = provider();
    expect(await p.listContainers()).toEqual([]);
    expect(await p.listObjects([], "coil")).toEqual([]);
  });

  test("counts answer unavailable with no map, never zero", async () => {
    const counts = await provider().countObjects([]);
    for (const kind of ["coil", "discrete_input", "input_register", "holding_register"]) {
      expect(counts[kind]).toHaveProperty("unavailable");
      expect(counts[kind]).not.toHaveProperty("count");
    }
  });

  test("with a map the units are listed in numeric order", async () => {
    const containers = await provider({ registerMap: MAP }).listContainers();
    expect(containers.map((c: { name: string }) => c.name)).toEqual(["1", "10"]);
  });

  test("a container narrows the objects to its own unit", async () => {
    const p = provider({ registerMap: MAP });
    expect((await p.listObjects(["1"], "holding_register")).map((o: { name: string }) => o.name)).toEqual(["volts"]);
    expect((await p.listObjects(["10"], "holding_register")).map((o: { name: string }) => o.name)).toEqual(["far"]);
  });

  test("with a map present a kind the map does not use counts zero, which is an answer", async () => {
    const counts = await provider({ registerMap: MAP }).countObjects(["1"]);
    expect(counts.input_register).toEqual({ count: 0 });
  });
});

describe("what the provider refuses rather than fakes", () => {
  test("connect reports a malformed map rather than waiting for the first read", async () => {
    await expect(provider({ registerMap: "{not json" }).connect()).rejects.toThrow(/not valid JSON/);
  });

  test("connect on an absent map succeeds, because an empty map is a normal state", async () => {
    await expect(provider().connect()).resolves.toBeUndefined();
  });

  test("the read console refuses and says what is missing", async () => {
    await expect(provider({ registerMap: MAP }).query("{}")).rejects.toThrow(/not wired up/);
  });

  test("maintenance is refused with the reason", async () => {
    await expect(provider().runMaintenance()).rejects.toThrow(/no request this provider is allowed/);
  });

  test("the monitoring surfaces answer empty rather than inventing figures", async () => {
    const p = provider();
    expect(await p.getPerformanceMetrics()).toEqual({});
    expect(await p.getSlowQueries()).toEqual([]);
    expect(await p.getActiveSessions()).toEqual([]);
    expect(await p.getTableStats()).toEqual([]);
    expect(await p.getIndexStats()).toEqual([]);
    expect(await p.getStorageStats()).toEqual([]);
  });

  test("health omits activeConnections rather than sending a fabricated zero", async () => {
    const health = await provider({ registerMap: MAP }).getHealth();
    expect(Object.hasOwn(health, "activeConnections")).toBe(false);
    expect(health.cacheHitRatio).toBe("unknown");
  });
});

describe("a refusal is a QueryError, because the product treats it differently", () => {
  /**
   * Measured rather than assumed: `isQueryError` tests `instanceof QueryError`, and at least one
   * reader (`platform/kubernetes/objects.ts:348`) turns a `QueryError` into `{ unavailable }` while
   * letting anything else propagate as an unexpected failure. A refusal thrown as a plain `Error`
   * therefore reaches the user as a crash instead of as the sentence it carries. The first version
   * of the provider threw plain errors; these tests exist so that cannot come back.
   */
  test("the read console's refusal is a QueryError", async () => {
    const error = await provider({ registerMap: MAP })
      .query("{}")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueryError);
  });

  test("the maintenance refusal is a QueryError", async () => {
    const error = await provider()
      .runMaintenance()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueryError);
  });

  test("an unknown point is a QueryError", async () => {
    const error = await provider({ registerMap: MAP })
      .describeObject(["1", "nope"], "holding_register")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueryError);
  });
});

/**
 * These assertions used to live in a `provider-surface.test.ts` that read a second declaration
 * object, `MODBUS_SURFACE`. Nothing in the product read that object: the provider declares its
 * capabilities inline. So those seventeen tests were passengers, green whatever the provider did,
 * and the two declarations had ALREADY diverged on `queryDialect`, which is the one point the
 * provider documents as a gap. The duplicate is deleted and these run against the real class.
 */
describe("every capability this provider does not have, asserted on the real class", () => {
  test.each([
    ["supportsExplain"],
    ["supportsCreateTable"],
    ["supportsInlineRowEdit"],
    ["supportsTransactions"],
    ["supportsResultPagination"],
    ["supportsMaintenance"],
    ["supportsConnectionString"],
    ["supportsExternalQueryLimiting"],
    ["supportsTestDataGeneration"],
    ["declaresForeignKeys"],
    ["tablesAreDerivedGroupings"],
  ])("%s is declared false", (key) => {
    const caps = provider().getCapabilities() as unknown as Record<string, unknown>;
    expect(caps[key]).toBe(false);
  });

  test("no key scan is declared, because nothing is walked", () => {
    expect(provider().getCapabilities().keyScan).toBeUndefined();
  });

  test("one container level, named Unit", () => {
    const levels = provider().getCapabilities().containerLevels ?? [];
    expect(levels).toHaveLength(1);
    expect(levels[0]?.label).toBe("Unit");
  });
});

describe("the sentences the product has to say out loud", () => {
  test("the read only hint says the device enforces nothing", () => {
    expect(MODBUS_READ_ONLY_HINT).toContain("device enforces nothing");
    expect(MODBUS_READ_ONLY_HINT).toContain("can write to it");
  });

  test("the mbaps sentence says revocation is not checked, and names both runtimes", () => {
    expect(MODBUS_NO_REVOCATION_SENTENCE).toContain("does not check revocation");
    expect(MODBUS_NO_REVOCATION_SENTENCE).toContain("Node");
    expect(MODBUS_NO_REVOCATION_SENTENCE).toContain("Bun");
  });
});
