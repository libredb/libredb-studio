/**
 * The governance snapshot loader (spec 7.4, 7.5): one read-only repeatable-read transaction over the governance source,
 * admission of its connection rows, and the effective grant of each subject and admitted connection.
 *
 * `pg` is the fake of tests/helpers/governance/pg-fake.ts, so every statement the loader issues is seen, and each case
 * answers it with rows, an error or nothing at all. Envelopes are sealed with the test sealer to a keyring file of a
 * fresh key, and opened by Studio's own opener, as a governance source and Studio do it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { keyringFileOf, removeKeyringFiles, testKey, writeKeyringFile } from "../../../helpers/governance/keyring-file";
import { sealSecret } from "../../../helpers/governance/lsb1-seal";
import {
  answerSnapshot,
  contractRow,
  EMPTY_SOURCE,
  type FakeClient,
  FakePool,
  fakePg,
  nodeError,
  pgError,
  type SnapshotRows,
  settle,
} from "../../../helpers/governance/pg-fake";

const realPg = await import("pg");
mock.module("pg", () => ({ Pool: FakePool, Client: realPg.Client, types: realPg.types }));

const { loadGovernanceSnapshot } = await import("@/lib/governance/snapshot");
const { closeGovernancePool } = await import("@/lib/governance/db");
const { governanceFreshness, governanceServable } = await import("@/lib/governance/freshness");
const { effectiveGrant, governanceState, resetGovernanceState } = await import("@/lib/governance/state");
const { resetGovernanceKeyring } = await import("@/lib/governance/keyring");
const { pgSslConfig } = await import("@/lib/pg-ssl");
const { logger } = await import("@/lib/logger");
const { registerOwnerRemoval } = await import("@/lib/db/owner-removal");

const ROOT = path.resolve(import.meta.dir, "../../../..");

interface ManifestStatement {
  readonly id: string;
  readonly sql: string;
}

/** The statements the manifest publishes for a snapshot, in the order Studio issues them. */
const MANIFEST_SNAPSHOT_SQL = (
  JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/governance/contract-v1.json"), "utf8")) as {
    statements: ManifestStatement[];
  }
).statements
  .filter((statement) => statement.id.startsWith("snapshot."))
  .map((statement) => statement.sql);

const KEY = testKey();
const KEYRING_FILE = keyringFileOf(KEY);
/** A URL whose password must never reach a message. */
const URL = "postgresql://libredb_studio:example-only-url-password@db.internal:5432/libredb?sslmode=verify-full";

const ENV: Readonly<Record<string, string | undefined>> = {
  GOVERNANCE_SOURCE: "postgres",
  GOVERNANCE_POSTGRES_URL: URL,
  GOVERNANCE_PRIVATE_KEYS_FILE: KEYRING_FILE,
  GOVERNANCE_POSTGRES_SCHEMA: undefined,
  GOVERNANCE_ALLOWED_ENGINES: undefined,
  GOVERNANCE_REFRESH_MS: undefined,
  GOVERNANCE_MAX_STALENESS_MS: undefined,
};

let saved: Record<string, string | undefined> = {};
let logs: {
  error: ReturnType<typeof spyOn>;
  warn: ReturnType<typeof spyOn>;
  info: ReturnType<typeof spyOn>;
  debug: ReturnType<typeof spyOn>;
};

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  saved = {};
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name];
    setEnv(name, value);
  }
  fakePg.reset();
  logs = {
    error: spyOn(logger, "error").mockImplementation(() => {}),
    warn: spyOn(logger, "warn").mockImplementation(() => {}),
    info: spyOn(logger, "info").mockImplementation(() => {}),
    debug: spyOn(logger, "debug").mockImplementation(() => {}),
  };
});

afterEach(async () => {
  jest.useRealTimers();
  await closeGovernancePool();
  resetGovernanceState();
  resetGovernanceKeyring();
  for (const [name, value] of Object.entries(saved)) setEnv(name, value);
  for (const spy of Object.values(logs)) spy.mockRestore();
});

afterAll(() => {
  removeKeyringFiles();
});

const DEFINITION = { host: "db.example.internal", port: 5432, database: "orders" };
const READ = { user: "reader", password: "example-only-read-password" };
const WRITE = { user: "writer", password: "example-only-write-password" };

