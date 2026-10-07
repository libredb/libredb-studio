/**
 * `docs/providers/influxdb3.md` quotes sentences and numbers the code owns (InfluxDB spec SPEC-delivery B.1 and B.3),
 * the shape of `tests/unit/db/qdrant/provider-doc.test.ts`: one test file per type-id, because the tri-sync invariant
 * is per type-id.
 *
 * A value copied into prose is true only until the code moves, so every label, hint, route, keyword, bound, refusal,
 * error sentence and generated preview the doc quotes is read back here from the module that owns it, and the
 * tested version and digest from the capture manifest. Where a sentence is a template, the doc writes it with the
 * placeholders this file fills, or with the values a committed capture gives it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYAML } from "yaml";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import { MCP_EXPOSABLE, READ_ONLY_ENFORCED } from "@/lib/db/compatibility";
import { CREDENTIAL_WARNINGS } from "@/lib/db/credential-warnings";
import { createInfluxClient, type InfluxAnswer } from "@/lib/db/providers/timeseries/influxdb/client";
import {
  INFLUX_CELL_BUDGET,
  INFLUX_CONNECTION_SENTENCES,
  INFLUX_LIMITER_OPTIONS,
  INFLUX_LIST_CAP,
  INFLUX_MAX_IN_FLIGHT,
  INFLUX_RESPONSE_CAP_BYTES,
  INFLUX_ROW_CUT,
  INFLUX_SURFACE_TIMEOUT_MS,
  INFLUXDB3_DEFAULT_PORT,
} from "@/lib/db/providers/timeseries/influxdb/connection-options";
import {
  INFLUX_ERROR_SENTENCES,
  InfluxAnswerError,
  type InfluxErrorContext,
  toInfluxError,
} from "@/lib/db/providers/timeseries/influxdb/errors";
import { InfluxDB3Provider } from "@/lib/db/providers/timeseries/influxdb/index";
import { toInfluxOverview } from "@/lib/db/providers/timeseries/influxdb/monitoring";
import { type InfluxRoute, SQL_ROUTES } from "@/lib/db/providers/timeseries/influxdb/routes";
import { INFLUX_SYSTEM_DATABASES, RUN_DATABASE_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/run-database";
import { describeInfluxdb3Table, influxdb3PathRefusal } from "@/lib/db/providers/timeseries/influxdb/sql-objects";
import {
  evaluateInfluxSql,
  INFLUX_SQL_MAX_TEXT_BYTES,
  INFLUX_SQL_POLICY_SENTENCES,
  type InfluxSqlKeyword,
} from "@/lib/db/providers/timeseries/influxdb/sql-policy";
import { shapeJsonlBody } from "@/lib/db/providers/timeseries/influxdb/sql-results";
import { readPing } from "@/lib/db/providers/timeseries/influxdb/versions";
import { generateSelectQuery, generateTableQuery } from "@/lib/query-generators";
import { SeedConnectionSchema } from "@/lib/seed/types";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import type { DatabaseConnection } from "@/lib/types";
import { loadInfluxCapture, loadInfluxManifest } from "../../../helpers/influxdb-fixtures";
import { recordingInfluxTransport } from "../../../helpers/influxdb-transport";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const DOC = read("docs/providers/influxdb3.md");
const SEEDS = read("docs/SEED_CONNECTIONS.md");
const BACKLOG = read("docs/BACKLOG.md");

const CONNECTION: DatabaseConnection = {
  id: "influxdb3-doc",
  name: "InfluxDB 3",
  type: "influxdb3",
  host: "localhost",
  port: INFLUXDB3_DEFAULT_PORT,
  createdAt: new Date(0),
};
const provider = new InfluxDB3Provider(CONNECTION);
const capabilities = provider.getCapabilities();
const labels = provider.getLabels();
const UI = DB_UI_CONFIG.influxdb3;
const CORE = "3.12.0-core";

/** Thousands grouped by commas, the doc's spelling, the same in every locale. */
const n = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** Prose is one sentence per line, so a sentence that spans lines is compared with its line breaks read as spaces. */
const flat = (text: string): string => text.replace(/\s*\n\s*/g, " ");

