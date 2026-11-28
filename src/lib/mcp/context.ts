import type { AuthInfo } from "@modelcontextprotocol/server";
import type { Role } from "@/lib/auth";
import { metadataTreeTarget } from "@/lib/api/editor-provider";
import { editorExecutionContext } from "@/lib/api/execution-context";
import type { TreeTarget } from "@/lib/api/session-target";
import type { EngineGrants } from "@/lib/db/claim-grants";
import { StudioProfileRefusal } from "@/lib/db/errors";
import { type EngineRecord, legacyProviderType, servedEngineRecord } from "@/lib/db/server-catalog";
import { acquireExecutionProfileProvider, type ExecutionProfile } from "@/lib/db/factory";
import type { OpenWait } from "@/lib/provider-host/core/open-once";
import { connectionTextScrub, type ProviderTextScrub } from "@/lib/db/operations/provider-text";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { logger } from "@/lib/logger";
import { getManagedConnections, seedRolesOf, type ManagedConnection } from "@/lib/seed";
import { resolveVaultCredentials } from "@/lib/seed/credential-resolver";
import { VaultError } from "@/lib/seed/vault-client";
import { mcpConnectionUnavailable } from "./availability";
import { redactError } from "./serializer";

/** The answer of a context whose seed file could not be loaded; the cause is logged, never sent. */
export const MCP_CONNECTIONS_UNREADABLE = "unreadable";
export const MCP_CONNECTIONS_UNREADABLE_TEXT =
  "The connection configuration could not be read, so no connection is available. The server log names the cause.";

/**
 * The MCP tools' view of the connections one caller may use (#246).
 *
 * One instance per request, built by an SDK server factory around the verified identity. The seed
 * file is read lazily, the first time a tool asks for connections or the per-token tools/list asks
 * which engines the caller reaches (`reachableTypes`), so initialize and server/discover never
 * depend on it, and within one request it is read once.
 *
 * Acquisition goes through the provider factory alone, by what the connection's engine record offers:
 * `acquireExecutionProfileProvider` (`acquire`) for a record that offers execution profiles, a legacy engine's, and the
 * record's metadata session (`metadataTarget`, `metadataTreeTarget` in src/lib/api/editor-provider.ts) for a provider
 * package's, whose session opens through its package with no agent credential and no read roots (clause C-109), so
 * MCP reads only its schema there. The factory joins concurrent first opens of one connection and profile or session
 * into one open, on its own key, and a failed one is retried by the next caller (docs/providers/CONTRACT.md, clause
 * C-44), so this context keeps no table of its own. Every acquisition hands the factory the caller's wait, so the open
 * releases a call that stopped waiting (clause C-81, `acquireWithinCall` and `metadataTargetWithinCall`).
 *
 * A seed file that cannot be loaded answers MCP_CONNECTIONS_UNREADABLE, which every tool turns
 * into its own explicit error.
 *
 * The listing hands a `${vault:...}` reference back unresolved, as the managed list does, so it is
 * read at acquisition, after the role filter and before the cache key, exactly as resolveConnection
 * reads it for the editor and agent routes; a literal connection is the text it carries and is never
 * resolved. A reference that cannot be read refuses the open, with no fallback.
 */

export interface McpCaller {
  readonly username: string;
  readonly role: Role;
  readonly claimRoles?: readonly string[];
}

/**
 * The engines of the connections one token can read and some MCP open can serve (`reachableTypes`): what its
 * tools/list registers statement tools for, and what `inspect_schema`'s hints are read from.
 */
export type McpReach = ReadonlySet<ManagedConnection["type"]>;

export interface McpToolCall {
  readonly context: McpConnectionContext;
  readonly signal: AbortSignal;
}

