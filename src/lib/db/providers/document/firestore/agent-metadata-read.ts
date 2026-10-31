/**
 * What an agent's Firestore read sends and answers: each read of the closed table (`agent-statement.ts`) run over the
 * agent's client (`FirestoreAgentClient` in `agent-client.ts`), its answer projected to names, counts and flags, and
 * the wording of a failure without Google's words.
 *
 * Each operation has a typed projection here, and the capability `metadataOnly` states them. No column's name comes
 * from the server, and no answer is passed on as it came: a listing is its collection ids; a count is the collection's
 * id and its document count; a document read is the id of the collection the document sits in, whether it exists,
 * and its create and update times, never its path, its id or a field. The document path a statement names is not
 * echoed: the statement already holds it. A cell that does not fit its column's kind refuses the whole answer, as a
 * stored value smuggled into a metadata field would look.
 *
 * Budgets refuse rather than cut: a listing or a count past the row budget, and an answer past the byte budget, are
 * refused. A count asks Firestore to stop one past the row budget (`upTo`), so it never reads more index entries than
 * the refusal needs. A listing reads each page with the server's own token, held here for the one read and never
 * returned, so nothing of one read reaches the next.
 */
import {
  AuthenticationError,
  DatabaseError,
  QueryCancelledError,
  QueryError,
  RefusedBeforeSendError,
  TimeoutError,
} from "@/lib/db/errors";
import {
  byteBudgetSentence,
  measureResultBytes,
  ROW_BUDGET_PREFIX,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import {
  declareMetadataOnly,
  type MetadataOnlyDeclaration,
  type MetadataProjection,
  MetadataProjectionError,
  projectMetadata,
} from "@/lib/db/redaction/metadata-only";
import type { QueryResult, QueryWarning, ReadOnlyStatementBudget } from "@/lib/db/types";
import { type FirestoreAgentCall, type FirestoreAgentClient, isStudioWorded, studioWorded } from "./agent-client";
import type { FirestoreAgentOperation, FirestoreAgentPlan } from "./agent-statement";
import { FIRESTORE_TYPE, LIMITS } from "./constants";
import { googleErrorOf } from "./errors";
import { compareUtf8, idRefusal } from "./names";
import { FIRESTORE_TRANSPORT_SENTENCES } from "./transport";

/** One answer of the table's reads, as the provider hands it to its projection. */
export type FirestoreAgentAnswer =
  | {
      readonly op: "list-collections";
      readonly ids: readonly string[];
      /** Ids the id rules refuse, which are counted and never listed. */
      readonly skipped: number;
    }
  | { readonly op: "count"; readonly collection: string; readonly documents: number }
  | {
      readonly op: "document";
      readonly collection: string;
      readonly exists: boolean;
      readonly createTime?: string;
      readonly updateTime?: string;
    };

/** A server time as Firestore writes one (RFC 3339 in UTC, up to nanoseconds), or null, never other text. */
const SERVER_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const timeOrNull = (time: string | undefined): string | null =>
  time !== undefined && SERVER_TIME.test(time) ? time : null;

type ListingAnswer = Extract<FirestoreAgentAnswer, { op: "list-collections" }>;
const COLLECTIONS: MetadataProjection<string> = [{ column: "collection", kind: "name", read: (id) => id }];

type CountAnswer = Extract<FirestoreAgentAnswer, { op: "count" }>;
const COUNT: MetadataProjection<CountAnswer> = [
  { column: "collection", kind: "name", read: (a) => a.collection },
  { column: "documents", kind: "count", read: (a) => a.documents },
];

/** The path the statement named is not echoed: the answer is the collection's id and the document's three facts. */
type DocumentAnswer = Extract<FirestoreAgentAnswer, { op: "document" }>;
const DOCUMENT: MetadataProjection<DocumentAnswer> = [
  { column: "collection", kind: "name", read: (a) => a.collection },
  { column: "exists", kind: "flag", read: (a) => a.exists },
  { column: "created", kind: "name", optional: true, read: (a) => timeOrNull(a.createTime) },
  { column: "updated", kind: "name", optional: true, read: (a) => timeOrNull(a.updateTime) },
];

const PROJECTIONS = Object.freeze({
  "list-collections": COLLECTIONS,
  count: COUNT,
  document: DOCUMENT,
} satisfies Record<FirestoreAgentOperation, MetadataProjection<never>>);

/** What `ProviderCapabilities.metadataOnly` states for Firestore: every operation's columns and their kinds. */
export const FIRESTORE_METADATA_ONLY: MetadataOnlyDeclaration = declareMetadataOnly(PROJECTIONS);

const NOT_PASSED_ON =
  "Google's own words are not passed on to agent mode, since a Firestore error can repeat a document path the read did not name.";

export const FIRESTORE_AGENT_FAILURE_SENTENCES = {
  denied: `Firestore refused this connection's credential the read. ${NOT_PASSED_ON}`,
  notFound: `Firestore found no database, or no parent document, for the read, or this connection's credential may not see it. ${NOT_PASSED_ON}`,
  invalid: `Firestore refused the read as one it cannot answer. ${NOT_PASSED_ON}`,
  quota: `Firestore's quota or rate limit for this project is exhausted, so the read was not answered. ${NOT_PASSED_ON}`,
  status: (status: number): string => `Firestore refused the read with HTTP ${status}. ${NOT_PASSED_ON}`,
  credential: `Google refused the connection's credential when Studio asked for a token, so the read was not sent. ${NOT_PASSED_ON}`,
  unreachable: `Firestore could not be reached for the read. ${NOT_PASSED_ON}`,
  closed: "The connection was closed while the read ran, so it was not answered.",
  failed: `The read failed. ${NOT_PASSED_ON}`,
  unreadableAnswer: "Firestore answered the read with a body that is not JSON, so it was not answered.",
  listingCut: `Firestore answered more pages of collection ids than Studio reads for one listing (${LIMITS.idListingRequests}), so the listing was refused rather than answered in part.`,
  repeatedToken:
    "Firestore sent the same page token twice, so reading on would list a page again: the listing was refused.",
  skippedIds: (count: number): string =>
    `${count} collection ${count === 1 ? "id breaks" : "ids break"} Firestore's id rules, so ${count === 1 ? "it is" : "they are"} counted here and not listed.`,
  countOverRows: (allowed: number): string =>
    `${ROW_BUDGET_PREFIX}: the collection holds more than ${allowed} documents, and Studio counts documents only up to the row budget, refusing a larger count rather than cutting it. A narrower count is not one of agent mode's reads, since it would reveal stored values.`,
} as const;

const F = FIRESTORE_AGENT_FAILURE_SENTENCES;

/** What a read runs under: the request's budget and the call (the deadline, the session's end, the allowance). */
export interface FirestoreAgentReadContext {
  readonly budget: ReadOnlyStatementBudget;
  readonly call: FirestoreAgentCall;
}

/** Every collection id under one parent, up to the row budget and the id-listing cap, refused past either. */
async function listCollections(
  client: FirestoreAgentClient,
  parent: readonly string[],
  context: FirestoreAgentReadContext,
): Promise<ListingAnswer> {
  const allowed = context.budget.maxResultRows;
  const pageSize = Math.min(LIMITS.idListingPageSize, allowed + 1);
  const listed = new Set<string>();
  const used = new Set<string>();
  let token: string | undefined;
  for (let request = 0; request < LIMITS.idListingRequests; request += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page's request carries the token the one before it returned.
    const page = await client.listCollectionIds(
      { parent, pageSize, ...(token === undefined ? {} : { pageToken: token }) },
      context.call,
    );
    for (const id of page.ids) listed.add(id);
    if (listed.size > allowed) throw studioWorded(rowBudgetSentence(listed.size, allowed));
    if (page.next === undefined) {
      const ids = [...listed].filter((id) => idRefusal(id, "collection") === null).sort(compareUtf8);
      return { op: "list-collections", ids, skipped: listed.size - ids.length };
    }
    if (used.has(page.next)) throw studioWorded(F.repeatedToken);
    used.add(page.next);
    token = page.next;
  }
  throw studioWorded(F.listingCut);
}

/** The answer of one admitted read, through the agent's client alone. */
export async function runFirestoreAgentRead(
  client: FirestoreAgentClient,
  plan: FirestoreAgentPlan,
  context: FirestoreAgentReadContext,
): Promise<FirestoreAgentAnswer> {
  switch (plan.op) {
    case "list-collections":
      return listCollections(client, plan.parent, context);
    case "count": {
      const allowed = context.budget.maxResultRows;
      // One past the budget: a count that reaches it is refused, and Firestore reads no index entry beyond it.
      const documents = await client.countDocuments(plan.source, allowed + 1, context.call);
      if (documents > allowed) throw studioWorded(F.countOverRows(allowed));
      const collection = plan.source.kind === "collectionGroup" ? plan.source.collectionId : plan.source.path.at(-1);
      return { op: "count", collection: collection as string, documents };
    }
    case "document": {
      const times = await client.documentTimes(plan.path, context.call);
      return { op: "document", collection: plan.path[plan.path.length - 2], ...times };
    }
  }
}

/** The rows of one answer under its operation's projection, and the notes it carries. */
function project(answer: FirestoreAgentAnswer): {
  readonly projected: ReturnType<typeof projectMetadata>;
  readonly warnings: readonly QueryWarning[];
} {
  switch (answer.op) {
    case "list-collections":
      return {
        projected: projectMetadata(COLLECTIONS, answer.ids),
        warnings: answer.skipped === 0 ? [] : [{ message: F.skippedIds(answer.skipped) }],
      };
    case "count":
      return { projected: projectMetadata(COUNT, [answer]), warnings: [] };
    case "document":
      return { projected: projectMetadata(DOCUMENT, [answer]), warnings: [] };
  }
}

/** The answer of one read: its projected rows, refused past the byte budget rather than cut. */
export function firestoreAgentResult(
  answer: FirestoreAgentAnswer,
  budget: ReadOnlyStatementBudget,
  executionTime: number,
): QueryResult {
  const { projected, warnings } = project(answer);
  const bytes = measureResultBytes(projected.rows);
  if (bytes > budget.maxResultBytes) {
    throw studioWorded(byteBudgetSentence(bytes, budget.maxResultBytes));
  }
  return {
    fields: projected.fields,
    rows: projected.rows,
    rowCount: projected.rows.length,
    executionTime,
    ...(warnings.length === 0 ? {} : { warnings: [...warnings] }),
  };
}

/** A Google refusal by its status alone: never its message, reason, links or the path it may quote. */
function statusSentence(status: number, grpcStatus: string | undefined): string {
  if (status === 429 || grpcStatus === "RESOURCE_EXHAUSTED") return F.quota;
  switch (status) {
    case 401:
    case 403:
      return F.denied;
    case 404:
      return F.notFound;
    case 400:
      return F.invalid;
    default:
      return F.status(status);
  }
}

/** The shared transport's error, recognised by shape, as `errors.ts` recognises it. */
function isTransportFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "TransportError";
}

