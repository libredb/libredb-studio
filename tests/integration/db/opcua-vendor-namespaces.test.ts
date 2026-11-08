/**
 * The OPC UA agent read against a REAL server whose own namespace hangs, beneath a declared read root, the kinds of
 * node a vendor or a companion model hangs beside its process data: a DI device's locking object with the client and
 * user that hold it, a condition's `ClientUserId`, a session object of the standard type, a node named for a
 * credential, a reference out to the Server object, a units property of a session diagnostics data type, nodes whose
 * NodeClass or DataType the server refuses to read, nodes whose NodeClass attribute disagrees with their browse, and
 * one whose DataType changes between the walk and the answer; identity nodes whose BrowseName the server refuses to
 * read, and a value of an identity data type whose NodeClass attribute says Object, with a child; outside every root, a
 * folder of its own; a clean process folder declared as the root of a second connection; and a folder the server lists
 * a few references at a time, declared as the root of a third.
 *
 * A stand-in session would agree with whatever the provider assumed about a server's answers, so this drives the
 * provider's own `queryReadOnly`, over the library, against `node-opcua-server` started here on a port the system
 * picks, with every request the read sends recorded by node id. Every planted value starts with "planted" and must
 * never appear in an answer; an outside id and a missing one must answer alike and send the same requests.
 */
// oxlint-disable no-await-in-loop -- one read at a time on one handle, each over a session of its own.
import "@/lib/db/providers/industrial/opcua/hostname-guard";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPCUACertificateManager } from "node-opcua-certificate-manager";
import { AttributeIds, DataType, DataValue, resolveNodeId, StatusCodes, Variant } from "node-opcua-client";
import { OPCUAServer } from "node-opcua-server";
import { OPCUA_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/industrial/opcua/agent-read";
import { outwardNote } from "@/lib/db/providers/industrial/opcua/agent-roots";
import { OPCUA_UNITS_OUTSIDE } from "@/lib/db/providers/industrial/opcua/agent-units";
import type { OpcuaReadOnlyClient } from "@/lib/db/providers/industrial/opcua/client";
import { OpcuaProvider } from "@/lib/db/providers/industrial/opcua/index";
import { openLibrarySession } from "@/lib/db/providers/industrial/opcua/library";
import { OPCUA_PKI_ROOT_ENV } from "@/lib/db/providers/industrial/opcua/pki";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const AGENT: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 50, maxResultBytes: 1_000_000, statementTimeoutMs: 15_000 };
const PLANTED = "planted";
const SCRATCH: string[] = [];
const PKI_BEFORE = process.env[OPCUA_PKI_ROOT_ENV];

let server: OPCUAServer;
let provider: OpcuaProvider;
/** A second connection, whose one root is a clean process folder that holds none of the shapes. */
let clean: OpcuaProvider;
/** A third connection, whose one root is a folder the server lists two references at a time. */
let paged: OpcuaProvider;
/** Whether the server refuses every continuation point a BrowseNext hands back, as one it no longer holds. */
let refuseNext = false;
/** The in-process server's endpoint, once it listens. */
let endpointOf = (): string => "";
/** How many times the shifting node's DataType has been read in the current read: the walk's first, the answer's next. */
let shifts = 0;
/** Every node id each request of the current read named, by service. */
let requests: string[] = [];
const ids: Record<string, string> = {};

const scratch = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  SCRATCH.push(root);
  return root;
};

/** The library's session, every request it is asked recorded by service and node id. */
async function recordedSession(options: Parameters<typeof openLibrarySession>[0]): Promise<OpcuaReadOnlyClient> {
  const session = await openLibrarySession(options);
  return {
    ...session,
    browse: async (nodeIds) => {
      requests.push(`browse ${nodeIds.join(",")}`);
      return session.browse(nodeIds);
    },
    browseNext: async (points) => {
      requests.push(`browseNext ${points.length}`);
      return session.browseNext(points);
    },
    read: async (nodeIds, list) => {
      requests.push(`read${list === "facts" ? ":facts" : ""} ${nodeIds.join(",")}`);
      return session.read(nodeIds, list);
    },
    historyRead: async (request) => {
      requests.push(`historyRead ${request.nodeId}`);
      return session.historyRead(request);
    },
  };
}

