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
import { SNMP_LABELS, SNMP_NO_COUNT } from "@/lib/db/providers/network/snmp/labels";
import { SNMP_KINDS } from "@/lib/db/providers/network/snmp/objects";
import { SnmpNotWired, SnmpProvider } from "@/lib/db/providers/network/snmp";
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

describe("a count is never a zero this provider did not measure", () => {
  test("every kind answers unavailable, with its reason", async () => {
    const counts = await provider().countObjects();
    expect(Object.keys(counts).sort()).toEqual([...SNMP_KINDS].sort());
    for (const value of Object.values(counts)) {
      expect(value).toEqual({ unavailable: SNMP_NO_COUNT });
      expect(value).not.toHaveProperty("count");
    }
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

describe("the three ends that answer with the same sentence as listObjects", () => {
  // `listObjects` already had a case and these three did not, so the sentence a reader meets was
  // only ever measured on one of the four ends that give it. They are separate methods with
  // separate strings, and a wrong word in one of them would have cost nothing to keep.
  test("describing one object says what is missing", async () => {
    await expect(provider().describeObject()).rejects.toThrow(SnmpNotWired);
    await expect(provider().describeObject()).rejects.toThrow(/Describing an object needs the SNMP client/);
  });

  test("describing many objects says the same", async () => {
    await expect(provider().describeObjects()).rejects.toThrow(/Describing objects needs the SNMP client/);
  });

  test("reading health says the same", async () => {
    await expect(provider().getHealth()).rejects.toThrow(/Reading health needs the SNMP client/);
  });

  test("and every one of them names the socket as the missing piece", async () => {
    // The second half of that sentence is the half that tells a reader this is wiring rather
    // than a refusal: the parsing, the bounds and the refusals are in place, the socket is not.
    await expect(provider().getHealth()).rejects.toThrow(/what is missing is the socket/);
  });
});

describe("an unknown object kind is named, not guessed at", () => {
  test("it lists the kinds this provider has", async () => {
    await expect(provider().listObjects([], "collection")).rejects.toThrow(/table and scalars/);
  });
  test("a known kind gets past the check and refuses for the wiring", async () => {
    await expect(provider().listObjects([], "table")).rejects.toThrow(SnmpNotWired);
  });
});

describe("the labels the provider answers are the ones this build ships", () => {
  test("they are the same object, not a copy that can drift", () => {
    expect(provider().getLabels()).toBe(SNMP_LABELS);
  });
});
