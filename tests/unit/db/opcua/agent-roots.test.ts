/**
 * The read roots of an OPC UA seed connection: the grammar a root list is held to before any socket, the fixed
 * namespace-0 table a root may name, and the standard identity properties, each pinned against the published nodesets.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  answerTimeOutside,
  keyIn,
  OPCUA_IDENTITY_PROPERTIES,
  OPCUA_NAMESPACE0_ROOTS,
  OPCUA_READ_ROOT_MAX_LENGTH,
  OPCUA_READ_ROOTS_MAX,
  OPCUA_READ_SET_MAX_DEPTH,
  OPCUA_READ_SET_MAX_NODES,
  OPCUA_READ_SET_MAX_REQUESTS,
  OPCUA_READ_ROOTS_SENTENCES,
  OpcuaReadRootsError,
  outwardNote,
  proveReadSet,
  readRootRefusals,
  readRootSentence,
} from "@/lib/db/providers/industrial/opcua/agent-roots";
import type { OpcuaBrowseResult, OpcuaDataValue, OpcuaReference } from "@/lib/db/providers/industrial/opcua/client";

const NODESETS = join(process.cwd(), "node_modules", "node-opcua-nodesets", "nodesets");

/** One node of a nodeset file by id: its element, BrowseName, and the forward references it declares. */
interface NodesetNode {
  readonly element: string;
  readonly browseName: string;
  readonly children: readonly { readonly referenceType: string; readonly target: string }[];
}

const NODE_ELEMENTS: ReadonlySet<string> = new Set([
  "UAObject",
  "UAVariable",
  "UAMethod",
  "UAObjectType",
  "UAVariableType",
  "UADataType",
  "UAReferenceType",
  "UAView",
]);

/** The nodes of one nodeset file, read by slicing its text rather than by pattern over it. */
function nodeset(file: string): ReadonlyMap<string, NodesetNode> {
  const text = readFileSync(join(NODESETS, file), "utf8");
  const nodes = new Map<string, NodesetNode>();
  let at = 0;
  for (;;) {
    const open = text.indexOf("<UA", at);
    if (open < 0) break;
    const nameEnd = text.indexOf(" ", open);
    const element = text.slice(open + 1, nameEnd);
    if (!NODE_ELEMENTS.has(element)) {
      at = nameEnd;
      continue;
    }
    const openEnd = text.indexOf(">", open);
    const end = text[openEnd - 1] === "/" ? openEnd : text.indexOf(`</${element}>`, open);
    const body = text.slice(open, end);
    at = end + 1;
    const nodeId = attribute(body, "NodeId");
    const browseName = attribute(body, "BrowseName");
    if (nodeId === undefined || browseName === undefined) continue;
    const children: { referenceType: string; target: string }[] = [];
    let ref = body.indexOf("<Reference ");
    while (ref >= 0) {
      const tagEnd = body.indexOf(">", ref);
      const tag = body.slice(ref, tagEnd);
      const targetEnd = body.indexOf("</Reference>", tagEnd);
      const target = body.slice(tagEnd + 1, targetEnd);
      const referenceType = attribute(tag, "ReferenceType") ?? "";
      if (attribute(tag, "IsForward") !== "false") children.push({ referenceType, target });
      ref = body.indexOf("<Reference ", targetEnd);
    }
    nodes.set(nodeId, { element, browseName, children });
  }
  return nodes;
}

function attribute(tag: string, name: string): string | undefined {
  const start = tag.indexOf(` ${name}="`);
  if (start < 0) return undefined;
  const from = start + name.length + 3;
  return tag.slice(from, tag.indexOf('"', from));
}

const UA = nodeset("Opc.Ua.NodeSet2.xml");

