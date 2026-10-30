/**
 * What the server does for a RabbitMQ stream read: the repair ledger's identity of one read, the row-cap advice, and
 * the admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitRabbitreadStatement } from "@/lib/db/operations/rabbitread-admission";
import { readRabbitMQAgentStatement } from "@/lib/db/providers/stream/rabbitmq/agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * A stream read's identity in the repair ledger: the read the agent's reader sends, so one request written with its
 * keys in another order or another spacing is one read, and a default written out is the same read as one left out.
 * Total: a request the reader refuses is identified by its raw text, so a refused request is still refused the second
 * time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintRabbitread(text: string): string {
  const reading = readRabbitMQAgentStatement(text);
  const canonical = reading.ok
    ? `rabbitread:${JSON.stringify({
        vhost: reading.plan.vhost,
        stream: reading.plan.stream,
        from: reading.plan.startText,
        limit: reading.plan.limit,
      })}`
    : `rabbitread-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/** The sentence for a stream read refused past the row budget: one row per message, at most the request's limit. */
export function rabbitreadRowCapAdvice(_statement: string, allowed: string): string {
  return `Ask for at most ${allowed} rows: a read answers one row per message, up to its "limit", so write "limit": ${allowed} or less, and read on from the offset after the last one you read.`;
}

export const RABBITREAD_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "rabbitread.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintRabbitread,
  rowCapAdvice: rabbitreadRowCapAdvice,
  admit: admitRabbitreadStatement,
  shapeAdvice:
    "The request's shape falls outside what a bounded metadata read may be, which is a decision about the contract rather than about a valid read request; a differently shaped read may still be admitted.",
});
