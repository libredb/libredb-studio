/**
 * Runs the OPC UA agent's own reads through the provider against the two OPC PLC 2.15.10 containers that
 * tests/fixtures/opcua/2.15.10/agent-boundary/run.sh started, reads the withheld nodes raw anonymously, as a user and
 * as an administrator, sends a raw Write and a raw Call on a client of its own, and writes what it measured into that
 * run.sh's directory as boundary.json.
 *
 *   sh tests/fixtures/opcua/2.15.10/agent-boundary/run.sh
 *
 * The environment names the fixture: OPCUA_AGENT_ANON_PORT (the fixture as tests/fixtures/opcua/README.md starts it),
 * OPCUA_AGENT_USERS_PORT (the same with a user and an administrator), OPCUA_AGENT_OUT (the directory to write) and the
 * two passwords run.sh generated, OPCUA_AGENT_USER_SECRET and OPCUA_AGENT_ADMIN_SECRET. The capture records no
 * credential value at all: a withheld node is recorded by the status a browse and a read of it answered and by how
 * many children and values it answered, never by a name, an identity or a value, and before anything is written the
 * whole capture is checked for both passwords, the two account names in a value position and this host's name, and the
 * script stops if any is there.
 *
 * The raw reads, the Write and the Call go through `node-opcua-client` directly, never through the agent path, which is
 * the point: what is measured is what the server does with them. The Write sends the variable's own value back, so the
 * server's state is unchanged by it, and the Call asks `GetMonitoredItems` about a subscription that does not exist.
 * The server's values are read before and after the agent's reads, and so is its session count.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs no file under tests/live/.
 */
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the server holds then.
import "@/lib/db/providers/industrial/opcua/hostname-guard";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttributeIds,
  BrowseDirection,
  type ClientSession,
  DataType,
  MessageSecurityMode,
  OPCUAClient,
  SecurityPolicy,
  UserTokenType,
} from "node-opcua-client";
import { OPCUACertificateManager } from "node-opcua-certificate-manager";
import { OPCUA_WITHHELD_NODES } from "@/lib/db/providers/industrial/opcua/agent-withheld";
import type { OpcuaReadOnlyClient } from "@/lib/db/providers/industrial/opcua/client";
import type { OpcuaConnectionOptions } from "@/lib/db/providers/industrial/opcua/connection";
import { OpcuaProvider } from "@/lib/db/providers/industrial/opcua/index";
import { openLibrarySession } from "@/lib/db/providers/industrial/opcua/library";
import { OPCUA_PKI_ROOT_ENV } from "@/lib/db/providers/industrial/opcua/pki";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const ANON_PORT = Number(env("OPCUA_AGENT_ANON_PORT"));
const USERS_PORT = Number(env("OPCUA_AGENT_USERS_PORT"));
const OUT = env("OPCUA_AGENT_OUT");
const USER_SECRET = env("OPCUA_AGENT_USER_SECRET");
const ADMIN_SECRET = env("OPCUA_AGENT_ADMIN_SECRET");
const DATE = new Date().toISOString().slice(0, 10);
const AGENT: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 50, maxResultBytes: 1_000_000, statementTimeoutMs: 10_000 };
const ROOTS: string[] = [];
const pkiRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "opcua-agent-pki-"));
  ROOTS.push(root);
  return root;
};

const ANALOG = "ns=6;s=DataAccess_AnalogType_Int32";
const PLAIN = "ns=3;s=SlowUInt1";
const HISTORIAN = "ns=3;s=HistorianInt32";

type Who = "anonymous" | "user" | "administrator";
const identities: Record<Who, { readonly userName?: string; readonly password?: string }> = {
  anonymous: {},
  user: { userName: "probe-user", password: USER_SECRET },
  administrator: { userName: "probe-admin", password: ADMIN_SECRET },
};

