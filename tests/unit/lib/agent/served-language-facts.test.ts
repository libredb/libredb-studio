/**
 * The server reads a statement language's client facts (whether it is one, its workflow variants, its plan deliverable
 * and objective, its copy, an engine's granted language and client facet) from its registry composed from the installed
 * catalog, `servedClientPacks()` in src/lib/agent/languages/server.ts, the one its server packs are composed from; the
 * browser reads its bundled composition, `BUNDLED_CLIENT_PACKS` in src/lib/agent/languages/client.ts, until it reads the
 * server's catalog.
 *
 * Every registry module is imported statically, so each has loaded before any case composes and installs a catalog.
 * Each case forgets the catalog it installs. A planted package `acme-facts` serves engine `acmefacts`, whose declaration
 * states `acmeread` (tests/helpers/declared-agent-language.ts) and requests it as its agent statement language, with the
 * `health` reading; its register row grants that language under the digest of the data it declares, agent execution
 * and the reading. Its record offers no execution profiles, so no statement workflow opens on it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parseGrantRegister, type RegisterGrants, type RegisterRow } from "@libredb/grant-register";
import type { StatementLanguageData } from "@libredb/provider-sdk/manifest";
import {
  AGENT_REQUIREMENT_ENGINES,
  type AgentDeclaredLanguageId,
  AgentManifestError,
  agentVariant,
  legacyAgentEngine,
  openWorkflows,
  PLAN_ESTIMATE_OPERATIONS,
  planDeliverableOf,
  planObjectiveOf,
  requiredVariant,
  workflowAvailability,
} from "@/lib/agent/agent-manifest";
import { grantedAgentLanguage } from "@/lib/agent/granted-language";
import { BUNDLED_CLIENT_PACKS, grantedAgentStatementLanguage } from "@/lib/agent/languages/client";
import { agentEnginePack } from "@/lib/agent/languages/engines/index";
import { agentLanguagePack } from "@/lib/agent/languages/index";
import { serverLanguageClientPack, servedAvailabilityTables, servedClientPacks } from "@/lib/agent/languages/server";
import { runHeaderRefusal } from "@/lib/agent/run-ledger-ids";
import { AGENT_WORKFLOW_PRESENTS_ANSWER, type AgentRunMode, type AgentRunWorkflowType } from "@/lib/agent/types";
import { OPERATIONS_VARIANT } from "@/lib/agent/workflow-tool-sets";
import { STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import { languageDataSha256 } from "@/lib/db/language-digest";
import {
  AgentLanguageCatalogBootUnfinishedError,
  AgentLanguageCompositionOrderError,
} from "@/lib/db/operations/served-language-data";
import {
  beginServerCatalogBoot,
  endServerCatalogBootUnfinished,
  forgetServerCatalog,
  installServerCatalog,
  type ServerCatalog,
  servedEngineRecord,
} from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import { mcpStatementToolFor, mcpTablelessReadTool, mcpWithholdsDatabase } from "@/lib/mcp/tools/statement-arms";
import type { DatabaseType } from "@/lib/types";
import { acmereadData } from "../../../helpers/declared-agent-language";
import {
  admittedFor,
  admittedManifest,
  declaredLanguageSha256,
  packageRow,
  withStatementLanguageData,
} from "../../../helpers/package-catalog";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const ACME = "acmeread" as AgentDeclaredLanguageId;
const ENGINE = "acmefacts";
const WORKFLOWS = Object.keys(AGENT_WORKFLOW_PRESENTS_ANSWER) as AgentRunWorkflowType[];
const MODES: readonly AgentRunMode[] = ["planning", "agent"];

afterEach(() => forgetServerCatalog());

/** The planted package, whose declaration states `data` and requests its name as its agent language. */
function languagePackage(data: NonNullable<StatementLanguageData>) {
  const manifest = admittedManifest(ENGINE, (declared) => {
    declared.agent = { statementLanguage: data.name, overlay: { dialect: null, grounding: null } };
    declared.facets = { ...declared.facets, agentReadings: ["health"] };
    withStatementLanguageData(declared, data);
  });
  return { pkg: admittedFor("acme-facts", manifest), manifest, data };
}

type LanguagePackage = ReturnType<typeof languagePackage>;

/** The planted package's row granting its language under its declared digest, agent execution and a reading. */
function grantingRow(planted: LanguagePackage, grants: Partial<RegisterGrants> = {}): RegisterRow {
  return packageRow(planted.pkg, ENGINE, {
    statementLanguage: planted.data.name,
    languageSha256: declaredLanguageSha256(planted.manifest),
    agentExecution: true,
    agentReadings: Object.freeze(["health"] as const),
    ...grants,
  });
}

