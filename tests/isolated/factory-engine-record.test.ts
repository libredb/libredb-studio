/**
 * The provider factory reads a legacy engine's record, never Studio's tables (src/lib/db/factory.ts, issue #2537): a
 * catalog installed with one legacy record crafted changes what each entry point refuses or decides, the read-only
 * mode, an ungranted refusal, a denied file-access posture, the trust material a build reads, the single-writer
 * registration and borrow, the agent credential's form and the agent user.
 *
 * Under tests/isolated because it replaces the postgres and spark provider modules with `mock.module()` before it
 * imports the factory, which holds only while this file is the first in its bun process to evaluate them: the
 * replacement records its construction and connects without a network, so a case reads whether a build or an open got
 * through. SQLite is the real provider, opened in-process on a file in a scratch directory. Each case installs a
 * catalog of its own and forgets it, and clears the factory's caches, in `finally`. Every fabricated secret is generated
 * at run time. The file paths are joined with node:path, so the cases reach the same steps on Linux, macOS and Windows.
 */
import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { removeScratch, scratchDirectory } from "../helpers/provider-artifacts";
import { withEngineRecord } from "../helpers/package-catalog";

/** A provider that connects without a network and records what it was built from. */
class RecordedProvider {
  static built: unknown[] = [];
  private connected = false;
  constructor(readonly config: { type: string; queryTimeout?: number }) {
    RecordedProvider.built.push(config);
  }
  get type(): string {
    return this.config.type;
  }
  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }
  hasRunsInFlight(): boolean {
    return false;
  }
}

mock.module("@/lib/db/providers/sql/postgres", () => ({ PostgresProvider: RecordedProvider }));
mock.module("@/lib/db/providers/sql/spark/index", () => ({ SparkProvider: RecordedProvider }));

const {
  acquireExecutionProfileProvider,
  clearProviderCache,
  createDatabaseProvider,
  findOpenSingleWriterProvider,
  getOrCreateProvider,
  isSingleWriterFileOpen,
  withOneShotTunnel,
} = await import("@/lib/db/factory");
const { forgetServerCatalog, installServerCatalog } = await import("@/lib/db/server-catalog");
const { composeServerCatalog } = await import("@/lib/db/server-catalog-compose");
const { forgetTrustMaterial } = await import("@/lib/db/trust-material");
const { DatabaseConfigError, StudioProfileRefusal } = await import("@/lib/db/errors");
type EngineRecord = import("@/lib/db/server-catalog").EngineRecord;
type DatabaseConnection = import("@/lib/types").DatabaseConnection;

const scratch = scratchDirectory("studio-factory-engine-record-");
afterAll(() => {
  removeScratch(scratch);
});

/** Installs the composed catalog with `id`'s record changed by `grants` and `connection` members. */
function installCrafted(
  id: string,
  change: { grants?: Record<string, unknown>; connection?: Record<string, unknown> },
): void {
  installServerCatalog(
    withEngineRecord(composeServerCatalog([], []), id, (engine: EngineRecord) => ({
      ...engine,
      grants: Object.freeze({ ...engine.grants, ...change.grants }),
      connection: Object.freeze({ ...engine.connection, ...change.connection }),
    })),
  );
}

/** Runs `body` with nothing installed and the caches clear afterwards. */
async function crafted(body: () => Promise<void>): Promise<void> {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await body();
  } finally {
    log.mockRestore();
    forgetServerCatalog();
    await clearProviderCache();
  }
}

/** A postgres connection with `fields`. */
function postgres(fields: Record<string, unknown> = {}): DatabaseConnection {
  return {
    id: `pg-${randomUUID()}`,
    name: "pg",
    type: "postgres",
    host: "db.internal",
    port: 5432,
    database: "app",
    createdAt: new Date(0),
    ...fields,
  } as DatabaseConnection;
}

