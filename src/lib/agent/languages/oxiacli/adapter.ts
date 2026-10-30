/**
 * What the server does for an Oxia metadata read: the repair ledger's identity of one read, the row-cap advice, and
 * the admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitOxiacliStatement } from "@/lib/db/operations/oxiacli-admission";
import { readOxiaAgentStatement } from "@/lib/db/providers/keyvalue/oxia/agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * An Oxia read's identity in the repair ledger: the read the agent's reader sends, so `get /a` and `get '/a'` are one
 * read and two keys are two. Total: a command the reader refuses is identified by its raw text, so a refused command
 * is still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintOxiacli(text: string): string {
  const reading = readOxiaAgentStatement(text);
  const canonical = reading.ok ? `oxiacli:${JSON.stringify(reading.plan)}` : `oxiacli-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The sentence for an Oxia read refused past the row budget. Every read answers one row, and a key count larger than
 * the budget is refused by the provider with its own sentence, so the advice names the narrower count. Exported for its
 * tests, like the fingerprint.
 */
export function oxiacliRowCapAdvice(_statement: string, allowed: string): string {
  return `Ask for at most ${allowed} rows: shards, get and list each answer one row, and a list counts at most ${allowed} keys, so count a narrower range with list -s <min> -e <max> or a longer --prefix.`;
}

export const OXIACLI_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "oxiacli.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintOxiacli,
  rowCapAdvice: oxiacliRowCapAdvice,
  admit: admitOxiacliStatement,
  shapeAdvice:
    "The command's shape falls outside what a bounded metadata read may be, which is a decision about the contract rather than about a valid oxia command; a differently shaped read may still be admitted.",
});
