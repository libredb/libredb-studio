/**
 * LIBREDB_MCP_WRITE_ENABLED (#1774): fail closed, so unset, empty, off and unrecognized values
 * read as disabled, and only true/on/1 enable the write tool.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { MCP_WRITE_ENABLED_ENV, readMcpWriteEnabled } from "@/lib/mcp/write-switch";

describe("readMcpWriteEnabled (#1774)", () => {
  afterEach(() => {
    delete process.env[MCP_WRITE_ENABLED_ENV];
  });

  test.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["off", false],
    ["0", false],
    ["maybe", false],
    ["true", true],
    ["on", true],
    ["1", true],
    ["TRUE", true],
  ] as const)("reads %p as %p", (value, expected) => {
    if (value === undefined) delete process.env[MCP_WRITE_ENABLED_ENV];
    else process.env[MCP_WRITE_ENABLED_ENV] = value;
    expect(readMcpWriteEnabled()).toBe(expected);
  });

  test("MCP_WRITE_ENABLED_ENV names the variable the switch reads", () => {
    expect(MCP_WRITE_ENABLED_ENV).toBe("LIBREDB_MCP_WRITE_ENABLED");
  });
});
