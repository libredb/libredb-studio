/**
 * The one reader of the Neo4j captures (Neo4j provider spec 10).
 *
 * `tests/fixtures/neo4j/5.26.31/` holds what the compose server answered to the graph layer's own Bolt
 * client, one statement per file, written by `tests/live/neo4j-evidence.ts`; its README lists the encoding.
 * `recordedGraphClient` is a `GraphClient` over those files: a run is answered by the capture of the exact
 * database and statement text, so a catalog, a gate or a provider that sends any other text fails loudly
 * instead of meeting an answer a test author wrote. Every run is recorded in `calls`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type GraphClient,
  GraphClientError,
  type GraphClientErrorCategory,
  type GraphRunOptions,
  type GraphRunResult,
  type GraphServerInfo,
} from "@/lib/db/graph/bolt/client";

/** The captures of the server the provider is verified against. */
export const NEO4J_FIXTURES = join(import.meta.dir, "..", "fixtures", "neo4j", "5.26.31");

export interface CapturedError {
  readonly category: GraphClientErrorCategory;
  readonly code: string | null;
  readonly message: string;
}

/** One capture file: a statement's, `verify.json`, or a transport answer under `transport/`. */
export interface Neo4jCapture {
  readonly $captured: {
    readonly image: string;
    readonly digest: string;
    readonly date: string;
    readonly database: string | null;
  };
  readonly statement?: string;
  readonly surface?: string;
  readonly options?: { readonly database: string | null; readonly maxRows: number };
  readonly outcome: "pass" | "fail";
  readonly result?: GraphRunResult & GraphServerInfo;
  readonly error?: CapturedError;
}

/** One capture by its path under the fixture directory, without `.json`, e.g. `catalog-label` or `transport/error-auth`. */
export function neo4jCapture(name: string, dir: string = NEO4J_FIXTURES): Neo4jCapture {
  return JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as Neo4jCapture;
}

/** A captured failure as the client threw it. */
export function capturedError(error: CapturedError): GraphClientError {
  return new GraphClientError(error.category, error.message, error.code ?? undefined);
}

/** The error a failed capture holds; throws when the capture passed. */
export function capturedErrorOf(name: string, dir: string = NEO4J_FIXTURES): GraphClientError {
  const capture = neo4jCapture(name, dir);
  if (capture.error === undefined) throw new Error(`${name}.json is not a failure`);
  return capturedError(capture.error);
}

const keyOf = (database: string | null | undefined, statement: string): string => `${database ?? ""}\u0000${statement}`;

export interface RecordedGraphClientOverrides {
  readonly run?: (statement: string, options: GraphRunOptions) => Promise<GraphRunResult>;
  readonly verify?: () => Promise<GraphServerInfo>;
  readonly close?: () => Promise<void>;
}

export type RecordedGraphClient = GraphClient & {
  readonly calls: { statement: string; options: GraphRunOptions }[];
};

/**
 * A client answering from every statement capture of `dir`: rows cut to the run's `maxRows`, `truncated`
 * recomputed (and `queryType` dropped on a cut, as the Bolt client never reads the summary then), a captured
 * failure thrown as its `GraphClientError`, an aborted signal as a cancel, and `Error("no capture for: ...")`
 * for any other statement. Two files capturing one database and statement are refused when the client is
 * built, so no capture answers for another. `verify` answers from `verify.json`. An override answers in place of a method;
 * runs are recorded either way.
 */
export function recordedGraphClient(
  dir: string = NEO4J_FIXTURES,
  overrides: RecordedGraphClientOverrides = {},
): RecordedGraphClient {
  const captures = new Map<string, Neo4jCapture>();
  const files = new Map<string, string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json") || file === "verify.json") continue;
    const capture = neo4jCapture(file.slice(0, -".json".length), dir);
    if (capture.statement === undefined || capture.options === undefined) {
      throw new Error(`${file} is not a statement capture`);
    }
    const key = keyOf(capture.options.database, capture.statement);
    const earlier = files.get(key);
    if (earlier !== undefined) {
      throw new Error(`${earlier} and ${file} both capture ${JSON.stringify(capture.statement)} on one database`);
    }
    files.set(key, file);
    captures.set(key, capture);
  }
  const calls: { statement: string; options: GraphRunOptions }[] = [];

  async function replay(statement: string, options: GraphRunOptions): Promise<GraphRunResult> {
    if (options.signal?.aborted) throw new GraphClientError("cancelled", "The query was cancelled before it was sent");
    const capture = captures.get(keyOf(options.database, statement));
    if (capture === undefined) throw new Error(`no capture for: ${statement}`);
    if (capture.error !== undefined) throw capturedError(capture.error);
    const result = capture.result as GraphRunResult;
    const truncated = result.truncated || result.rows.length > options.maxRows;
    return {
      fields: result.fields,
      rows: result.rows.slice(0, options.maxRows),
      truncated,
      ...(truncated || result.queryType === undefined ? {} : { queryType: result.queryType }),
      ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
    };
  }

  return {
    calls,
    async run(statement, options) {
      calls.push({ statement, options });
      return (overrides.run ?? replay)(statement, options);
    },
    async verify() {
      if (overrides.verify !== undefined) return overrides.verify();
      return neo4jCapture("verify", dir).result as GraphServerInfo;
    },
    async close() {
      await overrides.close?.();
    },
  };
}
