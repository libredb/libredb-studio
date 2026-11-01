/**
 * docs/MCP.md and docs/API_DOCS.md against the code (#246). Reads repository text only: the
 * vendor pages the client sections were written from are not committed, so CI does not have
 * them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MCP_EXPOSABLE, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { readQueryFormsOf } from "@/lib/db/providers/sql/read-query-forms";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import { mcpClientConfigs } from "@/lib/mcp/client-config";
import { RUN_READ_QUERY_ENGINES, RUN_READ_QUERY_TYPES } from "../helpers/run-read-query";
import { mcpStatementArm, servingStatementArms } from "@/lib/mcp/tools/statement-arms";
import type { DatabaseType } from "@/lib/types";

const RUN_KUBECTL_READ_ARM = mcpStatementArm("run_kubectl_read");
const RUN_MONGO_COMMAND_ARM = mcpStatementArm("run_mongo_command");
const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const MCP_DOC = read("docs/MCP.md");
const API_DOCS = read("docs/API_DOCS.md");
const DOC_URL = "https://studio.example.com/api/mcp";
const CLIENTS = ["Claude Code", "Codex", "Cursor", "VS Code", "Gemini CLI", "OpenCode"];

describe("docs/API_DOCS.md documents every MCP route", () => {
  const routes = [...new Bun.Glob("src/app/api/mcp/**/route.ts").scanSync(ROOT)]
    .map((file) =>
      file
        .replaceAll("\\", "/")
        .replace(/^src\/app/, "")
        .replace(/\/route\.ts$/, ""),
    )
    .sort();

  test("the scan found the endpoint itself", () => {
    expect(routes).toContain("/api/mcp");
  });

  test.each(routes)("%s appears", (route) => {
    expect(API_DOCS).toContain(route);
  });

  test("the MCP section is in the table of contents", () => {
    expect(API_DOCS).toContain("[MCP API](#mcp-api)");
  });
});

/**
 * A statement language declares its MCP tool in its own pack and `statement-arms.ts` names no language, so no doc may
 * tell a future language to add an arm of its own there.
 */
describe("the docs say a language's MCP tool is a facet in its pack", () => {
  const docs = [
    "docs/BACKLOG.md",
    "docs/AGENT.md",
    "docs/MCP.md",
    ...new Bun.Glob("docs/providers/*.md").scanSync(ROOT),
  ];

  test.each(docs)("%s sends no language to an arm of its own in MCP_STATEMENT_ARMS", (doc) => {
    expect(
      read(doc)
        .split("\n")
        .filter((line) => /own arm in `MCP_STATEMENT_ARMS`/.test(line)),
    ).toEqual([]);
  });

  test("docs/BACKLOG.md names the facet where a future language's MCP tool lives", () => {
    expect(read("docs/BACKLOG.md")).toContain(
      "its own MCP facet in its language pack (`src/lib/agent/languages/<statement-language>/mcp.ts`, registered in `AGENT_LANGUAGE_MCP_FACETS`)",
    );
  });
});

