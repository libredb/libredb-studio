/**
 * The seed schema's mcp: "write" opt-in (#1774): accepted on a managed, writable, MCP-exposable
 * seed whatever its environment label, and refused with readOnly, on an unmanaged seed, in
 * defaults, on a non-boolean form, and on an engine MCP is not offered for.
 */
import { describe, expect, test } from "bun:test";
import { SeedConfigSchema } from "@/lib/seed/types";

const shop = { id: "shop", name: "Shop", type: "sqlite", database: "/tmp/shop.db", roles: ["admin"] } as const;

describe('SeedConfigSchema mcp: "write"', () => {
  test("accepts a managed writable seed, with and without an environment label", () => {
    for (const connection of [
      { ...shop, mcp: "write" },
      { ...shop, mcp: "write", environment: "development" },
      { ...shop, mcp: "write", environment: "production" },
    ]) {
      const result = SeedConfigSchema.safeParse({ version: "1", connections: [connection] });
      expect(result.success).toBe(true);
    }
  });

  test('refuses mcp: "write" with readOnly: true, naming the mcp field', () => {
    const result = SeedConfigSchema.safeParse({
      version: "1",
      connections: [{ ...shop, mcp: "write", readOnly: true }],
    });
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    // sqlite also refuses readOnly itself (its provider does not enforce the mode), so the write
    // refusal rides beside that one rather than alone; the write refusal is the one on mcp.
    const mcpIssue = issues.find((issue) => issue.path?.[0] === "connections" && issue.path?.[2] === "mcp");
    expect(mcpIssue).toBeDefined();
    expect(mcpIssue?.message).toContain('mcp: "write" is refused with readOnly: true');
  });

  test('refuses mcp: "write" on an unmanaged seed', () => {
    const result = SeedConfigSchema.safeParse({
      version: "1",
      connections: [{ ...shop, mcp: "write", managed: false }],
    });
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ["connections", 0, "mcp"],
      message: expect.stringContaining('mcp: "write" needs a managed connection'),
    });
  });

  test("refuses mcp in defaults, the write value included", () => {
    for (const mcp of [true, "write"]) {
      const result = SeedConfigSchema.safeParse({
        version: "1",
        defaults: { mcp },
        connections: [shop],
      });
      expect(result.success).toBe(false);
    }
  });

  test('refuses mcp: "write" on an engine MCP is not offered for', () => {
    const result = SeedConfigSchema.safeParse({
      version: "1",
      connections: [{ id: "e", name: "Etcd", type: "etcd", roles: ["admin"], mcp: "write" }],
    });
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      path: ["connections", 0, "mcp"],
      message: expect.stringContaining("mcp is not offered for etcd"),
    });
  });

  test("refuses a non-boolean, non-write mcp value", () => {
    for (const mcp of ["yes", "rw", "true"]) {
      const result = SeedConfigSchema.safeParse({
        version: "1",
        connections: [{ ...shop, mcp }],
      });
      expect(result.success).toBe(false);
    }
  });
});
