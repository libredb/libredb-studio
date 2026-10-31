/**
 * What the server does for a NETCONF read: the repair ledger's identity of one read, the row-cap advice, and the
 * admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitNetconfrpcStatement } from "@/lib/db/operations/netconfrpc-admission";
import { readNetconfAgentStatement } from "@/lib/db/providers/network/netconf/agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * A NETCONF read's identity in the repair ledger: the read the agent's reader plans, so two spellings of one request
 * (key order, spacing, an escaped key) are one read, and two paths are two. Total: a request the reader refuses is
 * identified by its raw text, so a refused request is still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintNetconfrpc(text: string): string {
  const reading = readNetconfAgentStatement(text);
  const canonical = reading.ok ? `netconfrpc:${JSON.stringify(reading.plan)}` : `netconfrpc-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The sentence for a NETCONF read refused past the row budget. A read answers one row per entry of the list at the end
 * of its path and is never cut, so the advice is a narrower path.
 */
export function netconfrpcRowCapAdvice(_statement: string, allowed: string): string {
  return `Ask for at most ${allowed} rows: a read answers one row per entry of the list at the end of its path, so read a narrower path, such as one entry by its keys (interface=eth0) or a list nested inside one entry.`;
}

export const NETCONFRPC_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "netconfrpc.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintNetconfrpc,
  rowCapAdvice: netconfrpcRowCapAdvice,
  admit: admitNetconfrpcStatement,
  shapeAdvice:
    "The request's shape falls outside what a bounded NETCONF read may be, which is a decision about the contract rather than about a valid console request; a differently shaped read may still be admitted.",
});
