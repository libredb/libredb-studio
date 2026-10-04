/**
 * The version a Qdrant server reports and the gates it decides (vector-family spec 6.9, QE30). Pure.
 *
 * `GET /` answers `{"title", "version", "commit"}` without a key, and `version` was a plain `major.minor.patch` on
 * every server measured (1.16.3 to 1.19.1). A key newer than the server is refused by name with the version it
 * needs, before any request: two of the gated keys are accepted and silently ignored by an older server, which
 * returns plausible wrong scores, and the others answer a 400 that names no key.
 *
 * A version that is missing, or is not a plain `major.minor.patch`, takes the oldest answer of every gate: each
 * gated key is refused naming the version it needs. Connecting still succeeds.
 */

/** A released version as three numbers. */
export type QdrantRelease = readonly [major: number, minor: number, patch: number];

export interface QdrantVersion {
  /** `version` as the server wrote it, when it is a short token safe to repeat; null otherwise. */
  readonly reported: string | null;
  /** The three numbers of a plain `major.minor.patch`; null for anything else. */
  readonly release: QdrantRelease | null;
}

/** The version this provider is tested against and claims (decision QD10). */
export const QDRANT_TESTED_VERSION = "1.19.1";

const PLAIN_RELEASE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
/** A version text short and plain enough to repeat in a sentence: `1.20.0-dev`, never a server's free text. */
const REPEATABLE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;

/** The version in the text of a `GET /` answer. A body that is not a JSON object, or holds no string `version`, reports none. */
export function readQdrantVersion(rootAnswerText: string): QdrantVersion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rootAnswerText);
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

interface GateRow {
  /** How a sentence names the key. */
  readonly label: string;
  readonly needs: QdrantRelease;
  /** What an older server does with the key, the reason the gate exists. */
  readonly olderServer: string;
}

/** The gate table of 6.9, from the saved OpenAPI version diff and the measurement on 1.16.3 to 1.19.1. */
export const QDRANT_VERSION_GATES = {
  "rrf.weights": {
    label: 'The key "weights" of "rrf"',
    needs: [1, 17, 0],
    olderServer: "an older server accepts it and returns the unweighted scores",
  },
  relevance_feedback: {
    label: 'The query "relevance_feedback"',
    needs: [1, 17, 0],
    olderServer: "an older server does not have it",
  },
  "params.idf": {
    label: 'The key "idf" of "params"',
    needs: [1, 19, 0],
    olderServer: "an older server accepts it and ignores it",
  },
  "match.prefix": {
    label: 'The match "prefix"',
    needs: [1, 19, 0],
    olderServer: "an older server answers an error that names no key",
  },
  slice: {
    label: 'The "slice" condition',
    needs: [1, 19, 0],
    olderServer: "an older server answers an error that names no key",
  },
  "formula.acosh": {
    label: 'The formula expression "acosh"',
    needs: [1, 19, 1],
    olderServer: "an older server answers an error that names no key",
  },
  "formula.max": {
    label: 'The formula expression "max"',
    needs: [1, 19, 1],
    olderServer: "an older server answers an error that names no key",
  },
  "formula.min": {
    label: 'The formula expression "min"',
    needs: [1, 19, 1],
    olderServer: "an older server answers an error that names no key",
  },
} as const satisfies Readonly<Record<string, GateRow>>;

export type QdrantVersionGate = keyof typeof QDRANT_VERSION_GATES;

/** Whether the server is at `needs` or later. A version that cannot be read is older than every release. */
export function serverHas(version: QdrantVersion, needs: QdrantRelease): boolean {
  const { release } = version;
  if (release === null) return false;
  for (let part = 0; part < 3; part++) {
    if (release[part] !== needs[part]) return release[part] > needs[part];
  }
  return true;
}

/** The refusal of a gated key on a server older than the key, or undefined where the server has it. Nothing is sent. */
export function versionGateRefusal(gate: QdrantVersionGate, version: QdrantVersion): string | undefined {
  const row = QDRANT_VERSION_GATES[gate];
  if (serverHas(version, row.needs)) return undefined;
  const server =
    version.release !== null
      ? `this server reports ${version.release.join(".")}`
      : version.reported !== null
        ? `this server reports ${version.reported}, which is not a plain release number`
        : "this server reported no version";
  return `${row.label} needs Qdrant ${row.needs.join(".")} or later, and ${server}; ${row.olderServer}, so nothing was sent.`;
}
