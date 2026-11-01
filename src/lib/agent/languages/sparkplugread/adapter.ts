/**
 * What the server does for a Sparkplug read: the repair ledger's identity of one read, the row-cap advice, and the
 * admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitSparkplugreadStatement } from "@/lib/db/operations/sparkplugread-admission";
import { readSparkplugAgentStatement } from "@/lib/db/providers/industrial/sparkplug/agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * A read's identity in the repair ledger: the plan the agent's reader sends, so one request written with its keys in
 * another order or another spacing is one read. Total: a request the reader refuses is identified by its raw text, so
 * a refused request is still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintSparkplugread(text: string): string {
  const reading = readSparkplugAgentStatement(text);
  const canonical = reading.ok ? `sparkplugread:${JSON.stringify(reading.plan)}` : `sparkplugread-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/** The sentence for a read refused past the row budget, which no Sparkplug read reaches: each answers one row. */
export function sparkplugreadRowCapAdvice(_statement: string, allowed: string): string {
  return `Ask for at most ${allowed} rows: a Sparkplug read answers one row, the window's totals or one group's, edge node's or device's counts, so a row budget of 1 holds every read.`;
}

export const SPARKPLUGREAD_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "sparkplugread.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintSparkplugread,
  rowCapAdvice: sparkplugreadRowCapAdvice,
  admit: admitSparkplugreadStatement,
  shapeAdvice:
    "The request's shape falls outside what a bounded Sparkplug read may be, which is a decision about the contract rather than about a valid read request; a differently shaped read may still be admitted.",
});
