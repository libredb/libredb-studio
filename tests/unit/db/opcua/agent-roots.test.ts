/**
 * The read roots of an OPC UA seed connection: the grammar a root list is held to before any socket, the fixed
 * namespace-0 table a root may name, and the standard identity properties, each pinned against the published nodesets.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OPCUA_IDENTITY_PROPERTIES,
  OPCUA_NAMESPACE0_ROOTS,
  OPCUA_READ_ROOT_MAX_LENGTH,
  OPCUA_READ_ROOTS_MAX,
  readRootRefusals,
} from "@/lib/db/providers/industrial/opcua/agent-roots";

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
