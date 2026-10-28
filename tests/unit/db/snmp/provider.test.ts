/**
 * The provider class, and the three lines that are deliberately not in it.
 *
 * This file holds the registration gap in place. While the three lines are absent the provider
 * declares no dialect of its own, and the editor treats its statements the way it treats
 * anything that declares none. That is a real cost and it is asserted here rather than
 * discovered later: if a dialect appears without the registration change landing with it, this
 * file fails and says so.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";
import { QUERY_DIALECTS } from "@/lib/db/query-dialects";
import { SNMP_LABELS } from "@/lib/db/providers/network/snmp/labels";
import { SNMP_KINDS } from "@/lib/db/providers/network/snmp/objects";
import { SnmpProvider } from "@/lib/db/providers/network/snmp";
import { QueryError } from "@/lib/db/errors";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import { MIB_SCALAR_GROUPS, MIB_TABLES } from "@/lib/db/providers/network/snmp/mib-objects";
import { StatementError } from "@/lib/db/providers/network/snmp/statement";
import { ConnectionRefused } from "@/lib/db/providers/network/snmp/connection-options";

/**
 * The connection's `type` is a placeholder, and that is the registration gap in plain sight:
 * `snmp` is not a member of the shared union yet, so a connection cannot carry it. When the
 * registration change lands this becomes `"snmp"` and the cast goes away.
 */
const provider = () =>
  new SnmpProvider({ id: "t", name: "t", type: "mongodb", host: "127.0.0.1", port: 161 } as DatabaseConnection);

/**
 * This block used to assert the opposite: that no dialect was declared, and that the user was
 * told what that cost. The dialect is registered now, and the measurement that forced it is
 * worth keeping. With `queryDialect` absent the registry does not leave the answer empty, it
 * FALLS BACK: the golden file recorded `tabType: "mongodb"` for this provider, so a tree click
 * on an SNMP agent would have opened a MongoDB editor and MongoDB's generator would have
 * written a `find`. An unregistered dialect is not a gap, it is another engine's answer.
 */
describe("the dialect is this provider's own, not another engine's by default", () => {
  test("the provider declares its dialect", () => {
    const capabilities = provider().getCapabilities() as { queryDialect?: string };
    expect(capabilities.queryDialect).toBe("snmp");
  });

  test("and the registry answers for it rather than falling back", () => {
    expect(QUERY_DIALECTS.snmp.tabType).toBe("snmp");
    expect(QUERY_DIALECTS.snmp.offersCountQuery).toBe(false);
  });
});

/**
 * A kind's count is the number of objects its folder lists, which is the size of the bundled
 * catalog, and never a number of instances on the agent.
 *
 * It used to be `{ unavailable }` for both kinds, and the object tree draws a refused folder as a
 * leaf, so once the catalog was wired the two folders could not be opened at all: found by opening
 * them in a browser against the fixture.
 */
describe("a kind's count is the size of the catalog it lists", () => {
  test("every kind answers the number of objects its listing holds", async () => {
    const p = provider();
    const counts = await p.countObjects();
    expect(Object.keys(counts).sort()).toEqual([...SNMP_KINDS].sort());
    for (const kind of SNMP_KINDS) {
      expect(counts[kind]).toEqual({ count: (await p.listObjects([], kind)).length });
    }
    expect(counts.table).toEqual({ count: MIB_TABLES.length });
  });
});

describe("what is genuinely empty answers empty, and what is missing refuses", () => {
  test("an agent keeps no statement history, no sessions, no table or index statistics", async () => {
    const p = provider();
    expect(await p.getSlowQueries()).toEqual([]);
    expect(await p.getActiveSessions()).toEqual([]);
    expect(await p.getTableStats()).toEqual([]);
    expect(await p.getIndexStats()).toEqual([]);
    expect(await p.getStorageStats()).toEqual([]);
    expect(await p.getPerformanceMetrics()).toEqual({});
  });
  test("one agent has no container level above its objects", async () => {
    expect(await provider().listContainers()).toEqual([]);
  });
  /**
   * This test used to assert that connecting refused because the socket was missing. The socket
   * is wired now, so the refusal an empty connection record draws is about the record: v2c
   * carries a community on every request and this one has none. The sentence moved from "this
   * build has no client" to "your connection is missing something", which is the whole point of
   * the change and is asserted rather than deleted.
   */
  test("connecting on an unconfigured record refuses for what the record is missing", async () => {
    await expect(provider().connect()).rejects.toThrow(ConnectionRefused);
    await expect(provider().connect()).rejects.toThrow(/community/);
  });
  test("closing something never opened is not an error", async () => {
    await expect(provider().disconnect()).resolves.toBeUndefined();
  });
});