describe("readRootRefusals", () => {
  test("a list of node ids in the console's form, the namespace written by URI, is accepted", () => {
    expect(readRootRefusals(["nsu=http://microsoft.com/Opc/OpcPlc/;s=Telemetry", "i=2256"])).toEqual([]);
    expect(readRootRefusals(["nsu=urn:plant;i=7", "nsu=urn:plant;g=09087e75-8e5e-499b-954f-f2a9603db28a"])).toEqual([]);
    expect(readRootRefusals(["nsu=urn:plant;b=AQ=="])).toEqual([]);
  });

  test("anything but a list of strings is one fragment with no index", () => {
    for (const value of ["i=2256", 7, null, { root: "i=2256" }, ["i=2256", 3]])
      expect(readRootRefusals(value)).toEqual([
        { reason: 'is a list of node ids, such as ["nsu=urn:plant;s=Line1"].' },
      ]);
  });

  test("an empty list, and a list past the bound, are refused whole", () => {
    expect(readRootRefusals([])).toEqual([
      {
        reason: "is empty: list at least one node id agent mode and MCP may read beneath, or remove agentReadRoots.",
      },
    ]);
    const many = Array.from({ length: OPCUA_READ_ROOTS_MAX + 1 }, (_, i) => `nsu=urn:plant;i=${i}`);
    expect(readRootRefusals(many)).toEqual([
      {
        reason: `holds ${OPCUA_READ_ROOTS_MAX + 1} roots, and a connection takes at most ${OPCUA_READ_ROOTS_MAX}: declare the folders that hold the process data rather than each node.`,
      },
    ]);
    expect(readRootRefusals(many.slice(0, OPCUA_READ_ROOTS_MAX))).toEqual([]);
    expect(OPCUA_READ_ROOTS_MAX).toBe(32);
  });

  test("each element is held to the grammar, by its index", () => {
    const long = `nsu=urn:plant;s=${"x".repeat(OPCUA_READ_ROOT_MAX_LENGTH)}`;
    expect(OPCUA_READ_ROOT_MAX_LENGTH).toBe(512);
    expect(readRootRefusals(["i=2256", long])).toEqual([{ index: 1, reason: "is longer than 512 characters." }]);
    expect(readRootRefusals(["${PLANT_ROOT}"])).toEqual([
      {
        index: 0,
        reason:
          "is a reference: read roots are written in the seed file as they are, since they are neither a credential nor an address.",
      },
    ]);
    expect(readRootRefusals(["${vault:secret/plant#root}"])[0]?.reason).toStartWith("is a reference");
    expect(readRootRefusals(["Telemetry"])).toEqual([
      {
        index: 0,
        reason: "is not a node id: write nsu=<namespace URI>;s=<name>, or i=, g= or b= for the identifier.",
      },
    ]);
    expect(readRootRefusals(["nsu=urn:plant;b=***"])[0]?.reason).toStartWith("is not a node id");
    expect(readRootRefusals(["nsu=urn:plant;b=A"])).toEqual([
      { index: 0, reason: "has an identifier that does not decode, so Studio cannot tell which node it names." },
    ]);
  });

  test("a namespace written by index is refused, alone or after a URI", () => {
    for (const root of ["ns=3;s=Telemetry", "nsu=urn:plant;ns=3;s=Telemetry"])
      expect(readRootRefusals([root])).toEqual([
        {
          index: 0,
          reason:
            "names its namespace by index, which a server restart can move to another namespace: write it with the namespace URI, nsu=<uri>;..., as the server's NamespaceArray lists it.",
        },
      ]);
  });

  test("the OPC Foundation diagnostics namespace is never a root", () => {
    expect(readRootRefusals(["nsu=http://opcfoundation.org/UA/Diagnostics;i=1"])).toEqual([
      {
        index: 0,
        reason:
          "is in the OPC Foundation diagnostics namespace, which servers built on the OPC Foundation .NET stack use for their session and subscription diagnostics, and is never a read root.",
      },
    ]);
  });

  test("namespace 0 is a root only from the fixed table, in all three spellings", () => {
    for (const root of ["i=2256", "ns=0;i=2256", "nsu=http://opcfoundation.org/UA/;i=2256"])
      expect(readRootRefusals([root])).toEqual([]);
    for (const { nodeId } of OPCUA_NAMESPACE0_ROOTS) expect(readRootRefusals([nodeId])).toEqual([]);
    for (const root of ["i=85", "i=84", "i=2253", "i=2268", "i=12637", "ns=0;i=15606", "i=2257"]) {
      const [fragment] = readRootRefusals([root]);
      expect(fragment?.index).toBe(0);
      expect(fragment?.reason).toStartWith(
        "names a namespace-0 node that is not offered as a read root: namespace 0 holds the server's configuration, roles and sessions, so only ",
      );
      for (const { path, nodeId } of OPCUA_NAMESPACE0_ROOTS) expect(fragment?.reason).toContain(`${path} (${nodeId})`);
    }
  });

  test("two elements that name one node are refused at the second, naming the first", () => {
    expect(readRootRefusals(["i=2256", "nsu=http://opcfoundation.org/UA/;i=2256"])).toEqual([
      { index: 1, reason: "names the same node as agentReadRoots[0]." },
    ]);
    expect(
      readRootRefusals([
        "nsu=urn:plant;g=09087E75-8E5E-499B-954F-F2A9603DB28A",
        "nsu=urn:plant;s=A",
        "nsu=urn:plant;g=09087e75-8e5e-499b-954f-f2a9603db28a",
      ]),
    ).toEqual([{ index: 2, reason: "names the same node as agentReadRoots[0]." }]);
    expect(readRootRefusals(["nsu=urn:a;s=X", "nsu=urn:b;s=X"])).toEqual([]);
  });

  test("every element is checked, so one refusal does not hide the next", () => {
    expect(readRootRefusals(["Telemetry", "ns=2;s=A", "i=2256"]).map((f) => f.index)).toEqual([0, 1]);
  });
});

describe("the namespace-0 roots table", () => {
  test("names the seven roots and no folder that would be everything", () => {
    expect(OPCUA_NAMESPACE0_ROOTS.map((root) => root.nodeId)).toEqual([
      "i=2256",
      "i=11704",
      "i=2275",
      "i=2255",
      "i=2254",
      "i=2267",
      "i=2994",
    ]);
  });

  test("every row's BrowseName, NodeClass and reference type match the published nodeset", () => {
    for (const root of OPCUA_NAMESPACE0_ROOTS) {
      const declared = UA.get(root.nodeId);
      expect(declared?.browseName).toBe(root.browseName);
      expect(declared?.element).toBe(`UA${root.nodeClass}`);
      for (const row of root.rows) {
        const node = UA.get(row.nodeId);
        expect(node?.browseName).toBe(row.browseName);
        expect(row.displayName).toBe(row.browseName);
        expect(node?.element).toBe(`UA${row.nodeClass}`);
        const parent = UA.get(row.parent);
        const held = parent?.children.find((c) => c.target === row.nodeId);
        expect(held?.referenceType).toBe(row.referenceTypeId === "i=47" ? "HasComponent" : "HasProperty");
      }
    }
  });

  test("the members are the ids the table names beneath each root, and nothing else", () => {
    const members = (nodeId: string) =>
      OPCUA_NAMESPACE0_ROOTS.find((root) => root.nodeId === nodeId)?.rows.map((row) => row.nodeId);
    expect(members("i=2256")).toEqual([
      "i=2257",
      "i=2258",
      "i=2259",
      "i=2260",
      "i=2261",
      "i=2262",
      "i=2263",
      "i=2264",
      "i=2265",
      "i=2266",
      "i=2992",
      "i=2993",
    ]);
    expect(members("i=11704")).toHaveLength(12);
    expect(members("i=2275")).toHaveLength(12);
    for (const single of ["i=2255", "i=2254", "i=2267", "i=2994"]) expect(members(single)).toEqual([]);
  });
});

