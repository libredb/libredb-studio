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
 * The listener cases start Studio's change notification listener with its production reload and no refresher, so a
 * snapshot changes only when a notification makes it, and with a ping every half second instead of every minute.
 * The heartbeat cases send beats as `libredb_studio` and read the row back as the superuser. The session revocation
 * case runs the real `getSession()` with `next/headers` mocked by a cookie jar, on sessions signed with a throwaway
 * `JWT_SECRET`. The query event cases record events through Studio's own sink, which inserts them as
 * `libredb_studio` on its one-second flush, and read the rows back as the superuser.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 * CI runs it in the "Functional Smoke (PostgreSQL, RabbitMQ)" job of .github/workflows/ci.yml, against a throwaway
 * postgres:17.
 *
 *   LIBREDB_LIVE_POSTGRES_URL='postgresql://postgres:pk@127.0.0.1:55432/postgres?sslmode=disable' \
 *     bun tests/live/governance-live-check.ts
 *
 * Point it at a DISPOSABLE server, as a superuser: it creates and drops a database and the roles `libredb_studio`,
 * `libredb_platform`, `libredb_fixture_owner` and `libredb_live_target`. The revocation case opens a governed
 * connection to that same server, as `libredb_live_target`, so Studio must reach it at the host and port of the URL.
 */
import { randomBytes } from "node:crypto";
import { Client, type Notification } from "pg";
import { editorExecutionContext } from "../../src/lib/api/execution-context";
import type { UserPayload } from "../../src/lib/auth";
import { clearProviderCache, getOrCreateProvider, getProviderCacheStats } from "../../src/lib/db/factory";
import { pingChannel } from "../../src/lib/governance/contract";
import { closeGovernancePool } from "../../src/lib/governance/db";
import { governanceFreshness } from "../../src/lib/governance/freshness";
import { sendGovernanceHeartbeat } from "../../src/lib/governance/heartbeat";
import { canonicalJson } from "../../src/lib/governance/jcs";
import { resetGovernanceKeyring } from "../../src/lib/governance/keyring";
import {
  governanceListenerStatus,
  startGovernanceListener,
  stopGovernanceListener,
} from "../../src/lib/governance/listener";
import { loadGovernanceSnapshot } from "../../src/lib/governance/snapshot";
import { requestFreshGovernanceLoad } from "../../src/lib/governance/start";
import { effectiveGrant, governanceState, resetGovernanceState } from "../../src/lib/governance/state";
import { buildQueryEvent, queryEventPolicy } from "../../src/lib/query-events/build";
import { writeQueryEventBatch } from "../../src/lib/query-events/postgres-sink";
import { queryEventSinkState, recordQueryEvent, resetQueryEventSink } from "../../src/lib/query-events/sink";
import type { QueryEventInput } from "../../src/lib/query-events/types";
import { resolveConnection, SeedConnectionError } from "../../src/lib/seed/resolve-connection";
import { buildFixtureDdl, FIXTURE_OWNER, readFixtureManifest } from "../helpers/governance/fixture-ddl";
import { keyringFileOf, removeKeyringFiles, type TestKey, testKey } from "../helpers/governance/keyring-file";
import { queryEventInput, startInTheFuture } from "../helpers/governance/query-event-input";
import { sealSecret } from "../helpers/governance/lsb1-seal";
import { cookieJar, deletedCookies, installNextHeadersMock, resetCookieJar } from "../helpers/next-cookie-jar";
import packageJson from "../../package.json";

// getSession() reads the session cookie through next/headers, which only a Next.js request provides.
installNextHeadersMock();
const { getSession, signJWT } = await import("../../src/lib/auth");