/** The identity the verifier put on the token, and an explicit error when it is not there. */
export function mcpCaller(authInfo: AuthInfo): McpCaller {
  const username = authInfo.extra?.username;
  const role = authInfo.extra?.role;
  const claimRoles = authInfo.extra?.claimRoles;
  if (typeof username !== "string" || username === "" || (role !== "admin" && role !== "user")) {
    throw new Error("The verified MCP identity carries no username and role");
  }
  return {
    username,
    role,
    ...(Array.isArray(claimRoles) ? { claimRoles: claimRoles as string[] } : {}),
  };
}

/**
 * The connection with its `${vault:...}` references read, or a StudioProfileRefusal naming it, so both tools answer
 * the refusal in Studio's words. The VaultError's own text stays in the server log: it may quote the reference.
 */
async function resolvedSecrets(connection: ManagedConnection): Promise<ManagedConnection> {
  if (connection.literal) return connection;
  try {
    return await resolveVaultCredentials(connection);
  } catch (error) {
    if (!(error instanceof VaultError)) throw error;
    logger.error("Could not read a seed connection's Vault reference for MCP", redactError(error), {
      route: "/api/mcp",
      connectionId: connection.id,
    });
    throw new StudioProfileRefusal(
      `Connection "${connection.id}" could not be opened: a secret reference in its seed entry could not be read from Vault, so nothing was sent to the database. The server log names the cause.`,
      "CONNECTION_SECRET_UNRESOLVABLE",
    );
  }
}

/**
 * Refuses a connection of an engine MCP reads only under an agent credential of the seed's own when it carries
 * neither `agentUser` nor `agentPassword`, so it is never read under its own login: the seed schema refuses such a
 * seed at load, and this is the open's own check, for a connection built in memory or loaded past the schema. One
 * that sets either field is the factory's to hold to the engine's form. Read from the connection's engine record, its
 * `agentCredentialRequired` grant (`grantsOf`, injectable for the tests), never a type-id branch; the sentence names no
 * engine. A type the server's engine catalog serves no record of is refused through it (`servedEngineRecord`) before
 * any grant is read; `acquire` and `metadataTarget` call this check first, so such a connection is refused before any
 * secret is read or any provider built. A provider package's session opens through its package, which receives no
 * agent credential (clause C-109), so where the grant requires one on a record that offers no execution profile the
 * connection is refused whatever it carries: setting a field cannot help, and the sentence says so.
 *
 * @throws {ProviderUnavailableError} For an engine only refused provider packages name.
 * @throws {UnknownProviderError} For a type that names no engine (FND-1).
 * @throws {StudioProfileRefusal} `AGENT_CREDENTIAL_REQUIRED`, for a connection with no agent credential where its
 * engine record requires one, and for every connection of a record that requires one and offers no execution profile.
 */
export function assertAgentCredentialWhereRequired(
  connection: ManagedConnection,
  grantsOf: (type: DatabaseType) => Pick<EngineGrants, "agentCredentialRequired"> = (type) =>
    servedEngineRecord(type).grants,
): void {
  const engine = servedEngineRecord(connection.type);
  if (!grantsOf(connection.type).agentCredentialRequired) return;
  if (!engine.offers.executionProfiles) {
    throw new StudioProfileRefusal(
      `Connection "${connection.id}" is read by MCP only under a read credential of its own, and its engine's session opens through its provider package, which receives none, so MCP cannot read it: an operator reads it in the editor instead.`,
      "AGENT_CREDENTIAL_REQUIRED",
    );
  }
  if (connection.agentUser !== undefined || connection.agentPassword !== undefined) return;
  throw new StudioProfileRefusal(
    `Connection "${connection.id}" is read by MCP only under a read credential of its own (agentUser and agentPassword), and it has none: an operator sets agentUser and agentPassword on this seed.`,
    "AGENT_CREDENTIAL_REQUIRED",
  );
}

