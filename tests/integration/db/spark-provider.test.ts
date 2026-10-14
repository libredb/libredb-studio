/**
 * Apache Spark provider, end to end over answers Spark gave.
 *
 * The real SparkProvider runs: connection options, sessions, the two-step statement run, the result stream and its
 * budgets, the Arrow decoder, the error table, the object surface and the monitoring reads. Only the wire is
 * replaced, by the recorded transport of `tests/helpers/spark-fixtures.ts`, handed through the constructor's third
 * argument; `grpc-client.ts` itself is proven against a fake server in `tests/unit/db/spark/grpc-client.test.ts`. A
 * call is matched by its RPC and its decoded request, and a request no capture matches fails the case by name, from
 * the transport's missed list when the provider swallowed the failed call: no answer is invented.
 *
 * The captures were taken by `tests/live/spark-evidence.ts` on 2026-10-13, under bun, from two servers:
 * - `apache/spark:4.2.0@sha256:fc64959c04bd87b0ac686be9aaa9008b69cdb1afc695400528279c8b01f43d89`, whose AnalyzePlan
 *   answers the version "4.2.0" (services `spark`, `spark-auth` and `spark-tls`, the TLS proxy in front of
 *   `spark-auth`, into `tests/fixtures/spark/4.2.0/`);
 * - `apache/spark:4.1.3@sha256:bf9d035a7c32a8ca46aa58d6348182ffd7d2dff6409206ecfbb3915ff1fef211`, whose AnalyzePlan
 *   answers the version "4.1.3" (service `spark-4-1`, into `tests/fixtures/spark/4.1.3/`).
 * The digests are in each capture's own header, with the service that answered it: the provenance test below holds
 * them to SPARK_SERVICE_IMAGES, where spark-tls carries the pin of spark-auth, the server behind its proxy, and finds
 * each capture's row in the section of its version in `tests/fixtures/spark/README.md`, which lists every capture with
 * its service, RPC, date and runtime and no digest. `tests/unit/db/spark/capture-catalog.test.ts` holds the spark,
 * spark-4-1 and spark-auth pins to database-compose.yml.
 *
 * What is BUILT rather than read from a capture, each labelled where it is built:
 * - the ids: the replay writes the request's own session, operation and tag ids into the echo fields of the captured
 *   answer, because the client chooses them at random, and answers every call of one session with one server-side
 *   session id, because each capture comes from its own run and the provider reads a changed id as a restarted
 *   server; every case shares this step;
 * - the version refusal: the 4.2.0 version answer rewritten to "3.5.9" and "4.0.4", since no capture is of a server
 *   below the floor;
 * - the nested namespace listing: the session catalog's `SHOW NAMESPACES` answer rewritten to multi-part spellings,
 *   because no catalog of the open-source fixture nests.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { captureContextSnapshot, fingerprintInventory, packContextForTask } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import type { AgentToolContext } from "@/lib/agent/tools";
import type { AgentInventory, AgentRunMode } from "@/lib/agent/types";
import { AuthenticationError, ConnectionError, QueryError } from "@/lib/db/errors";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { SPARK_ERROR_SENTENCES } from "@/lib/db/providers/sql/spark/errors";
import type { SparkWireTransport } from "@/lib/db/providers/sql/spark/grpc-client";
import { SparkProvider } from "@/lib/db/providers/sql/spark/index";
import { SPARK_CUT_WARNINGS } from "@/lib/db/providers/sql/spark/result-stream";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import { readSparkCapture, type SparkCaptureVersion } from "../../helpers/spark-captures";
import { type RecordedSparkTransport, recordedSparkTransport } from "../../helpers/spark-fixtures";
import { columnsStream } from "../../helpers/spark-ipc";
import {
  SPARK_CAPTURE_CATALOG,
  SPARK_CAPTURE_NAMES,
  SPARK_EVERY_TYPE_SELECT,
  SPARK_SAMPLE_NAMESPACE,
  SPARK_SERVICE_IMAGES,
  type SparkCaptureEntry,
  type SparkCaptureName,
} from "../../live/spark-evidence-plan";

function entry(name: SparkCaptureName): SparkCaptureEntry {
  const found = SPARK_CAPTURE_CATALOG.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`the capture plan has no entry ${name}`);
  return found;
}

/** The statement a capture ran, read from the plan, because the matcher compares statement texts. */
function actionSql(name: SparkCaptureName): string {
  const { action } = entry(name);
  if (!("sql" in action) || action.sql === undefined) throw new Error(`the capture plan's ${name} runs no statement`);
  return action.sql;
}