describe("a statement is judged before the wiring is blamed", () => {
  test("a write command is refused as a write, not as a missing socket", async () => {
    await expect(provider().query("set sysName.0 x")).rejects.toThrow(StatementError);
    await expect(provider().query("set sysName.0 x")).rejects.toThrow(/reads and never writes/);
  });
  test("a malformed object is refused as malformed", async () => {
    await expect(provider().query("get 1.3.4294967296")).rejects.toThrow(StatementError);
  });
  /**
   * And the acceptable statement now reaches the connection rather than the wiring. A statement
   * run before `connect` is told so by name: there is no socket because none was opened, which
   * is a different thing from there being no socket to open.
   */
  test("an acceptable statement on a closed connection says the connection is closed", async () => {
    await expect(provider().query("get sysDescr.0")).rejects.toThrow(DatabaseConfigError);
    await expect(provider().query("get sysDescr.0")).rejects.toThrow(/not open/);
  });
});

describe("maintenance is refused as a write, not as unimplemented", () => {
  test("the reason names the seam rather than the roadmap", async () => {
    await expect(provider().runMaintenance()).rejects.toThrow(DatabaseConfigError);
    await expect(provider().runMaintenance()).rejects.toThrow(/no code that writes/);
  });
});

describe("the catalog answers from the bundled modules, with no connection and no traffic", () => {
  // Every case here runs on a provider that was never connected: there is no socket to send on, so
  // an answer at all is the proof that the catalog asks the agent nothing.
  test("both kinds declare columns, so the tree opens an object", () => {
    const kinds = provider().getCapabilities().objectKinds ?? [];
    expect(kinds.map((kind) => [kind.id, kind.hasColumns])).toEqual([
      ["table", true],
      ["scalars", true],
    ]);
  });

  test("listing tables answers every bundled table, addressed by its descriptor", async () => {
    const tables = await provider().listObjects([], "table");
    expect(tables).toHaveLength(MIB_TABLES.length);
    expect(tables[0]).toEqual({ path: ["sysORTable"], name: "sysORTable", kind: "table" });
    expect(tables.find((object) => object.name === "udpTable")?.status).toBe("deprecated");
  });

  test("listing scalar groups answers every bundled group", async () => {
    const groups = await provider().listObjects([], "scalars");
    expect(groups).toHaveLength(MIB_SCALAR_GROUPS.length);
    expect(groups[0]).toEqual({ path: ["system"], name: "system", kind: "scalars" });
  });

  test("describing a table answers its columns and its INDEX clause", async () => {
    const detail = await provider().describeObject(["ifTable"], "table");
    expect(detail.columns[0]?.name).toBe("ifIndex");
    expect(detail.indexes).toEqual([{ name: "ifEntry", columns: ["ifIndex"], unique: true }]);
  });

  test("describing a name the modules do not define is refused, not answered empty", async () => {
    await expect(provider().describeObject(["noSuchTable"], "table")).rejects.toThrow(QueryError);
  });

  test("describing an unknown kind names the kinds this provider has", async () => {
    await expect(provider().describeObject(["ifTable"], "collection")).rejects.toThrow(/table and scalars/);
    await expect(provider().describeObjects([], "collection")).rejects.toThrow(/table and scalars/);
  });

  test("describing a whole kind answers one detail per listed object, path for path", async () => {
    const p = provider();
    const listed = await p.listObjects([], "scalars");
    const batch = await p.describeObjects([], "scalars");
    expect(batch.details.map((detail) => detail.path)).toEqual(listed.map((object) => object.path));
    expect(batch).not.toHaveProperty("truncated");
  });

  test("a caller's limit is applied and said, in the shared sentence", async () => {
    const batch = await provider().describeObjects([], "table", 2);
    expect(batch.details.map((detail) => detail.path)).toEqual([["sysORTable"], ["ifTable"]]);
    expect(batch.truncated).toEqual({ limit: 2, reason: callerBoundTruncationReason(2) });
  });

  test("a limit the kind fits inside is not a truncation", async () => {
    const batch = await provider().describeObjects([], "scalars", MIB_SCALAR_GROUPS.length);
    expect(batch).not.toHaveProperty("truncated");
  });
});

describe("health is read from the agent, so it needs an open connection", () => {
  test("reading health before connecting says the connection is closed", async () => {
    await expect(provider().getHealth()).rejects.toThrow(DatabaseConfigError);
    await expect(provider().getHealth()).rejects.toThrow(/not open/);
  });
});

describe("an unknown object kind is named, not guessed at", () => {
  test("it lists the kinds this provider has", async () => {
    await expect(provider().listObjects([], "collection")).rejects.toThrow(/table and scalars/);
  });
});

describe("the labels the provider answers are the ones this build ships", () => {
  test("they are the same object, not a copy that can drift", () => {
    expect(provider().getLabels()).toBe(SNMP_LABELS);
  });
});