/** The section under the heading line `heading`, up to the next heading of its level or above. */
function sectionOf(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`no heading ${heading}`);
  const level = heading.indexOf(" ");
  const inFence = (at: number) => lines.slice(0, at).filter((line) => line.startsWith("```")).length % 2 === 1;
  const end = lines.findIndex(
    (line, at) => at > start && /^#{1,6} /.test(line) && line.indexOf(" ") <= level && !inFence(at),
  );
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

/** The table row of `text` whose first cell is exactly `cell`. */
const rowOf = (text: string, cell: string): string | undefined =>
  text.split("\n").find((line) => line.startsWith(`| ${cell} |`));

/** A sentence template of `INFLUX_ERROR_SENTENCES`, read by key. */
function template(key: string): (...parts: string[]) => string {
  const value = INFLUX_ERROR_SENTENCES[key];
  if (typeof value !== "function") throw new TypeError(`${key} is not a template`);
  return value;
}

/** A fixed sentence of `INFLUX_ERROR_SENTENCES`, read by key. */
function sentence(key: string): string {
  const value = INFLUX_ERROR_SENTENCES[key];
  if (typeof value !== "string") throw new TypeError(`${key} is not a sentence`);
  return value;
}

/** What errors.ts needs to word a failure of a run against the session database `home`. */
const QUERY_CONTEXT: InfluxErrorContext = {
  type: "influxdb3",
  phase: "query",
  endpoint: { host: "localhost", port: INFLUXDB3_DEFAULT_PORT },
  generation: "v3",
  hasUser: false,
  database: "home",
  timeoutMs: 60_000,
  responseCapBytes: INFLUX_RESPONSE_CAP_BYTES,
  secretForms: [],
};

/** The sentence a committed 3.12.0 Core answer to the SQL query route becomes. */
function wordedCapture(name: string): string {
  const capture = loadInfluxCapture(CORE, name);
  const answer: InfluxAnswer = { status: capture.status, contentType: capture.contentType, text: capture.body };
  return toInfluxError(new InfluxAnswerError(answer, SQL_ROUTES.query.path), QUERY_CONTEXT).message;
}

/** A route as the doc's route table writes it: the request line, its URL query keys, and its body keys. */
function routeRow(route: InfluxRoute): string {
  const value = (key: string, entry: InfluxRoute["query"][string]) =>
    "fixed" in entry ? `\`${key}\` = \`${entry.fixed}\`` : `\`${key}\` (${entry.fill})`;
  const list = (record: InfluxRoute["query"] | undefined) =>
    record === undefined || Object.keys(record).length === 0
      ? "none"
      : Object.entries(record)
          .map(([key, entry]) => value(key, entry))
          .join(", ");
  return `| \`${route.method} ${route.path}\` | ${list(route.query)} | ${list(route.body)} |`;
}

/** The 3.12.0 Core describe answer for `home` as the provider reads it, the columns Generate Query is given. */
async function homeColumns() {
  const capture = loadInfluxCapture(CORE, "sql-schema-home");
  const detail = await describeInfluxdb3Table(
    {
      send: async () => ({ status: capture.status, contentType: capture.contentType, text: capture.body }),
      signal: new AbortController().signal,
      sessionDatabase: "home",
    },
    ["home"],
  );
  return detail.columns;
}