const MANIFEST = readFixtureManifest();
const SCHEMA = `"${MANIFEST.schema}"`;
/** The role a governed connection to the fixture server writes as: the credential its envelopes carry. */
const TARGET_ROLE = "libredb_live_target";
const ROLES = [FIXTURE_OWNER, "libredb_platform", "libredb_studio", TARGET_ROLE];
const INSTANCE_ID = "libredb-studio-live-check";
/** How often the live check's listener pings itself, so the ping case waits seconds rather than minutes. */
const PING_INTERVAL_MS = 500;
/** The identity provider the sessions of the live check name, as `OIDC_ISSUER`. */
const OIDC_ISSUER = "https://idp.example/realms/libredb";
const SESSION_COOKIE = "auth-token";

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
  /** The superuser URL of the fixture database: the server a governed connection of a case can point at. */
  readonly fixtureUrl: string;
}

/** The transaction session of the PostgreSQL provider, which `POST /api/db/transaction` drives. */
interface LiveTransactionProvider {
  beginTransaction(): Promise<unknown>;
  queryInTransaction(sql: string): Promise<unknown>;
  isInTransaction(): boolean;
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

/** The binding every canary is sealed for (spec 8.4). */
const CANARY_BINDING = { connectionId: "canary", level: "read", engine: "canary", definition: {} } as const;

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
  // The control plane's canary for the key Studio holds (spec 8.4).
  await client.query(`INSERT INTO ${SCHEMA}.seal_canary_v1_source (kid, envelope, created_at) VALUES ($1, $2, now())`, [
    key.kid,
    sealSecret(key.publicKey, CANARY_BINDING, { user: "libredb-canary" }),
  ]);
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

/** Runs `run` while holding back what it writes to stdout, such as an audit line, so the script prints only its own. */
async function capturingStdout<T>(run: () => Promise<T>): Promise<{ readonly result: T; readonly lines: string[] }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  };
  try {
    return { result: await run(), lines };
  } finally {
    console.log = log;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `condition` holds, polling every 10 ms, and fails when it does not within `withinMs`. */
async function until(condition: () => boolean, withinMs: number, what: string): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    check(Date.now() - started <= withinMs, `${what} did not happen within ${withinMs} ms`);
    // oxlint-disable-next-line no-await-in-loop -- the condition is polled in order, one wait at a time.
    await sleep(10);
  }
}

