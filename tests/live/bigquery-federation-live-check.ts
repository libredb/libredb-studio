/**
 * Hand-run live check of an external-account credential (Workload Identity Federation) against real Google; not in
 * `bun run test`. It serves a subject token from this machine, signed with a key whose public half a workload identity
 * pool provider holds, and opens the real provider on it.
 *
 *   bun tests/live/bigquery-federation-live-check.ts keygen <dir>
 *   bun tests/live/bigquery-federation-live-check.ts run <dir> --project <id> --number <project number> \
 *     --pool <pool> --provider <provider> --audience <allowed audience> --dataset <dataset> [--soak-seconds 360]
 *
 * The dataset holds two one-row tables, `granted` (the subject may read it) and `not_granted`. Exits 1 on a failed check.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { exportJWK, importPKCS8, importSPKI, SignJWT } from "jose";
import { createDatabaseProvider } from "@/lib/db/factory";
import { type DatabaseConnection, LITERAL_SEED_FILE } from "@/lib/types";

const [mode, dir = ""] = process.argv.slice(2);
const args = process.argv.slice(4);
const flag = (name: string, fallback = "") => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const SUBJECT = "studio-live-user";
const ISSUER = "https://studio-live.invalid";
const KID = "studio-live-1";
const SUBJECT_SECONDS = 150;

if (mode === "keygen") {
  mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  writeFileSync(path.join(dir, "key.pem"), privateKey, { mode: 0o600 });
  const jwk = await exportJWK(await importSPKI(publicKey, "RS256"));
  writeFileSync(
    path.join(dir, "jwks.json"),
    JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }),
  );
  console.log(`wrote ${dir}/key.pem and ${dir}/jwks.json; issuer ${ISSUER}`);
  process.exit(0);
}
if (mode !== "run") {
  console.error(
    "usage: keygen <dir> | run <dir> --project .. --number .. --pool .. --provider .. --audience .. --dataset ..",
  );
  process.exit(2);
}

const project = flag("--project");
const dataset = flag("--dataset");
const soakSeconds = Number(flag("--soak-seconds", "360"));
const poolAudience = (pool: string) =>
  `//iam.googleapis.com/projects/${flag("--number")}/locations/global/workloadIdentityPools/${pool}/providers/${flag("--provider")}`;
const key = await importPKCS8(readFileSync(path.join(dir, "key.pem"), "utf8"), "RS256");

// -- the subject endpoint and the redirect's target, both on this machine --------------------------------------------

const log: string[] = [];
const stamp = () => new Date().toISOString().slice(11, 19);
const hits = (needle: string) => log.filter((line) => line.includes(needle)).length;
async function subjectToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: KID })
    .setIssuer(ISSUER)
    .setSubject(SUBJECT)
    .setAudience(flag("--audience"))
    .setIssuedAt(now)
    .setExpirationTime(now + SUBJECT_SECONDS)
    .sign(key);
}
const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
const target = createServer((request, response) => {
  log.push(`${stamp()} redirect-target ${request.method} ${request.url}`);
  response.end("should never be reached");
});
const targetPort = await listen(target);
const subjects = createServer(async (request, response) => {
  log.push(`${stamp()} subject-endpoint ${request.method} ${request.url}`);
  if (request.url === "/redirect") {
    response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/stolen` }).end();
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" }).end(await subjectToken());
});
const subjectPort = await listen(subjects);

// -- connections -----------------------------------------------------------------------------------------------------

const credential = (over: { pool?: string; route?: string } = {}) =>
  JSON.stringify({
    type: "external_account",
    audience: poolAudience(over.pool ?? flag("--pool")),
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    credential_source: { url: `http://127.0.0.1:${subjectPort}${over.route ?? "/subject"}` },
  });
let serial = 0;
const connection = (over: Partial<DatabaseConnection> & { literal?: boolean } = {}): DatabaseConnection => {
  const { literal, ...rest } = over;
  const record = {
    id: `federation-live-${++serial}`,
    name: "BigQuery federation live check",
    type: "bigquery",
    database: project,
    schema: dataset,
    password: credential(),
    managed: true,
    createdAt: new Date(),
    ...rest,
  } as DatabaseConnection;
  return literal ? ({ ...record, [LITERAL_SEED_FILE]: true } as DatabaseConnection) : record;
};

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
async function refusedAtConnect(record: DatabaseConnection): Promise<string> {
  const provider = await createDatabaseProvider(record);
  try {
    await provider.connect();
    await provider.disconnect();
    return "CONNECTED";
  } catch (error) {
    return messageOf(error);
  }
}

// -- the checks ------------------------------------------------------------------------------------------------------

const provider = await createDatabaseProvider(connection());
await provider.connect();
const granted = await provider.query(`SELECT id FROM \`${dataset}.granted\``);
check("1 a server-written connection reads the granted table", granted.rows.length === 1, JSON.stringify(granted.rows));

const denied = await provider.query(`SELECT id FROM \`${dataset}.not_granted\``).then(
  () => "ROWS RETURNED",
  (error: unknown) => messageOf(error),
);
check("2 Google refuses the table with no grant", /denied|permission/i.test(denied), denied.slice(0, 160));

const before = hits("subject-endpoint GET /subject");
const started = Date.now();
let soakQueries = 0;
while (Date.now() - started < soakSeconds * 1000) {
  // oxlint-disable-next-line no-await-in-loop -- one query at a time, on purpose.
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  // oxlint-disable-next-line no-await-in-loop -- one query at a time, on purpose.
  const rows = await provider.query(`SELECT id FROM \`${dataset}.granted\``);
  soakQueries += rows.rows.length;
  console.log(`      ${stamp()} soak query ok, subject fetches so far ${hits("subject-endpoint GET /subject")}`);
}
const refreshed = hits("subject-endpoint GET /subject") - before;
check(
  `3 a ${SUBJECT_SECONDS} s subject token is fetched again before it ends, and queries keep working for ${soakSeconds} s`,
  soakQueries >= Math.floor(soakSeconds / 30) - 1 && refreshed >= Math.floor(soakSeconds / SUBJECT_SECONDS),
  `${soakQueries} queries answered, ${refreshed} further subject fetches`,
);
await provider.disconnect();

const quiet = async (name: string, record: DatabaseConnection, expected: RegExp) => {
  const count = log.length;
  const message = await refusedAtConnect(record);
  check(
    name,
    expected.test(message) && log.length === count,
    `${message.slice(0, 200)} | requests made: ${log.length - count}`,
  );
};
await quiet(
  "4 the same credential on a connection a browser sent is refused, with no request",
  connection({ managed: false }),
  /only on a connection the server wrote/,
);
await quiet(
  "5 the same credential on a seed-file row read in literal mode is refused, with no request",
  connection({ literal: true }),
  /only on a connection the server wrote/,
);

const redirected = await refusedAtConnect(connection({ password: credential({ route: "/redirect" }) }));
check(
  "6 a redirect from the subject URL is refused and its target is never contacted",
  redirected !== "CONNECTED" && hits("redirect-target") === 0 && hits("subject-endpoint GET /redirect") > 0,
  `${redirected.slice(0, 200)} | redirect target requests: ${hits("redirect-target")}`,
);

const wrongPool = await refusedAtConnect(connection({ password: credential({ pool: "no-such-pool-xyz" }) }));
check(
  "7 an exchange Google refuses is reported with Google's reason and no token",
  /Google token request failed/.test(wrongPool) && !/eyJ/.test(wrongPool),
  wrongPool.slice(0, 300),
);

console.log("\nrequest log of the two local servers:");
for (const line of log) console.log(`  ${line}`);
subjects.close();
target.close();
console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
