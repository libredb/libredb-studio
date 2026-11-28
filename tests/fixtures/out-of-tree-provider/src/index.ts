/**
 * The out-of-tree acceptance's fixture provider (scripts/out-of-tree-acceptance.ts): an in-memory engine written
 * against @libredb/provider-sdk alone, as a developer outside the repository writes one.
 *
 * It is a template: the acceptance copies this directory outside the repository, installs the packed SDK there and
 * packs it with Studio's pack step, which runs the fixture's own build (build.mjs) to bundle this file. Nothing in the
 * repository imports it; the root type check reads it, so an SDK change that breaks a provider written against the
 * published surface fails that check, and the in-process test of its granted language bundles it from its path.
 *
 * Console statements: `list` answers every row, `get <name>` the row of that name or none; anything else is refused.
 * A statement is read trimmed, so white space around it changes nothing. The manifest's own statement language bounds
 * a console statement's text in UTF-8 bytes, and Studio refuses one past that bound before it reaches this provider.
 *
 * A read-only execute (`readOnly`, which agent mode and MCP send) is one request of the language's agent request form
 * instead: one JSON object, `{"read": "list"}` or `{"read": "get", "name": "<1 to 32 letters a to z>"}`, with no other
 * key and no key written twice; anything else is refused before the store is read. It runs no estimating mode, since
 * the store has no plan, and it refuses an answer past its budget's rows or bytes rather than cutting it.
 */
import {
  defineProvider,
  encodedRowBytes,
  type ExecuteAnswer,
  type ExecuteRequest,
  type HealthInfo,
  rowsSource,
} from "@libredb/provider-sdk/calls";
import { repeatsAKey } from "@libredb/provider-sdk/values";
import manifest from "../libredb-provider.json" with { type: "json" };

/** What a session holds: the engine's names and values. */
interface Session {
  readonly entries: ReadonlyMap<string, string>;
}

const ENTRIES: ReadonlyMap<string, string> = new Map([
  ["alpha", "first"],
  ["beta", "second"],
]);

const COLUMNS = Object.freeze([
  Object.freeze({ name: "name", type: "text" }),
  Object.freeze({ name: "value", type: "text" }),
]);

const GET = /^get\s+(\S+)$/;
/** A name a read-only request's get read takes, as the language's request form states it. */
const NAME = /^[a-z]{1,32}$/;
const READ_ONLY_FORM =
  'A read-only read is one JSON object: {"read": "list"}, or {"read": "get", "name": "<1 to 32 letters a to z>"}.';

type Rows = readonly (readonly string[])[];

function answerOf(rows: Rows): ExecuteAnswer {
  return { results: [rowsSource(COLUMNS, rows, rows.length)], warnings: [], executionTimeMs: 0, pageApplied: false };
}

/** Every entry's row, or the row of `name` or none. */
function rowsOf(session: Session, name: string | null): Rows {
  if (name === null) return [...session.entries].map(([entry, value]) => [entry, value]);
  const value = session.entries.get(name);
  return value === undefined ? [] : [[name, value]];
}

/** The name a read-only request reads, null for every entry; throws for a request outside the form. */
function readOnlyName(statement: string): string | null {
  let request: unknown;
  try {
    request = JSON.parse(statement);
  } catch {
    throw new Error(READ_ONLY_FORM);
  }
  if (typeof request !== "object" || request === null || Array.isArray(request) || repeatsAKey(statement)) {
    throw new Error(READ_ONLY_FORM);
  }
  const keys = Object.keys(request);
  const { read, name } = request as Record<string, unknown>;
  if (read === "list" && keys.length === 1) return null;
  if (read === "get" && keys.length === 2 && typeof name === "string" && NAME.test(name)) return name;
  throw new Error(READ_ONLY_FORM);
}

/** The answer of a read-only execute, within its budget or refused. */
function readOnlyAnswer(session: Session, request: ExecuteRequest): ExecuteAnswer {
  const readOnly = request.readOnly as NonNullable<ExecuteRequest["readOnly"]>;
  if (readOnly.mode !== undefined) throw new Error("This in-memory engine has no plan to estimate: a read runs.");
  const rows = rowsOf(session, readOnlyName(request.statement));
  const bytes = rows.reduce((sum, row) => sum + encodedRowBytes(row), 0);
  if (rows.length > readOnly.budget.maxRows || bytes > readOnly.budget.maxBytes) {
    throw new Error("The read answers more rows or bytes than this read may answer, so it is refused, not cut.");
  }
  return answerOf(rows);
}

export default defineProvider<Session>(manifest, {
  async open() {
    return { handle: { entries: ENTRIES } };
  },
  async close() {},
  async health(session): Promise<HealthInfo> {
    return {
      databaseSize: `${session.entries.size} entries`,
      cacheHitRatio: "n/a",
      slowQueries: [],
      activeSessions: [],
    };
  },
  console: {
    async execute(session, request) {
      if (request.readOnly !== undefined) return readOnlyAnswer(session, request);
      const statement = request.statement.trim();
      if (statement === "list") return answerOf(rowsOf(session, null));
      const get = GET.exec(statement);
      if (get !== null) return answerOf(rowsOf(session, get[1] as string));
      throw new Error("This engine runs two statements: list, and get followed by a name.");
    },
  },
});