describe("the standard identity properties", () => {
  test("ClientUserId is the property Part 9 gives every condition", () => {
    const clientUserId = OPCUA_IDENTITY_PROPERTIES.find((p) => p.name === "ClientUserId");
    expect(clientUserId?.namespaceUri).toBe("http://opcfoundation.org/UA/");
    expect(UA.get("i=9026")?.browseName).toBe("ClientUserId");
    expect(UA.get("i=2782")?.children.some((c) => c.target === "i=9026" && c.referenceType === "HasProperty")).toBe(
      true,
    );
  });

  test("Lock, LockingClient and LockingUser are the DI locking nodes", () => {
    const di = nodeset("Opc.Ua.Di.NodeSet2.xml");
    const names = OPCUA_IDENTITY_PROPERTIES.filter((p) => p.namespaceUri === "http://opcfoundation.org/UA/DI/").map(
      (p) => p.name,
    );
    expect(names).toEqual(["Lock", "LockingClient", "LockingUser"]);
    expect(di.get("ns=1;i=6161")?.browseName).toBe("1:Lock");
    expect(di.get("ns=1;i=6163")?.browseName).toBe("1:LockingClient");
    expect(di.get("ns=1;i=6164")?.browseName).toBe("1:LockingUser");
  });
});

/** A scripted server for the walk: nodes by key, each with its facts and its forward references, and a request log. */
interface FakeChild {
  readonly target: string;
  readonly ref?: string;
  readonly name?: string;
  readonly typeDefinition?: string;
}
interface FakeNode {
  readonly nodeClass?: string;
  readonly classStatus?: string;
  readonly dataType?: string;
  readonly dataTypeStatus?: string;
  readonly ns?: number;
  readonly name?: string;
  /** A status the server answers the BrowseName attribute with instead of the name. */
  readonly nameStatus?: string;
  readonly display?: string;
  readonly browseStatus?: string;
  readonly children?: readonly FakeChild[];
}

const PLANT = "urn:plant";
const TABLE = [
  "http://opcfoundation.org/UA/",
  "urn:local",
  PLANT,
  "http://opcfoundation.org/UA/Diagnostics",
  "http://opcfoundation.org/UA/DI/",
];

function fakeServer(
  nodes: Readonly<Record<string, FakeNode>>,
  options: { readonly page?: number; readonly nextStatus?: string; readonly endless?: boolean } = {},
) {
  const log: string[] = [];
  const pending = new Map<string, OpcuaReference[]>();
  let points = 0;
  const reference = (child: FakeChild): OpcuaReference => {
    const node = nodes[child.target];
    const name = child.name ?? node?.name ?? child.target;
    return {
      nodeId: child.target,
      browseName: name,
      displayName: node?.display ?? name,
      nodeClass: node?.nodeClass ?? "Object",
      referenceTypeId: child.ref ?? "ns=0;i=47",
      mayHaveChildren: true,
      ...(child.typeDefinition === undefined ? {} : { typeDefinition: child.typeDefinition }),
    };
  };
  const page = (references: OpcuaReference[]): Pick<OpcuaBrowseResult, "references" | "continuationPoint"> => {
    const size = options.page ?? Number.POSITIVE_INFINITY;
    if (references.length <= size) return { references };
    points += 1;
    const point = new Uint8Array([points]);
    pending.set(String(points), references.slice(size));
    return { references: references.slice(0, size), continuationPoint: point };
  };
  const client = {
    browse: async (ids: readonly string[]) => {
      log.push(`browse ${ids.join(",")}`);
      return ids.map((nodeId) => {
        const node = nodes[nodeId];
        if (node === undefined) return { nodeId, references: [], statusCode: "BadNodeIdUnknown" };
        if (node.browseStatus !== undefined) return { nodeId, references: [], statusCode: node.browseStatus };
        return { nodeId, statusCode: "Good", ...page((node.children ?? []).map(reference)) };
      });
    },
    browseNext: async (list: readonly Uint8Array[]) => {
      log.push("browseNext");
      if (options.endless === true) {
        points += 1;
        return [{ nodeId: "", references: [], statusCode: "Good", continuationPoint: new Uint8Array([points]) }];
      }
      const rest = pending.get(String(list[0]?.[0])) ?? [];
      if (options.nextStatus !== undefined) return [{ nodeId: "", references: [], statusCode: options.nextStatus }];
      return [{ nodeId: "", statusCode: "Good", ...page(rest) }];
    },
    releaseBrowseContinuationPoints: async (list: readonly Uint8Array[]) => {
      log.push(`release ${list.map((point) => point[0]).join(",")}`);
    },
    read: async (ids: readonly string[], list?: string) => {
      log.push(`read:${list} ${ids.join(",")}`);
      return ids.map((nodeId): OpcuaDataValue => {
        const node = nodes[nodeId];
        if (node === undefined)
          return { nodeId, value: null, statusCode: "BadNodeIdUnknown", dataTypeStatusCode: "BadNodeIdUnknown" };
        return {
          nodeId,
          value: null,
          ...(node.classStatus === undefined ? { nodeClass: node.nodeClass ?? "Object" } : {}),
          ...(node.dataType === undefined ? {} : { dataTypeId: node.dataType }),
          dataTypeStatusCode: node.dataTypeStatus ?? "Good",
          ...(node.nameStatus === undefined
            ? { browseName: { namespaceIndex: node.ns ?? 2, name: node.name ?? nodeId } }
            : {}),
          displayName: node.display ?? node.name ?? nodeId,
          statusCode: node.classStatus ?? "Good",
        };
      });
    },
  };
  return { client, log };
}

const CHUNKS = { browse: 20, read: 200 } as const;
const ROOT = `nsu=${PLANT};s=Line`;
const variable = (name: string, over: Partial<FakeNode> = {}): FakeNode => ({
  nodeClass: "Variable",
  dataType: "ns=0;i=11",
  name,
  ...over,
});
const prove = (nodes: Record<string, FakeNode>, roots: readonly string[] = [ROOT], options = {}) => {
  const server = fakeServer(nodes, options);
  return { server, set: proveReadSet(server.client, roots, TABLE, CHUNKS) };
};

