/**
 * Drift guards for the agent runtime's cross-cutting documentation (#329 T13).
 *
 * The agent runtime is the first feature in this repository whose behaviour is
 * spread across a dozen modules, six API route paths, a rail, a durable backend and a
 * chart constraint, and none of that is derivable from any single file. `docs/AGENT.md`
 * is where it is written down. These tests keep three kinds of claim honest, because
 * prose is the one part of the repository nothing else checks:
 *
 *  1. **The document is reachable.** A behaviour document nobody links is a document
 *     nobody reads, so `docs/ARCHITECTURE.md` must link it and the link must resolve.
 *  2. **The configuration surface is complete.** Every environment variable the agent
 *     modules read is documented in BOTH `.env.example` and `docs/AGENT.md`, and the
 *     companion assertion is what keeps that check honest: across every agent-owned file
 *     (the runtime, the routes, the rail, its hooks, the run-access helper) only
 *     `config.ts` touches `process.env`, so a fourth variable read from one of them
 *     cannot slip past undocumented.
 *  3. **The deferral record is complete in both directions.** Every M2 backlog entry is
 *     cited by the behaviour document, and every id the document cites exists. A
 *     milestone that defers work and then documents nothing, or documents an entry that
 *     was later deleted, fails here rather than misleading a reader.
 *
 * The chart block covers the one deployment constraint the runtime imposes (the
 * zero-config durable backend takes file locks, so it is single-instance) plus the
 * verbatim operator copy of the chart, which is the mistake a chart edit made outside
 * `bun run chart:bump` actually produces — CI catches it, and the maintainer loop
 * cannot push, so this is the only local guard.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { operatorCopyViolations } from "../../scripts/sync-chart-version.mjs";
import { AGENT_LANGUAGE_COPY, AGENT_STATEMENT_LANGUAGE, AGENT_WORKFLOW_VARIANTS } from "@/lib/agent/agent-manifest";
import { AGENT_EXECUTION_ENGINES, namedList } from "@/lib/agent/engine-support";
import { AGENT_HISTORY_MAX_CONVERSATIONS, AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import * as engineClientResolvers from "@/lib/agent/languages/engines/client";
import * as enginePackResolvers from "@/lib/agent/languages/engines/index";
import * as engineServerResolvers from "@/lib/agent/languages/engines/server";
import { agentPosture } from "@/lib/agent/posture";
import { getDBConfig } from "@/lib/db-ui-config";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import type { DatabaseType } from "@/lib/types";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

/**
 * `Bun.Glob().scanSync()` yields HOST-separated paths, so on Windows a hit arrives as
 * `src\app\api\agent\config\route.ts` (measured on windows-latest, where this file's own
 * non-vacuity control failed along with the nine assertions it guards). Every use of a
 * scanned path below is POSIX-spelled - the `src/app` prefix stripped off a route, the
 * route path looked up in `docs/API_DOCS.md`, the comparison against
 * `src/lib/agent/config.ts` - and so is the documentation being searched, which no
 * platform rewrites. So the separator is normalised once where the paths are produced
 * rather than in each comparison.
 *
 * Unconditional, not a win32 branch: a tracked path holding a backslash cannot be
 * checked out on Windows at all, and this suite runs there, so no name under `src/` can
 * carry one. That makes this a no-op on POSIX rather than a branch nothing here runs.
 */
const scan = (pattern: string): string[] =>
  [...new Bun.Glob(pattern).scanSync(ROOT)].map((hit) => hit.replaceAll("\\", "/"));

const AGENT_DOC_PATH = "docs/AGENT.md";
const AGENT_DOC = read(AGENT_DOC_PATH);
const ARCHITECTURE = read("docs/ARCHITECTURE.md");
const ENV_EXAMPLE = read(".env.example");
const BACKLOG = read("docs/BACKLOG.md");
const AGENT_CONFIG = read("src/lib/agent/config.ts");
const CHART_VALUES = read("charts/libredb-studio/values.yaml");
/** The ledger directory the chart writes; the same path the image will also set. */
const CHART_LEDGER_PATH = "/app/data/workflow";
const CHART_README = read("charts/libredb-studio/README.md");

describe("docs/AGENT.md is reachable from the architecture document", () => {
  test("docs/ARCHITECTURE.md links to it and the link resolves to a real file", () => {
    const links = [...ARCHITECTURE.matchAll(/\]\(([^)]*AGENT\.md)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      // Links in docs/ARCHITECTURE.md are relative to docs/.
      expect(existsSync(path.join(ROOT, "docs", link))).toBe(true);
    }
  });
});

