/**
 * Opt-in live run of the passkey storage contract against a real PostgreSQL.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The multi-replica guarantees of passkeys
 * rest on PostgreSQL semantics a mocked `pg` cannot show: foreign-key cascades, row locks taken
 * by `SELECT ... FOR UPDATE`, `ON CONFLICT DO NOTHING` under concurrent transactions, and the
 * parameter inference that makes an untyped counter compared with `0` an integer and fail above
 * 2147483647. tests/unit/lib/storage/providers/postgres.test.ts pins only the
 * driver mechanics; this script runs every case of `PASSKEY_STORE_CONTRACT`, the same list
 * tests/unit/lib/storage/providers/sqlite-passkeys.test.ts runs on SQLite, against a server.
 *
 * Each case opens its own `PostgresStorageProvider`, whose `initialize()` creates the tables
 * when missing, works under random `contract-...@example.com` accounts and deletes them again.
 * It prints one line per case and exits non-zero on the first failure. It is NOT in
 * `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in
 * `tests/runner/discover.ts`). CI runs it in the "Functional Smoke (PostgreSQL)" job of
 * .github/workflows/ci.yml, against a throwaway postgres:17.
 *
 *   LIBREDB_LIVE_POSTGRES_URL='postgresql://postgres:pk@127.0.0.1:55432/postgres?sslmode=disable' \
 *     bun tests/live/passkey-store-postgres.ts
 *
 * Point it at a DISPOSABLE server: it creates the storage tables in the database the URL names.
 * The URL must name a superuser: the reused-email case deletes an account with
 * `session_replication_role = replica` to leave its passkey rows behind.
 */
import { Client } from "pg";
import { PASSKEY_STORE_CONTRACT, type ContractStore } from "../helpers/passkey-store-contract";
import { PostgresStorageProvider } from "../../src/lib/storage/providers/postgres";

function url(): string {
  const raw = process.env.LIBREDB_LIVE_POSTGRES_URL;
  if (!raw) {
    throw new Error(
      "Set LIBREDB_LIVE_POSTGRES_URL to a disposable PostgreSQL URL, such as " +
        "postgresql://postgres:pk@127.0.0.1:55432/postgres?sslmode=disable. " +
        "The script creates the storage tables in that database.",
    );
  }
  return raw;
}

async function main(): Promise<void> {
  const connectionString = url();
  // A delete outside Studio that skips the foreign-key triggers, as logical replication apply or a
  // trigger-disabled restore does, so the passkey rows stay behind. Needs a superuser URL.
  const orphanAccount = async (email: string): Promise<void> => {
    const side = new Client({ connectionString });
    await side.connect();
    try {
      await side.query("BEGIN");
      await side.query("SET LOCAL session_replication_role = replica");
      await side.query("DELETE FROM accounts WHERE email = $1", [email]);
      await side.query("COMMIT");
    } finally {
      await side.end();
    }
  };
  const open = async (): Promise<ContractStore> => {
    const provider = new PostgresStorageProvider(connectionString);
    await provider.initialize();
    return { provider, close: () => provider.close(), orphanAccount };
  };

  for (const [index, contractCase] of PASSKEY_STORE_CONTRACT.entries()) {
    const label = `${index + 1}/${PASSKEY_STORE_CONTRACT.length} ${contractCase.name}`;
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential on purpose: one case per line, stop at the first failure.
      await contractCase.run(open);
    } catch (error) {
      console.error(`FAIL ${label}`);
      console.error(error);
      process.exit(1);
    }
    console.log(`ok   ${label}`);
  }
  console.log(`All ${PASSKEY_STORE_CONTRACT.length} passkey store contract cases passed on PostgreSQL.`);
}

await main();