/** The catalog of the planted package, its engine granted `rows`. */
function catalogOf(planted: LanguagePackage, rows: readonly RegisterRow[]): ServerCatalog {
  return composeServerCatalog([planted.pkg], [], parseGrantRegister([...rows], LEGACY_ENGINE_IDS));
}

/** The planted package with its granting row, composed and installed. */
function installGranted(): LanguagePackage {
  const planted = languagePackage(acmereadData());
  installServerCatalog(catalogOf(planted, [grantingRow(planted)]));
  return planted;
}

describe("the server's client facts of a statement language", () => {
  test("a package's own declared language, granted by its row, is known to every server reader of a language's client facts", () => {
    const planted = installGranted();
    const text = (planted.data.agent as NonNullable<typeof planted.data.agent>).text;
    const packs = servedClientPacks();
    const record = servedEngineRecord(ENGINE);

    expect(grantedAgentLanguage(ENGINE)).toBe(ACME);
    expect(grantedAgentStatementLanguage(record, packs)).toBe(ACME);
    expect(packs[ACME]).toBe(serverLanguageClientPack(ACME));
    expect(packs[ACME]).toBe(agentLanguagePack(ACME).client);
    expect(Object.isFrozen(packs)).toBe(true);

    const investigation = agentVariant(ACME, "investigation", packs);
    if (investigation === undefined) throw new Error("the declared language composes no investigation variant");
    expect(investigation.objective).toBe(text.investigation.objective as string);
    expect(investigation.classifierDescription).toBe(text.investigation.classifierDescription as string);
    expect(requiredVariant(ACME, "investigation", packs)).toBe(investigation);
    expect(agentVariant(ACME, "query-optimization", packs)).toBeUndefined();
    expect(planDeliverableOf(ACME, "investigation", packs)).toEqual(planDeliverableOf("sql", "investigation", packs));
    expect(planObjectiveOf(ACME, "investigation", packs)).toBe(text.investigation.objective as string);
    expect(planObjectiveOf(ACME, "query-optimization", packs)).toBe(
      planObjectiveOf("sql", "query-optimization", packs),
    );
    expect(agentEnginePack(ENGINE)).toBe(agentLanguagePack(ACME));

    const tables = servedAvailabilityTables();
    expect(tables.packs).toBe(packs);
    expect(tables.requirementEngines).toBe(AGENT_REQUIREMENT_ENGINES);
    expect(servedAvailabilityTables()).toBe(tables);
    expect(workflowAvailability("planning", "investigation", record, tables)).toEqual({
      open: true,
      statementLanguage: ACME,
      variant: investigation,
    });
    expect(workflowAvailability("planning", "query-optimization", record, tables)).toEqual({
      open: true,
      statementLanguage: ACME,
      variant: null,
    });
    expect(workflowAvailability("agent", "investigation", record, tables)).toEqual({
      open: false,
      cause: "no-statement-session",
    });
    expect(workflowAvailability("agent", "query-optimization", record, tables)).toEqual({
      open: false,
      cause: "no-statement-session",
    });
    expect(workflowAvailability("agent", "operations", record, tables)).toEqual({
      open: true,
      statementLanguage: ACME,
      variant: OPERATIONS_VARIANT,
    });
    expect(openWorkflows("planning", record, tables)).toEqual(WORKFLOWS);
    expect(openWorkflows("agent", record, tables)).toEqual(["operations"]);

    // MCP serves the arm on no package engine yet, so the engine has no statement tool and keeps its database.
    expect(mcpStatementToolFor(ENGINE as DatabaseType)).toBeNull();
    expect(mcpTablelessReadTool(ENGINE as DatabaseType)).toBeNull();
    expect(mcpWithholdsDatabase(ENGINE as DatabaseType)).toBe(false);
  });

  test("a package's declared language its row does not grant, or that the installed catalog no longer composes, is known to no server reader", () => {
    const planted = languagePackage(acmereadData());
    // One byte of one text changed: the digest of other data than the package declares.
    const other = structuredClone(planted.data) as { agent: { text: { copy: { noun: string } } } };
    other.agent.text.copy.noun = `${other.agent.text.copy.noun}x`;
    const otherDigest = languageDataSha256(other as unknown as NonNullable<StatementLanguageData>);
    expect(otherDigest).not.toBe(declaredLanguageSha256(planted.manifest));

    const refusesAcme = (granted: string | null) => {
      const packs = servedClientPacks();
      const record = servedEngineRecord(ENGINE);
      expect<string | null>(grantedAgentLanguage(ENGINE)).toBe(granted);
      expect(Object.hasOwn(packs, ACME)).toBe(false);
      expect(() => agentVariant(ACME, "investigation", packs)).toThrow(
        new AgentManifestError("unknown statement language acmeread"),
      );
      expect(() => serverLanguageClientPack(ACME)).toThrow("no client facet for acmeread");
      return record;
    };

    // No row: the record grants no language, and requests one.
    installServerCatalog(catalogOf(planted, []));
    const record = refusesAcme(null);
    const tables = servedAvailabilityTables();
    expect(workflowAvailability("planning", "investigation", record, tables)).toEqual({
      open: true,
      statementLanguage: null,
      variant: null,
    });
    expect(workflowAvailability("agent", "investigation", record, tables)).toEqual({
      open: false,
      cause: "not-reviewed",
    });
    forgetServerCatalog();

    // A row naming the language under the digest of other data: the record is granted no language, and the catalog
    // composes none from it.
    installServerCatalog(catalogOf(planted, [grantingRow(planted, { languageSha256: otherDigest })]));
    expect(servedEngineRecord(ENGINE).grants.statementLanguage).toBeNull();
    refusesAcme(null);
    forgetServerCatalog();

    // Granted, then forgotten: nothing installed serves the engine, and no registry holds the language.
    installGranted();
    expect(Object.hasOwn(servedClientPacks(), ACME)).toBe(true);
    forgetServerCatalog();
    expect(Object.hasOwn(servedClientPacks(), ACME)).toBe(false);
    expect(() => agentVariant(ACME, "investigation", servedClientPacks())).toThrow(
      new AgentManifestError("unknown statement language acmeread"),
    );
  });

  test("with nothing installed and with Studio's own catalog installed, the server's client facts are the browser's, facet for facet, for every legacy engine", () => {
    const census = () => {
      const packs = servedClientPacks();
      expect(Object.keys(packs)).toEqual(Object.keys(BUNDLED_CLIENT_PACKS));
      for (const [id, pack] of Object.entries(BUNDLED_CLIENT_PACKS)) {
        expect(packs[id as AgentDeclaredLanguageId]).toBe(pack);
      }
      const tables = servedAvailabilityTables();
      expect(tables.requirementEngines).toBe(AGENT_REQUIREMENT_ENGINES);
      for (const id of LEGACY_ENGINE_IDS) {
        const legacy = legacyAgentEngine(id as DatabaseType);
        expect(grantedAgentLanguage(id)).toBe(grantedAgentStatementLanguage(legacy, BUNDLED_CLIENT_PACKS));
        for (const mode of MODES) {
          for (const workflow of WORKFLOWS) {
            expect(workflowAvailability(mode, workflow, servedEngineRecord(id), tables)).toEqual(
              workflowAvailability(mode, workflow, legacy),
            );
          }
          expect(openWorkflows(mode, servedEngineRecord(id), tables)).toEqual(openWorkflows(mode, legacy));
        }
      }
      // A served declared facet states no plan estimate, so the plan-estimate set is one over both registries.
      const servedEstimates = new Set<string>(
        Object.values(packs).flatMap(({ planEstimateOperation }) =>
          planEstimateOperation === null ? [] : [planEstimateOperation],
        ),
      );
      expect(servedEstimates).toEqual(new Set<string>(PLAN_ESTIMATE_OPERATIONS));
    };
    census();
    installServerCatalog(composeServerCatalog([], [], STUDIO_GRANT_REGISTER));
    census();

    // Under a catalog granting a package its own language, each served declared facet still states no plan estimate.
    forgetServerCatalog();
    installGranted();
    expect(servedClientPacks()[ACME]?.planEstimateOperation).toBeNull();
  });

  test("the server's client facts refuse a read while the catalog's boot is pending, and name a boot that ended by an error", () => {
    const reads: readonly (readonly [string, () => unknown])[] = [
      ["servedClientPacks", () => servedClientPacks()],
      ["servedAvailabilityTables", () => servedAvailabilityTables()],
      ["grantedAgentLanguage", () => grantedAgentLanguage("postgres")],
      ["runHeaderRefusal", () => runHeaderRefusal({ mode: "planning", statementLanguage: "sql" })],
    ];
    const refusals = (kind: new () => Error) =>
      reads.map(([name, read]) => {
        try {
          read();
          return [name, "answered"];
        } catch (error) {
          return [name, error instanceof kind ? kind.name : String(error)];
        }
      });

    beginServerCatalogBoot();
    expect(refusals(AgentLanguageCompositionOrderError)).toEqual(
      reads.map(([name]) => [name, AgentLanguageCompositionOrderError.name]),
    );
    endServerCatalogBootUnfinished();
    expect(refusals(AgentLanguageCatalogBootUnfinishedError)).toEqual(
      reads.map(([name]) => [name, AgentLanguageCatalogBootUnfinishedError.name]),
    );
    forgetServerCatalog();
    expect(runHeaderRefusal({ mode: "planning", statementLanguage: "sql" })).toBeNull();
  });

  test("no server module reads the browser's composition of the statement languages", () => {
    const BROWSER_COMPOSITION: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
      "src/lib/agent/languages/client": new Set([
        "BUNDLED_CLIENT_PACKS",
        "DECLARED_AGENT_LANGUAGES",
        "languageClientPack",
        "projectClientPacks",
      ]),
      "src/lib/agent/agent-manifest": new Set([
        "AGENT_LANGUAGE_COPY",
        "AGENT_WORKFLOW_VARIANTS",
        "AGENT_PLAN_ESTIMATE_OPERATION",
      ]),
    });
    // The modules of the browser's tier that read it (client-import-boundary.test.ts's entries).
    const BROWSER_READERS = [
      "src/components/agent/AgentRail.tsx",
      "src/lib/agent/agent-manifest.ts",
      "src/lib/agent/posture.ts",
    ];

    /** The module a specifier names, relative to the root and with no extension, or null for a package. */
    const resolved = (file: string, specifier: string): string | null => {
      if (specifier.startsWith("@/")) return path.posix.join("src", specifier.slice(2)).replace(/\.tsx?$/, "");
      if (!specifier.startsWith(".")) return null;
      return path.posix.join(path.posix.dirname(file), specifier).replace(/\.tsx?$/, "");
    };

    /** Each read of the browser's composition `text`, as source file `file`, imports or re-exports. */
    const readsIn = (file: string, text: string): string[] => {
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const found: string[] = [];
      for (const statement of source.statements) {
        const declaration =
          ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement : undefined;
        const specifier = declaration?.moduleSpecifier;
        if (declaration === undefined || specifier === undefined || !ts.isStringLiteral(specifier)) continue;
        const target = resolved(file, specifier.text);
        const names = target === null ? undefined : BROWSER_COMPOSITION[target];
        if (names === undefined) continue;
        if (ts.isImportDeclaration(declaration)) {
          const clause = declaration.importClause;
          if (clause === undefined || clause.isTypeOnly) continue;
          const bindings = clause.namedBindings;
          if (bindings !== undefined && ts.isNamespaceImport(bindings))
            found.push(`${file}: * as ${bindings.name.text}`);
          if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              const name = (element.propertyName ?? element.name).text;
              if (!element.isTypeOnly && names.has(name)) found.push(`${file}: ${name}`);
            }
          }
          continue;
        }
        if (declaration.isTypeOnly) continue;
        const clause = declaration.exportClause;
        if (clause === undefined || ts.isNamespaceExport(clause)) {
          found.push(`${file}: export *`);
          continue;
        }
        for (const element of clause.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (!element.isTypeOnly && names.has(name)) found.push(`${file}: ${name}`);
        }
      }
      return found;
    };

    const sources = (directory: string): string[] =>
      readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
        const relative = path.posix.join(directory, entry.name);
        if (entry.isDirectory()) return sources(relative);
        return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative] : [];
      });

    const reads = sources("src").flatMap((file) => readsIn(file, readFileSync(path.join(ROOT, file), "utf8")));
    const importers = [...new Set(reads.map((read) => read.slice(0, read.indexOf(":"))))].sort();
    expect(importers).toEqual(BROWSER_READERS);

    // The guard finds a planted read: the copy table imported into the run loop.
    const investigation = "src/lib/agent/investigation.ts";
    const planted = `import { AGENT_LANGUAGE_COPY } from "./agent-manifest";\n${readFileSync(path.join(ROOT, investigation), "utf8")}`;
    expect(readsIn(investigation, planted)).toEqual([`${investigation}: AGENT_LANGUAGE_COPY`]);
    expect(readsIn(investigation, `export * from "@/lib/agent/languages/client";\n`)).toEqual([
      `${investigation}: export *`,
    ]);
  });
});
