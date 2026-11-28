/**
 * The MCP readers of a grant read the grant of the connection's engine record (`servedEngineRecord` in
 * src/lib/db/server-catalog.ts), never a table of Studio's keyed by the connection's type: availability's file-access
 * refusal (`mcpConnectionUnavailable`), the open's agent credential and read roots checks
 * (`assertAgentCredentialWhereRequired`, `assertReadRootsWhereRequired`), the `inspect_schema` hints
 * (`metadataReadAnnotations`), the served set of each statement tool (`mcpStatementEngines`) and the statement arm a type
 * reads (`mcpStatementToolFor`, `mcpWithholdsDatabase`). So a package engine's grant reaches every one of them through
 * its register row (docs/providers/CONTRACT.md, clause M-54), availability's exposure gate and both open checks
 * included, and each claim's restrictive value where no row exists.
 *
 * Every catalog here is composed in memory (tests/helpers/package-catalog.ts) and installed by the case that reads it,
 * then forgotten in `finally`, so no case leaves a catalog behind for the next.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseGrantRegister, type RegisterGrants } from "@libredb/grant-register";
import { ExecutionProfileError } from "@/lib/db/errors";
import { serverCatalogInstalled } from "@/lib/db/server-catalog";
import { type AdmittedForCatalog, composeServerCatalog } from "@/lib/db/server-catalog-compose";
import {
  MCP_CONNECTION_UNAVAILABLE_TEXT,
  MCP_ENGINE_NOT_OFFERED_TEXT,
  mcpConnectionUnavailable,
} from "@/lib/mcp/availability";
import { assertAgentCredentialWhereRequired, assertReadRootsWhereRequired, type McpCaller } from "@/lib/mcp/context";
import { MCP_READ_ONLY_ANNOTATIONS } from "@/lib/mcp/output";
import { metadataReadAnnotations } from "@/lib/mcp/tools/annotations";
import { mcpStatementEngines } from "@/lib/mcp/tools/served-engines";
import { mcpStatementToolFor, mcpWithholdsDatabase } from "@/lib/mcp/tools/statement-arms";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import type { ManagedConnection } from "@/lib/seed";
import { filterByRoles } from "@/lib/seed/connection-filter";
import { seedRolesOf } from "@/lib/seed/roles";
import type { DatabaseType } from "@/lib/types";
import {
  admittedFor,
  admittedManifest,
  craftedCatalog,
  type EditableEngine,
  packageRow,
  withCatalog,
  withLoosestClaims,
} from "../../helpers/package-catalog";

const USER: McpCaller = { username: "bob", role: "user" };

const STATE_CHANGING = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/** The copy a user lists of an operator's file seed of `type` offered to every role, built by the product's projection. */
function userCopy(type: DatabaseType): ManagedConnection {
  const [copy] = filterByRoles(
    [{ id: "files", name: "Files", type, database: "/srv/data/files.db", roles: ["*"] }],
    seedRolesOf(USER),
  );
  if (copy === undefined) throw new Error("a user token cannot list a seed offered to every role");
  return copy;
}

/** A listed connection of `type` with neither an agent credential nor read roots. */
function listed(type: string): ManagedConnection {
  return {
    id: "seed:store",
    name: "store",
    type: type as DatabaseType,
    createdAt: new Date(0),
    managed: true,
    roles: ["*"],
    seedId: "store",
  };
}

/** What `read` throws, or `null`, so the refusal is asserted after it settles. */
function thrownBy(read: () => unknown): unknown {
  try {
    read();
    return null;
  } catch (error) {
    return error;
  }
}

/** The deny code `read` refuses with, or a line naming what it answered instead. */
function denyCode(read: () => unknown): string {
  const error = thrownBy(read);
  return error instanceof ExecutionProfileError ? error.reasonCode : `not refused: ${String(error)}`;
}