/** A raw client of the capture's own, with a PKI root of its own, never Studio's. */
async function rawSession(port: number, who: Who): Promise<{ session: ClientSession; close: () => Promise<void> }> {
  const manager = new OPCUACertificateManager({ rootFolder: pkiRoot(), automaticallyAcceptUnknownCertificate: true });
  await manager.initialize();
  const client = OPCUAClient.create({
    applicationName: "opcua-agent-boundary-capture",
    clientCertificateManager: manager,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    endpointMustExist: false,
    connectionStrategy: { maxRetry: 0 },
  });
  await client.connect(`opc.tcp://127.0.0.1:${port}/`);
  const identity = identities[who];
  const session = await client.createSession(
    identity.userName === undefined
      ? { type: UserTokenType.Anonymous }
      : { type: UserTokenType.UserName, userName: identity.userName, password: identity.password ?? "" },
  );
  return {
    session,
    close: async () => {
      await session.close().catch(() => undefined);
      await client.disconnect();
    },
  };
}

async function browseRaw(session: ClientSession, nodeId: string) {
  return session.browse({
    nodeId,
    browseDirection: BrowseDirection.Forward,
    referenceTypeId: "i=33",
    includeSubtypes: true,
    nodeClassMask: 0,
    resultMask: 63,
  });
}

/** What one withheld root answers read raw: statuses and counts, never a name, an identity or a value. */
async function withheldRaw(port: number, who: Who) {
  const raw = await rawSession(port, who);
  try {
    const roots = [];
    for (const root of OPCUA_WITHHELD_NODES) {
      const browsed = await browseRaw(raw.session, root.nodeId);
      const children = browsed.references ?? [];
      const read = await raw.session.read({ nodeId: root.nodeId, attributeId: AttributeIds.Value });
      let childValues = 0;
      let deeper = 0;
      for (const child of children.slice(0, 50)) {
        if (child.nodeClass === 4) continue; // Method: never called, never read here either.
        const value = await raw.session.read({ nodeId: child.nodeId, attributeId: AttributeIds.Value });
        if (value.statusCode.name === "Good" && value.value.value !== null && value.value.value !== undefined)
          childValues += 1;
        deeper += (await browseRaw(raw.session, child.nodeId.toString())).references?.length ?? 0;
      }
      roots.push({
        kind: root.kind,
        nodeId: root.nodeId,
        browse: browsed.statusCode.name,
        children: children.length,
        grandchildren: deeper,
        read: read.statusCode.name,
        childrenAnsweringAValue: childValues,
      });
    }
    return roots;
  } finally {
    await raw.close();
  }
}

/**
 * What standard namespace-0 nodes beneath the withheld roots answer read raw, by status only: the default application
 * group's TrustList (i=12642), CertificateGroups (i=14053), the Anonymous role (i=15644) and its Identities (i=16192).
 * Agent mode refuses each by its id, whatever a walk saw.
 */
async function standardDescendantsRaw(port: number, who: Who) {
  const raw = await rawSession(port, who);
  try {
    const answers = [];
    for (const nodeId of ["i=12642", "i=14053", "i=15644", "i=16192"]) {
      const browsed = await browseRaw(raw.session, nodeId);
      const read = await raw.session.read({ nodeId, attributeId: AttributeIds.Value });
      answers.push({ nodeId, browse: browsed.statusCode.name, read: read.statusCode.name });
    }
    return answers;
  } finally {
    await raw.close();
  }
}

/** The URI of the namespace OPC PLC's telemetry nodes live in (ns=3), read raw; entry 1 names the host and is not used. */
async function telemetryNamespace(port: number): Promise<string> {
  const raw = await rawSession(port, "anonymous");
  try {
    const table = await raw.session.read({ nodeId: "i=2255", attributeId: AttributeIds.Value });
    const uri = (table.value.value as string[] | null)?.[3];
    if (typeof uri !== "string") throw new Error("the fixture's namespace table has no entry 3");
    return uri;
  } finally {
    await raw.close();
  }
}

