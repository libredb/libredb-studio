/**
 * What the OPC UA agent path answered on the pinned OPC PLC 2.15.10 fixture beneath read roots, held to the capture
 * `tests/live/opcua-agent-boundary.ts` wrote (tests/fixtures/opcua/2.15.10/agent-boundary/boundary.json), so the claims
 * of `docs/providers/opcua.md` section 14 and the walk's measured cost stay tied to a measurement: a statement profile
 * without roots opened no session; every identity's walk took the same requests and read values with their units,
 * history and browses; every id outside the roots, a session object the administrator is shown included, answered as
 * the missing twin did and sent the same requests, none naming it; and the server's state did not move.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPCUA_READ_SET_MAX_REQUESTS } from "@/lib/db/providers/industrial/opcua/agent-roots";

const capture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "..", "..", "fixtures", "opcua", "2.15.10", "agent-boundary", "boundary.json"),
    "utf8",
  ),
);

const IDENTITIES = ["anonymous", "user", "administrator"] as const;
const readOf = (who: string, statement: string) =>
  capture.agent[who].reads.find((read: { statement: string }) => read.statement === statement);

describe("the OPC UA agent boundary capture", () => {
  test("the roots name namespaces 3 and 6 by the URIs the fixture's table lists", () => {
    expect(capture.namespaces).toEqual({
      3: "http://microsoft.com/Opc/OpcPlc/",
      6: "http://microsoft.com/Opc/OpcPlc/ReferenceTest",
    });
    expect(capture.roots).toEqual([
      "nsu=http://microsoft.com/Opc/OpcPlc/;s=Telemetry",
      "nsu=http://microsoft.com/Opc/OpcPlc/ReferenceTest;s=DataAccess",
      "i=2256",
    ]);
  });

  test("a statement profile without roots was refused before any session", () => {
    expect(capture.withoutRoots.sessionsOpened).toBe(0);
    expect(capture.withoutRoots.refused).toStartWith("READ_ROOTS_REQUIRED: ");
  });

  test("the fixture took a raw anonymous Write and reached a method, so the seam is the boundary", () => {
    expect(capture.rawWrite).toMatchObject({ status: "Good", valueUnchanged: true });
    expect(capture.rawCall).toMatchObject({
      status: "BadSubscriptionIdInvalid",
      resetToServerDefaultsUserExecutable: true,
    });
  });

  test("every identity's walk took the same requests, well inside the walk's bound", () => {
    const walks = IDENTITIES.map((who) => capture.agent[who].walk.walkRequests);
    expect(new Set(walks).size).toBe(1);
    expect(walks[0]).toBeLessThan(OPCUA_READ_SET_MAX_REQUESTS);
    for (const who of IDENTITIES) expect(capture.agent[who].walk.rowCount).toBe(3);
    expect(capture.walks["the three roots"].walkRequests).toBe(walks[0]);
  });

  test("every identity read a value with its units, history and browses beneath the roots", () => {
    for (const who of IDENTITIES) {
      const values = readOf(who, '{"read":["ns=6;s=DataAccess_AnalogType_Int32","ns=3;s=SlowUInt1"]}');
      expect(values.rows[0]).toMatchObject({ statusCode: "Good", units: "mV", euRange: "0 to 100" });
      expect(values.rows[1]).toMatchObject({ units: "no units published", euRange: "no range published" });
      expect(readOf(who, '{"history":"ns=3;s=HistorianInt32","limit":5}').rowCount).toBe(5);
      expect(readOf(who, '{"browse":"ns=3;s=Telemetry"}').rowCount).toBeGreaterThan(0);
      expect(readOf(who, '{"browse":"i=2256"}').rowCount).toBe(6);
      expect(readOf(who, '{"history":"ns=3;s=HistorianInt32"}').refused).toContain("row budget");
    }
  });

  test("every id outside the roots answered and sent as its missing twin did, and no request named it", () => {
    const sets = [
      ...IDENTITIES.map((who) => capture.agent[who].outsideBesideMissing),
      capture.administratorSessionObject,
    ];
    for (const set of sets) {
      for (const kind of ["read", "history", "browse"]) {
        const counted = set[kind];
        expect(counted.pairs).toBeGreaterThan(0);
        expect([kind, counted.answersAlike, counted.requestsAlike]).toEqual([kind, counted.pairs, counted.pairs]);
        expect(counted.requestsNamingTheId).toBe(0);
      }
    }
  });

  test("a write and an index range were refused before anything was sent", () => {
    for (const who of IDENTITIES) {
      for (const read of capture.agent[who].reads.filter((r: { refused?: string }) =>
        r.refused?.startsWith("RefusedBeforeSendError"),
      ))
        expect(read.sent).toBe(0);
    }
  });

  test("the server's values and its session count read the same after the agent's reads", () => {
    expect(capture.serverState).toMatchObject({ configurationUnchanged: true, sessionsLeftBehind: 0 });
  });
});
