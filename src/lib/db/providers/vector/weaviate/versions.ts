/**
 * The version a Weaviate server reports and the path it decides (#1566 spec 3.3). Pure.
 *
 * `GET /v1/meta` answers `{"version", "hostname", "modules", ...}` and `version` was a plain `major.minor.patch` on
 * every server measured (1.37.4 to 1.40.2). By precedent (Qdrant, Milvus and InfluxDB read the version and decide by
 * a table; no provider probes features), the version alone picks, per search, the REST route or the GraphQL read.
 *
 * REST search did not arrive in version order (spec A.2): 1.38.22 carries the routes behind
 * `EXPERIMENTAL_REST_SEARCH_ENABLED`, 1.39.0 has none, 1.39.6 has them behind the flag, 1.39.7 serves them by
 * default, and near-vector starts at 1.39.8. So REST is chosen from 1.39.7 (near-vector from 1.39.8), and GraphQL
 * below that, where a flag-on 1.38 server would also answer REST: both paths return the same rows, and the flag is
 * configuration the version cannot show. A version that cannot be read takes GraphQL.
 */

/** A released version as three numbers. */
export type WeaviateRelease = readonly [major: number, minor: number, patch: number];

export interface WeaviateVersion {
  /** `version` as the server wrote it, when it is a short token safe to repeat; null otherwise. */
  readonly reported: string | null;
  /** The three numbers of a plain `major.minor.patch`; null for anything else. */
  readonly release: WeaviateRelease | null;
}

/**
 * The versions this provider is tested against, one per server shape of the fixture matrix: the newest line, the
 * 1.38 line whose REST search sits behind a flag, and DigitalOcean's (decisions of 2026-10-23).
 */
export const WEAVIATE_TESTED_VERSIONS: readonly string[] = Object.freeze(["1.40.2", "1.38.22", "1.37.4"]);

/** The oldest line version 1 supports (decision, spec 15): end of life upstream, kept for a managed service. */
export const WEAVIATE_FLOOR: WeaviateRelease = [1, 37, 0];

/** The first release that serves bm25, hybrid, near-object and aggregate over REST without a flag. */
export const REST_SEARCH_SINCE: WeaviateRelease = [1, 39, 7];
/** The first release with the near-vector REST route. */
export const REST_NEAR_VECTOR_SINCE: WeaviateRelease = [1, 39, 8];

const PLAIN_RELEASE = /^v?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
/** A version text short and plain enough to repeat in a sentence: `1.41.0-rc.1`, never a server's free text. */
const REPEATABLE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;

/** The version in the text of a `GET /v1/meta` answer. A body that is not a JSON object, or holds no string `version`, reports none. */
export function readWeaviateVersion(metaAnswerText: string): WeaviateVersion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metaAnswerText);
  } catch {
    return { reported: null, release: null };
  }
  const version =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { readonly version?: unknown }).version
      : undefined;
  if (typeof version !== "string") return { reported: null, release: null };
  const plain = PLAIN_RELEASE.exec(version);
  return {
    reported: REPEATABLE.test(version) ? version : null,
    release: plain === null ? null : [Number(plain[1]), Number(plain[2]), Number(plain[3])],
  };
}

/** Whether the server is at `needs` or later. A version that cannot be read is older than every release. */
export function serverHas(version: WeaviateVersion, needs: WeaviateRelease): boolean {
  const { release } = version;
  if (release === null) return false;
  for (let part = 0; part < 3; part++) {
    if (release[part] !== needs[part]) return release[part] > needs[part];
  }
  return true;
}

/** The path a search or aggregate starts on. */
export type WeaviatePath = "rest" | "graphql";

/** Whether the operation is near-vector, which needs a later release than the other searches. */
export type WeaviatePathKind = "near-vector" | "other";

/** The table of spec 3.3: the path the version decides for one search. */
export function initialPath(version: WeaviateVersion, kind: WeaviatePathKind): WeaviatePath {
  return serverHas(version, kind === "near-vector" ? REST_NEAR_VECTOR_SINCE : REST_SEARCH_SINCE) ? "rest" : "graphql";
}

/** A sentence naming the server's version, for a refusal or a result header. */
export function versionText(version: WeaviateVersion): string {
  if (version.release !== null) return version.release.join(".");
  if (version.reported !== null) return `${version.reported}, which is not a plain release number`;
  return "a version it did not report";
}

/** The warning a connection to a server older than the floor carries; undefined at or above it (spec 3.1). */
export function belowFloorWarning(version: WeaviateVersion): string | undefined {
  if (version.release === null || serverHas(version, WEAVIATE_FLOOR)) return undefined;
  return `This Weaviate server is ${version.release.join(".")}, older than ${WEAVIATE_FLOOR.slice(0, 2).join(".")}, the oldest line Studio supports; nothing below it is tested.`;
}
