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
 * Last, it holds an account row as the superuser so a storage transaction waits on it, ends that
 * transaction's backend with pg_terminate_backend, as a PostgreSQL restart or failover does, and checks
 * that the transaction rejects with 57P01 and the provider keeps serving.
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
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PostgresStorageProvider } from "../../src/lib/storage/providers/postgres";

const SCHEMA = "studio";
const TABLES = ["user_storage", "accounts", "passkey_users", "passkey_credentials", "passkey_spent_challenges"];

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
  console.log("ok   pg_terminate_backend on the backend of an open storage transaction rejects the transaction and the process keeps serving");
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