/** The rejection of `work`, or a failure when it resolves. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("the call resolved instead of refusing");
}

describe("the factory reads the installed record of a legacy engine", () => {
  test("the factory's entry points refuse by the installed record's grants: read-only kept, an ungranted refusal and a denied file access posture", async () => {
    // A record that keeps the read-only mode is built read-only, where Studio's table refuses the mode.
    await crafted(async () => {
      installCrafted("postgres", { grants: { readOnlyEnforced: true } });
      const provider = await createDatabaseProvider(postgres({ readOnly: true }));
      expect(provider).toBeInstanceOf(RecordedProvider);
    });

    // An ungranted refusal the record holds refuses every entry point before any cache, tunnel or build.
    await crafted(async () => {
      const sentence = "Postgres is refused by its grants in this test.";
      installCrafted("postgres", { grants: { ungrantedRefusals: sentence } });
      const built = RecordedProvider.built.length;
      const run = mock(async () => "ran");
      const errors = [
        await rejection(createDatabaseProvider(postgres())),
        await rejection(getOrCreateProvider(postgres())),
        await rejection(acquireExecutionProfileProvider(postgres(), "agent-operations")),
        await rejection(withOneShotTunnel(postgres(), run)),
      ];
      for (const error of errors) {
        expect(error).toBeInstanceOf(DatabaseConfigError);
        expect((error as Error).message).toBe(sentence);
      }
      expect(run).not.toHaveBeenCalled();
      expect(RecordedProvider.built.length).toBe(built);
    });

    // A denied file-access posture the record's grant refuses.
    await crafted(async () => {
      const sentence = "Postgres opens no handle under a denied file-access posture in this test.";
      installCrafted("postgres", { grants: { deniedFileAccessRefusal: sentence } });
      const error = await rejection(createDatabaseProvider(postgres(), {}, { allowExternalFileAccess: false }));
      expect((error as Error).message).toBe(sentence);
      expect(await createDatabaseProvider(postgres(), {}, { allowExternalFileAccess: true })).toBeInstanceOf(
        RecordedProvider,
      );
    });
  });

  test("a legacy build reads trust material exactly when its record says the engine reads it", async () => {
    const bundle = path.join(scratch, "empty-bundle.pem");
    writeFileSync(bundle, "");
    process.env.NODE_EXTRA_CA_CERTS = bundle;
    forgetTrustMaterial();
    try {
      // The record's own row reads none, so the invalid bundle refuses nothing.
      await crafted(async () => {
        expect(await createDatabaseProvider(postgres())).toBeInstanceOf(RecordedProvider);
      });
      await crafted(async () => {
        installCrafted("postgres", { connection: { readsTrustMaterial: true } });
        const built = RecordedProvider.built.length;
        const error = await rejection(createDatabaseProvider(postgres()));
        expect(error).toBeInstanceOf(DatabaseConfigError);
        expect((error as Error).message).toStartWith("Invalid NODE_EXTRA_CA_CERTS: ");
        expect(RecordedProvider.built.length).toBe(built);
      });
    } finally {
      delete process.env.NODE_EXTRA_CA_CERTS;
      forgetTrustMaterial();
    }
  });

  test("the single-writer registration and borrow read the record's grants", async () => {
    const sqlite = (): DatabaseConnection =>
      ({
        id: "lite",
        name: "lite",
        type: "sqlite",
        database: path.join(scratch, "single-writer.db"),
        createdAt: new Date(0),
      }) as DatabaseConnection;

    // A record that keeps one handle per file and reads no posture: the handle registers its file, and a caller of
    // either posture borrows it.
    await crafted(async () => {
      installCrafted("sqlite", { grants: { singleWriterFile: true, readsFileAccessPosture: false } });
      const provider = await getOrCreateProvider(sqlite(), {}, { allowExternalFileAccess: true });
      expect(isSingleWriterFileOpen(sqlite())).toBe(true);
      expect(findOpenSingleWriterProvider(sqlite(), false)).toBe(provider);
      expect(findOpenSingleWriterProvider(sqlite(), true)).toBe(provider);
    });

    // The same record reading the posture: only a caller of the handle's own posture borrows it.
    await crafted(async () => {
      installCrafted("sqlite", { grants: { singleWriterFile: true, readsFileAccessPosture: true } });
      const provider = await getOrCreateProvider(sqlite(), {}, { allowExternalFileAccess: true });
      expect(findOpenSingleWriterProvider(sqlite(), false)).toBeNull();
      expect(findOpenSingleWriterProvider(sqlite(), true)).toBe(provider);
    });

    // Studio's own row keeps no single handle for SQLite, so nothing registers.
    await crafted(async () => {
      await getOrCreateProvider(sqlite(), {}, { allowExternalFileAccess: true });
      expect(isSingleWriterFileOpen(sqlite())).toBe(false);
    });
  });

  test("the agent credential form and the agent user refusal read the record", async () => {
    // A record whose form takes no agent credential refuses one before the provider connects.
    await crafted(async () => {
      installCrafted("postgres", { grants: { agentCredentialForm: "none" } });
      const error = await rejection(
        acquireExecutionProfileProvider(
          postgres({ agentUser: "agent", agentPassword: randomUUID() }),
          "agent-operations",
        ),
      );
      expect(error).toBeInstanceOf(StudioProfileRefusal);
      expect((error as Error).message).toContain("and this engine takes none");
    });

    // Studio's row refuses spark's user, so the agent user is refused; a record that refuses no field takes it.
    const spark = (): DatabaseConnection =>
      ({
        id: `spark-${randomUUID()}`,
        name: "spark",
        type: "spark",
        host: "spark.internal",
        port: 10000,
        createdAt: new Date(0),
        agentUser: "agent",
        agentPassword: randomUUID(),
      }) as DatabaseConnection;
    await crafted(async () => {
      const error = await rejection(acquireExecutionProfileProvider(spark(), "agent-operations"));
      expect(error).toBeInstanceOf(StudioProfileRefusal);
      expect((error as Error).message).toContain("and this engine takes no user name");
    });
    await crafted(async () => {
      installCrafted("spark", { connection: { refused: Object.freeze({}) } });
      expect(await acquireExecutionProfileProvider(spark(), "agent-operations")).toBeInstanceOf(RecordedProvider);
    });
  });
});
