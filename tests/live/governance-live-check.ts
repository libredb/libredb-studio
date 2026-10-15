/**
 * Opt-in live check of the governance snapshot loader against a real PostgreSQL.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. tests/unit/lib/governance/snapshot.test.ts drives the loader
 * against a fake `pg`, which answers whatever the test tells it to. Only a server shows that the statements the
 * manifest publishes read views of the published shape as `libredb_studio`, that a definition comes back from
 * `jsonb` (with its keys reordered) and still opens the envelope sealed for it, and that a missing privilege surfaces
 * as the SQLSTATE the freshness rules map to `misconfigured`.
 *
 * As the superuser in the URL, the script creates a throwaway database, builds the governance source in it from
 * `tests/fixtures/governance/contract-v1.json` with tests/helpers/governance/fixture-ddl.ts, seeds connections whose
 * credentials the test sealer sealed to a keyring file of a fresh key, and runs Studio's own loader as
 * `libredb_studio`. It prints one line per case, `ok   <case>` or `FAIL <case>` with the reason, exits non-zero when
 * any case failed, and drops the database and the fixture's roles again either way. Later slices add their cases to
 * `CASES`, in the order they run: a case may rely on the state the cases before it left.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 * CI runs it in the "Functional Smoke (PostgreSQL, RabbitMQ)" job of .github/workflows/ci.yml, against a throwaway
 * postgres:17.
 *
 *   LIBREDB_LIVE_POSTGRES_URL='postgresql://postgres:pk@127.0.0.1:55432/postgres?sslmode=disable' \
 *     bun tests/live/governance-live-check.ts
 *
 * Point it at a DISPOSABLE server, as a superuser: it creates and drops a database and the roles `libredb_studio`,
 * `libredb_platform` and `libredb_fixture_owner`.
 */
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { closeGovernancePool } from "../../src/lib/governance/db";
import { governanceFreshness } from "../../src/lib/governance/freshness";
import { resetGovernanceKeyring } from "../../src/lib/governance/keyring";
import { loadGovernanceSnapshot } from "../../src/lib/governance/snapshot";
import { effectiveGrant, governanceState, resetGovernanceState } from "../../src/lib/governance/state";
import { buildFixtureDdl, FIXTURE_OWNER, readFixtureManifest } from "../helpers/governance/fixture-ddl";
import { keyringFileOf, removeKeyringFiles, type TestKey, testKey } from "../helpers/governance/keyring-file";
import { sealSecret } from "../helpers/governance/lsb1-seal";

const MANIFEST = readFixtureManifest();
const SCHEMA = `"${MANIFEST.schema}"`;
const ROLES = [FIXTURE_OWNER, "libredb_platform", "libredb_studio"];

function superuserUrl(): string {
  const raw = process.env.LIBREDB_LIVE_POSTGRES_URL;
  if (!raw) {
    throw new Error(
      "Set LIBREDB_LIVE_POSTGRES_URL to a disposable PostgreSQL 17 superuser URL, such as " +
        "postgresql://postgres:pk@127.0.0.1:55432/postgres?sslmode=disable. " +
        "The script creates and drops a database and the governance roles on that server.",
    );
  }
  return raw;
}

/** The same server and options as `base`, as `user` on `database`. */
function urlFor(base: string, database: string, user?: { name: string; password: string }): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

async function asSuperuser<T>(url: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, what: string): void {
  const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
  check(a === e, `${what}: expected ${e}, got ${a}`);
}

/** What every case can reach: the fixture database as the superuser, and the key the seeded envelopes are sealed to. */
interface LiveContext {
  readonly superuser: (run: (client: Client) => Promise<unknown>) => Promise<unknown>;
  readonly key: TestKey;
}

const DEFINITION = { host: "orders.db.example.internal", port: 5432, database: "orders", ssl: { mode: "require" } };
const READ = { user: "reader", password: "example-only-read-password" };
const WRITE = { user: "writer", password: "example-only-write-password" };
/** A grant expiry well in the future, so no case races it. */
const LATER = new Date("2099-01-01T00:00:00.000Z");

interface SeedConnection {
  readonly id: string;
  readonly engine?: string;
  readonly definition?: Readonly<Record<string, unknown>>;
  /** Seal the write envelope too; `"foreign"` seals it for another connection's binding. */
  readonly write?: true | "foreign";
  /** Seal the read envelope to a key this Studio does not hold. */
  readonly readToUnknownKey?: true;
}

