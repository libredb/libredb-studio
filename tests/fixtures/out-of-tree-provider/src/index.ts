/**
 * The out-of-tree acceptance's fixture provider (scripts/out-of-tree-acceptance.ts): an in-memory engine written
 * against @libredb/provider-sdk alone, as a developer outside the repository writes one.
 *
 * It is a template: the acceptance copies this directory outside the repository, installs the packed SDK there and
 * packs it with Studio's pack step, which runs the fixture's own build (build.mjs) to bundle this file. Nothing in the
 * repository imports it; the root type check reads it, so an SDK change that breaks a provider written against the
 * published surface fails that check.
 *
 * Statements: `list` answers every row, `get <name>` the row of that name or none; anything else is refused.
 * A statement is read trimmed, so white space around it changes nothing. The manifest's own statement language bounds
 * a console statement's text in UTF-8 bytes, and Studio refuses one past that bound before it reaches this provider.
 */
import { defineProvider, type ExecuteAnswer, type HealthInfo, rowsSource } from "@libredb/provider-sdk/calls";
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

function answerOf(rows: readonly (readonly string[])[]): ExecuteAnswer {
  return { results: [rowsSource(COLUMNS, rows, rows.length)], warnings: [], executionTimeMs: 0, pageApplied: false };
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
      const statement = request.statement.trim();
      if (statement === "list") return answerOf([...session.entries].map(([name, value]) => [name, value]));
      const get = GET.exec(statement);
      if (get !== null) {
        const name = get[1] as string;
        const value = session.entries.get(name);
        return answerOf(value === undefined ? [] : [[name, value]]);
      }
      throw new Error("This engine runs two statements: list, and get followed by a name.");
    },
  },
});
