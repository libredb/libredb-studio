/**
 * `docs/providers/influxdb.md` quotes sentences and numbers the code owns (InfluxDB SPEC-delivery B.1 and B.3), the
 * shape of `tests/unit/db/qdrant/provider-doc.test.ts`.
 *
 * A value copied into prose is true only until the code moves, and nothing else goes red when it stops being true.
 * So every label, hint, refusal, error sentence, route, bound, capability, generated text, tested image and seed
 * field the doc states is read back here from the module that owns it: the exported constants where one exists, and
 * the provider's own answer where the sentence is private to it (the validate, maintenance and container-path
 * refusals, the plaintext refusal before any client, and which statements are sent with no database). A template
 * sentence is checked by its fixed parts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import { MCP_EXPOSABLE, READ_ONLY_ENFORCED } from "@/lib/db/compatibility";
import { CREDENTIAL_WARNINGS } from "@/lib/db/credential-warnings";
import type { InfluxAnswer, InfluxClientFactory, InfluxRequest } from "@/lib/db/providers/timeseries/influxdb/client";
import {
  INFLUX_CELL_BUDGET,
  INFLUX_CONNECTION_SENTENCES,
  INFLUX_LIMITER_OPTIONS,
  INFLUX_LIST_CAP,
  INFLUX_RESPONSE_CAP_BYTES,
  INFLUX_ROW_CUT,
  INFLUX_SURFACE_TIMEOUT_MS,
  INFLUXDB_DEFAULT_PORT,
} from "@/lib/db/providers/timeseries/influxdb/connection-options";
import { INFLUX_ERROR_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/errors";
import {
  INFLUXQL_PREVIEW_LIMIT,
  INFLUXQL_PREVIEW_WINDOW,
  influxqlSelectQuery,
  influxqlTableQuery,
} from "@/lib/db/providers/timeseries/influxdb/influxql-generators";
import { INFLUXQL_KEYWORDS } from "@/lib/db/providers/timeseries/influxdb/influxql-lexer";
import { describeInfluxqlMeasurement } from "@/lib/db/providers/timeseries/influxdb/influxql-objects";
import {
  evaluateInfluxql,
  INFLUXQL_MAX_TEXT_BYTES,
  INFLUXQL_POLICY_SENTENCES,
  type InfluxqlRefusalReason,
} from "@/lib/db/providers/timeseries/influxdb/influxql-policy";
import { InfluxDBProvider } from "@/lib/db/providers/timeseries/influxdb/index";
import { INFLUXQL_CHUNK_SIZE, INFLUXQL_ROUTES, type InfluxRoute } from "@/lib/db/providers/timeseries/influxdb/routes";
import { INFLUX_SYSTEM_DATABASES, RUN_DATABASE_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/run-database";
import { GENERATION_TRAITS } from "@/lib/db/providers/timeseries/influxdb/versions";
import { SeedConnectionSchema } from "@/lib/seed/types";
import type { DatabaseConnection } from "@/lib/types";
import { loadInfluxCapture, loadInfluxManifest } from "../../../helpers/influxdb-fixtures";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const TEST_PASSWORD = "password";
const DOC = readFileSync(path.join(ROOT, "docs/providers/influxdb.md"), "utf8");
const SEEDS = readFileSync(path.join(ROOT, "docs/SEED_CONNECTIONS.md"), "utf8");
const UI = DB_UI_CONFIG.influxdb;
const INFLUXDB: DatabaseConnection = {
  id: "influxdb-doc",
  name: "InfluxDB",
  type: "influxdb",
  host: "127.0.0.1",
  port: INFLUXDB_DEFAULT_PORT,
  createdAt: new Date(0),
};
const provider = new InfluxDBProvider(INFLUXDB);
const labels = provider.getLabels();
const capabilities = provider.getCapabilities();

/** Digits in groups of three, without a locale call. */
const n = (value: number): string => String(value).replace(/\B(?=(\d{3})+$)/g, ",");
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