/** The first statement a capture ran before its own, read from the plan. */
function beforeSql(name: SparkCaptureName): string {
  const sql = entry(name).before?.[0]?.sql;
  if (sql === undefined) throw new Error(`the capture plan's ${name} runs no statement before its own`);
  return sql;
}

/** Every recorded transport the running case made. */
const made: RecordedSparkTransport[] = [];

function recorded(...args: Parameters<typeof recordedSparkTransport>): RecordedSparkTransport {
  const transport = recordedSparkTransport(...args);
  made.push(transport);
  return transport;
}

afterEach(() => {
  // A request no capture answered fails the case, a call whose failure the provider swallowed included: no case
  // expects a miss.
  expect(made.splice(0).flatMap((transport) => transport.missed)).toStrictEqual([]);
});

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures", "spark");
const EVERY_TYPE_SELECT = SPARK_EVERY_TYPE_SELECT;
const EXPLAIN_STATEMENT = actionSql("explain-formatted");
const ROW_BUDGET_STATEMENT = actionSql("row-budget-cut");
const TIME_STATEMENT = actionSql("time-type-refused");
const PERMISSION_STATEMENT = actionSql("error-permission-denied");
const MAX_RESULT_STATEMENT = actionSql("error-max-result-size");
const SHOW_TABLES_STATEMENT = actionSql("show-tables-inline");
const SYNTAX_STATEMENT = actionSql("error-syntax");
const MISSING_TABLE_STATEMENT = actionSql("error-missing-table");
const LARGE_TYPES_SET = beforeSql("large-var-types-refused");
const LARGE_TYPES_SELECT = actionSql("large-var-types-refused");
const SUBSTITUTION_SET = beforeSql("substitution-off");
const SUBSTITUTION_SELECT = actionSql("substitution-off");
const ZSTD_SET = beforeSql("compressed-zstd");
const ZSTD_SELECT = actionSql("compressed-zstd");
const TEMP_VIEW_SCRIPT = [beforeSql("temp-view-script"), actionSql("temp-view-script")];

const CONNECT: readonly SparkCaptureName[] = [
  "connect-version",
  "release-session",
  "connect-session-setup",
  "connect-current-namespace",
];
/** A statement's own session: its Config set of the seven pairs, the setup every request session sends first. */
const STATEMENT_SESSION: readonly SparkCaptureName[] = ["request-session-setup"];
/** A connection's Catalog and Namespace: the sample namespace of the session catalog. */
const STUDIO_PLACE: Partial<DatabaseConnection> = { database: "spark_catalog", schema: SPARK_SAMPLE_NAMESPACE };
/**
 * A connect with STUDIO_PLACE: the metadata session's setup sends SET CATALOG and USE NAMESPACE, and SHOW CURRENT
 * NAMESPACE then answers the studio namespace, recorded after the same two statements. Masked, that request is
 * connect-current-namespace's, so the two captures never share a transport: the first one listed would answer both.
 */
const CONNECT_STUDIO: readonly SparkCaptureName[] = [
  "connect-version",
  "release-session",
  "connect-session-setup",
  "set-catalog",
  "use-namespace",
  "connect-current-namespace-studio",
];
/**
 * The agent's grounding walk after CONNECT, in the order the provider sends it: the catalogs, each catalog's
 * namespaces, studio_unloaded's listing refused and its details fetched, then the counts of the session-default
 * namespace. spark_catalog.default holds nothing, so nothing is listed or described.
 */
const GROUNDING_WALK: readonly SparkCaptureName[] = [
  "connect-current-namespace",
  "show-catalogs",
  "config-catalog-keys",
  "connect-current-namespace",
  "show-namespaces",
  "connect-current-namespace",
  "show-namespaces-unloaded",
  "show-namespaces-unloaded-details",
  "show-views-default",
  "show-tables-default",
  "show-user-functions-default",
];
/** Spark's text for SHOW NAMESPACES IN `studio_unloaded`, a configured catalog it cannot load (show-namespaces-unloaded). */
const UNLOADED_CATALOG_TEXT = "requirement failed: Option 'url' is required.";

const config = (extra: Partial<DatabaseConnection> = {}): DatabaseConnection =>
  ({
    id: "spark-replay",
    name: "spark",
    type: "spark",
    host: "127.0.0.1",
    port: 15002,
    ...extra,
  }) as DatabaseConnection;

async function connected(
  version: SparkCaptureVersion,
  names: readonly SparkCaptureName[],
  extra: Partial<DatabaseConnection> = {},
) {
  const transport = recorded(version, [...CONNECT, ...STATEMENT_SESSION, ...names]);
  const provider = new SparkProvider(config(extra), {}, { transport });
  await provider.connect();
  return { provider, transport };
}