describe("the agent's environment surface is documented where an operator looks", () => {
  /**
   * `src/lib/agent/config.ts` declares each variable it reads as a `*_ENV` constant, so
   * the names can be extracted rather than restated here — a fourth variable added to
   * that file is then covered by this test without editing it.
   */
  const envNames = [...AGENT_CONFIG.matchAll(/\b\w+_ENV\b\s*=\s*"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]);

  test("the extraction found the module's variables (a vacuous pass would hide everything below)", () => {
    expect(envNames.length).toBeGreaterThanOrEqual(3);
    expect(envNames).toContain("LIBREDB_AGENT_ENABLED");
    expect(envNames).toContain("WORKFLOW_TARGET_WORLD");
  });

  test.each(envNames)("%s is documented in .env.example", (name) => {
    expect(ENV_EXAMPLE).toContain(name);
  });

  test.each(envNames)("%s is documented in docs/AGENT.md", (name) => {
    expect(AGENT_DOC).toContain(name);
  });

  test("no other agent module reads process.env, so the documented set is the whole set", () => {
    // One Glob per root: Bun.Glob does not brace-expand whole alternative patterns
    // (verified — a single "{a/**,b/**}" pattern matches nothing), and a silently
    // empty scan would make this assertion pass for the wrong reason.
    const roots = [
      "src/lib/agent/**/*.ts",
      "src/app/api/agent/**/*.ts",
      "src/components/agent/**/*.{ts,tsx}",
      "src/hooks/use-agent-*.ts",
      "src/lib/api/agent-run-access.ts",
    ];
    const files = roots.flatMap(scan);
    expect(files.length).toBeGreaterThan(20);

    const readers = files.filter((file) => read(file).includes("process.env"));
    expect(readers).toEqual(["src/lib/agent/config.ts"]);
  });
});

describe("the milestone's deferral record is complete in both directions", () => {
  const m2Section = BACKLOG.split(/^## Agent M2 deferrals/m)[1] ?? "";
  const backlogIds = [...m2Section.matchAll(/^### (B\d+)\./gm)].map((m) => m[1]);
  const citedIds = [...new Set([...AGENT_DOC.matchAll(/\bB(\d+)\b/g)].map((m) => `B${m[1]}`))];

  test("the M2 backlog section was located and has entries", () => {
    expect(backlogIds.length).toBeGreaterThan(0);
  });

  test.each(backlogIds)("%s is cited by docs/AGENT.md", (id) => {
    expect(citedIds).toContain(id);
  });

  test.each(citedIds)("%s cited by docs/AGENT.md exists as a backlog entry", (id) => {
    expect(backlogIds).toContain(id);
  });

  test("the SQLite caveat is stated as behaviour, not implied", () => {
    // A budget meter or a deadline that let a reader assume an in-engine interrupt would
    // be the dishonest half of this feature, so AGENT.md says how SQLite really stops it.
    expect(AGENT_DOC).toMatch(/sqlite[^.]*\b(kill(ed|ing) (the child|mid-flight))\b/i);
  });
});

describe("the two companion pages exist and are reachable", () => {
  /**
   * `docs/AGENT.md` is the behaviour document, and #331 T6 split two audiences out of
   * it: the user guide and the data-flow page. A page nobody links is a page nobody
   * reads — the same reason the architecture link above is asserted — and the data-flow
   * page in particular is what `docs/SECURITY.md` now points at for egress, so it
   * cannot quietly stop existing.
   */
  const COMPANIONS = ["docs/AGENT_GUIDE.md", "docs/AGENT_DATA_FLOW.md"];

  test.each(COMPANIONS)("%s exists", (page) => {
    expect(existsSync(path.join(ROOT, page))).toBe(true);
  });

  test.each(COMPANIONS)("%s is linked from docs/AGENT.md", (page) => {
    expect(AGENT_DOC).toContain(`(./${path.basename(page)})`);
  });

  test("README.md links the user guide, which is where a reader starts", () => {
    expect(read("README.md")).toContain("docs/AGENT_GUIDE.md");
  });
});

/**
 * The rail runs on MongoDB, Redis, Couchbase, Elasticsearch, OpenSearch, Druid,
 * ClickHouse and Trino as well as on the two dialects the agent composes SQL for, and
 * #414 took the SQL-and-tables vocabulary out of the surfaces themselves: the answer
 * card lists identifiers it could not find as bare chips under a sentence about the
 * inventory, `applyStatementName` builds its accessible name from `draft.noun.singular`,
 * and the schema-capture entry renders the count in `noun.singular`/`noun.plural` — "17
 * key patterns" on Redis, "3 datasources" on Druid.
 *
 * These pages are what the next change reads to learn what the panel is allowed to say,
 * so prose describing those surfaces in tables and SQL is how the noun comes back. Each
 * claim below is pinned against the code that decides the word, so the assertion fails
 * whichever side drifts.
 */
describe("the panel's documentation describes the rail in the words it renders", () => {
  const AGENT_GUIDE = read("docs/AGENT_GUIDE.md");
  const ANSWER_CARD = read("src/components/agent/AnswerCard.tsx");
  const RAIL_PARTS = read("src/components/agent/rail-parts.tsx");
  const TIMELINE = read("src/components/agent/timeline.ts");

  test("the answer card's identifier marking is documented in the noun the card uses", () => {
    // What the card actually says about names the inventory does not hold, and where
    // the control beside them takes its own noun from.
    expect(ANSWER_CARD).toContain("These names are not in the inventory this run read");
    expect(RAIL_PARTS).toContain("draft.noun.singular");

    const row = AGENT_DOC.split("\n").find((line) => line.includes("One click that RAN the model's SQL"));
    expect(row).toBeDefined();
    // The first cell is about NL2SQL, which wrote SQL, so it says SQL. The cell that
    // describes today's card is the second one, and the card names no engine's rows.
    const instead = row?.split("|")[2] ?? "";
    expect(instead).toContain("the inventory does not hold");
    expect(instead).not.toMatch(/\btables?\b/i);
  });

  test("the one-hand-off rule is stated over the statement, not over SQL", () => {
    // A plan run on MongoDB drafts an aggregation, so the general statement of the rule
    // cannot be made about a language only some engines speak.
    expect(AGENT_DOC).toContain("an unmarked control against the statement is the silent hand-off");
    expect(AGENT_DOC).not.toContain("against the SQL");
  });

  test("the guide's Schema captured row states the engine's own noun, not a table count", () => {
    // The renderer takes the word from the provider's labels, never from the shape the
    // capture happens to be recorded in.
    // A regex rather than the line, so a reflow of that ternary is not a doc failure.
    expect(TIMELINE).toMatch(/tableCount === 1\s*\?\s*noun\.singular\s*:\s*noun\.plural/);

    // The row, not the paragraph above it that also names the entry: the fingerprint is
    // what only the row states.
    const row = AGENT_GUIDE.split("\n").find(
      (line) => line.includes("`Schema captured`") && line.includes("fingerprint"),
    );
    expect(row).toBeDefined();
    expect(row).not.toContain("table count");
    expect(row).toContain("the engine's own noun");
  });

  test("the guide's strip table has one row for each reading the posture renders, and no other", () => {
    // Every reading the strip can show, from the module that writes it: plan mode with no connection resolved and on
    // every engine (a language pack may declare its own plan posture), agent mode with no connection resolved, agent
    // mode on every engine with the hand-over consented and not, and agent mode on every engine after a run on the
    // connection was refused for the connection itself. The engine is labelled the way the guide names one, so the arm
    // that names it renders the guide's own placeholder.
    const label = "`<engine>`";
    const engines = Object.keys(AGENT_STATEMENT_LANGUAGE) as DatabaseType[];
    const postures = [
      agentPosture({ mode: "planning", engine: null, engineLabel: label, handover: false }),
      ...engines.map((engine) => agentPosture({ mode: "planning", engine, engineLabel: label, handover: false })),
      agentPosture({ mode: "agent", engine: null, engineLabel: label, handover: false }),
      ...engines.flatMap((engine) =>
        [false, true].map((handover) => agentPosture({ mode: "agent", engine, engineLabel: label, handover })),
      ),
      ...engines.map((engine) =>
        agentPosture({ mode: "agent", engine, engineLabel: label, handover: false, refusedHere: "Refused." }),
      ),
    ];
    const readings = [...new Set(postures.map((posture) => `*${posture.headline}* | *${posture.qualifier}*`))].sort();
    const table = AGENT_GUIDE.split("| The pill says | Beside it | When |\n| --- | --- | --- |\n")[1]?.split("\n\n")[0];
    const rows = (table ?? "").split("\n").map((row) =>
      row
        .split("|")
        .slice(1, 3)
        .map((cell) => cell.trim())
        .join(" | "),
    );
    expect(rows).toHaveLength(readings.length);
    expect([...rows].sort()).toEqual(readings);
  });
});

/**
 * The egress table states ranges over the frozen decision table, and a range is the
 * kind of figure that goes stale silently (#373 review): `maxModelTurns` still said
 * "20-48" after `data-analysis` landed at 60, so the page that answers "how much can
 * leave" understated a ceiling by a fifth of a run.
 *
 * Derived from `AGENT_WORKFLOW_BUDGETS` rather than listed here, so the row that fails
 * is the row a workflow moved — the same shape as the route scan above.
 */
describe("docs/AGENT_DATA_FLOW.md states the frozen ceilings as they are", () => {
  const DATA_FLOW = read("docs/AGENT_DATA_FLOW.md");
  const rows = Object.values(AGENT_WORKFLOW_BUDGETS);

  const range = (values: readonly number[]): string => `${Math.min(...values)}-${Math.max(...values)}`;

  test.each([
    ["maxModelTurns", range(rows.map((row) => row.maxModelTurns))],
    ["maxStatementsPerRun", range(rows.map((row) => row.policy.budgets.maxStatementsPerRun))],
  ])("the %s row states %s, by workflow", (bound, expected) => {
    // The bound's own row, not the document: two rows could otherwise cover for each
    // other while both were wrong.
    const row = DATA_FLOW.split("\n").find((line) => line.includes(`\`${bound}\``));
    expect(row).toBeDefined();
    expect(row).toContain(`${expected}, by workflow`);
  });
});

describe("the guide's history bound is the retention constant", () => {
  const AGENT_GUIDE = read("docs/AGENT_GUIDE.md");

  test("the number in the newest-conversations sentence is AGENT_HISTORY_MAX_CONVERSATIONS", () => {
    // Prose is the one part nothing else checks: "50" could become "5" here and
    // every gate stays green, which is exactly the drift this guard exists for.
    const match = AGENT_GUIDE.match(/keeps the (\d+) newest conversations/);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(AGENT_HISTORY_MAX_CONVERSATIONS);
  });
});

describe("the agent's HTTP surface is documented where a reader looks for a route", () => {
  /**
   * B19's own "done" text asked for this: nothing compared `docs/API_DOCS.md` against
   * `src/app/api/`, so a route family could be absent from the API reference and every
   * gate stayed green. The paths are DERIVED from the route tree rather than listed
   * here, so a seventh agent path added tomorrow fails this test instead of being
   * silently undocumented.
   *
   * Dynamic segments are compared in the reference's own notation (`{runId}`), which is
   * what the rest of that document already uses for a path parameter.
   */
  const API_DOCS = read("docs/API_DOCS.md");

  const routePaths = scan("src/app/api/agent/**/route.ts")
    .map((file) =>
      file
        .replace(/^src\/app/, "")
        .replace(/\/route\.ts$/, "")
        .replace(/\[(\w+)\]/g, "{$1}"),
    )
    .sort();

  test("the scan found the agent route tree (an empty scan would pass everything below)", () => {
    expect(routePaths).toContain("/api/agent/config");
    expect(routePaths).toContain("/api/agent/drive");
    expect(routePaths.length).toBeGreaterThanOrEqual(6);
  });

  test.each(routePaths)("%s appears in docs/API_DOCS.md", (routePath) => {
    expect(API_DOCS).toContain(routePath);
  });

  test("the family is reachable from the table of contents", () => {
    expect(API_DOCS).toContain("#agent-api");
  });
});

describe("the removal's coverage map cites a measurement that exists (#331 T7)", () => {
  /**
   * `docs/AGENT.md` claims the removed NL2SQL and Autopilot panels' happy paths are
   * measured as agent runs, and names the file that does it. A claim about a test file
   * is worth exactly what the file's existence is worth: if the evals are renamed or
   * deleted, the section stops being evidence and starts being a story about one.
   */
  const SECTION = "## What the removed AI panels did that a run does not";
  const COVERAGE_EVAL = "tests/evals/legacy-surface-coverage.test.ts";

  test("the section exists and names the eval that measures it", () => {
    expect(AGENT_DOC).toContain(SECTION);
    // Bounded at the next heading, so a mention somewhere else in the document
    // cannot stand in for this section carrying its own evidence.
    const section = AGENT_DOC.split(SECTION)[1]?.split(/^## /m)[0] ?? "";
    expect(section).toContain(COVERAGE_EVAL);
  });

  test("the eval file it names is in the repository", () => {
    expect(existsSync(path.join(ROOT, COVERAGE_EVAL))).toBe(true);
  });

  test("the two largest losses are IN the list, not only elsewhere in the document", () => {
    // Review found the section flattering: it listed six losses and omitted the two
    // biggest ones, both in our favour. The agent is standalone-only, so for an
    // embedded user every "what a run does instead" cell is false; and a toolless
    // model, which drove both panels, is refused outright. Both facts were stated in
    // other sections, which made the record incomplete rather than concealed — and a
    // section whose purpose is to say what a user lost has to carry them itself.
    const section = AGENT_DOC.split(SECTION)[1]?.split(/^## /m)[0] ?? "";

    expect(section).toContain("tests/unit/agent-package-boundary.test.ts");
    expect(section).toContain("src/lib/agent/capability-gate.ts");
  });
});

describe("the container image carries the ledger default a plain `docker run` cannot pass", () => {
  /**
   * The ratified T5 proposal says a plain `docker run` must carry the same ledger
   * default `docker-compose.yml` sets. Compose can express it in a file the operator
   * already edits; a bare `docker run -p 3000:3000 ghcr.io/...` cannot, and with no
   * default in the image the SDK resolves `.workflow-data` against the working
   * directory — `/app`, the container's writable layer, which survives a restart and
   * is discarded on the next recreate or image upgrade. The image is the only place
   * that reaches every one of those runs, so the default lives there.
   */
  const DOCKERFILE = read("Dockerfile");
  const COMPOSE = read("docker-compose.yml");
  const LEDGER_PATH = "/app/data/workflow";

  test("the runtime stage sets WORKFLOW_LOCAL_DATA_DIR inside the data volume", () => {
    const runner = DOCKERFILE.split(/^FROM .* AS runner$/m)[1] ?? "";
    expect(runner).toContain(`ENV WORKFLOW_LOCAL_DATA_DIR=${LEDGER_PATH}`);
  });

  test("the image default is the path compose and the operator documentation already name", () => {
    // Three files stating three paths would put the ledger somewhere no volume is
    // mounted for two of them.
    expect(COMPOSE).toContain(`WORKFLOW_LOCAL_DATA_DIR=\${WORKFLOW_LOCAL_DATA_DIR:-${LEDGER_PATH}}`);
    expect(ENV_EXAMPLE).toContain(`WORKFLOW_LOCAL_DATA_DIR=${LEDGER_PATH}`);
    expect(AGENT_DOC).toContain(LEDGER_PATH);
  });

  test("the default sits under the directory the entrypoint makes writable for the app user", () => {
    // The runtime stage never issues `USER`: the container starts as root, the
    // entrypoint chowns the data directory and drops to `nextjs` with gosu. A ledger
    // default outside that directory would be unwritable under a mounted volume.
    const entrypoint = read("docker-entrypoint.sh");
    expect(entrypoint).toContain("/app/data");
    expect(LEDGER_PATH.startsWith("/app/data/")).toBe(true);
  });
});

describe("the chart says the zero-config durable backend is single-instance", () => {
  test("the replicaCount comment names the variable that lifts the constraint", () => {
    const comment =
      CHART_VALUES.split(/^replicaCount:/m)[0]
        .split(/\n\s*\n/)
        .at(-1) ?? "";
    expect(comment).toContain("WORKFLOW_TARGET_WORLD");
  });

  test("the chart README states the constraint and how to opt out of it", () => {
    // Bounded on BOTH sides: the README says "replicaCount > 1" in other sections
    // (sqlite storage, rate limiting), so a section that ran to end-of-file would let
    // the replica assertion pass on somebody else's paragraph.
    const section = CHART_README.split(/^## Agent Runtime/m)[1]?.split(/^## /m)[0] ?? "";
    expect(section).toContain("LIBREDB_AGENT_ENABLED");
    expect(section).toContain("WORKFLOW_TARGET_WORLD");
    expect(section).toContain("@workflow/world-postgres");
    expect(section).toMatch(/single-instance/i);
    expect(section).toMatch(/replicaCount[^.]*\b1\b/);
    // The README must name the path the chart actually writes, so a reader who
    // overrides it knows what they are replacing.
    expect(section).toContain(`WORKFLOW_LOCAL_DATA_DIR=${CHART_LEDGER_PATH}`);
  });

  /**
   * This assertion used to be `/WORKFLOW_LOCAL_DATA_DIR[\s\S]*\/app\/data/` on the
   * README, guarding an `extraEnv` recipe. It survived the recipe's deletion — the
   * two tokens still appeared in prose that said there was NO such variable to
   * remember — and so it passed while a default install was broken. A documentation
   * regex cannot check a deployment; the deployment can. What actually has to hold
   * is that the packaged chart steers the ledger into the one writable volume,
   * because `securityContext.readOnlyRootFilesystem: true` leaves the SDK's
   * cwd-relative default (`.workflow-data` under `WORKDIR /app`) unwritable and no
   * run can start. The image carries its own copy only from an app version later
   * than the `appVersion` this chart deploys, so the chart is what makes a default
   * install work today.
   */
  test("the chart itself writes the ledger into the writable volume", () => {
    const deployment = read("charts/libredb-studio/templates/deployment.yaml");
    expect(deployment).toMatch(new RegExp(`- name: WORKFLOW_LOCAL_DATA_DIR\\s*\\n\\s*value: ${CHART_LEDGER_PATH}\\b`));
    // The volume that path lives in is mounted unconditionally, not only under
    // persistence: an emptyDir still makes the agent work, it only makes it forget.
    expect(deployment).toMatch(/mountPath: \/app\/data\b/);
  });

  test("the operator's verbatim chart copy still matches the source chart", () => {
    expect(operatorCopyViolations(ROOT)).toEqual([]);
  });
});

/**
 * The provider file that implements each listed engine's `queryReadOnly`, which `docs/AGENT.md` links in its engine
 * paragraph. Keyed by the list, and a test holds its keys to it, so an engine added to `AGENT_EXECUTION_ENGINES`
 * fails until its provider is named here and linked there.
 */
const READ_ONLY_PROVIDER_FILES: Readonly<Record<string, string>> = {
  postgres: "src/lib/db/providers/sql/postgres.ts",
  sqlite: "src/lib/db/providers/sql/sqlite.ts",
  duckdb: "src/lib/db/providers/sql/duckdb/index.ts",
  mssql: "src/lib/db/providers/sql/mssql.ts",
  mysql: "src/lib/db/providers/sql/mysql.ts",
  kubernetes: "src/lib/db/providers/platform/kubernetes/index.ts",
  mongodb: "src/lib/db/providers/document/mongodb/index.ts",
  clickhouse: "src/lib/db/providers/sql/clickhouse/index.ts",
  libsql: "src/lib/db/providers/sql/libsql/index.ts",
  influxdb3: "src/lib/db/providers/timeseries/influxdb/sql-provider.ts",
  elasticsearch: "src/lib/db/providers/sql/search/index.ts",
  opensearch: "src/lib/db/providers/sql/search/index.ts",
  oracle: "src/lib/db/providers/sql/oracle/index.ts",
  db2: "src/lib/db/providers/sql/db2/index.ts",
  cassandra: "src/lib/db/providers/sql/cassandra/index.ts",
  couchbase: "src/lib/db/providers/document/couchbase/index.ts",
  druid: "src/lib/db/providers/sql/druid/index.ts",
  libredb: "src/lib/db/providers/embedded/libredb.ts",
  influxdb: "src/lib/db/providers/timeseries/influxdb/influxql-provider.ts",
  weaviate: "src/lib/db/providers/vector/weaviate/index.ts",
  qdrant: "src/lib/db/providers/vector/qdrant/index.ts",
  neo4j: "src/lib/db/providers/graph/neo4j/index.ts",
  milvus: "src/lib/db/providers/vector/milvus/index.ts",
  redis: "src/lib/db/providers/keyvalue/redis.ts",
  etcd: "src/lib/db/providers/keyvalue/etcd/index.ts",
  oxia: "src/lib/db/providers/keyvalue/oxia/index.ts",
  rabbitmq: "src/lib/db/providers/stream/rabbitmq/index.ts",
  kafka: "src/lib/db/providers/stream/kafka/index.ts",
  s3: "src/lib/db/providers/objectstore/s3/index.ts",
  firestore: "src/lib/db/providers/document/firestore/index.ts",
  snmp: "src/lib/db/providers/network/snmp/index.ts",
  netconf: "src/lib/db/providers/network/netconf/index.ts",
  modbus: "src/lib/db/providers/industrial/modbus/index.ts",
  prometheus: "src/lib/db/providers/timeseries/prometheus/index.ts",
  opcua: "src/lib/db/providers/industrial/opcua/index.ts",
  mtconnect: "src/lib/db/providers/industrial/mtconnect/index.ts",
  mqtt: "src/lib/db/providers/keyvalue/mqtt/index.ts",
  sparkplug: "src/lib/db/providers/industrial/sparkplug/index.ts",
};

/**
 * The copy that names the engines agent mode executes on: the READMEs and their translations, the agent pages, and the
 * marketplace listings (the `LISTINGS` of `tests/unit/marketplace-copy.test.ts` that carry such a sentence, plus the
 * Azure offer's HTML description and the PCSC page body).
 */
const ENGINE_CLAIM_FILES = [
  "README.md",
  "README_hi.md",
  "README_ja.md",
  "README_ko.md",
  "README_ru.md",
  "README_zh.md",
  "DOCKERHUB.md",
  "docs/AGENT.md",
  "docs/AGENT_GUIDE.md",
  "docs/AGENT_DEMO.md",
  "docs/FEATURES.md",
  "docs/providers/libsql.md",
  "docs/API_DOCS.md",
  "deploy/railway/TEMPLATE_OVERVIEW.md",
  "deploy/digitalocean/assets/description-long.md",
  "deploy/rancher/CATALOG_LISTING.md",
  "deploy/rancher/app-readme.md",
  "deploy/rancher/pcsc-listing.html",
  "deploy/azure/listing/description.html",
];

/** Copy that names no agent-mode engine today, scanned so that a sentence added there is held to the list too. */
const ENGINE_CLAIM_SCANNED = [
  "README_es.md",
  "README_pt.md",
  "README_ur.md",
  "docs/AGENT_DATA_FLOW.md",
  "deploy/azure/listing/listing-fields.md",
  "deploy/aws/listing/listing-fields.md",
];

/**
 * The phrase each file uses for agent mode, in English and in each translated README's own words, and the method the
 * agent's statements reach an engine through, which a sentence naming its implementers names instead.
 */
const AGENT_ENGINE_CLAIM =
  /agent mode|agentモード|agent 모드|режим agent|agent 模式|read-only (?:investigation )?agent|(?:execut(?:es|ing)|runs) statements|statement path|agent read-only profile|queryReadOnly/i;

/** A sentence naming SQL engines for MCP, whose `run_read_query` serves the SQL engines alone (#1614 decision 2). */
const MCP_CLAIM = /\bMCP\b|run_read_query|Five read-only tools/;

/**
 * An engine count where the engines should be named (#1614: "Never write a count of engines; name them from the
 * list"), in each language a README states one in.
 */
const ENGINE_COUNT =
  /\b(five|six|seven) (engines|providers)\b|thirty-five|sixth engine|шести|여섯|六种|यही चार engines|この\d+つのエンジン/;

/**
 * A file's sentences, for a claim that may wrap: a soft line break inside a paragraph is joined, a list item, a table
 * row, a heading and an HTML block each start a sentence, a blockquote's markers are dropped, and a sentence ends at a
 * full stop before a space or at a Devanagari or CJK full stop, which needs none.
 */
const sentencesOf = (text: string): string[] =>
  text
    .replace(/<\/?(?:p|ul|li|h3)>/g, "\n\n")
    .replace(/^> ?/gm, "")
    .replace(/\n(?![\n\-*|#])[ \t]*/g, " ")
    .split(/(?<=[。।])\s*|(?<=\.)\s+|\n+/);

const PRODUCT_ENGINES = EXTERNAL_DATABASE_TYPES.map((type) => getDBConfig(type).label);

/**
 * The sentences of `text` that claim where agent mode executes: three or more of the engines on the list, named beside
 * an agent-mode phrase. Two named engines are a statement about that pair, such as the composed catalog on PostgreSQL
 * and SQLite, rather than a list.
 */
const engineClaimsIn = (text: string): string[] =>
  sentencesOf(text).filter(
    (sentence) =>
      AGENT_EXECUTION_ENGINES.filter((type) => sentence.includes(getDBConfig(type).label)).length >= 3 &&
      AGENT_ENGINE_CLAIM.test(sentence) &&
      !MCP_CLAIM.test(sentence) &&
      !PRODUCT_ENGINES.every((label) => sentence.includes(label)),
  );

const engineClaims = (relative: string): string[] => engineClaimsIn(read(relative));

/** The part of the Rancher listing that is submitted, as `tests/unit/marketplace-copy.test.ts` cuts it. */
const rancherSubmittedCopy = (): string => {
  const listing = read("deploy/rancher/CATALOG_LISTING.md");
  const from = listing.indexOf("## Short description");
  const to = listing.indexOf("## Outstanding corrections");
  // Thrown rather than sliced: a heading renamed away would leave an empty slice, which no count can fail.
  if (from < 0 || to < from) throw new Error("deploy/rancher/CATALOG_LISTING.md: the submitted sections moved");
  return listing.slice(from, to);
};

describe("every agent-mode engine sentence is the one engine list (#246)", () => {
  /**
   * AGENT_EXECUTION_ENGINES is the list, and every sentence that names the engines agent mode and
   * run_read_query execute on is derived from it. These three said PostgreSQL and SQLite long after
   * DuckDB and SQL Server joined, which no test could see. Every line break is joined away first,
   * with the comment marker that continues it, if any, and the indentation around it, so a
   * sentence may wrap where the file wraps: in a docblock, in a # comment, or in a block comment
   * whose lines carry no marker at all, as the seed loader's does.
   */
  const list = namedList(AGENT_EXECUTION_ENGINES.map((type) => getDBConfig(type).label));
  const prose = (relative: string) => read(relative).replace(/\n[ \t]*(?:\*|\/\/|#)?[ \t]*/g, " ");

  test("the derived list is today's thirty-eight engines", () => {
    expect(list).toBe(
      "PostgreSQL, SQLite, DuckDB, SQL Server, MySQL, Kubernetes, MongoDB, ClickHouse, libSQL, InfluxDB 3 (SQL), Elasticsearch, OpenSearch, Oracle, Db2 LUW, Apache Cassandra, Couchbase, Apache Druid, LibreDB, InfluxDB (InfluxQL), Weaviate, Qdrant, Neo4j, Milvus, Redis, etcd, Oxia, RabbitMQ, Apache Kafka, S3-compatible object storage, Firestore, SNMP, NETCONF, Modbus, Prometheus, OPC UA, MTConnect, MQTT and Sparkplug B",
    );
  });

  test(".env.example states it, and says plan mode is grounded on every engine", () => {
    const env = prose(".env.example");
    expect(env).toContain(`AGENT MODE EXECUTES STATEMENTS ON ${list.toUpperCase()} ONLY.`);
    expect(env).toContain("grounded on every engine");
    expect(env).not.toContain("POSTGRESQL AND SQLITE ONLY");
  });

  test("the factory's profile comment states it", () => {
    expect(prose("src/lib/db/factory.ts")).toContain(`implement that: ${list} (`);
  });

  test("the seed loader's sample comment states it", () => {
    expect(prose("src/lib/seed/index.ts")).toContain(`Agent mode executes statements on ${list};`);
  });

  test("each engine on the list has its read-only provider file, and the map has no other key", () => {
    expect(Object.keys(READ_ONLY_PROVIDER_FILES).sort()).toEqual([...AGENT_EXECUTION_ENGINES].sort());
    for (const file of Object.values(READ_ONLY_PROVIDER_FILES)) expect(existsSync(path.join(ROOT, file))).toBe(true);
  });

  test("the guide's list of the files that define queryReadOnly names each read-only provider file", () => {
    const sentence = read("docs/AGENT_GUIDE.md").split("`queryReadOnly` exists on ")[1]?.split(/\.\n/)[0] ?? "";
    for (const file of Object.values(READ_ONLY_PROVIDER_FILES)) {
      const [parent, base] = file.split("/").slice(-2);
      expect(sentence).toContain(base === "index.ts" ? `\`${parent}/index.ts\`` : base);
    }
  });

  /**
   * A sentence that lists the files defining `queryReadOnly` (it names both `postgres.ts` and `sqlite.ts`) names every
   * read-only provider file, in every README translation and agent page, so a list closed with "and nowhere else"
   * cannot leave out an engine the same sentence's heading names.
   */
  test.each(ENGINE_CLAIM_FILES)(
    "every list of queryReadOnly's files in %s names each read-only provider file",
    (file) => {
      const lists = sentencesOf(read(file)).filter(
        (sentence) => sentence.includes("`postgres.ts`") && sentence.includes("`sqlite.ts`"),
      );
      for (const sentence of lists) {
        for (const provider of Object.values(READ_ONLY_PROVIDER_FILES)) {
          const [parent, base] = provider.split("/").slice(-2);
          expect(sentence).toContain(base === "index.ts" ? `${parent}/index.ts\`` : `${base}\``);
        }
      }
    },
  );

  test("docs/FEATURES.md no longer says the search providers implement no queryReadOnly", () => {
    expect(read("docs/FEATURES.md")).not.toContain("The search providers implement no `queryReadOnly`");
  });

  /**
   * The copy that names the engines agent mode executes on, in prose and in five languages. A sentence is selected by
   * what it claims rather than by where it sits: it names three or more of the engines on the list beside one of the
   * phrases each file uses for agent mode, or beside `queryReadOnly`, the method a sentence naming its implementers
   * names. Two kinds of sentence name those engines for another reason and are left out: MCP's `run_read_query` list,
   * by name, because that tool serves the SQL engines alone (#1614 decision 2), and the product's whole engine list,
   * which names every engine and which the Railway overview runs into its agent clause.
   */
  test.each(ENGINE_CLAIM_FILES)(
    "%s carries an agent-mode engine sentence (an empty selection passes the rest)",
    (file) => {
      expect(engineClaims(file).length).toBeGreaterThan(0);
    },
  );

  test.each([...ENGINE_CLAIM_FILES, ...ENGINE_CLAIM_SCANNED])(
    "every agent-mode engine sentence in %s names the list",
    (file) => {
      for (const claim of engineClaims(file)) {
        for (const type of AGENT_EXECUTION_ENGINES) expect(claim).toContain(getDBConfig(type).label);
      }
    },
  );

  test("the selector reads a claim in another language and leaves the product's engine list out", () => {
    const agentClaim = "- **Режим Agent работает только с PostgreSQL, SQLite, DuckDB, SQL Server, MySQL и MongoDB.**";
    expect(engineClaimsIn(agentClaim)).toHaveLength(1);
    const productList = `Query ${EXTERNAL_DATABASE_TYPES.map((type) => getDBConfig(type).label).join(", ")} from your browser, with a read-only agent beside them.`;
    expect(engineClaimsIn(productList)).toEqual([]);
    expect(
      engineClaimsIn("- `run_read_query` runs on PostgreSQL, SQLite, DuckDB, SQL Server and MySQL in agent mode."),
    ).toEqual([]);
  });

  test("the selector reads a list of queryReadOnly's implementers, and leaves a pair of engines out", () => {
    expect(
      engineClaimsIn(
        "The read tools reach the database through `provider.queryReadOnly`, which PostgreSQL, SQLite and DuckDB implement.",
      ),
    ).toHaveLength(1);
    expect(engineClaimsIn("In agent mode the server composes catalog statements on PostgreSQL and SQLite.")).toEqual(
      [],
    );
  });

  test.each([...ENGINE_CLAIM_FILES, ...ENGINE_CLAIM_SCANNED, "src/lib/agent/engine-support.ts"])(
    "%s counts no engines",
    (file) => {
      // The Rancher file's editorial notes date old copy by its engine count, so only its submitted copy is held.
      const text = file === "deploy/rancher/CATALOG_LISTING.md" ? rancherSubmittedCopy() : read(file);
      // The READMEs and listings wrap their lines, so a count split by a line break is matched too.
      expect(text.replace(/\s+/g, " ")).not.toMatch(ENGINE_COUNT);
    },
  );

  test("docs/API_DOCS.md quotes the refusal the posture writes for an engine outside the list", () => {
    const body = agentPosture({ mode: "agent", engine: "spark", engineLabel: "Apache Spark", handover: false }).body;
    expect(read("docs/API_DOCS.md")).toContain(`"error": "${body}"`);
  });
});

/**
 * Agent execution on Kubernetes changed six claims this document makes, and each is pinned against the code that
 * decides it, so the row that drifts is the one that fails: the engine paragraph and the boundary it names, the
 * descriptor table, the kubectl variants, their verdicts, the posture row and the stated residue. The residue is
 * the same six lines `docs/providers/kubernetes.md` section 9 carries, word for word, because a reader of either
 * page is owed the whole of what machine redaction leaves unmasked.
 */
describe("docs/AGENT.md states agent execution on Kubernetes as the code decides it", () => {
  const sectionOf = (heading: string): string => AGENT_DOC.split(heading)[1]?.split(/^#{2,3} /m)[0] ?? "";
  const cells = (row: string): string[] =>
    row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
  const ticked = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

  test("the engine paragraph names every executing engine, links each one's provider and names Kubernetes' boundary", () => {
    const paragraph = AGENT_DOC.split("- **Agent mode requires ")[1]?.split(/\n\n/)[0] ?? "";
    expect(paragraph.length).toBeGreaterThan(0);
    for (const type of AGENT_EXECUTION_ENGINES) {
      expect(paragraph).toContain(getDBConfig(type).label);
      expect(paragraph).toContain(`(../${READ_ONLY_PROVIDER_FILES[type]})`);
    }
    expect(paragraph).toContain("request allowlist");
    expect(paragraph).toContain("RBAC");
    expect(paragraph).toContain("(#on-a-mongodb-connection)");
  });

  test("the R1 paragraph admits a Studio-enforced final-request allowlist and never a parser", () => {
    const paragraph =
      AGENT_DOC.split("**The curated read is a fifth operation descriptor**")[1]?.split(/\n\n/)[0] ?? "";
    expect(paragraph).not.toContain("must NAME the database-native mechanism");
    expect(paragraph).toContain("final method and path");
    expect(paragraph).toContain("never a parser");
  });

  test("the descriptor table holds every registered descriptor, each row as the registry declares it", () => {
    const registry = createCanonicalOperationRegistry();
    const header = "| Descriptor | Risk class | Access level | Cost | Audit action | Reached by |";
    const table = AGENT_DOC.split(header)[1]?.split(/\n\n/)[0] ?? "";
    const rows = table
      .split("\n")
      .filter((line) => line.startsWith("| `"))
      .map(cells);
    expect(rows.map((row) => ticked(row[0])[0]).sort()).toEqual([...registry.registeredIds()]);
    for (const id of ["kubectl.query.read", "cluster.usage.read", "cluster.workloads.read"]) {
      expect(rows.some((row) => ticked(row[0])[0] === id)).toBe(true);
    }
    for (const row of rows) {
      const resolution = registry.resolve(ticked(row[0])[0]);
      expect(resolution.kind).toBe("resolved");
      if (resolution.kind !== "resolved") continue;
      const { descriptor } = resolution;
      expect(row[1]).toBe(`R${descriptor.riskClass}`);
      expect(row[2]).toBe(`\`${descriptor.accessLevel}\``);
      expect(row[3]).toBe(`\`${descriptor.resourceCost}\``);
      // The audit stream records the descriptor's own id as the action (`execution.ts`).
      expect(row[4]).toBe(`\`${descriptor.id}\``);
    }
  });

  test("the Kubernetes variants table lists each variant's tools and narrowed extras", () => {
    const section = sectionOf("### On a Kubernetes connection");
    const variants = AGENT_WORKFLOW_VARIANTS.kubectl;
    const workflows = Object.keys(variants).filter((workflow) => workflow !== "operations");
    expect(workflows.length).toBe(4);
    for (const workflow of workflows) {
      const variant = variants[workflow as keyof typeof variants];
      const row = section.split("\n").find((line) => line.startsWith(`| \`${workflow}\``));
      expect(row).toBeDefined();
      const [, tools, extras] = cells(row ?? "");
      expect(ticked(tools).sort()).toEqual([...(variant?.tools ?? [])].sort());
      const narrowed = [...(variant?.narrowedExtras ?? [])].sort();
      if (narrowed.length === 0) expect(extras).toBe("none");
      else expect(ticked(extras).sort()).toEqual(narrowed);
    }
    for (const absent of ["inspect_plan", "compare_plans", "profile_table"]) expect(section).toContain(`\`${absent}\``);
    expect(section).toContain("grounding inventory");
  });

  test("the verdict section names both kubectl verifiers and their four shortfalls", () => {
    const section = sectionOf("## Whether the run answered");
    for (const variant of Object.values(AGENT_WORKFLOW_VARIANTS.kubectl)) {
      expect(section).toContain(`\`${variant?.verifier}\``);
    }
    for (const shortfall of ["no-usage-reading", "no-usage-evidence", "no-usage-metrics", "no-workload-profile"]) {
      expect(section).toContain(`\`${shortfall}\``);
    }
  });

  test("the posture table carries the kubectl reads arm in the words the strip renders", () => {
    const posture = agentPosture({ mode: "agent", engine: "kubernetes", engineLabel: "Kubernetes", handover: false });
    const boundary = posture.qualifier.split(", ").at(-1) ?? "";
    expect(boundary).toContain("request allowlist");
    const row = AGENT_DOC.split("\n").find((line) => line.startsWith("| `reads`") && line.includes(`*${boundary}*`));
    expect(row).toBeDefined();
  });

  test("the withheld-names paragraph says Secret names are masked in agent reads and namespace names pass", () => {
    const line = AGENT_DOC.split("\n").find((text) => text.startsWith("Kubernetes declares both:")) ?? "";
    expect(line).toContain("maskedNameKinds");
    expect(line).toContain("masked in its agent reads");
    expect(line).toContain("namespace names pass");
  });

  test("Known limitations carries the residue of machine redaction verbatim", () => {
    const section = sectionOf("## Known limitations");
    for (const line of [
      "Log lines and event messages are free text the server wrote; a credential an application prints reaches the model.",
      "Status and condition messages pass.",
      "Label values pass, and can hold anything a team put there.",
      "Custom-resource fields with no structural rule pass in -o yaml and -o json.",
      "A guessed Secret name can be confirmed to exist through get secret NAME or auth can-i get secrets/NAME; RBAC decides that.",
      "The connection's Namespaces field lists the tree; it does not bound a statement, which may use -A or any -n.",
    ]) {
      expect(section).toContain(`- ${line}\n`);
    }
  });
});

/**
 * A read-only transaction is not what bounds an agent statement on MySQL and MariaDB: DDL, GRANT and SET GLOBAL each
 * commit implicitly, which ends the transaction before the statement runs, so the principal is the first layer there
 * and the transaction the second (`docs/providers/mysql.md` section 12.1, measured), and the provider reads the
 * principal's grants at its first statement rather than at open. On PostgreSQL the read-only transaction is not the
 * whole boundary either, because it does not stop a superuser's `COPY ... TO PROGRAM`, which is why the role is
 * verified at open (`docs/SECURITY.md` row 3.4). A sentence that lists MySQL among the engines a read-only transaction
 * bounds says the reverse of the first, and one that names PostgreSQL's transaction alone leaves out half of the second.
 */
describe("the SQL engines' boundaries are stated in the order their provider documents measured", () => {
  const clausesOf = (sentence: string, label: string): string[] =>
    sentence.split("; ").filter((clause) => clause.includes(label));

  test("the MySQL provider document is still the source: the principal first, read at the first statement", () => {
    const mysql = read("docs/providers/mysql.md");
    expect(mysql).toContain(
      "### 12.1 The principal is the first layer, because a read-only transaction ends where DDL begins",
    );
    expect(mysql).toContain("The verification runs at the FIRST `queryReadOnly` call, not at `connect()`");
  });

  test("docs/AGENT.md's engine paragraph puts MySQL's principal before its transaction, and PostgreSQL's role beside its own", () => {
    const paragraph = AGENT_DOC.split("- **Agent mode requires ")[1]?.split(/\n\n/)[0] ?? "";
    const sentence = paragraph.split("\n").find((line) => line.trim().startsWith("On the SQL engines")) ?? "";
    const [mysql = "", ...otherMysql] = clausesOf(sentence, "MySQL");
    expect(otherMysql).toEqual([]);
    expect(mysql).toContain("principal verified before the first statement");
    expect(mysql).toContain("implicit");
    expect(mysql.indexOf("principal")).toBeLessThan(mysql.indexOf("`START TRANSACTION READ ONLY`"));
    const [postgres = "", ...otherPostgres] = clausesOf(sentence, "PostgreSQL");
    expect(otherPostgres).toEqual([]);
    expect(postgres).toContain("read-only transaction");
    expect(postgres).toContain("role verified at open");
  });

  test("docs/FEATURES.md's read-only bullet reads MySQL's principal at the first statement, not at open", () => {
    const bullet =
      read("docs/FEATURES.md")
        .split("\n")
        .find((line) => line.includes("**Read-only, enforced by the database:**")) ?? "";
    const mysql = bullet.slice(bullet.indexOf("On MySQL and MariaDB"));
    expect(bullet).toContain("On MySQL and MariaDB");
    expect(mysql).toContain("principal verified before the first statement");
    expect(mysql).not.toMatch(/^On MySQL and MariaDB[^.]*verified at open/);
  });
});

describe("docs/AGENT.md names every language-pack resolver in its Language packs section (#1821)", () => {
  const section = AGENT_DOC.split("\n## Language packs\n")[1]?.split(/^## /m)[0] ?? "";
  const RESOLVERS = [
    ...Object.keys(engineClientResolvers),
    ...Object.keys(engineServerResolvers),
    ...Object.keys(enginePackResolvers),
    "languageClientPack",
    "languageServerPack",
    "agentLanguagePack",
    "statementFamilyOf",
    "DEFAULT_STATEMENT_LANGUAGE",
    "CURATED_CALL_LANGUAGE",
  ];

  test("the section exists and is in the table of contents", () => {
    expect(section.length).toBeGreaterThan(0);
    expect(AGENT_DOC).toContain("[Language packs](#language-packs)");
  });

  test("the engine resolvers were read from their modules (an empty read would pass everything below)", () => {
    expect(RESOLVERS).toContain("runServerPack");
    expect(RESOLVERS).toContain("agentEnginePack");
    expect(RESOLVERS).toContain("engineFamily");
  });

  test("each resolver is named in backticks", () => {
    expect(RESOLVERS.filter((name) => !section.includes(`\`${name}\``))).toEqual([]);
  });

  // Derived from the record that is total over AgentStatementLanguageId, so a language's first-member change cannot
  // land without moving this sentence.
  test("its opening sentence counts and names every statement language", () => {
    const ids = Object.keys(AGENT_LANGUAGE_COPY);
    const COUNT_WORDS = [
      "zero",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      "ten",
      "eleven",
      "twelve",
      "thirteen",
      "fourteen",
      "fifteen",
      "sixteen",
      "seventeen",
      "eighteen",
      "nineteen",
      "twenty",
      "twenty-one",
      "twenty-two",
      "twenty-three",
      "twenty-four",
    ];
    expect(ids.length).toBeLessThan(COUNT_WORDS.length);
    expect(section).toContain(
      `Agent mode reads statements in ${COUNT_WORDS[ids.length]} statement languages, ${namedList(ids.map((id) => `\`${id}\``))}, and what it does differently`,
    );
  });
});