/** Whether the administrator's own session diagnostics carry its account name, measured and recorded as a flag. */
async function sessionDiagnosticsCarryIdentity(
  port: number,
): Promise<{ sessions: number; carriesAccountName: boolean }> {
  const raw = await rawSession(port, "administrator");
  try {
    const summary = await browseRaw(raw.session, "i=3706");
    let carries = false;
    for (const session of summary.references ?? []) {
      for (const child of (await browseRaw(raw.session, session.nodeId.toString())).references ?? []) {
        const value = await raw.session.read({ nodeId: child.nodeId, attributeId: AttributeIds.Value });
        if (
          JSON.stringify(value.value?.value ?? null, (_k, v) => (typeof v === "bigint" ? String(v) : v)).includes(
            "probe-admin",
          )
        )
          carries = true;
      }
    }
    return { sessions: summary.references?.length ?? 0, carriesAccountName: carries };
  } finally {
    await raw.close();
  }
}

/** A per-session node id, which the server chose, held only in memory to ask the agent about it. */
async function aSessionNode(port: number): Promise<{ id: string; close: () => Promise<void> }> {
  const raw = await rawSession(port, "administrator");
  const summary = await browseRaw(raw.session, "i=3706");
  const first = summary.references?.[0];
  if (first === undefined) throw new Error("the administrator saw no session under i=3706");
  return { id: first.nodeId.toString(), close: raw.close };
}