/** One row of each fate admission can give a row: admitted with both levels, read only, and four skips. */
const CONNECTIONS: readonly SeedConnection[] = [
  { id: "live-both", write: true },
  { id: "live-read-only", write: "foreign" },
  { id: "live-unknown-key", readToUnknownKey: true },
  { id: "live-secret-in-definition", definition: { ...DEFINITION, password: "example-only-inline-password" } },
  { id: "live-server-level", definition: { host: "orders.db.example.internal", port: 5432 } },
  { id: "live-file-engine", engine: "sqlite", definition: { database: "/data/orders.db" } },
];

const GRANTS = [
  { subject: "alice@example.com", connection: "live-both", level: "write", expires: null },
  { subject: "alice@example.com", connection: "live-read-only", level: "write", expires: null },
  { subject: "alice@example.com", connection: "live-secret-in-definition", level: "read", expires: null },
  { subject: "bob@example.com", connection: "live-both", level: "read", expires: LATER },
] as const;

async function seed(client: Client, key: TestKey): Promise<void> {
  await client.query(
    `INSERT INTO ${SCHEMA}.contract_source (version, status, sunset_after, notify_channel) VALUES ($1, 'current', NULL, $2)`,
    [MANIFEST.contractVersion, MANIFEST.notification.channel],
  );
  const stranger = testKey();
  const connections = CONNECTIONS.map((row) => {
    const engine = row.engine ?? "postgres";
    const definition = row.definition ?? DEFINITION;
    const seal = (level: "read" | "write", secret: Readonly<Record<string, string>>, to: TestKey, id = row.id) =>
      sealSecret(to.publicKey, { connectionId: id, level, engine, definition }, secret);
    const read = seal("read", READ, row.readToUnknownKey ? stranger : key);
    const write =
      row.write === undefined ? null : seal("write", WRITE, key, row.write === "foreign" ? "live-both" : row.id);
    return { id: row.id, name: `Connection ${row.id}`, engine, definition, read, write };
  });
  // One statement per table: jsonb_to_recordset turns the rows, passed as one JSON parameter, into a set.
  await client.query(
    `INSERT INTO ${SCHEMA}.connections_v1_source (connection_id, name, engine, environment, group_name, color, definition, read_secret, write_secret, mcp_enabled, updated_at)
     SELECT id, name, engine, 'production', NULL, NULL, definition, read, write, false, now()
     FROM jsonb_to_recordset($1::jsonb) AS r(id text, name text, engine text, definition jsonb, read text, write text)`,
    [JSON.stringify(connections)],
  );
  await client.query(
    `INSERT INTO ${SCHEMA}.grants_v1_source (subject, connection_id, level, expires_at, downgraded, granted_at)
     SELECT subject, connection, level, expires, false, now()
     FROM jsonb_to_recordset($1::jsonb) AS r(subject text, connection text, level text, expires timestamptz)`,
    [JSON.stringify(GRANTS)],
  );
}

interface LiveCase {
  readonly name: string;
  readonly run: (context: LiveContext) => Promise<void>;
}

function loadedSnapshot() {
  const { snapshot, failure } = governanceState();
  check(failure === null, `the load failed: ${failure?.detail ?? ""}`);
  check(snapshot !== null, "no snapshot was loaded");
  return snapshot as NonNullable<typeof snapshot>;
}

