/**
 * What the server does for an MQTT read: the repair ledger's identity of one read, the row-cap advice, and the
 * admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitMqttreadStatement } from "@/lib/db/operations/mqttread-admission";
import { readMqttAgentStatement } from "@/lib/db/providers/keyvalue/mqtt/agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * A read's identity in the repair ledger: the plan the agent's reader sends, so one request written with its keys in
 * another order or another spacing is one read. Total: a request the reader refuses is identified by its raw text, so
 * a refused request is still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintMqttread(text: string): string {
  const reading = readMqttAgentStatement(text);
  const canonical = reading.ok ? `mqttread:${JSON.stringify(reading.plan)}` : `mqttread-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/** The sentence for a read refused past the row budget, which no MQTT read reaches: each answers one row. */
export function mqttreadRowCapAdvice(_statement: string, allowed: string): string {
  return `Ask for at most ${allowed} rows: an MQTT read answers one row, the window's totals or one topic's metadata, so a row budget of 1 holds every read.`;
}

export const MQTTREAD_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "mqttread.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintMqttread,
  rowCapAdvice: mqttreadRowCapAdvice,
  admit: admitMqttreadStatement,
  shapeAdvice:
    "The request's shape falls outside what a bounded MQTT read may be, which is a decision about the contract rather than about a valid read request; a differently shaped read may still be admitted.",
});
