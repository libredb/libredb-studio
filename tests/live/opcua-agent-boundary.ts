/**
 * Runs the OPC UA agent's own reads through the provider, beneath read roots, against the two OPC PLC 2.15.10
 * containers that tests/fixtures/opcua/2.15.10/agent-boundary/run.sh started, sends a raw Write and a raw Call on a
 * client of its own, and writes what it measured into that run.sh's directory as boundary.json.
 *
 *   sh tests/fixtures/opcua/2.15.10/agent-boundary/run.sh
 *
 * The environment names the fixture: OPCUA_AGENT_ANON_PORT (the fixture as tests/fixtures/opcua/README.md starts it),
 * OPCUA_AGENT_USERS_PORT (the same with a user and an administrator), OPCUA_AGENT_OUT (the directory to write) and the
 * two passwords run.sh generated, OPCUA_AGENT_USER_SECRET and OPCUA_AGENT_ADMIN_SECRET.
 *
 * What it records, for the anonymous, the non-privileged and the administrator identity, each over a handle whose read
 * roots are the Telemetry folder (namespace 3), the DataAccess folder (namespace 6, its URI read from the fixture's own
 * NamespaceArray) and Server.ServerStatus: the walk's request count and time, a value read with its units, a history
 * read, a browse of a member, of the Objects folder and of a namespace-0 root, and, for every read kind, an id outside
 * the roots beside a missing twin, compared by their answers and by every request each sent; for the administrator, a
 * session object the server shows it, compared the same way; the walk over wider and narrower root lists, which are
 * the request counts the walk's bound is set against; and that a statement profile without roots opens no session.
 *
 * The capture records no credential value at all: a request list is compared, never written, and before anything is
 * written the whole capture is checked for both passwords, the two account names in a value position and this host's
 * name, and the script stops if any is there. The raw Write and the Call go through `node-opcua-client` directly, never
 * through the agent path: the Write sends the variable's own value back, and the Call asks `GetMonitoredItems` about a
 * subscription that does not exist. The server's values are read before and after the agent's reads, and so is its
 * session count.
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
const PKI_ROOTS: string[] = [];
const pkiRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "opcua-agent-pki-"));
  PKI_ROOTS.push(root);
  return root;
};

const ANALOG = "ns=6;s=DataAccess_AnalogType_Int32";
const PLAIN = "ns=3;s=SlowUInt1";
const HISTORIAN = "ns=3;s=HistorianInt32";
/** The missing twin every outside id is compared with: an id in the process namespace the server does not hold. */
const MISSING = "ns=3;s=NoSuchNodeAtAll";
/**
 * Ids the server holds outside the read roots: the server's configuration, the session diagnostics summary and its
 * array, the Server object, the folder above Telemetry, a node of namespaces 2 and 4, and RoleSet.
 */
const OUTSIDE = ["i=12637", "i=3706", "i=3707", "i=2253", "ns=3;s=OpcPlc", "ns=2;i=5001", "ns=4;i=5", "i=15606"];

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

/** The fixture's NamespaceArray, read raw; entry 1 names the host and is never written. */
async function namespaceTable(port: number): Promise<readonly string[]> {
  const raw = await rawSession(port, "anonymous");
  try {
    const table = await raw.session.read({ nodeId: "i=2255", attributeId: AttributeIds.Value });
    const value = table.value.value as string[] | null;
    if (!Array.isArray(value) || value.length < 7) throw new Error("the fixture's namespace table is short");
    return value;
  } finally {
    await raw.close();
  }
}

/** A per-session node id the administrator is shown, which the server chose, held only in memory. */
async function aSessionNode(port: number): Promise<{ id: string; close: () => Promise<void> }> {
  const raw = await rawSession(port, "administrator");
  const summary = await browseRaw(raw.session, "i=3706");
  const first = summary.references?.[0];
  if (first === undefined) throw new Error("the administrator saw no session under i=3706");
  return { id: first.nodeId.toString(), close: raw.close };
}

