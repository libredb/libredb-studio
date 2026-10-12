/**
 * The Firestore object surface (spec 5.1, 5.2, 5.5). This first part is the collection id listing the tree, the
 * Keys panel's id levels, the Source tab and the console's `listCollections()` share: every page of
 * `listCollectionIds` up to the id-listing cap, each id held to the id rules before it is shown or reused, sorted by
 * UTF-8 bytes because Firestore promises no order.
 *
 * Every request carries the context its failure is mapped under: the session's credential kind and the credential's
 * secret forms (`CallBase`, built once per session by the provider, so a Google message quoting the credential is
 * withheld), the connection's target, and the surface that asked, so an answer past its cap is worded for it.
 */
import { QueryError } from "@/lib/db/errors";
import { FIRESTORE_ERROR_PROVIDER, LIMITS } from "./constants";
import type { CallPhase, ErrorContext } from "./errors";
import { compareUtf8, idRefusal } from "./names";
import type { FirestoreClient } from "./transport";

/** What every request of one session carries besides the target: the credential kind and its secret forms. */
export interface CallBase {
  readonly credential: ErrorContext["credential"];
  readonly secretForms: readonly string[];
}

/** The surface that asked; the console's `listCollections()` reads through the same listing (spec 5.6). */
export type CallSurface = "keys" | "tree" | "source" | "console";

export const FIRESTORE_LISTING_SENTENCES = Object.freeze({
  idCap: `Studio stops after ${LIMITS.idListingRequests} id listing requests at one level, so ids past the ones those requests returned are not listed.`,
  malformed: "Firestore answered a listing Studio cannot read.",
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The context every request of a surface read carries. */
export function callContext(
  client: FirestoreClient,
  base: CallBase,
  phase: CallPhase,
  surface?: ErrorContext["surface"],
): ErrorContext {
  return {
    phase,
    credential: base.credential,
    secretForms: base.secretForms,
    target: client.target,
    ...(surface === undefined ? {} : { surface }),
  };
}

function malformedListing(): QueryError {
  return new QueryError(FIRESTORE_LISTING_SENTENCES.malformed, FIRESTORE_ERROR_PROVIDER);
}

function readIdPage(answer: unknown): { readonly ids: readonly string[]; readonly next: string | undefined } {
  if (!isRecord(answer)) throw malformedListing();
  const { collectionIds, nextPageToken } = answer;
  if (
    collectionIds !== undefined &&
    !(Array.isArray(collectionIds) && collectionIds.every((id) => typeof id === "string"))
  )
    throw malformedListing();
  if (nextPageToken !== undefined && typeof nextPageToken !== "string") throw malformedListing();
  return {
    ids: (collectionIds ?? []) as string[],
    next: nextPageToken === undefined || nextPageToken === "" ? undefined : nextPageToken,
  };
}

/**
 * Every collection id directly under `parent` (the database root for `[]`), up to `LIMITS.idListingRequests`
 * requests of `LIMITS.idListingPageSize` ids; `complete` is false when the cap stopped the read, and `skipped` counts
 * the distinct ids the id rules refused.
 */
export async function listCollectionIdsSorted(
  client: FirestoreClient,
  parent: readonly string[],
  signal: AbortSignal,
  base: CallBase,
  surface: CallSurface,
): Promise<{ ids: string[]; complete: boolean; skipped: number }> {
  const listed = new Set<string>();
  const context = callContext(client, base, "listing", surface);
  let token: string | undefined;
  let complete = false;
  for (let request = 0; request < LIMITS.idListingRequests && !complete; request += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page's request carries the token the one before it returned.
    const answer = await client.send(
      {
        kind: "listCollectionIds",
        parent,
        pageSize: LIMITS.idListingPageSize,
        ...(token === undefined ? {} : { pageToken: token }),
      },
      { signal, context },
    );
    const page = readIdPage(answer);
    for (const id of page.ids) listed.add(id);
    token = page.next;
    complete = token === undefined;
  }
  const ids = [...listed].filter((id) => idRefusal(id, "collection") === null).sort(compareUtf8);
  return { ids, complete, skipped: listed.size - ids.length };
}
