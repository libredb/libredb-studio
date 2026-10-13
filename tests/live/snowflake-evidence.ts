/**
 * The Snowflake evidence harness: it asks the trial account the measurement items of
 * tests/live/snowflake-evidence-plan.ts and runs the scenarios of the full capture, over raw `node:https` with no
 * provider code, so what it records is what Snowflake answered and not what Studio made of it. It writes
 * tests/fixtures/snowflake/trial-<date>-v<CURRENT_VERSION>/<name>.json, one file per item or scenario, and a full
 * manifest.json: the cloud, the region, `CURRENT_VERSION()`, the edition, the capture date and the Studio commit.
 *
 * Every request is recorded with its headers and its answer; a partition is recorded decoded, with the encoding it
 * came in. A measurement item's rows, a partition's and a statement's own inline ones, are summarised by
 * tests/helpers/snowflake-evidence-summary.ts, so its file stays small; a scenario is recorded whole, since the
 * integration test replays it, and stops at its first refused answer or a role check that answers another role, as
 * the provider does. A warehouse-sensitive item records `SHOW WAREHOUSES` state before and after it, and a cold item
 * (step 1) starts only on a suspended warehouse and waits for the suspension after it. M12 signs token A once and
 * sends it again at the offsets the plan names; the cross-token items sign token B later for the same user and key.
 * Every file passes tests/helpers/snowflake-evidence-scrub.ts; while any one holds a secret, nothing is written.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/), with the operator's env file
 * loaded, the account set up as tests/fixtures/snowflake/README.md says:
 *
 *   (set -a; . <the operator's env file>; set +a; bun tests/live/snowflake-evidence.ts --step 1,2,3,4)
 *   (set -a; . <the operator's env file>; set +a; bun tests/live/snowflake-evidence.ts --scenarios --step 5)
 *
 * Its inputs come from the environment only: the variables tests/helpers/snowflake-live.ts reads, plus
 * SNOWFLAKE_EDITION for the manifest, SNOWFLAKE_OPERATOR_USER, the administrator who set the account up, for the scrub
 * and the mask, and, when the operator knows it, SNOWFLAKE_EGRESS_IP for the scrub. A missing or malformed one, or an
 * argument it does not accept, exits 2 before any socket; a failure exits 1. Every line it prints is masked. The
 * account's locator, organisation and account name are asked of the account itself before the first item, so the
 * scrub and the mask know them whatever form SNOWFLAKE_ACCOUNT took.
 */
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import path from "node:path";
import { connect as tlsConnect } from "node:tls";
import { gunzipSync } from "node:zlib";
import { SignJWT } from "jose";
import {
  SnowflakeEvidenceLeakError,
  SnowflakeEvidenceScrubber,
  type SnowflakeRawExchange,
} from "../helpers/snowflake-evidence-scrub";
import { SNOWFLAKE_ROWS_SUMMARISED, summariseRows } from "../helpers/snowflake-evidence-summary";
import {
  type EvidenceInputs,
  evidenceScrubSecrets,
  type LiveArguments,
  liveSecrets,
  mask,
  readEvidenceInputs,
  readLiveArguments,
} from "../helpers/snowflake-live";
import {
  type EvidenceItem,
  type EvidencePrincipal,
  type EvidenceScenario,
  SNOWFLAKE_EVIDENCE_DATABASE,
  SNOWFLAKE_EVIDENCE_PLAN,
  SNOWFLAKE_EVIDENCE_SCENARIOS,
  SNOWFLAKE_EVIDENCE_SCHEMA,
  SNOWFLAKE_EVIDENCE_WAREHOUSE,
  SNOWFLAKE_SUSPEND_POLL_MS,
  SNOWFLAKE_SUSPEND_WAIT_MS,
  SNOWFLAKE_TOKEN_REUSE_OFFSETS_S,
  type ScenarioStatement,
  type ScenarioStop,
  scenarioStop,
} from "./snowflake-evidence-plan";