/**
 * The agent's wording of a failure, or undefined for one the provider passes on as it is: Studio's own refusal before
 * anything was sent (the allowance, the closed table), or a defect. `deadlineFired` says the read's own time budget
 * ended it. A Google failure is worded by its status alone, never by its message, since a Firestore error can echo a
 * document path the request did not hold, and a token, transport or unknown failure by its category alone.
 */
export function firestoreAgentFailure(
  error: unknown,
  budget: Pick<ReadOnlyStatementBudget, "statementTimeoutMs">,
  statement: string | undefined,
  deadlineFired: boolean,
): QueryError | undefined {
  const worded = (sentence: string) => new QueryError(sentence, FIRESTORE_TYPE, statement);
  if (error instanceof RefusedBeforeSendError || isStudioWorded(error)) return undefined;
  if (error instanceof MetadataProjectionError) return worded(error.message);
  if (deadlineFired || error instanceof TimeoutError)
    return worded(`${TIME_BUDGET_PREFIX}: no answer within ${budget.statementTimeoutMs}ms`);
  const google = googleErrorOf(error);
  if (google !== undefined) {
    // A stream that failed after it began answers 2xx with the failure's own code in its error element.
    const status =
      google.httpStatus >= 200 && google.httpStatus < 300 && google.code !== undefined
        ? google.code
        : google.httpStatus;
    return worded(statusSentence(status, google.status));
  }
  if (error instanceof QueryCancelledError) return worded(F.closed);
  if (error instanceof AuthenticationError) return worded(F.credential);
  if (isTransportFailure(error)) return worded(F.unreachable);
  // Studio's own sentences about an answer it could not read quote nothing the server wrote.
  if (error instanceof QueryError && error.message === FIRESTORE_TRANSPORT_SENTENCES.notJson)
    return worded(F.unreadableAnswer);
  if (error instanceof DatabaseError) return worded(F.failed);
  return undefined;
}
