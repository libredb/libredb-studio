/**
 * The agent's Firestore reads, and nothing else: the client every surface of a handle opened for an agent-mode profile
 * reads through. Each member is one request of the closed request table (`requests.ts`), built with the fields named
 * here and no other, so no agent-mode surface can send a query, a document get that returns fields, a document
 * listing, an explain or anything outside the table, whatever it is handed.
 *
 * Every request is charged to the run's read allowance BEFORE it is sent, with what it may cost at most, and only after
 * the closed table has admitted it, so a request the table refuses costs nothing and a request past the allowance is
 * never sent. One collection id page is one billed read, a count one per 1,000 index entries it may read, up to its
 * `upTo`, and a document read one.
 *
 * Answers are read for the facts the agent answers and nothing else: the ids of a page and its next token, a count,
 * and a document's existence and two times. A found document's fields are never read, and the document read asks for
 * none: its mask names no field.
 */
import { QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import type { RunReadAllowance } from "@/lib/db/read-allowance";
import type { FirestoreCountSource } from "./agent-statement";
import { FIRESTORE_TYPE } from "./constants";
import { fullDocumentName } from "./names";
import { type CallBase, callContext, isRecord } from "./objects";
import { buildRequest, type FirestoreRequest } from "./requests";
import type { FirestoreClient } from "./transport";

/** What every agent request is sent under: the signal that ends it, the session's error context, the allowance. */
export interface FirestoreAgentCall {
  readonly signal: AbortSignal;
  readonly base: CallBase;
  readonly allowance: RunReadAllowance;
}

/** One page of collection ids directly under a parent, and the server's token for the next page, if any. */
export interface FirestoreIdPage {
  readonly ids: readonly string[];
  readonly next?: string;
}

/** One page request: the parent ([] for the root), the page size, and the token Studio read from the page before. */
export interface FirestoreIdPageRequest {
  readonly parent: readonly string[];
  readonly pageSize: number;
  readonly pageToken?: string;
}

/** A named document's existence and, when it exists, its two server times as Firestore wrote them. */
export interface FirestoreDocumentTimes {
  readonly exists: boolean;
  readonly createTime?: string;
  readonly updateTime?: string;
}

export interface FirestoreAgentClient {
  listCollectionIds(request: FirestoreIdPageRequest, call: FirestoreAgentCall): Promise<FirestoreIdPage>;
  countDocuments(source: FirestoreCountSource, upTo: number, call: FirestoreAgentCall): Promise<number>;
  documentTimes(path: readonly string[], call: FirestoreAgentCall): Promise<FirestoreDocumentTimes>;
}

/** The agent client's members, in the order it declares them; the boundary tests hold the client to this list. */
export const FIRESTORE_AGENT_CLIENT_MEMBERS: readonly (keyof FirestoreAgentClient)[] = Object.freeze([
  "listCollectionIds",
  "countDocuments",
  "documentTimes",
]);

/** The index entries one billed read of a count covers. */
export const COUNT_ENTRIES_PER_READ = 1_000;

/** The alias the count is asked under and read back by. */
const COUNT_ALIAS = "count";

export const FIRESTORE_AGENT_CLIENT_SENTENCES = Object.freeze({
  unreadable: "Firestore's answer to the read could not be read as the metadata asked for.",
  /** The labels a charge names the request with: Studio's words, never a path or an id. */
  listingLabel: "a collection id listing request",
  countLabel: (upTo: number): string => `a document count of up to ${upTo.toLocaleString("en-US")} documents`,
  documentLabel: "a document read",
});

const C = FIRESTORE_AGENT_CLIENT_SENTENCES;

/** The errors Studio worded itself on the agent path, which quote nothing the server wrote and pass as they are. */
const STUDIO_WORDED = new WeakSet<Error>();

/** A refusal in Studio's own words, raised on the agent path and passed on unchanged. */
export function studioWorded(sentence: string): QueryError {
  const error = new QueryError(sentence, FIRESTORE_TYPE);
  STUDIO_WORDED.add(error);
  return error;
}

/** Whether `error` is one `studioWorded` raised. */
export function isStudioWorded(error: unknown): boolean {
  return error instanceof Error && STUDIO_WORDED.has(error);
}

function unreadable(): QueryError {
  return studioWorded(C.unreadable);
}

/** The billed reads a count of up to `upTo` documents may cost: one per 1,000 index entries, and at least one. */
export function countCharge(upTo: number): number {
  return Math.max(1, Math.ceil(upTo / COUNT_ENTRIES_PER_READ));
}

/** The one request a count sends: the whole source, with no filter, order, cursor, offset or projection. */
function countRequest(source: FirestoreCountSource, upTo: number): FirestoreRequest {
  const from =
    source.kind === "collectionGroup"
      ? { collectionId: source.collectionId, allDescendants: true }
      : { collectionId: source.path[source.path.length - 1] };
  return {
    kind: "runAggregationQuery",
    parent: source.kind === "collectionGroup" ? [] : source.path.slice(0, -1),
    body: {
      structuredAggregationQuery: {
        structuredQuery: { from: [from] },
        aggregations: [{ alias: COUNT_ALIAS, count: { upTo: String(upTo) } }],
      },
    },
  };
}

function readIdPage(answer: unknown): FirestoreIdPage {
  if (!isRecord(answer)) throw unreadable();
  const { collectionIds, nextPageToken } = answer;
  if (
    collectionIds !== undefined &&
    !(Array.isArray(collectionIds) && collectionIds.every((id) => typeof id === "string"))
  )
    throw unreadable();
  if (nextPageToken !== undefined && typeof nextPageToken !== "string") throw unreadable();
  const ids = (collectionIds ?? []) as string[];
  return nextPageToken === undefined || nextPageToken === "" ? { ids } : { ids, next: nextPageToken };
}

/** The count of a runAggregationQuery stream: exactly one result element, its count alias a decimal integer. */
function readCount(answer: unknown): number {
  if (!Array.isArray(answer)) throw unreadable();
  const results = answer.filter((element) => isRecord(element) && element.result !== undefined);
  if (results.length !== 1) throw unreadable();
  const result = (results[0] as Record<string, unknown>).result;
  const fields = isRecord(result) ? result.aggregateFields : undefined;
  const value = isRecord(fields) ? fields[COUNT_ALIAS] : undefined;
  const text = isRecord(value) ? value.integerValue : undefined;
  if (typeof text !== "string" || !/^(?:0|[1-9]\d{0,15})$/.test(text)) throw unreadable();
  const count = Number(text);
  if (!Number.isSafeInteger(count)) throw unreadable();
  return count;
}

/** A batchGet stream of one document: one element, found under the requested name or missing; fields never read. */
function readTimes(answer: unknown, name: string): FirestoreDocumentTimes {
  if (!Array.isArray(answer)) throw unreadable();
  const elements = answer.filter(
    (element) => isRecord(element) && (element.found !== undefined || element.missing !== undefined),
  );
  if (elements.length !== 1) throw unreadable();
  const element = elements[0] as Record<string, unknown>;
  if (element.missing !== undefined) {
    if (element.missing !== name) throw unreadable();
    return { exists: false };
  }
  const found = element.found;
  if (!isRecord(found) || found.name !== name) throw unreadable();
  const { createTime, updateTime } = found;
  if (createTime !== undefined && typeof createTime !== "string") throw unreadable();
  if (updateTime !== undefined && typeof updateTime !== "string") throw unreadable();
  return {
    exists: true,
    ...(createTime === undefined ? {} : { createTime }),
    ...(updateTime === undefined ? {} : { updateTime }),
  };
}

/**
 * The agent's client over one session's Firestore client: the reads of `FirestoreAgentClient` alone. Each request is
 * admitted by the closed table, then charged, then sent; a refusal of either sends nothing.
 */
export function createFirestoreAgentClient(client: FirestoreClient): FirestoreAgentClient {
  async function send(request: FirestoreRequest, units: number, label: string, call: FirestoreAgentCall) {
    // The closed table first: a request it refuses costs no billed read, and is refused as nothing sent.
    try {
      buildRequest(client.target, request);
    } catch (error) {
      throw error instanceof QueryError ? new RefusedBeforeSendError(error.message, FIRESTORE_TYPE) : error;
    }
    call.allowance.charge(units, label);
    return client.send(request, { signal: call.signal, context: callContext(client, call.base, "statement") });
  }
  return Object.freeze({
    listCollectionIds: async (request: FirestoreIdPageRequest, call: FirestoreAgentCall) =>
      readIdPage(
        await send(
          {
            kind: "listCollectionIds",
            parent: request.parent,
            pageSize: request.pageSize,
            ...(request.pageToken === undefined ? {} : { pageToken: request.pageToken }),
          },
          1,
          C.listingLabel,
          call,
        ),
      ),
    countDocuments: async (source: FirestoreCountSource, upTo: number, call: FirestoreAgentCall) =>
      readCount(await send(countRequest(source, upTo), countCharge(upTo), C.countLabel(upTo), call)),
    documentTimes: async (path: readonly string[], call: FirestoreAgentCall) => {
      const name = fullDocumentName(client.target, path);
      return readTimes(
        await send(
          { kind: "batchGet", body: { documents: [name], mask: { fieldPaths: [] } } },
          1,
          C.documentLabel,
          call,
        ),
        name,
      );
    },
  } satisfies FirestoreAgentClient);
}
