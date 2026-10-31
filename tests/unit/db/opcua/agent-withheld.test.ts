/**
 * The withheld parts of an OPC UA server: the standard roots by node id, every spelling of one id compared as one, and
 * the walk under the roots read through Browse alone before every agent read, refused rather than guessed where the
 * server will not say.
 */
import { describe, expect, test } from "bun:test";
import {
  canonicalNodeId,
  deniedAncestry,
  namesNamespaceUri,
  OPCUA_AGENT_NAMESPACE0,
  OPCUA_NAMESPACE0_OUTSIDE,
  OPCUA_WITHHELD_NODES,
  OPCUA_WITHHELD_SENTENCE,
  OPCUA_WITHHELD_WALK_MAX_DEPTH,
  OPCUA_WITHHELD_WALK_MAX_NODES,
  type OpcuaWithheldSet,
  OpcuaWithheldWalkError,
  refusalOf,
  standingRefusal,
  withheldNodes,
  withheldReason,
  withheldRootOf,
} from "@/lib/db/providers/industrial/opcua/agent-withheld";
import type {
  OpcuaBrowseDirection,
  OpcuaBrowseResult,
  OpcuaNodeId,
  OpcuaReference,
} from "@/lib/db/providers/industrial/opcua/client";

/** The key of an id as the provider keys it, with no namespace table: an id with none throws. */
const keyOf = async (nodeId: OpcuaNodeId): Promise<OpcuaNodeId> => {
  const key = canonicalNodeId(nodeId);
  if (key === undefined) throw new Error(`no key for ${nodeId}`);
  return key;
};

const ref = (nodeId: string, nodeClass = "Object"): OpcuaReference => ({
  nodeId,
  browseName: nodeId,
  displayName: nodeId,
  nodeClass,
  referenceTypeId: "ns=0;i=47",
  mayHaveChildren: nodeClass !== "Method",
});

/**
 * A server whose tree a test states; a node it does not hold answers BadNodeIdUnknown, as OPC PLC does. An inverse
 * browse answers the nodes whose children name the node browsed, or `parents` where a test states them.
 */
