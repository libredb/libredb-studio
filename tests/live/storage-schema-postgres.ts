/**
 * Opt-in live check that STORAGE_POSTGRES_SCHEMA keeps every storage table in its named schema.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. tests/unit/lib/storage/providers/postgres.test.ts
 * proves that every statement names the schema, against a mocked `pg`. Only a server shows that the
 * statements then work for the role a governance install runs Studio as: one that owns schema
 * `studio` and has no CREATE on `public`, so a single unqualified table, foreign key or index would
 * fail here instead of landing in `public`.
 *
 * As the superuser in the URL, the script creates a throwaway database and a login role that owns
 * only schema `studio` in it, with PUBLIC's privileges on `public` revoked. It then opens a
 * `PostgresStorageProvider` as that role with STORAGE_POSTGRES_SCHEMA=studio, writes and reads a row
 * of each of the five storage tables, and checks that each table exists in `studio` and none in
 * `public`. It prints one line per table and exits non-zero on the first failure, and it drops the
 * database and the role again either way. A schema that does not exist must fail initialize() with
 * the CREATE SCHEMA hint, which the script checks first.
 * Then it holds an account row as the superuser so a storage transaction waits on it, ends that
 * transaction's backend with pg_terminate_backend, as a PostgreSQL restart or failover does, and checks
 * that the transaction rejects with 57P01 and the provider keeps serving.
 * Last, the credential re-seal (docs/STORAGE.md, "Re-sealing the store") as the same role: rows the
 * previous version wrote are re-sealed as version 2 after a backup of every store table in `studio`;
 * a rewrite that throws part way and a run terminated while it waits for the lock leave the store as
 * it was; two runs at once serialize, one re-sealing and one finding nothing to do; and the documented
 * restore SQL brings the version 1 rows back, which a fresh provider opens again.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in
 * `tests/runner/discover.ts`). CI runs it in the "Functional Smoke (PostgreSQL, RabbitMQ)" job of
 * .github/workflows/ci.yml, against a throwaway postgres:17.
 *
 *   LIBREDB_LIVE_POSTGRES_URL='postgresql://postgres:pk@127.0.0.1:55432/postgres?sslmode=disable' \
 *     bun tests/live/storage-schema-postgres.ts
 *
 * Point it at a DISPOSABLE server, as a superuser: it creates and drops a database and a role.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { withCredentialEncryption } from "../../src/lib/storage/encrypting-provider";
import { resetStorageEncryptionKey } from "../../src/lib/storage/encryption";
import { PostgresStorageProvider } from "../../src/lib/storage/providers/postgres";
import { resealStore } from "../../src/lib/storage/reseal";
import type { ServerStorageProvider } from "../../src/lib/storage/types";
import { sealVersionOne } from "../helpers/storage-envelope-v1";

const SCHEMA = "studio";
const TABLES = [
  "storage_meta",
  "user_storage",
  "accounts",
  "passkey_users",
  "passkey_credentials",
  "passkey_spent_challenges",
];

function superuserUrl(): string {
  const raw = process.env.LIBREDB_LIVE_POSTGRES_URL;
  if (!raw) {
    throw new Error(
      "Set LIBREDB_LIVE_POSTGRES_URL to a disposable PostgreSQL superuser URL, such as " +
        "postgresql://postgres:pk@127.0.0.1:55432/postgres?sslmode=disable. " +
        "The script creates and drops a database and a role on that server.",
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

/** Run every storage table through the provider as the Studio role at `url`; `superuser` reads where they landed. */
async function exerciseTables(url: string, superuser: string): Promise<void> {
  // A schema that does not exist is the operator's to create, never Studio's.
  process.env.STORAGE_POSTGRES_SCHEMA = "absent_schema";
  const absent = new PostgresStorageProvider(url);
  const failure = await absent.initialize().then(
    () => null,
    (error: unknown) => error as Error,
  );
  await absent.close();
  check(
    failure?.message.startsWith(
      "schema absent_schema does not exist: create it with CREATE SCHEMA absent_schema AUTHORIZATION ",
    ) === true,
    `a missing schema should fail with the CREATE SCHEMA hint, got: ${failure?.message ?? "no error"}`,
  );
  console.log("ok   a missing schema fails initialize() with the CREATE SCHEMA hint");

  process.env.STORAGE_POSTGRES_SCHEMA = SCHEMA;
  const provider = new PostgresStorageProvider(url);
  await provider.initialize();
  try {
    const now = new Date().toISOString();
    const email = "schema-check@example.com";
    await provider.insertAccount({
      email,
      passwordHash: "scrypt$check",
      role: "user",
      totpSecret: null,
      totpPending: null,
      disabled: false,
      sessionVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    await provider.setCollection(email, "connections", []);
    await provider.insertPasskey({
      passkey: {
        id: "11111111-1111-4111-8111-111111111111",
        credentialId: "schema-check-credential",
        accountEmail: email,
        publicKey: "pk",
        signCount: 0,
        transports: ["internal"],
        backupEligible: false,
        backupState: false,
        rpId: "studio.example.com",
        name: "Passkey",
        createdAt: now,
        lastUsedAt: null,
      },
      userHandle: "schema-check-handle",
      expectedSessionVersion: 0,
      maxPasskeys: 20,
      challenge: { hash: "ab".repeat(32), expiresAt: new Date(Date.now() + 600_000).toISOString() },
      purgeSpentBefore: now,
    });

    const reads: Record<string, boolean> = {
      storage_meta: (await provider.readEnvelopeState()) === "v1-accepted",
      user_storage: Array.isArray(await provider.getCollection(email, "connections")),
      accounts: (await provider.getAccount(email))?.email === email,
      passkey_users: (await provider.getPasskeyUserHandle(email)) === "schema-check-handle",
      passkey_credentials: (await provider.findPasskey("schema-check-credential"))?.passkey.accountEmail === email,
      // A spent challenge cannot be spent twice: the second registration with it is refused.
      passkey_spent_challenges: false,
    };
    const respent = await provider
      .insertPasskey({
        passkey: {
          id: "22222222-2222-4222-8222-222222222222",
          credentialId: "schema-check-second",
          accountEmail: email,
          publicKey: "pk",
          signCount: 0,
          transports: ["internal"],
          backupEligible: false,
          backupState: false,
          rpId: "studio.example.com",
          name: "Second",
          createdAt: now,
          lastUsedAt: null,
        },
        userHandle: "schema-check-handle",
        expectedSessionVersion: 0,
        maxPasskeys: 20,
        challenge: { hash: "ab".repeat(32), expiresAt: new Date(Date.now() + 600_000).toISOString() },
        purgeSpentBefore: now,
      })
      .then(
        () => "accepted",
        (error: unknown) => (error as { reason?: string }).reason ?? String(error),
      );
    reads.passkey_spent_challenges = respent === "challenge_spent";

    const placed = await asSuperuser(superuser, async (client) => {
      const { rows } = await client.query(
        "SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = ANY($1::text[])",
        [TABLES],
      );
      return rows as { table_schema: string; table_name: string }[];
    });
    for (const table of TABLES) {
      const schemas = placed.filter((row) => row.table_name === table).map((row) => row.table_schema);
      check(
        schemas.length === 1 && schemas[0] === SCHEMA,
        `${table} should exist only in schema ${SCHEMA}, found in: ${schemas.join(", ") || "none"}`,
      );
      check(reads[table], `${table} in schema ${SCHEMA} did not return what was written`);
      console.log(`ok   ${SCHEMA}.${table} created, written and read`);
    }

    await terminateOpenTransaction(provider, url, superuser, email);
  } finally {
    await provider.close();
  }
}

/**
 * A backend that ends during a storage transaction, as a PostgreSQL restart or failover ends it (57P01), must reject
 * that transaction with its own error and leave the process serving. pg-pool stops listening for `error` on a client
 * while it is checked out, so an unlistened event here ends this script, which is the failure this checks.
 */
async function terminateOpenTransaction(
  provider: PostgresStorageProvider,
  url: string,
  superuser: string,
  email: string,
): Promise<void> {
  const role = decodeURIComponent(new URL(url).username);
  const holder = new Client({ connectionString: superuser });
  await holder.connect();
  let pending: Promise<unknown> | undefined;
  try {
    // The superuser holds the account row, so the storage transaction stays open on its FOR UPDATE.
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM ${SCHEMA}.accounts WHERE email = $1 FOR UPDATE`, [email]);
    const now = new Date().toISOString();
    pending = provider
      .insertPasskey({
        passkey: {
          id: "33333333-3333-4333-8333-333333333333",
          credentialId: "schema-check-terminated",
          accountEmail: email,
          publicKey: "pk",
          signCount: 0,
          transports: ["internal"],
          backupEligible: false,
          backupState: false,
          rpId: "studio.example.com",
          name: "Terminated",
          createdAt: now,
          lastUsedAt: null,
        },
        userHandle: "schema-check-handle",
        expectedSessionVersion: 0,
        maxPasskeys: 20,
        challenge: { hash: "cd".repeat(32), expiresAt: new Date(Date.now() + 600_000).toISOString() },
        purgeSpentBefore: now,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    let pid: number | undefined;
    for (let attempt = 0; attempt < 100 && pid === undefined; attempt++) {
      // oxlint-disable-next-line no-await-in-loop -- polls until the storage transaction waits on the lock.
      const { rows } = await holder.query(
        "SELECT pid FROM pg_stat_activity WHERE usename = $1 AND wait_event_type = 'Lock'",
        [role],
      );
      pid = (rows as { pid: number }[])[0]?.pid;
      // oxlint-disable-next-line no-await-in-loop -- the next poll waits a moment.
      if (pid === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check(pid !== undefined, "the storage transaction never waited on the held account row");
    await holder.query("SELECT pg_terminate_backend($1)", [pid]);
    await holder.query("ROLLBACK");
  } finally {
    await holder.end();
  }
  const failure = (await pending) as { code?: string; message?: string } | null;
  check(
    failure?.code === "57P01",
    `the terminated transaction should reject with 57P01, got: ${failure?.code ?? "no code"} ${failure?.message ?? "no error"}`,
  );
  // The socket's end reaches the client after the statement fails; give it the time to arrive.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await provider.mergeData(email, { connections: [] });
  check((await provider.getAccount(email))?.email === email, "the provider stopped serving after the termination");
  console.log(
    "ok   pg_terminate_backend on the backend of an open storage transaction rejects the transaction and the process keeps serving",
  );
}

/** The store as `superuser` reads it: the connections rows, the factors, the marker and the backup tables by schema. */
async function storeState(superuser: string) {
  return asSuperuser(superuser, async (client) => {
    const rows = await client.query(`SELECT user_id, data FROM ${SCHEMA}.user_storage ORDER BY user_id, collection`);
    const factors = await client.query(`SELECT email, totp_secret, totp_pending FROM ${SCHEMA}.accounts ORDER BY email`);
    const marker = await client.query(`SELECT key, value FROM ${SCHEMA}.storage_meta`);
    const backups = await client.query(
      "SELECT table_schema, table_name FROM information_schema.tables WHERE table_name LIKE '%\\_pre\\_reseal\\_%' ORDER BY table_schema, table_name",
    );
    return { rows: rows.rows, factors: factors.rows, marker: marker.rows, backups: backups.rows };
  });
}

/** A Studio storage provider as the factory hands it out, initialized. */
async function sealingProvider(url: string): Promise<ServerStorageProvider> {
  const provider = withCredentialEncryption(new PostgresStorageProvider(url));
  await provider.initialize();
  return provider;
}

/** The re-seal as the role that owns only schema `studio`, from a store the previous version wrote to its restore. */
async function exerciseReseal(url: string, superuser: string): Promise<void> {
  process.env.STORAGE_POSTGRES_SCHEMA = SCHEMA;
  process.env.JWT_SECRET = randomBytes(32).toString("base64url");
  delete process.env.STORAGE_ENCRYPTION_KEY;
  resetStorageEncryptionKey();
  const secrets = { alice: randomUUID(), bob: randomUUID(), factor: randomUUID() };
  const email = "reseal-check@example.com";

  // The previous version's rows: version 1 envelopes, written straight through the provider.
  const raw = new PostgresStorageProvider(url);
  await raw.initialize();
  try {
    for (const [owner, secret] of [
      ["alice", secrets.alice],
      ["bob", secrets.bob],
    ] as const) {
      await raw.setCollection(owner, "connections", [
        { id: `${owner}-c1`, name: owner, type: "postgres", host: `${owner}.internal`, password: sealVersionOne(secret) },
      ] as never);
    }
    await raw.insertAccount({
      email,
      passwordHash: "scrypt$check",
      role: "user",
      totpSecret: sealVersionOne(secrets.factor),
      totpPending: null,
      disabled: false,
      sessionVersion: 0,
      createdAt: "t",
      updatedAt: "t",
    });
  } finally {
    await raw.close();
  }
  const original = await storeState(superuser);
  check(original.backups.length === 0 && original.marker.length === 0, "the store should start with no marker and no backup");

  // A rewrite that throws on a later row rolls everything back, its backup tables included.
  const failing = new PostgresStorageProvider(url);
  await failing.initialize();
  try {
    let calls = 0;
    const failure = await failing
      .rewriteStoredCredentials(
        {
          connections: (_owner, data) => {
            calls += 1;
            if (calls === 2) throw new Error("rewrite failed on a later row");
            return data.replace('"v1:', '"changed:');
          },
          factors: () => null,
        },
        "pre-reseal-20261122T050000Z",
      )
      .then(
        () => null,
        (error: unknown) => error as Error,
      );
    check(failure?.message === "rewrite failed on a later row", `the failing rewrite should reject, got: ${failure?.message}`);
  } finally {
    await failing.close();
  }
  check(JSON.stringify(await storeState(superuser)) === JSON.stringify(original), "a failed re-seal changed the store");
  console.log("ok   a re-seal whose rewrite throws on a later row leaves rows, marker and backups as they were");

  // A run terminated while it waits for the lock leaves the store as it was.
  const role = decodeURIComponent(new URL(url).username);
  const holder = new Client({ connectionString: superuser });
  await holder.connect();
  const waiting = new PostgresStorageProvider(url);
  await waiting.initialize();
  try {
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ${SCHEMA}.storage_meta IN EXCLUSIVE MODE`);
    const pending = waiting
      .rewriteStoredCredentials({ connections: () => null, factors: () => null }, "pre-reseal-20261122T051000Z")
      .then(
        () => null,
        (error: unknown) => error as { code?: string },
      );
    let pid: number | undefined;
    for (let attempt = 0; attempt < 100 && pid === undefined; attempt++) {
      // oxlint-disable-next-line no-await-in-loop -- polls until the re-seal waits on the lock.
      const { rows } = await holder.query(
        "SELECT pid FROM pg_stat_activity WHERE usename = $1 AND wait_event_type = 'Lock'",
        [role],
      );
      pid = (rows as { pid: number }[])[0]?.pid;
      // oxlint-disable-next-line no-await-in-loop -- the next poll waits a moment.
      if (pid === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check(pid !== undefined, "the re-seal never waited on the held lock");
    await holder.query("SELECT pg_terminate_backend($1)", [pid]);
    const failure = await pending;
    check(failure?.code === "57P01", `the terminated re-seal should reject with 57P01, got: ${failure?.code}`);
    await holder.query("ROLLBACK");
  } finally {
    await holder.end();
    await waiting.close();
  }
  check(JSON.stringify(await storeState(superuser)) === JSON.stringify(original), "a terminated re-seal changed the store");
  console.log("ok   a re-seal terminated while it waits for the lock leaves the store as it was");

  // Two runs at once: one re-seals after the backup, the other waits on the lock and finds nothing to do.
  const first = await sealingProvider(url);
  const second = await sealingProvider(url);
  try {
    const reports = await Promise.all([
      resealStore(first, new Date("2026-11-22T05:20:00.000Z")),
      resealStore(second, new Date("2026-11-22T05:20:01.000Z")),
    ]);
    const kinds = reports.map((report) => report.kind).sort();
    check(JSON.stringify(kinds) === '["already-retired","rewritten"]', `two runs should serialize, got: ${kinds.join(", ")}`);
  } finally {
    await first.close();
    await second.close();
  }
  const resealed = await storeState(superuser);
  check(!JSON.stringify(resealed.rows).includes('"v1:'), "a version 1 value survived the re-seal");
  check(
    (resealed.factors as { totp_secret: string | null }[]).every(
      (row) => row.totp_secret === null || row.totp_secret.startsWith("v2:"),
    ),
    "a factor was not re-sealed",
  );
  check(JSON.stringify(resealed.marker) === '[{"key":"credential_envelope","value":"v2"}]', "the marker was not written");
  const backups = resealed.backups as { table_schema: string; table_name: string }[];
  check(
    backups.length === TABLES.length && backups.every((row) => row.table_schema === SCHEMA),
    `every store table should be backed up in ${SCHEMA} and none in public, got: ${JSON.stringify(backups)}`,
  );
  const reader = await sealingProvider(url);
  try {
    const alice = (await reader.getCollection("alice", "connections")) ?? [];
    check(alice[0]?.password === secrets.alice, "a re-sealed value did not open");
    check((await reader.getAccount(email))?.totpSecret === secrets.factor, "a re-sealed factor did not open");
  } finally {
    await reader.close();
  }
  console.log(`ok   two re-seals at once serialize: one re-seals after a backup of all ${TABLES.length} tables in ${SCHEMA}, one finds nothing to do`);

  // The documented restore (docs/STORAGE.md, "Downgrading"), as the role that owns the tables.
  const backupOfRows = backups.find((row) => row.table_name.startsWith("user_storage_pre_reseal_"));
  check(backupOfRows !== undefined, "no backup of user_storage was written");
  const stamp = backupOfRows!.table_name.slice("user_storage_".length);
  const restorer = new Client({ connectionString: url });
  await restorer.connect();
  try {
    await restorer.query("BEGIN");
    await restorer.query(`DELETE FROM ${SCHEMA}.user_storage`);
    await restorer.query(`INSERT INTO ${SCHEMA}.user_storage SELECT * FROM ${SCHEMA}.user_storage_${stamp}`);
    await restorer.query(
      `UPDATE ${SCHEMA}.accounts AS a SET totp_secret = b.totp_secret, totp_pending = b.totp_pending FROM ${SCHEMA}.accounts_${stamp} AS b WHERE a.email = b.email`,
    );
    await restorer.query(`DELETE FROM ${SCHEMA}.storage_meta WHERE key = 'credential_envelope'`);
    await restorer.query("COMMIT");
  } finally {
    await restorer.end();
  }
  const restored = await storeState(superuser);
  check(JSON.stringify(restored.rows) === JSON.stringify(original.rows), "the restore did not bring the rows back");
  check(JSON.stringify(restored.factors) === JSON.stringify(original.factors), "the restore did not bring the factors back");
  check(restored.marker.length === 0, "the restore did not clear the marker");
  const fresh = await sealingProvider(url);
  try {
    check(
      ((await fresh.getCollection("bob", "connections")) ?? [])[0]?.password === secrets.bob,
      "a restored version 1 value did not open",
    );
  } finally {
    await fresh.close();
  }
  console.log("ok   the documented restore SQL brings the version 1 rows back and clears the marker, and they open again");
}

async function main(): Promise<void> {
  const admin = superuserUrl();
  const suffix = randomBytes(4).toString("hex");
  const database = `storage_schema_${suffix}`;
  const role = { name: `storage_schema_${suffix}`, password: randomBytes(16).toString("hex") };

  await asSuperuser(admin, async (client) => {
    await client.query(`CREATE DATABASE ${database}`);
    await client.query(`CREATE ROLE ${role.name} LOGIN PASSWORD '${role.password}'`);
  });
  try {
    await asSuperuser(urlFor(admin, database), async (client) => {
      // The governance install's layout: PUBLIC loses CREATE on public, the Studio role owns studio.
      await client.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
      await client.query(`CREATE SCHEMA ${SCHEMA} AUTHORIZATION ${role.name}`);
      const { rows } = await client.query("SELECT has_schema_privilege($1, 'public', 'CREATE') AS can", [role.name]);
      check((rows as { can: boolean }[])[0].can === false, `${role.name} must not hold CREATE on schema public`);
    });
    await exerciseTables(urlFor(admin, database, role), urlFor(admin, database));
    await exerciseReseal(urlFor(admin, database, role), urlFor(admin, database));
  } catch (error) {
    console.error("FAIL storage tables in a named schema");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await asSuperuser(admin, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await client.query(`DROP ROLE IF EXISTS ${role.name}`);
    });
  }
  if (process.exitCode !== 1) console.log(`All ${TABLES.length} storage tables live in schema ${SCHEMA}.`);
}

await main();