/** Every request the agent path asked of the session, by service and the node ids it named, in order. */
function recordingOpener(requests: string[]) {
  return async (options: OpcuaConnectionOptions): Promise<OpcuaReadOnlyClient> => {
    const session = await openLibrarySession(options);
    requests.push("open");
    return new Proxy(session, {
      get(target, property, receiver) {
        const member = Reflect.get(target, property, receiver);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          const [first, second] = args;
          const named = Array.isArray(first)
            ? first.every((id) => typeof id === "string")
              ? ` ${first.join(",")}`
              : ` ${first.length}`
            : typeof first === "object" && first !== null && "nodeId" in first
              ? ` ${String((first as { nodeId: unknown }).nodeId)}`
              : "";
          requests.push(`${String(property)}${second === "facts" ? ":facts" : ""}${named}`);
          return (member as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  };
}

function connection(port: number, who: Who, roots: readonly string[] | undefined): DatabaseConnection {
  const identity = identities[who];
  return {
    id: `agent-${who}`,
    name: `agent-${who}`,
    type: "opcua",
    host: `opc.tcp://127.0.0.1:${port}/`,
    ...(identity.userName === undefined ? {} : { user: identity.userName, password: identity.password }),
    ...(roots === undefined ? {} : { agentReadRoots: roots }),
  } as never;
}

/**
 * An agent-mode handle over the given read roots. A user token is encrypted with the server's certificate, which
 * Studio's strict store does not trust until a reader moves it from `rejected` into `trusted/certs`, as
 * docs/providers/opcua.md section 4.4 says; the capture does exactly that once, the way a reader would.
 */
async function agentHandle(port: number, who: Who, roots: readonly string[], requests: string[]) {
  const root = pkiRoot();
  const open = () =>
    new OpcuaProvider(connection(port, who, roots), {}, AGENT, recordingOpener(requests), {
      [OPCUA_PKI_ROOT_ENV]: root,
    });
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

/** One agent read: its answer as text and every request it sent, each with `id` put back to one spelling. */
async function exchange(provider: OpcuaProvider, requests: string[], statement: string, id?: string) {
  requests.length = 0;
  const answer = await provider.queryReadOnly(statement, BUDGET).then(
    (result) => JSON.stringify({ ...result, executionTime: 0 }),
    (error: Error) => `${error.name}: ${error.message}`,
  );
  const spelled = (text: string) => (id === undefined ? text : text.replaceAll(id, "<id>"));
  return { answer: spelled(answer), requests: requests.map(spelled) };
}

const WALK_SERVICES = ["browse", "browseNext", "read:facts"];
const isWalk = (request: string): boolean => WALK_SERVICES.includes(request.split(" ")[0] as string);

/** One agent read, recorded as what it answered, how many requests of each service it sent, and how long it took. */
async function agentRead(provider: OpcuaProvider, requests: string[], statement: string) {
  requests.length = 0;
  const started = performance.now();
  try {
    const result = await provider.queryReadOnly(statement, BUDGET);
    const services: Record<string, number> = {};
    for (const request of requests) {
      const service = request.split(" ")[0] as string;
      services[service] = (services[service] ?? 0) + 1;
    }
    return {
      statement,
      services,
      walkRequests: requests.filter(isWalk).length,
      ms: Math.round(performance.now() - started),
      rowCount: result.rowCount,
      fields: result.fields,
      rows: result.rows.slice(0, 12).map((row) => {
        const kept: Record<string, unknown> = {};
        for (const field of [
          "nodeId",
          "statusCode",
          "shape",
          "units",
          "unitId",
          "unitNamespace",
          "euRange",
          "browseName",
          "nodeClass",
          "referenceTypeId",
        ])
          if (field in row) kept[field] = row[field];
        return kept;
      }),
      warnings: result.warnings?.map((warning) => warning.message) ?? [],
    };
  } catch (error) {
    return {
      statement,
      sent: requests.filter((request) => request !== "open" && request !== "close").length,
      refused: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

const KINDS = {
  read: (id: string) => JSON.stringify({ read: [id] }),
  history: (id: string) => JSON.stringify({ history: id }),
  browse: (id: string) => JSON.stringify({ browse: id }),
} as const;

/**
 * Each id beside the missing twin, for every read kind: how many pairs answered byte for byte alike and sent the same
 * requests in the same order, and how many requests any of them sent naming the id itself. Recorded as counts only.
 */
async function alikeWithMissing(provider: OpcuaProvider, requests: string[], ids: readonly string[]) {
  const answers: Record<string, unknown> = {};
  for (const [kind, statement] of Object.entries(KINDS)) {
    const missing = await exchange(provider, requests, statement(MISSING), MISSING);
    let answersAlike = 0;
    let requestsAlike = 0;
    let requestsNamingTheId = 0;
    for (const id of ids) {
      const outside = await exchange(provider, requests, statement(id), id);
      if (outside.answer === missing.answer) answersAlike += 1;
      if (JSON.stringify(outside.requests) === JSON.stringify(missing.requests)) requestsAlike += 1;
      requestsNamingTheId += outside.requests.filter((request) => request.includes("<id>")).length;
    }
    answers[kind] = {
      pairs: ids.length,
      answersAlike,
      requestsAlike,
      requestsNamingTheId,
      missingAnswer: missing.answer.slice(0, 200),
      missingWalkRequests: missing.requests.filter(isWalk).length,
    };
  }
  return answers;
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

/** What one identity's agent reads answer beneath the roots. */
async function identityReads(port: number, who: Who, roots: readonly string[], telemetry: string) {
  const requests: string[] = [];
  const provider = await agentHandle(port, who, roots, requests);
  try {
    const walk = await agentRead(provider, requests, JSON.stringify({ browse: "i=85" }));
    const reads = [];
    for (const statement of [
      JSON.stringify({ read: [ANALOG, PLAIN] }),
      JSON.stringify({ read: [`nsu=${telemetry};s=SlowUInt1`] }),
      JSON.stringify({ history: HISTORIAN, limit: 5 }),
      JSON.stringify({ history: HISTORIAN }),
      JSON.stringify({ history: PLAIN }),
      JSON.stringify({ browse: "ns=3;s=Telemetry" }),
      JSON.stringify({ browse: "i=2256" }),
      JSON.stringify({ browse: "i=2260" }),
      JSON.stringify({ write: ANALOG, value: 1 }),
      JSON.stringify({ read: [ANALOG], indexRange: "0:1" }),
    ])
      reads.push(await agentRead(provider, requests, statement));
    return { walk, reads, outsideBesideMissing: await alikeWithMissing(provider, requests, OUTSIDE) };
  } finally {
    await provider.disconnect();
  }
}

const capture: Record<string, unknown> = {
  measured: DATE,
  server:
    "Microsoft OPC PLC 2.15.10 by digest (sha256:28bbdaa2e8781fe3b8bda1bbd2d4ebe0ad5bcb1fbb83f69c74b8a92efa7fe75c), started as tests/fixtures/opcua/README.md starts it; a second container adds a non-privileged user and an administrator",
  budget: BUDGET,
};

try {
  const table = await namespaceTable(ANON_PORT);
  const telemetry = table[3] as string;
  const dataAccess = table[6] as string;
  const ROOT_LIST = [`nsu=${telemetry};s=Telemetry`, `nsu=${dataAccess};s=DataAccess`, "i=2256"];
  capture.namespaces = { 3: telemetry, 6: dataAccess };
  capture.roots = ROOT_LIST;
  capture.outside = OUTSIDE;
  capture.missingTwin = MISSING;

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

  // A statement profile on a connection that declares no roots opens no session.
  {
    let opened = 0;
    const rootless = new OpcuaProvider(
      connection(ANON_PORT, "anonymous", undefined),
      {},
      AGENT,
      async () => {
        opened += 1;
        throw new Error("a rootless statement profile reached the opener");
      },
      { [OPCUA_PKI_ROOT_ENV]: pkiRoot() },
    );
    const refused = await rootless.connect().then(
      () => "opened",
      (error: Error & { reasonCode?: string }) => `${error.reasonCode}: ${error.message}`,
    );
    capture.withoutRoots = { refused, sessionsOpened: opened };
  }

  // The agent path beneath the roots, as each identity.
  capture.agent = {
    anonymous: await identityReads(ANON_PORT, "anonymous", ROOT_LIST, telemetry),
    user: await identityReads(USERS_PORT, "user", ROOT_LIST, telemetry),
    administrator: await identityReads(USERS_PORT, "administrator", ROOT_LIST, telemetry),
  };

  // A session object the server shows the administrator, named by the id the server chose: answered as missing.
  const held = await aSessionNode(USERS_PORT);
  try {
    const requests: string[] = [];
    const administrator = await agentHandle(USERS_PORT, "administrator", ROOT_LIST, requests);
    try {
      capture.administratorSessionObject = await alikeWithMissing(administrator, requests, [held.id]);
    } finally {
      await administrator.disconnect();
    }
  } finally {
    await held.close();
  }

  // The walk over wider and narrower root lists: the request counts the walk's bound is set against.
  const walks: Record<string, unknown> = {};
  for (const [name, roots] of [
    ["Telemetry", [`nsu=${telemetry};s=Telemetry`]],
    ["DataAccess", [`nsu=${dataAccess};s=DataAccess`]],
    ["the three roots", ROOT_LIST],
    ["the OpcPlc folder", [`nsu=${telemetry};s=OpcPlc`]],
    ["every namespace-0 table root", ["i=2256", "i=11704", "i=2275", "i=2255", "i=2254", "i=2267", "i=2994"]],
  ] as const) {
    const requests: string[] = [];
    const provider = await agentHandle(ANON_PORT, "anonymous", roots, requests);
    try {
      const walk = await agentRead(provider, requests, JSON.stringify({ browse: "i=85" }));
      walks[name] =
        "refused" in walk
          ? { refused: walk.refused, sent: walk.sent }
          : { walkRequests: walk.walkRequests, services: walk.services, ms: walk.ms, roots: walk.rowCount };
    } finally {
      await provider.disconnect();
    }
  }
  capture.walks = walks;

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
  for (const forbidden of [USER_SECRET, ADMIN_SECRET, hostname(), table[1] ?? ""])
    if (forbidden !== "" && text.includes(forbidden)) throw new Error("the capture holds a value it must not hold");
  if (text.includes('"probe-user"') || text.includes('"probe-admin"'))
    throw new Error("the capture holds an account name as a value");
  writeFileSync(join(OUT, "boundary.json"), text);
  console.log(`wrote ${join(OUT, "boundary.json")}`);
} finally {
  for (const root of PKI_ROOTS) rmSync(root, { recursive: true, force: true });
}