/** Every service the agent path asked of the session, by name, so the capture shows what reached the server. */
function recordingOpener(services: string[]) {
  return async (options: OpcuaConnectionOptions): Promise<OpcuaReadOnlyClient> => {
    const session = await openLibrarySession(options);
    services.push("open");
    return new Proxy(session, {
      get(target, property, receiver) {
        const member = Reflect.get(target, property, receiver);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          services.push(String(property));
          return (member as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  };
}

function connection(port: number, who: Who): DatabaseConnection {
  const identity = identities[who];
  return {
    id: `agent-${who}`,
    name: `agent-${who}`,
    type: "opcua",
    host: `opc.tcp://127.0.0.1:${port}/`,
    ...(identity.userName === undefined ? {} : { user: identity.userName, password: identity.password }),
  } as never;
}

/**
 * An agent-mode handle. A user token is encrypted with the server's certificate, which Studio's strict store does not
 * trust until a reader moves it from `rejected` into `trusted/certs`, as docs/providers/opcua.md section 4.4 says; the
 * capture does exactly that once, the way a reader would.
 */
async function agentHandle(port: number, who: Who, services: string[]) {
  const root = pkiRoot();
  const open = () =>
    new OpcuaProvider(connection(port, who), {}, AGENT, recordingOpener(services), { [OPCUA_PKI_ROOT_ENV]: root });
  try {
    const provider = open();
    await provider.connect();
    return provider;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("BadCertificateUntrusted")) throw error;
    mkdirSync(join(root, "trusted", "certs"), { recursive: true });
    for (const file of readdirSync(join(root, "rejected")))
      renameSync(join(root, "rejected", file), join(root, "trusted", "certs", file));
    const provider = open();
    await provider.connect();
    return provider;
  }
}

/** One agent read, recorded as what it answered, which services it sent, and how it was refused. */
async function agentRead(provider: OpcuaProvider, services: string[], statement: string) {
  services.length = 0;
  try {
    const result = await provider.queryReadOnly(statement, BUDGET);
    const counts: Record<string, number> = {};
    for (const service of services) counts[service] = (counts[service] ?? 0) + 1;
    return {
      statement,
      services: counts,
      rowCount: result.rowCount,
      fields: result.fields,
      rows: result.rows.slice(0, 12).map((row) => {
        const kept: Record<string, unknown> = {};
        for (const field of ["nodeId", "statusCode", "shape", "units", "unitId", "unitNamespace", "euRange"])
          if (field in row) kept[field] = row[field];
        for (const field of ["browseName", "nodeClass", "referenceTypeId"]) if (field in row) kept[field] = row[field];
        return kept;
      }),
      warnings: result.warnings?.map((warning) => warning.message) ?? [],
    };
  } catch (error) {
    return {
      statement,
      services: services.filter((service) => service !== "open" && service !== "close").length,
      refused: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

/** Values that must not move when the agent reads, read raw before and after. */
async function stateOf(port: number) {
  const raw = await rawSession(port, "anonymous");
  try {
    const ids = [ANALOG, "ns=3;s=FastNumberOfUpdates", "ns=3;s=SlowNumberOfUpdates", "i=2259"];
    const values = await raw.session.read(ids.map((nodeId) => ({ nodeId, attributeId: AttributeIds.Value })));
    const sessions = await raw.session.read({ nodeId: "i=2277", attributeId: AttributeIds.Value });
    return {
      values: Object.fromEntries(ids.map((id, at) => [id, String(values[at]?.value?.value)])),
      // One session is this reading's own.
      currentSessionCount: sessions.statusCode.name === "Good" ? Number(sessions.value.value) - 1 : "unavailable",
    };
  } finally {
    await raw.close();
  }
}

const capture: Record<string, unknown> = {
  measured: DATE,
  server:
    "Microsoft OPC PLC 2.15.10 by digest (sha256:28bbdaa2e8781fe3b8bda1bbd2d4ebe0ad5bcb1fbb83f69c74b8a92efa7fe75c), started as tests/fixtures/opcua/README.md starts it; a second container adds a non-privileged user and an administrator",
  budget: BUDGET,
};

try {
  // What the withheld nodes answer read raw, with no agent path in between.
  capture.withheldRaw = {
    anonymous: await withheldRaw(ANON_PORT, "anonymous"),
    user: await withheldRaw(USERS_PORT, "user"),
    administrator: await withheldRaw(USERS_PORT, "administrator"),
  };
  capture.standardDescendantsRaw = {
    anonymous: await standardDescendantsRaw(ANON_PORT, "anonymous"),
    user: await standardDescendantsRaw(USERS_PORT, "user"),
    administrator: await standardDescendantsRaw(USERS_PORT, "administrator"),
  };
  capture.sessionDiagnostics = await sessionDiagnosticsCarryIdentity(USERS_PORT);
  const telemetry = await telemetryNamespace(ANON_PORT);

  // A raw Write of a variable's own value, and a raw Call, on the capture's own anonymous client.
  {
    const raw = await rawSession(ANON_PORT, "anonymous");
    try {
      const before = await raw.session.read({ nodeId: ANALOG, attributeId: AttributeIds.Value });
      const written = await raw.session.write({
        nodeId: ANALOG,
        attributeId: AttributeIds.Value,
        value: { value: { dataType: before.value.dataType, value: before.value.value } },
      });
      const after = await raw.session.read({ nodeId: ANALOG, attributeId: AttributeIds.Value });
      const called = await raw.session.call({
        objectId: "i=2253",
        methodId: "i=11492",
        inputArguments: [{ dataType: DataType.UInt32, value: 0 }],
      });
      const resetExecutable = await raw.session.read({ nodeId: "i=25709", attributeId: AttributeIds.UserExecutable });
      capture.rawWrite = {
        nodeId: ANALOG,
        what: "the variable's own value written back, by the capture script and never by Studio",
        status: written.name,
        valueUnchanged: String(before.value.value) === String(after.value.value),
      };
      capture.rawCall = {
        method: "Server.GetMonitoredItems (i=11492) for subscription 0, by the capture script and never by Studio",
        status: called.statusCode.name,
        resetToServerDefaultsUserExecutable: resetExecutable.value.value,
      };
    } finally {
      await raw.close();
    }
  }

  const stateBefore = await stateOf(ANON_PORT);

  // The agent path, anonymous, on the fixture as documented.
  const services: string[] = [];
  const anonymous = await agentHandle(ANON_PORT, "anonymous", services);
  const reads = [];
  for (const statement of [
    JSON.stringify({ read: [ANALOG, PLAIN] }),
    JSON.stringify({ read: ["i=12637", "i=15606", "i=3706", "i=2256"] }),
    JSON.stringify({ read: ["i=12642", "i=16192", "i=2255"] }),
    JSON.stringify({ read: [`nsu=${telemetry};s=SlowUInt1`] }),
    JSON.stringify({ read: ["nsu=urn:not-on-this-server;s=SlowUInt1"] }),
    JSON.stringify({ browse: "i=15644" }),
    JSON.stringify({ browse: "i=85" }),
    JSON.stringify({ browse: "i=2253" }),
    JSON.stringify({ browse: "i=2268" }),
    JSON.stringify({ browse: "i=2274" }),
    JSON.stringify({ browse: "i=14443" }),
    JSON.stringify({ history: HISTORIAN, limit: 5 }),
    JSON.stringify({ history: HISTORIAN }),
    JSON.stringify({ history: PLAIN }),
    JSON.stringify({ browse: "i=12637" }),
    JSON.stringify({ write: ANALOG, value: 1 }),
    JSON.stringify({ read: [ANALOG], indexRange: "0:1" }),
  ])
    reads.push(await agentRead(anonymous, services, statement));
  capture.agentAnonymous = reads;
  await anonymous.disconnect();

  // The agent path as the administrator, who can browse the session diagnostics: a per-session node, named by the id
  // the server chose for it, is answered withheld and never sent.
  const held = await aSessionNode(USERS_PORT);
  try {
    const adminServices: string[] = [];
    const administrator = await agentHandle(USERS_PORT, "administrator", adminServices);
    capture.agentAdministrator = {
      perSessionRead: await agentRead(administrator, adminServices, JSON.stringify({ read: [held.id, PLAIN] })).then(
        (answer) =>
          "rows" in answer && answer.rows !== undefined
            ? {
                ...answer,
                rows: answer.rows.map((row) =>
                  row.nodeId === held.id ? { ...row, nodeId: "<per-session node>" } : row,
                ),
                statement: answer.statement.replace(held.id, "<per-session node>"),
              }
            : answer,
      ),
      perSessionBrowse: await agentRead(administrator, adminServices, JSON.stringify({ browse: held.id })).then(
        (answer) => ({
          ...answer,
          statement: answer.statement.replace(held.id, "<per-session node>"),
        }),
      ),
      perSessionHistory: await agentRead(administrator, adminServices, JSON.stringify({ history: held.id })).then(
        (answer) => ({ ...answer, statement: answer.statement.replace(held.id, "<per-session node>") }),
      ),
    };
    await administrator.disconnect();
  } finally {
    await held.close();
  }

  const stateAfter = await stateOf(ANON_PORT);
  capture.serverState = {
    before: stateBefore,
    after: stateAfter,
    configurationUnchanged:
      stateBefore.values["ns=3;s=FastNumberOfUpdates"] === stateAfter.values["ns=3;s=FastNumberOfUpdates"] &&
      stateBefore.values["ns=3;s=SlowNumberOfUpdates"] === stateAfter.values["ns=3;s=SlowNumberOfUpdates"] &&
      stateBefore.values[ANALOG] === stateAfter.values[ANALOG],
    sessionsLeftBehind:
      typeof stateBefore.currentSessionCount === "number" && typeof stateAfter.currentSessionCount === "number"
        ? stateAfter.currentSessionCount - stateBefore.currentSessionCount
        : "unavailable",
  };

  const text = `${JSON.stringify(capture, (_key, value) => (typeof value === "bigint" ? String(value) : value), 2)}\n`;
  // No credential and no name of this host in the capture, in any spelling the script can see.
  for (const forbidden of [USER_SECRET, ADMIN_SECRET, hostname()])
    if (forbidden !== "" && text.includes(forbidden)) throw new Error("the capture holds a value it must not hold");
  if (/"(probe-user|probe-admin)"/.test(text)) throw new Error("the capture holds an account name as a value");
  writeFileSync(join(OUT, "boundary.json"), text);
  console.log(`wrote ${join(OUT, "boundary.json")}`);
} finally {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
}