const CASES: readonly LiveCase[] = [
  {
    name: "the snapshot loads as libredb_studio from views built from the manifest",
    run: async () => {
      await loadGovernanceSnapshot();
      const snapshot = loadedSnapshot();
      same(governanceFreshness(), "ok", "freshness");
      same(snapshot.contractVersion, 1, "contract version");
      same(snapshot.publishedVersions, [1], "published versions");
    },
  },
  {
    name: "rows are admitted or skipped with the expected codes",
    run: async () => {
      const snapshot = loadedSnapshot();
      same(
        [...snapshot.connections.values()].map((connection) => [connection.id, connection.write !== undefined]),
        [
          ["live-both", true],
          ["live-read-only", false],
        ],
        "admitted connections and whether each has a write level",
      );
      same(
        snapshot.skipped.map((skip) => [skip.item, skip.envelopeCode ?? null]),
        [
          [
            { kind: "connection", id: "live-read-only", level: "write", code: "WRITE_SECRET_UNOPENABLE" },
            "AUTH_FAILED",
          ],
          [
            { kind: "connection", id: "live-unknown-key", level: "read", code: "READ_SECRET_UNOPENABLE" },
            "UNKNOWN_KID",
          ],
          [
            { kind: "connection", id: "live-secret-in-definition", path: "password", code: "DEFINITION_HAS_SECRET" },
            null,
          ],
          [{ kind: "connection", id: "live-server-level", path: "database", code: "SERVER_LEVEL_NOT_ALLOWED" }, null],
          [{ kind: "connection", id: "live-file-engine", code: "ENGINE_UNSUPPORTED" }, null],
        ],
        "skipped rows",
      );
    },
  },
  {
    name: "effective grants match the grant rows on admitted connections",
    run: async () => {
      const snapshot = loadedSnapshot();
      const now = Date.now();
      const grants = [...snapshot.grants].map(([subject, bySubject]) => [
        subject,
        [...bySubject.keys()].map((id) => {
          const grant = effectiveGrant(snapshot, subject, id, now);
          return [id, grant?.level ?? null, grant?.expiresAt ?? null];
        }),
      ]);
      same(
        grants,
        [
          [
            "alice@example.com",
            [
              ["live-both", "write", null],
              ["live-read-only", "read", null],
            ],
          ],
          ["bob@example.com", [["live-both", "read", LATER.getTime()]]],
        ],
        "effective grants",
      );
    },
  },
  {
    name: "revoking SELECT on one view turns the state misconfigured, naming that view",
    run: async ({ superuser }) => {
      await superuser((client) => client.query(`REVOKE SELECT ON ${SCHEMA}.grants_v1 FROM libredb_studio`));
      await loadGovernanceSnapshot();
      const { failure } = governanceState();
      same(governanceFreshness(), "misconfigured", "freshness");
      same(failure?.code ?? null, "42501", "SQLSTATE");
      check(
        failure?.detail.startsWith(`${MANIFEST.schema}.grants_v1: `) === true,
        `the failure should name ${MANIFEST.schema}.grants_v1, got: ${failure?.detail ?? "no failure"}`,
      );
    },
  },
];

async function main(): Promise<void> {
  const admin = superuserUrl();
  const database = `governance_live_${randomBytes(4).toString("hex")}`;
  const studio = { name: "libredb_studio", password: randomBytes(16).toString("hex") };
  const ddl = buildFixtureDdl(MANIFEST, { studioPassword: studio.password });
  const key = testKey();
  const fixture = urlFor(admin, database);

  await asSuperuser(admin, async (client) => {
    await client.query(`CREATE DATABASE ${database}`);
    // One simple query runs the statements in order and stops at the first that fails.
    await client.query(ddl.roles.join(";\n"));
  });
  let failed = 0;
  try {
    await asSuperuser(fixture, async (client) => {
      await client.query(ddl.objects.join(";\n"));
      await seed(client, key);
    });
    process.env.GOVERNANCE_SOURCE = "postgres";
    process.env.GOVERNANCE_POSTGRES_URL = urlFor(admin, database, studio);
    process.env.GOVERNANCE_PRIVATE_KEYS_FILE = keyringFileOf(key);
    process.env.LOG_LEVEL ??= "error";
    const context: LiveContext = { superuser: (run) => asSuperuser(fixture, run), key };
    for (const liveCase of CASES) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- the cases run in order, each on the state the one before it left.
        await liveCase.run(context);
        console.log(`ok   ${liveCase.name}`);
      } catch (error) {
        failed += 1;
        console.error(`FAIL ${liveCase.name}`);
        console.error(error);
      }
    }
  } catch (error) {
    failed += 1;
    console.error("FAIL building the governance fixture");
    console.error(error);
  } finally {
    await closeGovernancePool();
    resetGovernanceState();
    resetGovernanceKeyring();
    removeKeyringFiles();
    await asSuperuser(admin, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await client.query(`DROP ROLE IF EXISTS ${ROLES.join(", ")}`);
    });
  }
  if (failed > 0) {
    console.error(`${failed} of ${CASES.length} governance live cases failed.`);
    process.exitCode = 1;
  } else {
    console.log(`All ${CASES.length} governance live cases passed.`);
  }
}

await main();
