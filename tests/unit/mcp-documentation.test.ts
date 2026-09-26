/**
 * docs/MCP.md and docs/API_DOCS.md against the code (#246). Reads repository text only: the
 * vendor pages the client sections were written from are not committed, so CI does not have
 * them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mcpClientConfigs } from "@/lib/mcp/client-config";
import { RUN_READ_QUERY_ENGINES } from "@/lib/mcp/tools/run-read-query";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const MCP_DOC = read("docs/MCP.md");
const API_DOCS = read("docs/API_DOCS.md");
const DOC_URL = "https://studio.example.com/api/mcp";
const CLIENTS = ["Claude Code", "Codex", "Cursor", "VS Code", "Gemini CLI"];

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

describe("docs/MCP.md", () => {
  test("carries the engine sentence derived from the one engine list", () => {
    expect(MCP_DOC).toContain(
      `Runs on ${RUN_READ_QUERY_ENGINES}; other engines refuse it, so use inspect_schema there.`,
    );
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

  test("says a static Authorization header is required, because phase 1 serves no OAuth metadata", () => {
    expect(MCP_DOC).toContain("a client needs its `Authorization` header configured");
  });
});
