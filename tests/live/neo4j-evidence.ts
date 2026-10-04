/**
 * The evidence harness of the Neo4j provider (spec 10; revisions SR7, SR10).
 *
 * It drives the graph layer's own Bolt client (`createBoltClient`) against the compose `neo4j` service of
 * docker/neo4j/README.md and writes one capture per statement into tests/fixtures/neo4j/<server version>/, as
 * `{ "$captured": { image, digest, date, database }, "statement", "options": { database, maxRows },
 * "outcome": "pass" | "fail", "result" | "error": { category, code, message } }`. The replay helper,
 * tests/helpers/neo4j-fixtures.ts, answers a run from these files, so the catalog, the statement gate and
 * the provider are tested on what 5.26 answered, not on what a test author expected.
 *
 * What it captures: every catalog statement, the qualified built-in functions the read policy allows, the
 * monitoring reads, the generators' statements for every seeded label and relationship type, every seeded
 * value type and a path, and the EXPLAIN classification the statement gate reads, of a read, a write, a SHOW,
 * a LOAD CSV, a TERMINATE, both orders of a version prefix, every allowlisted procedure call and every allowed
 * SHOW form. Connection-level answers (verify, a wrong password, a refused socket, TLS against a plaintext
 * server) go to the `transport/` subdirectory, beside the statement captures and never keyed as one.
 *
 * Two measurements go into the fixture README instead of a capture: the server's refusal of `CREATE (n)` in a
 * READ session, and a cancel as the query route sends it: an abort of the Bolt client's run of a long read,
 * with the time until the run rejects and the time until the transaction leaves `SHOW TRANSACTIONS`. The
 * client closes the session on the abort, so the second time is how long the server takes to stop the read.
 *
 * Read-only check: the node and relationship counts and the index and constraint names are read before and
 * after the whole run, and the run fails when they differ.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/):
 *   docker compose -f database-compose.yml up -d --wait neo4j
 *   bun tests/live/neo4j-evidence.ts
 *   docker compose -f database-compose.yml stop neo4j
 * An empty server is seeded from docker/neo4j/seed.cypher first.
 */
// oxlint-disable no-await-in-loop -- captures run one at a time, so each answer is the server's to that statement alone.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBoltClient } from "@/lib/db/graph/bolt/bolt-client";
import { type GraphClient, GraphClientError, type GraphRunResult } from "@/lib/db/graph/bolt/client";
import { cypherSelectLabel, cypherSelectRelationship } from "@/lib/db/graph/cypher/generators";
import { quoteCypherName } from "@/lib/db/graph/cypher/quote";
import { CATALOG_ROW_BOUND, NEO4J_CATALOG_STATEMENTS } from "@/lib/db/providers/graph/neo4j/catalog";
import { NEO4J_POLICY_PROFILE } from "@/lib/db/providers/graph/neo4j/profile";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";

const ROOT = join(import.meta.dir, "..", "..");
const CONTAINER = "libredb-neo4j";
const HOST = "127.0.0.1";
const URI = `bolt://${HOST}:7687`;
const USER = "neo4j";
const PASSWORD = "password123";
const TIMEOUT_MS = 30_000;
const USER_AGENT = "libredb-studio-evidence";
/** A read that runs for minutes: the cancel and timeout subject. */
const LONG_READ = "UNWIND range(1, 2000000000) AS x RETURN count(x)";
const CANCEL_APP = "neo4j-evidence-cancel";
/** The functions query of SR7, run on the server whose version names the fixture directory. */
const BUILT_IN_FUNCTIONS =
  "SHOW FUNCTIONS YIELD name, isBuiltIn WHERE isBuiltIn AND name CONTAINS '.' RETURN name ORDER BY name";

interface Captured {
  readonly image: string;
  readonly digest: string;
  readonly date: string;
  readonly database: string | null;
}

interface CaptureError {
  readonly category: string;
  readonly code: string | null;
  readonly message: string;
}

