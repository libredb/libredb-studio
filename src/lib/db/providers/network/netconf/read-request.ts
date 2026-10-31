/**
 * The console's read request (`docs/providers/netconf.md` section 3.1), read by one parser for the console and for the
 * agent's reader (`agent-statement.ts`), so a request means one thing wherever it is written.
 */
import { QueryError } from "@/lib/db/errors";
import { assertYangIdentifier, type PathNode } from "./keypath";

const READ_SENTENCES = Object.freeze({
  notJson: "A NETCONF read request is JSON: it names a datastore, a path and a limit.",
  noDatastore: "This read names no datastore, and this provider sends no unfiltered read.",
  noPath: "This read names no path, and this provider sends no unfiltered read.",
  badLimit: "A limit is a whole number of rows, one or more.",
});

export interface ReadRequest {
  readonly datastore: string;
  readonly path: readonly PathNode[];
  readonly limit: number;
}

/**
 * Reads the console's JSON request.
 *
 * MEASURED by calling this function with eleven bodies, because the sentence that stood here
 * said it refuses rather than defaults and that is true of two of the three fields, not of the
 * request. `datastore` and `path` are required and refused by name, so a request missing one is
 * told which. `limit` is the only field with a default, and only when it is ABSENT: present and
 * not a positive integer it is refused like the other two, `null` included, because `null` is
 * not `undefined`. A field this shape does not name is neither refused nor defaulted, it is
 * ignored. `docs/providers/netconf.md` section 3.1 states the same three rules.
 */
export function parseReadRequest(statement: string): ReadRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(statement);
  } catch {
    throw new QueryError(READ_SENTENCES.notJson);
  }
  // An array parses as an object, so it has to be refused here rather than falling through to the
  // datastore check, where the message would say the request names no datastore when the real
  // problem is that it is not a request at all. Found by a test whose expectation was right and
  // whose code was not.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new QueryError(READ_SENTENCES.notJson);
  }
  const body = parsed as Record<string, unknown>;
  const datastore = body["datastore"];
  const path = body["path"];
  if (typeof datastore !== "string" || datastore === "") throw new QueryError(READ_SENTENCES.noDatastore);
  if (typeof path !== "string" || path === "") throw new QueryError(READ_SENTENCES.noPath);
  const limit = body["limit"];
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) {
    throw new QueryError(READ_SENTENCES.badLimit);
  }
  return { datastore, path: parsePathArgument(path), limit: typeof limit === "number" ? limit : 1000 };
}

function parsePathArgument(path: string): readonly PathNode[] {
  const nodes = path
    .split("/")
    .filter((piece) => piece !== "")
    .map((piece): PathNode => {
      const at = piece.indexOf("=");
      const head = at === -1 ? piece : piece.slice(0, at);
      const colon = head.indexOf(":");
      const name = assertYangIdentifier(colon === -1 ? head : head.slice(colon + 1), piece);
      const moduleName = colon === -1 ? undefined : assertYangIdentifier(head.slice(0, colon), piece);
      const keys =
        at === -1
          ? undefined
          : piece
              .slice(at + 1)
              .split(",")
              .map(decodeURIComponent);
      if (moduleName && keys) return { module: moduleName, name, keys };
      if (moduleName) return { module: moduleName, name };
      if (keys) return { name, keys };
      return { name };
    });
  if (nodes.length === 0) throw new QueryError(READ_SENTENCES.noPath);
  return nodes;
}
