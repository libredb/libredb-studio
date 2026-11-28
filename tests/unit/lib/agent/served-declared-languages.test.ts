/**
 * The server's registries of the statement languages declared as data are composed from the installed server catalog,
 * whenever their modules loaded: the server packs, the whole packs, the MCP facets, the workflow tool rules, the tool
 * arms and the declared read descriptors each read the language data of the served records whose grant names it,
 * through one accessor (`servedLanguageData` in src/lib/db/operations/served-language-data.ts), memoized per installed
 * catalog. With nothing installed, or with Studio's own catalog installed, they compose the legacy records' data, which
 * is the bundled set the browser composes (src/lib/agent/languages/client.ts).
 *
 * Every registry moduleLanguage is imported statically, so each has loaded before any case composes and installs a catalog: a
 * registry composed when its module loads would answer the bundled set here. Each case forgets the catalog it installs.
 * A planted package `acme-served` serves engine `acmeserved`, whose declaration states `acmeread`
 * (tests/helpers/declared-agent-language.ts) and requests it as its agent statement language.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parseGrantRegister, type RegisterGrants, type RegisterRow } from "@libredb/grant-register";
import type { StatementLanguageData } from "@libredb/provider-sdk/manifest";
import { AGENT_LANGUAGE_COPY, type AgentDeclaredLanguageId } from "@/lib/agent/agent-manifest";
import { composeDeclaredLanguages, DECLARED_AGENT_LANGUAGES, languageClientPack } from "@/lib/agent/languages/client";
import { agentLanguagePack, languageToolArms } from "@/lib/agent/languages/index";
import { agentEnginePack } from "@/lib/agent/languages/engines/index";
import { agentLanguageMcpFacets } from "@/lib/agent/languages/mcp";
import { OPERATIONS_TOOL_RULE } from "@/lib/agent/languages/shared";
import { languageServer, languageServerPack, workflowToolRules } from "@/lib/agent/languages/server";
import { STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import { BUNDLED_STATEMENT_LANGUAGE_DATA } from "@/lib/db/engine-catalog/statement-language.generated";
import { languageDataSha256 } from "@/lib/db/language-digest";
import { createCanonicalOperationRegistry, isStatementReadOperation } from "@/lib/db/operations/descriptors";
import {
  AgentLanguageCatalogBootUnfinishedError,
  AgentLanguageCompositionOrderError,
  servedLanguageData,
} from "@/lib/db/operations/served-language-data";
import {
  beginServerCatalogBoot,
  endServerCatalogBootUnfinished,
  forgetServerCatalog,
  installServerCatalog,
  type ServerCatalog,
  servedEngines,
} from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import {
  McpCatalogBootUnfinishedError,
  McpCompositionOrderError,
  mcpStatementSurface,
  servingStatementArms,
} from "@/lib/mcp/tools/statement-arms";
import { acmereadData } from "../../../helpers/declared-agent-language";
import {
  admittedFor,
  admittedManifest,
  declaredLanguageSha256,
  packageRow,
  withEngineRecord,
  withStatementLanguageData,
} from "../../../helpers/package-catalog";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const ACME = "acmeread" as AgentDeclaredLanguageId;

afterEach(() => forgetServerCatalog());

/** A package serving engine `engine`, whose declaration states `data` and requests its name as its agent language. */
function languagePackage(name: string, engine: string, data: NonNullable<StatementLanguageData>) {
  const manifest = admittedManifest(engine, (declared) => {
    declared.agent = { statementLanguage: data.name, overlay: { dialect: null, grounding: null } };
    withStatementLanguageData(declared, data);
  });
  return { pkg: admittedFor(name, manifest), manifest, engine };
}

type LanguagePackage = ReturnType<typeof languagePackage>;

/** `planted`'s register row granting its language under the digest of the data it declares, changed by `grants`. */
function grantingRow(planted: LanguagePackage, grants: Partial<RegisterGrants> = {}): RegisterRow {
  const data = planted.manifest.engines[0]?.statementLanguageData as NonNullable<StatementLanguageData>;
  return packageRow(planted.pkg, planted.engine, {
    statementLanguage: data.name,
    languageSha256: declaredLanguageSha256(planted.manifest),
    ...grants,
  });
}