describe("proveReadSet", () => {
  test("follows Organizes, HasComponent, HasOrderedComponent and HasProperty, and no other reference type", async () => {
    const { set } = prove({
      "ns=2;s=Line": {
        name: "Line",
        children: [
          { target: "ns=2;s=A", ref: "ns=0;i=35" },
          { target: "ns=2;s=B", ref: "ns=0;i=47" },
          { target: "ns=2;s=C", ref: "ns=0;i=49" },
          { target: "ns=2;s=D", ref: "ns=0;i=46" },
          { target: "ns=2;s=E", ref: "ns=0;i=36" },
          { target: "ns=2;s=F", ref: "ns=0;i=48" },
          { target: "ns=2;s=G", ref: "ns=0;i=45" },
          { target: "ns=2;s=H", ref: "ns=2;i=900" },
        ],
      },
      ...Object.fromEntries(["A", "B", "C", "D", "E", "F", "G", "H"].map((n) => [`ns=2;s=${n}`, variable(n)])),
    });
    const proved = await set;
    expect([...proved.members.keys()].sort()).toEqual(["ns=2;s=A", "ns=2;s=B", "ns=2;s=C", "ns=2;s=D", "ns=2;s=Line"]);
    expect(proved.outward.get("ns=2;s=Line")).toBe(4);
    expect(proved.kept.get("ns=2;s=Line")?.map((r) => r.referenceTypeId)).toEqual(["i=35", "i=47", "i=49", "i=46"]);
  });

  test("namespace 0, the diagnostics namespace, an index past the table and an unkeyable id are outside", async () => {
    const table = [...TABLE, PLANT.replace("plant", "other")];
    const local = await proveReadSet(
      fakeServer({
        "ns=2;s=Line": {
          name: "Line",
          children: [
            { target: "ns=0;i=2253" },
            { target: "ns=3;i=1" },
            { target: "ns=9;s=Far" },
            { target: "nsu=http://opcfoundation.org/UA/Diagnostics;i=7" },
            { target: "ns=2;b=A" },
            { target: "ns=1;s=Local" },
          ],
        },
        "ns=1;s=Local": variable("Local", { ns: 1 }),
      }).client,
      [ROOT],
      table,
      CHUNKS,
    );
    expect([...local.members.keys()]).toEqual(["ns=2;s=Line", "ns=1;s=Local"]);
    expect(local.outward.get("ns=2;s=Line")).toBe(5);
  });

  test("an id in a namespace whose URI the table lists twice is outside", async () => {
    const table = [...TABLE, "urn:twin", "urn:twin"];
    const { client } = fakeServer({
      "ns=2;s=Line": { name: "Line", children: [{ target: "ns=5;s=A" }, { target: "nsu=urn:twin;s=B" }] },
      "ns=5;s=A": variable("A"),
    });
    const proved = await proveReadSet(client, [ROOT], table, CHUNKS);
    expect([...proved.members.keys()]).toEqual(["ns=2;s=Line"]);
    expect(proved.outward.get("ns=2;s=Line")).toBe(2);
    const refused = await proveReadSet(client, ["nsu=urn:twin;s=A"], table, CHUNKS).catch((e: Error) => e.message);
    expect(refused).toBe(
      "Read root nsu=urn:twin;s=A is ambiguous on this server: its namespace URI appears more than once in the server's namespace table. Nothing was answered.",
    );
  });

  test("a root whose URI sits at index 0, or in the diagnostics namespace, refuses before anything is sent", async () => {
    const { client, log } = fakeServer({});
    const table = [PLANT, ...TABLE.filter((uri) => uri !== PLANT)];
    expect(await proveReadSet(client, [ROOT], table, CHUNKS).catch((e: Error) => e.message)).toBe(
      "Read root nsu=urn:plant;s=Line resolves into namespace 0 on this server, which is never read beneath a root outside the fixed table. Nothing was answered.",
    );
    expect(
      await proveReadSet(client, ["nsu=http://opcfoundation.org/UA/Diagnostics;i=1"], TABLE, CHUNKS).catch(
        (e: Error) => e.message,
      ),
    ).toStartWith(
      "Read root nsu=http://opcfoundation.org/UA/Diagnostics;i=1 resolves into the OPC Foundation diagnostics namespace",
    );
    expect(await proveReadSet(client, ["nsu=urn:elsewhere;s=Line"], TABLE, CHUNKS).catch((e: Error) => e.message)).toBe(
      "Read root nsu=urn:elsewhere;s=Line is not on this server: its namespace URI is not in the server's namespace table. Nothing was answered.",
    );
    expect(log).toEqual([]);
  });

  test("a root the server does not answer Good for, or one the prune catches, refuses the read whole", async () => {
    for (const [nodes, expected] of [
      [
        {},
        "Read root nsu=urn:plant;s=Line could not be read on this server: it answered BadNodeIdUnknown. Nothing was answered.",
      ],
      [
        { "ns=2;s=Line": { classStatus: "BadUserAccessDenied" } },
        "Read root nsu=urn:plant;s=Line could not be read on this server: it answered BadUserAccessDenied. Nothing was answered.",
      ],
      [
        { "ns=2;s=Line": { name: "AdminPassword" } },
        "Read root nsu=urn:plant;s=Line is of a kind agent mode never reads (its class, data type or name), so nothing beneath it is read: an operator declares another root.",
      ],
      [
        { "ns=2;s=Line": { name: "Line", nameStatus: "BadUserAccessDenied" } },
        "Read root nsu=urn:plant;s=Line is of a kind agent mode never reads (its class, data type or name), so nothing beneath it is read: an operator declares another root.",
      ],
    ] as const) {
      const { set, server } = prove(nodes as Record<string, FakeNode>);
      const refused = await set.catch((e: Error) => e);
      expect(refused).toBeInstanceOf(OpcuaReadRootsError);
      expect((refused as Error).message).toBe(expected);
      expect(server.log).toEqual([`read:facts ns=2;s=Line`]);
    }
  });

  test("a DAG costs one visit per node, and a cycle ends", async () => {
    const { set, server } = prove({
      "ns=2;s=Line": { name: "Line", children: [{ target: "ns=2;s=A" }, { target: "ns=2;s=B" }] },
      "ns=2;s=A": { name: "A", children: [{ target: "ns=2;s=C" }] },
      "ns=2;s=B": { name: "B", children: [{ target: "ns=2;s=C" }] },
      "ns=2;s=C": { name: "C", children: [{ target: "ns=2;s=Line" }] },
    });
    const proved = await set;
    expect(proved.members.size).toBe(4);
    expect(proved.kept.get("ns=2;s=B")?.map((r) => r.nodeId)).toEqual(["ns=2;s=C"]);
    expect(proved.kept.get("ns=2;s=C")?.map((r) => r.nodeId)).toEqual(["ns=2;s=Line"]);
    expect(server.log.filter((line) => line.startsWith("browse")).join(" ")).toBe(
      "browse ns=2;s=Line browse ns=2;s=A,ns=2;s=B browse ns=2;s=C",
    );
  });

  test("a member at the depth stop is browsed and counted, and its targets are not added", async () => {
    const chain: Record<string, FakeNode> = {};
    for (let level = 0; level <= OPCUA_READ_SET_MAX_DEPTH + 1; level += 1)
      chain[`ns=2;s=L${level}`] = { name: `L${level}`, children: [{ target: `ns=2;s=L${level + 1}` }] };
    const { set } = prove(chain, [`nsu=${PLANT};s=L0`]);
    const proved = await set;
    expect(proved.members.has(`ns=2;s=L${OPCUA_READ_SET_MAX_DEPTH}`)).toBe(true);
    expect(proved.members.has(`ns=2;s=L${OPCUA_READ_SET_MAX_DEPTH + 1}`)).toBe(false);
    expect(proved.outward.get(`ns=2;s=L${OPCUA_READ_SET_MAX_DEPTH}`)).toBe(1);
    expect(proved.kept.get(`ns=2;s=L${OPCUA_READ_SET_MAX_DEPTH}`)).toEqual([]);
  });

  test("the node bound refuses at one past it, never answering part of the set", async () => {
    const wide = (count: number): Record<string, FakeNode> => ({
      "ns=2;s=Line": {
        name: "Line",
        children: Array.from({ length: count }, (_, i) => ({ target: `ns=2;i=${i}` })),
      },
      ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`ns=2;i=${i}`, variable(`V${i}`)])),
    });
    const big = { browse: 20, read: 5_000 };
    const exact = await proveReadSet(fakeServer(wide(OPCUA_READ_SET_MAX_NODES - 1)).client, [ROOT], TABLE, big);
    expect(exact.members.size).toBe(OPCUA_READ_SET_MAX_NODES);
    expect(
      await proveReadSet(fakeServer(wide(OPCUA_READ_SET_MAX_NODES)).client, [ROOT], TABLE, big).catch(
        (e: Error) => e.message,
      ),
    ).toBe(
      "The read roots of this connection hold more than 2,000 nodes, past what one read proves: an operator declares narrower read roots. Nothing was answered.",
    );
  });

  test("the request bound refuses at one past it", async () => {
    const roots = Array.from({ length: 32 }, (_, i) => `nsu=${PLANT};s=R${i}`);
    const many = (perRoot: number): Record<string, FakeNode> => {
      const nodes: Record<string, FakeNode> = {};
      for (const [r] of roots.entries())
        for (let i = 0; i < perRoot; i += 1)
          nodes[i === 0 ? `ns=2;s=R${r}` : `ns=2;s=R${r}.${i}`] = {
            name: `R${r}.${i}`,
            children: i + 1 < perRoot ? [{ target: `ns=2;s=R${r}.${i + 1}` }] : [],
          };
      return nodes;
    };
    const one = { browse: 1, read: 1 };
    // With chunks of one, the roots' facts cost 32 reads, and each level one browse per member and one facts read per
    // new member: 32 roots of two members cost 32 + 32 browses + 32 reads + 32 browses = 128, and of three, 192.
    const fits = await proveReadSet(fakeServer(many(2)).client, roots, TABLE, one);
    expect(fits.requests).toBe(128);
    expect(await proveReadSet(fakeServer(many(3)).client, roots, TABLE, one).catch((e: Error) => e.message)).toBe(
      "The read roots of this connection need more than 150 requests to prove, past what one read proves: an operator declares narrower read roots. Nothing was answered.",
    );
    expect(OPCUA_READ_SET_MAX_REQUESTS).toBe(150);
  });

  test("a member whose Browse is refused is a leaf, and nothing beneath it is a member", async () => {
    const { set } = prove({
      "ns=2;s=Line": { name: "Line", children: [{ target: "ns=2;s=Locked" }] },
      "ns=2;s=Locked": { name: "Locked", browseStatus: "BadUserAccessDenied", children: [{ target: "ns=2;s=Under" }] },
      "ns=2;s=Under": variable("Under"),
    });
    const proved = await set;
    expect([...proved.leaves]).toEqual(["ns=2;s=Locked"]);
    expect(proved.members.has("ns=2;s=Under")).toBe(false);
    expect(proved.kept.get("ns=2;s=Locked")).toEqual([]);
  });

  test("continuation points are followed to their end, and a refused one or a Bad BrowseNext refuses whole", async () => {
    const nodes = {
      "ns=2;s=Line": { name: "Line", children: ["A", "B", "C"].map((n) => ({ target: `ns=2;s=${n}` })) },
      ...Object.fromEntries(["A", "B", "C"].map((n) => [`ns=2;s=${n}`, variable(n)])),
    };
    const paged = await proveReadSet(fakeServer(nodes, { page: 1 }).client, [ROOT], TABLE, CHUNKS);
    expect(paged.kept.get("ns=2;s=Line")?.map((r) => r.nodeId)).toEqual(["ns=2;s=A", "ns=2;s=B", "ns=2;s=C"]);
    expect(
      await proveReadSet(
        fakeServer(nodes, { page: 1, nextStatus: "BadContinuationPointInvalid" }).client,
        [ROOT],
        TABLE,
        CHUNKS,
      ).catch((e: Error) => e.message),
    ).toBe(
      "The server stopped listing the read roots part way (BadContinuationPointInvalid), so the set cannot be proved. Nothing was answered.",
    );
    const refusedPoint = {
      ...nodes,
      "ns=2;s=Line": { ...nodes["ns=2;s=Line"], browseStatus: "BadNoContinuationPoints" },
    };
    expect(
      await proveReadSet(fakeServer(refusedPoint).client, [ROOT], TABLE, CHUNKS).catch((e: Error) => e.message),
    ).toBe(
      "The server stopped listing the read roots part way (BadNoContinuationPoints), so the set cannot be proved. Nothing was answered.",
    );
  });

  test("prune rule 1: a class refused, unspecified, or a Variable whose DataType is refused or withheld", async () => {
    const { set } = prove({
      "ns=2;s=Line": {
        name: "Line",
        children: ["Refused", "Zero", "NoType", "Session", "Folder", "Plain"].map((n) => ({ target: `ns=2;s=${n}` })),
      },
      "ns=2;s=Refused": { name: "Refused", classStatus: "BadUserAccessDenied" },
      "ns=2;s=Zero": { name: "Zero", nodeClass: "Unspecified" },
      "ns=2;s=NoType": variable("NoType", { dataTypeStatus: "BadUserAccessDenied" }),
      "ns=2;s=Session": variable("Session", { dataType: "ns=0;i=865" }),
      "ns=2;s=Folder": { name: "Folder", nodeClass: "Object", children: [{ target: "ns=2;s=Deep" }] },
      "ns=2;s=Deep": variable("Deep"),
      "ns=2;s=Plain": variable("Plain"),
    });
    const proved = await set;
    expect([...proved.members.keys()].sort()).toEqual(["ns=2;s=Deep", "ns=2;s=Folder", "ns=2;s=Line", "ns=2;s=Plain"]);
    expect(proved.outward.get("ns=2;s=Line")).toBe(4);
  });

  test("prune rule 2 by a withheld type definition, rule 3 by qualified name, rule 4 by a credential name", async () => {
    const { set } = prove({
      "ns=2;s=Line": {
        name: "Line",
        children: [
          { target: "ns=2;s=Session", typeDefinition: "ns=0;i=2029" },
          { target: "ns=2;s=Lock" },
          { target: "ns=2;s=Condition" },
          { target: "ns=2;s=OwnClientUserId" },
          { target: "ns=2;s=Secret" },
          { target: "ns=2;s=Pump" },
        ],
      },
      "ns=2;s=Session": { name: "Session", children: [{ target: "ns=2;s=Who" }] },
      "ns=2;s=Who": variable("Who"),
      "ns=2;s=Lock": { name: "Lock", ns: 4, children: [{ target: "ns=2;s=LockingUser" }] },
      "ns=2;s=LockingUser": variable("LockingUser", { ns: 4 }),
      "ns=2;s=Condition": variable("ClientUserId", { ns: 0 }),
      "ns=2;s=OwnClientUserId": variable("ClientUserId", { ns: 2 }),
      "ns=2;s=Secret": variable("ApiToken"),
      "ns=2;s=Pump": variable("Pump"),
    });
    const proved = await set;
    expect([...proved.members.keys()].sort()).toEqual(["ns=2;s=Line", "ns=2;s=OwnClientUserId", "ns=2;s=Pump"]);
    expect(proved.outward.get("ns=2;s=Line")).toBe(4);
  });

  test("prune rule 3 fails closed: a node whose BrowseName the server will not answer is pruned with its subtree", async () => {
    const { set } = prove({
      "ns=2;s=Line": {
        name: "Line",
        children: ["Lock", "Condition", "Pump"].map((n) => ({ target: `ns=2;s=${n}` })),
      },
      "ns=2;s=Lock": {
        name: "Lock",
        ns: 4,
        nameStatus: "BadUserAccessDenied",
        children: [{ target: "ns=2;s=LockingUser" }],
      },
      "ns=2;s=LockingUser": variable("LockingUser", { ns: 4, nameStatus: "BadUserAccessDenied" }),
      "ns=2;s=Condition": variable("ClientUserId", { ns: 0, nameStatus: "BadUserAccessDenied" }),
      "ns=2;s=Pump": variable("Pump"),
    });
    const proved = await set;
    expect([...proved.members.keys()].sort()).toEqual(["ns=2;s=Line", "ns=2;s=Pump"]);
    expect(proved.outward.get("ns=2;s=Line")).toBe(2);
  });

  test("a node that claims a class bearing no value yet answers a DataType is pruned with its subtree", async () => {
    const { set } = prove({
      "ns=2;s=Line": {
        name: "Line",
        children: ["Liar", "Folder"].map((n) => ({ target: `ns=2;s=${n}` })),
      },
      // A UserNameIdentityToken variable whose own NodeClass attribute says Object.
      "ns=2;s=Liar": {
        name: "Liar",
        nodeClass: "Object",
        dataType: "ns=0;i=322",
        children: [{ target: "ns=2;s=Detail" }],
      },
      "ns=2;s=Detail": variable("Detail"),
      // A folder whose DataType the server refuses, as a server answers for a class with no such attribute.
      "ns=2;s=Folder": { name: "Folder", nodeClass: "Object", dataTypeStatus: "BadAttributeIdInvalid" },
    });
    const proved = await set;
    expect([...proved.members.keys()].sort()).toEqual(["ns=2;s=Folder", "ns=2;s=Line"]);
    expect(proved.outward.get("ns=2;s=Line")).toBe(1);
  });

  test("a namespace-0 root's members are its fixed rows, read and never browsed", async () => {
    const nodes: Record<string, FakeNode> = {
      "i=2256": { name: "ServerStatus", nodeClass: "Variable", dataType: "ns=0;i=862", ns: 0 },
    };
    for (const row of OPCUA_NAMESPACE0_ROOTS[0]?.rows ?? [])
      nodes[row.nodeId] = { name: row.browseName, nodeClass: "Variable", dataType: "ns=0;i=13", ns: 0 };
    const { set, server } = prove(nodes, ["i=2256"]);
    const proved = await set;
    expect(proved.members.size).toBe(13);
    expect(server.log.every((line) => line.startsWith("read:facts"))).toBe(true);
    expect(proved.roots).toEqual([
      {
        nodeId: "i=2256",
        browseName: "ServerStatus",
        displayName: "ServerStatus",
        nodeClass: "Variable",
        referenceTypeId: null,
      },
    ]);
  });

  test("the units properties a Variable lists are kept by kind, and one left outside is recorded", async () => {
    const { set } = prove({
      "ns=2;s=Line": {
        name: "Line",
        children: [{ target: "ns=2;s=Temp" }, { target: "ns=2;s=Flow" }, { target: "ns=2;s=Bare" }],
      },
      "ns=2;s=Temp": variable("Temp", {
        children: [
          { target: "ns=2;s=Temp.EU", ref: "ns=0;i=46", name: "EngineeringUnits" },
          { target: "ns=2;s=Temp.Range", ref: "ns=0;i=46", name: "EURange" },
        ],
      }),
      "ns=2;s=Temp.EU": variable("EngineeringUnits", { dataType: "ns=0;i=887" }),
      "ns=2;s=Temp.Range": variable("EURange", { dataType: "ns=0;i=884" }),
      "ns=2;s=Flow": variable("Flow", {
        children: [{ target: "ns=0;i=1", ref: "ns=0;i=46", name: "EngineeringUnits" }],
      }),
      "ns=2;s=Bare": variable("Bare"),
    });
    const proved = await set;
    expect(proved.units.get("ns=2;s=Temp")).toEqual({
      units: "ns=2;s=Temp.EU",
      range: "ns=2;s=Temp.Range",
    });
    expect(proved.units.get("ns=2;s=Flow")).toEqual({ units: "outside" });
    expect(proved.units.get("ns=2;s=Bare")).toBeUndefined();
  });

  test("the walk's request count is a formula of the set: one facts Read and one Browse per chunk of each level", async () => {
    const line = (count: number): Record<string, FakeNode> => ({
      "ns=2;s=Line": {
        name: "Line",
        children: Array.from({ length: count }, (_, i) => ({ target: `ns=2;i=${i}` })),
      },
      ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`ns=2;i=${i}`, variable(`V${i}`)])),
    });
    // The root's facts, its Browse, the facts of its children in one Read of 200, and their Browses 20 at a time.
    for (const count of [2, 20, 21, 45]) {
      const { set, server } = prove(line(count));
      const proved = await set;
      expect([count, proved.requests]).toEqual([count, 3 + Math.ceil(count / CHUNKS.browse)]);
      expect(server.log).toHaveLength(proved.requests);
    }
  });

  test("a server that never stops paging meets the request bound, and the point it holds is handed back", async () => {
    const { set, server } = prove(
      { "ns=2;s=Line": { name: "Line", children: [{ target: "ns=2;s=A" }, { target: "ns=2;s=B" }] } },
      [ROOT],
      { page: 1, endless: true },
    );
    const refused = await set.catch((error: Error) => error);
    expect((refused as Error).message).toBe(OPCUA_READ_ROOTS_SENTENCES.requests);
    const sent = server.log.filter((line) => !line.startsWith("release"));
    expect(sent.length).toBe(OPCUA_READ_SET_MAX_REQUESTS);
    // The last point the server handed out, released once the bound stopped the walk, and nothing after it.
    expect(server.log.at(-1)).toBe(`release ${OPCUA_READ_SET_MAX_REQUESTS - 1}`);
  });

  test("the request bound answers a walk of exactly its size and refuses one request more", async () => {
    const wide: Record<string, FakeNode> = {
      "ns=2;s=Line": {
        name: "Line",
        children: Array.from({ length: 74 }, (_, i) => ({ target: `ns=2;i=${i}` })),
      },
      ...Object.fromEntries(Array.from({ length: 74 }, (_, i) => [`ns=2;i=${i}`, variable(`V${i}`)])),
      "i=2255": { name: "NamespaceArray", nodeClass: "Variable", dataType: "ns=0;i=12", ns: 0 },
    };
    const one = { browse: 1, read: 1 };
    // With chunks of one: the root's facts, its Browse, then one facts Read and one Browse per child, 2 + 2 * 74.
    const exact = await proveReadSet(fakeServer(wide).client, [ROOT], TABLE, one);
    expect(exact.requests).toBe(OPCUA_READ_SET_MAX_REQUESTS);
    // A namespace-0 root with no rows adds one facts Read and no Browse: 151.
    expect(
      await proveReadSet(fakeServer(wide).client, [ROOT, "i=2255"], TABLE, one).catch((e: Error) => e.message),
    ).toBe(OPCUA_READ_ROOTS_SENTENCES.requests);
  });

  test("a namespace-0 fixed row the server does not answer Good for is no member", async () => {
    const nodes: Record<string, FakeNode> = {
      "i=2256": { name: "ServerStatus", nodeClass: "Variable", dataType: "ns=0;i=862", ns: 0 },
    };
    for (const row of OPCUA_NAMESPACE0_ROOTS[0]?.rows ?? [])
      nodes[row.nodeId] = { name: row.browseName, nodeClass: "Variable", dataType: "ns=0;i=13", ns: 0 };
    nodes["i=2259"] = { name: "State", classStatus: "BadUserAccessDenied", ns: 0 };
    nodes["i=2258"] = { name: "CurrentTime", nodeClass: "Variable", dataTypeStatus: "BadUserAccessDenied", ns: 0 };
    const proved = await prove(nodes, ["i=2256"]).set;
    expect(proved.members.has("i=2259")).toBe(false);
    expect(proved.members.has("i=2258")).toBe(false);
    expect(proved.members.has("i=2257")).toBe(true);
    expect(proved.members.size).toBe(11);
  });

  test("a units property the walk pruned by its own facts is outside, never a place to read", async () => {
    const withUnits = (eu: FakeNode): Record<string, FakeNode> => ({
      "ns=2;s=Line": { name: "Line", children: [{ target: "ns=2;s=Temp" }] },
      "ns=2;s=Temp": variable("Temp", {
        children: [{ target: "ns=2;s=Temp.EU", ref: "ns=0;i=46", name: "EngineeringUnits" }],
      }),
      "ns=2;s=Temp.EU": eu,
    });
    for (const [why, eu] of [
      ["a withheld data type", variable("EngineeringUnits", { dataType: "ns=0;i=865" })],
      ["a credential name", variable("EngineeringUnits", { display: "DevicePassword" })],
      ["a standard identity property", variable("LockingUser", { ns: 4 })],
      ["a refused data type", variable("EngineeringUnits", { dataTypeStatus: "BadUserAccessDenied" })],
    ] as const) {
      const proved = await prove(withUnits(eu)).set;
      expect([why, proved.members.has("ns=2;s=Temp.EU")]).toEqual([why, false]);
      expect([why, proved.units.get("ns=2;s=Temp")]).toEqual([why, { units: "outside" }]);
      expect([why, proved.kept.get("ns=2;s=Temp")]).toEqual([why, []]);
      expect([why, proved.outward.get("ns=2;s=Temp")]).toEqual([why, 1]);
    }
  });
});

