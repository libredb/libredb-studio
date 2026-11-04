/**
 * What `run_opcua_read` answered on the pinned OPC PLC 2.15.10 fixture, held to the capture
 * `tests/live/opcua-mcp-boundary.ts` wrote (tests/fixtures/opcua/2.15.10/mcp-boundary/boundary.json), so the claims of
 * `docs/providers/opcua.md` section 15 and the OPC UA row of `docs/MCP.md`'s cancellation table stay tied to a
 * measurement: every identity read values with their units, history and browses beneath the read roots; every id
 * outside the roots, another client's session object included, answered as the missing twin did for every read kind; a
 * seed without roots was refused before anything was acquired; every refused form sent nothing; the unfenced write
 * changed nothing while the raw write did; and a silent server and a cancel ended as the cancel table says.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const capture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "..", "..", "..", "fixtures", "opcua", "2.15.10", "mcp-boundary", "boundary.json"),
    "utf8",
  ),
);

const IDENTITIES = ["anonymous", "user", "administrator"] as const;

describe("the run_opcua_read capture", () => {
  test("the seeds declared the Telemetry and DataAccess folders by namespace URI, and Server.ServerStatus", () => {
    expect(capture.$captured.roots).toEqual([
      "nsu=http://microsoft.com/Opc/OpcPlc/;s=Telemetry",
      "nsu=http://microsoft.com/Opc/OpcPlc/ReferenceTest;s=DataAccess",
      "i=2256",
    ]);
  });

  test("every identity read values, history and browses, and no answer carried a planted name or an account", () => {
    for (const who of IDENTITIES) {
      const reads = capture.reads[who];
      for (const answer of Object.values(reads) as Array<Record<string, unknown>>) {
        expect(answer).toMatchObject({ isError: false, carriesPlanted: false, carriesAccount: false });
        expect(answer.rows as number).toBeGreaterThan(0);
      }
      expect(reads["browse i=85"].rows).toBe(3);
      expect(reads["browse i=85"].notes[0]).toStartWith("These are this connection's read roots");
    }
  });

  test("every id outside the roots answered as the missing twin, for every read kind and identity", () => {
    expect(capture.$captured.outside).toHaveLength(8);
    for (const who of [...IDENTITIES, "administratorSessionObjects"]) {
      for (const kind of ["read", "history", "browse"]) {
        const counted = capture.outside[who][kind];
        expect([who, kind, counted.alike]).toEqual([who, kind, counted.pairs]);
        expect(counted.pairs).toBeGreaterThan(0);
        expect(counted).toMatchObject({ carriesPlanted: false, carriesAccount: false });
      }
    }
  });

  test("a seed without read roots was refused when the tool opened it, and nothing was acquired", () => {
    expect(capture.rootless.isError).toBe(true);
    expect(capture.rootless.acquired).toEqual([]);
    expect(capture.rootless.text).toContain("agentReadRoots");
  });

  test("every refused form was refused in its own words and sent nothing, and the unfenced write changed nothing", () => {
    expect(capture.refused.map((form: { request: string; code: string }) => [form.request, form.code])).toEqual([
      ["a write", "request"],
      ["a call", "request"],
      ["an index range", "request"],
      ["a data encoding", "request"],
      ["a subscription", "request"],
      ["two reads in one request", "request"],
    ]);
    for (const form of capture.refused) expect(form).toMatchObject({ ownWords: true, unfencedNotSent: true });
    expect(capture.overBudget).toStartWith(
      "The result has more than 1000 rows, the most this server reads for one call.",
    );
    expect(capture.writes).toEqual({
      rawWriteStatus: "Good",
      rawWriteChangedTheValue: true,
      unfencedToolSentNothing: true,
      unfencedToolChangedTheValue: false,
    });
  });

  test("a silent server was the timeout answer at the least timeout_ms, and a cancel answered while the read ran to its time left", () => {
    expect(capture.limits.leastTimeoutAnsweredMs).toBeLessThan(1000);
    expect(capture.limits.leastReadEndedMs).toBeLessThan(1000);
    expect(capture.limits.cancelAnsweredMs).toBeLessThan(1500);
    expect(capture.limits.cancelReadEndedMs).toBeGreaterThanOrEqual(1500);
  });
});
