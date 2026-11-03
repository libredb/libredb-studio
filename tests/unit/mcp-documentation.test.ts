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
import { DB_UI_CONFIG, getDBConfig } from "@/lib/db-ui-config";
import { namedList } from "@/lib/agent/engine-support";
import { mcpClientConfigs } from "@/lib/mcp/client-config";
import { RUN_READ_QUERY_TYPES } from "../helpers/run-read-query";
import { registeredMcpToolNames } from "../helpers/mcp-tool-names";
import { namedLabels } from "../helpers/repo-text-scope";
import { mcpStatementToolFor, servingStatementArms } from "@/lib/mcp/tools/statement-arms";
import type { DatabaseType } from "@/lib/types";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const MCP_DOC = read("docs/MCP.md");
const labelOf = (type: DatabaseType): string => getDBConfig(type).label;

/** The labels of every engine a statement tool this build registers serves: the set each per-engine list must cover. */
const servedLabels = (): string[] => [...new Set(servingStatementArms().flatMap((arm) => arm.types))].map(labelOf);

/** The engine lines under "Read-only is the database's own enforcement", one bullet per engine, label first. */
const boundaryBullets = (): string[] => {
  const lines = MCP_DOC.split("\n");
  const start = lines.findIndex((line) => line.startsWith("- Read-only is the database's own enforcement"));
  const bullets: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  - ")) break;
    bullets.push(line);
  }
  return bullets;
};
const boundaryLabels = (): string[] => boundaryBullets().map((line) => line.slice(4, line.indexOf(": ")));
const boundaryLine = (label: string): string | undefined =>
  boundaryBullets().find((line) => line.startsWith(`  - ${label}: `));

/** The cancel table's rows, header and separator left out. */
const cancelRows = (): string[] => {
  const lines = MCP_DOC.split("\n");
  const header = lines.indexOf("| Engine | The client closes the request | `timeout_ms` passes |");
  const rows: string[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("| ")) break;
    rows.push(line);
  }
  return rows;
};
const cancelLabels = (): string[] => cancelRows().map((row) => row.slice(2, row.indexOf(" | ")));
const cancelRow = (label: string): string | undefined => cancelRows().find((row) => row.startsWith(`| ${label} | `));

const ORACLE_CANCEL_ROW =
  "| Oracle | Studio stops waiting; the statement runs on until the driver's call timeout, set to the time left of `timeout_ms`, ends its session, which stops it | The driver's call timeout ends the statement's session at `timeout_ms`, Oracle stops the statement within two seconds, and the client gets the timeout answer (measured on 26ai Free 23.26.3 on 2026-11-02) |";
const ORACLE_BOUNDARY =
  "  - Oracle: by a user set `ALTER USER ... READ ONLY`, which the server refuses every write, checked before every statement, on that statement's own session, to reach nothing READ ONLY leaves open and to read nothing of Oracle's own schemas beyond what `PUBLIC` may, and refuses a login that could do more than read ([oracle.md](./providers/oracle.md)).";
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
      "a language's MCP words belong to its facet (`src/lib/agent/languages/<statement-language>/mcp.ts`, registered in `AGENT_LANGUAGE_MCP_FACETS`)",
    );
  });
});