/** A recorded transport whose AnalyzePlan version answer is rewritten (BUILT): the only way to replay an old server. */
function withVersion(base: SparkWireTransport, version: string): SparkWireTransport {
  return (options) => {
    const channel = base(options);
    return {
      ...channel,
      unary: async (rpc, request, call) => {
        const answer = await channel.unary(rpc, request, call);
        return rpc === "AnalyzePlan" ? { ...answer, spark_version: { version } } : answer;
      },
    };
  };
}

/**
 * A recorded transport whose `SHOW NAMESPACES IN \`spark_catalog\`` answer holds `spellings` (BUILT): no catalog of the
 * open-source fixture nests, so the captured answer's inline rows are replaced by one Utf8 `namespace` column.
 */
function withNamespaces(base: SparkWireTransport, spellings: readonly string[]): SparkWireTransport {
  return (options) => {
    const channel = base(options);
    return {
      ...channel,
      executePlan: (request, call, limits) => {
        const stream = channel.executePlan(request, call, limits);
        const query = (request as { plan?: { command?: { sql_command?: { input?: { sql?: { query?: string } } } } } })
          .plan?.command?.sql_command?.input?.sql?.query;
        if (query !== "SHOW NAMESPACES IN `spark_catalog`") return stream;
        const data = Buffer.from(columnsStream([{ name: "namespace", kind: "utf8", values: spellings }]));
        return {
          read: async () => {
            const response = (await stream.read()) as
              | { readonly sql_command_result?: { readonly relation: { readonly local_relation: object } } }
              | undefined;
            if (response?.sql_command_result === undefined) return response;
            const { relation } = response.sql_command_result;
            return {
              ...response,
              sql_command_result: { relation: { ...relation, local_relation: { ...relation.local_relation, data } } },
            };
          },
          get receivedBytes() {
            return stream.receivedBytes;
          },
          get truncated() {
            return stream.truncated;
          },
          cancel: () => stream.cancel(),
        };
      },
    };
  };
}

/** What the agent's capture is handed, as tests/integration/db/etcd-provider.test.ts builds it, in the run's mode. */
function agentContext(provider: SparkProvider, mode: AgentRunMode): AgentToolContext {
  const clock = () => 1_000;
  const connection = config();
  return {
    runId: "run-spark",
    modelId: "unmeasured-model-for-tests",
    mode,
    workflowType: "investigation",
    actor: { sessionId: "session-1", role: "user" },
    connection,
    capabilities: provider.getCapabilities(),
    labels: provider.getLabels(),
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(connection.id),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2, clock),
    repairs: new AgentRepairLedger(),
    acquireProvider: async () => provider,
    clock,
  };
}

describe("provenance", () => {
  test("every capture carries its service's pinned image and digest, spark-tls's being spark-auth's, and tests/fixtures/spark/README.md lists it", () => {
    // spark-tls runs no Spark of its own: its captures are the answers of spark-auth's server, behind the proxy.
    expect(SPARK_SERVICE_IMAGES["spark-tls"]).toStrictEqual(SPARK_SERVICE_IMAGES["spark-auth"]);
    const readme = readFileSync(join(FIXTURES, "README.md"), "utf8");
    let read = 0;
    for (const version of ["4.2.0", "4.1.3"] as const) {
      // The version's section ends at the next heading, so a row is found only under its own version.
      const start = readme.indexOf(`\n## ${version}\n`);
      expect(start).toBeGreaterThan(-1);
      const end = readme.indexOf("\n## ", start + 1);
      const section = readme.slice(start, end === -1 ? undefined : end);
      for (const file of readdirSync(join(FIXTURES, version))) {
        const name = file.replace(/\.json$/, "") as SparkCaptureName;
        expect(SPARK_CAPTURE_NAMES).toContain(name);
        const { $captured } = readSparkCapture(version, name);
        expect($captured.sparkVersion).toBe(version);
        expect($captured.image).toBe(SPARK_SERVICE_IMAGES[$captured.service].image);
        expect($captured.digest).toBe(SPARK_SERVICE_IMAGES[$captured.service].digest);
        expect(section).toContain(`| \`${name}\` | ${$captured.service} | ${$captured.rpc} |`);
        expect(section).toContain(`| ${$captured.date} | ${$captured.runtime} |`);
        read += 1;
      }
    }
    expect(read).toBeGreaterThan(0);
  });
});