/**
 * Refuses a connection of an engine MCP reads only beneath read roots its seed declares when it declares none, so it is
 * never read across the whole server: the seed schema refuses such a seed at load, and this is the open's own check,
 * for a connection built in memory or loaded past the schema. Read from the connection's engine record, its
 * `readRootsRequired` grant (`grantsOf`, injectable for the tests), never a type-id branch. A type the server's engine
 * catalog serves no record of is refused through it, as `assertAgentCredentialWhereRequired` refuses it, before any
 * grant is read. A provider package's session opens through its package, which receives no read roots (clause C-109),
 * so where the grant requires them on a record that offers no execution profile the connection is refused whatever it
 * declares.
 *
 * @throws {ProviderUnavailableError} For an engine only refused provider packages name.
 * @throws {UnknownProviderError} For a type that names no engine (FND-1).
 * @throws {StudioProfileRefusal} `READ_ROOTS_REQUIRED`, for a connection with no read roots where its engine record
 * requires them, and for every connection of a record that requires them and offers no execution profile.
 */
export function assertReadRootsWhereRequired(
  connection: ManagedConnection,
  grantsOf: (type: DatabaseType) => Pick<EngineGrants, "readRootsRequired"> = (type) => servedEngineRecord(type).grants,
): void {
  const engine = servedEngineRecord(connection.type);
  if (!grantsOf(connection.type).readRootsRequired) return;
  if (!engine.offers.executionProfiles) {
    throw new StudioProfileRefusal(
      `Connection "${connection.id}" is read by MCP only beneath read roots its seed entry declares, and its engine's session opens through its provider package, which receives none, so MCP cannot read it: an operator reads it in the editor instead.`,
      "READ_ROOTS_REQUIRED",
    );
  }
  if (connection.agentReadRoots !== undefined) return;
  throw new StudioProfileRefusal(
    `Connection "${connection.id}" is read by MCP only beneath read roots its seed entry declares, and it declares none: an operator sets agentReadRoots on this seed.`,
    "READ_ROOTS_REQUIRED",
  );
}

/**
 * The scrub of the providers MCP opens for `connection`, of `engine` (src/lib/db/operations/provider-text.ts): the
 * profiled providers' for a record that offers execution profiles, whose open hands the agent password in place of the
 * connection's own where one is configured, and every provider's for a provider package's record, whose open receives
 * the connection's own login (clause C-109).
 */
export function mcpTextScrub(connection: ManagedConnection, engine: EngineRecord): ProviderTextScrub {
  return connectionTextScrub(
    connection,
    legacyProviderType(engine),
    engine.offers.executionProfiles ? "profiled" : "any",
  );
}

export class McpConnectionContext {
  private visible: Promise<readonly ManagedConnection[] | typeof MCP_CONNECTIONS_UNREADABLE> | null = null;
  /**
   * The open of each listed connection this request made, keyed by the listed record itself, so two records that
   * share an id and not their credentials are never joined: the open's own checks, then its Vault
   * references read. `textScrub` and `acquire` share it, so Vault is read once per call and in the order it always
   * was, before any provider is built. An open that refused stays refused for the rest of the request.
   */
  private readonly opened = new Map<ManagedConnection, Promise<ManagedConnection>>();

  constructor(readonly caller: McpCaller) {}

  visibleConnections(): Promise<readonly ManagedConnection[] | typeof MCP_CONNECTIONS_UNREADABLE> {
    this.visible ??= this.load();
    return this.visible;
  }

  async resolve(connectionId: string): Promise<ManagedConnection | null | typeof MCP_CONNECTIONS_UNREADABLE> {
    const visible = await this.visibleConnections();
    if (visible === MCP_CONNECTIONS_UNREADABLE) return visible;
    return visible.find((connection) => connection.id === connectionId) ?? null;
  }

