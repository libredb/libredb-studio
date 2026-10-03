/**
 * Milvus's version, read once at connect from GetVersion, and the version gates of vector-family spec 5.9. Pure.
 *
 * A 2.6 server ignores a parameter it does not know and answers code 0 (R09 F21), so a feature the server may lack
 * is refused by Studio before it is sent, never inferred from an answer. One descriptor, generated at go-api/v3.0.2,
 * serves both lines, because 2.6.25 to 3.0.2 only adds RPCs and fields (R03 F29). A version Studio cannot read, or
 * a major that is neither 2 nor 3, takes the pre-3.0 answer of every gate, the safer reading.
 *
 * Only what depends on the version is here: the keys refused on every version (groupByFields, the function and
 * aggregation keys, range_filter without radius) are rows of the route table and the request rules.
 */

/** The one version tested and claimed (decision Q14). */
export const MILVUS_TESTED_VERSION = "3.0.2";

export interface MilvusVersion {
  /** The server's text, trimmed, or undefined when there was none. */
  readonly reported: string | undefined;
  readonly major: number | undefined;
  readonly minor: number | undefined;
}

/** `3.0.2`, `v3.0.2` and a pre-release or build suffix; anything else is not read. */
const VERSION = /^v?(\d+)\.(\d+)(\.\d+)?(?:[-+]\S*)?$/;
/** A longer text is not read as a version, so no sentence can carry a server's oversized answer (VF7). */
const VERSION_MAX_LENGTH = 64;

function versionMatch(reported: string | undefined): RegExpExecArray | null {
  if (reported === undefined || reported.length > VERSION_MAX_LENGTH) return null;
  return VERSION.exec(reported);
}

export function readMilvusVersion(response: { readonly version?: string } | undefined): MilvusVersion {
  const text = response?.version?.trim();
  const reported = text === undefined || text === "" ? undefined : text;
  const match = versionMatch(reported);
  if (match === null) return { reported, major: undefined, minor: undefined };
  return { reported, major: Number(match[1]), minor: Number(match[2]) };
}

export type MilvusVersionGate = "orderByFields";

export const MILVUS_VERSION_GATES: Readonly<
  Record<
    MilvusVersionGate,
    { readonly key: string; readonly since: readonly [number, number]; readonly before: string }
  >
> = Object.freeze({
  orderByFields: {
    key: "orderByFields",
    since: [3, 0],
    before: "a server before 3.0 ignores it and returns the rows unsorted, so Studio does not send it",
  },
});

/** The refusal of `gate` on `version`, or undefined where the server honours it. */
export function versionGateRefusal(gate: MilvusVersionGate, version: MilvusVersion): string | undefined {
  const row = MILVUS_VERSION_GATES[gate];
  const [sinceMajor, sinceMinor] = row.since;
  const { major, minor } = version;
  // Only majors 2 and 3 are read as versions; any other takes the pre-3.0 answer (5.9).
  const comparable = major !== undefined && minor !== undefined && (major === 2 || major === 3);
  if (comparable && (major > sinceMajor || (major === sinceMajor && minor >= sinceMinor))) return undefined;
  const lead = `${row.key} needs Milvus ${sinceMajor}.${sinceMinor} or later, and this server reports`;
  // Only the numbers Studio read are named: a suffix is the server's own text, which may carry anything (VF9, E20).
  const match = versionMatch(version.reported);
  if (match === null) return `${lead} a version Studio could not read: ${row.before}.`;
  const named = `${match[1]}.${match[2]}${match[3] ?? ""}`;
  if (!comparable) {
    return `${lead} ${named}, a major Studio does not read (it reads 2 and 3), so Studio takes the pre-${sinceMajor}.${sinceMinor} answer and does not send it.`;
  }
  return `${lead} ${named}: ${row.before}.`;
}
