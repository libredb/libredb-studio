/**
 * The etcd provider's agent path: the open and the proof under the agent read-only profile, the proof again before
 * every command with no verdict kept, the one fixed request each read sends, and the object surface and monitoring
 * reads of a handle opened for either agent profile, which name no key, key prefix or key range.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { ETCD_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/keyvalue/etcd/agent-metadata-read";
import { ETCD_PROOF_SENTENCES } from "@/lib/db/providers/keyvalue/etcd/agent-read-only-proof";
import { ETCD_AGENT_SENTENCES } from "@/lib/db/providers/keyvalue/etcd/agent-statement";
import { type EtcdClient, EtcdError, type EtcdPermission } from "@/lib/db/providers/keyvalue/etcd/client";
import { EtcdProvider } from "@/lib/db/providers/keyvalue/etcd/index";
import { ALL_KEYS, fromHexId } from "@/lib/db/providers/keyvalue/etcd/keys";
import { TIME_BUDGET_PREFIX } from "@/lib/db/providers/sql/read-only-budget";
import type { ProviderExecutionContext } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { capturedClient, principalCapture } from "../../../helpers/etcd-agent";
import { createFakeEtcdClient, type FakeEtcdClient } from "../../../helpers/etcd-fake-client";
import { permissionDenied } from "../../../helpers/etcd-key-space";

const BUDGET = { maxResultRows: 200, maxResultBytes: 64 * 1024, statementTimeoutMs: 10_000 };
const READ_ONLY: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true, sendsStatements: false };
const encode = (text: string) => new TextEncoder().encode(text);

const PROFILE_REQUIRED = "Read-only execution requires a provider opened under the agent read-only profile";
const SURFACE_REFUSED =
  "An etcd handle opened for agent mode answers only the agent's metadata reads, through queryReadOnly, and lists no key, value or key range.";
const KEY_NAMES_WITHHELD =
  "Agent mode on etcd reads metadata only, and key names count as stored values, so no key, key prefix or key range is listed to it.";

/** Password sign-in, which needs TLS; `require` verifies nothing, which no fake minds. */
function connectionOf(user: string | undefined): DatabaseConnection {
  return {
    id: "etcd-agent",
    name: "etcd agent",
    type: "etcd",
    host: "etcd.test",
    port: 2379,
    createdAt: new Date(0),
    ...(user === undefined ? {} : { user, password: "not-a-real-password", ssl: { mode: "require" as const } }),
  };
}

/** A client answering as `principal` did on the captured server, with a sign-in and a close. */
function clientOf(principal: Parameters<typeof principalCapture>[0], overrides: Partial<EtcdClient> = {}) {
  return createFakeEtcdClient({
    ...capturedClient(principalCapture(principal)),
    authenticate: async () => {},
    close: async () => {},
    ...overrides,
  });
}

interface Built {
  readonly provider: EtcdProvider;
  readonly built: () => number;
}

function build(connection: DatabaseConnection, client: FakeEtcdClient, execution: ProviderExecutionContext): Built {
  let built = 0;
  const provider = new EtcdProvider(connection, { queryTimeout: 5_000 }, execution, async () => {
    built += 1;
    return client;
  });
  return { provider, built: () => built };
}

async function opened(
  client: FakeEtcdClient,
  execution: ProviderExecutionContext = READ_ONLY,
  user = "agent_reader_range",
) {
  const { provider } = build(connectionOf(user), client, execution);
  await provider.connect();
  return provider;
}

/** A reader whose `Status` answers the connect, and fails with `error` every time after. */
function statusFailsAfterConnect(error: unknown): FakeEtcdClient {
  const captured = capturedClient(principalCapture("reader-range")).status!;
  let calls = 0;
  return clientOf("reader-range", {
    status: async (options) => {
      calls += 1;
      return calls === 1 ? captured(options) : Promise.reject(error);
    },
  });
}