describe("docs/providers/influxdb3.md quotes what the code says", () => {
  test("the title and the overview name the dialog's label", () => {
    expect(UI.label).toBe("InfluxDB 3 (SQL)");
    expect(DOC.split("\n")[0]).toBe(`# ${UI.label} Provider`);
    expect(sectionOf(DOC, "## 1. Overview")).toContain(`"${UI.label}"`);
  });

  test("the tested version and its image digest are the capture manifest's", () => {
    const core = loadInfluxManifest().versions.find((entry) => entry.version === CORE);
    expect(core).toBeDefined();
    expect(flat(sectionOf(DOC, "### 1.2 Tested versions"))).toContain(
      `Tested against InfluxDB 3 Core 3.12.0, image \`${core?.image}\`, captured ${core?.capturedAt}.`,
    );
  });

  test("section 2.1 names the shared directory and the other type's doc", () => {
    const where = sectionOf(DOC, "### 2.1 Where it sits");
    expect(where).toContain("src/lib/db/providers/timeseries/influxdb/");
    expect(where).toContain("[influxdb.md](./influxdb.md)");
    expect(where).toContain("@/lib/db/providers/sql/sql-base");
  });

  test("the field rows are the dialog's labels and hints, and the port is the provider's default", () => {
    const fields = sectionOf(DOC, "### 4.1 Configuration fields");
    const hints = UI.fieldHints ?? {};
    expect(UI.fieldLabels?.password).toBe("Token");
    expect(rowOf(fields, "Host")).toBe(`| Host | ${hints.host} |`);
    expect(rowOf(fields, "Port")).toBe(`| Port | \`${INFLUXDB3_DEFAULT_PORT}\` by default, the InfluxDB 3 HTTP port |`);
    expect(UI.defaultPort).toBe(String(INFLUXDB3_DEFAULT_PORT));
    expect(capabilities.defaultPort).toBe(INFLUXDB3_DEFAULT_PORT);
    expect(rowOf(fields, "Token")).toBe(`| Token | ${hints.password} |`);
    expect(rowOf(fields, "Database")).toBe(`| Database | ${hints.database} |`);
    expect(rowOf(fields, "Send the password without TLS")).toBe(
      `| Send the password without TLS | ${hints.allowInsecureAuth} |`,
    );
    expect(rowOf(fields, "Read-only")).toBe(`| Read-only | ${UI.readOnlyHint} |`);
    expect(UI.connectionFields).not.toContain("user");
  });

  test("the authentication rules quote the connection options' sentences and the credential warning", () => {
    const auth = flat(sectionOf(DOC, "### 4.2 Authentication"));
    expect(auth).toContain("`Authorization: Bearer <token>`");
    expect(auth).toContain(`> ${INFLUX_CONNECTION_SENTENCES.influxdb3User}`);
    expect(auth).toContain(`> ${INFLUX_CONNECTION_SENTENCES.malformed("Token")}`);
    const noSecret = CREDENTIAL_WARNINGS.influxdb3?.find((entry) => entry.kind === "no-secret");
    expect(noSecret).toBeDefined();
    expect(auth).toContain(`> Credential warning: ${noSecret?.message}`);
  });

  test("the version and wrong-server sentences are the error table's", async () => {
    const version = flat(sectionOf(DOC, "### 4.3 Version and the wrong server"));
    // The mis-pick sentence as the provider words it over the committed 2.9.1 /ping and /health answers.
    const wire = recordingInfluxTransport([
      loadInfluxCapture("2.9.1", "ping-auth"),
      loadInfluxCapture("2.9.1", "health-auth"),
    ]);
    const misPicked = new InfluxDB3Provider(CONNECTION, {}, (options, routes) =>
      createInfluxClient(options, routes, wire.factory),
    );
    const refusal = await misPicked.connect().then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(refusal).toBe(template("noSqlOnVersion")("InfluxDB 2.9.1"));
    expect(version).toContain(`> ${refusal}`);
    expect(version).toContain(`> ${sentence("noSqlEndpoint")}`);
    expect(version).toContain(`> ${sentence("pingForbiddenNoDatabase")}`);
    expect(version).toContain(`> ${template("notSqlContentType")("[endpoint]", "[content type]")}`);
  });

  test("the session database sentences are the run-database module's", () => {
    const session = flat(sectionOf(DOC, "### 4.4 The session database"));
    expect(session).toContain(`> ${RUN_DATABASE_SENTENCES.sessionMany(["bench", "home"])}`);
    const hidden = [...INFLUX_SYSTEM_DATABASES].map((name) => `\`${name}\``);
    expect(session).toContain(`with ${hidden.slice(0, -1).join(", ")} and ${hidden.at(-1)} never counted`);
    expect(session).toContain(`> ${RUN_DATABASE_SENTENCES.sessionNone}`);
    expect(session).toContain(`> ${RUN_DATABASE_SENTENCES.listingRefused}`);
    expect(session).toContain(`> ${RUN_DATABASE_SENTENCES.internalHidden}`);
    expect(session).toContain(`> ${template("sqlDatabaseNotFound")("[database]")}`);
    // Up to ten names, then "and N more".
    const twelve = Array.from({ length: 12 }, (_, at) => `db${at + 1}`);
    expect(RUN_DATABASE_SENTENCES.sessionMany(twelve)).toContain("db10 and 2 more");
    expect(session).toContain('up to ten names, then "and N more"');
    expect(session).toContain(`[U81](../BACKLOG.md)`);
  });

  test("the plaintext refusal is the connection options' sentence", () => {
    const plaintext = flat(sectionOf(DOC, "### 4.5 A token needs TLS off this machine"));
    expect(plaintext).toContain(`> ${INFLUX_CONNECTION_SENTENCES.plaintext}`);
    expect(INFLUX_CONNECTION_SENTENCES.plaintext).toContain("Send the password without TLS");
  });

  test("the statement language is the generated statementLanguage, word for word", () => {
    expect(sectionOf(DOC, "### 5.1 The statement")).toContain(`\`\`\`text\n${labels.statementLanguage}\n\`\`\``);
  });

  test("the route table is SQL_ROUTES, every route and its keys, and nothing else", () => {
    const routes = sectionOf(DOC, "### 5.2 The routes");
    const documented = routes.split("\n").filter((line) => /^\| `(GET|POST) /.test(line));
    expect(documented).toEqual(Object.values(SQL_ROUTES).map(routeRow));
  });

  test("the six keywords are what the policy allows, and each refusal example is its verdict", () => {
    const policy = sectionOf(DOC, "### 5.3 The read policy");
    // Keyed by the policy's keyword type, so a seventh read keyword fails the typecheck until it is probed here.
    const probes: Readonly<Record<InfluxSqlKeyword, string>> = {
      SELECT: "SELECT 1",
      WITH: "WITH x AS (SELECT 1) SELECT * FROM x",
      VALUES: "VALUES (1)",
      SHOW: "SHOW TABLES",
      EXPLAIN: "EXPLAIN SELECT 1",
      DESCRIBE: 'DESCRIBE "home"',
    };
    for (const [keyword, text] of Object.entries(probes)) {
      expect(evaluateInfluxSql(text)).toEqual({ allowed: true, keyword: keyword as never });
    }
    expect(flat(policy)).toContain(
      `The first keyword, behind comments and opening parentheses, is one of ${Object.keys(probes)
        .slice(0, -1)
        .map((word) => `\`${word}\``)
        .join(", ")} and \`DESCRIBE\`.`,
    );
    const examples = policy.split("\n").filter((line) => /^\| `[^`]*` \| /.test(line));
    expect(examples.length).toBeGreaterThanOrEqual(7);
    for (const row of examples) {
      const [text, message] = row.slice(2, -2).split(" | ");
      const verdict = evaluateInfluxSql(text.slice(1, -1));
      expect(verdict.allowed).toBe(false);
      expect(verdict.allowed ? "" : verdict.message).toBe(message);
    }
    expect(examples.some((row) => row.includes(INFLUX_SQL_POLICY_SENTENCES.multipleStatements))).toBe(true);
    expect(examples.some((row) => row.includes(INFLUX_SQL_POLICY_SENTENCES.unterminated))).toBe(true);
    expect(examples.some((row) => row.includes(INFLUX_SQL_POLICY_SENTENCES.empty))).toBe(false);
    const words = /only a writing statement uses \(([^)]+)\) outside quotes/.exec(flat(policy))?.[1] ?? "";
    const listed = [...words.matchAll(/`(\w+)`/g)].map((match) => match[1]);
    expect(listed.length).toBe(12);
    for (const word of listed) {
      expect(evaluateInfluxSql(`SELECT 1 AS ${word}`)).toMatchObject({ allowed: false, reason: "write-word" });
    }
    expect(flat(policy)).toContain(`> ${INFLUX_SQL_POLICY_SENTENCES.empty}`);
    expect(flat(policy)).toContain(`> ${INFLUX_SQL_POLICY_SENTENCES.tooLong(INFLUX_SQL_MAX_TEXT_BYTES + 1)}`);
    expect(flat(policy)).toContain(`${n(INFLUX_SQL_MAX_TEXT_BYTES)} bytes of UTF-8`);
  });

  test("the bound-parameter refusal is the provider's", async () => {
    let message = "";
    try {
      await provider.query("SELECT 1", [1]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(flat(sectionOf(DOC, "### 5.3 The read policy"))).toContain(`> ${message}`);
  });

  test("the grammar table is the DataFusion row, every field", () => {
    const grammar = sectionOf(DOC, "### 5.4 The DataFusion grammar");
    const row = resolveSqlGrammar("influxdb3");
    const documented = grammar.split("\n").filter((line) => /^\| `\w+` \| `/.test(line));
    expect(documented.map((line) => line.split(" | ").slice(0, 2).join(" | "))).toEqual(
      Object.entries(row).map(([key, value]) => `| \`${key}\` | \`${JSON.stringify(value)}\``),
    );
  });

  test("every bound the doc quotes is the number the code enforces", () => {
    const bounds = sectionOf(DOC, "### 5.6 Bounds");
    const mib = INFLUX_RESPONSE_CAP_BYTES / (1024 * 1024);
    expect(rowOf(bounds, "Statement text")).toContain(`${n(INFLUX_SQL_MAX_TEXT_BYTES)} bytes of UTF-8`);
    expect(rowOf(bounds, "Response")).toContain(`${mib} MiB (${n(INFLUX_RESPONSE_CAP_BYTES)} bytes)`);
    expect(rowOf(bounds, "Rows")).toContain(`${n(INFLUX_ROW_CUT)} rows`);
    expect(rowOf(bounds, "Cells")).toContain(`${n(INFLUX_CELL_BUDGET)} cells`);
    expect(rowOf(bounds, "In flight")).toContain(
      `${INFLUX_LIMITER_OPTIONS.perProvider} calls per connection and ${INFLUX_LIMITER_OPTIONS.perEngine} per server type in this process, with a queue of ${INFLUX_LIMITER_OPTIONS.queueDepth}`,
    );
    expect(INFLUX_MAX_IN_FLIGHT).toBe(INFLUX_LIMITER_OPTIONS.perProvider);
    expect(rowOf(bounds, "Tree, connect and monitoring")).toContain(
      `${INFLUX_SURFACE_TIMEOUT_MS / 1000} seconds, or the query timeout when it is shorter`,
    );
    expect(rowOf(bounds, "Table listing")).toContain(`${n(INFLUX_LIST_CAP)} tables`);
    expect(flat(bounds)).toContain(`> ${template("tooLarge")(`${mib} MiB`)}`);
  });

  test("a row nested 64 levels deep is read, and one deeper is refused, as the doc says", () => {
    const nested = (depth: number) => `${'{"a":'.repeat(depth - 1)}{"b":1}${"}".repeat(depth - 1)}\n`;
    const limits = { rowCut: INFLUX_ROW_CUT, cellBudget: INFLUX_CELL_BUDGET };
    expect(shapeJsonlBody(nested(64), limits).rows).toHaveLength(1);
    expect(() => shapeJsonlBody(nested(65), limits)).toThrow();
    expect(flat(sectionOf(DOC, "### 5.5 Result shape"))).toContain("nested deeper than 64 levels");
    expect(flat(sectionOf(DOC, "### 5.5 Result shape"))).toContain(`> ${sentence("notReadableRow")}`);
  });

  test("a line naming a column twice is refused with the sentence the doc quotes", () => {
    const limits = { rowCut: INFLUX_ROW_CUT, cellBudget: INFLUX_CELL_BUDGET };
    expect(() => shapeJsonlBody('{"usage":1.5,"usage":1.5}\n', limits)).toThrow();
    const shape = flat(sectionOf(DOC, "### 5.5 Result shape"));
    expect(shape).toContain('`{"usage":1.5,"usage":1.5}`');
    expect(shape).toContain(`> ${template("repeatedColumn")("usage")}`);
  });

  test("the one-database sentences are what a cross-database statement and a long path get", () => {
    const one = flat(sectionOf(DOC, "### 5.8 One database per connection"));
    expect(one).toContain(`> ${wordedCapture("sql-cross-database")}`);
    expect(one).toContain(`> ${influxdb3PathRefusal("home")}`);
  });

  test("the previews are the generators' output over the built provider's capabilities", async () => {
    const previews = sectionOf(DOC, "### 5.9 Previews and Generate Query");
    const table = generateTableQuery(["home"], capabilities);
    const select = generateSelectQuery(["home"], await homeColumns(), capabilities);
    expect(table).not.toMatch(/\bLIMIT\b/);
    expect(previews).toContain(`\`\`\`sql\n${table}\n\`\`\``);
    expect(previews).toContain(`\`\`\`sql\n${select}\n\`\`\``);
    expect(flat(previews)).toContain(`> ${sentence("fileLimit")}`);
    expect(wordedCapture("filelimit-sql")).toBe(sentence("fileLimit"));
  });

  test("the error table quotes every sentence errors.ts gives this type", () => {
    const errors = flat(sectionOf(DOC, "## 10. Error handling"));
    const text = "[server text]";
    for (const quoted of [
      template("sqlParse")(text),
      template("sqlPlan")(text),
      template("sqlNotImplemented")(text),
      template("sqlRefused")(text),
      template("outOfMemory")(text),
      template("sqlTokenMayNotRead")("[database]"),
      template("sqlDatabaseNotFound")("[database]"),
      template("crossDatabase")("[table]", "[database]"),
      template("timeout")("[milliseconds]"),
      template("tooLarge")(`${INFLUX_RESPONSE_CAP_BYTES / (1024 * 1024)} MiB`),
      template("tls")("[endpoint]", "[code]"),
      template("noCompleteAnswer")("[endpoint]", "[code]"),
      template("redirect")("[endpoint]"),
      template("encoding")("[endpoint]"),
      sentence("token3Refused"),
      sentence("authorizationMalformed"),
      sentence("noSqlEndpoint"),
      sentence("fileLimit"),
      sentence("truncated"),
      sentence("notReadableRow"),
      template("repeatedColumn")("[column]"),
      sentence("cancelled"),
      sentence("unrecognised"),
    ]) {
      expect(errors).toContain(quoted);
    }
    // The table's examples are what the committed 3.12.0 answers become.
    expect(wordedCapture("sql-parse-error")).toBe(
      template("sqlParse")('SQL error: ParserError("Expected: an expression, found: EOF")'),
    );
    expect(wordedCapture("sql-not-implemented")).toBe(
      template("sqlNotImplemented")("This feature is not implemented: Unsupported SQL statement: SHOW DATABASES"),
    );
    expect(wordedCapture("sql-db-not-found")).toBe(template("sqlDatabaseNotFound")("home"));
    expect(wordedCapture("sql-schema-error")).toBe(
      template("sqlRefused")(
        "Schema error: No field named nope. Valid fields are home.co, home.hum, home.room, home.temp, home.time.",
      ),
    );
  });

  test("the monitoring section quotes the labels, the overview's version text and its floor", () => {
    const monitoring = flat(sectionOf(DOC, "## 7. Monitoring & health"));
    expect(monitoring).toContain(`> ${labels.slowQueriesEmptyState}`);
    expect(monitoring).toContain(`> ${labels.sessionsEmptyState}`);
    const ping = loadInfluxCapture(CORE, "ping-auth");
    const version = readPing({ status: ping.status, text: ping.body });
    const overview = (cut: boolean) =>
      toInfluxOverview({
        version,
        sessionDatabase: "home",
        objectCount: cut ? INFLUX_LIST_CAP : 6,
        objectCountCut: cut,
        objects: "tables",
      });
    expect(monitoring).toContain(`\`${overview(false).version}\``);
    expect(overview(false).version).toBe("InfluxDB 3 Core 3.12.0, database home");
    expect(monitoring).toContain(`"${overview(true).tableCountSampledFrom}"`);
  });

  test("the capability and label tables are the provider's declarations and the records'", () => {
    const section = sectionOf(DOC, "## 9. Capabilities & labels");
    const declared: Readonly<Record<string, unknown>> = { ...capabilities };
    for (const key of [
      "queryLanguage",
      "defaultPort",
      "enforcesReadOnly",
      "supportsResultPagination",
      "supportsExternalQueryLimiting",
      "supportsExplain",
      "supportsCreateTable",
      "supportsInlineRowEdit",
      "supportsTransactions",
      "supportsMaintenance",
      "supportsConnectionString",
      "identifierQuoting",
      "statementTerminator",
    ]) {
      expect(rowOf(section, `\`${key}\``)).toBe(`| \`${key}\` | \`${JSON.stringify(declared[key])}\` |`);
    }
    expect(capabilities.containerLevels).toBeUndefined();
    expect(capabilities.previewTimeWindow?.since).toBe("now() - INTERVAL '1 hour'");
    expect(rowOf(section, "`READ_ONLY_ENFORCED`")).toBe(
      `| \`READ_ONLY_ENFORCED\` | \`${READ_ONLY_ENFORCED.influxdb3}\` |`,
    );
    expect(rowOf(section, "`MCP_EXPOSABLE`")).toBe(`| \`MCP_EXPOSABLE\` | \`${MCP_EXPOSABLE.influxdb3}\` |`);
    const strings: Readonly<Record<string, unknown>> = { ...labels };
    for (const key of ["entityName", "entityNamePlural", "rowName", "selectAction", "generateAction"]) {
      expect(rowOf(section, `\`${key}\``)).toBe(`| \`${key}\` | ${String(strings[key])} |`);
    }
    expect(flat(section)).toContain(labels.statementLanguage as string);
  });

  test("the seed recipe names fields the seed schema declares, as docs/SEED_CONNECTIONS.md writes them", () => {
    const running = sectionOf(DOC, "## 12. Running InfluxDB 3 for Studio");
    const recipe = /```yaml\n([\s\S]*?)```/.exec(running)?.[1] ?? "";
    // The recipe with its environment placeholders filled is a seed the loader takes.
    const [seed] = parseYAML(recipe.replace(/\$\{\w+\}/g, "filled")) as unknown[];
    const parsed = SeedConnectionSchema.safeParse(seed);
    expect(parsed.error?.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) ?? []).toEqual([]);
    const keys = [...recipe.matchAll(/^\s+(?:- )?(\w+):/gm)].map((match) => match[1]);
    const shape = Object.keys((SeedConnectionSchema as unknown as { shape: Record<string, unknown> }).shape);
    const nested = new Set(["mode"]);
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys.filter((key) => !nested.has(key))) expect(shape).toContain(key);
    const seedBlock = SEEDS.slice(SEEDS.indexOf('- id: "metrics-influx3"'));
    for (const key of keys.filter((key) => !nested.has(key))) expect(seedBlock).toContain(`${key}:`);
    expect(running).toContain("[SEED_CONNECTIONS.md](../SEED_CONNECTIONS.md)");
  });

  test("every backlog id the doc cites is an entry of docs/BACKLOG.md", () => {
    const cited = [...new Set([...DOC.matchAll(/\b([DUB]\d{2,3})\b/g)].map((match) => match[1]))];
    for (const id of ["D196", "D197", "D198", "D200", "D201", "D202", "D204", "U79", "U80", "U81", "B94"]) {
      expect(cited).toContain(id);
    }
    for (const id of cited) expect(BACKLOG).toMatch(new RegExp(`^### ${id}\\. `, "m"));
  });

  test("the known limitations keep each stated limit", () => {
    const limits = flat(sectionOf(DOC, "## 13. Known limitations"));
    for (const fragment of [
      "On InfluxDB 3 Core every token is an admin token",
      "SSL mode `require` sends the token to a server whose certificate is not checked.",
      "no Arrow Flight",
      "An all-null column and the columns of an empty result cannot be known",
      "One connection reads one database",
      "A page boundary inside a tie of `time` can repeat or skip a row",
    ]) {
      expect(limits).toContain(fragment);
    }
  });

  test("the object edit section the edit census asks of an abstainer is there", () => {
    expect(DOC).toMatch(/^#{1,6} .*Object edit \(#789\)/m);
  });

  test("the doc carries no em dash and no en dash, and cites no factory.ts line", () => {
    expect(DOC).not.toMatch(/[\u2013\u2014]/);
    expect(DOC).not.toMatch(/factory\.ts:\d/);
  });
});