beforeAll(async () => {
  process.env[OPCUA_PKI_ROOT_ENV] = scratch("opcua-vendor-client-pki-");
  server = new OPCUAServer({
    port: 0,
    resourcePath: "/libredb-vendor",
    serverCertificateManager: new OPCUACertificateManager({
      rootFolder: scratch("opcua-vendor-server-pki-"),
      automaticallyAcceptUnknownCertificate: true,
    }),
    buildInfo: { productName: "libredb-vendor-server", buildNumber: "1", buildDate: new Date(0) },
  });
  await server.initialize();
  const space = server.engine.addressSpace;
  if (space === null || space === undefined) throw new Error("the server started with no address space");
  const namespace = space.getOwnNamespace();
  const di = space.registerNamespace("http://opcfoundation.org/UA/DI/");
  const text = (value: string) => ({ get: () => new Variant({ dataType: DataType.String, value }) });

  const line = namespace.addFolder("ObjectsFolder", { browseName: "Line1" });
  ids.line = line.nodeId.toString();
  ids.speed = namespace
    .addVariable({
      componentOf: line,
      browseName: "Speed",
      dataType: "Double",
      value: { get: () => new Variant({ dataType: DataType.Double, value: 12.5 }) },
    })
    .nodeId.toString();
  // A DI device's locking object, in the DI namespace, with the client and the user that hold the lock.
  const lock = di.addObject({ componentOf: line, browseName: "Lock" });
  ids.lock = lock.nodeId.toString();
  ids.lockingClient = di
    .addVariable({
      componentOf: lock,
      browseName: "LockingClient",
      dataType: "String",
      value: text(`${PLANTED}-client`),
    })
    .nodeId.toString();
  ids.lockingUser = di
    .addVariable({ componentOf: lock, browseName: "LockingUser", dataType: "String", value: text(`${PLANTED}-user`) })
    .nodeId.toString();
  // A condition's ClientUserId: the OPC Foundation's qualified name, hung beneath an ordinary plant folder.
  ids.clientUserId = namespace
    .addVariable({
      componentOf: line,
      browseName: { namespaceIndex: 0, name: "ClientUserId" },
      dataType: "String",
      value: text(`${PLANTED}-operator`),
    })
    .nodeId.toString();
  // A session object of the standard type, and a node named for a credential, both beneath the root.
  const sessionType = space.findObjectType("SessionDiagnosticsObjectType");
  if (sessionType === null) throw new Error("the server has no SessionDiagnosticsObjectType");
  const client = namespace.addObject({ componentOf: line, browseName: "Client7", typeDefinition: sessionType });
  ids.client = client.nodeId.toString();
  ids.clientName = namespace
    .addVariable({ componentOf: client, browseName: "Name", dataType: "String", value: text(`${PLANTED}-session`) })
    .nodeId.toString();
  ids.password = namespace
    .addVariable({ componentOf: line, browseName: "DB_Password", dataType: "String", value: text(`${PLANTED}-secret`) })
    .nodeId.toString();
  // A units property of a session diagnostics data type: the walk prunes it, so its units are never read.
  const temp = namespace.addVariable({
    componentOf: line,
    browseName: "Temp",
    dataType: "Double",
    value: { get: () => new Variant({ dataType: DataType.Double, value: 21.5 }) },
  });
  ids.temp = temp.nodeId.toString();
  const sessionData = space.findDataType("SessionDiagnosticsDataType");
  if (sessionData === null) throw new Error("the server has no SessionDiagnosticsDataType");
  ids.tempUnits = namespace
    .addVariable({
      propertyOf: temp,
      browseName: { namespaceIndex: 0, name: "EngineeringUnits" },
      dataType: sessionData,
    })
    .nodeId.toString();
  /** A planted String variable beneath the line whose answer to one attribute the server rewrites. */
  const rewritten = (name: string, answer: (attributeId: number) => DataValue | undefined): string => {
    const node = namespace.addVariable({
      componentOf: line,
      browseName: name,
      dataType: "String",
      value: text(`${PLANTED}-${name}`),
    });
    const own = node.readAttribute.bind(node);
    node.readAttribute = ((context, attributeId, ...rest) =>
      answer(attributeId) ?? own(context, attributeId, ...rest)) as typeof node.readAttribute;
    return node.nodeId.toString();
  };
  const refused = new DataValue({ statusCode: StatusCodes.BadUserAccessDenied });
  const classed = (nodeClass: number) =>
    new DataValue({ value: new Variant({ dataType: DataType.Int32, value: nodeClass }), statusCode: StatusCodes.Good });
  // The server refuses to read the DataType of one, and the NodeClass of another.
  ids.refusedType = rewritten("RefusedType", (id) => (id === AttributeIds.DataType ? refused : undefined));
  ids.refusedClass = rewritten("RefusedClass", (id) => (id === AttributeIds.NodeClass ? refused : undefined));
  // The browse says Variable, and the NodeClass attribute says Object (1) or Unspecified (0).
  ids.classedObject = rewritten("ClassedObject", (id) => (id === AttributeIds.NodeClass ? classed(1) : undefined));
  ids.classedZero = rewritten("ClassedZero", (id) => (id === AttributeIds.NodeClass ? classed(0) : undefined));
  // A String to the walk, and a session diagnostics data type to the answer's own Read.
  ids.shifting = rewritten("Shifting", (id) => {
    if (id !== AttributeIds.DataType) return undefined;
    shifts += 1;
    const type = shifts === 1 ? "ns=0;i=12" : "ns=0;i=865";
    return new DataValue({
      value: new Variant({ dataType: DataType.NodeId, value: resolveNodeId(type) }),
      statusCode: StatusCodes.Good,
    });
  });
  /** A node beneath the line whose answer to one attribute the server replaces with `answer`. */
  const answering = <T extends { readAttribute: unknown }>(node: T, attributeId: number, answer: DataValue): string => {
    const own = (node.readAttribute as (...args: unknown[]) => DataValue).bind(node);
    node.readAttribute = ((context: unknown, id: number, ...rest: unknown[]) =>
      id === attributeId ? answer : own(context, id, ...rest)) as T["readAttribute"];
    return (node as unknown as { nodeId: { toString(): string } }).nodeId.toString();
  };
  // The DI locking object, its client and user, and a condition's ClientUserId, each refusing its BrowseName, so
  // only a server that answers the name could have them told apart from a process value.
  const unnamedLock = di.addObject({ componentOf: line, browseName: "Lock" });
  ids.unnamedLock = answering(unnamedLock, AttributeIds.BrowseName, refused);
  ids.unnamedLockingClient = answering(
    di.addVariable({
      componentOf: unnamedLock,
      browseName: "LockingClient",
      dataType: "String",
      value: text(`${PLANTED}-unnamed-client`),
    }),
    AttributeIds.BrowseName,
    refused,
  );
  ids.unnamedLockingUser = answering(
    di.addVariable({
      componentOf: unnamedLock,
      browseName: "LockingUser",
      dataType: "String",
      value: text(`${PLANTED}-unnamed-user`),
    }),
    AttributeIds.BrowseName,
    refused,
  );
  ids.unnamedClientUserId = answering(
    namespace.addVariable({
      componentOf: line,
      browseName: { namespaceIndex: 0, name: "ClientUserId" },
      dataType: "String",
      value: text(`${PLANTED}-unnamed-operator`),
    }),
    AttributeIds.BrowseName,
    refused,
  );
  // A UserNameIdentityToken value whose NodeClass attribute says Object, with a child of its own.
  const token = namespace.addVariable({ componentOf: line, browseName: "AuthState", dataType: "ns=0;i=322" });
  ids.token = answering(token, AttributeIds.NodeClass, classed(1));
  ids.tokenDetail = namespace
    .addVariable({ componentOf: token, browseName: "Detail", dataType: "String", value: text(`${PLANTED}-detail`) })
    .nodeId.toString();
  // A reference from a member out to the Server object, which is never a member whatever reaches it.
  line.addReference({ referenceType: "Organizes", isForward: true, nodeId: "ns=0;i=2253" });
  // Outside every root: a folder beside the line, with a value of its own.
  const office = namespace.addFolder("ObjectsFolder", { browseName: "Office" });
  ids.outside = namespace
    .addVariable({ componentOf: office, browseName: "Recipe", dataType: "String", value: text(`${PLANTED}-recipe`) })
    .nodeId.toString();
  ids.missing = `ns=${namespace.index};s=NoSuchNode`;
  // A clean process folder, which holds none of the shapes, for the second connection's one root.
  const processFolder = namespace.addFolder("ObjectsFolder", { browseName: "Process" });
  ids.process = processFolder.nodeId.toString();
  ids.flow = namespace
    .addVariable({
      componentOf: processFolder,
      browseName: "Flow",
      dataType: "Double",
      value: { get: () => new Variant({ dataType: DataType.Double, value: 3.5 }) },
    })
    .nodeId.toString();
  // A folder the server lists two references at a time, so every Browse of it hands back a continuation point.
  const pagedFolder = namespace.addFolder("ObjectsFolder", { browseName: "Paged" });
  ids.paged = pagedFolder.nodeId.toString();
  for (let at = 0; at < 7; at += 1)
    ids[`paged${at}`] = namespace
      .addVariable({
        componentOf: pagedFolder,
        browseName: `Level${at}`,
        dataType: "Double",
        value: { get: () => new Variant({ dataType: DataType.Double, value: at + 0.5 }) },
      })
      .nodeId.toString();
  // The page size is the client's to ask for, and node-opcua's client asks for far more than this folder holds, so
  // the server's own Browse and BrowseNext handlers are wrapped: a Browse of the folder asks for two references, and
  // with `refuseNext` set a BrowseNext names a point the server never handed out, which the server itself refuses.
  const handlers = server as unknown as Record<
    string,
    (message: { request: Record<string, unknown> }, channel: unknown) => void
  >;
  const onBrowse = handlers._on_BrowseRequest?.bind(server);
  const onBrowseNext = handlers._on_BrowseNextRequest?.bind(server);
  if (onBrowse === undefined || onBrowseNext === undefined) throw new Error("the server has no Browse handlers");
  handlers._on_BrowseRequest = (message, channel) => {
    const asked = (message.request.nodesToBrowse ?? []) as readonly { nodeId: { toString(): string } }[];
    if (asked.some((entry) => entry.nodeId.toString() === ids.paged)) message.request.requestedMaxReferencesPerNode = 2;
    onBrowse(message, channel);
  };
  handlers._on_BrowseNextRequest = (message, channel) => {
    if (refuseNext && message.request.releaseContinuationPoints !== true)
      message.request.continuationPoints = ((message.request.continuationPoints ?? []) as unknown[]).map(() =>
        Buffer.from("not-a-real-point"),
      );
    onBrowseNext(message, channel);
  };
  await server.start();
  const endpoint = `opc.tcp://127.0.0.1:${server.endpoints[0]?.port}/libredb-vendor`;
  endpointOf = () => endpoint;
  const rootOf = (id: string): string => `nsu=${namespace.namespaceUri};${id.slice(id.indexOf(";") + 1)}`;
  const connection = (root: string) =>
    ({
      id: "vendor",
      name: "vendor",
      type: "opcua",
      host: endpoint,
      securityMode: "None",
      agentReadRoots: [root],
    }) as unknown as DatabaseConnection;
  provider = new OpcuaProvider(connection(rootOf(ids.line)), {}, AGENT, recordedSession);
  await provider.connect();
  clean = new OpcuaProvider(connection(rootOf(ids.process)), {}, AGENT, recordedSession);
  await clean.connect();
  paged = new OpcuaProvider(connection(rootOf(ids.paged)), {}, AGENT, recordedSession);
  await paged.connect();
});