function server(
  tree: Readonly<Record<string, readonly OpcuaReference[]>>,
  over: Partial<Record<string, string>> = {},
  pages: Readonly<Record<string, readonly OpcuaReference[]>> = {},
  parents: Readonly<Record<string, readonly OpcuaReference[]>> = {},
) {
  const browsed: OpcuaNodeId[][] = [];
  const inverse: OpcuaNodeId[][] = [];
  const continued: number[] = [];
  const parentsOf = (nodeId: OpcuaNodeId): readonly OpcuaReference[] =>
    parents[nodeId] ??
    Object.entries(tree)
      .filter(([, children]) => children.some((child) => canonicalNodeId(child.nodeId) === nodeId))
      .map(([parent]) => ref(parent));
  return {
    browsed,
    inverse,
    continued,
    client: {
      browse: async (
        ids: readonly OpcuaNodeId[],
        direction?: OpcuaBrowseDirection,
      ): Promise<readonly OpcuaBrowseResult[]> => {
        if (direction === "inverse") {
          inverse.push([...ids]);
          return ids.map((nodeId) => ({
            nodeId,
            references: parentsOf(nodeId),
            statusCode: over[`${nodeId}#up`] ?? "Good",
          }));
        }
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

  test("each carries its reason, and the shared sentence names every one and the namespace-0 list", () => {
    for (const entry of OPCUA_WITHHELD_NODES) {
      expect(withheldReason(entry)).toStartWith(`${entry.kind} (${entry.nodeId}) is withheld from agent mode`);
      expect(OPCUA_WITHHELD_SENTENCE).toContain(`${entry.kind} (${entry.nodeId})`);
    }
    expect(OPCUA_WITHHELD_SENTENCE).toContain("every other namespace-0 node is refused with its reason");
    expect(withheldReason(OPCUA_NAMESPACE0_OUTSIDE)).toStartWith(
      "A namespace-0 node outside agent mode's list is not read: namespace 0 holds standard nodes agent mode does not read",
    );
  });

  test("every spelling of a root is the root, and nothing else is", () => {
    for (const spelling of ["i=12637", "ns=0;i=12637", "nsu=http://opcfoundation.org/UA/;i=12637"])
      expect(withheldRootOf(spelling)?.nodeId).toBe("i=12637");
    expect(withheldRootOf("ns=1;i=12637")).toBeUndefined();
    expect(withheldRootOf("i=126370")).toBeUndefined();
    expect(withheldRootOf("s=i=12637")).toBeUndefined();
  });
});

describe("namespace 0 is read from a list", () => {
  test("the list is the folders, the Server object and its state and limits, and holds no withheld root", () => {
    const ids = OPCUA_AGENT_NAMESPACE0.map((entry) => entry.nodeId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const root of OPCUA_WITHHELD_NODES) expect(ids).not.toContain(root.nodeId);
    for (const entry of OPCUA_AGENT_NAMESPACE0)
      expect(["Root", "Objects", "Server"]).toContain(entry.path.split(".")[0]);
    // Under Server: no session, subscription or sampling diagnostics, redundancy, vendor or namespace metadata.
    for (const id of ["i=2289", "i=2290", "i=2295", "i=2296", "i=11715", "i=12885", "i=17634"])
      expect(ids).not.toContain(id);
    expect(ids).toEqual(expect.arrayContaining(["i=84", "i=85", "i=2253", "i=2255", "i=2256", "i=2258", "i=2275"]));
  });

  test("a standard node beneath a withheld root is refused by id, though no walk can see it", () => {
    // TrustList of the default application group, CertificateGroups, the Anonymous role and its Identities, and the
    // UserManagementType's Users: fixed ids in namespace 0 a server may answer a Read of while refusing their browse.
    for (const id of ["i=12642", "ns=0;i=12642", "i=14053", "i=14156", "i=15644", "i=16192", "i=15668"])
      expect(standingRefusal(canonicalNodeId(id) as string)).toBe(OPCUA_NAMESPACE0_OUTSIDE);
  });

  test("every other namespace-0 node is refused, a listed one and any other namespace are not", () => {
    for (const id of ["i=2290", "i=11715", "i=23470", "i=11492", "i=86", "i=58"])
      expect(standingRefusal(id)).toBe(OPCUA_NAMESPACE0_OUTSIDE);
    for (const id of ["i=85", "i=2253", "i=2256", "i=11705", "ns=3;s=SlowUInt1", "ns=7;i=12642"])
      expect(standingRefusal(id)).toBeUndefined();
    expect(standingRefusal("i=12637")?.nodeId).toBe("i=12637");
    // A key still naming its URI is the session's to decide.
    expect(standingRefusal("nsu=urn:plant;i=12642")).toBeUndefined();
  });

  test("refusalOf takes the walk's set first and the standing refusals after", () => {
    const set: OpcuaWithheldSet = { nodes: new Map([["ns=7;i=1", OPCUA_WITHHELD_NODES[2]]]), denied: [] };
    expect(refusalOf(set, "ns=7;i=1")).toBe(OPCUA_WITHHELD_NODES[2]);
    expect(refusalOf(set, "i=16192")).toBe(OPCUA_NAMESPACE0_OUTSIDE);
    expect(refusalOf(set, "ns=7;i=2")).toBeUndefined();
  });
});

describe("canonicalNodeId", () => {
  test("namespace 0 is one node however it is written", () => {
    expect(canonicalNodeId("ns=0;i=2253")).toBe("i=2253");
    expect(canonicalNodeId("nsu=http://opcfoundation.org/UA/;s=x")).toBe("s=x");
    expect(canonicalNodeId("ns=3;s=SlowUInt1")).toBe("ns=3;s=SlowUInt1");
  });

  test("a numeric identifier and a namespace index are numbers, within their ranges", () => {
    expect(canonicalNodeId("ns=03;i=0042")).toBe("ns=3;i=42");
    expect(canonicalNodeId("i=4294967295")).toBe("i=4294967295");
    expect(canonicalNodeId("i=4294967296")).toBeUndefined();
    expect(canonicalNodeId("ns=65536;i=1")).toBeUndefined();
    expect(canonicalNodeId("i=-1")).toBeUndefined();
    expect(canonicalNodeId("i=")).toBeUndefined();
    expect(canonicalNodeId("s=")).toBeUndefined();
    expect(canonicalNodeId("x=1")).toBeUndefined();
  });

  test("a GUID is compared in lower case, and a String identifier keeps its own semicolons and case", () => {
    expect(canonicalNodeId("ns=2;g=ABCDEF01-2345-6789-ABCD-EF0123456789")).toBe(
      "ns=2;g=abcdef01-2345-6789-abcd-ef0123456789",
    );
    expect(canonicalNodeId("ns=2;g=not-a-guid")).toBeUndefined();
    expect(canonicalNodeId("ns=3;s=a;g=AB")).toBe("ns=3;s=a;g=AB");
    expect(canonicalNodeId("s=A;B")).toBe("s=A;B");
  });

  test("an opaque identifier is its bytes: unpadded, padded and stray trailing bits are one node", () => {
    for (const spelling of ["ns=2;b=AQ==", "ns=2;b=AQ", "ns=2;b=AR==", "ns=2;b=AR"])
      expect(canonicalNodeId(spelling)).toBe("ns=2;b=AQ==");
    expect(canonicalNodeId("ns=2;b=A=Q=")).toBeUndefined();
    expect(canonicalNodeId("ns=2;b=A")).toBeUndefined();
  });

  test("a namespace URI is namespace 0's, an index in the server's table, or left for the session to decide", () => {
    expect(canonicalNodeId("nsu=urn:plant;s=Pump")).toBe("nsu=urn:plant;s=Pump");
    expect(namesNamespaceUri("nsu=urn:plant;s=Pump")).toBe(true);
    expect(namesNamespaceUri("ns=3;s=Pump")).toBe(false);
    const table = ["http://opcfoundation.org/UA/", "urn:host", "urn:plant"];
    expect(canonicalNodeId("nsu=urn:plant;s=Pump", table)).toBe("ns=2;s=Pump");
    expect(canonicalNodeId("nsu=urn:plant;b=AR", table)).toBe("ns=2;b=AQ==");
    expect(canonicalNodeId("nsu=urn:elsewhere;s=Pump", table)).toBeUndefined();
    expect(canonicalNodeId("nsu=http://opcfoundation.org/UA/;i=1", [])).toBe("i=1");
  });

  test("namespace 0's URI with an index after it, or a node on another server, has no key", () => {
    expect(canonicalNodeId("nsu=http://opcfoundation.org/UA/;ns=0;i=1")).toBeUndefined();
    expect(canonicalNodeId("nsu=urn:plant;ns=2;i=1")).toBeUndefined();
    // How the library spells an expanded node id with a URI and a server index.
    expect(canonicalNodeId("ns=0;i=5;namespaceUri:urn:x;serverIndex:2")).toBeUndefined();
  });
});

describe("withheldNodes", () => {
  test("walks every root through Browse, and withholds what the server answers beneath them", async () => {
    const fake = server({
      "i=12637": [ref("ns=0;i=14053"), ref("ns=0;i=25709", "Method")],
      "i=14053": [ref("ns=0;i=14156")],
      "i=14156": [],
      "i=3706": [ref("ns=7;i=1324504778")],
      "ns=7;i=1324504778": [ref("ns=7;i=1324504823", "Variable")],
      "ns=7;i=1324504823": [],
      "i=15606": [],
    });
    const set = await withheldNodes(fake.client, keyOf);
    expect(set.nodes.get("i=14156")?.nodeId).toBe("i=12637");
    expect(set.nodes.get("ns=7;i=1324504823")?.nodeId).toBe("i=3706");
    expect(set.denied).toEqual([]);
    // A method is a member and is never browsed.
    expect(set.nodes.get("i=25709")?.nodeId).toBe("i=12637");
    expect(fake.browsed.flat()).not.toContain("i=25709");
    // The roots are asked first, together, in one chunk, and every node after by its key.
    expect(fake.browsed[0]).toEqual(OPCUA_WITHHELD_NODES.map((entry) => entry.nodeId));
    expect(fake.browsed[1]).toEqual(["i=14053", "ns=7;i=1324504778"]);
  });

  test("a node beneath a root is withheld in every spelling of it", async () => {
    const fake = server({ "i=3706": [ref("ns=7;b=AR")], "ns=7;b=AQ==": [] });
    const set = await withheldNodes(fake.client, keyOf);
    for (const spelling of ["ns=7;b=AQ==", "ns=7;b=AQ", "ns=7;b=AR==", "ns=07;b=AR"])
      expect(refusalOf(set, canonicalNodeId(spelling) as string)?.nodeId).toBe("i=3706");
  });

  test("a root the server does not hold has nothing beneath it", async () => {
    const set = await withheldNodes(server({}).client, keyOf);
    expect([...set.nodes.keys()]).toEqual(OPCUA_WITHHELD_NODES.map((entry) => entry.nodeId));
    expect(set.denied).toEqual([]);
  });

  test("a node the server will not browse for this identity stays withheld, and the walk is marked unfinished", async () => {
    const fake = server(
      { "i=12637": [ref("ns=0;i=14053")], "i=14053": [] },
      { "i=3707": "BadUserAccessDenied", "i=14053": "BadUserAccessDenied" },
    );
    const set = await withheldNodes(fake.client, keyOf);
    expect(set.nodes.get("i=3707")?.nodeId).toBe("i=3707");
    expect(set.nodes.get("i=14053")?.nodeId).toBe("i=12637");
    expect(set.denied).toEqual(["i=3707", "i=14053"]);
  });

  test("any other refusal of a root, or of a node beneath one, refuses the read", async () => {
    await expect(withheldNodes(server({}, { "i=15606": "BadTooManyOperations" }).client, keyOf)).rejects.toThrow(
      "the server answered BadTooManyOperations to a browse of them",
    );
    const below = server({ "i=12637": [ref("ns=0;i=14053")] }, { "i=14053": "BadNodeIdUnknown" });
    await expect(withheldNodes(below.client, keyOf)).rejects.toBeInstanceOf(OpcuaWithheldWalkError);
  });

  test("an answer missing from the browse refuses the read", async () => {
    const client = { browse: async () => [], browseNext: async () => [] };
    await expect(withheldNodes(client, keyOf)).rejects.toThrow("the server answered nothing");
  });

  test("a reference with no key refuses the read", async () => {
    const fake = server({ "i=3706": [ref("ns=0;i=5;namespaceUri:urn:x;serverIndex:2")] });
    await expect(withheldNodes(fake.client, keyOf)).rejects.toThrow("no key for");
  });

  test("continuation points are followed to the end of a level", async () => {
    const fake = server(
      { "i=15606": [ref("ns=0;i=15680")], "i=15680": [], "i=16036": [] },
      {},
      { "i=15606": [ref("ns=0;i=16036")] },
    );
    const set = await withheldNodes(fake.client, keyOf);
    expect(set.nodes.get("i=16036")?.nodeId).toBe("i=15606");
    expect(fake.continued).toEqual([1]);
  });

  test("a continuation the server refuses or leaves unanswered refuses the read", async () => {
    const refused = server({ "i=15606": [] }, { "i=15606#next": "BadContinuationPointInvalid" }, { "i=15606": [] });
    await expect(withheldNodes(refused.client, keyOf)).rejects.toThrow("BadContinuationPointInvalid");
    const empty = server({ "i=15606": [] }, {}, { "i=15606": [] });
    empty.client.browseNext = async () => [];
    await expect(withheldNodes(empty.client, keyOf)).rejects.toThrow("the server answered nothing");
  });

  test("past its node bound, the walk refuses rather than answers unchecked", async () => {
    const wide = Array.from({ length: OPCUA_WITHHELD_WALK_MAX_NODES + 1 }, (_, at) => ref(`ns=5;i=${at}`, "Method"));
    await expect(withheldNodes(server({ "i=12637": wide }).client, keyOf)).rejects.toThrow(
      `more than the ${OPCUA_WITHHELD_WALK_MAX_NODES.toLocaleString("en-US")} nodes`,
    );
    // Exactly the bound is read.
    const exact = wide.slice(0, OPCUA_WITHHELD_WALK_MAX_NODES);
    expect((await withheldNodes(server({ "i=12637": exact }).client, keyOf)).nodes.size).toBe(
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
    await expect(withheldNodes(server(tree).client, keyOf)).rejects.toThrow(
      `deeper than the ${OPCUA_WITHHELD_WALK_MAX_DEPTH} levels`,
    );
  });

  test("a node reached under two roots keeps the first, and the walk visits it once", async () => {
    const fake = server({ "i=12637": [ref("ns=5;i=1")], "i=15606": [ref("ns=5;i=1")], "ns=5;i=1": [] });
    const set = await withheldNodes(fake.client, keyOf);
    expect(set.nodes.get("ns=5;i=1")?.nodeId).toBe("i=12637");
    expect(fake.browsed.flat().filter((id) => id === "ns=5;i=1")).toHaveLength(1);
  });

  test("the walk chunks by the size it is given", async () => {
    const fake = server({});
    await withheldNodes(fake.client, keyOf, 3);
    expect(fake.browsed.map((batch) => batch.length)).toEqual([3, 3, 1]);
  });
});

describe("deniedAncestry", () => {
  /** A server that refuses this identity a browse of the session diagnostics array, as OPC PLC 2.15.10 does. */
  const denied = (
    tree: Record<string, OpcuaReference[]>,
    over: Partial<Record<string, string>> = {},
    parents: Readonly<Record<string, readonly OpcuaReference[]>> = {},
  ) => server(tree, { "i=3707": "BadUserAccessDenied", ...over }, {}, parents);

  test("a finished walk sends nothing more", async () => {
    const fake = server({});
    const set = await withheldNodes(fake.client, keyOf);
    expect((await deniedAncestry(fake.client, ["ns=3;s=A"], set, keyOf)).size).toBe(0);
    expect(fake.inverse).toEqual([]);
  });

  test("a node the walk could not see is withheld by its parent, though the server would answer its Read", async () => {
    // The per-session element under the array the server would not browse: its own parent names it.
    const fake = denied(
      { "i=85": [ref("ns=3;s=Plant")], "ns=3;s=Plant": [ref("ns=3;s=A")] },
      {},
      {
        "ns=7;i=99": [ref("ns=0;i=3707")],
      },
    );
    const set = await withheldNodes(fake.client, keyOf);
    const found = await deniedAncestry(fake.client, ["ns=7;i=99", "ns=3;s=A"], set, keyOf);
    expect(found.get("ns=7;i=99")?.nodeId).toBe("i=3707");
    expect(found.has("ns=3;s=A")).toBe(false);
    // Level by level: the two keys, then A's parent; the session node's line ended at i=3707, A's at i=85.
    expect(fake.inverse).toEqual([["ns=7;i=99", "ns=3;s=A"], ["ns=3;s=Plant"]]);
  });

  test("a node two levels beneath a withheld node the walk saw is withheld too", async () => {
    const fake = denied({}, {}, { "ns=7;i=2": [ref("ns=7;i=1")], "ns=7;i=1": [ref("i=3708")] });
    const set = await withheldNodes(fake.client, keyOf);
    expect((await deniedAncestry(fake.client, ["ns=7;i=2"], set, keyOf)).get("ns=7;i=2")?.nodeId).toBe("i=3708");
  });

  test("namespace-0 keys, refused keys and nodes `clean` names are not climbed", async () => {
    const fake = denied({}, {}, { "ns=3;s=Child": [ref("ns=3;s=Parent")] });
    const set = await withheldNodes(fake.client, keyOf);
    expect((await deniedAncestry(fake.client, ["i=2256", "i=3707"], set, keyOf)).size).toBe(0);
    expect(fake.inverse).toEqual([]);
    const found = await deniedAncestry(fake.client, ["ns=3;s=Child"], set, keyOf, 10, new Set(["ns=3;s=Parent"]));
    expect(found.size).toBe(0);
    expect(fake.inverse).toEqual([["ns=3;s=Child"]]);
  });

  test("parents the server will not answer, or none at all, refuse the read", async () => {
    const refused = denied({}, { "ns=3;s=A#up": "BadUserAccessDenied" });
    const set = await withheldNodes(refused.client, keyOf);
    await expect(deniedAncestry(refused.client, ["ns=3;s=A"], set, keyOf)).rejects.toThrow(
      "it answered BadUserAccessDenied for a node's parents",
    );
    const orphan = denied({});
    await expect(
      deniedAncestry(orphan.client, ["ns=3;s=A"], await withheldNodes(orphan.client, keyOf), keyOf),
    ).rejects.toThrow("a node answered no parent");
    const silent = denied({});
    const silentSet = await withheldNodes(silent.client, keyOf);
    const browse = silent.client.browse;
    silent.client.browse = async (ids, direction) => (direction === "inverse" ? [] : browse(ids, direction));
    await expect(deniedAncestry(silent.client, ["ns=3;s=A"], silentSet, keyOf)).rejects.toThrow(
      "it answered nothing for a node's parents",
    );
  });

  test("a line deeper than the walk reads refuses the read, and exactly the depth is read", async () => {
    const chain = (length: number): Record<string, OpcuaReference[]> => {
      const parents: Record<string, OpcuaReference[]> = {};
      for (let at = 0; at < length; at += 1)
        parents[`ns=5;i=${at}`] = [ref(at + 1 < length ? `ns=5;i=${at + 1}` : "i=85")];
      return parents;
    };
    const exact = denied({}, {}, chain(OPCUA_WITHHELD_WALK_MAX_DEPTH));
    const set = await withheldNodes(exact.client, keyOf);
    expect((await deniedAncestry(exact.client, ["ns=5;i=0"], set, keyOf)).size).toBe(0);
    const deep = denied({}, {}, chain(OPCUA_WITHHELD_WALK_MAX_DEPTH + 1));
    await expect(
      deniedAncestry(deep.client, ["ns=5;i=0"], await withheldNodes(deep.client, keyOf), keyOf),
    ).rejects.toThrow(`deeper than the ${OPCUA_WITHHELD_WALK_MAX_DEPTH} levels`);
  });

  test("a parent with no key refuses the read", async () => {
    const fake = denied({}, {}, { "ns=3;s=A": [ref("ns=0;i=5;namespaceUri:urn:x;serverIndex:2")] });
    const set = await withheldNodes(fake.client, keyOf);
    await expect(deniedAncestry(fake.client, ["ns=3;s=A"], set, keyOf)).rejects.toThrow("no key for");
  });

  test("a parent's continued page is read before the line is decided", async () => {
    const fake = denied({}, {}, { "ns=3;s=A": [ref("i=85")] });
    const set = await withheldNodes(fake.client, keyOf);
    const browse = fake.client.browse;
    fake.client.browse = async (ids, direction) =>
      direction === "inverse"
        ? ids.map((nodeId) => ({
            nodeId,
            references: [ref("i=85")],
            statusCode: "Good",
            continuationPoint: new TextEncoder().encode("ns=3;s=Hidden"),
          }))
        : browse(ids, direction);
    fake.client.browseNext = async () => [{ nodeId: "", references: [ref("i=3707")], statusCode: "Good" }];
    expect((await deniedAncestry(fake.client, ["ns=3;s=A"], set, keyOf)).get("ns=3;s=A")?.nodeId).toBe("i=3707");
  });

  test("a parent's continued page the server refuses refuses the read", async () => {
    const fake = denied({}, {}, { "ns=3;s=A": [ref("i=85")] });
    const set = await withheldNodes(fake.client, keyOf);
    const browse = fake.client.browse;
    fake.client.browse = async (ids, direction) =>
      direction === "inverse"
        ? ids.map((nodeId) => ({
            nodeId,
            references: [ref("i=85")],
            statusCode: "Good",
            continuationPoint: new TextEncoder().encode("ns=3;s=Hidden"),
          }))
        : browse(ids, direction);
    fake.client.browseNext = async () => [{ nodeId: "", references: [], statusCode: "BadContinuationPointInvalid" }];
    await expect(deniedAncestry(fake.client, ["ns=3;s=A"], set, keyOf)).rejects.toThrow(
      "it answered BadContinuationPointInvalid for a node's parents",
    );
  });
});
