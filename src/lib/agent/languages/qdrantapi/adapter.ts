/**
 * What the server does for a Qdrant metadata read: the repair ledger's identity of one read, the row-cap advice in
 * the request's own words, and the admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { toJsonText } from "@/lib/db/console/tagged-json";
import { admitQdrantapiStatement } from "@/lib/db/operations/qdrantapi-admission";
import { readQdrantAgentStatement } from "@/lib/db/providers/vector/qdrant/metadata-request";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * A Qdrant read's identity in the repair ledger: the request as the agent's reader reads it, its operation, path
 * parameters, query keys in order and body with its defaults written in, so `POST /collections/plain/points/count`
 * written with or without `{"exact": true}` is one read and `GET /collections/plain` and `GET /collections/docs` are
 * two. Total: a request the reader refuses is identified by its raw text, so a refused request is still refused the
 * second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintQdrantapi(text: string): string {
  const reading = readQdrantAgentStatement(text);
  const canonical = reading.ok
    ? `qdrantapi:${JSON.stringify([
        reading.plan.route.op,
        reading.plan.request.params,
        Object.entries(reading.plan.request.query).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
        reading.plan.body === null ? null : toJsonText(reading.plan.body),
      ])}`
    : `qdrantapi-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The row-cap advice of each read that lists many rows. The keys are the language copy's `adviceKeys`, and
 * `statement-languages.test.ts` holds the two to each other.
 */
const QDRANT_ROW_CAP_ADVICE: Readonly<Record<string, (allowed: string) => string>> = Object.freeze({
  collections: (allowed: string) =>
    `Ask for at most ${allowed} rows: read one collection with GET /collections/{collection} instead of the whole list, and run it again.`,
  collection: (allowed: string) =>
    `Ask for at most ${allowed} rows: count the collection with POST /collections/{collection}/points/count, or read its cluster layout, instead of every vector and payload index, and run it again.`,
  aliases: (allowed: string) =>
    `Ask for at most ${allowed} rows: read one collection's aliases with GET /collections/{collection}/aliases instead of every alias, and run it again.`,
});

const ADVICE_OF: Readonly<Record<string, string>> = Object.freeze({
  get_collections: "collections",
  get_collection: "collection",
  get_collections_aliases: "aliases",
});

/** The sentence for a Qdrant read refused past the row budget. Exported for its tests, like the fingerprint. */
export function qdrantapiRowCapAdvice(statement: string, allowed: string): string {
  const reading = readQdrantAgentStatement(statement);
  const key = reading.ok ? ADVICE_OF[reading.plan.route.op] : undefined;
  return key === undefined
    ? `Ask for at most ${allowed} rows: read one collection instead of the whole list, and run it again.`
    : QDRANT_ROW_CAP_ADVICE[key](allowed);
}

export const QDRANTAPI_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "qdrantapi.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintQdrantapi,
  rowCapAdvice: qdrantapiRowCapAdvice,
  admit: admitQdrantapiStatement,
  shapeAdvice:
    "The request's shape falls outside what a bounded metadata read may be, which is a decision about the contract rather than about a valid Qdrant request; a differently shaped read may still be admitted.",
});