const ROOT = path.resolve(import.meta.dir, "../..");
const HARNESS_PATHS = [
  "tests/helpers/snowflake-evidence-scrub.ts",
  "tests/helpers/snowflake-evidence-summary.ts",
  "tests/helpers/snowflake-live.ts",
  "tests/live/snowflake-evidence-plan.ts",
  "tests/live/snowflake-evidence.ts",
];
const STATEMENTS = "/api/v2/statements";
const POLL_FIRST_MS = 250;
const POLL_MAX_MS = 2_000;
/** A statement that has not ended after this long is recorded as it stands. */
const STATEMENT_WAIT_MS = 900_000;
const USER_AGENT = "LibreDB-Studio-evidence";

// ============================================================================
// Arguments
// ============================================================================

interface Options {
  readonly steps: ReadonlySet<number>;
  readonly scenarios: boolean;
}

function exitBadArgument(message: string): never {
  console.error(`snowflake-evidence: ${message}; nothing was sent.`);
  process.exit(2);
}

function parseOptions(argv: readonly string[]): Options {
  const steps = new Set<number>();
  let scenarios = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--scenarios") scenarios = true;
    else if (argument === "--step") {
      const list = argv[(index += 1)] ?? "";
      for (const part of list.split(",")) {
        const step = Number(part);
        if (![1, 2, 3, 4, 5].includes(step)) exitBadArgument(`--step takes 1 to 5, comma-separated`);
        steps.add(step);
      }
    } else exitBadArgument(`it takes --step <1..5,...> and --scenarios, not ${JSON.stringify(argument)}`);
  }
  if (steps.size === 0 && !scenarios) exitBadArgument("give --step, --scenarios or both");
  return { steps, scenarios };
}

const options = parseOptions(process.argv.slice(2));
const read = readLiveArguments(process.env);
if ("exitCode" in read) {
  console.error(`snowflake-evidence: ${read.message}`);
  process.exit(read.exitCode);
}
const args: LiveArguments = read;
const readInputs = readEvidenceInputs(process.env);
if ("exitCode" in readInputs) {
  console.error(`snowflake-evidence: ${readInputs.message}`);
  process.exit(readInputs.exitCode);
}
const inputs: EvidenceInputs = readInputs;
const secrets = [...liveSecrets(args), inputs.operatorUser];
const say = (line: string): void => console.log(mask(line, secrets));

// ============================================================================
// Credentials
// ============================================================================

interface Signer {
  readonly user: string;
  readonly key: KeyObject;
  readonly fingerprint: string;
  readonly publicKeyBody: string;
}

function signerOf(user: string, pem: string, passphrase: string | undefined, name: string): Signer {
  let key: KeyObject;
  try {
    key = createPrivateKey(passphrase === undefined ? pem : { key: pem, passphrase });
  } catch {
    exitBadArgument(`the key of ${name} does not open with the passphrase given`);
  }
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  return {
    user,
    key,
    fingerprint: `SHA256:${createHash("sha256").update(spki).digest("base64")}`,
    publicKeyBody: spki.toString("base64"),
  };
}

const SVC = signerOf(args.svc.user, args.svc.keyPem, args.svc.passphrase, "SNOWFLAKE_SVC_KEY_FILE");
const READER = signerOf(args.reader.user, args.reader.keyPem, args.reader.passphrase, "SNOWFLAKE_READER_KEY_FILE");
const FRESH = (() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return signerOf(args.reader.user, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), undefined, "");
})();

/** The account claim: the identifier's first label, upper-cased, as the provider signs it. */
const ACCOUNT_CLAIM = args.host.split(".")[0].toUpperCase();

async function signToken(signer: Signer, claim: string = ACCOUNT_CLAIM): Promise<string> {
  const subject = `${claim}.${signer.user.toUpperCase()}`;
  const iat = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ iss: `${subject}.${signer.fingerprint}`, sub: subject, iat, exp: iat + 900 })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .sign(signer.key);
  secrets.push(token);
  return token;
}

interface Bearer {
  readonly token: string;
  readonly type: "KEYPAIR_JWT" | "PROGRAMMATIC_ACCESS_TOKEN";
}