/** The payload of the first notification `client` hears, or a failure when none arrives within `withinMs`. */
function nextNotification(client: Client, withinMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no notification arrived within ${withinMs} ms`)), withinMs);
    client.once("notification", (message: Notification) => {
      clearTimeout(timer);
      resolve(message.payload ?? "");
    });
  });
}

/** An editor statement Alice ran on her granted connection, as a route records it. */
const aliceEvent = (overrides: Partial<QueryEventInput>): QueryEventInput =>
  queryEventInput({
    principal: { subject: "alice@example.com", username: "alice@example.com", role: "user" },
    connection: { id: "seed:live-both", name: "Connection live-both", engine: "postgres", accessLevel: "write" },
    ...overrides,
  });

/** The query event rows whose correlation id starts with `prefix`, read as the superuser, in correlation id order. */
async function eventRows(context: LiveContext, prefix: string): Promise<Record<string, unknown>[]> {
  const result = (await context.superuser((client) =>
    client.query(
      `SELECT event_id::text AS event_id, correlation_id, subject, connection_id, source, status, error_code,
              studio_instance, contract_version, received_at IS NOT NULL AS received
       FROM ${SCHEMA}.query_event WHERE starts_with(correlation_id, $1) ORDER BY correlation_id`,
      [prefix],
    ),
  )) as { rows: Record<string, unknown>[] };
  return result.rows;
}

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** The sink state, with whether it names a last flush in place of the instant. */
function sinkStateFlushed(): Record<string, unknown> {
  const state = queryEventSinkState();
  return { ...state, lastFlushAt: state.lastFlushAt !== null };
}

/** Waits until the sink has inserted, or refused, every event it holds. */
const untilSinkDrained = (): Promise<void> =>
  until(() => queryEventSinkState().queued === 0, 5000, "the flush of the queued query events");

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
    name: "deleting a grant row makes resolveConnection answer 404 after the next load",
    run: async ({ superuser }) => {
      const bob = { role: "user", username: "bob@example.com", idpSubject: "bob@example.com" };
      const opened = await resolveConnection({ connectionId: "seed:live-both" }, bob);
      same([opened.user, opened.password], [READ.user, READ.password], "the credential Bob's read grant opens");

      await superuser((client) =>
        client.query(`DELETE FROM ${SCHEMA}.grants_v1_source WHERE subject = $1 AND connection_id = $2`, [
          bob.idpSubject,
          "live-both",
        ]),
      );
      await loadGovernanceSnapshot();
      loadedSnapshot();

      const { result: refusal, lines } = await capturingStdout(() =>
        resolveConnection({ connectionId: "seed:live-both" }, bob).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      check(refusal instanceof SeedConnectionError, `expected a SeedConnectionError, got ${String(refusal)}`);
      const { statusCode, code } = refusal as SeedConnectionError;
      same([statusCode, code], [404, "CONNECTION_NOT_FOUND"], "the refusal");
      const audit = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      same(
        audit.map(({ event, reason, actor, connection }) => [event, reason, actor, connection]),
        [["permission_denied", "connection_not_granted", bob.username, "live-both"]],
        "the audit line of the miss",
      );
    },
  },
  {
    name: "a NOTIFY round trip arrives",
    run: async ({ superuser }) => {
      startGovernanceListener(requestFreshGovernanceLoad, { pingIntervalMs: PING_INTERVAL_MS });
      await until(() => governanceListenerStatus()?.state === "listening", 10_000, "the listener's LISTEN");
      same(governanceListenerStatus()?.lastNotificationAt ?? null, null, "the last notification before any was sent");

      const sentAt = Date.now();
      await superuser((client) =>
        client.query("SELECT pg_notify($1, $2)", [
          MANIFEST.notification.channel,
          JSON.stringify({ v: MANIFEST.notification.payloadVersion, kind: "settings" }),
        ]),
      );
      await until(
        () => (governanceListenerStatus()?.lastNotificationAt ?? 0) >= sentAt,
        2000,
        "the notification's arrival at the listener",
      );
    },
  },
  {
    name: "the ping arrives on the instance channel",
    run: async ({ superuser }) => {
      const heardBefore = governanceListenerStatus()?.lastNotificationAt ?? null;
      // A second session that listens on the instance's ping channel hears the listener's own ping there.
      const nonce = await superuser(async (client) => {
        await client.query(`LISTEN ${pingChannel(INSTANCE_ID)}`);
        return nextNotification(client, PING_INTERVAL_MS * 4);
      });
      check(/^[0-9a-f]{16}$/.test(String(nonce)), `a ping should carry a 16 hex digit nonce, got ${String(nonce)}`);
      // Two missed pings would make the listener deaf, so still listening after three intervals means they came back.
      await sleep(PING_INTERVAL_MS * 3);
      same(governanceListenerStatus()?.state, "listening", "the listener's state after three ping intervals");
      same(governanceListenerStatus()?.lastNotificationAt ?? null, heardBefore, "the last notification after pings");
    },
  },
  {
    name: "deleting a grant makes resolveConnection answer 404 within 1 s with no explicit reload",
    run: async ({ superuser }) => {
      const alice = { role: "user", username: "alice@example.com", idpSubject: "alice@example.com" };
      await resolveConnection({ connectionId: "seed:live-both" }, alice);

      const deletedAt = Date.now();
      await superuser((client) =>
        client.query(`DELETE FROM ${SCHEMA}.grants_v1_source WHERE subject = $1 AND connection_id = $2`, [
          alice.idpSubject,
          "live-both",
        ]),
      );
      // Nothing here loads the snapshot: the trigger's notification makes the listener reload it.
      const { result: refusal } = await capturingStdout(async () => {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- one attempt at a time, until the refusal or the deadline.
          const outcome = await resolveConnection({ connectionId: "seed:live-both" }, alice).then(
            () => undefined,
            (error: unknown) => error,
          );
          if (outcome !== undefined || Date.now() - deletedAt > 1000) return outcome;
          // oxlint-disable-next-line no-await-in-loop -- the next attempt waits for this one's pause.
          await sleep(10);
        }
      });
      const elapsed = Date.now() - deletedAt;
      check(
        refusal instanceof SeedConnectionError,
        `expected a SeedConnectionError within 1 s, got ${String(refusal)}`,
      );
      const { statusCode, code } = refusal as SeedConnectionError;
      same([statusCode, code], [404, "CONNECTION_NOT_FOUND"], "the refusal");
      check(elapsed <= 1000, `the refusal took ${elapsed} ms, more than 1 s`);
    },
  },
  {
    name: "the heartbeat row appears for the instance with the canary ok",
    run: async ({ superuser, key }) => {
      await loadGovernanceSnapshot();
      same(loadedSnapshot().canary, { [key.kid]: "ok" }, "the canary results of the snapshot");
      await sendGovernanceHeartbeat();
      const rows = (await superuser((client) =>
        client.query(
          `SELECT instance_id, studio_version, supported_contracts, contract_version, keyring_kids, listener_state, skipped, sink, canary FROM ${SCHEMA}.studio_instances_v1`,
        ),
      )) as { rows: Record<string, unknown>[] };
      same(rows.rows.length, 1, "heartbeat rows");
      const { skipped, sink, canary, ...columns } = rows.rows[0];
      same(
        columns,
        {
          instance_id: INSTANCE_ID,
          studio_version: packageJson.version,
          supported_contracts: [1],
          contract_version: 1,
          keyring_kids: [key.kid],
          listener_state: "listening",
        },
        "the heartbeat row",
      );
      // jsonb keeps its keys in its own order, so the JSON columns are compared in canonical form.
      same(
        canonicalJson({ skipped, sink, canary }),
        canonicalJson({
          skipped: loadedSnapshot().skipped.map(({ item }) => item),
          sink: { queued: 0, dropped: 0, rejected: 0, lastFlushAt: null, backingOff: false, lastSqlstate: null },
          canary: { [key.kid]: "ok" },
        }),
        "the heartbeat's JSON columns",
      );
    },
  },
  {
    name: "a second beat advances last_seen_at and keeps started_at",
    run: async ({ superuser }) => {
      const read = async () =>
        (
          (await superuser((client) =>
            client.query(
              `SELECT started_at, last_seen_at, snapshot_loaded_at FROM ${SCHEMA}.studio_instances_v1 WHERE instance_id = $1`,
              [INSTANCE_ID],
            ),
          )) as { rows: { started_at: Date; last_seen_at: Date; snapshot_loaded_at: Date }[] }
        ).rows[0];
      const first = await read();
      // now() is the start of the beat's transaction, so a few milliseconds apart are enough to tell two beats apart.
      await sleep(20);
      await sendGovernanceHeartbeat();
      const second = await read();
      check(
        second.last_seen_at.getTime() > first.last_seen_at.getTime(),
        `last_seen_at should advance, got ${first.last_seen_at.toISOString()} then ${second.last_seen_at.toISOString()}`,
      );
      same(second.started_at.toISOString(), first.started_at.toISOString(), "started_at after the second beat");
      check(
        Math.abs(second.started_at.getTime() - performance.timeOrigin) < 1,
        `started_at should be the process start time, got ${second.started_at.toISOString()}`,
      );
      same(
        second.snapshot_loaded_at.getTime(),
        loadedSnapshot().loadedAt,
        "snapshot_loaded_at, the load time of the snapshot in use",
      );
    },
  },
  {
    name: "revoking a grant during an open transaction on a governed connection to the fixture server removes the uncommitted row within 2 s",
    run: async ({ superuser, key, fixtureUrl }) => {
      const alice = { role: "user", username: "alice@example.com", idpSubject: "alice@example.com" };
      const credential = { user: TARGET_ROLE, password: randomBytes(16).toString("hex") };
      // The fixture server itself, as Studio reaches it, so the governed connection really opens.
      const server = new URL(fixtureUrl);
      const definition = {
        host: server.hostname,
        port: Number(server.port || 5432),
        database: server.pathname.slice(1),
        ssl: { mode: server.searchParams.get("sslmode") ?? "disable" },
      };
      const seal = (level: "read" | "write") =>
        sealSecret(key.publicKey, { connectionId: "live-target", level, engine: "postgres", definition }, credential);
      await superuser(async (client) => {
        await client.query(
          `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${TARGET_ROLE}') THEN CREATE ROLE ${TARGET_ROLE}; END IF; END $$`,
        );
        await client.query(`ALTER ROLE ${TARGET_ROLE} LOGIN PASSWORD '${credential.password}'`);
        await client.query("CREATE TABLE public.live_revocation (id integer PRIMARY KEY, written_by text NOT NULL)");
        await client.query(`GRANT SELECT, INSERT ON public.live_revocation TO ${TARGET_ROLE}`);
        // The connection and Alice's write grant on it arrive together, in one commit and so in one reload.
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO ${SCHEMA}.connections_v1_source (connection_id, name, engine, environment, group_name, color, definition, read_secret, write_secret, mcp_enabled, updated_at)
           VALUES ('live-target', 'Connection live-target', 'postgres', 'production', NULL, NULL, $1, $2, $3, false, now())`,
          [JSON.stringify(definition), seal("read"), seal("write")],
        );
        await client.query(
          `INSERT INTO ${SCHEMA}.grants_v1_source (subject, connection_id, level, expires_at, downgraded, granted_at)
           VALUES ($1, 'live-target', 'write', NULL, false, now())`,
          [alice.idpSubject],
        );
        await client.query("COMMIT");
      });
      await until(
        () => {
          const { snapshot } = governanceState();
          return (
            snapshot !== null && effectiveGrant(snapshot, alice.idpSubject, "live-target", Date.now()) !== undefined
          );
        },
        2000,
        "the arrival of Alice's write grant",
      );

      // Alice opens a transaction on her own provider, as the transaction route does, and writes a row in it.
      const record = await resolveConnection({ connectionId: "seed:live-target" }, alice);
      const opened = await getOrCreateProvider(record, {}, editorExecutionContext(alice, record));
      const provider = opened as unknown as LiveTransactionProvider;
      await provider.beginTransaction();
      await provider.queryInTransaction("INSERT INTO public.live_revocation (id, written_by) VALUES (1, 'alice')");

      // The control plane revokes the grant. Nothing here reloads the snapshot or removes a provider.
      const revokedAt = Date.now();
      await superuser((client) =>
        client.query(`DELETE FROM ${SCHEMA}.grants_v1_source WHERE subject = $1 AND connection_id = 'live-target'`, [
          alice.idpSubject,
        ]),
      );
      // Another session writes the same key: it waits for Alice's transaction to end, and succeeds only once that
      // transaction rolled back and took her uncommitted row with it, because a commit would make the key a duplicate.
      await superuser(async (client) => {
        await client.query("SET statement_timeout = 2000");
        await client.query("INSERT INTO public.live_revocation (id, written_by) VALUES (1, 'probe')");
      }).catch((error: unknown) => {
        throw new Error(`Alice's uncommitted row still held its key 2 s after the revocation: ${String(error)}`);
      });
      const elapsed = Date.now() - revokedAt;
      check(elapsed <= 2000, `the uncommitted row was removed ${elapsed} ms after the revocation, more than 2 s`);
      const table = (await superuser((client) => client.query("SELECT written_by FROM public.live_revocation"))) as {
        rows: unknown[];
      };
      same(table.rows, [{ written_by: "probe" }], "the rows of the table");
      same(provider.isInTransaction(), false, "whether Alice's provider holds a transaction");
      same(getProviderCacheStats().connections, [], "the providers still cached");
    },
  },
  {
    name: "a revocation row makes getSession refuse the older session within 2 s",
    run: async ({ superuser }) => {
      // What the OIDC callback mints for Carol.
      const carol: UserPayload = {
        role: "user",
        username: "carol@example.com",
        idpSubject: "carol@example.com",
        idpIssuer: OIDC_ISSUER,
      };
      const holdSession = async () => {
        resetCookieJar();
        cookieJar.set(SESSION_COOKIE, { value: await signJWT(carol) });
      };
      await holdSession();
      same((await getSession())?.idpSubject ?? null, carol.idpSubject, "the subject of Carol's session before");

      // The control plane ends Carol's sessions. Nothing here reloads the snapshot: the trigger's notification does.
      const revokedAt = Date.now();
      const inserted = (await superuser((client) =>
        client.query(
          `INSERT INTO ${SCHEMA}.session_revocations_v1_source (subject, revoked_before) VALUES ($1, now()) RETURNING revoked_before`,
          [carol.idpSubject],
        ),
      )) as { rows: { revoked_before: Date }[] };
      // oxlint-disable-next-line no-await-in-loop -- one check at a time, until the refusal or the deadline.
      while ((await getSession()) !== null) {
        check(
          Date.now() - revokedAt <= 2000,
          "getSession still accepted Carol's older session 2 s after the revocation",
        );
        // oxlint-disable-next-line no-await-in-loop -- the next check waits for this one's pause.
        await sleep(10);
      }
      const elapsed = Date.now() - revokedAt;
      check(elapsed <= 2000, `getSession refused the older session ${elapsed} ms after the revocation, more than 2 s`);
      check(
        deletedCookies.some((cookie) => cookie.name === SESSION_COOKIE),
        "the refused session's cookie was not cleared",
      );

      // The token's iat counts whole seconds, so the first session issued after revoked_before is signed in the next.
      const revokedBefore = inserted.rows[0].revoked_before.getTime();
      await sleep(Math.max(0, Math.floor(revokedBefore / 1000) * 1000 + 1000 - Date.now()));
      await holdSession();
      same((await getSession())?.idpSubject ?? null, carol.idpSubject, "the subject of a session signed after it");
    },
  },
  {
    name: "events insert as libredb_studio, which holds only INSERT",
    run: async (context) => {
      const privileges = async (object: string) =>
        (
          (await context.superuser((client) =>
            client.query(
              `SELECT privilege FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS privilege
               WHERE has_table_privilege('libredb_studio', $1, privilege)`,
              [`${SCHEMA}.${object}`],
            ),
          )) as { rows: { privilege: string }[] }
        ).rows.map((row) => row.privilege);
      same(await privileges("query_events_v1"), ["INSERT"], "the privileges of libredb_studio on query_events_v1");
      same(await privileges("query_event"), [], "the privileges of libredb_studio on query_event");

      recordQueryEvent(aliceEvent({ correlationId: "live-insert-1" }));
      recordQueryEvent(aliceEvent({ correlationId: "live-insert-2", status: "error", errorCode: "42P01" }));
      await untilSinkDrained();

      same(
        (await eventRows(context, "live-insert-")).map((row) =>
          Object.assign(row, { event_id: UUID.test(String(row.event_id)) }),
        ),
        ["live-insert-1", "live-insert-2"].map((correlation_id, index) => ({
          event_id: true,
          correlation_id,
          subject: "alice@example.com",
          connection_id: "live-both",
          source: "editor",
          status: index === 0 ? "success" : "error",
          error_code: index === 0 ? null : "42P01",
          studio_instance: INSTANCE_ID,
          contract_version: 1,
          received: true,
        })),
        "the query event rows",
      );
      same(
        sinkStateFlushed(),
        { queued: 0, dropped: 0, rejected: 0, lastFlushAt: true, backingOff: false, lastSqlstate: null },
        "the sink state, and whether it names a last flush",
      );
    },
  },
  {
    name: "a retried batch adds no duplicate",
    run: async (context) => {
      const instance = { studioInstance: INSTANCE_ID };
      const batch = ["live-retry-1", "live-retry-2"].map((correlationId) =>
        buildQueryEvent(aliceEvent({ correlationId }), queryEventPolicy(), instance),
      );
      const first = await writeQueryEventBatch(batch, AbortSignal.timeout(10_000));
      same([first.settled, first.rejections, first.failure], [2, [], null], "the first insert");
      // An insert whose answer was lost is sent again with the same event ids, alone or with newer events.
      const retry = await writeQueryEventBatch(batch, AbortSignal.timeout(10_000));
      same([retry.settled, retry.rejections, retry.failure], [2, [], null], "the retried insert");
      const newer = buildQueryEvent(aliceEvent({ correlationId: "live-retry-3" }), queryEventPolicy(), instance);
      const mixed = await writeQueryEventBatch([batch[1], newer], AbortSignal.timeout(10_000));
      same([mixed.settled, mixed.rejections, mixed.failure], [2, [], null], "the insert that repeats one event");

      same(
        (await eventRows(context, "live-retry-")).map((row) => [row.correlation_id, row.event_id]),
        [...batch, newer].map((row) => [row.correlation_id, row.event_id]),
        "the query event rows, one per event id",
      );
    },
  },
  {
    name: "an event 10 minutes in the future is rejected while the rest of its batch lands",
    run: async (context) => {
      const { lines } = await capturingStdout(async () => {
        recordQueryEvent(aliceEvent({ correlationId: "live-future-1" }));
        recordQueryEvent(aliceEvent({ correlationId: "live-future-2", started: startInTheFuture() }));
        recordQueryEvent(aliceEvent({ correlationId: "live-future-3" }));
        await untilSinkDrained();
      });
      const rejections = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      same(
        rejections.map((line) => ({
          type: line.type,
          event_id: UUID.test(String(line.event_id)),
          sqlstate: line.sqlstate,
          constraint: line.constraint,
        })),
        [{ type: "query_event_rejected", event_id: true, sqlstate: "23514", constraint: "query_event_not_future" }],
        "the rejection lines",
      );
      const rows = await eventRows(context, "live-future-");
      same(
        rows.map((row) => row.correlation_id),
        ["live-future-1", "live-future-3"],
        "the query event rows of the batch",
      );
      check(
        !rows.some((row) => row.event_id === rejections[0].event_id),
        `the rejected event ${String(rejections[0].event_id)} should not be stored`,
      );
      same(
        sinkStateFlushed(),
        { queued: 0, dropped: 0, rejected: 1, lastFlushAt: true, backingOff: false, lastSqlstate: "23514" },
        "the sink state, and whether it names a last flush",
      );

      // The next beat reports the sink as it stands.
      await sendGovernanceHeartbeat();
      const beat = (await context.superuser((client) =>
        client.query(`SELECT sink FROM ${SCHEMA}.studio_instances_v1 WHERE instance_id = $1`, [INSTANCE_ID]),
      )) as { rows: { sink: unknown }[] };
      same(canonicalJson(beat.rows[0].sink), canonicalJson(queryEventSinkState()), "the heartbeat's sink column");
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
    process.env.GOVERNANCE_INSTANCE_ID = INSTANCE_ID;
    process.env.GOVERNANCE_PRIVATE_KEYS_FILE = keyringFileOf(key);
    // The session case signs and verifies its sessions in this process only.
    process.env.JWT_SECRET = randomBytes(32).toString("hex");
    process.env.OIDC_ISSUER = OIDC_ISSUER;
    // The Next.js build injects the version a heartbeat reports; this script runs outside it.
    process.env.NEXT_PUBLIC_APP_VERSION = packageJson.version;
    process.env.LOG_LEVEL ??= "error";
    const context: LiveContext = { superuser: (run) => asSuperuser(fixture, run), key, fixtureUrl: fixture };
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
    await stopGovernanceListener();
    // A case that failed can leave events queued, whose next flush would open the pool again.
    resetQueryEventSink();
    await closeGovernancePool();
    // A provider a case opened to the fixture server, which a failed case may have left open.
    await clearProviderCache();
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