describe("docs/MCP.md", () => {
  test("says run_read_query runs on the engines its forms list names, and points elsewhere for the rest", () => {
    expect(MCP_DOC).toContain(
      "Runs on the engines listed below with the forms each takes; other engines refuse it, and list_connections' read_tool names the tool that reads each connection.",
    );
  });

  // The doc's own single-engine sentence, held to the labels of the engines each arm serves.
  test.each(
    servingStatementArms()
      .filter((arm) => arm.tool !== "run_read_query")
      .map((arm) => [arm.tool, arm] as const),
  )("carries %s's engine sentence, named from the engines it serves", (_tool, arm) => {
    expect(MCP_DOC).toContain(`Runs on ${namedList(arm.types.map(labelOf))}; other engines refuse it.`);
  });

  test("names every tool this build registers", () => {
    for (const tool of registeredMcpToolNames()) expect(MCP_DOC).toMatch(new RegExp(`^ {2}- \`${tool}\` `, "m"));
  });

  test("states no count of tools", () => {
    expect(MCP_DOC).toContain("- The tools, each annotated read-only and closed-world:");
  });

  test("carries the read_tool field", () => {
    expect(MCP_DOC).toContain("`read_tool`");
    expect(MCP_DOC).not.toContain("B117");
  });

  test("carries run_qdrant_read's seed key, its proof's cost and its cancel row", () => {
    expect(MCP_DOC).toContain(
      "On Qdrant the seed's `password` must be the server's read-only API key or a JWT whose access is `r`, globally or on the collections the client should read",
    );
    expect(MCP_DOC).toContain(
      "The proof runs before every call, so a key listing N collections costs N + 3 requests per call, N + 4 more on the call that opens the connection.",
    );
    expect(MCP_DOC).toContain(
      "| Qdrant | Studio stops waiting; the provider keeps its request open until its own deadline, set to the time left of `timeout_ms`, closes it | The provider closes its request at `timeout_ms`, and the client gets the timeout answer (measured on 1.19.1 on 2026-11-02 through a proxy that held the request: closed 502 ms after a 500 ms `timeout_ms`, and 3001 ms after a request with a 3000 ms `timeout_ms` cancelled at 200 ms) |",
    );
  });

  test("carries run_milvus_read's seed's user, its data scope and its cancel row", () => {
    expect(MCP_DOC).toContain("A Milvus seed's user must be one `run_milvus_read` proves read-only before every read");
    expect(MCP_DOC).toContain("a call naming a collection is sent only when the user's `ShowCollections` lists it");
    expect(MCP_DOC).toContain("database, partition and function names reach MCP through it");
    expect(MCP_DOC).toMatch(/^\| Milvus \| /m);
  });

  test("carries run_etcd_read's seed user, its proof's cost, inspect_schema's page and its cancel row", () => {
    expect(MCP_DOC).toContain(
      "unless authentication is on and the seed's `user` holds no root role and roles that grant READ only, on the prefixes the client should read",
    );
    expect(MCP_DOC).toContain(
      "An etcd seed with `mcp: true` whose `user` is `root` is refused when the seed file loads.",
    );
    expect(MCP_DOC).toContain(
      "The proof runs before every call, so a user holding N roles costs N + 2 requests per call before the read.",
    );
    expect(MCP_DOC).toContain("On etcd it lists no key prefix and answers an empty page");
    expect(MCP_DOC).toContain(
      "| etcd | Studio stops waiting; the provider's gRPC call stays open until its own deadline, set to the time left of `timeout_ms`, cancels it | The provider cancels its gRPC call at `timeout_ms`, and the client gets the timeout answer |",
    );
  });

  test("carries run_mqtt_read's and run_sparkplug_read's seeds, notes and inspect_schema answers", () => {
    expect(MCP_DOC).toContain("An MQTT seed's `user` is never proven read-only");
    expect(MCP_DOC).toContain("a retained topic outside its ACL answers exactly as a topic that does not exist");
    expect(MCP_DOC).toContain("A Sparkplug B seed carries no credential");
    expect(MCP_DOC).toContain("On MQTT it refuses the call the same way, naming `run_mqtt_read`");
    expect(MCP_DOC).toContain("On Sparkplug B it lists no group, edge node or device and answers an empty page");
    expect(MCP_DOC).toContain("`timeout_ms` must be at least 5000");
    expect(MCP_DOC).toContain("which then reach the client as the answer's `notes`");
  });

  // Measured through /api/mcp: only the call that opens the connection runs the handshake; a later call reuses the
  // acquisition the factory keeps for 30 idle minutes and opens the read's session alone.
  test.each(["docs/MCP.md", "docs/providers/mqtt.md", "docs/providers/sparkplug.md"])(
    "%s counts two broker sessions on the call that opens the connection and one on a later call",
    (doc) => {
      const text = read(doc);
      expect(text).toContain("The call that opens the connection opens two broker sessions");
      expect(text).toContain("A later call on the same connection reuses that acquisition");
      expect(text).not.toContain("A call opens two broker sessions");
    },
  );

  // Measured through /api/mcp: a broker that accepts TCP and never sends CONNACK is given up when the handshake's own
  // 3-second window ends, whatever timeout_ms is, and answered as an engine error, not the timeout answer.
  test.each(["MQTT", "Sparkplug B"])("the %s cancel row says a broker that sends no CONNACK ends at about 3 s as an engine error", (label) => {
    const row = MCP_DOC.split("\n").find((line) => line.startsWith(`| ${label} | `));
    expect(row).toContain("never sends a CONNACK is given up at about 3 s whatever `timeout_ms` is");
    expect(row).toContain("an engine error saying no CONNACK arrived, not the timeout answer");
    expect(row).not.toContain("given up at the time left");
  });

  test("says inspect_schema refuses Kubernetes", () => {
    expect(MCP_DOC).toContain(
      "On Kubernetes it refuses the call by name, because no Kubernetes kind is a table: the refusal names `run_kubectl_read`, which reads its objects, and is answered as soon as the connection resolves, before anything is acquired.",
    );
    expect(MCP_DOC).not.toContain("On Kubernetes it lists no table");
    expect(MCP_DOC).not.toContain("B105");
  });

  test("carries run_kafka_read's withheld topics and the seed's login", () => {
    expect(MCP_DOC).toContain("are withheld from every listing, as they are in agent mode and in `inspect_schema`");
    expect(MCP_DOC).toContain(
      "A Kafka seed needs no least-privilege principal and none is proven, since the agent's client can send no write whatever the login may do",
    );
    expect(MCP_DOC).toMatch(/^\| Apache Kafka \| /m);
  });

  test("carries what run_rabbitmq_read withholds and its cancel row", () => {
    expect(MCP_DOC).toContain(
      "Its answer is the agent's metadata-only projection: each message's offset and body size, and never a message's body, headers, properties or routing key.",
    );
    expect(MCP_DOC).toMatch(/^\| RabbitMQ \| Studio stops waiting; /m);
    const cancelRow = MCP_DOC.split("\n").find((text) => text.startsWith("| RabbitMQ | Studio stops waiting; "));
    expect(cancelRow).toContain(
      "until then the read keeps the seed's one read slot, so a later call on that seed waits for it, and one whose `timeout_ms` ends first is answered as the timeout",
    );
    expect(MCP_DOC).toContain(
      "An answer carries no warning text: a read that stops before its `limit` because no message arrived for 1 s answers the messages it read, which is not proof of the stream's end, and a read from `next` answers only messages published after the read starts, and the tool's description says both.",
    );
    expect(boundaryLine("RabbitMQ")).toContain("by Studio's read client");
  });

  test("carries run_libredb_read's data scope and its cancel row", () => {
    expect(MCP_DOC).toContain(
      "Each command opens the seed's file read-only, on a handle of its own that takes no lock and cannot write",
    );
    expect(MCP_DOC).toContain(
      "Studio's own storage database, its `-wal` and `-shm` files and its `auth-bootstrap.json` are refused as a LibreDB target before anything is opened",
    );
    expect(MCP_DOC).toMatch(/^\| LibreDB \| The read runs on the Studio server's own thread /m);
    expect(boundaryLine("LibreDB")).toContain("by a read-only handle opened for each command");
    expect(MCP_DOC).not.toContain("B152");
    // The result limit measures the whole tool result, which carries every row twice, so a value of half of it fails.
    expect(MCP_DOC).toContain(
      "since that limit measures the whole tool result, which carries every row twice, once in its text block and once in `structuredContent`, a value of about 16 KiB is already refused.",
    );
    expect(MCP_DOC).not.toContain("a value larger than the 32 KiB result limit is refused whole");
  });

  test("carries the seed run_redis_read needs, inspect_schema's unproven open and its cancel row", () => {
    expect(MCP_DOC).toMatch(/^ {2}- `run_redis_read` runs one read-only Redis metadata read/m);
    expect(MCP_DOC).toContain(
      "A Redis seed's `user` must be an ACL user of its own, never `default`, that the server refuses every write probe as a command it does not hold, such as `on`, a password, `~*` and `+@read`",
    );
    expect(MCP_DOC).toContain(
      "Redis proves its ACL user only for a connection that sends statements, so `inspect_schema` opens a Redis connection unproven, as the editor does, with any user, `default` and a `+@read` reader included, and lists the leading segment of each key grouping (`user:*`), never a full key name and never a function library.",
    );
    expect(MCP_DOC).toContain("a user refused `CONFIG GET` is listed its session database alone");
    expect(MCP_DOC).toMatch(/^\| Redis \| .*after which the connection is closed and never reopened, /m);
    expect(MCP_DOC).toMatch(/^\| Redis \| Studio stops waiting; /m);
  });

  test("states run_redis_read's waits, its seed's SELECT and its keymiss reads as the code and the capture have them", () => {
    // `openClient` sends SELECT for a database other than 0, which @read does not hold, under the call's time left;
    // the TCP connect waits for the provider's query timeout instead.
    expect(MCP_DOC).toContain("a seed that names a database other than 0 also needs `+select`");
    const row = MCP_DOC.split("\n").find((line) => line.startsWith("| Redis | Studio stops waiting; "));
    expect(row).toContain(
      "the sign-in, the `SELECT` of a database other than 0, the proof's round trip and the command",
    );
    expect(row).toContain("the provider's query timeout");
    expect(row).not.toContain("three times");
    // tests/fixtures/redis/<version>/agent-boundary/notifications.json: every key read of the table but these two.
    expect(MCP_DOC).toContain(
      "every key read of the table but `OBJECT ENCODING` and `MEMORY USAGE` publishes a `keymiss` event naming that key",
    );
  });

  test("says which Weaviate names each tool returns", () => {
    expect(MCP_DOC).toContain(
      "On Weaviate it lists each collection's declared properties and vectors and never its tenants or aliases, which `run_weaviate_read` reads as far as the key's grants reach; it reads no stored object, so a vector's dimension, which the schema does not declare, reads `?`, and a call wakes no tenant.",
    );
    expect(MCP_DOC).toContain(
      "a name in a collection's place is sent only when the key's own collection or alias list holds it, and an alias as the collection its list entry names, because the server reads an alias there as whatever collection it names when the request arrives, and a name that does not exist and one outside the grants are one answer",
    );
    expect(MCP_DOC).not.toContain("a collection's tenants and aliases are never returned");
    expect(MCP_DOC).toContain(
      "a verbose node read names the collections on each node and neither names nor counts their shards",
    );
    expect(MCP_DOC).not.toContain("counts each collection's shards");
  });

  test("carries run_mtconnect_read's row in the cancel table", () => {
    expect(MCP_DOC).toMatch(/^\| MTConnect \| /m);
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

  test("names the engines MCP is not offered for once, from MCP_EXPOSABLE, and points inspect_schema at that list (#1089 E12)", () => {
    const refused = SHIPPED_DATABASE_TYPES.filter((type) => !MCP_EXPOSABLE[type]).map(labelOf);
    expect(refused).not.toEqual([]);
    const names = namedList(refused);
    expect(MCP_DOC).toContain(`It works for every engine but ${names}, whose connections the seed file cannot opt in.`);
    expect(MCP_DOC.split(names)).toHaveLength(2);
    expect(MCP_DOC).toContain(
      "It works on the same engines as `list_connections`: it lists every object kind the engine reads rows from",
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
      "| libSQL | Studio stops waiting; the statement runs on until the provider closes its request at the time left of `timeout_ms`, which stops it on sqld | Studio closes the request at `timeout_ms`, sqld stops the statement, and the client gets the timeout answer (measured on sqld 0.24.33 on 2026-11-01) |",
    );
  });

  test("says what a cancel and a timeout do to an InfluxDB 3 statement, as measured on 3.12.0 Core", () => {
    expect(MCP_DOC).toContain(
      "| InfluxDB 3 (SQL) | Studio stops waiting; the statement runs on until the provider closes its request at the time left of `timeout_ms`, which stops it on InfluxDB 3 Core | Studio closes the request at `timeout_ms`, InfluxDB 3 Core stops the statement, and the client gets the timeout answer (measured on 3.12.0 Core on 2026-11-01) |",
    );
  });

  test("says what InfluxDB 3 needs of a seed and that inspect_schema opens it on any 3.x server", () => {
    expect(MCP_DOC).toContain(
      "  - InfluxDB 3 (SQL): by the 3.12 Core planner, which refuses every write, DDL, `COPY`, `SET` and transaction statement whatever the token, on a server checked at open to be that line ([influxdb3.md](./providers/influxdb3.md))",
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
      "| Couchbase | Studio stops waiting; the statement runs on until the provider closes its request at the time left of `timeout_ms`, which stops it on the query service | Studio closes the request at `timeout_ms` and the query service, whose own timeout is set to the time left, stops the statement, and the client gets the timeout answer (measured on Couchbase Server 8.0.2 Enterprise on 2026-11-02) |",
    );
  });

  test("says what Couchbase needs of a seed, how it enforces read-only, and that inspect_schema opens it unchecked", () => {
    expect(MCP_DOC).toContain(
      "  - Couchbase: by a user whose only roles are `query_select` on named scopes of the connection's bucket, checked at open and again before every statement on a server proven to refuse that user a write, behind the provider's fence that sends one `SELECT`, and refuses a login that could do more than read ([couchbase.md](./providers/couchbase.md)).",
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
      "| Elasticsearch | Studio stops waiting, and the provider closes its request at the time left of `timeout_ms`; the cluster runs the statement to its end, and holds no search context for it once it ends | Studio closes the request at `timeout_ms`, the cluster runs the statement to its end and then holds no search context for it, and the client gets the timeout answer (measured on 9.1.4 on 2026-11-01) |",
    );
  });

  // The login check narrows the login and cannot refuse every login that may read a restricted index, so the doc names
  // the statement check as the boundary for hidden and system indices, and claims no more of the login check.
  test("says what Elasticsearch needs of a seed, that a broad login is refused at open, what the boundary is, and how it pages without OFFSET", () => {
    expect(MCP_DOC).toContain(
      "  - Elasticsearch: by the grammar of its SQL endpoint, which holds no write, DDL or transaction statement, on a server checked at open to be the 9.1 release line whose refusals were captured, with a login narrowed at open, when security is on, to hold no cluster privilege `all` and no broad reach over the restricted system indices, while hidden and system indices are kept from each statement by the provider's statement check ([elasticsearch.md](./providers/elasticsearch.md))",
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
      "| OpenSearch | Studio stops waiting, and the provider closes its request at the time left of `timeout_ms`; the cluster runs the search to its end, and holds no search context for it once it ends | Studio closes the request at `timeout_ms`, the cluster runs the search to its end and then holds no search context for it, and the client gets the timeout answer (measured on 3.8.0 on 2026-11-02) |",
    );
  });

  // The login probes narrow the login; the statement check keeps hidden, dot-led and plugin-owned indices from a statement.
  test("says what OpenSearch needs of a seed, that a broad login is refused at open, and what the boundary is", () => {
    expect(MCP_DOC).toContain(
      "  - OpenSearch: by its SQL plugin, which refuses every write and DDL statement, on a server whose `DELETE` setting is proved off and whose 3.8 release line is checked at open, with a login probed at open, when security is on, for access to the security plugin's REST API and for a delete by query and an index close on a fresh index name, which narrows the login while the statement check and the plugin refuse every write whatever it is, and with hidden and dot-led indices and the indices the bundled plugins write into kept from each statement by the provider's statement check ([opensearch.md](./providers/opensearch.md))",
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
      "| Apache Cassandra | Studio stops waiting; the native protocol has no cancel, so the coordinator runs the statement to its end, and the provider closes the call's session when the answer arrives or at the time left of `timeout_ms` | The driver's read timeout, set to the time left, ends the wait and the provider closes the call's session; the coordinator runs the statement to its end, and the client gets the timeout answer (measured on 5.0.9 on 2026-11-02, where over three runs `system_views.queries` listed a filtered count for 875 to 4638 ms past the timeout answer and 721 to 1875 ms past a cancel) |",
    );
  });

  // A seed carries no agent user, so the seed's own role is the one checked, and the provider's read scope is part of
  // the boundary the doc names.
  test("says what Apache Cassandra needs of a seed, what the boundary is, that inspect_schema opens it unchecked, and how it pages without OFFSET", () => {
    expect(MCP_DOC).toContain(
      "  - Apache Cassandra: by a role checked at open and again before every statement, on that statement's own session, to be no superuser and to hold only `SELECT` on the connection's keyspace, on an Apache Cassandra 5.0 server that enforces its grants, while the provider sends one `SELECT` of a table of that keyspace or of `system_schema` and nothing else, and refuses a login that could do more than read ([cassandra.md](./providers/cassandra.md)).",
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
    expect(cancelRow("Oracle")).toContain("(measured on 26ai Free 23.26.3 on 2026-11-02)");
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
  ])(
    "%s, one of the provider docs that describe paging, says run_read_query pages a SELECT without its own LIMIT and refuses only a LIMIT past 1000",
    (doc) => {
      const text = read(doc);
      expect(text).toContain(
        "A `SELECT` without its own `LIMIT` is paged at `max_rows` (100 by default, at most 500), and `pagination.hasMore` and `pagination.nextOffset` say where the next page starts; a query whose own `LIMIT` is past 1000 rows, or a result past 1 MiB, is refused, never cut.",
      );
      expect(text).not.toContain("A result past 1000 rows or 1 MiB is refused");
      expect(text).toContain("read with its own `LIMIT` past 1000 rows");
    },
  );

  test("says how each engine a statement tool serves enforces read-only, one line per engine and no other", () => {
    expect(boundaryLabels().sort()).toEqual(servedLabels().sort());
  });

  test("gives every served engine one row in the cancel table, and no other engine one", () => {
    expect(cancelLabels().sort()).toEqual(servedLabels().sort());
  });

  test("docs/FEATURES.md points at docs/MCP.md for the tools and their engines, and names no statement tool", () => {
    const line = read("docs/FEATURES.md")
      .split("\n")
      .find((text) => text.startsWith("*   **Read-only tools:**"));
    expect(line).toContain("[docs/MCP.md](./MCP.md#what-it-is)");
    expect(line).not.toMatch(/\brun_[a-z]+_(?:read|query|command)\b/);
  });

  test("says which libSQL token a seed needs and that inspect_schema opens libSQL unproven", () => {
    expect(MCP_DOC).toContain(
      "  - libSQL: by a token proven at open to be read-only, which the server refuses every write, and refuses a login that could do more than read ([libsql.md](./providers/libsql.md)).",
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
      "| Db2 LUW | Studio stops waiting; the statement runs on the server to its end, and the provider closes its connection once it has ended | Studio stops waiting at `timeout_ms`, the statement runs on the server to its end, and the client gets the timeout answer (measured on 12.1.0.0 on 2026-11-02: a statement answered at `timeout_ms`, and one whose client closed the call, each ran 17 to 46 seconds more) |",
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

describe("the per-engine lines that stay per engine", () => {
  // The same whole-label matcher the guards use reads each first cell, so a row names one engine and no other.
  test("each boundary bullet and cancel row names exactly one engine, the one it starts with", () => {
    const labels = SHIPPED_DATABASE_TYPES.map(labelOf);
    for (const label of boundaryLabels()) expect(namedLabels(label, labels)).toEqual([label]);
    for (const label of cancelLabels()) expect(namedLabels(label, labels)).toEqual([label]);
  });

  test("D128 names no served engine, so the cancel table stays the one place that says what each one does", () => {
    const backlog = read("docs/BACKLOG.md");
    const start = backlog.indexOf("### D128.");
    const body = backlog.slice(start, backlog.indexOf("\n### ", start + 1));
    expect(body).toContain("the cancel table in `docs/MCP.md`");
    expect(namedLabels(body, servedLabels())).toEqual([]);
    expect(body).toContain("every engine a statement tool serves stops the statement on abort");
  });
});

describe("docs/SEED_CONNECTIONS.md", () => {
  const seed = read("docs/SEED_CONNECTIONS.md");
  /** The seed doc's short name where it differs from the display label; every other closed engine uses its label. */
  const SHORT_NAMES: Partial<Record<DatabaseType, string>> = { s3: "S3" };
  const closed = SHIPPED_DATABASE_TYPES.filter((type) => !MCP_EXPOSABLE[type]).map(
    (type) => SHORT_NAMES[type] ?? labelOf(type),
  );
  const names = closed.length === 1 ? closed[0] : `${closed.slice(0, -1).join(", ")} or ${closed[closed.length - 1]}`;
  const article = /^[AEIOU]/.test(names) ? "An" : "A";

  test("names the engines MCP is not offered for, from MCP_EXPOSABLE, in the mcp field row and its load error", () => {
    expect(closed).not.toEqual([]);
    const row = seed.split("\n").find((line) => line.startsWith("| `connections[].mcp` |"));
    expect(row).toContain(`${article} ${names} connection refuses \`mcp: true\` when the file loads`);
    expect(seed).toContain(
      `| \`mcp: true\` on ${article.toLowerCase()} ${names} connection | The whole file fails like any invalid config, and the error names \`mcp\` and the type, such as \`oxia\` or \`s3\` |`,
    );
  });

  test("says which statement tool reads a Neo4j seed", () => {
    const tool = mcpStatementToolFor("neo4j");
    expect(tool).not.toBeNull();
    expect(seed).toContain(
      `\`mcp: true\` lets an MCP client list the connection, inspect its schema and read it with \`${tool}\`.`,
    );
  });
});