afterAll(async () => {
  await provider?.disconnect();
  await clean?.disconnect();
  await paged?.disconnect();
  await server?.shutdown();
  if (PKI_BEFORE === undefined) delete process.env[OPCUA_PKI_ROOT_ENV];
  else process.env[OPCUA_PKI_ROOT_ENV] = PKI_BEFORE;
  for (const root of SCRATCH) rmSync(root, { recursive: true, force: true });
});

/** One read's answer and requests, the named id put back to one spelling so two ids compare byte for byte. */
async function read(statement: Record<string, unknown>, id: string, on: OpcuaProvider = provider) {
  requests = [];
  shifts = 0;
  const answer = await on.queryReadOnly(JSON.stringify(statement), BUDGET).then(
    (result) => JSON.stringify({ ...result, executionTime: 0 }),
    (error: Error) => `${error.name}: ${error.message}`,
  );
  return { answer: answer.replaceAll(id, "<id>"), requests: [...requests] };
}

const OUTSIDE = [
  "lock",
  "lockingClient",
  "lockingUser",
  "clientUserId",
  "client",
  "clientName",
  "password",
  "tempUnits",
  "refusedType",
  "refusedClass",
  "classedZero",
  "classedObject",
  "unnamedLock",
  "unnamedLockingClient",
  "unnamedLockingUser",
  "unnamedClientUserId",
  "token",
  "tokenDetail",
  "outside",
];

