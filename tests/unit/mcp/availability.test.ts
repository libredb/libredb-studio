import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { REFUSES_DENIED_FILE_ACCESS, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { getDBConfig } from "@/lib/db-ui-config";
import { forgetServerCatalog, installServerCatalog } from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { typeIdRefusal, unknownTypeSentence } from "@/lib/db/type-id";
import { MCP_CONNECTION_UNAVAILABLE_TEXT, mcpConnectionUnavailable } from "@/lib/mcp/availability";
import type { McpCaller } from "@/lib/mcp/context";
import type { ManagedConnection } from "@/lib/seed";
import { filterByRoles } from "@/lib/seed/connection-filter";
import { seedRolesOf } from "@/lib/seed/roles";
import type { SeedConnection } from "@/lib/seed/types";
import type { DatabaseType } from "@/lib/types";
import { admittedFor, admittedManifest } from "../../helpers/package-catalog";
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
  forgetServerCatalog();
  if (savedGovernance === undefined) delete process.env.GOVERNANCE_SOURCE;
  else process.env.GOVERNANCE_SOURCE = savedGovernance;
});

describe("mcpConnectionUnavailable", () => {
  test("answers null on an engine whose row is null, under a denied posture too", () => {
    expect(mcpConnectionUnavailable(ADMIN, copyFor(ADMIN, "duckdb", ["*"]))).toBeNull();
    expect(mcpConnectionUnavailable(USER, copyFor(USER, "duckdb", ["*"]))).toBeNull();
  });

  test("answers null wherever the record it is given holds the engine null", () => {
    const refuses = { ...REFUSES_DENIED_FILE_ACCESS, sqlite: null };
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

  // An engine only a provider package serves has no row in any table either (docs/providers/CONTRACT.md, clause C-107):
  // a refused package's engine answers the sentence naming the refusal code, an admitted one the open's own sentence.
  test("answers the server catalog's refusal for an engine a provider package serves or a refused package names", () => {
    installServerCatalog(
      composeServerCatalog(
        [admittedFor("acme-avail-served", admittedManifest("acmeavailserved"))],
        [{ name: "acme-avail-gone", version: "1.0.0", engines: ["acmeavailgone"], code: "PROVIDER_LOAD_FAILED" }],
      ),
    );
    const listed = (type: string) => ({ ...copyFor(ADMIN, "sqlite", ["admin"]), type }) as unknown as ManagedConnection;
    expect(mcpConnectionUnavailable(ADMIN, listed("acmeavailgone"))).toBe(
      'The connection type "acmeavailgone" is served by a provider package this LibreDB Studio refused when it started (PROVIDER_LOAD_FAILED), so no provider can open it; the server\'s log names the package and why.',
    );
    expect(mcpConnectionUnavailable(USER, listed("acmeavailserved"))).toBe(
      "LibreDB Studio's provider factory builds no provider for an engine of a provider package; that engine's session opens through its package, and this caller does not serve one.",
    );
  });

  test("a request that needs the legacy provider surface is refused for a package engine by reading the record's offer, 501 PACKAGE_ENGINE_UNSUPPORTED with today's sentence", () => {
    // A legacy engine's record offers the legacy provider and a package's record offers none; the install refuses a
    // catalog whose offer disagrees with the id, so the answer follows the offer of a valid record.
    installServerCatalog(
      composeServerCatalog([admittedFor("acme-avail-offer", admittedManifest("acmeavailoffer"))], []),
    );
    const listed = (type: string) => ({ ...copyFor(ADMIN, "sqlite", ["admin"]), type }) as unknown as ManagedConnection;
    expect(mcpConnectionUnavailable(ADMIN, listed("acmeavailoffer"))).toBe(
      "LibreDB Studio's provider factory builds no provider for an engine of a provider package; that engine's session opens through its package, and this caller does not serve one.",
    );
    expect(mcpConnectionUnavailable(ADMIN, listed("sqlite"))).toBeNull();
  });

  // A connection whose type names no provider (FND-1) has no row in any table, so its refusal is the one sentence every
  // surface gives it, before any posture is asked; an inherited key such as `constructor` reads no row either.
  test("answers the refusal's sentence for a connection whose type names no provider, before any posture", () => {
    const listed = (type: unknown) =>
      ({ ...copyFor(ADMIN, "sqlite", ["admin"]), type }) as unknown as ManagedConnection;
    expect(mcpConnectionUnavailable(ADMIN, listed("acmefoo"))).toBe(unknownTypeSentence("acmefoo"));
    expect(mcpConnectionUnavailable(USER, listed("constructor"))).toBe(unknownTypeSentence("constructor"));
    const untyped = { ...copyFor(ADMIN, "sqlite", ["admin"]) } as Record<string, unknown>;
    delete untyped.type;
    expect(mcpConnectionUnavailable(ADMIN, untyped as unknown as ManagedConnection)).toBe(
      typeIdRefusal(undefined)?.sentence as string,
    );
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