function docker(...args: string[]): string {
  const out = spawnSync("docker", args, { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${out.stderr}`);
  return out.stdout.trim();
}

function errorOf(error: unknown): CaptureError {
  if (!(error instanceof GraphClientError)) throw error;
  return { category: error.category, code: error.code ?? null, message: error.message };
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function write(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function poll<T>(read: () => Promise<T | undefined>, limitMs: number): Promise<T> {
  const deadline = performance.now() + limitMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw new Error(`nothing within ${limitMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function main(): Promise<void> {
  const reference = docker("inspect", "--format", "{{.Config.Image}}", CONTAINER);
  const [image, digest] = reference.split("@");
  if (image === undefined || digest === undefined) throw new Error(`${CONTAINER} runs ${reference}, not a digest pin`);

  const client: GraphClient = createBoltClient({
    uri: URI,
    user: USER,
    password: PASSWORD,
    connectionTimeoutMs: TIMEOUT_MS,
    userAgent: USER_AGENT,
  });
  const run = (statement: string, database: string | undefined, maxRows = CATALOG_ROW_BOUND) =>
    client.run(statement, { database, timeoutMs: TIMEOUT_MS, maxRows });

  const server = await client.verify();
  const home = (await run(NEO4J_CATALOG_STATEMENTS.homeDatabase, undefined)).rows[0]?.name;
  if (typeof home !== "string") throw new Error("the server reported no home database");

  const counted = (await run("MATCH (n) RETURN count(n) AS n", home)).rows[0]?.n;
  if (counted === 0) {
    const seeded = spawnSync("docker", ["exec", "-i", CONTAINER, "cypher-shell", "-u", USER, "-p", PASSWORD], {
      input: readFileSync(join(ROOT, "docker", "neo4j", "seed.cypher")),
    });
    if (seeded.status !== 0) throw new Error(`the seed failed: ${seeded.stderr}`);
  }

  const components = await run("CALL dbms.components() YIELD versions RETURN versions[0] AS version", home);
  const version = components.rows[0]?.version;
  if (typeof version !== "string" || !version.startsWith("5.26.")) throw new Error(`not a 5.26 server: ${version}`);
  const out = join(ROOT, "tests", "fixtures", "neo4j", version);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "transport"), { recursive: true });

  const stamp = (database: string | undefined): Captured => ({
    image,
    digest,
    date: new Date().toISOString(),
    database: database ?? null,
  });

  const snapshot = async () =>
    JSON.stringify(
      await Promise.all([
        run("MATCH (n) RETURN count(n) AS n", home),
        run("MATCH ()-[r]->() RETURN count(r) AS r", home),
        run("SHOW INDEXES YIELD name RETURN name ORDER BY name", home),
        run("SHOW CONSTRAINTS YIELD name RETURN name ORDER BY name", home),
      ]).then((results) => results.map((result) => result.rows)),
    );
  const before = await snapshot();

  const names = new Set<string>();
  const capture = async (
    name: string,
    statement: string,
    database: string | undefined,
    maxRows: number,
    timeoutMs = TIMEOUT_MS,
  ): Promise<GraphRunResult | undefined> => {
    if (names.has(name)) throw new Error(`two captures named ${name}`);
    names.add(name);
    const head = { $captured: stamp(database), statement, options: { database: database ?? null, maxRows } };
    try {
      const result = await client.run(statement, { database, timeoutMs, maxRows });
      write(join(out, `${name}.json`), { ...head, outcome: "pass", result });
      return result;
    } catch (error) {
      write(join(out, `${name}.json`), { ...head, outcome: "fail", error: errorOf(error) });
      return undefined;
    }
  };

  // The catalog (SR4, SR16).
  await capture("catalog-home-database", NEO4J_CATALOG_STATEMENTS.homeDatabase, undefined, CATALOG_ROW_BOUND);
  const labels = await capture("catalog-label", NEO4J_CATALOG_STATEMENTS.label, home, CATALOG_ROW_BOUND);
  const types = await capture(
    "catalog-relationship-type",
    NEO4J_CATALOG_STATEMENTS.relationship_type,
    home,
    CATALOG_ROW_BOUND,
  );
  await capture("catalog-index", NEO4J_CATALOG_STATEMENTS.index, home, CATALOG_ROW_BOUND);
  await capture("catalog-constraint", NEO4J_CATALOG_STATEMENTS.constraint, home, CATALOG_ROW_BOUND);
  await capture("catalog-node-properties", NEO4J_CATALOG_STATEMENTS.nodeProperties, home, CATALOG_ROW_BOUND);
  await capture(
    "catalog-relationship-properties",
    NEO4J_CATALOG_STATEMENTS.relationshipProperties,
    home,
    CATALOG_ROW_BOUND,
  );
  // The qualified built-in functions the read policy allows (SR7).
  await capture("functions-built-in", BUILT_IN_FUNCTIONS, home, CATALOG_ROW_BOUND);
  if (labels === undefined || types === undefined) throw new Error("the label or type listing failed");
  const labelNames = labels.rows.map((row) => String(row.label));
  const typeNames = types.rows.map((row) => String(row.relationshipType));

  // The monitoring reads (T10).
  await capture(
    "monitor-components",
    "CALL dbms.components() YIELD name, versions, edition",
    home,
    DEFAULT_QUERY_LIMIT,
  );
  await capture("monitor-ping", "CALL db.ping()", home, DEFAULT_QUERY_LIMIT);
  await capture(
    "monitor-transactions",
    "SHOW TRANSACTIONS YIELD database, transactionId, username, currentQuery, startTime, status, elapsedTime",
    home,
    DEFAULT_QUERY_LIMIT,
  );
  await capture("monitor-node-count", "MATCH (n) RETURN count(n) AS nodes", home, DEFAULT_QUERY_LIMIT);
  await capture(
    "monitor-relationship-count",
    "MATCH ()-[r]->() RETURN count(r) AS relationships",
    home,
    DEFAULT_QUERY_LIMIT,
  );
  for (const label of labelNames) {
    await capture(
      `monitor-label-count-${slug(label)}`,
      `MATCH (n:${quoteCypherName(label)}) RETURN count(n) AS c`,
      home,
      DEFAULT_QUERY_LIMIT,
    );
  }
  await capture(
    "monitor-index-usage",
    "SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, state, readCount, lastRead, populationPercent",
    home,
    DEFAULT_QUERY_LIMIT,
  );

  // The generators' statements, as a tree click sends them.
  for (const label of labelNames) {
    await capture(`generate-label-${slug(label)}`, cypherSelectLabel(label), home, DEFAULT_QUERY_LIMIT);
  }
  for (const type of typeNames) {
    await capture(`generate-relationship-${slug(type)}`, cypherSelectRelationship(type), home, DEFAULT_QUERY_LIMIT);
  }

  // Every seeded value type, and a path.
  await capture(
    "value-types",
    [
      "MATCH (s:Service {id: 'types'})",
      "MATCH p = (:Person)-[:MEMBER_OF]->(:Team)",
      "RETURN s.aString AS aString, s.anInteger AS anInteger, s.beyondDoubles AS beyondDoubles,",
      "s.minInteger AS minInteger, s.aFloat AS aFloat, s.notANumber AS notANumber, s.aBoolean AS aBoolean,",
      "s.aList AS aList, s.aDate AS aDate, s.aLocalTime AS aLocalTime, s.aTime AS aTime,",
      "s.aLocalDateTime AS aLocalDateTime, s.aDateTime AS aDateTime, s.aDuration AS aDuration,",
      "s.aCartesianPoint AS aCartesianPoint, s.aWgs84Point AS aWgs84Point, s AS node, p AS path",
      "LIMIT 1",
    ].join(" "),
    home,
    DEFAULT_QUERY_LIMIT,
  );

  // The statement gate's classification (SR10): maxRows 0, as the gate runs it.
  await capture("explain-read", "EXPLAIN MATCH (n) RETURN n", home, 0);
  await capture("explain-write", "EXPLAIN CREATE (n)", home, 0);
  await capture("explain-load-csv", `EXPLAIN LOAD CSV FROM 'http://${HOST}:9/x.csv' AS row RETURN row`, home, 0);
  await capture("explain-terminate", "EXPLAIN TERMINATE TRANSACTIONS 'x'", home, 0);
  await capture("explain-version-prefix-first", "CYPHER 5 EXPLAIN MATCH (n) RETURN n", home, 0);
  await capture("explain-version-prefix-after", "EXPLAIN CYPHER 5 MATCH (n) RETURN n", home, 0);
  for (const procedure of NEO4J_POLICY_PROFILE.readPolicy.allowedProcedures) {
    await capture(`explain-call-${slug(procedure)}`, `EXPLAIN CALL ${procedure}()`, home, 0);
  }
  for (const form of NEO4J_POLICY_PROFILE.readPolicy.allowedShowForms) {
    const typed = form.map((word) => (word === "*" ? home : word)).join(" ");
    await capture(`explain-show-${slug(form.join(" "))}`, `EXPLAIN SHOW ${typed}`, home, 0);
  }

  // Errors the error table maps.
  await capture("error-syntax", "MATCH (n RETURN n", home, DEFAULT_QUERY_LIMIT);
  await capture("error-query", "RETURN 1 / 0", home, DEFAULT_QUERY_LIMIT);
  await capture("error-timeout", LONG_READ, home, DEFAULT_QUERY_LIMIT, 1000);

  // Transport answers.
  write(join(out, "verify.json"), {
    $captured: stamp(undefined),
    surface: "verify()",
    outcome: "pass",
    result: server,
  });
  const transport = async (name: string, surface: string, uri: string, password: string) => {
    const other = createBoltClient({ uri, user: USER, password, connectionTimeoutMs: 5000, userAgent: USER_AGENT });
    try {
      const result = await other.verify();
      write(join(out, "transport", `${name}.json`), { $captured: stamp(undefined), surface, outcome: "pass", result });
    } catch (error) {
      write(join(out, "transport", `${name}.json`), {
        $captured: stamp(undefined),
        surface,
        outcome: "fail",
        error: errorOf(error),
      });
    } finally {
      await other.close();
    }
  };
  await transport("error-auth", "verify() with a wrong password", URI, "wrong-password");
  await transport("error-connection", `verify() to ${HOST}:1, where nothing listens`, `bolt://${HOST}:1`, PASSWORD);
  await transport("error-tls", "verify() over bolt+s:// to the plaintext server", `bolt+s://${HOST}:7687`, PASSWORD);

  // The AccessMode refusal of a write in a READ session (README only).
  let accessMode: CaptureError;
  try {
    await run("CREATE (n)", home);
    throw new Error("CREATE (n) ran in a READ session");
  } catch (error) {
    accessMode = errorOf(error);
  }

  // How long an abort takes to stop a long read, through the Bolt client as the query route cancels (README only).
  const abort = new AbortController();
  const ended = client
    .run(LONG_READ, {
      database: home,
      timeoutMs: TIMEOUT_MS,
      maxRows: DEFAULT_QUERY_LIMIT,
      signal: abort.signal,
      metadata: { app: CANCEL_APP },
    })
    .then(
      () => "completed",
      (error: unknown) => {
        const caught = errorOf(error);
        return `${caught.category}: ${caught.message}`;
      },
    );
  const running = `SHOW TRANSACTIONS YIELD transactionId, metaData WHERE metaData.app = '${CANCEL_APP}' RETURN transactionId`;
  await poll(async () => ((await run(running, home)).rows.length > 0 ? true : undefined), 10_000);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const abortStart = performance.now();
  abort.abort();
  const endedAs = await ended;
  const rejectMs = performance.now() - abortStart;
  await poll(async () => ((await run(running, home)).rows.length === 0 ? true : undefined), 30_000);
  const goneMs = performance.now() - abortStart;

  const after = await snapshot();
  await client.close();
  if (after !== before) throw new Error(`the server changed during the run:\n${before}\n${after}`);

  const files = names.size;
  const readme = [
    `# Neo4j ${version} captures`,
    "",
    "What the compose `neo4j` service answered to the graph layer's Bolt client, one statement per file, written by `tests/live/neo4j-evidence.ts`.",
    "Tests replay them through `recordedGraphClient` in `tests/helpers/neo4j-fixtures.ts`, which answers a run by the exact database and statement text and fails on any other.",
    "No value in these files was typed by hand.",
    "",
    "## Provenance",
    "",
    "| Item | Value |",
    "|---|---|",
    `| Image | \`${image}\` |`,
    `| Digest | \`${digest}\` |`,
    `| Server | \`${server.agent}\`, Bolt ${server.protocolVersion} |`,
    `| Home database | \`${home}\` |`,
    `| Seed | \`docker/neo4j/seed.cypher\` |`,
    `| Captured | ${new Date().toISOString().slice(0, 10)} |`,
    "",
    `There are ${files} statement captures, plus \`verify.json\` and three transport captures under \`transport/\`.`,
    "The node and relationship counts and the index and constraint names were read before and after the run, and were the same.",
    "",
    "## Encoding",
    "",
    'Each statement file is `{ "$captured": { image, digest, date, database }, "statement", "options": { database, maxRows }, "outcome": "pass" | "fail", "result" | "error" }`.',
    "A `result` is the client's `GraphRunResult`, so its rows are already the JSON-safe values `record-values.ts` writes.",
    "An `error` is `{ category, code, message }` of the client's `GraphClientError`.",
    "A transport file carries a `surface` sentence instead of a statement and options.",
    "The `explain-*` captures ran with `maxRows: 0`, as the statement gate runs them.",
    "",
    "## Measured, not captured",
    "",
    "`CREATE (n)` in a READ session was refused by the server:",
    "",
    "```text",
    `${accessMode.code}: ${accessMode.message}`,
    "```",
    "",
    `An abort of the Bolt client's run of \`${LONG_READ}\` rejected the run ${rejectMs.toFixed(1)} ms later, with:`,
    "",
    "```text",
    endedAs.trim(),
    "```",
    "",
    `The client closed the session on the abort, and the transaction left \`SHOW TRANSACTIONS\` ${goneMs.toFixed(0)} ms after the abort.`,
    "",
  ].join("\n");
  writeFileSync(join(out, "README.md"), readme);
  console.log(JSON.stringify({ out, files, accessMode, rejectMs, goneMs, endedAs }, null, 2));
}

await main();
