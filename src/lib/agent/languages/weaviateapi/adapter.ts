/**
 * What the server does for a Weaviate metadata read: the repair ledger's identity of one read, the row-cap advice in
 * the request's own words, and the admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { toJsonText } from "@/lib/db/console/tagged-json";
import { admitWeaviateapiStatement } from "@/lib/db/operations/weaviateapi-admission";
import { readWeaviateAgentStatement } from "@/lib/db/providers/vector/weaviate/metadata-request";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * A Weaviate read's identity in the repair ledger: the request as the agent's reader reads it, its operation, path
 * parameters, query keys in order and body, so `GET /v1/nodes?output=verbose` written with or without a comment is one
 * read and `GET /v1/schema/Note` and `GET /v1/schema/Doc` are two. Total: a request the reader refuses is identified by
 * its raw text, so a refused request is still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintWeaviateapi(text: string): string {
  const reading = readWeaviateAgentStatement(text);
  const canonical = reading.ok
    ? `weaviateapi:${JSON.stringify([
        reading.plan.route.op,
        reading.plan.request.params,
        Object.entries(reading.plan.query).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
        reading.plan.body === null ? null : toJsonText(reading.plan.body),
      ])}`
    : `weaviateapi-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The row-cap advice of each read that lists many rows. The keys are the language copy's `adviceKeys`, and
 * `statement-languages.test.ts` holds the two to each other.
 */
const WEAVIATEAPI_ROW_CAP_ADVICE: Readonly<Record<string, (allowed: string) => string>> = Object.freeze({
  schema: (allowed: string) =>
    `Ask for at most ${allowed} rows: read one collection with GET /v1/schema/{collection} instead of the whole schema, and run it again.`,
  tenants: (allowed: string) =>
    `Ask for at most ${allowed} rows: read one tenant with GET /v1/schema/{collection}/tenants/{tenant} instead of the whole list, and run it again.`,
  nodes: (allowed: string) =>
    `Ask for at most ${allowed} rows: read one collection's nodes with GET /v1/nodes/{collection}, or the nodes without output=verbose, and run it again.`,
});

const ADVICE_OF: Readonly<Record<string, string>> = Object.freeze({
  schema: "schema",
  tenants: "tenants",
  nodes: "nodes",
  collection_nodes: "nodes",
});

/** The sentence for a Weaviate read refused past the row budget. Exported for its tests, like the fingerprint. */
export function weaviateapiRowCapAdvice(statement: string, allowed: string): string {
  const reading = readWeaviateAgentStatement(statement);
  const key = reading.ok ? ADVICE_OF[reading.plan.route.op] : undefined;
  return key === undefined
    ? `Ask for at most ${allowed} rows: read one collection, tenant or node instead of the whole list, and run it again.`
    : WEAVIATEAPI_ROW_CAP_ADVICE[key](allowed);
}

export const WEAVIATEAPI_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "weaviateapi.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintWeaviateapi,
  rowCapAdvice: weaviateapiRowCapAdvice,
  admit: admitWeaviateapiStatement,
  shapeAdvice:
    "The request's shape falls outside what a bounded metadata read may be, which is a decision about the contract rather than about a valid Weaviate request; a differently shaped read may still be admitted.",
});
