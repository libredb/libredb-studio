/**
 * The MongoDB agent boundary (issue #1614), over documents the servers themselves answered.
 *
 * `fixtures/` holds `buildInfo` and `connectionStatus` replies captured on 2026-10-17 from MongoDB 9.0.4, 8.3.11 and
 * 7.0.43 with authorization on, 9.0.4 with it off, and FerretDB 2.7.0, each beside the command that drew it and the
 * principal it ran as (the matrix principals were created for the capture and dropped after it). The two pure checks
 * are held to those documents, so a check that drifts from what a server answers is a red test here; and the
 * verification is driven through a client that answers each command from them, so the order of the commands, what
 * each carries and which refusal ends the open are pinned with no server.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Document, MongoClient } from "mongodb";
import { ExecutionProfileError } from "@/lib/db/errors";
import {
  AGENT_VERIFY_MAX_TIME_MS,
  MONGO_AGENT_READ_ACTIONS,
  agentHostsOf,
  assertAgentEngineIsAdmissible,
  assertAgentPrivilegesAreReadOnly,
  probeServerEnforcesAuthorization,
  verifyAgentProfile,
} from "@/lib/db/providers/document/mongodb/agent-boundary";
import { AGENT_COMMAND_COMMENT } from "@/lib/db/providers/document/mongodb/agent-read";

/** One captured reply, by its fixture name. */
function fixture(name: string): Document {
  const text = readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8");
  return (JSON.parse(text) as { reply: Document }).reply;
}

const BUILD_INFO = {
  "9.0.4": fixture("buildinfo-9.0.4"),
  "8.3.11": fixture("buildinfo-8.3.11"),
  "7.0.43": fixture("buildinfo-7.0.43"),
};
const FERRETDB = fixture("buildinfo-ferretdb-2.7.0");
const LIBREDB_AGENT = {
  "9.0.4": fixture("connection-status-libredb-agent-9.0.4"),
  "8.3.11": fixture("connection-status-libredb-agent-8.3.11"),
  "7.0.43": fixture("connection-status-libredb-agent-7.0.43"),
};
const HOSTS = ["127.0.0.1"];

/** The refusal `run` raises, held to its class and its code. */
function refusal(run: () => unknown, reasonCode: string): ExecutionProfileError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ExecutionProfileError);
  expect((caught as ExecutionProfileError).reasonCode).toBe(reasonCode as ExecutionProfileError["reasonCode"]);
  return caught as ExecutionProfileError;
}

/** A status of one user holding exactly `privileges`. */
const holding = (privileges: unknown): Document => ({
  authInfo: {
    authenticatedUsers: [{ user: "someone", db: "app" }],
    authenticatedUserRoles: [],
    authenticatedUserPrivileges: privileges,
  },
  ok: 1,
});

const READ_ACTIONS = [...MONGO_AGENT_READ_ACTIONS];

/** `document` without `keys`. */
const without = (document: Document, ...keys: string[]): Document =>
  Object.fromEntries(Object.entries(document).filter(([key]) => !keys.includes(key)));

