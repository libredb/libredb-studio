/**
 * One console run on the server (spec 5.4, 5.7): the Explain button's marker stripped at offset 0, the statement
 * parsed and compiled before any request, the one request sent with the statement phase (a listing page by page up
 * to its cap), and the answer shaped into a QueryResult carrying every warning.
 */
import { QueryError } from "@/lib/db/errors";
import { FIRESTORE_EXPLAIN_MARKER } from "@/lib/explain/firestore-explain";
import type { QueryResult } from "@/lib/types";
import { FIRESTORE_TYPE, LIMITS, SENTENCES } from "../constants";
import type { ErrorContext } from "../errors";
import type { FirestoreRequest } from "../requests";
import { RESULT_SENTENCES, readQueryStream, shapeResult } from "../results";
import type { FirestoreClient } from "../transport";
import { compileStatement } from "./compile";
import { parseStatement } from "./parser";

export interface ExecuteDeps {
  readonly client: FirestoreClient;
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly credential: ErrorContext["credential"];
  /** The credential's forms (`CallBase` in objects.ts); a Google message holding one is withheld (spec S7). */
  readonly secretForms?: readonly string[];
}

type Listing = Extract<FirestoreRequest, { kind: "listCollectionIds" | "listDocuments" }>;

/** Per listing: the answer's list key, the noun a malformed page is named by, and the most requests one run sends. */
const LISTINGS: Readonly<Record<Listing["kind"], { key: string; what: string; requests: number }>> = {
  listCollectionIds: { key: "collectionIds", what: "a collection listing", requests: LIMITS.idListingRequests },
  listDocuments: {
    key: "documents",
    what: "a document listing",
    requests: Math.ceil(LIMITS.consoleListDocumentsRows / LIMITS.collectionPageSizeUnmasked),
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every page of a listing up to its request cap, merged into one answer that keeps the last page token. */
async function readPages(request: Listing, deps: ExecuteDeps, context: ErrorContext): Promise<Record<string, unknown>> {
  const { key, what, requests } = LISTINGS[request.kind];
  const items: unknown[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < requests; page++) {
    // oxlint-disable-next-line no-await-in-loop -- each page's request carries the token the one before it returned.
    const answer = await deps.client.send(pageToken === undefined ? request : { ...request, pageToken }, {
      signal: deps.signal,
      context,
    });
    const listed = isRecord(answer) ? (answer[key] ?? []) : undefined;
    if (!Array.isArray(listed)) throw new QueryError(RESULT_SENTENCES.malformed(what), FIRESTORE_TYPE);
    items.push(...listed);
    const next = isRecord(answer) && typeof answer.nextPageToken === "string" ? answer.nextPageToken : "";
    if (next === "") return { [key]: items };
    pageToken = next;
  }
  return { [key]: items, nextPageToken: pageToken };
}

/** One console statement, run: the text as the editor sent it, with the Explain button's marker when it pressed. */
export async function executeStatement(text: string, deps: ExecuteDeps): Promise<QueryResult> {
  const started = deps.now();
  const explainButton = text.startsWith(FIRESTORE_EXPLAIN_MARKER);
  const body = explainButton ? text.slice(FIRESTORE_EXPLAIN_MARKER.length) : text;
  const { target } = deps.client;
  const { request, shape, warnings } = compileStatement(parseStatement(body), body, { target, explainButton });
  // The emulator ignores Query Explain (spec 4.3): refused before any request, with the emulator sentence of
  // constants.ts.
  if (shape.kind === "explain" && deps.client.mode === "emulator") {
    throw new QueryError(SENTENCES.emulatorExplain, FIRESTORE_TYPE, body);
  }
  const context: ErrorContext = {
    phase: "statement",
    credential: deps.credential,
    target,
    surface: "console",
    aggregation: request.kind === "runAggregationQuery",
    ...(deps.secretForms === undefined ? {} : { secretForms: deps.secretForms }),
  };
  const answer =
    request.kind === "listCollectionIds" || request.kind === "listDocuments"
      ? await readPages(request, deps, context)
      : await deps.client.send(request, { signal: deps.signal, context });
  if (shape.kind === "explain" && readQueryStream(answer).explainMetrics === undefined) {
    throw new QueryError(RESULT_SENTENCES.noPlan, FIRESTORE_TYPE, body);
  }
  const shaped = shapeResult(answer, shape, target);
  const messages = [...warnings, ...shaped.warnings];
  return {
    rows: shaped.rows,
    fields: shaped.fields,
    rowCount: shaped.rows.length,
    executionTime: deps.now() - started,
    ...(shaped.columnTypes === undefined ? {} : { columnTypes: shaped.columnTypes }),
    ...(shaped.vectorColumns === undefined ? {} : { vectorColumns: shaped.vectorColumns }),
    ...(messages.length === 0 ? {} : { warnings: messages.map((message) => ({ message })) }),
  };
}
