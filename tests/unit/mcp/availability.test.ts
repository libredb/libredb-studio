import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseGrantRegister } from "@libredb/grant-register";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { getDBConfig } from "@/lib/db-ui-config";
import { forgetServerCatalog, installServerCatalog, servedEngines } from "@/lib/db/server-catalog";
import { STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { typeIdRefusal, unknownTypeSentence } from "@/lib/db/type-id";
import {
  MCP_CONNECTION_UNAVAILABLE_TEXT,
  MCP_ENGINE_NOT_OFFERED_TEXT,
  mcpConnectionUnavailable,
} from "@/lib/mcp/availability";
import type { McpCaller } from "@/lib/mcp/context";
import type { ManagedConnection } from "@/lib/seed";
import { filterByRoles } from "@/lib/seed/connection-filter";
import { seedRolesOf } from "@/lib/seed/roles";
import { type SeedConnection, SeedConnectionSchema } from "@/lib/seed/types";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import type { DatabaseType } from "@/lib/types";
import {
  admittedFor,
  admittedManifest,
  craftedCatalog,
  type EditableEngine,
  packageRow,
  withCatalog,
} from "../../helpers/package-catalog";
import { namedLabels } from "../../helpers/repo-text-scope";
import { legacyRegisterTable } from "../../helpers/legacy-register";

const deniedFileAccessRefusal = legacyRegisterTable("deniedFileAccessRefusal");

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
    const grantsOf = (type: DatabaseType) => ({
      exposable: true,
      deniedFileAccessRefusal: type === "sqlite" ? null : deniedFileAccessRefusal[type],
    });
    expect(mcpConnectionUnavailable(USER, copyFor(USER, "sqlite", ["*"]), grantsOf)).toBeNull();
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

  // A refused package's engine is answered the server catalog's refusal naming its code, and an admitted package's engine
  // is read by its record's grants (docs/providers/CONTRACT.md, clause C-107): with no register row it is exposed to no
  // MCP client, so it is answered the exposure sentence.
  test("answers the server catalog's refusal for an engine only a refused package names, and the exposure sentence for an admitted one no row offers to MCP", () => {
    installServerCatalog(
      composeServerCatalog(
        [admittedFor("acme-avail-served", admittedManifest("acmeavailserved"))],
        [{ name: "acme-avail-gone", version: "1.0.0", engines: ["acmeavailgone"], code: "PROVIDER_LOAD_FAILED" }],
        STUDIO_GRANT_REGISTER,
      ),
    );
    const listed = (type: string) => ({ ...copyFor(ADMIN, "sqlite", ["admin"]), type }) as unknown as ManagedConnection;
    expect(mcpConnectionUnavailable(ADMIN, listed("acmeavailgone"))).toBe(
      'The connection type "acmeavailgone" is served by a provider package this LibreDB Studio refused when it started (PROVIDER_LOAD_FAILED), so no provider can open it; the server\'s log names the package and why.',
    );
    expect(mcpConnectionUnavailable(USER, listed("acmeavailserved"))).toBe(MCP_ENGINE_NOT_OFFERED_TEXT);
  });

  test("a package engine's connection is available, refused by tool by its grants where no row exists", () => {
    // Each declaration requests exposure, so only the register row decides it.
    const requestsExposure = (engine: EditableEngine) => {
      engine.mcp = { ...engine.mcp, exposable: true };
    };
    const bare = admittedFor("acme-avail-bare", admittedManifest("acmeavailbare", requestsExposure));
    const open = admittedFor("acme-avail-open", admittedManifest("acmeavailopen", requestsExposure));
    const files = admittedFor("acme-avail-files", admittedManifest("acmeavailfiles", requestsExposure));
    const exposed = { exposable: true, agentCredentialRequired: false, readRootsRequired: false } as const;
    const register = parseGrantRegister(
      [
        packageRow(open, "acmeavailopen", { ...exposed, deniedFileAccessRefusal: null }),
        // Every other claim at its restrictive value, the denied file access refusal among them.
        packageRow(files, "acmeavailfiles", exposed),
      ],
      LEGACY_ENGINE_IDS,
    );
    installServerCatalog(composeServerCatalog([bare, open, files], [], register));
    const adminOnly = (type: string) =>
      ({ ...copyFor(ADMIN, "sqlite", ["admin"]), type }) as unknown as ManagedConnection;
    const everyRole = (type: string) => ({ ...copyFor(USER, "sqlite", ["*"]), type }) as unknown as ManagedConnection;

    // No row: no MCP client is offered the engine, ahead of any posture, for an admin on an admin-only seed too.
    expect(mcpConnectionUnavailable(ADMIN, adminOnly("acmeavailbare"))).toBe(MCP_ENGINE_NOT_OFFERED_TEXT);
    expect(mcpConnectionUnavailable(USER, everyRole("acmeavailbare"))).toBe(MCP_ENGINE_NOT_OFFERED_TEXT);
    // A row granting exposure: available, and the posture read only where the row refuses a denied handle.
    expect(mcpConnectionUnavailable(USER, everyRole("acmeavailopen"))).toBeNull();
    expect(mcpConnectionUnavailable(ADMIN, adminOnly("acmeavailfiles"))).toBeNull();
    expect(mcpConnectionUnavailable(USER, everyRole("acmeavailfiles"))).toBe(MCP_CONNECTION_UNAVAILABLE_TEXT);
  });

  test("a legacy engine whose record grants no exposure is refused by the exposure sentence before any posture", async () => {
    // Read from the record, never a type branch: SQLite's record with its exposure withdrawn.
    expect(mcpConnectionUnavailable(ADMIN, copyFor(ADMIN, "sqlite", ["admin"]))).toBeNull();
    await withCatalog(craftedCatalog({ sqlite: { exposable: false } }), () => {
      expect(mcpConnectionUnavailable(ADMIN, copyFor(ADMIN, "sqlite", ["admin"]))).toBe(MCP_ENGINE_NOT_OFFERED_TEXT);
      expect(mcpConnectionUnavailable(USER, copyFor(USER, "sqlite", ["*"]))).toBe(MCP_ENGINE_NOT_OFFERED_TEXT);
    });
  });

  test("every shipped engine the exposure gate refuses is one the seed loader refuses mcp: true on", () => {
    const unexposed = [...servedEngines().values()].filter((engine) => !engine.grants.exposable);
    // Vacuity: a population of none would hold nothing.
    expect(unexposed.length).toBeGreaterThan(0);
    for (const engine of unexposed) {
      const parsed = SeedConnectionSchema.safeParse({
        id: "unexposed",
        name: "Unexposed",
        type: engine.id,
        host: "unexposed.internal",
        roles: ["*"],
        mcp: true,
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
        `mcp is not offered for ${engine.id}: the product does not expose this engine to MCP clients. Remove mcp from this connection.`,
      );
    }
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

  test("the exposure sentence names no engine and says what an operator changes", () => {
    expect(MCP_ENGINE_NOT_OFFERED_TEXT).toBe(
      "This connection is not available to MCP: LibreDB Studio does not offer its engine to MCP clients, so an operator removes mcp from this seed.",
    );
    expect(
      namedLabels(
        MCP_ENGINE_NOT_OFFERED_TEXT,
        SHIPPED_DATABASE_TYPES.map((type) => getDBConfig(type).label),
      ),
    ).toEqual([]);
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
