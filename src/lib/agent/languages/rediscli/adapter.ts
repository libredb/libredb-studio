/**
 * What the server does for a Redis metadata read: the repair ledger's identity of one read, the row-cap advice, and
 * the admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitRediscliStatement } from "@/lib/db/operations/rediscli-admission";
import { readRedisAgentStatement } from "@/lib/db/providers/keyvalue/redis-agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * A Redis read's identity in the repair ledger: the argv the agent's reader sends, so `type k` and `TYPE   k` are one
 * read and two keys are two. Total: a command the reader refuses is identified by its raw text, so a refused command is
 * still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintRediscli(text: string): string {
  const reading = readRedisAgentStatement(text);
  const canonical = reading.ok ? `rediscli:${JSON.stringify(reading.plan.argv)}` : `rediscli-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The sentence for a Redis read refused past the row budget. Every read in the table answers one row, so only a budget
 * below one row refuses it, and the advice names no narrower read. Exported for its tests, like the fingerprint.
 */
export function rediscliRowCapAdvice(_statement: string, allowed: string): string {
  return `Ask for at most ${allowed} rows: every Redis read agent mode runs answers one row, about the database or one key, so read one key at a time.`;
}

export const REDISCLI_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "rediscli.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintRediscli,
  rowCapAdvice: rediscliRowCapAdvice,
  admit: admitRediscliStatement,
  shapeAdvice:
    "The command's shape falls outside what a bounded metadata read may be, which is a decision about the contract rather than about a valid Redis command; a differently shaped read may still be admitted.",
});
