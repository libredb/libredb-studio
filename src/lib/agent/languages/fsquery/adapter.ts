/**
 * What the server does for a Firestore metadata read: the repair ledger's identity of one read, the row-cap advice,
 * and the admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitFsqueryStatement } from "@/lib/db/operations/fsquery-admission";
import { readFirestoreAgentStatement } from "@/lib/db/providers/document/firestore/agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * A Firestore read's identity in the repair ledger: the read the agent's reader sends, so a statement written with
 * `await` or without it, with `.get()` or without it, or through `db.collection("users").doc("alice")` or
 * `db.doc("users/alice")`, is one read, and two paths are two. Total: a statement the reader refuses is identified by
 * its raw text, so a refused statement is still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintFsquery(text: string): string {
  const reading = readFirestoreAgentStatement(text);
  const canonical = reading.ok ? `fsquery:${JSON.stringify(reading.plan)}` : `fsquery-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The sentence for a Firestore read refused past the row budget. A listing answers one row per collection id and
 * every other read one row; a count answers only when the collection holds at most the budget's documents, and no
 * narrower count is offered, since it would reveal stored values. Exported for its tests, like the fingerprint.
 */
export function fsqueryRowCapAdvice(_statement: string, allowed: string): string {
  return `Ask for at most ${allowed} rows: db.listCollections() answers one row per collection id and every other read one row, and a collection's count is answered only when it holds at most ${allowed} documents; a count narrowed by where, orderBy, a cursor, offset, limit or select is not one of agent mode's reads, since it would reveal stored values.`;
}

export const FSQUERY_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "fsquery.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintFsquery,
  rowCapAdvice: fsqueryRowCapAdvice,
  admit: admitFsqueryStatement,
  shapeAdvice:
    "The statement's shape falls outside what a bounded metadata read may be, which is a decision about the contract rather than about a valid Firestore statement; a differently shaped read may still be admitted.",
});
