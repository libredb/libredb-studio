/**
 * Send `02-libsql-object-fixture.sql` to a running sqld, and print the catalog it built (#789).
 *
 * sqld ships no client: the image carries neither a `sqlite3` binary nor `curl`, and the only
 * way in is the Hrana HTTP API. So the fixture needs an applier of its own, and this is it.
 * Without one the file would be as unapplicable as the fenced block D53 was filed for.
 *
 *   docker compose -f database-compose.yml up -d libsql
 *   bun docker/sqlite-init/apply-to-libsql.ts http://127.0.0.1:18080
 *   bun docker/sqlite-init/apply-to-libsql.ts http://127.0.0.1:18080 <token>
 *
 * It prints `sqlite_schema` as `type|name|tbl_name|sql` afterwards, which is what the capture
 * in `tests/integration/db/libsql-provider.test.ts` is taken from. Statements run ONE PER
 * REQUEST rather than as one batch, because a batch stops at the first failure and a fixture
 * that half-applied is worse than one that did not: each statement's own outcome is printed.
 */
import { readFixtureStatements, LIBSQL_FIXTURE_FILE } from "./build-fixture";

interface HranaOutcome {
  type: string;
  error?: { message: string };
  response?: { result?: { rows?: { type: string; value?: string }[][] } };
}

async function send(base: string, token: string | undefined, sql: string): Promise<HranaOutcome> {
  const response = await fetch(`${base.replace(/\/$/, "")}/v2/pipeline`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql } }, { type: "close" }] }),
  });
  // A FAILED STATEMENT IS AN HTTP 200 with the failure inside `results[]`, so `response.ok`
  // is never the verdict here (docs/providers/libsql.md section 3). A non-200 is a transport
  // or an auth failure and is the one case worth raising on.
  if (!response.ok) throw new Error(`${base} answered HTTP ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { results: HranaOutcome[] };
  return body.results[0];
}

if (import.meta.main) {
  const base = process.argv[2] ?? "http://127.0.0.1:18080";
  const token = process.argv[3];
  let failed = 0;
  for (const statement of readFixtureStatements(LIBSQL_FIXTURE_FILE)) {
    const outcome = await send(base, token, statement);
    const head = statement.split("\n")[0].slice(0, 72);
    if (outcome.type === "ok") process.stdout.write(`ok    ${head}\n`);
    else {
      failed += 1;
      process.stdout.write(`FAIL  ${head}\n      ${outcome.error?.message ?? "no message"}\n`);
    }
  }
  const catalog = await send(base, token, "SELECT type, name, tbl_name, sql FROM sqlite_schema");
  for (const row of catalog.response?.result?.rows ?? []) {
    process.stdout.write(`${row.map((cell) => (cell.type === "null" ? "" : (cell.value ?? ""))).join("|")}\n`);
  }
  if (failed > 0) process.exitCode = 1;
}