for (const version of ["4.2.0", "4.1.3"] as const) {
  describe(`replay on ${version}`, () => {
    test("connect: version, session setup, current catalog and namespace, the tokenless caution", async () => {
      const { provider } = await connected(version, []);
      expect(provider.isConnected()).toBe(true);
      expect(provider.connectWarnings()).toEqual([
        { message: SPARK_ERROR_SENTENCES.tokenlessCaution("127.0.0.1", 15002) },
      ]);
      await provider.disconnect();
    });

    test("connect with a catalog and a namespace: the metadata session runs SET CATALOG and USE NAMESPACE before its first read", async () => {
      const transport = recorded(version, CONNECT_STUDIO);
      const provider = new SparkProvider(config(STUDIO_PLACE), {}, { transport });
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
      expect(transport.served).toStrictEqual([...CONNECT_STUDIO]);
      await provider.disconnect();
    });

    test("a statement that turns large types on, then a SELECT of a string: both refused with the large-types sentence", async () => {
      const { provider } = await connected(version, [
        "large-var-types-set",
        "large-var-types-refused-command",
        "large-var-types-refused",
        // The Interrupt each refusal sends: a masked Interrupt by tag reads as the one cancel-interrupt captured.
        "cancel-interrupt",
      ]);
      // The SET's own inline answer arrives as LargeUtf8 (large-var-types-set, both versions).
      await expect(provider.query(LARGE_TYPES_SET, undefined, undefined, "s-large")).rejects.toThrow(
        SPARK_ERROR_SENTENCES.largeVarTypes,
      );
      await expect(provider.query(LARGE_TYPES_SELECT, undefined, undefined, "s-large")).rejects.toThrow(
        SPARK_ERROR_SENTENCES.largeVarTypes,
      );
      await provider.disconnect();
    });

    test("the every-type SELECT through both steps: 34 columns decoded and JSON-safe", async () => {
      const { provider } = await connected(version, ["every-type-command", "every-type-relation"]);
      const captured = readSparkCapture(version, "every-type-command").$captured.request as {
        readonly plan: {
          readonly command: { readonly sql_command: { readonly input: { readonly sql: { readonly query: string } } } };
        };
      };
      expect(captured.plan.command.sql_command.input.sql.query).toBe(EVERY_TYPE_SELECT);
      const result = await provider.query(EVERY_TYPE_SELECT);
      expect(result.fields).toHaveLength(34);
      expect(() => JSON.stringify(result.rows)).not.toThrow();
      await provider.disconnect();
    });

    test("TIME is refused with Studio's sentence after Spark's text, its details fetched by the failure's errorId", async () => {
      const { provider, transport } = await connected(version, [
        "time-type-refused-command",
        "time-type-refused",
        "time-type-refused-details",
      ]);
      await expect(provider.query(TIME_STATEMENT)).rejects.toThrow(SPARK_ERROR_SENTENCES.timeTypeOff);
      expect(transport.served.filter((name) => name.endsWith("-details"))).toStrictEqual(["time-type-refused-details"]);
      await provider.disconnect();
    });

    test("SHOW TABLES answers inline with no Spark job", async () => {
      const { provider } = await connected(version, ["show-tables-inline"]);
      const result = await provider.query(SHOW_TABLES_STATEMENT);
      expect(result.fields).toEqual(["namespace", "tableName", "isTemporary"]);
      await provider.disconnect();
    });

    test("Explain: EXPLAIN FORMATTED text becomes the plan tree", async () => {
      const { provider } = await connected(version, ["explain-formatted"]);
      const result = await provider.query(EXPLAIN_STATEMENT);
      expect(String(Object.values(result.rows[0])[0])).toContain("== Physical Plan ==");
      await provider.disconnect();
    });

    for (const mode of ["agent", "planning"] as const) {
      test(`the ${mode} run's grounding walk reads the session-default namespace only, and names the catalog Spark cannot list as not read`, async () => {
        const transport = recorded(version, [...new Set([...CONNECT, ...GROUNDING_WALK])]);
        const provider = new SparkProvider(config(), {}, { transport });
        await provider.connect();
        const before = transport.served.length;
        const capture = await captureContextSnapshot(agentContext(provider, mode));
        // Every catalog's namespaces are listed, since the walk lists each level before it narrows to the session's
        // namespace; then only spark_catalog.default, which SHOW CURRENT NAMESPACE answers, is counted.
        expect(transport.served.slice(before)).toStrictEqual([...GROUNDING_WALK]);
        // studio_unloaded's namespaces were never listed, so they are in no count: the four other namespaces of
        // spark_catalog are.
        const inventory: AgentInventory = {
          objects: [],
          kinds: [
            { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
            { id: "view", role: "relation", label: "View", labelPlural: "Views" },
            { id: "function", role: "routine", label: "Function", labelPlural: "Functions" },
          ],
          unreadContainers: {
            count: 4,
            label: "Namespace",
            labelPlural: "Namespaces",
            read: ["spark_catalog.default"],
            unlistedParents: [{ path: "studio_unloaded", label: "Catalog", reason: UNLOADED_CATALOG_TEXT }],
          },
          defaultContainer: ["spark_catalog", "default"],
        };
        expect(capture).toStrictEqual({
          kind: "captured",
          snapshot: {
            connectionId: "spark-replay",
            fingerprint: fingerprintInventory(inventory),
            capturedAtMs: 1_000,
            ...inventory,
            readVia: "provider-inventory",
          },
          charged: { statements: 1, elapsedMs: 0 },
        });
        if (capture.kind !== "captured") throw new Error(`expected a capture, got ${capture.kind}`);
        // The run is told which catalog was not read, in Spark's words.
        expect(
          packContextForTask(capture.snapshot, "which tables hold orders")
            .split("\n")
            .filter((line) => line.includes("was not read")),
        ).toStrictEqual([
          `Not read: 4 other Namespaces. The Catalog "studio_unloaded" was not read: listing its Namespaces failed with "${UNLOADED_CATALOG_TEXT}". This inventory covers only what it read in ("spark_catalog.default"), so an object in any other Namespace is not listed below. Do not read its absence as an absence in the database.`,
        ]);
        await provider.disconnect();
      });
    }
  });
}

describe("replay on 4.2.0 only", () => {
  test("a missing token and a wrong token are refused as an AuthenticationError, each with its own sentence", async () => {
    const none = new SparkProvider(config(), {}, { transport: recorded("4.2.0", ["auth-no-token"]) });
    const missing = await none.connect().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(missing).toBeInstanceOf(AuthenticationError);
    expect((missing as Error).message).toBe(SPARK_ERROR_SENTENCES.tokenMissing);
    const wrong = new SparkProvider(
      config({ password: "not-the-token" }),
      {},
      { transport: recorded("4.2.0", ["auth-wrong-token"]) },
    );
    const refused = await wrong.connect().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(AuthenticationError);
    expect((refused as Error).message).toBe(SPARK_ERROR_SENTENCES.tokenWrong);
  });

  test("a FROM-led result of 100,001 rows is cut by the row budget, with its warning and one Interrupt", async () => {
    const transport = recorded("4.2.0", [
      ...CONNECT,
      ...STATEMENT_SESSION,
      "row-budget-cut-command",
      "row-budget-cut",
      "cancel-interrupt",
    ]);
    const provider = new SparkProvider(config(), {}, { transport });
    await provider.connect();
    const result = await provider.query(ROW_BUDGET_STATEMENT);
    expect(result.rows).toHaveLength(100_000);
    expect(result.pagination?.wasLimited).toBe(true);
    expect(result.warnings).toEqual([{ message: SPARK_CUT_WARNINGS.rows }]);
    // interrupt() swallows a failed call, so `served` shows the one Interrupt its capture answered.
    expect(transport.served.filter((name) => name === "cancel-interrupt")).toEqual(["cancel-interrupt"]);
    await provider.disconnect();
  });

  test("a script in one scope: a temp view one statement makes, the next reads, both on the scope's one session", async () => {
    const { provider, transport } = await connected("4.2.0", [
      "temp-view-create",
      "temp-view-script-command",
      "temp-view-script",
    ]);
    const before = transport.served.length;
    const rows: unknown[] = [];
    for (const statement of TEMP_VIEW_SCRIPT) {
      // oxlint-disable-next-line no-await-in-loop -- the script's statements run in order in one scope.
      rows.push((await provider.query(statement, undefined, undefined, "scope-script")).rows);
    }
    expect(rows).toStrictEqual([[], [{ x: 1 }]]);
    // One session setup, then both statements: a session per statement would set up and release one for each.
    expect(transport.served.slice(before)).toStrictEqual([
      "request-session-setup",
      "temp-view-create",
      "temp-view-script-command",
      "temp-view-script",
    ]);
    await provider.endOpenQueryTransaction("scope-script");
    expect(transport.served.slice(before + 4)).toStrictEqual(["release-session"]);
    // The match masks session ids, so the ids the provider chose are read from `sessions`: the setup, both statements'
    // steps and the release carry the scope's one id, and the metadata session the connect set up carries another.
    const scope = transport.sessions[before];
    const metadata = transport.sessions[transport.served.indexOf("connect-current-namespace")];
    expect(transport.sessions.slice(before)).toStrictEqual([scope, scope, scope, scope, scope]);
    expect([scope, metadata]).toStrictEqual([expect.stringMatching(UUID), expect.stringMatching(UUID)]);
    expect(scope).not.toBe(metadata);
    await provider.disconnect();
  });

  test("errors: a syntax error with ErrorInfo, a missing table, a permission refusal's cause and maxResultSize, each with its FetchErrorDetails", async () => {
    const transport = recorded("4.2.0", [
      ...CONNECT,
      ...STATEMENT_SESSION,
      "error-syntax",
      "error-syntax-details",
      "error-missing-table",
      "error-missing-table-details",
      "error-permission-denied",
      "error-permission-denied-details",
      "error-max-result-size-command",
      "error-max-result-size",
      "error-max-result-size-details",
    ]);
    const provider = new SparkProvider(config(), {}, { transport });
    await provider.connect();
    await expect(provider.query(SYNTAX_STATEMENT)).rejects.toBeInstanceOf(QueryError);
    await expect(provider.query(MISSING_TABLE_STATEMENT)).rejects.toBeInstanceOf(QueryError);
    await expect(provider.query(PERMISSION_STATEMENT)).rejects.toThrow("Permission denied");
    await expect(provider.query(MAX_RESULT_STATEMENT)).rejects.toThrow(SPARK_ERROR_SENTENCES.maxResultSize);
    // Each FetchErrorDetails carried its failure's errorId, so the details captured in that failure's run answered it.
    expect(transport.served.filter((name) => name.endsWith("-details"))).toStrictEqual([
      "error-syntax-details",
      "error-missing-table-details",
      "error-permission-denied-details",
      "error-max-result-size-details",
    ]);
    await provider.disconnect();
  });

  test("substitution off: SELECT '${x}' after SET x=1 returns the text as written", async () => {
    const { provider } = await connected("4.2.0", ["substitution-set", "substitution-off-command", "substitution-off"]);
    await provider.query(SUBSTITUTION_SET, undefined, undefined, "scope-subst");
    const result = await provider.query(SUBSTITUTION_SELECT, undefined, undefined, "scope-subst");
    expect(result.rows).toEqual([{ v: "${x}" }]);
    await provider.disconnect();
  });

  test("a session SET of the codec to zstd, then the next result refused naming the codec", async () => {
    const { provider } = await connected("4.2.0", [
      "compressed-zstd-set",
      "compressed-zstd-command",
      "compressed-zstd",
      // The Interrupt each refusal sends: a masked Interrupt by tag reads as the one cancel-interrupt captured.
      "cancel-interrupt",
    ]);
    // The SET's own inline answer is already a ZSTD batch (compressed-zstd-set), so it is refused as the SELECT is.
    await expect(provider.query(ZSTD_SET, undefined, undefined, "scope-zstd")).rejects.toThrow(
      SPARK_ERROR_SENTENCES.compressed("zstd"),
    );
    await expect(provider.query(ZSTD_SELECT, undefined, undefined, "scope-zstd")).rejects.toThrow(
      SPARK_ERROR_SENTENCES.compressed("zstd"),
    );
    await provider.disconnect();
  });

  test("the tree over the studio namespace's captures: catalogs, namespaces, objects, DESCRIBE and SHOW CREATE", async () => {
    const { provider } = await connected("4.2.0", [
      "show-catalogs",
      "config-catalog-keys",
      "show-namespaces",
      "show-tables",
      "show-views",
      "show-user-functions",
      "describe-table",
      "describe-table-struct30",
      "describe-view",
      "show-create-table",
      "show-create-view",
    ]);
    // The session catalog and the configured catalog key Spark has not loaded (config-catalog-keys).
    const catalogs = await provider.listContainers([]);
    expect(catalogs.map((container) => container.path)).toEqual([["spark_catalog"], ["studio_unloaded"]]);
    const namespaces = await provider.listContainers(["spark_catalog"]);
    expect(namespaces.map((container) => container.name)).toContain(SPARK_SAMPLE_NAMESPACE);
    const studio = ["spark_catalog", SPARK_SAMPLE_NAMESPACE];
    expect(await provider.countObjects(studio)).toEqual(STUDIO_COUNTS);
    const tables = await provider.listObjects(studio, "table");
    expect(tables.map((object) => object.name).sort()).toEqual(["every_type", "wide_struct"]);
    const views = await provider.listObjects(studio, "view");
    expect(views.map((object) => object.name)).toEqual(["every_type_view"]);
    const functions = await provider.listObjects(studio, "function");
    expect(functions.map((object) => object.name)).toEqual(["f1"]);
    for (const [name, kind, columns] of [
      ["every_type", "table", EVERY_TYPE_COLUMNS],
      ["wide_struct", "table", [["s", WIDE_STRUCT_TYPE]]],
      [
        "every_type_view",
        "view",
        [
          ["c_int", "int"],
          ["c_string", "string"],
        ],
      ],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time on one provider.
      expect(await provider.describeObject([...studio, name], kind)).toStrictEqual({
        path: [...studio, name],
        columns: columns.map(([column, type]) => ({ name: column, type, nullable: true, isPrimary: false })),
        indexes: [],
        foreignKeys: [],
      });
    }
    for (const [name, kind] of [
      ["every_type", "table"],
      ["every_type_view", "view"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time on one provider.
      const [ddl] = (await provider.readObjectSource([...studio, name], kind)).parts;
      expect((ddl as { readonly text: string }).text).toContain(name);
    }
    await provider.disconnect();
  });

  test("the object surface meets the contract every provider's does, over the studio namespace", async () => {
    const { provider } = await connected("4.2.0", [
      "show-catalogs",
      "config-catalog-keys",
      "show-namespaces",
      "show-tables",
      "show-views",
      "show-user-functions",
      "describe-table",
      "describe-table-struct30",
      "describe-view",
      "show-create-table",
      "show-create-view",
      "show-create-table-missing",
      "show-create-table-missing-details",
    ]);
    await assertObjectSurface(provider, {
      containers: [["spark_catalog"], ["studio_unloaded"]],
      container: ["spark_catalog", SPARK_SAMPLE_NAMESPACE],
      kinds: STUDIO_KINDS,
      sampleObject: { path: ["spark_catalog", SPARK_SAMPLE_NAMESPACE, "every_type"], kind: "table" },
      // Spark answers SHOW CREATE TABLE of it with [TABLE_OR_VIEW_NOT_FOUND] (show-create-table-missing).
      absentSource: { path: ["spark_catalog", SPARK_SAMPLE_NAMESPACE, "no_such_table"], kind: "table" },
    });
    await provider.disconnect();
  });

  test("BUILT: a nested namespace listing, the session catalog's SHOW NAMESPACES answer rewritten to multi-part spellings", async () => {
    const spellings = ["studio", "lake.raw", "lake.`x.y`"];
    const transport = withNamespaces(recorded("4.2.0", [...CONNECT, "show-namespaces"]), spellings);
    const provider = new SparkProvider(config(), {}, { transport });
    await provider.connect();
    const namespaces = await provider.listContainers(["spark_catalog"]);
    expect(namespaces.map((container) => container.path)).toEqual(
      spellings.map((spelling) => ["spark_catalog", spelling]),
    );
    await provider.disconnect();
  });

  test("health: one AnalyzePlan version read on the metadata session", async () => {
    const transport = recorded("4.2.0", CONNECT);
    const provider = new SparkProvider(config(), {}, { transport });
    await provider.connect();
    const before = transport.served.length;
    expect((await provider.getHealth()).slowQueries).toEqual([]);
    expect(transport.served.slice(before)).toEqual(["connect-version"]);
    await provider.disconnect();
  });

  // The table count lists the namespace SHOW CURRENT NAMESPACE answers: with no Catalog or Namespace set the server's
  // default, which holds no table; with the studio namespace set, the three rows of SHOW TABLES less the view.
  for (const place of [
    {
      label: "spark_catalog.default, no catalog or namespace set",
      extra: {},
      connect: CONNECT,
      current: "connect-current-namespace",
      listing: ["show-views-default", "show-tables-default"],
      namespace: "spark_catalog.default",
      tableCount: 0,
    },
    {
      label: "spark_catalog.studio, set as the connection's catalog and namespace",
      extra: STUDIO_PLACE,
      connect: CONNECT_STUDIO,
      current: "connect-current-namespace-studio",
      listing: ["show-views", "show-tables"],
      namespace: "spark_catalog.studio",
      tableCount: 2,
    },
  ] as const) {
    test(`overview in ${place.label}: the version, the spark.app. start time and the table count, on the metadata session`, async () => {
      const transport = recorded("4.2.0", [...place.connect, "overview-app-conf", ...place.listing]);
      const provider = new SparkProvider(config(place.extra), {}, { transport });
      await provider.connect();
      const before = transport.served.length;
      // The clock stands 90 minutes after spark.app.startTime as overview-app-conf answers it.
      setSystemTime(new Date(APP_START_MS + 90 * 60_000));
      try {
        expect(await provider.getOverview()).toStrictEqual({
          version: "4.2.0",
          uptime: "1.50h",
          startTime: new Date(APP_START_MS),
          maxConnections: 0,
          databaseSize: "N/A",
          tableCount: place.tableCount,
          tableCountSampledFrom: `the tables of ${place.namespace}, the connection's current namespace`,
          indexCount: 0,
        });
      } finally {
        setSystemTime();
      }
      expect(transport.served.slice(before)).toStrictEqual([
        "connect-version",
        "overview-app-conf",
        place.current,
        ...place.listing,
      ]);
      await provider.disconnect();
    });
  }

  test("a released session answers SESSION_CLOSED and the metadata session is re-created", async () => {
    // session-closed-show-catalogs answers the first SHOW CATALOGS only: masked, the repeat on the new session is the
    // same request, and show-catalogs answers it.
    const transport = recorded(
      "4.2.0",
      [...CONNECT, "session-closed-show-catalogs", "show-catalogs", "config-catalog-keys"],
      { once: ["session-closed-show-catalogs"] },
    );
    const provider = new SparkProvider(config(), {}, { transport });
    await provider.connect();
    const before = transport.served.length;
    const catalogs = await provider.listContainers([]);
    expect(catalogs.map((container) => container.path)).toStrictEqual([["spark_catalog"], ["studio_unloaded"]]);
    // The closed session is dropped unreleased, a new one is set up with the nine pairs, and the statement runs again.
    expect(transport.served.slice(before)).toStrictEqual([
      "connect-current-namespace",
      "session-closed-show-catalogs",
      "connect-session-setup",
      "show-catalogs",
      "config-catalog-keys",
    ]);
    await provider.disconnect();
  });

  test("BUILT: the version refusal, the 4.2.0 version answer rewritten to 3.5.9 and 4.0.4", async () => {
    for (const old of ["3.5.9", "4.0.4"]) {
      const provider = new SparkProvider(config(), {}, { transport: withVersion(recorded("4.2.0", CONNECT), old) });
      // oxlint-disable-next-line no-await-in-loop -- one connect at a time on one provider.
      await expect(provider.connect()).rejects.toThrow(SPARK_ERROR_SENTENCES.versionTooOld(old));
      // oxlint-disable-next-line no-await-in-loop -- one connect at a time on one provider.
      await expect(provider.connect()).rejects.toBeInstanceOf(ConnectionError);
    }
  });
});

/** A session id as the provider chooses it: a random UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** What the studio namespace holds (SPARK_SAMPLE_STATEMENTS): two tables, one view over one of them, one function. */
const STUDIO_KINDS = { table: 2, view: 1, function: 1 };
const STUDIO_COUNTS = { table: { count: 2 }, view: { count: 1 }, function: { count: 1 } };
/** spark.app.startTime as overview-app-conf answers it, in epoch milliseconds. */
const APP_START_MS = 1_791_889_584_013;
/** every_type's columns as DESCRIBE TABLE answers them (describe-table): the 32 SPARK_SAMPLE_STATEMENTS stores. */
const EVERY_TYPE_COLUMNS: readonly (readonly [string, string])[] = [
  ["c_boolean", "boolean"],
  ["c_tinyint", "tinyint"],
  ["c_smallint", "smallint"],
  ["c_int", "int"],
  ["c_bigint_safe", "bigint"],
  ["c_bigint_large", "bigint"],
  ["c_float", "float"],
  ["c_double", "double"],
  ["c_double_nan", "double"],
  ["c_double_inf", "double"],
  ["c_decimal", "decimal(10,2)"],
  ["c_decimal_neg", "decimal(4,2)"],
  ["c_decimal_38", "decimal(38,0)"],
  ["c_string", "string"],
  ["c_string_collated", "string collate UTF8_LCASE"],
  ["c_char", "char(5)"],
  ["c_varchar", "varchar(10)"],
  ["c_binary", "binary"],
  ["c_date", "date"],
  ["c_date_min", "date"],
  ["c_timestamp", "timestamp"],
  ["c_timestamp_ntz", "timestamp_ntz"],
  ["c_ym_interval", "interval year to month"],
  ["c_year_interval", "interval year"],
  ["c_dt_interval", "interval day to second"],
  ["c_hour_interval", "interval hour"],
  ["c_array", "array<int>"],
  ["c_map", "map<string,int>"],
  ["c_map_nested_key", "map<array<int>,string>"],
  ["c_struct", "struct<x:int,y:string>"],
  ["c_variant", "variant"],
  ["c_null_int", "int"],
];
/** wide_struct's one column, its 30 fields whole (describe-table-struct30). */
const WIDE_STRUCT_TYPE = `struct<${Array.from({ length: 30 }, (_, index) => `f${index + 1}:int`).join(",")}>`;
