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
  atBoundary,
  MODBUS_NO_MAP_INVENTORY_SENTENCE,
  MODBUS_NO_REVOCATION_SENTENCE,
  MODBUS_READ_ONLY_HINT,
  ModbusProvider,
} from "@/lib/db/providers/industrial/modbus/index";
import { ModbusMapError } from "@/lib/db/providers/industrial/modbus/register-map";
import { ModbusRequestError } from "@/lib/db/providers/industrial/modbus/pdu";
import { ModbusDecodeError } from "@/lib/db/providers/industrial/modbus/values";
import { ModbusValveDefect } from "@/lib/db/providers/industrial/modbus/valve";
import { QUERY_DIALECTS } from "@/lib/db/query-dialects";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
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

/**
 * FOUR READER ACTIONS, FOUR CLASSES, AND THE DIFFERENCE IS IN THE CLASS RATHER THAN THE SENTENCE.
 *
 * Before this, one of nine refusal classes was converted and the other eight fell through as plain
 * Errors, which the API layer reports as 500 INTERNAL_ERROR. That put the user's own bad read
 * request in the same bucket as OUR defect, and a sentence telling them apart helps a person
 * reading prose and nothing that branches on a field.
 *
 * What a reader does next is the test: edit the REQUEST, edit the MAP, look at the DEVICE, or tell
 * us. Each assertion below names one of those.
 */
describe("a refusal carries what the reader has to act on", () => {
  test("a fault in the read request is a QueryError: the thing to change is the console text", () => {
    const converted = atBoundary(new ModbusRequestError("Quantity must be a whole number from 1 to 125."));
    expect(converted).toBeInstanceOf(QueryError);
    expect((converted as Error).message).toContain("1 to 125");
  });

  test("a fault in the register map is a DatabaseConfigError: the thing to change is the map", () => {
    expect(atBoundary(new ModbusMapError("the map is not valid JSON"))).toBeInstanceOf(DatabaseConfigError);
  });

  test("a decode fault is read as the map's, because every sentence it carries compares the two", () => {
    const converted = atBoundary(new ModbusDecodeError("Type float32 needs 2 register(s) and 1 were given."));
    expect(converted).toBeInstanceOf(DatabaseConfigError);
    expect(converted).not.toBeInstanceOf(QueryError);
  });

  test("OUR defect is not dressed as the user's: a valve refusal rises by identity", () => {
    // The valve fires on bytes this code built, so a 400 here would send someone to fix a document
    // that has nothing wrong with it, and would hide the one failure that should reach us.
    const planted = new ModbusValveDefect("Outbound function code 6 writes.");
    expect(atBoundary(planted)).toBe(planted);
    expect(atBoundary(planted)).not.toBeInstanceOf(QueryError);
    expect(atBoundary(planted)).not.toBeInstanceOf(DatabaseConfigError);
  });

  test("the four are four, not two: no two of them land on one class", () => {
    const classOf = (e: unknown) => {
      const out = atBoundary(e);
      if (out instanceof QueryError) return "query";
      if (out instanceof DatabaseConfigError) return "config";
      return "rises";
    };
    expect([
      classOf(new ModbusRequestError("x")),
      classOf(new ModbusMapError("x")),
      classOf(new ModbusValveDefect("x")),
    ]).toEqual(["query", "config", "rises"]);
  });
});

