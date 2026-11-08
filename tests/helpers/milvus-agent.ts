/**
 * The Milvus agent boundary captures (tests/fixtures/milvus/3.0.2/agent-boundary/, written by its run.sh): one file
 * per call a 3.0.2 server was sent raw, `<surface>-<principal>.json`, with the principal it was sent as and what the
 * server answered. `agentMilvusWire` replays them through the real adapter, as one principal's server.
 */
import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import type { MilvusRpc } from "@/lib/db/providers/vector/milvus/grpc-client";
import {
  capturedAnswer,
  capturedFailure,
  type MilvusCapture,
  milvusCapture,
  reviveMilvusFixture,
} from "./milvus-fixtures";
import { type RecordedMilvusAnswer, type RecordedMilvusWire, recordedMilvusWire } from "./milvus-wire";

export const MILVUS_AGENT_CAPTURES = posix.join(
  import.meta.dir.replaceAll("\\", "/"),
  "..",
  "fixtures",
  "milvus",
  "3.0.2",
  "agent-boundary",
);

/** The user each principal signs in as; `open-anonymous` sends no authorization. */
export const MILVUS_AGENT_USERS: Readonly<Record<string, string | undefined>> = {
  root: "root",
  reader: "agent_reader",
  dbro: "agent_dbro",
  rw: "agent_rw",
  admin: "agent_admin",
  custom: "agent_custom",
  clusterro: "agent_clusterro",
  nobody: "agent_nobody",
  midrun: "agent_midrun",
  elsewhere: "agent_elsewhere",
  rwother: "agent_rwother",
  "open-reader": "agent_reader",
  "open-anonymous": undefined,
};

export interface MilvusAgentCapture {
  readonly $captured: {
    readonly server: "authorization on" | "authorization off";
    readonly image: string;
    readonly version: string;
    readonly date: string;
    readonly runtime: string;
    readonly rpc: string;
    readonly principal: string;
    readonly rights: string;
    readonly surface: string;
    readonly request: unknown;
  };
  readonly outcome: "pass" | "fail";
  readonly payload: unknown;
}

/** One capture: `<surface>-<principal>.json`. */
export function milvusAgentCapture(surface: string, principal: string): MilvusAgentCapture {
  const text = readFileSync(posix.join(MILVUS_AGENT_CAPTURES, `${surface}-${principal}.json`), "utf8");
  return reviveMilvusFixture(JSON.parse(text)) as MilvusAgentCapture;
}