/** The catalog of `planted`, each engine granted its row of `rows`. */
function catalogOf(planted: readonly LanguagePackage[], rows: readonly RegisterRow[]): ServerCatalog {
  return composeServerCatalog(
    planted.map(({ pkg }) => pkg),
    [],
    parseGrantRegister([...rows], LEGACY_ENGINE_IDS),
  );
}

/** The acmeread package with its row granting it, composed and installed. */
function installServed(): LanguagePackage {
  const planted = languagePackage("acme-served", "acmeserved", acmereadData());
  installServerCatalog(catalogOf([planted], [grantingRow(planted)]));
  return planted;
}

/** The ids `servedLanguageData` answers, in order. */
function servedNames(): string[] {
  return servedLanguageData().map(({ name }) => name);
}

describe("the server's declared language registries", () => {
  test("the declared registries are composed from the installed catalog, whenever their modules loaded", () => {
    const planted = installServed();
    const data = planted.manifest.engines[0]?.statementLanguageData as NonNullable<StatementLanguageData>;
    const agent = data.agent as NonNullable<typeof data.agent>;

    // The record's data, by reference: the admitted declaration's own.
    expect(servedLanguageData().at(-1)).toBe(data);
    expect(servedNames()).toEqual(["kafkaread", "acmeread"]);

    const server = languageServerPack(ACME);
    expect<string>(server.adapter.readOperation).toBe("acmeread.query.read");
    expect(languageServer(ACME)).toBe(server.adapter);
    const pack = agentLanguagePack(ACME);
    expect<string>(pack.id).toBe("acmeread");
    expect(pack.server).toBe(server);
    expect(pack.client.copy.noun).toBe(agent.text.copy.noun as string);
    expect(pack.client.copy.argument).toBe("statement");
    expect(pack.execution).toEqual({ arms: {}, evidenceTools: {} });
    expect(workflowToolRules()[ACME]).toBe(server.workflowToolRules);
    expect(workflowToolRules()[ACME]).toEqual({
      investigation: agent.text.investigation.toolRule as string,
      operations: OPERATIONS_TOOL_RULE,
    });
    expect(languageToolArms()[ACME]).toBe(pack.execution.arms);
    expect<string | undefined>(agentLanguageMcpFacets()[ACME]?.tool).toBe("run_acme_read");
    expect(createCanonicalOperationRegistry().registeredIds()).toContain("acmeread.query.read");
    expect(isStatementReadOperation("acmeread.query.read")).toBe(true);

    // MCP composes the arm from the server's composed facet, and serves it on no engine until a package engine's
    // execution profiles are served.
    const arm = mcpStatementSurface().arms[ACME];
    if (arm === null || arm === undefined) throw new Error("the served declared language's facet builds no arm");
    expect<string>(arm.tool).toBe("run_acme_read");
    expect<readonly string[]>(arm.types).toEqual([]);
    expect(servingStatementArms()).not.toContain(arm);
    expect(arm.argument).toBe("statement");
    const refused = JSON.stringify({ read: "topics", topic: "not-taken" });
    const refusal = languageServer(ACME).admit?.(refused) ?? null;
    if (refusal === null) throw new Error("the planted request form admits the refused request");
    expect(arm.fence(refused, "mqtt")).toBe(
      `The ${agent.text.copy.noun as string} was refused before it reached ${agent.text.copy.reached as string} (${refusal.code}). ${refusal.message}`,
    );

    // Forgotten, the bundled set again: each registry refuses or answers false by its existing named error.
    forgetServerCatalog();
    expect(servedNames()).toEqual(["kafkaread"]);
    expect(() => languageServerPack(ACME)).toThrow("no server adapter for acmeread");
    expect(() => languageServer(ACME)).toThrow("no server adapter for acmeread");
    expect(() => agentLanguagePack(ACME)).toThrow("no language pack for acmeread");
    expect(Object.keys(workflowToolRules())).not.toContain("acmeread");
    expect(Object.keys(languageToolArms())).not.toContain("acmeread");
    expect(Object.keys(agentLanguageMcpFacets())).not.toContain("acmeread");
    expect(createCanonicalOperationRegistry().registeredIds()).not.toContain("acmeread.query.read");
    expect(isStatementReadOperation("acmeread.query.read")).toBe(false);
    expect(Object.keys(mcpStatementSurface().arms)).not.toContain("acmeread");
  });

  test("an admitted package's language data its row does not grant is composed into no registry", () => {
    const planted = languagePackage("acme-served", "acmeserved", acmereadData());
    const data = planted.manifest.engines[0]?.statementLanguageData as NonNullable<StatementLanguageData>;
    // One byte of one text changed: the digest of other data than the package declares.
    const other = structuredClone(data) as { agent: { text: { copy: { noun: string } } } };
    other.agent.text.copy.noun = `${other.agent.text.copy.noun}x`;
    const otherDigest = languageDataSha256(other as unknown as NonNullable<StatementLanguageData>);
    expect(otherDigest).not.toBe(declaredLanguageSha256(planted.manifest));
    const ungranted: readonly (readonly RegisterRow[])[] = [
      [],
      [grantingRow(planted, { languageSha256: otherDigest })],
      [grantingRow(planted, { statementLanguage: "acmeother" })],
    ];
    for (const rows of ungranted) {
      installServerCatalog(catalogOf([planted], rows));
      expect(servedEngines().get("acmeserved")?.statementLanguageData).toBe(data);
      expect(servedNames()).toEqual(["kafkaread"]);
      expect(() => languageServerPack(ACME)).toThrow("no server adapter for acmeread");
      expect(() => agentLanguagePack(ACME)).toThrow("no language pack for acmeread");
      expect(Object.keys(workflowToolRules())).not.toContain("acmeread");
      expect(Object.keys(languageToolArms())).not.toContain("acmeread");
      expect(Object.keys(agentLanguageMcpFacets())).not.toContain("acmeread");
      expect(isStatementReadOperation("acmeread.query.read")).toBe(false);
      expect(Object.keys(mcpStatementSurface().arms)).not.toContain("acmeread");
      forgetServerCatalog();
    }
  });

  test("with nothing installed and with Studio's own catalog installed, the served declared languages are the bundled ones, each data object and client facet the browser's own", () => {
    const census = () => {
      const served = composeDeclaredLanguages(servedLanguageData());
      expect(served.map(({ id }) => id)).toEqual(DECLARED_AGENT_LANGUAGES.map(({ id }) => id));
      served.forEach((language, index) => expect(language.agent).toBe(DECLARED_AGENT_LANGUAGES[index]?.agent));
      // No legacy engine states data its record does not grant: every stated agent part is served.
      const stated = Object.values(BUNDLED_STATEMENT_LANGUAGE_DATA).filter((data) => data !== null);
      expect(servedLanguageData()).toEqual(stated);
      servedLanguageData().forEach((data, index) => expect(data).toBe(stated[index]));
      for (const { id } of served) {
        expect(agentLanguagePack(id).client).toBe(languageClientPack(id));
        const engines = [...servedEngines().values()].filter((engine) => engine.grants.statementLanguage === id);
        expect(engines.length).toBeGreaterThan(0);
        for (const engine of engines) expect(agentEnginePack(engine.id)).toBe(agentLanguagePack(id));
      }
      // The tables keyed by language are the browser's languages, in its order.
      expect(Object.keys(workflowToolRules())).toEqual(Object.keys(AGENT_LANGUAGE_COPY));
      expect(Object.keys(languageToolArms())).toEqual(Object.keys(AGENT_LANGUAGE_COPY));
      expect(Object.keys(agentLanguageMcpFacets())).toEqual(Object.keys(AGENT_LANGUAGE_COPY));
    };
    // Vacuity: the bundled declarations state an agent language.
    expect(DECLARED_AGENT_LANGUAGES.length).toBeGreaterThan(0);
    census();
    installServerCatalog(composeServerCatalog([], [], STUDIO_GRANT_REGISTER));
    census();
  });

  test("a read while the catalog's boot is pending is a named composition-order error, and one after a boot that ended by an error names that boot", () => {
    const moduleLanguage = Object.keys(languageToolArms())[0] as AgentDeclaredLanguageId;
    const reads: readonly (readonly [string, () => unknown])[] = [
      ["servedLanguageData", () => servedLanguageData()],
      ["languageServerPack", () => languageServerPack(moduleLanguage)],
      ["languageServer", () => languageServer(moduleLanguage)],
      ["agentLanguagePack", () => agentLanguagePack(moduleLanguage)],
      ["workflowToolRules", () => workflowToolRules()],
      ["languageToolArms", () => languageToolArms()],
      ["agentLanguageMcpFacets", () => agentLanguageMcpFacets()],
      ["createCanonicalOperationRegistry", () => createCanonicalOperationRegistry()],
      ["isStatementReadOperation", () => isStatementReadOperation("acmeread.query.read")],
    ];
    const refusals = (kind: new () => Error) =>
      reads.map(([name, read]) => {
        try {
          read();
          return [name, "answered"];
        } catch (error) {
          return [name, error instanceof kind ? (error as Error).message : String(error)];
        }
      });

    beginServerCatalogBoot();
    const order = new AgentLanguageCompositionOrderError();
    expect(order.name).toBe("AgentLanguageCompositionOrderError");
    expect(order.message).toBe(
      "Agent mode's statement languages were read while the server's engine catalog was still being composed at boot. Boot installs the catalog before the server serves any request, so this read is a defect of Studio's own composition order.",
    );
    expect(refusals(AgentLanguageCompositionOrderError)).toEqual(reads.map(([name]) => [name, order.message]));
    // MCP's statement tools answer their own error first.
    expect(() => mcpStatementSurface()).toThrow(McpCompositionOrderError);

    endServerCatalogBootUnfinished();
    const unfinished = new AgentLanguageCatalogBootUnfinishedError();
    expect(unfinished.name).toBe("AgentLanguageCatalogBootUnfinishedError");
    expect(unfinished.message).toBe(
      "Agent mode's statement languages were read after the server's engine catalog's boot began and did not finish: the boot ended by an error before it installed the catalog, so no statement language is composed.",
    );
    expect(refusals(AgentLanguageCatalogBootUnfinishedError)).toEqual(
      reads.map(([name]) => [name, unfinished.message]),
    );
    expect(() => mcpStatementSurface()).toThrow(McpCatalogBootUnfinishedError);

    forgetServerCatalog();
    expect(servedNames()).toEqual(["kafkaread"]);
    expect(languageServerPack(moduleLanguage)).toBe(agentLanguagePack(moduleLanguage).server);
  });

  test("each registry is composed once per installed catalog, and a newly installed catalog composes its own", () => {
    installServed();
    const first = {
      data: servedLanguageData(),
      server: languageServerPack(ACME),
      pack: agentLanguagePack(ACME),
      facets: agentLanguageMcpFacets(),
      rules: workflowToolRules(),
      arms: languageToolArms(),
    };
    expect(servedLanguageData()).toBe(first.data);
    expect(Object.isFrozen(first.data)).toBe(true);
    expect(languageServerPack(ACME)).toBe(first.server);
    expect(agentLanguagePack(ACME)).toBe(first.pack);
    expect(agentLanguageMcpFacets()).toBe(first.facets);
    expect(workflowToolRules()).toBe(first.rules);
    expect(languageToolArms()).toBe(first.arms);
    forgetServerCatalog();

    installServed();
    expect(servedLanguageData()).not.toBe(first.data);
    expect(languageServerPack(ACME)).not.toBe(first.server);
    expect(agentLanguagePack(ACME)).not.toBe(first.pack);
    expect(agentLanguageMcpFacets()).not.toBe(first.facets);
    expect(workflowToolRules()).not.toBe(first.rules);
    expect(languageToolArms()).not.toBe(first.arms);
  });

  test("a granted language two served engines declare, or one a module language holds, fails the registries' first read by name", () => {
    // The catalog's set rules refuse both compositions at boot (`statement-language`). The registries' named error
    // remains the host defect for a catalog composed past the rule, crafted here, and for bundled declarations.
    const one = languagePackage("acme-one", "acmeone", acmereadData());
    const two = languagePackage("acme-two", "acmetwo", acmereadData());
    expect(() => catalogOf([one, two], [grantingRow(one), grantingRow(two)])).toThrow(
      "the admitted packages still conflict (acme-one 1.0.0 statement-language, acme-two 1.0.0 statement-language)",
    );
    // Each package composed on its own, the second's record added to the first's catalog.
    const engines = new Map(catalogOf([one], [grantingRow(one)]).engines);
    const second = catalogOf([two], [grantingRow(two)]).engines.get(two.engine);
    if (second === undefined) throw new Error(`the composition of ${two.pkg.name} holds no record of ${two.engine}`);
    engines.set(two.engine, second);
    installServerCatalog(Object.freeze({ engines, unavailable: new Map() }));
    for (const read of [() => languageServerPack(ACME), () => agentLanguageMcpFacets(), () => workflowToolRules()]) {
      expect(read).toThrow('The statement language "acmeread" is declared as data twice.');
    }
    forgetServerCatalog();

    // The module language's name is read from the registry, never written here; the first id is the default family,
    // whose name no declaration may state.
    const moduleLanguage = Object.keys(languageToolArms())[1] as string;
    const named = languagePackage("acme-module", "acmemodule", acmereadData(moduleLanguage));
    expect(() => catalogOf([named], [grantingRow(named)])).toThrow(
      "the admitted packages still conflict (acme-module 1.0.0 statement-language)",
    );
    // Composed with no row, its record then given the grant the rule refuses.
    installServerCatalog(
      withEngineRecord(catalogOf([named], []), named.engine, (engine) => ({
        ...engine,
        grants: Object.freeze({ ...engine.grants, statementLanguage: moduleLanguage }),
      })),
    );
    for (const read of [
      () => languageServerPack(moduleLanguage as AgentDeclaredLanguageId),
      () => agentLanguageMcpFacets(),
      () => languageToolArms(),
    ]) {
      expect(read).toThrow(
        `The statement language ${JSON.stringify(moduleLanguage)} is declared as data and is also a module language of this build.`,
      );
    }
  });

  test("no server registry composes a declared language when its module loads", () => {
    const COMPOSERS = new Set([
      "servedLanguageData",
      "composeDeclaredLanguages",
      "declaredClientPack",
      "composeDeclaredServerPack",
      "declaredMcpFacets",
      "declaredLanguageReadDescriptor",
      "BUNDLED_STATEMENT_LANGUAGE_DATA",
      "DECLARED_AGENT_LANGUAGES",
    ]);
    const files = [
      "src/lib/agent/languages/server.ts",
      "src/lib/agent/languages/index.ts",
      "src/lib/agent/languages/mcp.ts",
      "src/lib/db/operations/descriptors.ts",
    ];
    const loadTimeReads = files.flatMap((file) => {
      const source = ts.createSourceFile(
        file,
        readFileSync(path.join(ROOT, file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const found: string[] = [];
      const visit = (node: ts.Node): void => {
        // A function's body runs when it is called, never when its module loads, and a type is no value.
        if (ts.isFunctionLike(node) || ts.isTypeNode(node)) return;
        if (ts.isIdentifier(node) && COMPOSERS.has(node.text)) found.push(`${file}: ${node.text}`);
        ts.forEachChild(node, visit);
      };
      for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement)) continue;
        visit(statement);
      }
      return found;
    });
    expect(loadTimeReads).toEqual([]);
  });
});