interface ConnectionOptions {
  readonly read?: string;
  /** The write envelope, or a credential to seal into one for the row's own binding. */
  readonly write?: string | Readonly<Record<string, string>>;
  readonly definition?: Readonly<Record<string, unknown>>;
}

/** A `connections_v1` row whose envelopes are sealed for its own binding unless given. */
function connectionRow(id: string, options: ConnectionOptions = {}): Record<string, unknown> {
  const definition = options.definition ?? DEFINITION;
  const seal = (level: "read" | "write", secret: Readonly<Record<string, string>>) =>
    sealSecret(KEY.publicKey, { connectionId: id, level, engine: "postgres", definition }, secret);
  const write = options.write;
  return {
    connection_id: id,
    name: `Connection ${id}`,
    engine: "postgres",
    environment: "production",
    group_name: null,
    color: null,
    definition,
    read_secret: options.read ?? seal("read", READ),
    write_secret: write === undefined ? null : typeof write === "string" ? write : seal("write", write),
    mcp_enabled: false,
    updated_at: new Date("2026-10-14T12:00:00.000Z"),
  };
}

const grantRow = (
  subject: string,
  connectionId: string,
  level: string,
  expiresAt: Date | number | null = null,
): Record<string, unknown> => ({
  subject,
  connection_id: connectionId,
  level,
  expires_at: expiresAt,
  downgraded: false,
  granted_at: new Date("2026-10-14T12:00:00.000Z"),
});

/** The governance source answers `rows` in the default schema. */
const serve = (rows: Partial<SnapshotRows>, schema?: string): void => {
  fakePg.respond = answerSnapshot({ ...EMPTY_SOURCE, ...rows }, schema);
};

/** The one pool the loader made. */
function onlyPool(): FakePool {
  expect(FakePool.made).toHaveLength(1);
  return FakePool.made[0];
}

/** The clients the loader took from its pool, across every load. */
const clients = (): FakeClient[] => FakePool.made.flatMap((pool) => pool.clients);

const snapshot = () => {
  const loaded = governanceState().snapshot;
  if (loaded === null) throw new Error("no snapshot was loaded");
  return loaded;
};

const failure = () => {
  const failed = governanceState().failure;
  if (failed === null) throw new Error("no load failed");
  return failed;
};

