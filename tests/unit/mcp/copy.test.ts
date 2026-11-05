/**
 * The copy that introduces MCP beside docs/MCP.md says what MCP runs (#2252, part 1): bounded, read-only statements
 * in each engine's own language, as the guide's introduction says, never "read-only SQL", which only one statement
 * tool runs, and that MCP needs no LLM provider. The settings screen's rendered sentences are pinned in
 * tests/components/mcp/McpSettings.test.tsx; this reads the sources. The chart's values comment keeps its words until
 * the next chart change (`docs/BACKLOG.md` MCP23), because a values.yaml edit forces a chart release.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../..");

/** A file's text with each line's leading comment marker removed and its white space collapsed, so a wrapped sentence reads whole. */
const prose = (relative: string): string =>
  readFileSync(path.join(ROOT, relative), "utf8")
    .replace(/^[ \t]*#[ \t]?/gm, "")
    .replace(/\s+/g, " ");

describe("the copy that introduces MCP", () => {
  test.each(["src/components/mcp/McpSettings.tsx", ".env.example", "docker-compose.example.yml"])(
    "%s never says read-only SQL",
    (file) => {
      expect(prose(file)).not.toMatch(/\bread-only SQL\b/i);
    },
  );

  test.each([".env.example", "docker-compose.example.yml"])(
    "%s says what MCP runs and that it needs no LLM provider",
    (file) => {
      const text = prose(file);
      expect(text).toContain("runs bounded, read-only statements in each engine's own language");
      expect(text).toContain("MCP needs no LLM provider");
    },
  );
});
