/**
 * A server catalog for the agent routes' tests of a provider package's engine, built in memory
 * (tests/helpers/package-catalog.ts): Studio's own engines beside four package engines, each the SDK's minimal manifest
 * with its id replaced, admitted and granted a register row only where named below.
 *
 * - `BARE`: the minimal manifest, no row: it requests no statement language and offers agent mode no reading.
 * - `REQUESTING`: the loosest claims, so it requests `sql`, and no row: not reviewed, and no reading.
 * - `READING`: the loosest claims, its row granting the `health` reading and no language.
 * - `EXECUTING`: the loosest claims, its row granting `sql` and agent execution and no reading, and reviewing no grammar
 *   (the row's `grammarSha256` is null while the manifest states SQL text).
 *
 * `agentPackageLanguageCatalog` is Studio's engines beside one more package engine, `AGENT_PACKAGE_LANGUAGE`, whose
 * declaration states the crafted language `acmeread` (tests/helpers/declared-agent-language.ts) and requests it with the
 * `health` reading, its row granting that language under the digest of the data it declares, agent execution and the
 * reading. Its package's console execute honours the request fields a case names (none by default), and where it
 * honours `readOnly` its row also grants `readRootsRequired: false`, so the factory opens its read-only statement
 * session; a case may name the digest its row grants the language under (`offByOneByte` of the declared one).
 *
 * `mcpPackageLanguageCatalog` is Studio's engines beside one package engine MCP serves on its own language's statement
 * tool: it declares the language data a case names (`acmereadData` with a name and tool of its own), requests MCP exposure and statement reads, and
 * its row grants the language under its digest, agent execution and every MCP claim, with no agent credential, read
 * roots or one session; its package honours `readOnly` unless the case names other request fields, and a case changes
 * any member of its row.
 *
 * No file is written and no package is imported; ids are fixture ids no bundled engine serves.
 */
import { parseGrantRegister, type RegisterGrants } from "@libredb/grant-register";
import type { StatementLanguageData } from "@libredb/provider-sdk/manifest";
import type { ServerCatalog } from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import { acmereadData } from "./declared-agent-language";
import {
  admittedFor,
  admittedManifest,
  declaredLanguageSha256,
  type EditableEngine,
  packageRow,
  withLoosestClaims,
  withStatementLanguageData,
} from "./package-catalog";

export const AGENT_PACKAGE_ENGINES = Object.freeze({
  BARE: "acmeagentbare",
  REQUESTING: "acmeagentrequesting",
  READING: "acmeagentreading",
  EXECUTING: "acmeagentexecuting",
} as const);

/** The catalog of Studio's engines and the four package engines of `AGENT_PACKAGE_ENGINES`. */
export function agentPackageCatalog(): ServerCatalog {
  const { BARE, REQUESTING, READING, EXECUTING } = AGENT_PACKAGE_ENGINES;
  const bare = admittedFor("acme-agent-bare", admittedManifest(BARE));
  const requesting = admittedFor("acme-agent-requesting", admittedManifest(REQUESTING, withLoosestClaims));
  const reading = admittedFor("acme-agent-reading", admittedManifest(READING, withLoosestClaims));
  const executing = admittedFor("acme-agent-executing", admittedManifest(EXECUTING, withLoosestClaims));
  const register = parseGrantRegister(
    [
      packageRow(reading, READING, { agentReadings: Object.freeze(["health"] as const) }),
      packageRow(executing, EXECUTING, { statementLanguage: "sql", agentExecution: true }),
    ],
    LEGACY_ENGINE_IDS,
  );
  return composeServerCatalog([bare, requesting, reading, executing], [], register);
}

/** The package engine of `agentPackageLanguageCatalog`, granted its own declared language `acmeread`. */
export const AGENT_PACKAGE_LANGUAGE = "acmeagentlanguage";

/** `digest`, a hex SHA-256, with its last byte's low bit flipped: a digest one byte off. */
export function offByOneByte(digest: string): string {
  const last = Number.parseInt(digest.slice(-2), 16) ^ 1;
  return `${digest.slice(0, -2)}${last.toString(16).padStart(2, "0")}`;
}