/** Every capture's file name, without `.json`. */
export function milvusAgentCaptureNames(): readonly string[] {
  return readdirSync(MILVUS_AGENT_CAPTURES)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

/** A capture as the recorded wire answers it: its payload, or its failure as grpc-js rejects it. */
export function replayed(capture: MilvusAgentCapture): object {
  const asFixture = capture as unknown as MilvusCapture;
  if (capture.outcome === "fail" && (capture.payload as { error?: unknown }).error !== undefined) {
    throw capturedFailure(asFixture);
  }
  return capturedAnswer(asFixture);
}

/** The surface each metadata RPC's capture was written under. */
const METADATA_SURFACES: Readonly<Partial<Record<MilvusRpc, string>>> = {
  ListDatabases: "list-databases",
  DescribeDatabase: "describe-database",
  ShowCollections: "show-collections",
  DescribeCollection: "describe-collection",
  DescribeIndex: "describe-index",
  GetCollectionStatistics: "collection-statistics",
  GetLoadState: "load-state",
  GetLoadingProgress: "loading-progress",
  ShowPartitions: "show-partitions",
  ListAliases: "list-aliases",
  DescribeAlias: "describe-alias",
  Query: "query-values",
  Search: "search-text",
};

export interface AgentWireOptions {
  /** The surface SelectGrant of a role the user holds answers with; `select-grant-own-role` by default. */
  readonly ownGrants?: () => string;
  /** Answers that replace a capture, by RPC. */
  readonly overrides?: Partial<Record<MilvusRpc, RecordedMilvusAnswer>>;
}

/**
 * A recorded wire that answers as `principal`'s server did: GetVersion from the provider's own capture, the proof's
 * privilege reads and every metadata read from the principal's agent boundary captures. SelectUser answers the
 * principal's own user, or another user's; SelectGrant answers `public`, `admin` or a role the user holds, as captured
 * for the database the request names.
 */
export function agentMilvusWire(principal: string, options: AgentWireOptions = {}): RecordedMilvusWire {
  const answer = (surface: string) => () => replayed(milvusAgentCapture(surface, principal));
  const answers: Partial<Record<MilvusRpc, RecordedMilvusAnswer>> = {
    GetVersion: () => capturedAnswer(milvusCapture("milvus/get-version-reader")),
    ListCredUsers: answer("list-cred-users"),
    SelectUser: (request) => {
      const user = (request.user as { readonly name?: string } | undefined)?.name;
      return answer(user === MILVUS_AGENT_USERS[principal] ? "select-user-self" : "select-user-other")();
    },
    SelectGrant: (request) => {
      const entity = request.entity as
        | { readonly role?: { readonly name?: string }; readonly db_name?: string }
        | undefined;
      const role = entity?.role?.name;
      const surface =
        role === "public"
          ? "select-grant-public"
          : role === "admin" && principal !== "admin"
            ? "select-grant-admin"
            : (options.ownGrants?.() ?? "select-grant-own-role");
      // The captures name every database ("*"); a read naming none was captured as `-default-only`, where it was.
      return answer(entity?.db_name === "*" ? surface : `${surface}-default-only`)();
    },
    ...Object.fromEntries(Object.entries(METADATA_SURFACES).map(([rpc, surface]) => [rpc, answer(surface as string)])),
    ...options.overrides,
  };
  return recordedMilvusWire(answers);
}

export const MILVUS_SCOPE_CAPTURES = posix.join(
  import.meta.dir.replaceAll("\\", "/"),
  "..",
  "fixtures",
  "milvus",
  "3.0.2",
  "mcp-scope",
);

/** The narrow principals of the data-scope captures, the user each signs in as and the database it names. */
export const MILVUS_SCOPE_PRINCIPALS = {
  dbro: { user: "scope_dbro", database: "default" },
  few: { user: "scope_few", database: "default" },
  onedb: { user: "scope_onedb", database: "scope_db_a" },
} as const;

export type MilvusScopePrincipal = keyof typeof MILVUS_SCOPE_PRINCIPALS;

/** One data-scope capture: `<surface>-<principal>.json`, in the agent boundary captures' format. */
export function milvusScopeCapture(surface: string, principal: MilvusScopePrincipal | "root"): MilvusAgentCapture {
  const text = readFileSync(posix.join(MILVUS_SCOPE_CAPTURES, `${surface}-${principal}.json`), "utf8");
  return reviveMilvusFixture(JSON.parse(text)) as MilvusAgentCapture;
}

/** Every data-scope capture's file name, without `.json`. */
export function milvusScopeCaptureNames(): readonly string[] {
  return readdirSync(MILVUS_SCOPE_CAPTURES)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

/** The tag a data-scope capture names each collection position by, for a principal of `default`. */
const SCOPE_TAG: Readonly<Record<string, string>> = {
  scope_c1: "granted",
  scope_a1: "granted",
  scope_c3: "ungranted",
  scope_b1: "ungranted",
  scope_missing: "missing",
  scope_alias_c1: "alias-granted",
  scope_alias_c3: "alias-ungranted",
  scope_alias_b1: "other-db-alias",
};

const SCOPE_ALIAS_TAG: Readonly<Record<string, string>> = {
  scope_alias_c1: "granted",
  scope_alias_c3: "ungranted",
  scope_missing: "missing",
  scope_alias_b1: "other-db",
};

/**
 * A recorded wire that answers as the data-scope server answered `principal`: the read-only proof's reads, every
 * listing, and each collection, alias and index read by the name the request carries. A name the captures hold no
 * read of is answered with no recorded answer, so a test sees it was sent.
 */
export function scopeMilvusWire(
  principal: MilvusScopePrincipal,
  overrides: Partial<Record<MilvusRpc, RecordedMilvusAnswer>> = {},
): RecordedMilvusWire {
  const answer = (surface: string) => replayed(milvusScopeCapture(surface, principal));
  const named = (prefix: string) => (request: Readonly<Record<string, unknown>>) => {
    const tag = SCOPE_TAG[String(request.collection_name)];
    if (tag === undefined) throw new Error(`no ${prefix} capture of ${String(request.collection_name)}`);
    return answer(`${prefix}-${tag}`);
  };
  return recordedMilvusWire({
    GetVersion: () => capturedAnswer(milvusCapture("milvus/get-version-reader")),
    ListCredUsers: () => answer("list-cred-users"),
    SelectUser: () => answer("select-user-self"),
    SelectGrant: (request) =>
      answer(
        (request.entity as { readonly role?: { readonly name?: string } }).role?.name === "public"
          ? "select-grant-public"
          : "select-grant-own-role",
      ),
    ListDatabases: () => answer("list-databases"),
    DescribeDatabase: () => answer("describe-database"),
    ShowCollections: () => answer("show-collections"),
    DescribeCollection: named("describe-collection"),
    GetCollectionStatistics: named("statistics"),
    GetLoadState: named("load-state"),
    ShowPartitions: named("show-partitions"),
    DescribeIndex: (request) =>
      request.index_name === "scope_missing"
        ? answer("describe-index-missing-index")
        : named("describe-index")(request),
    ListAliases: (request) =>
      request.collection_name === undefined ? answer("list-aliases") : named("list-aliases-of")(request),
    DescribeAlias: (request) => answer(`describe-alias-${SCOPE_ALIAS_TAG[String(request.alias)]}`),
    ...overrides,
  });
}