async function bearerFor(principal: EvidencePrincipal, fresh = false): Promise<Bearer> {
  if (principal === "pat") return { token: args.pat.token, type: "PROGRAMMATIC_ACCESS_TOKEN" };
  const signer = fresh ? FRESH : principal === "svc" ? SVC : READER;
  return { token: await signToken(signer), type: "KEYPAIR_JWT" };
}

// ============================================================================
// The wire
// ============================================================================

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly text: string;
  readonly json: Record<string, unknown> | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Each recorded exchange's answer length in bytes as it came off the socket, before any `content-encoding`. */
const wireBytes = new WeakMap<SnowflakeRawExchange, number>();

/** One HTTPS exchange with the account, recorded into `into`; nothing is followed and nothing is retried. */
function send(
  into: SnowflakeRawExchange[],
  bearer: Bearer,
  method: "GET" | "POST",
  target: string,
  body?: Record<string, unknown>,
): Promise<Answer> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${bearer.token}`,
    "x-snowflake-authorization-token-type": bearer.type,
    accept: "application/json",
    "user-agent": USER_AGENT,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  };
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: args.host, port: 443, method, path: target, headers, servername: args.host },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("error", reject);
        incoming.on("end", () => {
          const raw = Buffer.concat(chunks);
          const answerHeaders = Object.fromEntries(
            Object.entries(incoming.headers).map(([name, value]) => [name, String(value)]),
          );
          const text = (answerHeaders["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8");
          const exchange: SnowflakeRawExchange = {
            request: { method, path: target, headers, ...(body === undefined ? {} : { body }) },
            response: { status: incoming.statusCode ?? 0, headers: answerHeaders, body: text },
          };
          wireBytes.set(exchange, raw.length);
          into.push(exchange);
          let json: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              json = parsed as Record<string, unknown>;
            }
          } catch {
            // A gateway page or an empty body: kept as text.
          }
          resolve({ status: incoming.statusCode ?? 0, headers: answerHeaders, text, json });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

interface Context {
  readonly role: string;
  readonly warehouse: boolean;
}

const ROLES: Readonly<Record<EvidencePrincipal, string>> = { svc: "STUDIO_RW", reader: "STUDIO_RO", pat: "STUDIO_RO" };

/** The body the provider sends for a statement: the four context fields and the fixed parameters. */
function statementBody(sql: string, tag: string, timeout: number, context: Context): Record<string, unknown> {
  return {
    statement: sql,
    timeout,
    database: SNOWFLAKE_EVIDENCE_DATABASE,
    schema: SNOWFLAKE_EVIDENCE_SCHEMA,
    ...(context.warehouse ? { warehouse: SNOWFLAKE_EVIDENCE_WAREHOUSE } : {}),
    role: context.role,
    parameters: {
      multi_statement_count: "1",
      query_tag: tag,
      client_result_chunk_size: 16,
      rows_per_resultset: 100_001,
      timezone: "UTC",
    },
  };
}

interface Run {
  readonly handle: string | null;
  readonly last: Answer;
  readonly polls: { readonly afterMs: number; readonly status: number; readonly retryAfter: string | null }[];
}

/** Submits asynchronously, then polls the handle until the statement ends; `poll` decides each next bearer. */
async function runStatement(
  into: SnowflakeRawExchange[],
  submitBearer: Bearer,
  sql: string,
  input: { readonly tag: string; readonly timeout: number; readonly context: Context; readonly pollBearer?: Bearer },
): Promise<Run> {
  const started = Date.now();
  const query = `async=true&requestId=${crypto.randomUUID()}`;
  let answer = await send(
    into,
    submitBearer,
    "POST",
    `${STATEMENTS}?${query}`,
    statementBody(sql, input.tag, input.timeout, input.context),
  );
  const handle = typeof answer.json?.statementHandle === "string" ? answer.json.statementHandle : null;
  const polls: Run["polls"][number][] = [];
  let interval = POLL_FIRST_MS;
  if (handle === null) return { handle, last: answer, polls };
  while (answer.status === 202 && Date.now() - started < STATEMENT_WAIT_MS) {
    // oxlint-disable-next-line no-await-in-loop -- each poll waits its interval before the next status read.
    await sleep(interval);
    // oxlint-disable-next-line no-await-in-loop -- each status answer decides whether there is another poll.
    answer = await send(into, input.pollBearer ?? submitBearer, "GET", `${STATEMENTS}/${handle}`);
    polls.push({
      afterMs: Date.now() - started,
      status: answer.status,
      retryAfter: answer.headers["retry-after"] ?? null,
    });
    interval = Math.min(interval * 2, POLL_MAX_MS);
  }
  return { handle, last: answer, polls };
}

/**
 * Reads partitions 1 to n of a finished statement, one at a time, and stops at the first answer that is not 200, as
 * the provider does; answers whether one refused.
 */
async function readPartitions(into: SnowflakeRawExchange[], bearer: Bearer, run: Run): Promise<boolean> {
  const meta = run.last.json?.resultSetMetaData as { partitionInfo?: unknown[] } | undefined;
  const count = Array.isArray(meta?.partitionInfo) ? meta.partitionInfo.length : 1;
  for (let index = 1; index < count && run.handle !== null; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one partition at a time, as the provider reads them.
    const part = await send(into, bearer, "GET", `${STATEMENTS}/${run.handle}?partition=${index}`);
    if (part.status !== 200) return true;
  }
  return false;
}

/** The warehouse's state, read with `SHOW WAREHOUSES LIKE` as the service user; the read is not recorded. */
async function warehouseState(): Promise<string> {
  const run = await runStatement([], await bearerFor("svc"), `SHOW WAREHOUSES LIKE '${SNOWFLAKE_EVIDENCE_WAREHOUSE}'`, {
    tag: "libredb-studio:evidence",
    timeout: 30,
    context: { role: "STUDIO_RW", warehouse: false },
  });
  const meta = run.last.json?.resultSetMetaData as { rowType?: { name: string }[] } | undefined;
  const columns = (meta?.rowType ?? []).map((column) => column.name);
  const rows = (run.last.json?.data ?? []) as (string | null)[][];
  const row = rows.find((candidate) => candidate[columns.indexOf("name")] === SNOWFLAKE_EVIDENCE_WAREHOUSE);
  return row?.[columns.indexOf("state")] ?? "ABSENT";
}

/** Waits, within the bound, until `SHOW WAREHOUSES` reports the warehouse suspended; fails naming `waiter`. */
async function awaitSuspended(waiter: string): Promise<string> {
  const deadline = Date.now() + SNOWFLAKE_SUSPEND_WAIT_MS;
  let state = await warehouseState();
  while (state !== "SUSPENDED" && Date.now() < deadline) {
    say(`  waiting for ${SNOWFLAKE_EVIDENCE_WAREHOUSE} to suspend (${state})`);
    // oxlint-disable-next-line no-await-in-loop -- the state is read again after each wait.
    await sleep(SNOWFLAKE_SUSPEND_POLL_MS);
    // oxlint-disable-next-line no-await-in-loop -- see above.
    state = await warehouseState();
  }
  if (state !== "SUSPENDED") {
    throw new Error(
      `${waiter}: ${SNOWFLAKE_EVIDENCE_WAREHOUSE} did not report SUSPENDED within ${SNOWFLAKE_SUSPEND_WAIT_MS / 1000} s (${state})`,
    );
  }
  return state;
}

/** Whether the certificate the host serves for its name covers that name, and its wildcard shapes. */
function certificateOfHost(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: args.host, port: 443, servername: args.host }, () => {
      const certificate = socket.getPeerCertificate();
      socket.end();
      const names = String(certificate.subjectaltname ?? "")
        .split(", ")
        .map((name) => name.replace(/^DNS:/, ""));
      const covers = names.some(
        (name) =>
          name === args.host || (name.startsWith("*.") && args.host.slice(args.host.indexOf(".")) === name.slice(1)),
      );
      resolve({
        coversHost: covers,
        authorized: socket.authorized,
        wildcardNames: names.filter((name) => name.startsWith("*.")).length,
        issuerOrganization: certificate.issuer?.O ?? null,
        validTo: certificate.valid_to,
      });
    });
    socket.on("error", reject);
  });
}

// ============================================================================
// Items and scenarios
// ============================================================================

function filled(sql: string): string {
  return sql
    .replaceAll("<svc-user>", args.svc.user)
    .replaceAll("<reader-user>", args.reader.user)
    .replaceAll(
      "<fp8>",
      createHash("sha256").update(Buffer.from(SVC.publicKeyBody, "base64")).digest("hex").slice(0, 8),
    )
    .replaceAll("<public-key-body>", SVC.publicKeyBody);
}

async function runItem(item: EvidenceItem): Promise<Record<string, unknown>> {
  const exchanges: SnowflakeRawExchange[] = [];
  const record: Record<string, unknown> = {
    item: item.id,
    step: item.step,
    asks: item.asks,
    rowsSummarised: SNOWFLAKE_ROWS_SUMMARISED,
  };
  if (item.cold) record.coldStart = await awaitSuspended(item.id);
  if (item.warehouseSensitive) record.stateBefore = await warehouseState();
  const context: Context = { role: item.role ?? ROLES[item.principal], warehouse: item.warehouse !== false };
  const statement = { tag: "libredb-studio:evidence", timeout: item.timeout ?? 60, context };
  const notes: Record<string, unknown>[] = [];

  switch (item.special) {
    case "operator":
      say(`  operator: ${item.asks}`);
      record.operator = "pending: the operator's answer is added to this file by hand";
      break;
    case "certificate":
      record.certificate = await certificateOfHost();
      break;
    case "token-reuse": {
      const token = { token: await signToken(SVC), type: "KEYPAIR_JWT" as const };
      const signedAt = Date.now();
      for (const offset of SNOWFLAKE_TOKEN_REUSE_OFFSETS_S) {
        // oxlint-disable-next-line no-await-in-loop -- each send waits for its offset after the one signing.
        await sleep(Math.max(0, signedAt + offset * 1000 - Date.now()));
        // oxlint-disable-next-line no-await-in-loop -- see above.
        const run = await runStatement(exchanges, token, filled(item.statements[0]), statement);
        notes.push({ afterIatS: offset, status: run.last.status, code: run.last.json?.code ?? null });
      }
      break;
    }
    case "claim-forms": {
      const forms = [
        ...new Set([ACCOUNT_CLAIM, ACCOUNT_CLAIM.replaceAll("_", "-"), ACCOUNT_CLAIM.replaceAll("-", "_")]),
      ];
      for (const claim of forms) {
        // oxlint-disable-next-line no-await-in-loop -- one claim spelling at a time.
        const token = { token: await signToken(SVC, claim), type: "KEYPAIR_JWT" as const };
        // oxlint-disable-next-line no-await-in-loop -- see above.
        const run = await runStatement(exchanges, token, filled(item.statements[0]), statement);
        notes.push({
          claimSpelling: claim === ACCOUNT_CLAIM ? "as typed" : claim.includes("-") ? "hyphens" : "underscores",
          status: run.last.status,
        });
      }
      break;
    }
    case "cross-token":
    case "cancel-twice": {
      const tokenA = { token: await signToken(SVC), type: "KEYPAIR_JWT" as const };
      // A later iat, so token B is a different token for the same user and key.
      await sleep(1_100);
      const tokenB = { token: await signToken(SVC), type: "KEYPAIR_JWT" as const };
      if (item.special === "cross-token") {
        const run = await runStatement(exchanges, tokenA, filled(item.statements[0]), {
          ...statement,
          pollBearer: tokenB,
        });
        await readPartitions(exchanges, tokenB, run);
      } else {
        const submitted = await send(
          exchanges,
          tokenA,
          "POST",
          `${STATEMENTS}?async=true&requestId=${crypto.randomUUID()}`,
          statementBody(filled(item.statements[0]), statement.tag, statement.timeout, context),
        );
        const handle = String(submitted.json?.statementHandle ?? "");
        await sleep(2_000);
        for (let cancel = 0; cancel < 2; cancel += 1) {
          // oxlint-disable-next-line no-await-in-loop -- the second cancel follows the first's answer.
          await send(exchanges, tokenB, "POST", `${STATEMENTS}/${handle}/cancel`);
        }
        await send(exchanges, tokenB, "GET", `${STATEMENTS}/${handle}`);
      }
      break;
    }
    default: {
      const bearer = await bearerFor(item.principal);
      for (const sql of item.statements) {
        // oxlint-disable-next-line no-await-in-loop -- the statements of an item run in order.
        const run = await runStatement(exchanges, bearer, filled(sql), statement);
        if (item.special === "partitions") {
          // oxlint-disable-next-line no-await-in-loop -- see above.
          await readPartitions(exchanges, bearer, run);
        }
        if (item.special === "poll-timing") notes.push({ statement: sql, polls: run.polls });
        if (item.special === "status-after-suspend" && run.handle !== null) {
          // oxlint-disable-next-line no-await-in-loop -- the second read waits for the suspension.
          await awaitSuspended(item.id);
          // oxlint-disable-next-line no-await-in-loop -- see above.
          await send(exchanges, bearer, "GET", `${STATEMENTS}/${run.handle}`);
          // oxlint-disable-next-line no-await-in-loop -- see above.
          record.stateAfterStatusGet = await warehouseState();
        }
      }
    }
  }
  if (item.warehouseSensitive) record.stateAfter = await warehouseState();
  if (notes.length > 0) record.notes = notes;
  return { ...record, exchanges };
}

async function runScenario(scenario: EvidenceScenario): Promise<Record<string, unknown>> {
  const exchanges: SnowflakeRawExchange[] = [];
  // A suspended panel read on a running warehouse would record the started state under the suspended name.
  if (scenario.suspended === true) await awaitSuspended(scenario.name);
  const role = scenario.role ?? ROLES[scenario.principal];
  const warehouse = scenario.warehouse !== false;
  const bearer = await bearerFor(scenario.principal, scenario.freshKey === true);
  let stopped: Record<string, unknown> | null = null;
  for (const [index, step] of scenario.statements.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- a scenario's statements run in order, each after the last's answer.
    const stop = await runScenarioStatement(exchanges, bearer, step, { role, warehouse });
    if (stop !== null) {
      stopped = { statement: index, sql: step.sql, reason: stop };
      say(`  stopped at statement ${index}: ${stop}`);
      break;
    }
  }
  const user =
    scenario.principal === "svc" ? args.svc.user : scenario.principal === "reader" ? args.reader.user : args.pat.user;
  return {
    scenario: scenario.name,
    connection: {
      user,
      authMethod: scenario.principal === "pat" ? "pat" : "keypair",
      role,
      warehouse: warehouse ? SNOWFLAKE_EVIDENCE_WAREHOUSE : "",
      database: SNOWFLAKE_EVIDENCE_DATABASE,
      schema: SNOWFLAKE_EVIDENCE_SCHEMA,
    },
    ...(stopped === null ? {} : { stopped }),
    exchanges,
  };
}

async function runScenarioStatement(
  exchanges: SnowflakeRawExchange[],
  bearer: Bearer,
  step: ScenarioStatement,
  context: Context,
): Promise<ScenarioStop> {
  if (step.cancelAfterMs === undefined) {
    const run = await runStatement(exchanges, bearer, step.sql, { tag: step.tag, timeout: step.timeout, context });
    const firstCell = ((run.last.json?.data ?? []) as unknown[][])[0]?.[0] ?? null;
    const stop = scenarioStop(step, { status: run.last.status, firstCell }, context.role);
    if (stop !== null) return stop;
    return step.partitions && (await readPartitions(exchanges, bearer, run)) ? "refused" : null;
  }
  // The cancel scenario's last statement: the status GET of a running statement and its cancel are both recorded.
  const submitted = await send(
    exchanges,
    bearer,
    "POST",
    `${STATEMENTS}?async=true&requestId=${crypto.randomUUID()}`,
    statementBody(step.sql, step.tag, step.timeout, context),
  );
  const handle = String(submitted.json?.statementHandle ?? "");
  await sleep(step.cancelAfterMs);
  await send(exchanges, bearer, "GET", `${STATEMENTS}/${handle}`);
  await send(exchanges, bearer, "POST", `${STATEMENTS}/${handle}/cancel`);
  return null;
}

// ============================================================================
// The run
// ============================================================================

/** The first value of a one-row `SELECT`, read as the service user; not recorded. */
async function scalar(sql: string): Promise<string> {
  const run = await runStatement([], await bearerFor("svc"), sql, {
    tag: "libredb-studio:evidence",
    timeout: 30,
    context: { role: "STUDIO_RW", warehouse: true },
  });
  const value = ((run.last.json?.data ?? []) as (string | null)[][])[0]?.[0];
  if (typeof value !== "string") throw new Error(`no value answered ${sql}`);
  return value;
}

function uncommitted(): string[] {
  const status = execFileSync("git", ["status", "--porcelain", "--", ...HARNESS_PATHS], { cwd: ROOT }).toString();
  return status
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3));
}

async function main(): Promise<void> {
  const version = await scalar("SELECT CURRENT_VERSION()");
  const region = await scalar("SELECT CURRENT_REGION()");
  const account = {
    locator: await scalar("SELECT CURRENT_ACCOUNT()"),
    organization: await scalar("SELECT CURRENT_ORGANIZATION_NAME()"),
    accountName: await scalar("SELECT CURRENT_ACCOUNT_NAME()"),
  };
  secrets.push(account.locator, account.organization, account.accountName);
  const captured = new Date().toISOString().slice(0, 10);
  const out = path.join(ROOT, "tests/fixtures/snowflake", `trial-${captured}-v${version}`);
  const scrubber = new SnowflakeEvidenceScrubber(evidenceScrubSecrets(args, inputs, account));

  const files: Record<string, unknown> = {};
  const results: { name: string; ms: number; exchanges: number }[] = [];
  const keep = (name: string, raw: Record<string, unknown>, ms: number, summarise: boolean): void => {
    const exchanges = (raw.exchanges as SnowflakeRawExchange[]).map((exchange) => {
      const scrubbed = scrubber.exchange(exchange);
      if (!summarise) return scrubbed;
      const onWire = wireBytes.get(exchange);
      if (onWire === undefined) throw new Error(`${name}: an exchange has no recorded wire length`);
      return summariseRows(scrubbed, { wireBytes: onWire, decodedBytes: Buffer.byteLength(exchange.response.body) });
    });
    files[`${name}.json`] = { ...raw, exchanges };
    results.push({ name, ms, exchanges: exchanges.length });
    say(`DONE ${name} (${ms} ms, ${exchanges.length} exchanges)`);
  };

  for (const item of SNOWFLAKE_EVIDENCE_PLAN.filter((entry) => options.steps.has(entry.step))) {
    const started = Date.now();
    say(`ITEM ${item.id} (step ${item.step})`);
    // oxlint-disable-next-line no-await-in-loop -- the session's items run in its order, one at a time.
    keep(item.id.replace("'", "-prime"), await runItem(item), Date.now() - started, true);
  }
  if (options.scenarios) {
    for (const scenario of SNOWFLAKE_EVIDENCE_SCENARIOS) {
      if (scenario.operator !== undefined) {
        say(`SKIP ${scenario.name}: by hand, ${scenario.operator}`);
        continue;
      }
      const started = Date.now();
      // oxlint-disable-next-line no-await-in-loop -- one scenario at a time.
      keep(scenario.name, await runScenario(scenario), Date.now() - started, false);
    }
  }

  const [cloud, ...rest] = region.split("_");
  files["manifest.json"] = {
    cloud,
    region: rest.join("_"),
    currentVersion: version,
    edition: inputs.edition,
    captured,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).toString().trim(),
    uncommitted: uncommitted(),
    results,
  };
  const rendered = scrubber.render(files);
  if (existsSync(out) && readdirSync(out).some((name) => !Object.hasOwn(rendered, name))) {
    throw new Error(`${path.relative(ROOT, out)} already holds files this run does not write`);
  }
  mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(rendered)) writeFileSync(path.join(out, name), text);
  say(`wrote ${Object.keys(rendered).length} files to ${path.relative(ROOT, out)}`);
}

main().catch((error: unknown) => {
  if (error instanceof SnowflakeEvidenceLeakError) say(`${error.message} ${error.findings.join("; ")}`);
  else say(`snowflake-evidence failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