const KINDS = [(id: string) => ({ read: [id] }), (id: string) => ({ history: id }), (id: string) => ({ browse: id })];

describe("beneath a declared root", () => {
  test("a process value is answered, with its units", async () => {
    const { answer } = await read({ read: [ids.speed] }, ids.speed);
    expect(answer).toContain('"value":"12.5"');
    expect(answer).toContain('"units":"no units published"');
  });

  test("the identity, session, credential, pruned and refused nodes and the folder outside answer as a missing id", async () => {
    for (const kind of KINDS) {
      const missing = await read(kind(ids.missing), ids.missing);
      for (const name of OUTSIDE) {
        const outside = await read(kind(ids[name] as string), ids[name] as string);
        expect([name, outside.answer]).toEqual([name, missing.answer]);
        expect([name, outside.requests]).toEqual([name, missing.requests]);
        expect(outside.answer).not.toContain(PLANTED);
        // A node beneath the root is named only by the walk, which reads the same for every request; the folder
        // outside every root is named by nothing the read sends.
        if (name === "outside")
          expect(outside.requests.some((request) => request.includes(ids[name] as string))).toBe(false);
      }
    }
    const history = await read({ history: ids.outside }, ids.outside);
    expect(history.answer).toBe(`OpcuaAgentError: ${OPCUA_AGENT_FAILURE_SENTENCES.status("BadNodeIdUnknown")}`);
  });

  test("a value whose units property the walk pruned answers that its units were not read, and never reads it", async () => {
    const { answer, requests: sent } = await read({ read: [ids.temp] }, ids.temp);
    expect(answer).toContain('"value":"21.5"');
    expect(answer).toContain(`"units":"${OPCUA_UNITS_OUTSIDE}"`);
    expect(sent.filter((request) => request.startsWith("read ")).join(" ")).not.toContain(ids.tempUnits);
  });

  test("a node whose DataType turns withheld between the walk and the answer is answered as a missing id", async () => {
    const missing = await read({ read: [ids.missing] }, ids.missing);
    const shifted = await read({ read: [ids.shifting] }, ids.shifting);
    expect(shifts).toBe(2);
    expect(shifted.answer).toBe(missing.answer);
    expect(shifted.answer).not.toContain(PLANTED);
  });

  test("a browse of the root lists the process values and counts what leads outside, naming none of it", async () => {
    requests = [];
    shifts = 0;
    const result = await provider.queryReadOnly(JSON.stringify({ browse: ids.line }), BUDGET);
    expect(result.rows.map((row) => row.browseName)).toEqual(["Speed", "Temp", "Shifting"]);
    expect(result.warnings?.map((warning) => warning.message)).toEqual([outwardNote(12)]);
    expect(JSON.stringify(result)).not.toContain(PLANTED);
    // The answer itself sent nothing: its requests are the walk's alone, the same as a browse of the read roots sends.
    const browsed = [...requests];
    requests = [];
    shifts = 0;
    await provider.queryReadOnly(JSON.stringify({ browse: "i=85" }), BUDGET);
    expect(browsed).toEqual(requests);
  });
});

