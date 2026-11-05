import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { REFUSES_DENIED_FILE_ACCESS, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { getDBConfig } from "@/lib/db-ui-config";
import { MCP_CONNECTION_UNAVAILABLE_TEXT, mcpConnectionUnavailable } from "@/lib/mcp/availability";
import type { McpCaller } from "@/lib/mcp/context";
import type { ManagedConnection } from "@/lib/seed";
import { filterByRoles } from "@/lib/seed/connection-filter";
import { seedRolesOf } from "@/lib/seed/roles";
import type { SeedConnection } from "@/lib/seed/types";
import type { DatabaseType } from "@/lib/types";
import { namedLabels } from "../../helpers/repo-text-scope";

const ADMIN: McpCaller = { username: "alice", role: "admin" };
const USER: McpCaller = { username: "bob", role: "user" };

/** The copy `caller` lists of an operator's seed of `type` offered to `roles`, built by the product's projection. */
function copyFor(caller: McpCaller, type: DatabaseType, roles: string[]): ManagedConnection {
  const entry: SeedConnection = { id: "files", name: "Files", type, database: "/srv/data/files.db", roles };
  const [copy] = filterByRoles([entry], seedRolesOf(caller));
  if (copy === undefined) throw new Error(`a ${caller.role} token cannot list a seed offered to ${roles.join(", ")}`);
  return copy;
}

let savedGovernance: string | undefined;

// editorExecutionContext names a provider owner under governance, so a developer's GOVERNANCE_SOURCE is set aside.
beforeEach(() => {
  savedGovernance = process.env.GOVERNANCE_SOURCE;
  delete process.env.GOVERNANCE_SOURCE;
});

afterEach(() => {
  if (savedGovernance === undefined) delete process.env.GOVERNANCE_SOURCE;
  else process.env.GOVERNANCE_SOURCE = savedGovernance;
});

describe("mcpConnectionUnavailable", () => {
  test("answers null on an engine whose row is false, under a denied posture too", () => {
    expect(mcpConnectionUnavailable(ADMIN, copyFor(ADMIN, "duckdb", ["*"]))).toBeNull();
    expect(mcpConnectionUnavailable(USER, copyFor(USER, "duckdb", ["*"]))).toBeNull();
  });

  test("answers null wherever the record it is given holds the engine false", () => {
    const refuses = { ...REFUSES_DENIED_FILE_ACCESS, sqlite: false };
    expect(mcpConnectionUnavailable(USER, copyFor(USER, "sqlite", ["*"]), refuses)).toBeNull();
  });

  test("answers null for an admin on a SQLite seed offered to admins alone", () => {
    expect(mcpConnectionUnavailable(ADMIN, copyFor(ADMIN, "sqlite", ["admin"]))).toBeNull();
  });

  test.each([
    ["an admin on a SQLite seed offered to every role", ADMIN, ["*"]],
    ["a user on a SQLite seed offered to every role", USER, ["*"]],
    ["a user on a SQLite seed offered to the user role", USER, ["user"]],
  ] as const)("answers the sentence for %s", (_, caller, roles) => {
    expect(mcpConnectionUnavailable(caller, copyFor(caller, "sqlite", [...roles]))).toBe(
      MCP_CONNECTION_UNAVAILABLE_TEXT,
    );
  });

  test("reads whom the operator offers a seed to from the copy, not from its narrowed roles", () => {
    // A seed another role can use opens for no caller, admin included (docs/providers/sqlite.md).
    const copy = copyFor(ADMIN, "sqlite", ["admin", "user"]);
    expect(copy.roles).toEqual(["admin"]);
    expect(mcpConnectionUnavailable(ADMIN, copy)).toBe(MCP_CONNECTION_UNAVAILABLE_TEXT);
  });

  test("the sentence names no engine and says what an operator changes", () => {
    expect(MCP_CONNECTION_UNAVAILABLE_TEXT).toBe(
      "This connection is not available to MCP: its engine opens only with full file access, which Studio grants only to an admin on a seed limited to the admin role, so an operator limits this seed's roles to admin.",
    );
    expect(
      namedLabels(
        MCP_CONNECTION_UNAVAILABLE_TEXT,
        SHIPPED_DATABASE_TYPES.map((type) => getDBConfig(type).label),
      ),
    ).toEqual([]);
  });
});
