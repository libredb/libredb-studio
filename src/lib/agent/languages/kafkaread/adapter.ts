/**
 * What the server does for a Kafka metadata read: the repair ledger's identity of one read, the row-cap advice, and
 * the admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitKafkareadStatement } from "@/lib/db/operations/kafkaread-admission";
import { readKafkaAgentStatement } from "@/lib/db/providers/stream/kafka/agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * A read's identity in the repair ledger: the plan the agent's reader sends, so one request written with its keys in
 * another order or another spacing is one read, and a default written out is the same read as one left out. Total: a
 * request the reader refuses is identified by its raw text, so a refused request is still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintKafkaread(text: string): string {
  const reading = readKafkaAgentStatement(text);
  const canonical = reading.ok ? `kafkaread:${JSON.stringify(reading.plan)}` : `kafkaread-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/** The sentence for a read refused past the row budget: one row per topic, broker or partition, up to its limit. */
export function kafkareadRowCapAdvice(_statement: string, allowed: string): string {
  return `Ask for at most ${allowed} rows: a read answers one row per topic, broker or partition, up to its "limit", so write "limit": ${allowed} or less, and read on with "after" set to the last name or id you read.`;
}

export const KAFKAREAD_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "kafkaread.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintKafkaread,
  rowCapAdvice: kafkareadRowCapAdvice,
  admit: admitKafkareadStatement,
  shapeAdvice:
    "The request's shape falls outside what a bounded metadata read may be, which is a decision about the contract rather than about a valid read request; a differently shaped read may still be admitted.",
});