describe("beneath a clean declared root", () => {
  test("the process value is answered, and the root lists it with nothing leading outside", async () => {
    const { answer } = await read({ read: [ids.flow] }, ids.flow, clean);
    expect(answer).toContain('"value":"3.5"');
    const browsed = await clean.queryReadOnly(JSON.stringify({ browse: ids.process }), BUDGET);
    expect(browsed.rows.map((row) => row.browseName)).toEqual(["Flow"]);
    expect(browsed.warnings).toBeUndefined();
  });

  test("every shape beneath the other folder, and that folder itself, answers as a missing id, sending nothing for it", async () => {
    for (const kind of KINDS) {
      const missing = await read(kind(ids.missing), ids.missing, clean);
      for (const name of ["line", "speed", ...OUTSIDE, "shifting", "temp"]) {
        const outside = await read(kind(ids[name] as string), ids[name] as string, clean);
        expect([name, outside.answer]).toEqual([name, missing.answer]);
        expect([name, outside.requests]).toEqual([name, missing.requests]);
        expect(outside.requests.some((request) => request.includes(ids[name] as string))).toBe(false);
      }
    }
  });
});

describe("beneath a root the server lists a few references at a time", () => {
  test("the walk follows every continuation point to its end, so a node on a later page is read", async () => {
    refuseNext = false;
    const browsed = await read({ browse: ids.paged }, ids.paged, paged);
    expect(browsed.requests.filter((request) => request.startsWith("browseNext"))).toEqual([
      "browseNext 1",
      "browseNext 1",
      "browseNext 1",
    ]);
    const result = await paged.queryReadOnly(JSON.stringify({ browse: ids.paged }), BUDGET);
    expect(result.rows.map((row) => row.browseName)).toEqual([0, 1, 2, 3, 4, 5, 6].map((at) => `Level${at}`));
    const last = await read({ read: [ids.paged6] }, ids.paged6 as string, paged);
    expect(last.answer).toContain('"value":"6.5"');
  });

  test("the editor's Keys panel follows the same continuation points, through the same session", async () => {
    const editor = new OpcuaProvider(
      { id: "editor", name: "editor", type: "opcua", host: endpointOf(), securityMode: "None" } as DatabaseConnection,
      {},
      undefined,
      openLibrarySession,
    );
    await editor.connect();
    try {
      const page = await editor.scanKeysPage?.({ cursor: "0", count: 50, pattern: "Paged/", level: true });
      expect(page?.keys).toEqual([0, 1, 2, 3, 4, 5, 6].map((at) => `Paged/Level${at}`));
    } finally {
      await editor.disconnect();
    }
  });

  test("a continuation point the server refuses stops the read whole, naming the status", async () => {
    refuseNext = true;
    try {
      const refused = await read({ read: [ids.paged0] }, ids.paged0 as string, paged);
      expect(refused.answer).toBe(
        "OpcuaAgentError: The server stopped listing the read roots part way (BadContinuationPointInvalid), so the set cannot be proved. Nothing was answered.",
      );
      expect(refused.requests.at(-1)).toBe("browseNext 1");
    } finally {
      refuseNext = false;
    }
  });
});
