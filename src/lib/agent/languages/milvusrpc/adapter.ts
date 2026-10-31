/**
 * What the server does for a Milvus metadata read: the repair ledger's identity of one read, the row-cap advice in
 * the request's own words, and the admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitMilvusrpcStatement } from "@/lib/db/operations/milvusrpc-admission";
import { readMilvusAgentStatement } from "@/lib/db/providers/vector/milvus/metadata-request";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * A Milvus read's identity in the repair ledger: the request as the agent's reader reads it, its route and what it
 * names, with the console's defaults written in, so `collections/describe` written with its body's keys in either
 * order is one read and two collections are two. Total: a request the reader refuses is identified by its raw text,
 * so a refused request is still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintMilvusrpc(text: string): string {
  const reading = readMilvusAgentStatement(text);
  const canonical = reading.ok
    ? `milvusrpc:${JSON.stringify(Object.entries(reading.plan).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))}`
    : `milvusrpc-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The row-cap advice of each read that lists many rows. The keys are the language copy's `adviceKeys`, and
 * `statement-languages.test.ts` holds the two to each other.
 */
const MILVUS_ROW_CAP_ADVICE: Readonly<Record<string, (allowed: string) => string>> = Object.freeze({
  databases: (allowed: string) =>
    `Ask for at most ${allowed} rows: read the connection's own database with databases/describe instead of the whole list, and run it again.`,
  collections: (allowed: string) =>
    `Ask for at most ${allowed} rows: read one collection with collections/describe instead of the whole list, and run it again.`,
  collection: (allowed: string) =>
    `Ask for at most ${allowed} rows: read the collection's indexes with indexes/list, or its row count with collections/get_stats, instead of every field, and run it again.`,
  partitions: (allowed: string) =>
    `Ask for at most ${allowed} rows: read the collection's load state or row count instead of every partition, and run it again.`,
  aliases: (allowed: string) =>
    `Ask for at most ${allowed} rows: read one collection's aliases with aliases/list and a collectionName instead of every alias, and run it again.`,
});

const ADVICE_OF: Readonly<Record<string, string>> = Object.freeze({
  "databases/list": "databases",
  "collections/list": "collections",
  "collections/describe": "collection",
  "partitions/list": "partitions",
  "aliases/list": "aliases",
});

/** The sentence for a Milvus read refused past the row budget. Exported for its tests, like the fingerprint. */
export function milvusrpcRowCapAdvice(statement: string, allowed: string): string {
  const reading = readMilvusAgentStatement(statement);
  const key = reading.ok ? ADVICE_OF[reading.plan.op] : undefined;
  return key === undefined
    ? `Ask for at most ${allowed} rows: read one collection instead of the whole list, and run it again.`
    : MILVUS_ROW_CAP_ADVICE[key](allowed);
}

export const MILVUSRPC_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "milvusrpc.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintMilvusrpc,
  rowCapAdvice: milvusrpcRowCapAdvice,
  admit: admitMilvusrpcStatement,
  shapeAdvice:
    "The request's shape falls outside what a bounded metadata read may be, which is a decision about the contract rather than about a valid Milvus request; a differently shaped read may still be admitted.",
});