describe("the sentences", () => {
  test("a fragment is framed with the element's index inside the sentence", () => {
    expect(readRootSentence({ index: 3, reason: "is longer than 512 characters." })).toBe(
      "agentReadRoots[3] is longer than 512 characters.",
    );
    expect(readRootSentence({ reason: "is empty." })).toBe("agentReadRoots is empty.");
  });

  test("the whole-read refusals name only what the operator wrote", () => {
    expect(OPCUA_READ_ROOTS_SENTENCES.unreadable("i=2256", "BadNodeIdUnknown")).toBe(
      "Read root i=2256 could not be read on this server: it answered BadNodeIdUnknown. Nothing was answered.",
    );
  });

  test("the outward note counts and names nothing else", () => {
    expect(outwardNote(1)).toBe(
      "1 reference of this node leads outside this connection's read roots and is not listed.",
    );
    expect(outwardNote(4)).toBe(
      "4 references of this node lead outside this connection's read roots and are not listed.",
    );
  });
});

describe("answerTimeOutside", () => {
  const row = (over: Partial<OpcuaDataValue>): OpcuaDataValue => ({
    nodeId: "ns=2;s=A",
    value: 1,
    statusCode: "Good",
    ...over,
  });
  test("a value on a valueless class, a changed class, no class, or a withheld data type answers as outside", () => {
    expect(answerTimeOutside({ nodeClass: "Variable" }, row({ nodeClass: "Variable", dataTypeId: "ns=0;i=11" }))).toBe(
      false,
    );
    expect(answerTimeOutside({ nodeClass: "Object" }, row({ nodeClass: "Object" }))).toBe(true);
    expect(answerTimeOutside({ nodeClass: "Object" }, row({ nodeClass: "Object", value: null }))).toBe(false);
    expect(answerTimeOutside({ nodeClass: "Object" }, row({ nodeClass: "Variable" }))).toBe(true);
    expect(answerTimeOutside({ nodeClass: "Variable" }, row({}))).toBe(true);
    expect(answerTimeOutside({ nodeClass: "Variable" }, row({ nodeClass: "Variable", dataTypeId: "ns=0;i=868" }))).toBe(
      true,
    ); // The walk admitted a Variable or VariableType only on a DataType answered Good, so a row with none disagrees.
    expect(answerTimeOutside({ nodeClass: "Variable" }, row({ nodeClass: "Variable" }))).toBe(true);
    expect(answerTimeOutside({ nodeClass: "VariableType" }, row({ nodeClass: "VariableType", value: null }))).toBe(
      true,
    );
  });
});

describe("keyIn", () => {
  test("keys by the table entry, never by a cached index", () => {
    expect(keyIn("nsu=urn:plant;s=A", TABLE)).toEqual({ key: "ns=2;s=A", namespace: "other" });
    expect(keyIn("ns=0;i=85", TABLE)).toEqual({ key: "i=85", namespace: "0" });
    expect(keyIn("ns=3;i=1", TABLE)).toEqual({ key: "ns=3;i=1", namespace: "diagnostics" });
    expect(
      keyIn(
        "ns=7;i=1",
        ["http://opcfoundation.org/UA/", "x", "http://opcfoundation.org/UA/", "", "", "", "", ""].map((u, i) =>
          i === 7 ? "http://opcfoundation.org/UA/" : u,
        ),
      ),
    ).toBeUndefined();
    expect(keyIn("ns=5;i=1", TABLE)).toBeUndefined();
    expect(keyIn("nsu=urn:nowhere;i=1", TABLE)).toBeUndefined();
    expect(keyIn("ns=2;b=A", TABLE)).toBeUndefined();
  });
});