describe("assertAgentEngineIsAdmissible", () => {
  test("admits the measured MongoDB 9.0.4, 8.3.11 and 7.0.43", () => {
    for (const buildInfo of Object.values(BUILD_INFO)) {
      expect(() => assertAgentEngineIsAdmissible(buildInfo, HOSTS)).not.toThrow();
    }
  });

  test("refuses the measured FerretDB 2.7.0 by the name it answers", () => {
    const error = refusal(() => assertAgentEngineIsAdmissible(FERRETDB, HOSTS), "PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toContain("identifies itself as FerretDB");
  });

  test("refuses a server that names itself Percona Server for MongoDB or Atlas Data Federation", () => {
    const percona = { ...BUILD_INFO["9.0.4"], psmdbVersion: "8.0.4-1" };
    expect(
      refusal(() => assertAgentEngineIsAdmissible(percona, HOSTS), "PROFILE_UNSUPPORTED_TARGET").message,
    ).toContain("identifies itself as Percona Server for MongoDB");
    const federation = { ...BUILD_INFO["9.0.4"], dataLake: { version: "v20260101" } };
    expect(
      refusal(() => assertAgentEngineIsAdmissible(federation, HOSTS), "PROFILE_UNSUPPORTED_TARGET").message,
    ).toContain("identifies itself as Atlas Data Federation");
  });

  test("refuses a host that is a DocumentDB, Cosmos DB or Firestore endpoint, whatever buildInfo answers", () => {
    const cases: [string, string][] = [
      ["cluster.cluster-x.us-east-1.docdb.amazonaws.com", "Amazon DocumentDB"],
      ["elastic.us-east-1.docdb-elastic.amazonaws.com", "Amazon DocumentDB"],
      ["acct.mongo.cosmos.azure.com", "Azure Cosmos DB"],
      ["C1.MONGOCLUSTER.COSMOS.AZURE.COM", "Azure Cosmos DB"],
      ["db.europe-west1.firestore.goog", "Firestore"],
    ];
    for (const [host, server] of cases) {
      const error = refusal(
        () => assertAgentEngineIsAdmissible(BUILD_INFO["9.0.4"], ["127.0.0.1", host]),
        "PROFILE_UNSUPPORTED_TARGET",
      );
      expect(error.message).toContain(host);
      expect(error.message).toContain(server);
    }
    // A name only matches as a whole label: these are other hosts.
    expect(() =>
      assertAgentEngineIsAdmissible(BUILD_INFO["9.0.4"], [
        "docdb.amazonaws.com.example.net",
        "mycosmos.azure.community",
      ]),
    ).not.toThrow();
  });

  test("refuses a buildInfo that fails one stable field of the positive shape", () => {
    const genuine = BUILD_INFO["9.0.4"];
    const shapes: Document[] = [
      { ...genuine, version: "x.y" },
      { ...genuine, versionArray: [9, 0, 5, 0] },
      without(genuine, "versionArray"),
      { ...genuine, storageEngines: ["inMemory"] },
      without(genuine, "storageEngines"),
      without(genuine, "version"),
    ];
    for (const buildInfo of shapes) {
      expect(
        refusal(() => assertAgentEngineIsAdmissible(buildInfo, HOSTS), "PROFILE_UNSUPPORTED_TARGET").message,
      ).toContain("does not answer the shape a MongoDB answers");
    }
  });

  test("reads none of allocator, javascriptEngine and gitVersion: their values change between releases", () => {
    const stable = without(BUILD_INFO["9.0.4"], "allocator", "javascriptEngine", "gitVersion");
    expect(() => assertAgentEngineIsAdmissible(stable, HOSTS)).not.toThrow();
    expect(() =>
      assertAgentEngineIsAdmissible({ ...BUILD_INFO["9.0.4"], allocator: "system", javascriptEngine: "none" }, HOSTS),
    ).not.toThrow();
  });
});

describe("assertAgentPrivilegesAreReadOnly", () => {
  test("the read actions are exactly what the read role answered on 9.0.4, 8.3.11 and 7.0.43", () => {
    const measured = new Set<string>();
    for (const status of Object.values(LIBREDB_AGENT)) {
      for (const privilege of status.authInfo.authenticatedUserPrivileges as { actions: string[] }[]) {
        for (const action of privilege.actions) measured.add(action);
      }
    }
    expect(READ_ACTIONS.sort()).toEqual([...measured].sort());
    // 7.0.43 answers one fewer: performRawDataOperations is newer than it.
    const seven = (LIBREDB_AGENT["7.0.43"].authInfo.authenticatedUserPrivileges as { actions: string[] }[])[0];
    expect(seven.actions).not.toContain("performRawDataOperations");
  });

  test("admits the seeded read user on 9.0.4, 8.3.11 and 7.0.43, and a read user on another bound database", () => {
    for (const status of Object.values(LIBREDB_AGENT)) {
      expect(() => assertAgentPrivilegesAreReadOnly(status, "app")).not.toThrow();
    }
    expect(() => assertAgentPrivilegesAreReadOnly(fixture("connection-status-read-9.0.4"), "rv_p6_db")).not.toThrow();
  });

  test("the bound database decides: the same read privileges on another database are refused", () => {
    const error = refusal(
      () => assertAgentPrivilegesAreReadOnly(LIBREDB_AGENT["9.0.4"], "reporting"),
      "PROFILE_PRIVILEGES_TOO_BROAD",
    );
    expect(error.message).toContain('"changeStream" on {"db":"app","collection":""}');
    expect(error.message).toContain('outside the database "reporting"');
  });

  test("refuses each measured principal holding more than read, naming the first privilege past it", () => {
    const cases: [string, string, string][] = [
      [
        "connection-status-read-plus-backup-9.0.4",
        '"find" on {"db":"local","collection":"replset.election"}',
        "outside",
      ],
      [
        "connection-status-read-plus-find-system-users-9.0.4",
        '"find" on {"db":"admin","collection":"system.users"}',
        "outside",
      ],
      [
        "connection-status-read-plus-user-admin-9.0.4",
        '"changeCustomData" on {"db":"rv_p6_db","collection":""}',
        "not a read",
      ],
      [
        "connection-status-read-plus-readwrite-other-9.0.4",
        '"changeStream" on {"db":"rv_p6_other","collection":""}',
        "outside",
      ],
      [
        "connection-status-read-plus-insert-one-collection-9.0.4",
        '"insert" on {"db":"rv_p6_db","collection":"seed"}',
        "not a read",
      ],
      [
        "connection-status-read-two-databases-9.0.4",
        '"changeStream" on {"db":"rv_p6_other","collection":""}',
        "outside",
      ],
      ["connection-status-read-any-database-9.0.4", '"listDatabases" on {"cluster":true}', "outside"],
      ["connection-status-root-9.0.4", '"analyze" on {"system_buckets":""}', "outside"],
    ];
    for (const [name, held, why] of cases) {
      const error = refusal(
        () => assertAgentPrivilegesAreReadOnly(fixture(name), "rv_p6_db"),
        "PROFILE_PRIVILEGES_TOO_BROAD",
      );
      expect(error.message).toContain(`this session holds ${held}`);
      expect(error.message).toContain(why);
    }
  });

  test("a system collection of the bound database is refused, except system.js", () => {
    const systemUsers = holding([{ resource: { db: "app", collection: "system.users" }, actions: ["find"] }]);
    expect(
      refusal(() => assertAgentPrivilegesAreReadOnly(systemUsers, "app"), "PROFILE_PRIVILEGES_TOO_BROAD").message,
    ).toContain("a collection the server keeps for itself");
    const systemJs = holding([{ resource: { db: "app", collection: "system.js" }, actions: ["find"] }]);
    expect(() => assertAgentPrivilegesAreReadOnly(systemJs, "app")).not.toThrow();
  });

  test("an action the profile does not recognise is a refusal, not an admission", () => {
    const status = holding([{ resource: { db: "app", collection: "" }, actions: ["find", "someFutureAction"] }]);
    expect(
      refusal(() => assertAgentPrivilegesAreReadOnly(status, "app"), "PROFILE_PRIVILEGES_TOO_BROAD").message,
    ).toContain('"someFutureAction" on {"db":"app","collection":""}, which is not a read');
  });

  test("a resource that is not one collection of the bound database is refused, whatever its shape", () => {
    const resources: Document[] = [
      { db: "", collection: "" },
      { db: "", collection: "orders" },
      { cluster: true },
      { anyResource: true },
      { system_buckets: "" },
      { db: "app" },
      { db: "app", collection: "", extra: true },
      { db: "app", collection: 7 },
    ];
    for (const resource of resources) {
      refusal(
        () => assertAgentPrivilegesAreReadOnly(holding([{ resource, actions: ["find"] }]), "app"),
        "PROFILE_PRIVILEGES_TOO_BROAD",
      );
    }
  });

  test("privileges it cannot read leave the boundary unproven, and that is a refusal", () => {
    const unreadable: Document[] = [
      // FerretDB's authenticated answer carries no privileges at all.
      { authInfo: { authenticatedUsers: [{ user: "postgres" }], authenticatedUserRoles: [] }, ok: 1 },
      { ok: 1 },
      holding("all"),
      holding([{ resource: { db: "app", collection: "" } }]),
      holding([{ resource: { db: "app", collection: "" }, actions: "find" }]),
      holding([null]),
    ];
    for (const status of unreadable) {
      expect(
        refusal(() => assertAgentPrivilegesAreReadOnly(status, "app"), "PROFILE_PRIVILEGES_TOO_BROAD").message,
      ).toContain("could not read this session's privileges");
    }
  });

  test("a user holding no privilege at all is too narrow, not too broad (measured: an empty list)", () => {
    const error = refusal(
      () => assertAgentPrivilegesAreReadOnly(fixture("connection-status-no-roles-9.0.4"), "rv_p6_db"),
      "PROFILE_PRIVILEGES_TOO_NARROW",
    );
    expect(error.message).toContain("holds no privilege at all");
  });
});

interface SentCommand {
  readonly database: string;
  readonly command: Document;
}

/** A client that answers each command by its name, from `replies`, and records what it was sent. */
function scriptedClient(
  replies: Record<string, Document | Error>,
  options: Document = { hosts: [{ host: "127.0.0.1", port: 27017 }] },
) {
  const sent: SentCommand[] = [];
  const client = {
    options,
    db: (database: string) => ({
      command: async (command: Document) => {
        sent.push({ database, command });
        const name = Object.keys(command)[0];
        const reply = replies[name];
        if (reply === undefined) throw new Error(`the client was sent ${name}, which this test does not answer`);
        if (reply instanceof Error) throw reply;
        return reply;
      },
      collection: () => {
        throw new Error("the verification reached a collection method");
      },
    }),
  } as unknown as MongoClient;
  return { client, sent, names: () => sent.map(({ command }) => Object.keys(command)[0]) };
}

const serverError = (code: number, message: string): Error =>
  Object.assign(new Error(message), { code, name: "MongoServerError" });
const UNAUTHORIZED = serverError(13, "not authorized on app to execute command { delete: ... }");
const VERIFY = { maxTimeMS: AGENT_VERIFY_MAX_TIME_MS, hosts: HOSTS };

/** The refusal `verifyAgentProfile` raises, held to its class and its code. */
async function verifyRefusal(client: MongoClient, reasonCode: string): Promise<ExecutionProfileError> {
  const caught = await verifyAgentProfile(client, "app", VERIFY).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(ExecutionProfileError);
  expect((caught as ExecutionProfileError).reasonCode).toBe(reasonCode as ExecutionProfileError["reasonCode"]);
  return caught as ExecutionProfileError;
}

describe("verifyAgentProfile", () => {
  test("admits the read user: buildInfo, then its privileges, then a probe that changes nothing, each bounded", async () => {
    const { client, sent, names } = scriptedClient({
      buildInfo: BUILD_INFO["9.0.4"],
      connectionStatus: LIBREDB_AGENT["9.0.4"],
      delete: UNAUTHORIZED,
    });
    await verifyAgentProfile(client, "app", VERIFY);
    expect(names()).toEqual(["buildInfo", "connectionStatus", "delete"]);
    expect(sent.map(({ database }) => database)).toEqual(["app", "app", "app"]);
    for (const { command } of sent) {
      expect(command.maxTimeMS).toBe(AGENT_VERIFY_MAX_TIME_MS);
      expect(command.comment).toBe(AGENT_COMMAND_COMMENT);
    }
    expect(sent[1].command).toMatchObject({ connectionStatus: 1, showPrivileges: true });
    const probe = sent[2].command;
    expect(Object.keys(probe)).toEqual(["delete", "deletes", "writeConcern", "maxTimeMS", "comment"]);
    expect(probe.delete).toBe("libredb_agent_probe");
    expect(probe.writeConcern).toEqual({ w: 1 });
    // One delete of one _id no document can hold: a fresh ObjectId, at most one match.
    const [deletion] = probe.deletes as { q: { _id: { _bsontype?: string } }; limit: number }[];
    expect((probe.deletes as unknown[]).length).toBe(1);
    expect(deletion.limit).toBe(1);
    expect(Object.keys(deletion.q)).toEqual(["_id"]);
    expect(deletion.q._id._bsontype).toBe("ObjectId");
  });

  test("an over-broad user is refused on its privileges, and no probe is sent", async () => {
    const { client, names } = scriptedClient({
      buildInfo: BUILD_INFO["9.0.4"],
      connectionStatus: fixture("connection-status-root-9.0.4"),
    });
    await verifyRefusal(client, "PROFILE_PRIVILEGES_TOO_BROAD");
    expect(names()).toEqual(["buildInfo", "connectionStatus"]);
  });

  test("a server that accepts the probe does not enforce authorization, with the read user's credentials or none", async () => {
    for (const status of [
      fixture("connection-status-no-auth-libredb-agent-9.0.4"),
      fixture("connection-status-no-auth-anonymous-9.0.4"),
    ]) {
      const { client, names } = scriptedClient({
        buildInfo: BUILD_INFO["9.0.4"],
        connectionStatus: status,
        delete: { n: 0, ok: 1 },
      });
      const error = await verifyRefusal(client, "PROFILE_SERVER_UNENFORCED");
      expect(error.message).toContain("does not enforce authorization");
      expect(names()).toEqual(["buildInfo", "connectionStatus", "delete"]);
    }
  });

  test("a connection that authenticated no user is too narrow on an enforcing server, wherever it is refused", async () => {
    // 9.0.4 and 8.3.11 refuse even buildInfo to it (measured, code 13).
    const refused = scriptedClient({
      buildInfo: serverError(13, "Command buildInfo requires authentication"),
      connectionStatus: fixture("connection-status-anonymous-9.0.4"),
    });
    const early = await verifyRefusal(refused.client, "PROFILE_PRIVILEGES_TOO_NARROW");
    expect(early.message).toContain('authenticated no user, so it holds no read privilege on "app"');
    expect(refused.names()).toEqual(["buildInfo", "connectionStatus"]);
    // 7.0.43 answers buildInfo, and refuses the probe (measured, code 13).
    const answered = scriptedClient({
      buildInfo: BUILD_INFO["7.0.43"],
      connectionStatus: fixture("connection-status-anonymous-9.0.4"),
      delete: serverError(13, "Command delete requires authentication"),
    });
    await verifyRefusal(answered.client, "PROFILE_PRIVILEGES_TOO_NARROW");
    expect(answered.names()).toEqual(["buildInfo", "connectionStatus", "delete"]);
  });

  test("a wire-compatible server is refused on its buildInfo or its host, before anything else is asked", async () => {
    const ferret = scriptedClient({ buildInfo: FERRETDB });
    await verifyRefusal(ferret.client, "PROFILE_UNSUPPORTED_TARGET");
    expect(ferret.names()).toEqual(["buildInfo"]);
    const cosmos = scriptedClient({ buildInfo: BUILD_INFO["9.0.4"] });
    const caught = await verifyAgentProfile(cosmos.client, "app", {
      ...VERIFY,
      hosts: ["acct.mongo.cosmos.azure.com"],
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((caught as ExecutionProfileError).reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(cosmos.names()).toEqual(["buildInfo"]);
  });

  test("a probe that fails for any reason but authorization fails the open with its own error", async () => {
    for (const failure of [
      serverError(121, "Document failed validation"),
      serverError(11000, "E11000 duplicate key error"),
      Object.assign(new Error("connection reset"), { name: "MongoNetworkError" }),
    ]) {
      const { client } = scriptedClient({
        buildInfo: BUILD_INFO["9.0.4"],
        connectionStatus: LIBREDB_AGENT["9.0.4"],
        delete: failure,
      });
      const caught = await verifyAgentProfile(client, "app", VERIFY).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(caught).toBe(failure);
    }
  });

  test("a status that does not say which user the session authenticated as leaves the boundary unproven", async () => {
    const { client, names } = scriptedClient({ buildInfo: BUILD_INFO["9.0.4"], connectionStatus: { ok: 1 } });
    const error = await verifyRefusal(client, "PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toContain("could not read which user this session authenticated as");
    expect(names()).toEqual(["buildInfo", "connectionStatus"]);
  });

  test("a buildInfo that fails, other than an unauthenticated connection's refusal, fails the open as it is", async () => {
    const network = Object.assign(new Error("connection destroyed"), { name: "MongoNetworkError" });
    const broken = scriptedClient({ buildInfo: network });
    expect(await verifyAgentProfile(broken.client, "app", VERIFY).catch((error: unknown) => error)).toBe(network);
    // Code 13 to a connection that DID authenticate is not the no-user case, so it is not read as one.
    const refusedAuthenticated = serverError(13, "not authorized");
    const odd = scriptedClient({ buildInfo: refusedAuthenticated, connectionStatus: LIBREDB_AGENT["9.0.4"] });
    expect(await verifyAgentProfile(odd.client, "app", VERIFY).catch((error: unknown) => error)).toBe(
      refusedAuthenticated,
    );
  });
});

describe("probeServerEnforcesAuthorization", () => {
  test("code 13 is the proof; an accepted delete is a server that does not enforce authorization", async () => {
    const enforcing = scriptedClient({ delete: UNAUTHORIZED });
    await probeServerEnforcesAuthorization(enforcing.client.db("app"), 1234);
    expect(enforcing.sent[0].command.maxTimeMS).toBe(1234);
    const open = scriptedClient({ delete: { n: 0, ok: 1 } });
    const caught = await probeServerEnforcesAuthorization(open.client.db("app"), 1234).catch((error: unknown) => error);
    expect((caught as ExecutionProfileError).reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
  });
});

describe("agentHostsOf", () => {
  test("names every host the client resolved, SRV host included, and nothing for a socket", () => {
    const options = {
      hosts: [
        { host: "a.example.net", port: 27017 },
        { host: "b.example.net", port: 27018 },
        { socketPath: "/tmp/mongodb-27017.sock" },
      ],
      srvHost: "cluster.mongo.cosmos.azure.com",
    };
    expect(agentHostsOf({ options } as unknown as MongoClient)).toEqual([
      "a.example.net",
      "b.example.net",
      "cluster.mongo.cosmos.azure.com",
    ]);
    expect(agentHostsOf({ options: { hosts: [] } } as unknown as MongoClient)).toEqual([]);
  });
});