describe("the dialect, and the gap it closed", () => {
  /**
   * This describe used to hold the opposite pair: `queryDialect` was undefined, and a second test
   * said the registration change "has to turn this test red to proceed". It did, and these are
   * what it turned into. The gap was not cosmetic: a `json` provider with no dialect of its own is
   * given MongoDB's tab type by `resolveTabType`, so the console read as MongoDB.
   */
  test("the provider declares its own dialect, so the console is not given another engine's", () => {
    const caps = provider().getCapabilities();
    expect(caps.queryLanguage).toBe("json");
    expect(caps.queryDialect).toBe("modbus");
  });

  test("the dialect the provider names has a registry entry, and that entry names its own tab type", () => {
    // Nothing forces a dialect to carry a tab type of its own: an entry saying `tabType: "sql"`
    // compiles. The pair is what keeps this engine's console its own, so the pair is asserted.
    expect(provider().getCapabilities().queryDialect).toBe("modbus");
    expect(QUERY_DIALECTS.modbus.tabType).toBe("modbus");
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

describe("the container path is checked, not taken", () => {
  /**
   * The guard was wired and NOTHING asserted it: removing the call left every test green
   * (MEASURED, round 18). A declaration with no check behind it lets a path of the wrong length
   * reach the map lookup, which then answers "no such point" and names the wrong mistake (#1147).
   */
  test("a path with more levels than the tree has is refused, and the refusal says the shape", async () => {
    const p = provider({ registerMap: MAP });
    await expect(p.listObjects(["1", "extra"], "coil")).rejects.toThrow(QueryError);
    await expect(p.listObjects(["1", "extra"], "coil")).rejects.toThrow(/container path/i);
  });

  test("counts are checked the same way, so the two surfaces cannot drift apart", async () => {
    await expect(provider({ registerMap: MAP }).countObjects(["1", "extra"])).rejects.toThrow(QueryError);
  });

  test("the control: the shape the tree actually sends is accepted", async () => {
    const p = provider({ registerMap: MAP });
    expect(await p.listObjects(["1"], "holding_register")).toHaveLength(1);
  });
});

describe("the tree comes from the map, with no device traffic", () => {
  test("a connection with no map lists no unit and no object", async () => {
    const p = provider();
    expect(await p.listContainers()).toEqual([]);
    // A unit path, not the empty one. The empty path is refused by the container-path guard, and
    // the product never sends it: the route checks the shape before the provider is reached, and
    // the tree asks for objects only under a container it has already listed. Four tests here used
    // `[]` and the guard turned all four red at once, which is the guard doing its job.
    expect(await p.listObjects(["1"], "coil")).toEqual([]);
  });

  test("counts answer unavailable with no map, never zero", async () => {
    const counts = await provider().countObjects(["1"]);
    for (const kind of ["coil", "discrete_input", "input_register", "holding_register"]) {
      expect(counts[kind]).toHaveProperty("unavailable");
      expect(counts[kind]).not.toHaveProperty("count");
    }
  });

  /**
   * U189: with no map nothing of the device can be listed, which is not a device that holds nothing. The provider
   * says so with its own reason, and the agent's grounding reads that declaration instead of reading no unit as none.
   */
  test("declares that its inventory needs a register map when the connection keeps none, with its reason", async () => {
    expect(await provider().inventoryNeedsConfiguration()).toBe(MODBUS_NO_MAP_INVENTORY_SENTENCE);
    expect(await provider({ registerMap: "[]" }).inventoryNeedsConfiguration()).toBe(MODBUS_NO_MAP_INVENTORY_SENTENCE);
    expect(MODBUS_NO_MAP_INVENTORY_SENTENCE).toBe(
      "this connection keeps no register map, and Modbus has no request that lists what a device holds, so none of its points can be listed",
    );
  });

  test("declares nothing once a map is kept, since the map is then the inventory", async () => {
    expect(await provider({ registerMap: MAP }).inventoryNeedsConfiguration()).toBeUndefined();
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
  /**
   * This test asserted the MESSAGE only, and that is how the defect hid. The three refusals this
   * class throws itself were asserted by TYPE, and the one it merely lets through was asserted by
   * text, so `connect` rejected with a `ModbusMapError` for as long as the suite stayed green. The
   * message assertion stays, because the sentence matters too, but the type is what carries it.
   */
  test("connect reports a malformed map as a configuration fault, not a query failure", async () => {
    const error = await provider({ registerMap: "{not json" })
      .connect()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error).not.toBeInstanceOf(QueryError);
    expect((error as Error).message).toMatch(/not valid JSON/);
  });

  test.each([
    ["listObjects", (p: ReturnType<typeof provider>) => p.listObjects(["1"], "coil")],
    ["countObjects", (p: ReturnType<typeof provider>) => p.countObjects(["1"])],
    ["listContainers", (p: ReturnType<typeof provider>) => p.listContainers()],
    ["inventoryNeedsConfiguration", (p: ReturnType<typeof provider>) => p.inventoryNeedsConfiguration()],
    ["getHealth", (p: ReturnType<typeof provider>) => p.getHealth()],
    ["getOverview", (p: ReturnType<typeof provider>) => p.getOverview()],
  ])("%s converts a malformed map at the boundary too", async (_name, call) => {
    const error = await call(provider({ registerMap: "{not json" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseConfigError);
  });

  /**
   * The measurement behind the choice of type. Every surface that reads anything reads the same
   * document, so an unparseable map leaves no kind that still works: it is the connection that is
   * wrong, not one read. Six of six is the evidence, and if a seventh surface is added it belongs
   * in this list.
   */
  test("a malformed map fails every surface alike, which is why it rises as configuration", async () => {
    const p = provider({ registerMap: "{not json" });
    const outcomes = await Promise.all(
      [
        () => p.connect(),
        () => p.listContainers(),
        () => p.countObjects(["1"]),
        () => p.listObjects(["1"], "coil"),
        () => p.getHealth(),
        () => p.getOverview(),
      ].map((call) =>
        call()
          .then(() => "served" as const)
          .catch(() => "refused" as const),
      ),
    );
    expect(outcomes).toEqual(["refused", "refused", "refused", "refused", "refused", "refused"]);
  });

  /**
   * The boundary has to be SELECTIVE, and this is the case that proves it. A programming mistake
   * is not a query failure: dressed as one, it sends a developer to look at the device instead of
   * at the code. So converting everything would be as wrong as converting nothing.
   */
  /**
   * The first version of this test made a getter throw and asserted the error came back unchanged.
   * A mutation proved it was a passenger: converting EVERYTHING at the boundary left it green,
   * because the getter throws before the wrapped region is entered, so the error never reached the
   * boundary at all. A test of a dead path measures nothing. The rule belongs to one function, so
   * it is tested on that function.
   */
  test("an unrelated error passes through the boundary unchanged, by identity", () => {
    const boom = new TypeError("undefined is not a function");
    expect(atBoundary(boom)).toBe(boom);
    expect(atBoundary(boom)).not.toBeInstanceOf(QueryError);
  });

  test("a map refusal becomes a DatabaseConfigError and keeps its sentence", () => {
    const converted = atBoundary(new ModbusMapError("the map is not valid JSON"));
    expect(converted).toBeInstanceOf(DatabaseConfigError);
    expect(converted).not.toBeInstanceOf(QueryError);
    expect((converted as Error).message).toBe("the map is not valid JSON");
  });

  test("a QueryError is returned as the same instance, not wrapped twice", () => {
    const already = new QueryError("already converted");
    expect(atBoundary(already)).toBe(already);
  });

  test("the three cases give three different answers, which is what makes the rule a rule", () => {
    const unrelated = new TypeError("x");
    const mapError = new ModbusMapError("y");
    const already = new QueryError("z");
    expect(atBoundary(unrelated)).toBe(unrelated);
    expect(atBoundary(mapError)).not.toBe(mapError);
    expect(atBoundary(already)).toBe(already);
  });

  /**
   * "An empty map is a normal state" moved to `wired.test.ts` with `connect`'s dial: the claim is
   * about the MAP being acceptable, and connect now also answers for the device, so proving it
   * needs an address that answers.
   */

  test("an empty request is refused before any socket, and the refusal names the three shapes", async () => {
    // This test used to assert "not wired up". The console reads now, and what it still refuses is
    // a request that names no shape - refused by the parser, so no connection is attempted. The
    // reading itself is measured over a real socket in `wired.test.ts`.
    const run = provider({ registerMap: MAP }).query("{}");
    await expect(run).rejects.toThrow(/"read"/);
    await expect(provider({ registerMap: MAP }).query("{}")).rejects.toThrow(/"identify"/);
  });

  test("maintenance is refused with the reason", async () => {
    await expect(provider().runMaintenance()).rejects.toThrow(/sends no maintenance request/);
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

  /**
   * The shape of the health answer moved to `wired.test.ts`, with the rest of the reads.
   *
   * It used to run here with no server, which stopped being possible the moment health began to
   * dial when the map is empty: the assertion was about the answer's SHAPE and the test was
   * spending three seconds proving a dial timeout. The claim did not weaken, it moved to the file
   * that has a device to answer it.
   */
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

  test("no create-table grammar is declared, so the form, the tree item and import into a new table stay off", () => {
    expect(provider().getCapabilities().createTable).toBeUndefined();
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

/**
 * The overview answers from the MAP, because a Modbus device publishes none of what an overview
 * asks for. Every number below is therefore a fact about what this provider can address, and the
 * two that a device does not publish are said as words rather than guessed at as numbers.
 */
describe("the overview of a device that publishes no overview", () => {
  test("counts the map's points, and says the rest is unknown rather than inventing it", async () => {
    expect(await provider({ registerMap: MAP }).getOverview()).toEqual({
      version: "Modbus TCP",
      uptime: "unknown",
      maxConnections: 1,
      databaseSize: "3 points",
      tableCount: 3,
      indexCount: 0,
    });
  });

  test("a connection with no map at all reports the size as unknown, not as zero", async () => {
    const overview = await provider().getOverview();

    // Absence and zero are different facts: no map means nothing is addressable yet, while `0
    // points` would read as a map that was read and found empty.
    expect(overview.databaseSize).toBe("unknown");
    expect(overview.tableCount).toBe(0);
  });
});
