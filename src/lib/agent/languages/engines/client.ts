/**
 * The engines' client facets (#1821): each engine's family client facet with its client overlay applied.
 *
 * Client tier. It reads the family client facets (`languages/client.ts`) and the engine client overlays, never
 * `agent-manifest.ts` at run time, which reads this module: an engine's family is held beside its overlay instead, and
 * `AgentEngineClientOverlays` types it as the family `AGENT_STATEMENT_LANGUAGE` maps the engine onto. The registry is
 * total over `AgentEngineType` and declared in the order postgres, sqlite, duckdb, mssql, mysql, mongodb, kubernetes,
 * and like the server registry it copies only `dialect` out of each engine module.
 */
import type { DatabaseType } from "@/lib/types";
import type { AgentStatementLanguageId } from "../../agent-manifest";
import { languageClientPack } from "../client";
import { KUBERNETES_CLIENT_OVERLAY } from "../kubectl/engines/client";
import { MONGODB_CLIENT_OVERLAY } from "../mongo/engines/client";
import { defineOverlay, dialectOnly } from "../overlay";
import type { AgentEngineClientDialect, AgentEngineClientOverlays, AgentEnginePack, AgentEngineType } from "../pack";
import {
  CLICKHOUSE_CLIENT_OVERLAY,
  DUCKDB_CLIENT_OVERLAY,
  LIBSQL_CLIENT_OVERLAY,
  MSSQL_CLIENT_OVERLAY,
  MYSQL_CLIENT_OVERLAY,
  POSTGRES_CLIENT_OVERLAY,
  SQLITE_CLIENT_OVERLAY,
} from "../sql/engines/client";

const CLIENT_OVERLAYS: AgentEngineClientOverlays = Object.freeze({
  postgres: Object.freeze({ family: "sql", overlay: dialectOnly(POSTGRES_CLIENT_OVERLAY) }),
  sqlite: Object.freeze({ family: "sql", overlay: dialectOnly(SQLITE_CLIENT_OVERLAY) }),
  duckdb: Object.freeze({ family: "sql", overlay: dialectOnly(DUCKDB_CLIENT_OVERLAY) }),
  mssql: Object.freeze({ family: "sql", overlay: dialectOnly(MSSQL_CLIENT_OVERLAY) }),
  mysql: Object.freeze({ family: "sql", overlay: dialectOnly(MYSQL_CLIENT_OVERLAY) }),
  clickhouse: Object.freeze({ family: "sql", overlay: dialectOnly(CLICKHOUSE_CLIENT_OVERLAY) }),
  libsql: Object.freeze({ family: "sql", overlay: dialectOnly(LIBSQL_CLIENT_OVERLAY) }),
  mongodb: Object.freeze({ family: "mongo", overlay: dialectOnly(MONGODB_CLIENT_OVERLAY) }),
  kubernetes: Object.freeze({ family: "kubectl", overlay: dialectOnly(KUBERNETES_CLIENT_OVERLAY) }),
} satisfies AgentEngineClientOverlays);

/**
 * The family `type` speaks, read from the registry beside its overlay, or null for a type with no statement language
 * and for a name that is no own key (`toString`).
 */
export function engineFamily(type: DatabaseType): AgentStatementLanguageId | null {
  return Object.hasOwn(CLIENT_OVERLAYS, type) ? CLIENT_OVERLAYS[type as AgentEngineType].family : null;
}

/**
 * The client facet of `type`: its family's, with the engine's overlay applied, which is the family's own object while
 * the overlay is empty. A type that speaks no statement language has none, and asking is a named error.
 */
export function engineClientPack(type: DatabaseType): AgentEnginePack["client"] {
  const entry = Object.hasOwn(CLIENT_OVERLAYS, type) ? CLIENT_OVERLAYS[type as AgentEngineType] : undefined;
  if (entry === undefined) throw new Error(`no engine pack for ${type}`);
  const overlay: { readonly dialect?: AgentEngineClientDialect } = entry.overlay;
  return defineOverlay(languageClientPack(entry.family), overlay);
}

/**
 * The engines whose client dialect says `"supported"` for every member asked, in registry order and frozen: the
 * client's answer to which engines compose what, read from the overlays rather than restated beside them. An engine
 * whose family has no client dialect supports none.
 */
export function enginesSupporting(
  ...members: readonly [keyof AgentEngineClientDialect, ...(keyof AgentEngineClientDialect)[]]
): readonly DatabaseType[] {
  return Object.freeze(
    (Object.keys(CLIENT_OVERLAYS) as AgentEngineType[]).filter((type) => {
      const dialect: AgentEngineClientDialect | undefined = CLIENT_OVERLAYS[type].overlay.dialect;
      return dialect !== undefined && members.every((member) => dialect[member] === "supported");
    }),
  );
}
