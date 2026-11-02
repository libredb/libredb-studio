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

const ORACLE_CANCEL_ROW =
  "| Oracle | Studio stops waiting; the statement runs on until the driver's call timeout, set to the time left of `timeout_ms`, ends its session, which stops it | The driver's call timeout ends the statement's session at `timeout_ms`, Oracle stops the statement within two seconds, and the client gets the timeout answer |";
const ORACLE_BOUNDARY =
  "Oracle by a user set `ALTER USER ... READ ONLY`, which the server refuses every write, checked before every statement, on that statement's own session, to reach nothing READ ONLY leaves open and to read nothing of Oracle's own schemas beyond what `PUBLIC` may ([oracle.md](./providers/oracle.md))";
const ORACLE_SEED =
  "On Oracle (23ai and later) the seed's user must be a local user set `ALTER USER ... READ ONLY` that holds `CREATE SESSION`, `SELECT` on the tables to read and, granted by SYS, `SELECT` on `SYS.DBA_POLICIES` and `SYS.DBA_AUDIT_POLICIES`, and nothing more, as the check before each agent statement proves ([oracle.md](./providers/oracle.md) section 5.7).\n" +
  "The check runs before every statement, not at the open, so `run_read_query` answers its refusal in its own sentence and sends nothing: a user that is not READ ONLY, such as SYSTEM or the schema owner, one holding a system privilege beyond `CREATE SESSION` or a role carrying one, `CONNECT` and `DBA` included, `EXECUTE` on code that is not Oracle's, or any grant on a schema Oracle maintains beyond those two catalogs, such as `SELECT_CATALOG_ROLE` or `AUDIT_VIEWER`, and any user while the database holds a database link or a row-level security or fine-grained auditing policy that runs code that is not Oracle's.\n" +
  "A grant added between two calls refuses the next call, and a lifted one admits it.";
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
      "A `SELECT` runs on every engine it serves; a refused statement's answer names what else that engine takes.",
    );
    expect(MCP_DOC).not.toContain("A `SELECT` (a `WITH` is fine) runs on every engine it serves");
    expect(MCP_DOC).toContain("`MCP_STATEMENT_READ`");
  });

  test("names each served engine's statement forms from its READ_QUERY_FORMS row, and no other engine's", () => {
    // One line per engine, in the row's own words; backticks are the doc's markup, not part of the claim.
    const lines = MCP_DOC.split("\n")
      .map((line) => line.replaceAll("`", ""))
      .filter((line) => /^ {4}- .+: a SELECT\b/.test(line));
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

  test("says what a cancel and a timeout do to an InfluxDB 3 statement, as measured on 3.12.0 Core", () => {
    expect(MCP_DOC).toContain(
      "| InfluxDB 3 (SQL) | Studio stops waiting; the statement runs on until the provider closes its request at the time left of `timeout_ms`, which stops it on InfluxDB 3 Core | Studio closes the request at `timeout_ms`, InfluxDB 3 Core stops the statement, and the client gets the timeout answer |",
    );
  });

  test("says what InfluxDB 3 needs of a seed and that inspect_schema opens it on any 3.x server", () => {
    expect(MCP_DOC).toContain(
      "InfluxDB 3 (SQL) by the 3.12 Core planner, which refuses every write, DDL, `COPY`, `SET` and transaction statement whatever the token, on a server checked at open to be that line ([influxdb3.md](./providers/influxdb3.md))",
    );
    expect(MCP_DOC).toContain(
      "On InfluxDB 3 (SQL) every Core token is an admin token, so no seed token is least-privilege and none is asked for: `run_read_query` refuses instead a server that is not InfluxDB 3 Core on the 3.12 line, whose planner's write refusals were captured, as the open does for agent mode ([influxdb3.md](./providers/influxdb3.md) section 3.5).",
    );
    expect(MCP_DOC).toContain(
      "InfluxDB 3 checks its server's line only for a connection that sends statements, so `inspect_schema` opens an InfluxDB 3 connection on any 3.x server, as the editor does.",
    );
  });

  test("says what a cancel and a timeout do to a Couchbase statement, as measured on 8.0.2 Enterprise", () => {
    expect(MCP_DOC).toContain(
      "| Couchbase | Studio stops waiting; the statement runs on until the provider closes its request at the time left of `timeout_ms`, which stops it on the query service | Studio closes the request at `timeout_ms` and the query service, whose own timeout is set to the time left, stops the statement, and the client gets the timeout answer |",
    );
  });

  test("says what Couchbase needs of a seed, how it enforces read-only, and that inspect_schema opens it unchecked", () => {
    expect(MCP_DOC).toContain(
      "Couchbase by a user whose only roles are `query_select` on named scopes of the connection's bucket, checked at open and again before every statement on a server proven to refuse that user a write, behind the provider's fence that sends one `SELECT` ([couchbase.md](./providers/couchbase.md))",
    );
    expect(MCP_DOC).toContain(
      "On Couchbase the seed's user must hold no role but `query_select` on named scopes of the seed's bucket (`query_select[<bucket>:<scope>]`, one for each scope it reads), never on every scope or on the bucket's `_system` scope, counting the roles of its groups, on a server that refuses that user a write, as the check proves at open and before every statement for agent mode ([couchbase.md](./providers/couchbase.md) section 15.7): the administrator, `ro_admin`, `query_system_catalog`, `data_reader`, a role on another bucket, a group that grants a writing role and every Community Edition user are refused.",
    );
    expect(MCP_DOC).toContain(
      "Couchbase checks its user only for a connection that sends statements, so `inspect_schema` opens a Couchbase connection unchecked, as the editor does, with the administrator too.",
    );
  });

  test("says what a cancel and a timeout do to an Elasticsearch statement, as measured on 9.1.4", () => {
    expect(MCP_DOC).toContain(
      "| Elasticsearch | Studio stops waiting, and the provider closes its request at the time left of `timeout_ms`; the cluster runs the statement to its end, and holds no search context for it once it ends | Studio closes the request at `timeout_ms`, the cluster runs the statement to its end and then holds no search context for it, and the client gets the timeout answer |",
    );
  });

  // The login check narrows the login and cannot refuse every login that may read a restricted index, so the doc names
  // the statement check as the boundary for hidden and system indices, and claims no more of the login check.
  test("says what Elasticsearch needs of a seed, that a broad login is refused at open, what the boundary is, and how it pages without OFFSET", () => {
    expect(MCP_DOC).toContain(
      "Elasticsearch by the grammar of its SQL endpoint, which holds no write, DDL or transaction statement, on a server checked at open to be the 9.1 release line whose refusals were captured, with a login narrowed at open, when security is on, to hold no cluster privilege `all` and no broad reach over the restricted system indices, while hidden and system indices are kept from each statement by the provider's statement check ([elasticsearch.md](./providers/elasticsearch.md))",
    );
    expect(MCP_DOC).toContain(
      "On Elasticsearch with security on, the open asks the server what the seed's login may do and lists its privileges, and refuses, before any statement runs, a login that holds the cluster privilege `all`, reads the restricted system indices it asks about, or is listed with an index privilege granted with `allow_restricted_indices`, on this cluster or a remote one, so a seed signed in as a superuser is refused; that check cannot name every restricted index, and the server lists no privileges for an API key with role descriptors of its own, so it does not refuse every login that may read one.\n" +
        "The provider sends no run-as header, so every request runs as the seed's own login, and a `run_as` privilege in its role does not widen what `run_read_query` reads.\n" +
        "With security on or off, the boundary is the provider's statement check: it reads each statement before sending it, refusing one it cannot read with certainty and one whose index expression holds an exclusion or a name that starts with a dot, and asks the server what its index resolves to, in the server's own index resolution and in the one the SQL endpoint makes, refusing a statement whose index resolves to a hidden or system index, alias or data stream, or which the two resolutions do not resolve alike.\n" +
        "`run_read_query` needs the cluster action `cluster:monitor/main` and `read` and `view_index_metadata` on the indices to read, and `inspect_schema` also the cluster privileges `monitor` and `read_pipeline` and the index privilege `monitor`, which is the `libredb_seed_read` role of [elasticsearch.md](./providers/elasticsearch.md) section 5.9, so opt in a seed signed in with that role.",
    );
    expect(MCP_DOC).not.toContain("reads no restricted system index");
    expect(MCP_DOC).not.toContain("read no restricted system index");
    expect(MCP_DOC).toContain(
      "Elasticsearch checks its server's release and its login only for a connection that sends statements, so `inspect_schema` opens an Elasticsearch connection on any release, as the editor does.",
    );
    expect(MCP_DOC).toContain(
      "Elasticsearch SQL has no `OFFSET`, so there `pagination.nextOffset` is always `null`, an `offset` is refused before anything is sent, and the answer says to page by key instead: `ORDER BY` a unique field, and for the next page add `WHERE` that field `>` the last value read.",
    );
  });

  test("says what a cancel and a timeout do to an OpenSearch statement, as measured on 3.8.0", () => {
    expect(MCP_DOC).toContain(
      "| OpenSearch | Studio stops waiting, and the provider closes its request at the time left of `timeout_ms`; the cluster runs the search to its end, and holds no search context for it once it ends | Studio closes the request at `timeout_ms`, the cluster runs the search to its end and then holds no search context for it, and the client gets the timeout answer |",
    );
  });

  // The login probes narrow the login; the statement check keeps hidden, dot-led and plugin-owned indices from a statement.
  test("says what OpenSearch needs of a seed, that a broad login is refused at open, and what the boundary is", () => {
    expect(MCP_DOC).toContain(
      "OpenSearch by its SQL plugin, which refuses every write and DDL statement, on a server whose `DELETE` setting is proved off and whose 3.8 release line is checked at open, with a login probed at open, when security is on, for access to the security plugin's REST API and for a delete by query and an index close on a fresh index name, which narrows the login while the statement check and the plugin refuse every write whatever it is, and with hidden and dot-led indices and the indices the bundled plugins write into kept from each statement by the provider's statement check ([opensearch.md](./providers/opensearch.md))",
    );
    expect(MCP_DOC).toContain(
      "On OpenSearch with security on, the open asks the security plugin whether the seed's login may call its REST API and probes a document delete by query and an index close on a fresh index name, and refuses, before any statement runs, a login the plugin lets do any of the three, so a seed signed in as `admin` is refused.\n" +
        "The probes show only that: a role granting writes on a pattern the fresh name does not match, or only granular write, create, delete or alias actions, passes them, and the statement check and the plugin refuse every write it sends, so the boundary is not the login.\n" +
        "With security on or off, hidden and dot-led indices and the indices the bundled plugins write into, such as `top_queries-*` and `security-auditlog-*`, are kept from each statement by the provider's statement check, which reads the statement before sending it and asks the server what its one index expression resolves to, in its own index resolution and in the field capabilities request that names the indices the SQL plugin reads.\n" +
        "`run_read_query` needs the cluster actions `cluster:monitor/main` and `cluster:monitor/state` and, on the indices to read, `read`, `indices:admin/mappings/get` and `indices:monitor/settings/get`, and `inspect_schema` also the cluster actions `cluster:monitor/health`, `cluster:admin/ingest/pipeline/get` and `indices:admin/index_template/get` and five index actions on every index, which is the `libredb_seed_read` role of [opensearch.md](./providers/opensearch.md) section 5.9, so opt in a seed signed in with that role.",
    );
    expect(MCP_DOC).toContain(
      "OpenSearch proves its `DELETE` off, checks its server's release and probes its login only for a connection that sends statements, so `inspect_schema` opens an OpenSearch connection on any release and with any login, as the editor does.",
    );
  });

  test("says what a cancel and a timeout do to an Apache Cassandra statement, as measured on 5.0.9", () => {
    expect(MCP_DOC).toContain(
      "| Apache Cassandra | Studio stops waiting; the native protocol has no cancel, so the coordinator runs the statement to its end, and the provider closes the call's session when the answer arrives or at the time left of `timeout_ms` | The driver's read timeout, set to the time left, ends the wait and the provider closes the call's session; the coordinator runs the statement to its end, and the client gets the timeout answer |",
    );
  });

  // A seed carries no agent user, so the seed's own role is the one checked, and the provider's read scope is part of
  // the boundary the doc names.
  test("says what Apache Cassandra needs of a seed, what the boundary is, that inspect_schema opens it unchecked, and how it pages without OFFSET", () => {
    expect(MCP_DOC).toContain(
      "Apache Cassandra by a role checked at open and again before every statement, on that statement's own session, to be no superuser and to hold only `SELECT` on the connection's keyspace, on an Apache Cassandra 5.0 server that enforces its grants, while the provider sends one `SELECT` of a table of that keyspace or of `system_schema` and nothing else ([cassandra.md](./providers/cassandra.md))",
    );
    expect(MCP_DOC).toContain(
      "On Apache Cassandra the seed must name its keyspace as `database`, a keyspace of the user's data, since a seed bound to one of Cassandra's own keyspaces (`system`, `system_auth`, `system_traces` and the rest) is refused at open whatever its role holds, and its `user` must be a role that is no superuser, holds no superuser role, and holds only `SELECT` on that keyspace or on tables of it, directly or through roles granted to it, with no column of the keyspace masked by a function outside the `system` keyspace, on an Apache Cassandra 5.0 server with `PasswordAuthenticator` and `CassandraAuthorizer`, as the check proves for agent mode ([cassandra.md](./providers/cassandra.md) section 14.2): the image's default `cassandra` superuser is refused, and so is a role holding `MODIFY`, `EXECUTE`, `UNMASK` or `DESCRIBE`, or `SELECT` on every keyspace, a node on `AllowAllAuthorizer`, and ScyllaDB.",
    );
    expect(MCP_DOC).toContain(
      "Apache Cassandra checks its role only for a connection that sends statements, so `inspect_schema` opens an Apache Cassandra connection unproven, as the editor does, with a superuser too.",
    );
    expect(MCP_DOC).toContain(
      "CQL has no `OFFSET` either, so on Apache Cassandra `pagination.nextOffset` is always `null`, an `offset` is refused before anything is sent, and the answer says how to page without one: keep a `LIMIT`, and for the next page add `WHERE token(<partition key>) > token(<the last one read>)`, or within one partition `WHERE <clustering column> > <the last value read>`.",
    );
    const doc = read("docs/providers/cassandra.md");
    expect(doc).toContain(
      "A `SELECT` without its own `LIMIT` is cut at `max_rows` (100 by default, at most 500), and `pagination.hasMore` says more rows exist; a query whose own `LIMIT` is past 1000 rows, or a result past 1 MiB, is refused, never cut.",
    );
    expect(doc).toContain("a read with its own `LIMIT` past 1000 rows, and a result past 1 MiB, is refused, never cut");
  });

  test("says what a cancel and a timeout do to an Oracle statement, as measured on 26ai Free 23.26.3", () => {
    expect(MCP_DOC).toContain(ORACLE_CANCEL_ROW);
    expect(read("docs/BACKLOG.md")).toContain(
      "and on Oracle until the driver's call timeout, set to the time left, ends the statement's session",
    );
  });

  // Oracle proves its user before every statement, not at the open, and its data scope is the user's grants: the doc
  // names the user a seed needs, what is refused in the tool's own sentence, and when the check runs.
  test("says what Oracle needs of a seed, what is refused and when, and that inspect_schema opens it unchecked", () => {
    expect(MCP_DOC).toContain(ORACLE_BOUNDARY);
    expect(MCP_DOC).toContain(ORACLE_SEED);
    expect(MCP_DOC).toContain(
      "Oracle checks its user only on a call that sends a statement, so `inspect_schema` opens an Oracle connection unchecked, as the editor does, and lists what the seed's user may see in the `ALL_*` views.",
    );
    expect(MCP_DOC).toContain("    - Oracle: a `SELECT` (a `WITH` is fine).");
  });

  // run_read_query pages a SELECT with no LIMIT of its own at max_rows; only a LIMIT of its own past the 1000-row
  // provider budget reaches the refusal, so no provider doc may say every result past 1000 rows is refused.
  test.each([
    "docs/providers/clickhouse.md",
    "docs/providers/libsql.md",
    "docs/providers/influxdb3.md",
    "docs/providers/opensearch.md",
    "docs/providers/couchbase.md",
  ])("%s says run_read_query pages a SELECT without its own LIMIT and refuses only a LIMIT past 1000", (doc) => {
    const text = read(doc);
    expect(text).toContain(
      "A `SELECT` without its own `LIMIT` is paged at `max_rows` (100 by default, at most 500), and `pagination.hasMore` and `pagination.nextOffset` say where the next page starts; a query whose own `LIMIT` is past 1000 rows, or a result past 1 MiB, is refused, never cut.",
    );
    expect(text).not.toContain("A result past 1000 rows or 1 MiB is refused");
    expect(text).toContain("read with its own `LIMIT` past 1000 rows");
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
      "`run_read_query` refuses a PostgreSQL, SQL Server, ClickHouse, libSQL, Oracle, Apache Cassandra or Couchbase connection whose own login could do more than read",
    );
    expect(MCP_DOC).toContain(
      "libSQL by a token proven at open to be read-only, which the server refuses every write ([libsql.md](./providers/libsql.md))",
    );
    expect(MCP_DOC).toContain(
      "libSQL proves its token only for a connection that sends statements, so `inspect_schema` opens a libSQL connection unproven, as the editor does, with a writable token or HTTP Basic too.",
    );
  });

  // Measured on Db2 12.1.0.0 through run_read_query: neither a timeout nor a client close stops the statement on the
  // server, which runs to its end; the user is checked before every statement, and inspect_schema checks none.
  test("says what a Db2 seed needs, that inspect_schema opens it unchecked, and what a cancel and a timeout do", () => {
    expect(MCP_DOC).toContain(
      "`run_read_query` refuses a Db2 LUW connection whose own user could do more than read, checked before every statement rather than at the open, so an opted-in Db2 seed needs a least-privilege user too.",
    );
    expect(MCP_DOC).toContain(
      "Db2 LUW checks its user only before a statement it sends, so `inspect_schema` opens a Db2 connection unchecked, as the editor does.",
    );
    expect(MCP_DOC).toContain(
      "| Db2 LUW | Studio stops waiting; the statement runs on the server to its end, and the provider closes its connection once it has ended | Studio stops waiting at `timeout_ms`, the statement runs on the server to its end, and the client gets the timeout answer |",
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
