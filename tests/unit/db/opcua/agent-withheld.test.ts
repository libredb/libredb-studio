/**
 * The withheld parts of an OPC UA server: the standard roots by node id, every spelling of one id compared as one, and
 * the walk under the roots read through Browse alone before every agent read, refused rather than guessed where the
 * server will not say.
 */
import { describe, expect, test } from "bun:test";
import {
  canonicalNodeId,
  OPCUA_WITHHELD_NODES,
  OPCUA_WITHHELD_SENTENCE,
  OPCUA_WITHHELD_WALK_MAX_DEPTH,
  OPCUA_WITHHELD_WALK_MAX_NODES,
  OpcuaWithheldWalkError,
  withheldNodes,
  withheldReason,
  withheldRootOf,
} from "@/lib/db/providers/industrial/opcua/agent-withheld";
import type { OpcuaBrowseResult, OpcuaNodeId, OpcuaReference } from "@/lib/db/providers/industrial/opcua/client";

const ref = (nodeId: string, nodeClass = "Object"): OpcuaReference => ({
  nodeId,
  browseName: nodeId,
  displayName: nodeId,
  nodeClass,
  referenceTypeId: "ns=0;i=47",
  mayHaveChildren: nodeClass !== "Method",
});

/** A server whose tree a test states; a node it does not hold answers BadNodeIdUnknown, as OPC PLC does. */
function server(
  tree: Readonly<Record<string, readonly OpcuaReference[]>>,
  over: Partial<Record<string, string>> = {},
  pages: Readonly<Record<string, readonly OpcuaReference[]>> = {},
) {
  const browsed: OpcuaNodeId[][] = [];
  const continued: number[] = [];
  return {
    browsed,
    continued,
    client: {
      browse: async (ids: readonly OpcuaNodeId[]): Promise<readonly OpcuaBrowseResult[]> => {
        browsed.push([...ids]);
        return ids.map((nodeId) => ({
          nodeId,
          references: tree[nodeId] ?? [],
          statusCode: over[nodeId] ?? (nodeId in tree ? "Good" : "BadNodeIdUnknown"),
          ...(nodeId in pages ? { continuationPoint: new TextEncoder().encode(nodeId) } : {}),
        }));
      },
      browseNext: async (points: readonly Uint8Array[]): Promise<readonly OpcuaBrowseResult[]> => {
        continued.push(points.length);
        const nodeId = new TextDecoder().decode(points[0]);
        return [{ nodeId, references: pages[nodeId] ?? [], statusCode: over[`${nodeId}#next`] ?? "Good" }];
      },
    },
  };
}

describe("the withheld roots", () => {
  test("are the standard nodes the ruling names, by numeric id in namespace 0", () => {
    expect(OPCUA_WITHHELD_NODES.map((entry) => entry.nodeId)).toEqual([
      "i=12637",
      "i=15606",
      "i=3706",
      "i=3707",
      "i=3708",
      "i=15443",
      "i=25440",
    ]);
  });

  test("each carries its reason, and the shared sentence names every one", () => {
    for (const entry of OPCUA_WITHHELD_NODES) {
      expect(withheldReason(entry)).toStartWith(`${entry.kind} (${entry.nodeId}) is withheld from agent mode`);
      expect(OPCUA_WITHHELD_SENTENCE).toContain(`${entry.kind} (${entry.nodeId})`);
    }
  });

  test("every spelling of a root is the root, and nothing else is", () => {
    for (const spelling of ["i=12637", "ns=0;i=12637", "nsu=http://opcfoundation.org/UA/;i=12637"])
      expect(withheldRootOf(spelling)?.nodeId).toBe("i=12637");
    expect(withheldRootOf("ns=1;i=12637")).toBeUndefined();
    expect(withheldRootOf("i=126370")).toBeUndefined();
    expect(withheldRootOf("s=i=12637")).toBeUndefined();
  });
});

describe("canonicalNodeId", () => {
  test("namespace 0 is one node however it is written", () => {
    expect(canonicalNodeId("ns=0;i=2253")).toBe("i=2253");
    expect(canonicalNodeId("nsu=http://opcfoundation.org/UA/;s=x")).toBe("s=x");
    expect(canonicalNodeId("ns=3;s=SlowUInt1")).toBe("ns=3;s=SlowUInt1");
  });

  test("a GUID is compared in lower case, and a String identifier keeps its own semicolons and case", () => {
    expect(canonicalNodeId("ns=2;g=ABCDEF01-2345-6789-ABCD-EF0123456789")).toBe(
      "ns=2;g=abcdef01-2345-6789-abcd-ef0123456789",
    );
    expect(canonicalNodeId("ns=3;s=a;g=AB")).toBe("ns=3;s=a;g=AB");
    expect(canonicalNodeId("s=A;B")).toBe("s=A;B");
  });

  test("any other namespace URI, or namespace 0's URI with an index after it, has no canonical spelling here", () => {
    expect(canonicalNodeId("nsu=urn:plant;i=1")).toBeUndefined();
    expect(canonicalNodeId("nsu=http://opcfoundation.org/UA/;ns=0;i=1")).toBeUndefined();
    expect(canonicalNodeId("nsu=http://opcfoundation.org/UA/x;i=1")).toBeUndefined();
  });
});