/** What `agentPackageLanguageCatalog` is built with. */
export interface AgentPackageLanguageOptions {
  /** The request fields its package's console execute honours; none by default. */
  readonly honours?: readonly string[];
  /** The digest its row grants the language under, from the declared one; the declared one by default. */
  readonly digest?: (declared: string) => string;
}

/** The catalog of Studio's engines and `AGENT_PACKAGE_LANGUAGE`, its row granting its own declared language. */
export function agentPackageLanguageCatalog(options: AgentPackageLanguageOptions = {}): ServerCatalog {
  const data = acmereadData();
  const honours = options.honours ?? [];
  const manifest = admittedManifest(
    AGENT_PACKAGE_LANGUAGE,
    (declared) => {
      declared.agent = { statementLanguage: data.name, overlay: { dialect: null, grounding: null } };
      declared.facets = { ...declared.facets, agentReadings: ["health"] };
      withStatementLanguageData(declared, data);
    },
    honours,
  );
  const spoken = admittedFor("acme-agent-language", manifest);
  const declaredDigest = declaredLanguageSha256(manifest);
  const register = parseGrantRegister(
    [
      packageRow(spoken, AGENT_PACKAGE_LANGUAGE, {
        statementLanguage: data.name,
        languageSha256: options.digest === undefined ? declaredDigest : options.digest(declaredDigest),
        agentExecution: true,
        agentReadings: Object.freeze(["health"] as const),
        ...(honours.includes("readOnly") && { readRootsRequired: false }),
      }),
    ],
    LEGACY_ENGINE_IDS,
  );
  return composeServerCatalog([spoken], [], register);
}

/** What `mcpPackageLanguageCatalog` plants: a package engine `id` declaring the statement language data `data`. */
export interface McpPackageLanguageOptions {
  /** The engine's id, a fixture id no bundled engine serves. */
  readonly id: string;
  /**
   * The language data its declaration states, `acmereadData(name, tool)` with a name and an MCP tool of the case's: one
   * language per package and one tool per granted language (the catalog's set rules).
   */
  readonly data: NonNullable<StatementLanguageData>;
  /** The request fields its package's console execute honours; `readOnly` by default. */
  readonly honours?: readonly string[];
  /** Members its register row grants beyond the plant's own, which they replace. */
  readonly row?: Partial<RegisterGrants>;
}

/**
 * The register row grants of a package engine that MCP serves on its own language's statement tool: the language under
 * `digest`, agent execution, every MCP claim, and neither an agent credential, read roots nor one session.
 */
export function mcpPackageLanguageRow(name: string, digest: string): Partial<RegisterGrants> {
  return {
    statementLanguage: name,
    languageSha256: digest,
    agentExecution: true,
    exposable: true,
    statementRead: true,
    agentCredentialRequired: false,
    readRootsRequired: false,
  };
}

/**
 * The engine declaration edit of a package engine MCP serves on its own language's tool: it requests MCP exposure and
 * statement reads with no agent credential, and states the language `data` as its agent statement language.
 */
export function withMcpPackageLanguage(data: NonNullable<StatementLanguageData>): (engine: EditableEngine) => void {
  return (engine) => {
    engine.mcp = { ...engine.mcp, exposable: true, statementRead: true, agentCredentialRequired: false };
    engine.agent = { statementLanguage: data.name, overlay: { dialect: null, grounding: null } };
    withStatementLanguageData(engine, data);
  };
}

/**
 * The catalog of Studio's engines and one more package engine, `options.id`, that declares the language data
 * `options.data`, its row granting that language under the digest of its data, agent execution and every MCP claim
 * (`mcpPackageLanguageRow`), changed by `options.row`; its package honours `readOnly` unless the case names other
 * request fields.
 */
export function mcpPackageLanguageCatalog(options: McpPackageLanguageOptions): ServerCatalog {
  const { data } = options;
  const manifest = admittedManifest(options.id, withMcpPackageLanguage(data), options.honours ?? ["readOnly"]);
  const spoken = admittedFor(`${options.id}-package`, manifest);
  const register = parseGrantRegister(
    [
      packageRow(spoken, options.id, {
        ...mcpPackageLanguageRow(data.name, declaredLanguageSha256(manifest)),
        ...options.row,
      }),
    ],
    LEGACY_ENGINE_IDS,
  );
  return composeServerCatalog([spoken], [], register);
}
