/**
 * The OPC UA agent read against a REAL server whose own namespace hangs, beneath a declared read root, the kinds of
 * node a vendor or a companion model hangs beside its process data: a DI device's locking object with the client and
 * user that hold it, a condition's `ClientUserId`, a session object of the standard type, a node named for a
 * credential, and a reference out to the Server object; and, outside every root, a folder of its own.
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
import { DataType, Variant } from "node-opcua-client";
import { OPCUAServer } from "node-opcua-server";
import { OPCUA_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/industrial/opcua/agent-read";
import { outwardNote } from "@/lib/db/providers/industrial/opcua/agent-roots";
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
  // A reference from a member out to the Server object, which is never a member whatever reaches it.
  line.addReference({ referenceType: "Organizes", isForward: true, nodeId: "ns=0;i=2253" });
  // Outside every root: a folder beside the line, with a value of its own.
  const office = namespace.addFolder("ObjectsFolder", { browseName: "Office" });
  ids.outside = namespace
    .addVariable({ componentOf: office, browseName: "Recipe", dataType: "String", value: text(`${PLANTED}-recipe`) })
    .nodeId.toString();
  ids.missing = `ns=${namespace.index};s=NoSuchNode`;
  await server.start();
  const endpoint = `opc.tcp://127.0.0.1:${server.endpoints[0]?.port}/libredb-vendor`;
  const root = `nsu=${namespace.namespaceUri};${ids.line.slice(ids.line.indexOf(";") + 1)}`;
  const connection = {
    id: "vendor",
    name: "vendor",
    type: "opcua",
    host: endpoint,
    securityMode: "None",
    agentReadRoots: [root],
  } as unknown as DatabaseConnection;
  provider = new OpcuaProvider(connection, {}, AGENT, recordedSession);
  await provider.connect();
});

afterAll(async () => {
  await provider?.disconnect();
  await server?.shutdown();
  if (PKI_BEFORE === undefined) delete process.env[OPCUA_PKI_ROOT_ENV];
  else process.env[OPCUA_PKI_ROOT_ENV] = PKI_BEFORE;
  for (const root of SCRATCH) rmSync(root, { recursive: true, force: true });
});

/** One read's answer and requests, the named id put back to one spelling so two ids compare byte for byte. */
async function read(statement: Record<string, unknown>, id: string) {
  requests = [];
  const answer = await provider.queryReadOnly(JSON.stringify(statement), BUDGET).then(
    (result) => JSON.stringify({ ...result, executionTime: 0 }),
    (error: Error) => `${error.name}: ${error.message}`,
  );
  return { answer: answer.replaceAll(id, "<id>"), requests: [...requests] };
}

const OUTSIDE = ["lock", "lockingClient", "lockingUser", "clientUserId", "client", "clientName", "password", "outside"];

describe("beneath a declared root", () => {
  test("a process value is answered, with its units", async () => {
    const { answer } = await read({ read: [ids.speed] }, ids.speed);
    expect(answer).toContain('"value":"12.5"');
    expect(answer).toContain('"units":"no units published"');
  });

  test("the identity, session and credential nodes and the folder outside answer as a missing id, for every read", async () => {
    for (const kind of [
      (id: string) => ({ read: [id] }),
      (id: string) => ({ history: id }),
      (id: string) => ({ browse: id }),
    ]) {
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

  test("a browse of the root lists the process value and counts what leads outside, naming none of it", async () => {
    requests = [];
    const result = await provider.queryReadOnly(JSON.stringify({ browse: ids.line }), BUDGET);
    expect(result.rows.map((row) => row.browseName)).toEqual(["Speed"]);
    expect(result.warnings?.map((warning) => warning.message)).toEqual([outwardNote(5)]);
    expect(JSON.stringify(result)).not.toContain(PLANTED);
    // The answer itself sent nothing: its requests are the walk's alone, the same as a browse of the read roots sends.
    const browsed = [...requests];
    requests = [];
    await provider.queryReadOnly(JSON.stringify({ browse: "i=85" }), BUDGET);
    expect(browsed).toEqual(requests);
  });
});
