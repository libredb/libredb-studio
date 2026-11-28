/**
 * The engine view an agent run reads (`agentEngineDeclarations` in src/lib/agent/engine-view.ts): a legacy
 * engine's is its provider's own declarations, handed on as the very objects the provider factory answers; a provider
 * package's engine's is read from its admitted declaration in a crafted catalog, no package imported and no session
 * opened. Every catalog is composed in memory (tests/helpers/package-catalog.ts), so no file, mode or line ending is read.
 */
import { describe, expect, spyOn, test } from "bun:test";
import type { ObjectModel } from "@libredb/provider-sdk/manifest";
import { agentEngineDeclarations } from "@/lib/agent/engine-view";
import { STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import * as db from "@/lib/db";
import * as factory from "@/lib/db/factory";
import { type EngineRecord, servedEngineRecord } from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import type { DatabaseConnection, ProviderCapabilities, ProviderLabels } from "@/lib/db/types";
import { admittedFor, admittedManifest, type EditableEngine, withEngineRecord } from "../../../helpers/package-catalog";

/** A connection of `type`, at an address no case connects to. */
function connectionOf(type: string): DatabaseConnection {
  return {
    id: "conn-1",
    name: "Orders",
    type,
    host: "127.0.0.1",
    port: 1,
    createdAt: new Date(0),
  } as DatabaseConnection;
}

/** A one-level model with a group kind, then two relation kinds: names no engine of Studio's. */
const MODEL: ObjectModel = {
  containerLevels: [{ id: "schema", label: "Folder", labelPlural: "Folders" }],
  containerPathShapes: "exact",
  containerNameSpelling: null,
  objectKinds: [
    kind("bundle", "group", "Bundle", "Bundles"),
    kind("item", "relation", "Item", "Items"),
    kind("view", "relation", "Lens", "Lenses"),
  ],
  rowActions: [],
  containersNameKinds: false,
  tablesNeedContainer: false,
  tablesAreDerivedGroupings: true,
  agentWalkScope: { mode: "session-default", alsoWalk: [["shared"]], whenNoDefault: null },
  schemaDiffScope: null,
  maskedNameKinds: [],
};

/** An object kind of `role` with its words and no member beyond them. */
function kind(
  id: string,
  role: "relation" | "group",
  label: string,
  labelPlural: string,
): ObjectModel["objectKinds"][number] {
  return {
    id,
    role,
    label,
    labelPlural,
    hasSource: false,
    sourceLanguage: null,
    hasColumns: role === "relation",
    acceptsSourceEdits: false,
    childKinds: [],
    attachedTo: null,
    acceptsRowWrites: false,
    enumeratedBy: null,
    countIsListing: false,
    machineNames: null,
    group: null,
  };
}

/**
 * The record of the package engine `id` in a catalog composed from the minimal manifest, its package's manifest then
 * replaced by the minimal manifest of `manifestId` changed by `edit` and admitted by the SDK's validator. The reader reads the
 * record's package's declaration, so the change reaches it without the composer's own checks of editor facts, which
 * refuse a tab type another engine claims and a language Studio holds none of.
 */
function packageEngine(id: string, edit: (engine: EditableEngine) => void, manifestId = id): EngineRecord {
  const catalog = composeServerCatalog([admittedFor(`${id}-package`, admittedManifest(id))], [], STUDIO_GRANT_REGISTER);
  const manifest = admittedManifest(manifestId, edit);
  const changed = withEngineRecord(catalog, id, (engine) => {
    const served = engine.source.package;
    if (served === null) throw new Error(`the crafted catalog serves ${id} from no package`);
    return { ...engine, source: { ...engine.source, package: { ...served, manifest } } };
  });
  return changed.engines.get(id) as EngineRecord;
}

describe("agentEngineDeclarations", () => {
  test("a legacy engine's agent declarations are its provider's own, read without connecting", async () => {
    const engine = servedEngineRecord("postgres");
    const connection = connectionOf("postgres");
    const execution = factory.executionContextFor("agent-operations", {});
    const read = await factory.readProviderDeclarations(connection, execution);
    // Read from the provider without connecting: the address is one nothing listens on.
    expect(await agentEngineDeclarations(engine, connection, execution)).toEqual({
      capabilities: read.capabilities,
      labels: read.labels,
    });

    const capabilities = { queryLanguage: "sql" } as ProviderCapabilities;
    const labels = { entityName: "Table", entityNamePlural: "Tables" } as ProviderLabels;
    const spy = spyOn(db, "readProviderDeclarations").mockResolvedValue({
      capabilities,
      labels,
      supportsQueryCancel: true,
    });
    try {
      const view = await agentEngineDeclarations(engine, connection, execution);
      // The very objects the factory answered, so a legacy run reads exactly what its provider declared.
      expect(view.capabilities).toBe(capabilities);
      expect(view.labels).toBe(labels);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual([connection, execution]);
    } finally {
      spy.mockRestore();
    }
  });

  test("a package engine's agent declarations are read from its admitted declaration: its model, query language, explain format and first relation kind's noun", async () => {
    const engine = packageEngine("acmeagentview", (declared) => {
      (declared as Record<string, unknown>).objects = structuredClone(MODEL);
      declared.editor.explainFormat = "postgres-json";
      (declared.editor.language as Record<string, unknown>).queryLanguage = "json";
    });
    const spy = spyOn(db, "readProviderDeclarations");
    try {
      const view = await agentEngineDeclarations(engine, connectionOf("acmeagentview"), {});
      expect(view).toEqual({
        capabilities: {
          containerLevels: MODEL.containerLevels,
          containerPathShapes: "exact",
          objectKinds: MODEL.objectKinds,
          rowActions: [],
          containersNameKinds: false,
          tablesAreDerivedGroupings: true,
          // Studio's form of the walk scope: a `whenNoDefault` the declaration writes as null is absent.
          agentWalkScope: { mode: "session-default", alsoWalk: [["shared"]] },
          queryLanguage: "json",
          explainFormat: "postgres-json",
        },
        labels: { entityName: "Item", entityNamePlural: "Items" },
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }

    const scoped = packageEngine("acmeagentscope", (declared) => {
      (declared as Record<string, unknown>).objects = {
        ...structuredClone(MODEL),
        agentWalkScope: {
          mode: "session-default",
          alsoWalk: [],
          whenNoDefault: { walk: "parent-default-children", skip: ["tmp"] },
        },
      };
    });
    const { capabilities } = await agentEngineDeclarations(scoped, connectionOf("acmeagentscope"), {});
    expect(capabilities.agentWalkScope).toEqual({
      mode: "session-default",
      alsoWalk: [],
      whenNoDefault: { walk: "parent-default-children", skip: ["tmp"] },
    });
    expect(capabilities.explainFormat).toBeUndefined();
    expect(Object.hasOwn(capabilities, "explainFormat")).toBe(false);
  });

  test("a package model with no relation kind names its inventory rows objects", async () => {
    const engine = packageEngine("acmeagentgroups", (declared) => {
      (declared as Record<string, unknown>).objects = {
        ...structuredClone(MODEL),
        objectKinds: [kind("bundle", "group", "Bundle", "Bundles")],
        agentWalkScope: null,
      };
    });
    const view = await agentEngineDeclarations(engine, connectionOf("acmeagentgroups"), {});
    expect(view.labels).toEqual({ entityName: "Object", entityNamePlural: "Objects" });
    expect(Object.hasOwn(view.capabilities, "agentWalkScope")).toBe(false);
  });

  test("a package declaration with no object model declares no object kinds, and a record its package declares no entry for is a host defect", async () => {
    const bare = packageEngine("acmeagentbare", () => undefined);
    const view = await agentEngineDeclarations(bare, connectionOf("acmeagentbare"), {});
    expect(view).toEqual({
      capabilities: { queryLanguage: "sql" },
      labels: { entityName: "Object", entityNamePlural: "Objects" },
    });

    // A record whose package's declaration names another engine only.
    const orphan = packageEngine("acmeagentother", () => undefined, "acmeagentelse");
    await expect(agentEngineDeclarations(orphan, connectionOf("acmeagentother"), {})).rejects.toThrow(
      'The provider package acmeagentother-package serving the engine "acmeagentother" declares no engine of that id: a host defect.',
    );

    // Names Studio holds none of, which admission refuses before a catalog is composed; a crafted catalog skips it.
    const unheldLanguage = packageEngine("acmeagentlang", (declared) => {
      (declared.editor.language as Record<string, unknown>).queryLanguage = "acmeql";
    });
    await expect(agentEngineDeclarations(unheldLanguage, connectionOf("acmeagentlang"), {})).rejects.toThrow(
      'The engine "acmeagentlang" declares the query language "acmeql", which LibreDB Studio holds no tab type for and admission refuses: a host defect.',
    );
    const unheldFormat = packageEngine("acmeagentplan", (declared) => {
      declared.editor.explainFormat = "acme-plan";
    });
    await expect(agentEngineDeclarations(unheldFormat, connectionOf("acmeagentplan"), {})).rejects.toThrow(
      'The engine "acmeagentplan" declares the explain format "acme-plan", which LibreDB Studio holds no explain strategy for and admission refuses: a host defect.',
    );
  });
});