describe("withheldNodes", () => {
  test("walks every root through Browse, and withholds what the server answers beneath them", async () => {
    const fake = server({
      "i=12637": [ref("ns=0;i=14053"), ref("ns=0;i=25709", "Method")],
      "ns=0;i=14053": [ref("ns=0;i=14156")],
      "ns=0;i=14156": [],
      "i=3706": [ref("ns=7;i=1324504778")],
      "ns=7;i=1324504778": [ref("ns=7;i=1324504823", "Variable")],
      "ns=7;i=1324504823": [],
      "i=15606": [],
    });
    const set = await withheldNodes(fake.client);
    expect(set.get("i=14156")?.nodeId).toBe("i=12637");
    expect(set.get("ns=7;i=1324504823")?.nodeId).toBe("i=3706");
    // A method is a member and is never browsed.
    expect(set.get("i=25709")?.nodeId).toBe("i=12637");
    expect(fake.browsed.flat()).not.toContain("ns=0;i=25709");
    // The roots are asked first, together, in one chunk.
    expect(fake.browsed[0]).toEqual(OPCUA_WITHHELD_NODES.map((entry) => entry.nodeId));
  });

  test("a root the server does not hold has nothing beneath it", async () => {
    const set = await withheldNodes(server({}).client);
    expect([...set.keys()]).toEqual(OPCUA_WITHHELD_NODES.map((entry) => entry.nodeId));
  });

  test("a node the server will not browse for this identity stays withheld, with nothing listed beneath it", async () => {
    const fake = server(
      { "i=12637": [ref("ns=0;i=14053")], "ns=0;i=14053": [] },
      { "i=3707": "BadUserAccessDenied", "ns=0;i=14053": "BadUserAccessDenied" },
    );
    const set = await withheldNodes(fake.client);
    expect(set.get("i=3707")?.nodeId).toBe("i=3707");
    expect(set.get("i=14053")?.nodeId).toBe("i=12637");
  });

  test("any other refusal of a root, or of a node beneath one, refuses the read", async () => {
    await expect(withheldNodes(server({}, { "i=15606": "BadTooManyOperations" }).client)).rejects.toThrow(
      "the server answered BadTooManyOperations to a browse of them",
    );
    const below = server({ "i=12637": [ref("ns=0;i=14053")] }, { "ns=0;i=14053": "BadNodeIdUnknown" });
    await expect(withheldNodes(below.client)).rejects.toBeInstanceOf(OpcuaWithheldWalkError);
  });

  test("an answer missing from the browse refuses the read", async () => {
    const client = { browse: async () => [], browseNext: async () => [] };
    await expect(withheldNodes(client)).rejects.toThrow("the server answered nothing");
  });

  test("continuation points are followed to the end of a level", async () => {
    const fake = server(
      { "i=15606": [ref("ns=0;i=15680")], "ns=0;i=15680": [], "ns=0;i=16036": [] },
      {},
      { "i=15606": [ref("ns=0;i=16036")] },
    );
    const set = await withheldNodes(fake.client);
    expect(set.get("i=16036")?.nodeId).toBe("i=15606");
    expect(fake.continued).toEqual([1]);
  });

  test("a continuation the server refuses or leaves unanswered refuses the read", async () => {
    const refused = server({ "i=15606": [] }, { "i=15606#next": "BadContinuationPointInvalid" }, { "i=15606": [] });
    await expect(withheldNodes(refused.client)).rejects.toThrow("BadContinuationPointInvalid");
    const empty = server({ "i=15606": [] }, {}, { "i=15606": [] });
    empty.client.browseNext = async () => [];
    await expect(withheldNodes(empty.client)).rejects.toThrow("the server answered nothing");
  });

  test("past its node bound, the walk refuses rather than answers unchecked", async () => {
    const wide = Array.from({ length: OPCUA_WITHHELD_WALK_MAX_NODES + 1 }, (_, at) => ref(`ns=5;i=${at}`, "Method"));
    await expect(withheldNodes(server({ "i=12637": wide }).client)).rejects.toThrow(
      `more than the ${OPCUA_WITHHELD_WALK_MAX_NODES.toLocaleString("en-US")} nodes`,
    );
    // Exactly the bound is read.
    const exact = wide.slice(0, OPCUA_WITHHELD_WALK_MAX_NODES);
    expect((await withheldNodes(server({ "i=12637": exact }).client)).size).toBe(
      OPCUA_WITHHELD_WALK_MAX_NODES + OPCUA_WITHHELD_NODES.length,
    );
  });

  test("past its depth bound, the walk refuses rather than answers unchecked", async () => {
    const tree: Record<string, OpcuaReference[]> = {};
    let parent = "i=12637";
    for (let depth = 0; depth < OPCUA_WITHHELD_WALK_MAX_DEPTH; depth += 1) {
      const nodeId = `ns=5;i=${depth}`;
      tree[parent] = [ref(nodeId)];
      parent = nodeId;
    }
    tree[parent] = [];
    await expect(withheldNodes(server(tree).client)).rejects.toThrow(
      `deeper than the ${OPCUA_WITHHELD_WALK_MAX_DEPTH} levels`,
    );
  });

  test("a node reached under two roots keeps the first, and the walk visits it once", async () => {
    const fake = server({ "i=12637": [ref("ns=5;i=1")], "i=15606": [ref("ns=5;i=1")], "ns=5;i=1": [] });
    const set = await withheldNodes(fake.client);
    expect(set.get("ns=5;i=1")?.nodeId).toBe("i=12637");
    expect(fake.browsed.flat().filter((id) => id === "ns=5;i=1")).toHaveLength(1);
  });

  test("the walk chunks by the size it is given", async () => {
    const fake = server({});
    await withheldNodes(fake.client, 3);
    expect(fake.browsed.map((batch) => batch.length)).toEqual([3, 3, 1]);
  });
});
