/**
 * The fixed MCP tool count matchers (tests/helpers/fixed-tool-count.ts), held to the forms the repository wrote and
 * the look-alikes it must leave alone: other counts, the agent's own tools, and an engine sentence built from the
 * registry.
 *
 * The positive forms are planted in strings here, which the guard would read; this file and the guard name each
 * other, and the guard leaves this one file out for that reason alone.
 */
import { describe, expect, test } from "bun:test";
import { countFindings, inCountScope, isMcpOwned } from "../helpers/fixed-tool-count";

const LABELS = ["PostgreSQL", "SQLite", "DuckDB", "Neo4j"];
const hits = (path: string, source: string): string[] =>
  countFindings(path, source, LABELS).map((finding) => finding.text);

describe("scope", () => {
  test("reads READMEs, every doc, source, tests, end-to-end specs and the env example, never fixtures", () => {
    for (const path of [
      "README.md",
      "README_ja.md",
      "docs/FEATURES.md",
      "docs/ARCHITECTURE.md",
      "docs/providers/neo4j.md",
      "src/lib/db/compatibility.ts",
      "tests/unit/agent-documentation.test.ts",
      "e2e/mcp.spec.ts",
      ".env.example",
    ])
      expect(inCountScope(path)).toBe(true);
    for (const path of ["tests/fixtures/x.ts", "package.json", "charts/libredb-studio/values.yaml"])
      expect(inCountScope(path)).toBe(false);
  });

  test("reads the files MCP owns on every line", () => {
    for (const path of [
      "docs/MCP.md",
      "src/lib/mcp/tools/index.ts",
      "tests/integration/mcp/protocol.test.ts",
      "tests/helpers/mcp-fixtures.ts",
      "tests/helpers/run-read-query.ts",
      "tests/unit/mcp-documentation.test.ts",
    ])
      expect(isMcpOwned(path)).toBe(true);
    expect(isMcpOwned("docs/FEATURES.md")).toBe(false);
  });
});

describe("countFindings", () => {
  test.each([
    ["docs/MCP.md", "- Fifteen tools, each annotated read-only and closed-world:"],
    ["src/lib/db/compatibility.ts", "  // Offered for the two metadata tools, carrying names and types only."],
    ["docs/ARCHITECTURE.md", "Its fifteen tools reach only seed connections opted in with `mcp: true`."],
    ["docs/FEATURES.md", "MCP: list the 15 tools"],
    ["tests/integration/mcp/protocol.test.ts", 'test("lists the fifteen tools in registration order", () => {});'],
    ["tests/integration/mcp/protocol.test.ts", "expect(tools).toHaveLength(15);"],
    ["tests/integration/mcp/http-route.test.ts", "expect(registrations.calls).toBe(15);"],
    ["tests/integration/mcp/lifecycle.test.ts", "return registrations.calls / 15;"],
    ["tests/unit/agent-documentation.test.ts", "const MCP_CLAIM = /\\bMCP\\b|Five read-only tools/;"],
    ["tests/integration/db/x-provider.test.ts", 'const engines = "It runs on PostgreSQL, SQLite and DuckDB.";'],
    [
      "tests/integration/mcp/run-cypher-read.test.ts",
      'expect(names.indexOf("run_cypher_read")).toBe(names.indexOf("run_qdrant_read") + 1);',
    ],
    ["tests/unit/mcp/x.test.ts", 'const names = ["list_connections", "run_read_query", "run_kubectl_read"];'],
    [
      "tests/integration/mcp/x.test.ts",
      'expect(tools).toEqual([["a", "run_read_query"], ["b", "run_redis_read"], ["c", "inspect_schema"]]);',
    ],
  ])("finds a fixed count or list in %s: %s", (path, source) => {
    expect(hits(path, source)).not.toEqual([]);
  });

  test.each([
    ["docs/MCP.md", "One endpoint, `POST /api/mcp`, one statement tool per statement language."],
    ["docs/MCP.md", "Every `POST` spends one slot, at most 500 rows, `max_rows` (default 100, at most 500)."],
    ["docs/AGENT.md", "Four tools are the read class, and the agent's three tools answer."],
    ["README.md", "OceanBase answers fourteen of the fifteen surfaces."],
    ["tests/integration/mcp/x.test.ts", "const text = `It runs on ${RUN_READ_QUERY_ENGINES}.`;"],
    ["tests/integration/mcp/x.test.ts", 'const text = "It runs on Neo4j.";'],
    ["tests/components/SchemaDiff.test.tsx", "// It runs on its own counter, so the order holds."],
    ["tests/unit/agent/x.test.ts", "expect(tools).toHaveLength(3);"],
    ["tests/unit/mcp/x.test.ts", 'const pair = ["list_connections", "inspect_schema"];'],
    ["tests/unit/mcp/x.test.ts", 'test.each([["run_read_query", 1], ["inspect_schema", 2], ["list_connections", 3]]);'],
    ["tests/integration/mcp/x.test.ts", "expect(registrations.calls).toBe(0);"],
    ["src/lib/agent/x.ts", 'const lead = "the two tools its verdict accepts";'],
  ])("leaves a look-alike alone in %s: %s", (path, source) => {
    expect(hits(path, source)).toEqual([]);
  });

  test("names the one-based line of each finding", () => {
    expect(countFindings("docs/MCP.md", "intro\n- Fifteen tools", LABELS)).toEqual([
      { path: "docs/MCP.md", line: 2, text: "- Fifteen tools" },
    ]);
  });
});