/** The loosest claims, with MQTT's agent segment, so the engine requests the statement language whose arm withholds the database. */
function withMqttAgent(engine: EditableEngine): void {
  withLoosestClaims(engine);
  const mqtt = JSON.parse(
    readFileSync(path.resolve(import.meta.dir, "../../../src/lib/db/engine-declarations/mqtt.json"), "utf8"),
  ) as { agent: unknown };
  (engine as Record<string, unknown>).agent = mqtt.agent;
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

describe("the MCP readers of a grant", () => {
  test("each MCP reader answers the engine record's installed grant, not Studio's table", async () => {
    // Studio's grants, read with nothing installed: what each crafted grant below differs from.
    expect(mcpConnectionUnavailable(USER, userCopy("sqlite"))).toBe(MCP_CONNECTION_UNAVAILABLE_TEXT);
    expect(thrownBy(() => assertAgentCredentialWhereRequired(listed("postgres")))).toBeNull();
    expect(thrownBy(() => assertReadRootsWhereRequired(listed("postgres")))).toBeNull();
    expect(metadataReadAnnotations(new Set<DatabaseType>(["postgres"]))).toBe(MCP_READ_ONLY_ANNOTATIONS);
    expect(mcpStatementEngines("sql").map((engine) => engine.id)).toEqual(expect.arrayContaining(["duckdb", "mysql"]));
    expect(mcpStatementToolFor("mysql")).toBe("run_read_query");
    expect(mcpWithholdsDatabase("mqtt")).toBe(true);

    const catalog = craftedCatalog({
      sqlite: { deniedFileAccessRefusal: null },
      postgres: { agentCredentialRequired: true, readRootsRequired: true, metadataReadChangesState: true },
      duckdb: { statementRead: false },
      mysql: { statementLanguage: null },
      mqtt: { statementLanguage: null },
    });
    await withCatalog(catalog, () => {
      expect(mcpConnectionUnavailable(USER, userCopy("sqlite"))).toBeNull();
      expect(denyCode(() => assertAgentCredentialWhereRequired(listed("postgres")))).toBe("AGENT_CREDENTIAL_REQUIRED");
      expect(denyCode(() => assertReadRootsWhereRequired(listed("postgres")))).toBe("READ_ROOTS_REQUIRED");
      expect(metadataReadAnnotations(new Set<DatabaseType>(["postgres"]))).toEqual(STATE_CHANGING);
      const served: readonly string[] = mcpStatementEngines("sql").map((engine) => engine.id);
      expect(served).not.toContain("duckdb");
      expect(served).not.toContain("mysql");
      expect(mcpStatementToolFor("mysql")).toBeNull();
      expect(mcpWithholdsDatabase("mqtt")).toBe(false);
      // Vacuity: an engine the crafted catalog leaves as it is reads its own grant.
      expect(served).toContain("postgres");
      expect(mcpStatementToolFor("postgres")).toBe("run_read_query");
    });
    expect(serverCatalogInstalled()).toBe(false);
  });

  test("an admitted package's engine is read at its register row's grant by the annotations, the statement arms, both open checks and availability, and at each claim's restrictive value where no row exists", async () => {
    const rowed = admittedFor("acme-rowed", admittedManifest("acmerowed", withMqttAgent));
    const bare = admittedFor("acme-bare", admittedManifest("acmebare", withMqttAgent));
    const granted: Partial<RegisterGrants> = {
      agentExecution: true,
      exposable: true,
      statementRead: true,
      statementLanguage: null,
      metadataReadChangesState: false,
      agentCredentialRequired: false,
      readRootsRequired: false,
      deniedFileAccessRefusal: null,
    };
    const register = parseGrantRegister([packageRow(rowed, "acmerowed", granted)], LEGACY_ENGINE_IDS);
    // A package engine states no data for a module language, so a row granting it one is refused by name (M-87).
    expect(() =>
      parseGrantRegister(
        [packageRow(rowed, "acmerowed", { ...granted, statementLanguage: "mqttread" })],
        LEGACY_ENGINE_IDS,
      ),
    ).toThrow("package-language-unreviewed at /0/grants/languageSha256");
    const catalog = composeServerCatalog([rowed, bare] as readonly AdmittedForCatalog[], [], register);

    await withCatalog(catalog, () => {
      // The register row's grant.
      expect(metadataReadAnnotations(new Set(["acmerowed" as DatabaseType]))).toBe(MCP_READ_ONLY_ANNOTATIONS);
      // No module language reaches a package engine (M-87), so its database is withheld by no arm.
      expect(mcpWithholdsDatabase("acmerowed" as DatabaseType)).toBe(false);
      // No arm serves an engine whose record offers no execution profile, as no package engine's record does.
      expect(mcpStatementToolFor("acmerowed" as DatabaseType)).toBeNull();

      // No row: each claim's restrictive value.
      expect(metadataReadAnnotations(new Set(["acmebare" as DatabaseType]))).toEqual(STATE_CHANGING);
      expect(mcpWithholdsDatabase("acmebare" as DatabaseType)).toBe(false);
      expect(mcpStatementToolFor("acmebare" as DatabaseType)).toBeNull();

      // Both open checks and availability: the row's grant opens the rowed engine to MCP.
      expect(thrownBy(() => assertAgentCredentialWhereRequired(listed("acmerowed")))).toBeNull();
      expect(thrownBy(() => assertReadRootsWhereRequired(listed("acmerowed")))).toBeNull();
      expect(mcpConnectionUnavailable(USER, listed("acmerowed"))).toBeNull();
      // No row: each check's grant at its restrictive value, and no MCP client is offered the engine.
      expect(denyCode(() => assertAgentCredentialWhereRequired(listed("acmebare")))).toBe("AGENT_CREDENTIAL_REQUIRED");
      expect(denyCode(() => assertReadRootsWhereRequired(listed("acmebare")))).toBe("READ_ROOTS_REQUIRED");
      expect(mcpConnectionUnavailable(USER, listed("acmebare"))).toBe(MCP_ENGINE_NOT_OFFERED_TEXT);
    });
    expect(serverCatalogInstalled()).toBe(false);
  });
});