const methods = (client: FakeEtcdClient, from = 0) => client.calls.slice(from).map((call) => call.method);
describe("the open under the agent read-only profile", () => {
  test("a connection that names no user is refused before any client is built", async () => {
    const { provider, built } = build(connectionOf(undefined), clientOf("auth-off"), READ_ONLY);
    await expect(provider.connect()).rejects.toThrow(
      new ExecutionProfileError(ETCD_PROOF_SENTENCES.noUser, "PROFILE_SERVER_UNENFORCED"),
    );
    expect(built()).toBe(0);
  });

  test("root is refused by name before any client is built", async () => {
    const { provider, built } = build(connectionOf("root"), clientOf("root"), READ_ONLY);
    await expect(provider.connect()).rejects.toThrow(ETCD_PROOF_SENTENCES.rootUser);
    expect(built()).toBe(0);
  });

  test("a READ-only user opens after the proof reads authentication, its user and its roles", async () => {
    const client = clientOf("reader-range");
    const provider = await opened(client);
    expect(provider.isConnected()).toBe(true);
    // The connect sequence, then the proof, which reads everything again with no verdict taken from the connect.
    expect(methods(client)).toEqual([
      "authenticate",
      "status",
      "authStatus",
      "userGet",
      "roleGet",
      "authStatus",
      "userGet",
      "roleGet",
    ]);
  });

  test.each([
    ["a user holding the root role", "root-role", ETCD_PROOF_SENTENCES.rootRole],
    ["a user with READWRITE on a range", "readwrite-range", ETCD_PROOF_SENTENCES.writer],
    ["a user with WRITE on a range", "write-range", ETCD_PROOF_SENTENCES.writer],
  ] as const)("%s is refused at open, and the channel is closed", async (_label, principal, sentence) => {
    const client = clientOf(principal);
    const { provider } = build(connectionOf(`agent_${principal}`), client, READ_ONLY);
    await expect(provider.connect()).rejects.toThrow(sentence);
    expect(provider.isConnected()).toBe(false);
    expect(methods(client).at(-1)).toBe("close");
  });

  test("authentication off is refused at open", async () => {
    // A certificate's user names a principal with no password, so the connect reads AuthStatus with no token.
    const client = clientOf("auth-off", { userGet: async () => [] });
    const { provider } = build(connectionOf("agent_reader"), client, READ_ONLY);
    await expect(provider.connect()).rejects.toThrow(ETCD_PROOF_SENTENCES.authOff);
  });

  test("a proof read that fails for another reason is raised in the provider's words", async () => {
    let reads = 0;
    const client = clientOf("reader-range", {
      userGet: async () => {
        reads += 1;
        if (reads === 1) return ["agent_read_app"];
        throw new EtcdError("unavailable", "etcdserver: request timed out", 14);
      },
    });
    const { provider } = build(connectionOf("agent_reader_range"), client, READ_ONLY);
    const failure = await provider.connect().catch((error: unknown) => error as Error);
    expect(failure).not.toBeInstanceOf(ExecutionProfileError);
    expect(failure?.message).toContain("etcd did not answer the read of etcd user agent_reader_range's grants");
  });

  test("the operations profile opens with any user and no proof, so plan mode grounds on root", async () => {
    const client = clientOf("root");
    const provider = await opened(client, OPERATIONS, "root");
    expect(provider.isConnected()).toBe(true);
    expect(methods(client).filter((method) => method === "authStatus")).toHaveLength(1);
  });
});