/** The fixed parts of a template sentence: what it says around the values it is handed. */
function fixedParts(template: (...parts: string[]) => string, arity: number): readonly string[] {
  const marker = "\u0001";
  return template(...Array.from({ length: arity }, () => marker))
    .split(marker)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** A route's row of the route table: its request line, its URL query keys, and its form keys. */
function routeRow(route: InfluxRoute): string {
  const query = Object.keys(route.query);
  const form = Object.entries(route.form ?? {}).map(([key, value]) =>
    "fixed" in value ? `\`${key}=${value.fixed}\`` : `\`${key}\` (${value.fill})`,
  );
  return `| \`${route.method} ${route.path}\` | ${query.length === 0 ? "none" : query.join(", ")} | ${form.length === 0 ? "none" : form.join(", ")} |`;
}

/** A client that answers the connect sequence of a 1.x server and records every request it is handed. */
function scriptedClient(): { readonly factory: InfluxClientFactory; readonly requests: InfluxRequest<string>[] } {
  const requests: InfluxRequest<string>[] = [];
  const answer = (status: number, text: string): InfluxAnswer => ({ status, contentType: "application/json", text });
  const client = {
    send: async (request: InfluxRequest<string>): Promise<InfluxAnswer> => {
      requests.push(request);
      if (request.route === "ping") return answer(204, "");
      if (request.route === "health") return answer(200, '{"version":"1.13.1"}');
      if (request.values.q === "SHOW DATABASES" && requests.length === 3) {
        return answer(
          200,
          '{"results":[{"statement_id":0,"series":[{"name":"databases","columns":["name"],"values":[["home"],["edge"]]}]}]}',
        );
      }
      return answer(200, '{"results":[{"statement_id":0}]}');
    },
    close: () => {},
  };
  return { factory: (() => client) as unknown as InfluxClientFactory, requests };
}

async function rejection(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

/** The `home` measurement's columns as the provider describes them, from the 1.13.1 captures of the seeded server. */
async function homeColumns() {
  const captured: Record<string, string> = {
    'SHOW TAG KEYS ON "home" FROM "home"': loadInfluxCapture("1.13.1", "show-tag-keys-home").body,
    'SHOW FIELD KEYS ON "home" FROM "home"': loadInfluxCapture("1.13.1", "show-field-keys-home").body,
  };
  const detail = await describeInfluxqlMeasurement(
    {
      send: async (request) => ({ status: 200, contentType: "application/json", text: captured[request.values.q] }),
      signal: () => new AbortController().signal,
      generation: "v1",
    },
    "home",
    "home",
  );
  return detail.columns;
}

/** One refused text per refusal class the policy has, each with the sentence the doc quotes beside it. */
const REFUSED_EXAMPLES: readonly string[] = [
  "-- nothing here",
  'from(bucket: "home") |> range(start: -1h)',
  "SELECT * FROM home WHERE time > now() - 10µs",
  "SELECT * FROM home WHERE room = 'Kitchen",
  "SELECT * FROM {home}",
  "SELECT * FROM home WHERE room = $room",
  "SELECT * FROM home; DROP DATABASE home",
  "SHOW DATABASES SHOW DATABASES",
  "DROP DATABASE home",
  "EXPLAIN DROP DATABASE home",
  "SELECT * FROM home DROP",
  "SELECT mean(temp) INTO other..x FROM home",
];

describe("docs/providers/influxdb.md quotes what the code says", () => {
  test("the overview names the dialog's label, and section 2.1 names the other type", () => {
    expect(sectionOf(DOC, "## 1. Overview")).toContain(`"${UI.label}"`);
    expect(sectionOf(DOC, "### 2.1 Where it sits")).toContain(`"${DB_UI_CONFIG.influxdb3.label}"`);
    expect(sectionOf(DOC, "### 2.1 Where it sits")).toContain("[influxdb3.md](./influxdb3.md)");
  });

  test("every tested version is the manifest's, with its image and digest", () => {
    const tested = sectionOf(DOC, "### 1.2 Tested versions");
    const manifest = loadInfluxManifest();
    expect(manifest.versions.length).toBe(3);
    for (const entry of manifest.versions) expect(tested).toContain(`\`${entry.image}\``);
  });

  test("the field rows are the dialog's labels and hints, and the port is the provider's default", () => {
    const fields = sectionOf(DOC, "### 4.1 Configuration fields");
    const hints = UI.fieldHints ?? {};
    expect(UI.defaultPort).toBe(String(INFLUXDB_DEFAULT_PORT));
    expect(rowOf(fields, "Host")).toBe(`| Host | ${hints.host} |`);
    expect(rowOf(fields, "Port")).toContain(`\`${INFLUXDB_DEFAULT_PORT}\` by default`);
    expect(rowOf(fields, UI.fieldLabels?.password ?? "")).toBe(`| Password or token | ${hints.password} |`);
    expect(rowOf(fields, "Database")).toBe(`| Database | ${hints.database} |`);
    expect(rowOf(fields, "Send the password without TLS")).toBe(
      `| Send the password without TLS | ${hints.allowInsecureAuth} |`,
    );
    expect(INFLUX_CONNECTION_SENTENCES.plaintext).toContain("tick Send the password without TLS");
    expect(fields).toContain(`> ${UI.readOnlyHint}`);
    expect(UI.connectionFields).toEqual(["host", "port", "user", "password", "database", "allowInsecureAuth"]);
  });

  test("the credential sentences are the connection options', the template by its fixed parts", () => {
    const auth = flat(sectionOf(DOC, "### 4.2 Authentication"));
    for (const sentence of [
      INFLUX_CONNECTION_SENTENCES.userWithoutPassword,
      INFLUX_CONNECTION_SENTENCES.userColon,
      INFLUX_CONNECTION_SENTENCES.databaseControl,
    ]) {
      expect(auth).toContain(`> ${sentence}`);
    }
    for (const part of fixedParts((field) => INFLUX_CONNECTION_SENTENCES.malformed(field as "User"), 1)) {
      expect(auth).toContain(part);
    }
    expect(auth).toContain(INFLUX_ERROR_SENTENCES.passwordWithoutUser as string);
  });

  test("the credential warning is the record's sentence", () => {
    const warning = CREDENTIAL_WARNINGS.influxdb?.find((entry) => entry.kind === "no-secret");
    expect(warning).toBeDefined();
    expect(sectionOf(DOC, "### 4.2 Authentication")).toContain(`> Credential warning: ${warning?.message}`);
  });

  test("the plaintext refusal is the provider's, raised before any client is built", async () => {
    let built = 0;
    const factory = (() => {
      built += 1;
      throw new Error("no client may be built");
    }) as unknown as InfluxClientFactory;
    const remote = new InfluxDBProvider(
      { ...INFLUXDB, host: "influx.example.com", password: TEST_PASSWORD },
      {},
      factory,
    );
    const sentence = await rejection(() => remote.connect());
    expect(built).toBe(0);
    expect(sentence).toBe(INFLUX_CONNECTION_SENTENCES.plaintext);
    expect(sectionOf(DOC, "### 4.3 A password or token needs TLS off this machine")).toContain(`> ${sentence}`);
  });

  test("the version table is the generation table, every line's label and its _internal rule", () => {
    const versions = sectionOf(DOC, "### 4.6 Server versions");
    for (const traits of Object.values(GENERATION_TRAITS)) {
      const row = rowOf(versions, traits.label);
      expect(row).toBeDefined();
      expect(row).toContain(traits.internalDatabase === "browse" ? "listed and run" : "hidden and refused");
    }
  });

  test("the run-database sentences and the system databases are run-database.ts's", () => {
    const run = flat(sectionOf(DOC, "### 4.7 The database a run uses"));
    expect(run).toContain(`> ${RUN_DATABASE_SENTENCES.chooseDatabase}`);
    expect(run).toContain(`> ${RUN_DATABASE_SENTENCES.internalHidden}`);
    expect(run).toContain(`> ${INFLUX_ERROR_SENTENCES.oneDatabasePerStatement}`);
    for (const name of INFLUX_SYSTEM_DATABASES) expect(run).toContain(`\`${name}\``);
  });

  test("the statements sent with no database are the ones the provider sends without db", async () => {
    const line = DOC.split("\n").find((text) => text.startsWith("Sent with no database:"));
    expect(line).toBeDefined();
    const statements = [...(line ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    expect(statements.length).toBe(10);
    const { factory, requests } = scriptedClient();
    const connected = new InfluxDBProvider({ ...INFLUXDB, database: "home" }, {}, factory);
    await connected.connect();
    for (const statement of [...statements, "SHOW MEASUREMENTS"]) {
      const text = statement === "SHOW GRANTS FOR" ? 'SHOW GRANTS FOR "reader"' : statement;
      // oxlint-disable-next-line no-await-in-loop -- each run's request is read as the last one recorded.
      await connected.query(text);
      const sent = requests[requests.length - 1].values;
      expect(sent.q).toBe(text);
      // The control: a statement that is not server-wide reads the connection's database.
      if (statement === "SHOW MEASUREMENTS") expect(sent.db).toBe("home");
      else expect(sent.db).toBeUndefined();
    }
    await connected.disconnect();
  });

  test("the statements sent with no database are every SHOW form of the grammar the provider sends without db", async () => {
    const line = DOC.split("\n").find((text) => text.startsWith("Sent with no database:"));
    const listed = [...(line ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    // Every SHOW statement of the influxql v1.4.1 parser, so an entry added to the provider's server-wide list goes red.
    const grammar: Readonly<Record<string, string>> = {
      "SHOW CONTINUOUS QUERIES": "SHOW CONTINUOUS QUERIES",
      "SHOW DATABASES": "SHOW DATABASES",
      "SHOW DIAGNOSTICS": "SHOW DIAGNOSTICS",
      "SHOW FIELD KEY CARDINALITY": "SHOW FIELD KEY CARDINALITY",
      "SHOW FIELD KEY EXACT CARDINALITY": "SHOW FIELD KEY EXACT CARDINALITY",
      "SHOW FIELD KEYS": "SHOW FIELD KEYS",
      "SHOW GRANTS FOR": 'SHOW GRANTS FOR "reader"',
      "SHOW MEASUREMENT CARDINALITY": "SHOW MEASUREMENT CARDINALITY",
      "SHOW MEASUREMENT EXACT CARDINALITY": "SHOW MEASUREMENT EXACT CARDINALITY",
      "SHOW MEASUREMENTS": "SHOW MEASUREMENTS",
      "SHOW QUERIES": "SHOW QUERIES",
      "SHOW RETENTION POLICIES": "SHOW RETENTION POLICIES",
      "SHOW SERIES": "SHOW SERIES",
      "SHOW SERIES CARDINALITY": "SHOW SERIES CARDINALITY",
      "SHOW SERIES EXACT CARDINALITY": "SHOW SERIES EXACT CARDINALITY",
      "SHOW SHARD GROUPS": "SHOW SHARD GROUPS",
      "SHOW SHARDS": "SHOW SHARDS",
      "SHOW STATS": "SHOW STATS",
      "SHOW SUBSCRIPTIONS": "SHOW SUBSCRIPTIONS",
      "SHOW TAG KEY CARDINALITY": "SHOW TAG KEY CARDINALITY",
      "SHOW TAG KEY EXACT CARDINALITY": "SHOW TAG KEY EXACT CARDINALITY",
      "SHOW TAG KEYS": "SHOW TAG KEYS",
      "SHOW TAG VALUES": 'SHOW TAG VALUES WITH KEY = "room"',
      "SHOW TAG VALUES CARDINALITY": 'SHOW TAG VALUES CARDINALITY WITH KEY = "room"',
      "SHOW USERS": "SHOW USERS",
    };
    const { factory, requests } = scriptedClient();
    const connected = new InfluxDBProvider({ ...INFLUXDB, database: "home" }, {}, factory);
    await connected.connect();
    const withoutDatabase: string[] = [];
    for (const [form, text] of Object.entries(grammar)) {
      // oxlint-disable-next-line no-await-in-loop -- each run's request is read as the last one recorded.
      await connected.query(text);
      const sent = requests[requests.length - 1].values;
      expect(sent.q).toBe(text);
      if (sent.db === undefined) withoutDatabase.push(form);
    }
    await connected.disconnect();
    expect(withoutDatabase.toSorted()).toEqual(listed.toSorted());
  });

  test("the run-database steps name the Database field's _internal refusal", () => {
    const run = sectionOf(DOC, "### 4.7 The database a run uses");
    const step = run.split("\n").find((text) => text.startsWith("4. "));
    expect(step).toContain("`_internal`");
  });

  test("the system databases section names every line that hides _internal, as the version table does", () => {
    const system = flat(sectionOf(DOC, "### 6.2 `_internal` and the system databases"));
    for (const traits of Object.values(GENERATION_TRAITS)) {
      if (traits.internalDatabase === "hide" && traits.label !== "InfluxDB") expect(system).toContain(traits.label);
    }
  });

  test("the result shape points to the truncation row of the error table", () => {
    expect(flat(sectionOf(DOC, "### 5.4 Result shape"))).toMatch(/truncat[^.]*\(section 10\)/);
  });

  test("the Cloud Serverless sentence is the error table's", () => {
    expect(flat(sectionOf(DOC, "### 4.8 InfluxDB Cloud"))).toContain(`> ${INFLUX_ERROR_SENTENCES.cloudDbrp}`);
  });

  test("the request language is statementLanguage, word for word", () => {
    expect(sectionOf(DOC, "### 5.1 The request")).toContain(`\`\`\`text\n${labels.statementLanguage}\n\`\`\``);
  });

  test("the route table is INFLUXQL_ROUTES, every route, its query keys and its form keys, and nothing else", () => {
    const routes = sectionOf(DOC, "### 5.2 The routes");
    const documented = routes.split("\n").filter((line) => /^\| `(GET|POST) /.test(line));
    expect(documented).toEqual(Object.values(INFLUXQL_ROUTES).map(routeRow));
  });

  test("the allowed first keywords are the ones the policy lets lead a statement", () => {
    const line = DOC.split("\n").find((text) => text.startsWith("The first keyword is one of"));
    expect(line).toBeDefined();
    const documented = [...(line ?? "").matchAll(/`([A-Z]+)`/g)].map((match) => match[1]).sort();
    const allowed = [...INFLUXQL_KEYWORDS]
      .filter((word) => evaluateInfluxql(word).allowed || evaluateInfluxql(`${word} SELECT * FROM "m"`).allowed)
      .sort();
    expect(documented).toEqual(allowed);
  });

  test("every refusal class is shown with the policy's own sentence", () => {
    const refusals = flat(sectionOf(DOC, "### 5.3 What the policy refuses"));
    const reasons = new Set<InfluxqlRefusalReason>();
    for (const example of REFUSED_EXAMPLES) {
      const verdict = evaluateInfluxql(example);
      if (verdict.allowed) throw new Error(`${example} is allowed`);
      reasons.add(verdict.reason);
      expect(refusals).toContain(`\`${example}\``);
      expect(refusals).toContain(`> ${verdict.message}`);
    }
    const tooLong = `SELECT * FROM home WHERE room = '${"a".repeat(INFLUXQL_MAX_TEXT_BYTES + 1 - 34)}'`;
    const verdict = evaluateInfluxql(tooLong);
    if (verdict.allowed) throw new Error("the long text is allowed");
    expect(new TextEncoder().encode(tooLong).length).toBe(INFLUXQL_MAX_TEXT_BYTES + 1);
    reasons.add(verdict.reason);
    expect(refusals).toContain(`> ${verdict.message}`);
    expect(verdict.message).toBe(INFLUXQL_POLICY_SENTENCES.tooLong(INFLUXQL_MAX_TEXT_BYTES + 1));
    const every: readonly InfluxqlRefusalReason[] = [
      "bound-parameter",
      "empty",
      "flux",
      "into",
      "lexical",
      "multiple-statements",
      "not-a-read",
      "too-long",
    ];
    expect([...reasons].sort()).toEqual([...every]);
    expect(refusals).toContain(`> ${INFLUXQL_POLICY_SENTENCES.boundParameter}`);
    expect(refusals).toContain(`> ${INFLUXQL_POLICY_SENTENCES.flux}`);
  });

  test("the Flux refusal is quoted in the section it names", () => {
    expect(flat(sectionOf(DOC, "### 3.5 Coming from InfluxDB 2.x and Flux"))).toContain(
      `> ${INFLUXQL_POLICY_SENTENCES.flux}`,
    );
    expect(INFLUXQL_POLICY_SENTENCES.flux).toContain("section Coming from InfluxDB 2.x and Flux");
  });

  test("every bound the doc quotes is the number the code enforces", () => {
    const bounds = sectionOf(DOC, "### 5.5 Bounds");
    expect(rowOf(bounds, "Statement text")).toContain(`${n(INFLUXQL_MAX_TEXT_BYTES)} bytes of UTF-8`);
    expect(rowOf(bounds, "Response")).toContain(`${INFLUX_RESPONSE_CAP_BYTES / (1024 * 1024)} MiB`);
    expect(rowOf(bounds, "Rows")).toContain(`${n(INFLUX_ROW_CUT)} rows`);
    expect(rowOf(bounds, "Cells")).toContain(`${n(INFLUX_CELL_BUDGET)} cells`);
    expect(rowOf(bounds, "Chunk size")).toContain(`\`chunk_size=${INFLUXQL_CHUNK_SIZE}\``);
    expect(rowOf(bounds, "Listings")).toContain(`${n(INFLUX_LIST_CAP)} names`);
    expect(rowOf(bounds, "Tree, connect and monitoring")).toContain(`${INFLUX_SURFACE_TIMEOUT_MS / 1000} seconds`);
    expect(rowOf(bounds, "In flight")).toContain(
      `${INFLUX_LIMITER_OPTIONS.perProvider} requests per connection and ${INFLUX_LIMITER_OPTIONS.perEngine} per type in this process, with a queue of ${INFLUX_LIMITER_OPTIONS.queueDepth}`,
    );
    expect(rowOf(bounds, "Preview")).toContain(`\`${INFLUXQL_PREVIEW_WINDOW}\``);
    expect(rowOf(bounds, "Preview")).toContain(`\`LIMIT ${INFLUXQL_PREVIEW_LIMIT}\``);
  });

  test("the preview and Generate Query texts are the generators' output for the seeded home measurement", async () => {
    const previews = sectionOf(DOC, "### 5.9 Previews");
    expect(previews).toContain(`\`\`\`text\n${influxqlTableQuery(["home", "home"])}\n\`\`\``);
    expect(previews).toContain(`\`\`\`text\n${influxqlSelectQuery(["home", "home"], await homeColumns())}\n\`\`\``);
    expect(previews).toContain('"co"');
  });

  test("the error table quotes the error sentences, each template by its fixed parts", () => {
    const errors = flat(sectionOf(DOC, "## 10. Error handling"));
    const fixed = [
      "userPasswordRefused",
      "passwordWithoutUser",
      "token2Refused",
      "token3Refused",
      "userMayNotListDatabases",
      "infinity",
      "queryKilled",
      "notReadable",
      "lexerDisagreement",
      "partial",
      "truncated",
      "cancelled",
      "fileLimit",
      "cloudDbrp",
      "unrecognised",
    ];
    for (const key of fixed) expect(errors).toContain(INFLUX_ERROR_SENTENCES[key] as string);
    const templates: Readonly<Record<string, number>> = {
      parse: 1,
      influxqlParse: 1,
      databaseNotFound: 1,
      readerCannotRead: 1,
      userMayNotRun: 1,
      tokenMayNotRun: 1,
      influxqlNotImplemented: 1,
      statementRefused: 1,
      noQueryEndpoint: 1,
      noPing: 1,
      httpStatus: 2,
      timeout: 1,
      tls: 2,
      noCompleteAnswer: 2,
      redirect: 1,
      encoding: 1,
    };
    for (const [key, arity] of Object.entries(templates)) {
      const template = INFLUX_ERROR_SENTENCES[key] as (...parts: string[]) => string;
      for (const part of fixedParts(template, arity)) expect(errors).toContain(part);
    }
    const tooLarge = INFLUX_ERROR_SENTENCES.tooLarge as (size: string) => string;
    expect(errors).toContain(tooLarge(`${INFLUX_RESPONSE_CAP_BYTES / (1024 * 1024)} MiB`));
  });

  test("the provider's private refusals are the ones it raises", async () => {
    const validate = await rejection(() => new InfluxDBProvider({ ...INFLUXDB, host: "" }).validate());
    expect(flat(sectionOf(DOC, "### 4.1 Configuration fields"))).toContain(`> ${validate}`);
    const maintenance = await rejection(() => provider.runMaintenance());
    expect(flat(sectionOf(DOC, "## 8. Maintenance"))).toContain(`> ${maintenance}`);
    const path = await rejection(() => provider.countObjects(["home", "autogen"]));
    expect(path).toStartWith("An InfluxDB container path is [database], received ");
    expect(flat(sectionOf(DOC, "### 6.1 The object surface"))).toContain(`> ${path}`);
  });

  test("the capability table is every declared capability, primitive values word for word", () => {
    const table = sectionOf(DOC, "## 9. Capabilities & labels");
    const documented = table
      .split("\n")
      .map((line) => /^\| `(\w+)` \|/.exec(line)?.[1])
      .filter((key): key is string => key !== undefined && key in capabilities);
    expect(documented.sort()).toEqual(Object.keys(capabilities).sort());
    for (const [key, value] of Object.entries(capabilities)) {
      if (typeof value === "object") continue;
      expect(rowOf(table, `\`${key}\``)).toBe(`| \`${key}\` | \`${JSON.stringify(value)}\` |`);
    }
    expect(capabilities.enforcesReadOnly).toBe(true);
    expect(capabilities.supportsResultPagination).toBe(false);
    expect(capabilities.supportsExternalQueryLimiting).toBe(false);
  });

  test("the label table is every label, word for word", () => {
    const table = sectionOf(DOC, "## 9. Capabilities & labels");
    for (const [key, value] of Object.entries(labels)) {
      expect(rowOf(table, `\`${key}\``)).toBe(`| \`${key}\` | ${value} |`);
    }
  });

  test("machine access and the read-only mode are what the records say", () => {
    const table = sectionOf(DOC, "## 9. Capabilities & labels");
    expect(rowOf(table, "`READ_ONLY_ENFORCED.influxdb`")).toBe(
      `| \`READ_ONLY_ENFORCED.influxdb\` | \`${READ_ONLY_ENFORCED.influxdb}\` |`,
    );
    expect(rowOf(table, "`MCP_EXPOSABLE.influxdb`")).toBe(
      `| \`MCP_EXPOSABLE.influxdb\` | \`${MCP_EXPOSABLE.influxdb}\` |`,
    );
  });

  test("the monitoring empty states are the labels'", () => {
    const monitoring = sectionOf(DOC, "## 7. Monitoring & health");
    expect(monitoring).toContain(`> ${labels.slowQueriesEmptyState}`);
    expect(monitoring).toContain(`> ${labels.sessionsEmptyState}`);
  });

  test("the seed recipe is a connection the seed schema accepts, and its fields are the recipe's in SEED_CONNECTIONS.md", () => {
    const running = sectionOf(DOC, "## 12. Running InfluxDB for Studio");
    const block = /```yaml\n([\s\S]*?)\n```/.exec(running)?.[1];
    expect(block).toBeDefined();
    const seed = parseYaml(block ?? "") as Record<string, unknown>;
    expect(SeedConnectionSchema.safeParse(seed).success).toBe(true);
    const recipe = SEEDS.slice(SEEDS.indexOf('  - id: "metrics-influx"'), SEEDS.indexOf('  - id: "metrics-influx3"'));
    for (const key of Object.keys(seed)) {
      expect(Object.keys(SeedConnectionSchema.shape)).toContain(key);
      expect(recipe).toMatch(new RegExp(`(^|\\n)\\s+(- )?${key}:`));
    }
  });

  test("the object edit section the edit census asks of an abstainer is there", () => {
    expect(DOC).toMatch(/^#{1,6} .*Object edit \(#789\)/m);
  });

  test("the doc carries no em dash, no en dash and no factory.ts line citation", () => {
    expect(DOC).not.toMatch(/[\u2013\u2014]/);
    expect(DOC).not.toMatch(/factory\.ts:\d/);
  });
});
