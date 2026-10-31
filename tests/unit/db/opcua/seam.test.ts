/**
 * The client seam carries no service that writes (#1677 O-S1).
 *
 * THIS IS THE WHOLE READ-ONLY GUARANTEE, ASSERTED STRUCTURALLY. A behavioural test would check that
 * the provider happens not to write today; this checks that no code in the provider can name a
 * service that writes, which is the claim the documentation makes.
 *
 * The lesson is borrowed, at cost. The MQTT provider's own docblock claimed its decoder's writer was
 * never in the build while the code imported the package root that re-exports it, and three separate
 * reviewers had to load the module by hand before anyone saw it. A sentence in a comment is not a
 * guarantee. This is.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { boundedAgentClient } from "@/lib/db/providers/industrial/opcua/agent-read";
import type { OpcuaReadOnlyClient } from "@/lib/db/providers/industrial/opcua/client";

const PROVIDER = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "src",
  "lib",
  "db",
  "providers",
  "industrial",
  "opcua",
);

/** Source with comments stripped: a docblock naming a rule is not a call site. */
function code(file: string): string {
  return readFileSync(path.join(PROVIDER, file), "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/.*$/gm, "");
}

const SOURCES = readdirSync(PROVIDER).filter((name) => name.endsWith(".ts"));

/**
 * The services OPC UA defines that change something, by their names in the specification and in
 * `node-opcua-client`'s own session (Part 4 5.11.4, 5.12.2, 5.13.2, and Part 4 5.7 node management).
 */
const WRITING_SERVICES = [
  "write",
  "call",
  "callMethod",
  "historyUpdate",
  "addNodes",
  "deleteNodes",
  "addReferences",
  "deleteReferences",
  "createSubscription",
  "createSubscription2",
  "createMonitoredItems",
  "monitorItem",
  // Named after the live review: each is a write or a state change on the server, and each is a
  // method the library's own session carries beside the eight reads.
  "registerNodes",
  "unregisterNodes",
  "writeSingleNode",
  "setMonitoringMode",
  "setTriggering",
  "transferSubscriptions",
  "deleteSubscriptions",
] as const;

describe("the client seam", () => {
  test("the sweep covers every module, so a service added in a new file is seen", () => {
    expect(SOURCES.length).toBeGreaterThan(8);
    expect(SOURCES).toContain("client.ts");
  });

  /**
   * Every module, not only the seam. A `session.write(...)` in `history.ts` would be just as much a
   * write, and a sweep of one file would miss it: the MQTT provider's equivalent test read one file
   * until an audit pointed that out.
   */
  for (const service of WRITING_SERVICES) {
    test(`no module names ${service} as a call`, () => {
      const named: string[] = [];
      for (const file of SOURCES) {
        // `.service(`, `service(` or `["service"](` as a call, not as part of a longer identifier.
        //
        // THE DOT HAD TO COME OUT OF THE CLASS. The first version of this pattern excluded `.` from
        // the character before the name, so `session.write(` never matched and the one form a write
        // would really take walked through: measured, `danger.write(nodeId)` inserted into a copy of
        // `history.ts` left this file at 15 pass, 0 fail. A property access is now what it looks
        // for, and a bracketed one too, because `client["write"](x)` is the same call.
        const calls = new RegExp(
          String.raw`(?:^|[^A-Za-z0-9_$])\.?${service}\s*\(|\[\s*["']${service}["']\s*\]\s*\(`,
          "m",
        );
        if (calls.test(code(file))) named.push(file);
      }
      if (named.length > 0) throw new Error(`${service} is named as a call in: ${named.join(", ")}`);
      expect(named).toEqual([]);
    });
  }

  /**
   * The positive half: the eight services the seam DOES declare. A guarantee that only forbids is
   * one deletion away from forbidding nothing, so the shape is pinned too.
   */
  test("the seam declares exactly the ten members, and nothing else", () => {
    const seam = code("client.ts");
    const declared = [
      "endpoints",
      "limits",
      "browse",
      "browseNext",
      "releaseBrowseContinuationPoints",
      "read",
      "historyRead",
      "historyReadNext",
      "releaseHistoryContinuationPoint",
      "close",
    ];
    // The interface body, so a method name in a comment or in another type is not counted.
    const body = seam.slice(seam.indexOf("export interface OpcuaReadOnlyClient {"));
    const members = [...body.slice(0, body.indexOf("\n}")).matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_]*)\s*\(/gm)].map(
      (match) => match[1],
    );
    // EXACTLY, in both directions: a guarantee that only lists what must be there is one addition
    // away from allowing anything, and `toContain` could not see a `write` added beside them.
    expect(members.sort()).toEqual([...declared].sort());
    // Ten members, eight services: three of them are one service with a field set (BrowseNext with
    // and without release, HistoryRead for a page, a continuation and a release).
    expect(members).toHaveLength(10);
  });

  /**
   * And the interface is the only way to the server. A module that imported `node-opcua-client`
   * directly would have the full session, with `write` on it, whatever this file asserts.
   */
  test("only the library module may import the client library", () => {
    const importers: string[] = [];
    for (const file of SOURCES) {
      if (code(file).includes("node-opcua")) importers.push(file);
    }
    // `library.ts` is the bridge; `session.ts` states the rules over it and must stay clean, so a
    // test of those rules can run with the library outside its import graph (#1677).
    expect(importers).toEqual(["library.ts"]);
  });
});

/**
 * The agent's client is narrower still. An agent read reaches the server only through `boundedAgentClient`, which holds
 * the read members of the seam and nothing else: no GetEndpoints and no CloseSession of its own, and, since the seam has
 * none, no Write, Call, AddNodes, DeleteNodes, AddReferences, DeleteReferences, HistoryUpdate, RegisterNodes,
 * TranslateBrowsePathsToNodeIds, TransferSubscriptions or CreateSubscription.
 */
describe("the agent's client", () => {
  test("holds exactly the eight read members of the seam, and its request count", () => {
    const session = new Proxy({} as OpcuaReadOnlyClient, {
      get: () => () => {
        throw new Error("not called");
      },
    });
    const client = boundedAgentClient(session, { deadlineAt: Number.POSITIVE_INFINITY, timeoutMs: 1, now: () => 0 });
    expect(Object.keys(client).sort()).toEqual(
      [
        "browse",
        "browseNext",
        "historyRead",
        "historyReadNext",
        "limits",
        "read",
        "releaseBrowseContinuationPoints",
        "releaseHistoryContinuationPoint",
        "requests",
      ].sort(),
    );
    expect(Object.isFrozen(client)).toBe(true);
  });
});