describe("queryReadOnly", () => {
  test("an editor handle and an operations-profile handle refuse it before anything is sent", async () => {
    for (const execution of [{}, OPERATIONS]) {
      const client = clientOf("reader-range");
      // oxlint-disable-next-line no-await-in-loop -- each handle is opened and asked on its own.
      const provider = await opened(client, execution);
      const mark = client.calls.length;
      // oxlint-disable-next-line no-await-in-loop -- each handle is opened and asked on its own.
      await expect(provider.queryReadOnly("endpoint status", BUDGET)).rejects.toThrow(
        new RefusedBeforeSendError(PROFILE_REQUIRED, "etcd", "endpoint status"),
      );
      expect(client.calls.length).toBe(mark);
    }
  });

  test("an unconnected provider is refused", async () => {
    const { provider } = build(connectionOf("agent_reader_range"), clientOf("reader-range"), READ_ONLY);
    await expect(provider.queryReadOnly("endpoint status", BUDGET)).rejects.toThrow();
  });

  test("a bad budget and an estimating plan are refused before anything is sent", async () => {
    const client = clientOf("reader-range");
    const provider = await opened(client);
    const mark = client.calls.length;
    await expect(provider.queryReadOnly("endpoint status", { ...BUDGET, maxResultRows: 0 })).rejects.toThrow();
    await expect(provider.queryReadOnly("endpoint status", BUDGET, "estimate-plan")).rejects.toThrow(
      "etcd composes no estimating plan for the agent",
    );
    expect(client.calls.length).toBe(mark);
  });

  test.each([
    ["put /app/config x", ETCD_AGENT_SENTENCES.metadataOnly],
    ["get /app/ --prefix", ETCD_AGENT_SENTENCES.metadataOnly],
    ["get /app/ --prefix --keys-only", ETCD_AGENT_SENTENCES.metadataOnly],
    ["watch /app/config", ETCD_AGENT_SENTENCES.metadataOnly],
    ["txn", ETCD_AGENT_SENTENCES.metadataOnly],
    ["lease grant 60", ETCD_AGENT_SENTENCES.metadataOnly],
    ["lease timetolive 694d8147df1dc4c8 --keys", ETCD_AGENT_SENTENCES.metadataOnly],
    ["get /app/config --rev=1", ETCD_AGENT_SENTENCES.flags],
    ["get /app/config --consistency=s", ETCD_AGENT_SENTENCES.flags],
  ])("%s is refused before the network, the proof included", async (text, sentence) => {
    const client = clientOf("reader-range");
    const provider = await opened(client);
    const mark = client.calls.length;
    await expect(provider.queryReadOnly(text, BUDGET)).rejects.toThrow(
      new RefusedBeforeSendError(sentence, "etcd", text),
    );
    expect(client.calls.length).toBe(mark);
  });

  test("every command is preceded by a fresh proof, and sends its one fixed request", async () => {
    const client = clientOf("reader-range");
    const provider = await opened(client);
    const cases: ReadonlyArray<readonly [string, keyof EtcdClient, unknown[]]> = [
      ["endpoint status", "status", []],
      ["member list", "memberList", [{ linearizable: true }]],
      ["alarm list", "alarmList", []],
      ["auth status", "authStatus", []],
      ["lease list", "leaseLeases", []],
      ["lease timetolive 694d8147df1dc4c8", "leaseTimeToLive", [fromHexId("694d8147df1dc4c8"), false]],
      ["get /app/config", "range", [{ key: encode("/app/config"), limit: 1 }]],
      ['get "" --prefix --count-only', "range", [{ ...ALL_KEYS, limit: 1, countOnly: true }]],
    ];
    for (const [text, method, args] of cases) {
      const mark = client.calls.length;
      // oxlint-disable-next-line no-await-in-loop -- the calls of one command are counted from its own mark.
      await provider.queryReadOnly(text, BUDGET).catch(() => undefined);
      const sent = client.calls.slice(mark);
      expect(sent.map((call): string => call.method)).toEqual(["authStatus", "userGet", "roleGet", method]);
      expect(sent[3]?.args.slice(0, -1)).toEqual(args);
      expect(sent[3]?.args.at(-1)).toMatchObject({ signal: expect.any(AbortSignal) });
    }
  });

  test("a named key answers its metadata and never its name or its value", async () => {
    const provider = await opened(clientOf("reader-range"));
    const answer = await provider.queryReadOnly("get /app/config", BUDGET);
    expect(answer.rows).toEqual([
      { exists: true, create_revision: 2, mod_revision: 2, version: 1, lease_id: null, value_bytes: 20 },
    ]);
    expect(JSON.stringify(answer)).not.toContain("/app/config");
    expect(JSON.stringify(answer)).not.toContain("fixture-config-value");
    expect(answer.rowCount).toBe(1);
    expect(answer.executionTime).toBeGreaterThanOrEqual(0);
  });

  test("each other read answers its projection", async () => {
    const provider = await opened(clientOf("reader-range"));
    expect((await provider.queryReadOnly("endpoint status", BUDGET)).rows[0]).toMatchObject({ version: "3.7.2" });
    expect((await provider.queryReadOnly("member list", BUDGET)).rows[0]).toMatchObject({ name: "pr39-etcd-auth" });
    expect((await provider.queryReadOnly("alarm list", BUDGET)).rows).toEqual([]);
    expect((await provider.queryReadOnly("auth status", BUDGET)).rows[0]).toMatchObject({ enabled: true });
    expect((await provider.queryReadOnly("lease list", BUDGET)).rows).toHaveLength(1);
    expect((await provider.queryReadOnly("lease timetolive 694d8147df1dc4c8", BUDGET)).rows[0]).toMatchObject({
      exists: true,
    });
  });

  test("a key outside the user's READ ranges is etcd's refusal, worded without etcd's words or the key", async () => {
    const provider = await opened(clientOf("reader-range"));
    const failure = await provider.queryReadOnly("get /other/credential", BUDGET).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure?.message).toBe(ETCD_AGENT_FAILURE_SENTENCES.refused("permission-denied"));
    expect(failure?.message).not.toContain("/other/credential");
    const count = await provider.queryReadOnly('get "" --prefix --count-only', BUDGET).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(count?.message).toBe(ETCD_AGENT_FAILURE_SENTENCES.refused("permission-denied"));
  });

  test("a deadline is the time budget's refusal", async () => {
    const provider = await opened(statusFailsAfterConnect(new EtcdError("deadline-exceeded", "Cancelled on client")));
    await expect(provider.queryReadOnly("endpoint status", BUDGET)).rejects.toThrow(
      `${TIME_BUDGET_PREFIX}: no answer within 10000ms`,
    );
  });

  test("a defect surfaces as itself", async () => {
    const defect = new TypeError("a defect");
    const provider = await opened(statusFailsAfterConnect(defect));
    await expect(provider.queryReadOnly("endpoint status", BUDGET)).rejects.toBe(defect);
  });

  test("WRITE granted during the run is read by the next command's proof, and the read is never sent", async () => {
    let permissions: EtcdPermission[] = [{ type: "read", key: encode("/app/"), rangeEnd: encode("/app0") }];
    const client = clientOf("reader-range", { roleGet: async () => permissions });
    const provider = await opened(client);
    expect((await provider.queryReadOnly("endpoint status", BUDGET)).rowCount).toBe(1);
    permissions = [...permissions, { type: "write", key: encode("/scratch/"), rangeEnd: encode("/scratch0") }];
    const mark = client.calls.length;
    await expect(provider.queryReadOnly("endpoint status", BUDGET)).rejects.toThrow(ETCD_PROOF_SENTENCES.writer);
    expect(methods(client, mark)).toEqual(["authStatus", "userGet", "roleGet"]);
  });

  test("authentication turned off during the run refuses the next command", async () => {
    let enabled = true;
    const client = clientOf("reader-range", { authStatus: async () => ({ enabled, authRevision: "33" }) });
    const provider = await opened(client);
    enabled = false;
    await expect(provider.queryReadOnly("endpoint status", BUDGET)).rejects.toThrow(ETCD_PROOF_SENTENCES.authOff);
  });

  test("the root role granted during the run refuses the next command", async () => {
    let roles = ["agent_read_app"];
    const client = clientOf("reader-range", { userGet: async () => roles });
    const provider = await opened(client);
    roles = [...roles, "root"];
    await expect(provider.queryReadOnly("endpoint status", BUDGET)).rejects.toThrow(ETCD_PROOF_SENTENCES.rootRole);
  });
});