  /**
   * The engines of the visible connections some MCP open can serve for this caller (`mcpConnectionUnavailable`): what
   * one token's tools/list registers statement tools for. It reads the listing this context holds, so it builds no
   * provider and reads no Vault reference, and answers MCP_CONNECTIONS_UNREADABLE when the seed file cannot be loaded.
   */
  async reachableTypes(): Promise<McpReach | typeof MCP_CONNECTIONS_UNREADABLE> {
    const visible = await this.visibleConnections();
    if (visible === MCP_CONNECTIONS_UNREADABLE) return visible;
    return new Set(
      visible
        .filter((connection) => mcpConnectionUnavailable(this.caller, connection) === null)
        .map((connection) => connection.type),
    );
  }

  /**
   * The scrub of the connection a call opens (src/lib/db/operations/provider-text.ts), over its secrets as resolved:
   * a Vault-backed secret is a reference on the listed connection and a value only once the open has read it, so
   * the scrub is taken from the open, which a tool asks for before it acquires, over the providers the connection's
   * engine record has MCP open (`mcpTextScrub`). It refuses as the open refuses.
   */
  async textScrub(listed: ManagedConnection): Promise<ProviderTextScrub> {
    const connection = await this.open(listed);
    return mcpTextScrub(connection, servedEngineRecord(connection.type));
  }

  /**
   * The provider of the listed connection under `profile`, opened with the caller's `wait`: the open stops waiting for
   * this call with the wait's reason when its signal aborts, and goes on for any other caller.
   */
  async acquire(listed: ManagedConnection, profile: ExecutionProfile, wait: OpenWait): Promise<DatabaseProvider> {
    const connection = await this.open(listed);
    // The caller's editor posture on this connection (non-admin DuckDB file access): it decides whether a
    // SQLite handle opens at all and which open single-writer handle an operations acquisition may
    // borrow, and it is part of the key, so it is derived first; every caller that can resolve one seed
    // shares it.
    const requester = editorExecutionContext(this.caller, connection);
    return acquireExecutionProfileProvider(connection, profile, {}, requester, wait);
  }

  /**
   * The tree target of the listed connection's metadata session, for a provider package's record, opened with the
   * caller's `wait` as `acquire` opens a legacy engine's provider (`metadataTreeTarget` in src/lib/api/editor-provider.ts,
   * clause C-66): under the caller's editor posture, through the package's own `open`, shared with the editor's tree
   * reads of the same connection, owner and posture.
   *
   * @throws {Error} A host defect: for a record that offers execution profiles, whose schema MCP reads under the
   *   agent-operations profile (`acquire`).
   */
  async metadataTarget(listed: ManagedConnection, wait: OpenWait): Promise<TreeTarget> {
    const connection = await this.open(listed);
    const engine = servedEngineRecord(connection.type);
    if (engine.offers.executionProfiles) {
      throw new Error(
        "MCP reads a legacy engine's schema under the agent-operations profile (`acquire`), never on its metadata session: a host defect.",
      );
    }
    return metadataTreeTarget(this.caller, connection, engine, wait);
  }

  /** The listed connection checked and its Vault references read, once per request (`opened`). */
  private open(listed: ManagedConnection): Promise<ManagedConnection> {
    let opening = this.opened.get(listed);
    if (opening === undefined) {
      opening = (async () => {
        assertAgentCredentialWhereRequired(listed);
        assertReadRootsWhereRequired(listed);
        return resolvedSecrets(listed);
      })();
      this.opened.set(listed, opening);
    }
    return opening;
  }

  /**
   * Only what the operator opted in: a seed entry without mcp: true, and every built-in sample,
   * is not visible. A file that cannot be loaded is an answer of its own, never an empty list,
   * because an empty list would tell the client there is nothing to reach when the truth is that
   * the server could not tell.
   */
  private async load(): Promise<readonly ManagedConnection[] | typeof MCP_CONNECTIONS_UNREADABLE> {
    try {
      const connections = await getManagedConnections(seedRolesOf(this.caller));
      return connections.filter((connection) => connection.mcp === true);
    } catch (error) {
      logger.error("Could not load managed connections for MCP", redactError(error), { route: "/api/mcp" });
      return MCP_CONNECTIONS_UNREADABLE;
    }
  }
}