describe("docs/MCP.md", () => {
  test("carries the engine sentence derived from the one engine list", () => {
    expect(MCP_DOC).toContain(
      `Runs on ${RUN_READ_QUERY_ENGINES}; other engines refuse it, and list_connections' read_tool names the tool that reads each connection.`,
    );
  });

  test("names every statement tool this build registers, and counts the tools", () => {
    const tools = ["list_connections", "inspect_schema", ...servingStatementArms().map((arm) => arm.tool)];
    const COUNT_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six"];
    expect(MCP_DOC).toContain(`- ${COUNT_WORDS[tools.length]} tools, each annotated read-only and closed-world:`);
    for (const tool of tools) expect(MCP_DOC).toMatch(new RegExp(`^ {2}- \`${tool}\` `, "m"));
  });

  test("carries run_mongo_command's engine sentence, derived from its arm, and the read_tool field", () => {
    expect(MCP_DOC).toContain(`Runs on ${RUN_MONGO_COMMAND_ARM.engines}; other engines refuse it.`);
    expect(MCP_DOC).toContain("`read_tool`");
    expect(MCP_DOC).not.toContain("B117");
  });

  test("carries run_kubectl_read's engine sentence, derived from its arm, and says inspect_schema refuses Kubernetes", () => {
    expect(MCP_DOC).toContain(`Runs on ${RUN_KUBECTL_READ_ARM.engines}; other engines refuse it.`);
    expect(MCP_DOC).toContain(
      "On Kubernetes it refuses the call by name, because no Kubernetes kind is a table: the refusal names `run_kubectl_read`, which reads its objects, and is answered as soon as the connection resolves, before anything is acquired.",
    );
    expect(MCP_DOC).not.toContain("On Kubernetes it lists no table");
    expect(MCP_DOC).not.toContain("B105");
  });

  test("claims only SELECT for every engine, and names the record that opens MCP read", () => {
    expect(MCP_DOC).toContain(
      "A `SELECT` (a `WITH` is fine) runs on every engine it serves; a refused statement's answer names what else that engine takes.",
    );
    expect(MCP_DOC).toContain("`MCP_STATEMENT_READ`");
  });

  test("names each served engine's statement forms from its READ_QUERY_FORMS row, and no other engine's", () => {
    // One line per engine, in the row's own words; backticks are the doc's markup, not part of the claim.
    const lines = MCP_DOC.split("\n")
      .map((line) => line.replaceAll("`", ""))
      .filter((line) => /^ {4}- .+: a SELECT \(a WITH is fine\)/.test(line));
    const expected = RUN_READ_QUERY_TYPES.map(
      (type) => `    - ${DB_UI_CONFIG[type].label}: ${readQueryFormsOf(type).statements}.`,
    );
    expect(lines.sort()).toEqual(expected.sort());
  });

  test("names the engines MCP is not offered for in both tool sentences, from MCP_EXPOSABLE (#1089 E12)", () => {
    const refused = SHIPPED_DATABASE_TYPES.filter((type) => !MCP_EXPOSABLE[type]).map(
      (type) => DB_UI_CONFIG[type].label,
    );
    // The control that the record answers: etcd, Oxia, S3, MQTT, Firestore, OPC UA, Modbus, NETCONF and Sparkplug B
    // are the engines it refuses today, with SNMP (#1721) among them: a Get is a read of one numbered object, and the
    // tools answer schemas rather than objects. Kubernetes left the list with run_kubectl_read, machine-redacted.
    expect(refused).toEqual(
      ["etcd", "oxia", "s3", "mqtt", "firestore", "opcua", "modbus", "netconf", "snmp", "sparkplug"].map(
        (type) => DB_UI_CONFIG[type as DatabaseType].label,
      ),
    );
    const names =
      refused.length === 1 ? refused[0] : `${refused.slice(0, -1).join(", ")} and ${refused[refused.length - 1]}`;
    expect(MCP_DOC).toContain(`It works for every engine but ${names}, whose connections the seed file cannot opt in.`);
    expect(MCP_DOC).toContain(
      `It works on every engine but ${names}: it lists every object kind the engine reads rows from`,
    );
    expect(MCP_DOC).not.toContain("It works for every engine.");
  });

  test("the snippet guard covers the OpenCode section", () => {
    expect(mcpClientConfigs(DOC_URL).map((config) => config.client)).toContain("OpenCode");
  });

  test.each(mcpClientConfigs(DOC_URL).map((config) => [config.id, config] as const))(
    "carries the %s snippet exactly as the settings screen renders it",
    (_id, config) => {
      expect(MCP_DOC).toContain(`\`\`\`${config.language}\n${config.snippet}\n\`\`\``);
    },
  );

  test("marks each client section as verified live or not", () => {
    const sections = MCP_DOC.split(/^### /m).filter((section) =>
      CLIENTS.some((client) => section.startsWith(`${client}\n`)),
    );
    expect(sections).toHaveLength(CLIENTS.length);
    for (const section of sections) expect(section).toMatch(/Verified live on \S+ with |Not verified live\./);
  });

  test("mentions a batch only in the line that says batches are refused", () => {
    expect(MCP_DOC.split("\n").filter((line) => /batch/i.test(line))).toEqual([
      "- JSON-RPC batches are refused: a request body that is a JSON array gets 400 and `-32600`.",
    ]);
  });

  test("links OpenCode's own page with a live result wherever it mentions OpenCode", () => {
    for (const section of MCP_DOC.split(/^#{2,3} /m).filter((part) => /opencode/i.test(part))) {
      expect(section).toContain("https://opencode.ai/docs/mcp-servers");
      expect(section).toMatch(/Verified live on \S+ with /);
    }
  });

  test("puts no token in a URL and nothing shaped like a JWT", () => {
    expect(MCP_DOC).not.toMatch(/[?&](?:token|access_token)=/);
    expect(MCP_DOC).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });

  test("says a 2025 client's notifications/cancelled is ignored, and cancels only by closing the request", () => {
    expect(MCP_DOC).toContain("Studio honours a cancel only when the client closes the request.");
    expect(MCP_DOC).toContain("`notifications/cancelled`, sent in a `POST` of its own, gets 202 and is ignored");
    expect(MCP_DOC).toContain("| Engine | The client closes the request | `timeout_ms` passes |");
  });

  test("says what a cancel and a timeout do to a ClickHouse statement, as measured on 26.7", () => {
    expect(MCP_DOC).toContain(
      "| ClickHouse | Studio stops waiting; the statement runs on until its server-side `max_execution_time`, which is set to the time left rounded up to whole seconds, ends it | Studio closes the request at `timeout_ms`, ClickHouse cancels the statement, and the client gets the timeout answer |",
    );
  });

  test("says what a cancel and a timeout do to a libSQL statement, as measured on sqld 0.24.33", () => {
    expect(MCP_DOC).toContain(
      "| libSQL | Studio stops waiting; the statement runs on until the provider closes its request at the time left of `timeout_ms`, which stops it on sqld | Studio closes the request at `timeout_ms`, sqld stops the statement, and the client gets the timeout answer |",
    );
  });

  test("names how each engine run_read_query serves enforces read-only, from the one engine list", () => {
    const line = MCP_DOC.split("\n").find((text) => text.startsWith("- Read-only is the database's own enforcement"));
    for (const type of RUN_READ_QUERY_TYPES) expect(line).toContain(DB_UI_CONFIG[type].label);
  });

  test("docs/FEATURES.md names run_read_query's engines from the one engine list", () => {
    expect(read("docs/FEATURES.md")).toContain(
      `\`run_read_query\` on ${RUN_READ_QUERY_ENGINES}, \`run_kubectl_read\` on Kubernetes`,
    );
  });

  test("says which libSQL token a seed needs and that inspect_schema opens libSQL unproven", () => {
    expect(MCP_DOC).toContain(
      "`run_read_query` refuses a PostgreSQL, SQL Server, ClickHouse or libSQL connection whose own login could do more than read",
    );
    expect(MCP_DOC).toContain(
      "libSQL by a token proven at open to be read-only, which the server refuses every write ([libsql.md](./providers/libsql.md))",
    );
    expect(MCP_DOC).toContain(
      "libSQL proves its token only for a connection that sends statements, so `inspect_schema` opens a libSQL connection unproven, as the editor does, with a writable token or HTTP Basic too.",
    );
  });

  test("says an MCP call on a LibreDB file keeps the Studio editor out until its handle is idle for 30 minutes", () => {
    expect(MCP_DOC).toContain(
      "- An MCP call on a LibreDB connection that no Studio session holds open opens the file itself and keeps its exclusive lock until that handle has been idle for 30 minutes.",
    );
  });

  test("says run_read_query on PostgreSQL and SQL Server needs a least-privilege seed principal", () => {
    expect(MCP_DOC).toContain("On PostgreSQL the seed's role must not be a superuser");
    expect(MCP_DOC).toContain("and it must be granted `SHOWPLAN`");
    expect(MCP_DOC).toContain("A seed entry cannot carry a separate agent credential");
  });

  // #1462: inspect_schema acquires under agent-operations, which carries the same
  // readOnly: true execution context as run_read_query's agent-read-only, so the same
  // role check refuses a privileged login there too - it does not get a free pass.
  // MongoDB proves its principal only for a profile that sends statements (#1614).
  test("says inspect_schema needs the same least-privilege principal as run_read_query, not a free pass", () => {
    expect(MCP_DOC).toContain(
      "`inspect_schema` acquires its connection read-only too, under `agent-operations` where `run_read_query` takes `agent-read-only`, and on PostgreSQL and SQL Server both profiles verify the principal at open",
    );
    expect(MCP_DOC).not.toContain("`inspect_schema` has no such requirement");
    expect(MCP_DOC).toContain(
      "so `inspect_schema` opens a MongoDB connection unverified, as the editor does, and no principal check refuses it there (`tests/integration/mcp/inspect-schema.test.ts`",
    );
  });

  test("says npx resolves a relative path variable against the directory it is run from", () => {
    expect(MCP_DOC).toContain(
      "The launcher resolves a relative path variable, such as `SEED_CONFIG_PATH`, against the directory you run `npx` from",
    );
  });

  test("mounts a volume on /app/data in the Docker example and says what dies without it", () => {
    expect(MCP_DOC).toContain("  -v libredb-data:/app/data \\\n");
    expect(MCP_DOC).toContain(
      "without it, a new container generates a new `JWT_SECRET` and every MCP token stops verifying",
    );
  });

  test("says where a first start's admin credentials are shown and stored, and how an admin reaches the MCP screen", () => {
    expect(MCP_DOC).toContain("`admin@libredb.org`");
    expect(MCP_DOC).toContain("under npx in the terminal, under Docker in `docker logs`");
    expect(MCP_DOC).toContain("`auth-bootstrap.json`");
    expect(MCP_DOC).toContain("choose **Editor**, then the user menu at the top right, then **MCP**");
  });

  test("says a SQLite seed's database is a path on the machine running Studio", () => {
    expect(MCP_DOC).toContain("A SQLite seed's `database` is an absolute path on the machine running Studio");
  });

  test("says a static Authorization header is required, because phase 1 serves no OAuth metadata", () => {
    expect(MCP_DOC).toContain("a client needs its `Authorization` header configured");
  });
});