describe("a handle opened for an agent-mode profile names no key", () => {
  for (const [label, execution] of [
    ["the agent read-only profile", READ_ONLY],
    ["the operations profile", OPERATIONS],
  ] as const) {
    describe(label, () => {
      test("the editor's command path is refused before anything is sent", async () => {
        const client = clientOf("reader-range");
        const provider = await opened(client, execution);
        const mark = client.calls.length;
        await expect(provider.query("get /app/ --prefix")).rejects.toThrow(
          new RefusedBeforeSendError(SURFACE_REFUSED, "etcd", "get /app/ --prefix"),
        );
        expect(client.calls.length).toBe(mark);
      });

      test("the key-prefix folder is withheld with its reason and walked not at all", async () => {
        const client = clientOf("reader-range", {
          memberList: async () => ({
            header: { clusterId: "1", memberId: "1", revision: "1", raftTerm: "1" },
            members: [],
          }),
          leaseLeases: async () => ({
            header: { clusterId: "1", memberId: "1", revision: "1", raftTerm: "1" },
            ids: [],
          }),
          userList: async () => Promise.reject(permissionDenied()),
          roleList: async () => Promise.reject(permissionDenied()),
        });
        const provider = await opened(client, execution);
        const mark = client.calls.length;
        const counts = await provider.countObjects([]);
        expect(counts.prefix).toEqual({ unavailable: KEY_NAMES_WITHHELD });
        expect(counts.member).toEqual({ count: 0 });
        expect(methods(client, mark)).not.toContain("range");
        expect(await provider.listObjects([], "prefix")).toEqual([]);
        expect((await provider.describeObjects([], "prefix")).details).toEqual([]);
        expect(methods(client, mark)).not.toContain("range");
      });

      test.each(["key", "role", "lease"])("a %s's source is refused before anything is sent", async (kind) => {
        const client = clientOf("reader-range");
        const provider = await opened(client, execution);
        const mark = client.calls.length;
        await expect(provider.readObjectSource(["/app/config"], kind)).rejects.toThrow(
          new QueryError(SURFACE_REFUSED, "etcd"),
        );
        expect(client.calls.length).toBe(mark);
      });

      test("the Keys panel walk and the table statistics are refused before anything is sent", async () => {
        const client = clientOf("reader-range");
        const provider = await opened(client, execution);
        const mark = client.calls.length;
        await expect(provider.scanKeysPage({ cursor: "0", count: 10 })).rejects.toThrow(
          new QueryError(SURFACE_REFUSED, "etcd"),
        );
        await expect(provider.getTableStats()).rejects.toThrow(new QueryError(KEY_NAMES_WITHHELD, "etcd"));
        expect(client.calls.length).toBe(mark);
      });

      test("health and storage read the cluster, and a refusal names what the user may read by how many ranges", async () => {
        const provider = await opened(clientOf("reader-range"), execution);
        expect((await provider.getHealth()).databaseSize).toBeDefined();
        expect(await provider.getStorageStats()).toHaveLength(1);
        const refusing = await opened(
          clientOf("reader-range", { alarmList: async () => Promise.reject(permissionDenied()) }),
          execution,
        );
        const failure = await refusing.getHealth().then(
          () => undefined,
          (error: unknown) => error as Error,
        );
        expect(failure?.message).toContain("etcd user agent_reader_range may read: 1 range.");
        expect(failure?.message).not.toContain("/app/");
      });

      test("a member's source is still read", async () => {
        const provider = await opened(clientOf("reader-range"), execution);
        const members = await provider.listObjects([], "member");
        expect(members).toHaveLength(1);
      });
    });
  }

  test("an editor handle keeps the key walk", async () => {
    const client = clientOf("reader-range", {
      range: async () => ({
        header: { clusterId: "1", memberId: "1", revision: "1", raftTerm: "1" },
        kvs: [],
        more: false,
        count: "0",
      }),
    });
    const provider = await opened(client, {});
    await provider.listObjects([], "prefix");
    expect(methods(client)).toContain("range");
  });
});
