/**
 * Opt-in live drive for X23: can a connection behind an SSH bastion build AND apply an object
 * edit plan?
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The defect was an equality between two
 * digests computed on two sides of an HTTP request, and the thing that moved one of them was a
 * real SSH forward's ephemeral local port. A mock tunnel proves the wiring - that is what
 * `tests/isolated/factory.test.ts` does, and it is the test that runs in CI - but it cannot tell
 * you that a real forward, a real pool dialling loopback and a real `CREATE OR REPLACE FUNCTION`
 * arriving on the far side all compose. This does that, once, by hand.
 *
 * It is NOT in `bun run test` or `bun run test:ci`. `tests/run-core.sh` globs `tests/unit
 * tests/api tests/integration tests/hooks tests/security tests/evals`, so nothing under
 * `tests/live/` is collected - the same arrangement `tests/live/mysql-object-vocabulary.ts` and
 * `tests/live/schema-diff-dialects.ts` have.
 *
 * WHAT IT NEEDS. A PostgreSQL seeded from this repository's `docker/postgres-init/`, so
 * `app.order_total(integer)` exists, and an SSH bastion that can reach it with
 * `AllowTcpForwarding yes`. Defaults match the containers the X23 task ran against:
 *
 *   docker run -d --name pg-p3fix --network p3fix-net -p 15901:5432 \
 *     -e POSTGRES_PASSWORD="$LIVE_PG_PASSWORD" -e POSTGRES_DB=libredb_dev \
 *     -v "$PWD/docker/postgres-init:/docker-entrypoint-initdb.d:ro" postgres:18
 *
 * Run it with:
 *
 *   LIVE_PG_PASSWORD=... LIVE_SSH_PASSWORD=... bun tests/live/ssh-tunnel-edit-plan.ts
 *
 * Both passwords are REQUIRED and have no default: see `requiredSecret` below.
 *
 * Override any of `LIVE_PG_HOST`, `LIVE_PG_PORT` (the far end AS THE BASTION SEES IT),
 * `LIVE_PG_DB`, `LIVE_PG_USER`, `LIVE_PG_PASSWORD`, `LIVE_SSH_HOST`, `LIVE_SSH_PORT`,
 * `LIVE_SSH_USER`, `LIVE_SSH_PASSWORD`.
 *
 * It restores the function's original definition on the way out, so it can be run repeatedly.
 */
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import { getOrCreateProvider, removeProvider } from "@/lib/db/factory";
import type { DatabaseConnection } from "@/lib/types";

const env = (name: string, fallback: string) => process.env[name] ?? fallback;

/**
 * A credential has NO default, which is the shape `tests/live/schema-diff-dialects.ts` already
 * uses (`required("MSSQL_TEST_PASSWORD")`). The first form of this file defaulted both passwords to
 * the throwaway containers' own values and GitGuardian read them as secrets in the diff, which is
 * the correct reading whatever the container was: a literal that a driver sends as a password is a
 * password. Addresses and user names keep their defaults, because they name where to go and not how
 * to get in.
 */
function requiredSecret(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `Set ${name}. This drive talks to a real bastion and a real engine, so its credentials come ` +
        `from the environment and are never written down here.`,
    );
  }
  return value;
}

const connection: DatabaseConnection = {
  id: "x23-live-tunnelled",
  name: "X23 live tunnelled",
  type: "postgres",
  // The far end AS THE BASTION SEES IT, which is the address the record stores and the routes
  // fingerprint. It is deliberately not reachable from here.
  host: env("LIVE_PG_HOST", "pg-p3fix"),
  port: Number(env("LIVE_PG_PORT", "5432")),
  database: env("LIVE_PG_DB", "libredb_dev"),
  user: env("LIVE_PG_USER", "postgres"),
  password: requiredSecret("LIVE_PG_PASSWORD"),
  createdAt: new Date(),
  sshTunnel: {
    enabled: true,
    host: env("LIVE_SSH_HOST", "127.0.0.1"),
    port: Number(env("LIVE_SSH_PORT", "15922")),
    username: env("LIVE_SSH_USER", "tunneluser"),
    authMethod: "password",
    password: requiredSecret("LIVE_SSH_PASSWORD"),
  },
};

const PATH = ["app", "order_total(integer)"];
const KIND = "function";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const provider = await getOrCreateProvider(connection);
try {
  console.log(`provider dials ${provider.config.host}:${provider.config.port} (the tunnel's local endpoint)`);
  if (provider.config.host !== "127.0.0.1" && provider.config.host !== "localhost") {
    fail(`no tunnel was opened: the provider is dialling ${provider.config.host}`);
  }

  const document = await provider.readObjectSource!(PATH, KIND);
  const part = document.parts[0];
  if (!("text" in part)) fail(`the definition is unavailable: ${JSON.stringify(part)}`);
  const original = part.text;
  console.log(`read ${original.length} bytes of definition through the tunnel`);

  // The marker goes INSIDE the body: measured here, appending a line comment after the closing
  // `$function$` is dropped by `pg_get_functiondef` on the way back, so the apply lands and the
  // catalog is unchanged, and the restore below then refuses its own text as identical.
  const edited = original.replace("AS $function$\n", "AS $function$\n  -- X23 live drive\n");
  if (edited === original) fail("the definition is not the shape this drive edits");
  const build = await provider.buildObjectEdit!({ path: PATH, kind: KIND, partId: part.id, text: edited });
  if (!build.built) fail(`the plan was refused: ${JSON.stringify(build.refusal)}`);

  const asTheRouteSeesIt = await connectionFingerprint(connection);
  console.log(`plan  fingerprint: ${build.plan.connectionFingerprint}`);
  console.log(`route fingerprint: ${asTheRouteSeesIt}`);
  if (build.plan.connectionFingerprint !== asTheRouteSeesIt) {
    fail("the two sides disagree, so the edit-plan route would answer 400 EDIT_PLAN_INVALID");
  }

  // THE CONTROL, so the equality above is not passing because everything is equal to everything.
  // This is exactly the object the factory handed the provider BEFORE X23 was fixed: the same
  // record with `host` and `port` rewritten and no far end carried alongside them.
  const asItWasBeforeTheFix = await connectionFingerprint({
    ...connection,
    host: provider.config.host,
    port: provider.config.port,
  });
  console.log(`pre-fix fingerprint: ${asItWasBeforeTheFix}`);
  if (asItWasBeforeTheFix === asTheRouteSeesIt) {
    fail("the pre-fix digest matches the route's, so this drive cannot tell a fixed seal from a broken one");
  }

  const outcome = await provider.applyObjectEdit!(build.plan);
  console.log(`apply outcome: ${outcome.outcome}`);
  if (outcome.outcome !== "applied") fail(`the apply did not land: ${JSON.stringify(outcome)}`);

  // Put it back, so the next run starts from the same definition this one did.
  const restore = await provider.buildObjectEdit!({ path: PATH, kind: KIND, partId: part.id, text: original });
  if (!restore.built) fail(`the restore was refused: ${JSON.stringify(restore.refusal)}`);
  const restored = await provider.applyObjectEdit!(restore.plan);
  console.log(`restore outcome: ${restored.outcome}`);

  console.log("TUNNELLED EDIT OK");
} finally {
  // Closes the provider AND the tunnel it opened: no SSH client or listening socket is left.
  await removeProvider(connection.id);
}