describe("one load", () => {
  test("one load issues exactly the manifest's snapshot statements inside one REPEATABLE READ READ ONLY transaction", async () => {
    serve({ connections: [connectionRow("orders")], grants: [grantRow("alice", "orders", "read")] });

    await loadGovernanceSnapshot();

    expect(MANIFEST_SNAPSHOT_SQL).toHaveLength(8);
    const [client] = clients();
    expect(clients()).toHaveLength(1);
    expect(client.statements).toEqual(MANIFEST_SNAPSHOT_SQL);
    expect(client.statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    expect(client.statements.at(-1)).toBe("COMMIT");
    // Released once, without an error, so the pool keeps the healthy connection.
    expect(client.releases).toBe(1);
    expect(client.releasedWith).toBeUndefined();
    expect(governanceFreshness()).toBe("ok");
    expect(governanceServable()).toBe(true);
  });

  test("a contract listing only version 2 is incompatible and no _v1 object is queried", async () => {
    serve({ contract: [contractRow(2)] });

    await loadGovernanceSnapshot();

    const [client] = clients();
    expect(client.statements).toEqual([MANIFEST_SNAPSHOT_SQL[0], MANIFEST_SNAPSHOT_SQL[1], "COMMIT"]);
    expect(client.statements.filter((sql) => sql.includes("_v1"))).toEqual([]);
    // Nothing failed on the connection, so it goes back to the pool.
    expect(client.releasedWith).toBeUndefined();
    expect(governanceFreshness()).toBe("incompatible");
    expect(governanceServable()).toBe(false);
    expect(failure()).toMatchObject({
      kind: "incompatible",
      code: null,
      detail: "no common contract version: Studio supports [1], the governance source publishes [2]",
    });
    expect(governanceState().snapshot).toBeNull();
  });

  test("a contract with no version at all is incompatible too", async () => {
    serve({ contract: [] });

    await loadGovernanceSnapshot();

    expect(failure().detail).toBe(
      "no common contract version: Studio supports [1], the governance source publishes []",
    );
  });

  test("the highest common version is active, and every published version is kept", async () => {
    serve({ contract: [contractRow(2), contractRow(1), { ...contractRow(1), status: "deprecated" }] });

    await loadGovernanceSnapshot();

    expect(snapshot().contractVersion).toBe(1);
    expect(snapshot().publishedVersions).toEqual([1, 2]);
  });

  test("the schema of GOVERNANCE_POSTGRES_SCHEMA is quoted in every statement", async () => {
    process.env.GOVERNANCE_POSTGRES_SCHEMA = "governance";
    serve({}, "governance");

    await loadGovernanceSnapshot();

    const reads = clients()[0].statements.filter((sql) => sql.startsWith("SELECT"));
    expect(reads).toHaveLength(6);
    for (const sql of reads) expect(sql).toContain(' FROM "governance".');
    expect(governanceFreshness()).toBe("ok");
  });

  test("the time a load starts is the snapshot's load time, so its age never runs behind", async () => {
    jest.useFakeTimers();
    const startedAt = Date.now();
    let answered = false;
    fakePg.respond = async (sql) => {
      // The governance source takes 3 seconds to answer the connections.
      if (sql.includes("connections_v1") && !answered) {
        answered = true;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      return answerSnapshot(EMPTY_SOURCE)(sql);
    };

    const load = loadGovernanceSnapshot();
    await settle();
    jest.advanceTimersByTime(3000);
    await load;

    expect(snapshot().loadedAt).toBe(startedAt);
  });
});

describe("the governance pool", () => {
  test("the pool reads GOVERNANCE_POSTGRES_URL with the storage pool's TLS handling and the limits of spec 7.4", async () => {
    await loadGovernanceSnapshot();

    expect(onlyPool().config).toEqual({
      connectionString: URL,
      ssl: pgSslConfig(URL),
      max: 4,
      connectionTimeoutMillis: 5000,
      query_timeout: 15000,
      statement_timeout: 10000,
      keepAlive: true,
      application_name: "libredb-studio-governance",
    });
  });

  test("a local URL without sslmode keeps TLS off, as the storage pool does", async () => {
    const local = "postgresql://libredb_studio@localhost:5432/libredb";
    process.env.GOVERNANCE_POSTGRES_URL = local;

    await loadGovernanceSnapshot();

    expect(onlyPool().config.ssl).toBe(false);
  });

  test("every load takes its client from the one pool of the process", async () => {
    await loadGovernanceSnapshot();
    await loadGovernanceSnapshot();

    expect(onlyPool().clients).toHaveLength(2);
    for (const client of onlyPool().clients) expect(client.releases).toBe(1);
  });

  test("closing the pool ends it, and the next load makes a new one", async () => {
    await loadGovernanceSnapshot();
    const first = onlyPool();

    await closeGovernancePool();
    await loadGovernanceSnapshot();

    expect(first.ended).toBe(true);
    expect(FakePool.made).toHaveLength(2);
    // Closing a pool that is not open does nothing.
    await closeGovernancePool();
    await closeGovernancePool();
  });

  test("an error event on the idle pool is logged and does not throw", async () => {
    await loadGovernanceSnapshot();
    const dropped = pgError("57P01", "terminating connection due to administrator command", "FATAL");

    expect(() => onlyPool().emit("error", dropped)).not.toThrow();

    expect(logs.error).toHaveBeenCalledWith("Governance pool client error", dropped, { route: "governance/db" });
  });

  test("a connection error while a client is checked out is logged, fails the load and never crashes", async () => {
    const dropped = pgError("57P01", "terminating connection due to administrator command", "FATAL");
    fakePg.respond = (sql, client) =>
      sql.includes("grants_v1")
        ? // pg emits the socket's error on the client from the socket's own callback, then rejects the statement:
          // with no listener the emit throws there, an uncaught exception that fails this test as it would end the
          // process.
          new Promise((_, reject) =>
            setImmediate(() => {
              client.emit("error", dropped);
              reject(dropped);
            }),
          )
        : answerSnapshot(EMPTY_SOURCE)(sql);

    await loadGovernanceSnapshot();

    expect(logs.warn).toHaveBeenCalledWith("Governance connection error while checked out", {
      route: "governance/db",
      error: "terminating connection due to administrator command",
    });
    expect(failure()).toMatchObject({ kind: "transient", code: "57P01" });
    const [client] = clients();
    expect(client.releasedWith).toBeInstanceOf(Error);
    // The listener goes when the client does, so a reused client never collects listeners.
    expect(client.listenerCount("error")).toBe(0);
  });

  test("a failed statement releases its client with the error, so the broken connection is never reused", async () => {
    fakePg.respond = async (sql) => {
      if (sql.includes("settings_v1")) {
        throw pgError("57P01", "terminating connection due to administrator command", "FATAL");
      }
      return answerSnapshot(EMPTY_SOURCE)(sql);
    };

    await loadGovernanceSnapshot();

    const [client] = clients();
    expect(client.releases).toBe(1);
    expect(client.releasedWith).toBeInstanceOf(Error);
    expect((client.releasedWith as Error).message).toBe(
      "bridge.settings_v1: terminating connection due to administrator command (SQLSTATE 57P01)",
    );
    // Nothing runs on a connection after it failed.
    expect(client.statements.at(-1)).toContain("settings_v1");
    expect(failure()).toMatchObject({ kind: "transient", code: "57P01" });
  });

  test("a refused connection is a transient failure with the driver's code, and no client is taken", async () => {
    fakePg.connecting = async () => {
      throw nodeError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.5:5432");
    };

    await loadGovernanceSnapshot();

    expect(clients()).toEqual([]);
    expect(failure()).toMatchObject({
      kind: "transient",
      code: "ECONNREFUSED",
      detail: "connect ECONNREFUSED 10.0.0.5:5432",
    });
    expect(governanceFreshness()).toBe("loading");
    expect(logs.warn).toHaveBeenCalledWith("Governance snapshot load failed", {
      route: "governance/snapshot",
      kind: "transient",
      code: "ECONNREFUSED",
      detail: "connect ECONNREFUSED 10.0.0.5:5432",
    });
  });
});

describe("the 20 s deadline", () => {
  test("a statement that never answers fails the load at 20 s and its client is released with the error", async () => {
    jest.useFakeTimers();
    fakePg.respond = (sql) => (sql.includes("grants_v1") ? new Promise(() => {}) : answerSnapshot(EMPTY_SOURCE)(sql));
    let finished = false;

    const load = loadGovernanceSnapshot().then(() => {
      finished = true;
    });
    await settle();
    jest.advanceTimersByTime(19_999);
    await settle();
    expect(finished).toBe(false);
    jest.advanceTimersByTime(1);
    await load;

    expect(failure()).toMatchObject({
      kind: "transient",
      code: null,
      detail: "The governance snapshot did not load within 20000 ms",
    });
    const [client] = clients();
    expect((client.releasedWith as Error).message).toBe("The governance snapshot did not load within 20000 ms");
    expect(client.statements.at(-1)).toContain("grants_v1");
  });

  test("a statement that answers after the deadline leads to no further statement", async () => {
    jest.useFakeTimers();
    let answerGrants: (value: { rows: unknown[] }) => void = () => {};
    fakePg.respond = (sql) =>
      sql.includes("grants_v1")
        ? new Promise((resolve) => {
            answerGrants = resolve;
          })
        : answerSnapshot(EMPTY_SOURCE)(sql);

    const load = loadGovernanceSnapshot();
    await settle();
    jest.advanceTimersByTime(20_000);
    await load;
    answerGrants({ rows: [] });
    await settle();

    const [client] = clients();
    expect(client.statements.at(-1)).toContain("grants_v1");
    expect(client.releases).toBe(1);
  });

  test("a connection the pool hands over after the deadline is released at once, with the error", async () => {
    jest.useFakeTimers();
    let connect: () => void = () => {};
    fakePg.connecting = () =>
      new Promise((resolve) => {
        connect = resolve;
      });

    const load = loadGovernanceSnapshot();
    await settle();
    jest.advanceTimersByTime(20_000);
    await load;
    connect();
    await settle();

    const [client] = clients();
    expect(client.statements).toEqual([]);
    expect((client.releasedWith as Error).message).toBe("The governance snapshot did not load within 20000 ms");
    expect(failure().detail).toBe("The governance snapshot did not load within 20000 ms");
  });
});

describe("misconfiguration", () => {
  test("42501 on grants_v1 is misconfigured and names the object", async () => {
    const denied = pgError("42501", "permission denied for view grants_v1");
    fakePg.respond = async (sql) => {
      if (sql.includes("grants_v1")) throw denied;
      return answerSnapshot(EMPTY_SOURCE)(sql);
    };

    await loadGovernanceSnapshot();

    expect(governanceFreshness()).toBe("misconfigured");
    expect(governanceServable()).toBe(false);
    expect(failure()).toMatchObject({
      kind: "misconfigured",
      code: "42501",
      detail: "bridge.grants_v1: permission denied for view grants_v1 (SQLSTATE 42501)",
    });
    expect(clients()[0].releasedWith).toBeInstanceOf(Error);
  });

  test("a misconfiguration after a good load stops serving the snapshot it keeps", async () => {
    await loadGovernanceSnapshot();
    const loaded = snapshot();
    fakePg.respond = async (sql) => {
      if (sql.includes("seal_canary_v1")) throw pgError("42P01", 'relation "bridge.seal_canary_v1" does not exist');
      return answerSnapshot(EMPTY_SOURCE)(sql);
    };

    await loadGovernanceSnapshot();

    expect(governanceFreshness()).toBe("misconfigured");
    expect(governanceServable()).toBe(false);
    expect(failure().detail).toBe(
      'bridge.seal_canary_v1: relation "bridge.seal_canary_v1" does not exist (SQLSTATE 42P01)',
    );
    // Kept for the admin status, which reports its age, but no longer served.
    expect(snapshot()).toBe(loaded);
  });

  test("a keyring that does not load is misconfigured naming GOVERNANCE_PRIVATE_KEYS_FILE, and the source is not read", async () => {
    process.env.GOVERNANCE_PRIVATE_KEYS_FILE = writeKeyringFile({ version: 1, keys: [] });
    resetGovernanceKeyring();

    await loadGovernanceSnapshot();

    expect(governanceFreshness()).toBe("misconfigured");
    expect(failure().code).toBeNull();
    expect(failure().detail).toContain("GOVERNANCE_PRIVATE_KEYS_FILE");
    expect(failure().detail).toContain("holds no keys");
    expect(FakePool.made).toEqual([]);
  });

  test("no failure message carries the password of GOVERNANCE_POSTGRES_URL", async () => {
    fakePg.connecting = async () => {
      throw pgError("28P01", 'password authentication failed for user "libredb_studio"', "FATAL");
    };

    await loadGovernanceSnapshot();

    expect(JSON.stringify(governanceState())).not.toContain("example-only-url-password");
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain("example-only-url-password");
  });
});

describe("effective grants", () => {
  /** Opens nothing: sealed for another connection id, so it fails AUTH_FAILED. */
  const unopenableWrite = () =>
    sealSecret(
      KEY.publicKey,
      { connectionId: "elsewhere", level: "write", engine: "postgres", definition: DEFINITION },
      WRITE,
    );

  test("a write grant is write only where the row says write and this instance opened the write envelope", async () => {
    serve({
      connections: [
        connectionRow("both", { write: WRITE }),
        connectionRow("read-only"),
        connectionRow("sealed-elsewhere", { write: unopenableWrite() }),
      ],
      grants: [
        grantRow("alice", "both", "write"),
        grantRow("alice", "read-only", "write"),
        grantRow("alice", "sealed-elsewhere", "write"),
        grantRow("bob", "both", "read"),
      ],
    });

    await loadGovernanceSnapshot();
    const now = Date.now();

    const write = effectiveGrant(snapshot(), "alice", "both", now);
    expect(write?.level).toBe("write");
    expect(write?.connection.write?.user).toBe("writer");
    expect(write?.connection.read.user).toBe("reader");
    expect(effectiveGrant(snapshot(), "alice", "read-only", now)?.level).toBe("read");
    expect(effectiveGrant(snapshot(), "alice", "sealed-elsewhere", now)?.level).toBe("read");
    expect(effectiveGrant(snapshot(), "bob", "both", now)?.level).toBe("read");
    // The unopenable write envelope is a skip that keeps its row, with read access only.
    expect(snapshot().skipped.map((skip) => skip.item)).toEqual([
      { kind: "connection", id: "sealed-elsewhere", level: "write", code: "WRITE_SECRET_UNOPENABLE" },
    ]);
  });

  test("a grant on a skipped or unknown connection, or for another subject, grants nothing", async () => {
    serve({
      connections: [connectionRow("orders"), connectionRow("server", { definition: { host: "db.example.internal" } })],
      grants: [
        grantRow("alice", "orders", "read"),
        grantRow("alice", "server", "read"),
        grantRow("alice", "gone", "read"),
      ],
    });

    await loadGovernanceSnapshot();
    const now = Date.now();

    expect(effectiveGrant(snapshot(), "alice", "orders", now)?.level).toBe("read");
    expect(effectiveGrant(snapshot(), "alice", "server", now)).toBeUndefined();
    expect(effectiveGrant(snapshot(), "alice", "gone", now)).toBeUndefined();
    expect(effectiveGrant(snapshot(), "bob", "orders", now)).toBeUndefined();
    expect([...snapshot().connections.keys()]).toEqual(["orders"]);
    expect(snapshot().skipped.map((skip) => skip.item.code)).toEqual(["SERVER_LEVEL_NOT_ALLOWED"]);
  });

  test("expires_at is checked at each decision against the clock the caller passes", async () => {
    const expiresAt = new Date("2026-10-15T09:00:00.000Z");
    serve({
      connections: [connectionRow("orders"), connectionRow("audit")],
      grants: [
        grantRow("alice", "orders", "read", expiresAt),
        grantRow("alice", "audit", "read", Number.POSITIVE_INFINITY),
        grantRow("bob", "orders", "read", Number.NEGATIVE_INFINITY),
      ],
    });

    await loadGovernanceSnapshot();

    expect(effectiveGrant(snapshot(), "alice", "orders", expiresAt.getTime() - 1)?.expiresAt).toBe(expiresAt.getTime());
    expect(effectiveGrant(snapshot(), "alice", "orders", expiresAt.getTime())).toBeUndefined();
    // 'infinity' never expires and '-infinity' has always expired.
    expect(effectiveGrant(snapshot(), "alice", "audit", Number.MAX_SAFE_INTEGER)?.level).toBe("read");
    expect(effectiveGrant(snapshot(), "bob", "orders", 0)).toBeUndefined();
  });

  test("a grant row outside the contract's rules, or one of two rows for one pair, grants nothing and is counted in a log line", async () => {
    serve({
      connections: [connectionRow("orders"), connectionRow("audit")],
      grants: [
        grantRow("alice", "orders", "admin"),
        grantRow("", "orders", "read"),
        grantRow("x".repeat(513), "orders", "read"),
        grantRow("bob", "orders", "read", "tomorrow" as unknown as Date),
        grantRow("bob", "audit", "read", new Date(Number.NaN)),
        { ...grantRow("carol", "orders", "read"), connection_id: 7 },
        grantRow("dave", "orders", "read"),
        grantRow("dave", "orders", "write"),
        grantRow("erin", "orders", "read"),
      ],
    });

    await loadGovernanceSnapshot();
    const now = Date.now();

    expect([...snapshot().grants.keys()]).toEqual(["erin"]);
    expect(effectiveGrant(snapshot(), "dave", "orders", now)).toBeUndefined();
    expect(logs.warn).toHaveBeenCalledWith("Governance rows ignored", {
      route: "governance/snapshot",
      grants: 8,
      revocations: 0,
      canaries: 0,
    });
  });
});

describe("what the snapshot keeps", () => {
  test("revocations keep the latest revoked_before per subject, and settings rows are kept as read", async () => {
    const settings = [{ key: "query.timeoutMs", value: 30000, updated_at: new Date("2026-10-14T12:00:00.000Z") }];
    serve({
      revocations: [
        { subject: "alice", revoked_before: new Date("2026-10-15T08:00:00.000Z") },
        { subject: "alice", revoked_before: new Date("2026-10-15T09:00:00.000Z") },
        { subject: "alice", revoked_before: new Date("2026-10-15T07:00:00.000Z") },
        { subject: "bob", revoked_before: Number.POSITIVE_INFINITY },
        { subject: "carol", revoked_before: null },
        { subject: "", revoked_before: new Date("2026-10-15T08:00:00.000Z") },
      ],
      settings,
    });

    await loadGovernanceSnapshot();

    expect([...snapshot().revocations]).toEqual([
      ["alice", new Date("2026-10-15T09:00:00.000Z").getTime()],
      ["bob", Number.POSITIVE_INFINITY],
    ]);
    expect(snapshot().settings).toEqual(settings);
    expect(logs.warn).toHaveBeenCalledWith("Governance rows ignored", {
      route: "governance/snapshot",
      grants: 0,
      revocations: 2,
      canaries: 0,
    });
  });

  test("a load replaces the snapshot at once and clears the failure before it", async () => {
    fakePg.connecting = async () => {
      throw nodeError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.5:5432");
    };
    await loadGovernanceSnapshot();
    expect(governanceState().failure).not.toBeNull();
    fakePg.connecting = async () => {};
    serve({ connections: [connectionRow("orders")] });

    await loadGovernanceSnapshot();

    expect(governanceState().failure).toBeNull();
    expect([...snapshot().connections.keys()]).toEqual(["orders"]);
  });
});

// ─── Teardown after a reload (spec 4.3, 7.4, 9.4) ────────────────────────────
//
// Once a reload swaps its snapshot in, the loader asks every copy of the provider factory to remove the providers of
// each subject and connection whose access the reload took away or changed (src/lib/db/owner-removal.ts). No factory
// is loaded here, so each case registers the removal a copy of the factory would. Every `connectionRow()` call seals
// its envelopes afresh, as the control plane does on a credential change, so a reload that serves the same row objects
// again changes nothing a connection opens with.

describe("teardown after a reload", () => {
  test("a reload asks every copy of the factory to remove exactly the providers whose access it took away or changed", async () => {
    const removals: unknown[][] = [];
    const unregister = registerOwnerRemoval(async (connectionId, scope) => {
      removals.push([connectionId, scope]);
    });
    try {
      const orders = connectionRow("orders", { write: WRITE });
      const billing = connectionRow("billing");
      serve({
        connections: [orders, billing],
        grants: [
          grantRow("alice", "orders", "write"),
          grantRow("bob", "orders", "read"),
          grantRow("carol", "billing", "read"),
        ],
      });
      await loadGovernanceSnapshot();
      // The first snapshot replaces nothing, so there is nothing to tear down.
      expect(removals).toEqual([]);

      // Alice is downgraded and Carol's grant is deleted; Bob's grant opens the connection as before.
      serve({
        connections: [orders, billing],
        grants: [grantRow("alice", "orders", "read"), grantRow("bob", "orders", "read")],
      });
      await loadGovernanceSnapshot();
      await settle();
      expect(removals).toEqual([
        ["seed:orders", { owner: "alice" }],
        ["seed:billing", { owner: "carol" }],
      ]);
      expect(logs.info).toHaveBeenCalledWith("Governance access changed, closing the providers it opened", {
        route: "governance/snapshot",
        connections: ["orders", "billing"],
      });

      // The same rows again change nothing; the read credential sealed again changes what every grant opens.
      removals.length = 0;
      await loadGovernanceSnapshot();
      await settle();
      expect(removals).toEqual([]);
      serve({
        connections: [connectionRow("orders", { write: WRITE }), billing],
        grants: [grantRow("alice", "orders", "read"), grantRow("bob", "orders", "read")],
      });
      await loadGovernanceSnapshot();
      await settle();
      expect(removals).toEqual([
        ["seed:orders", { owner: "alice" }],
        ["seed:orders", { owner: "bob" }],
      ]);
    } finally {
      unregister();
    }
  });

  test("a load does not wait for its teardown, and a removal that fails is logged with its connection", async () => {
    const unregister = registerOwnerRemoval(async (connectionId) => {
      if (connectionId === "seed:orders") return new Promise<void>(() => {});
      throw new Error("the factory refused the removal");
    });
    try {
      serve({
        connections: [connectionRow("orders"), connectionRow("billing")],
        grants: [grantRow("alice", "orders", "read"), grantRow("alice", "billing", "read")],
      });
      await loadGovernanceSnapshot();

      // Both grants are deleted: the removal for orders never ends, and the one for billing fails.
      serve({ connections: [connectionRow("orders"), connectionRow("billing")] });
      await loadGovernanceSnapshot();

      expect([...snapshot().grants.keys()]).toEqual([]);
      await settle();
      expect(logs.warn.mock.calls.filter(([message]: unknown[]) => message === "Governance teardown failed")).toEqual([
        [
          "Governance teardown failed",
          { route: "governance/snapshot", connectionId: "billing", error: "the factory refused the removal" },
        ],
      ]);
    } finally {
      unregister();
    }
  });
});

/** The canary binding of spec 8.4: connection `canary`, level `read`, engine `canary`, definition `{}`. */
const CANARY_BINDING = { connectionId: "canary", level: "read", engine: "canary", definition: {} } as const;
const CANARY_PLAINTEXT = { user: "libredb-canary" };

describe("seal canaries", () => {
  test("a canary sealed to an unknown kid is reported as UNKNOWN_KID for that kid", async () => {
    const stranger = testKey();
    serve({
      canary: [
        { kid: KEY.kid, envelope: sealSecret(KEY.publicKey, CANARY_BINDING, CANARY_PLAINTEXT) },
        { kid: stranger.kid, envelope: sealSecret(stranger.publicKey, CANARY_BINDING, CANARY_PLAINTEXT) },
      ],
    });

    await loadGovernanceSnapshot();

    expect(snapshot().canary).toEqual({ [KEY.kid]: "ok", [stranger.kid]: "UNKNOWN_KID" });
    expect(logs.warn).not.toHaveBeenCalled();
  });

  test("a canary sealed for another binding, with another plaintext, or not an envelope reports its code", async () => {
    const kids = ["0000000000000001", "0000000000000002", "0000000000000003", "0000000000000004"];
    serve({
      canary: [
        { kid: kids[0], envelope: sealSecret(KEY.publicKey, { ...CANARY_BINDING, level: "write" }, CANARY_PLAINTEXT) },
        { kid: kids[1], envelope: sealSecret(KEY.publicKey, CANARY_BINDING, { user: "someone-else" }) },
        { kid: kids[2], envelope: sealSecret(KEY.publicKey, CANARY_BINDING, { ...CANARY_PLAINTEXT, password: "x" }) },
        { kid: kids[3], envelope: "not-an-envelope" },
      ],
    });

    await loadGovernanceSnapshot();

    expect(snapshot().canary).toEqual({
      [kids[0]]: "AUTH_FAILED",
      [kids[1]]: "PLAINTEXT_INVALID",
      [kids[2]]: "PLAINTEXT_INVALID",
      [kids[3]]: "FORMAT",
    });
  });

  test("a canary row without a kid of the contract's form is ignored and counted, and one without a text envelope is FORMAT", async () => {
    serve({
      canary: [
        { kid: "NOT-A-KID", envelope: sealSecret(KEY.publicKey, CANARY_BINDING, CANARY_PLAINTEXT) },
        { kid: null, envelope: null },
        { kid: KEY.kid, envelope: null },
      ],
    });

    await loadGovernanceSnapshot();

    expect(snapshot().canary).toEqual({ [KEY.kid]: "FORMAT" });
    expect(logs.warn).toHaveBeenCalledWith("Governance rows ignored", {
      route: "governance/snapshot",
      grants: 0,
      revocations: 0,
      canaries: 2,
    });
  });
});

describe("log lines", () => {
  test("the first load and the first after a failure are logged at info, and a routine reload at debug", async () => {
    serve({ connections: [connectionRow("orders")], grants: [grantRow("alice", "orders", "read")] });

    await loadGovernanceSnapshot();
    await loadGovernanceSnapshot();

    const loaded = {
      route: "governance/snapshot",
      contract: 1,
      connections: 1,
      skipped: 0,
      subjects: 1,
    };
    // The keyring logs the kids it loaded at info as well; only the snapshot's lines are counted here.
    const snapshotLines = (calls: unknown[][]) =>
      calls.filter(([message]) => String(message).startsWith("Governance snapshot"));
    expect(snapshotLines(logs.info.mock.calls)).toEqual([["Governance snapshot loaded", loaded]]);
    expect(snapshotLines(logs.debug.mock.calls)).toEqual([["Governance snapshot reloaded", loaded]]);
  });

  test("skipped rows are logged with their envelope codes when the set changes, and never with a value", async () => {
    const elsewhere = sealSecret(
      KEY.publicKey,
      { connectionId: "elsewhere", level: "read", engine: "postgres", definition: DEFINITION },
      READ,
    );
    serve({ connections: [connectionRow("orders", { read: elsewhere })] });

    await loadGovernanceSnapshot();
    await loadGovernanceSnapshot();

    const skippedLines = logs.warn.mock.calls.filter(([message]: unknown[]) => message === "Governance rows skipped");
    expect(skippedLines).toEqual([
      [
        "Governance rows skipped",
        {
          route: "governance/snapshot",
          skipped: [
            {
              kind: "connection",
              id: "orders",
              level: "read",
              code: "READ_SECRET_UNOPENABLE",
              envelopeCode: "AUTH_FAILED",
            },
          ],
        },
      ],
    ]);
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain("example-only-read-password");
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(elsewhere);
  });
});
