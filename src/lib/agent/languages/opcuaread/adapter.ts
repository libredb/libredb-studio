/**
 * What the server does for an OPC UA read: the repair ledger's identity of one read, the row-cap advice, and the
 * admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitOpcuareadStatement } from "@/lib/db/operations/opcuaread-admission";
import { readOpcuaAgentStatement } from "@/lib/db/providers/industrial/opcua/agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * An OPC UA read's identity in the repair ledger: the read the agent's reader sends, so one request written with its
 * keys in another order, other spacing or another spelling of a namespace 0 node id is one read, and two reads are
 * two. Total: a request the reader refuses is identified by its raw text, so a refused request is still refused the
 * second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintOpcuaread(text: string): string {
  const reading = readOpcuaAgentStatement(text);
  const canonical = reading.ok ? `opcuaread:${JSON.stringify(reading.plan)}` : `opcuaread-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The sentence for an OPC UA read refused past the row budget. A value read answers one row per node it names, a
 * history read one row per value and a browse one row per child, and none is ever cut, so the advice is a smaller read.
 */
export function opcuareadRowCapAdvice(_statement: string, allowed: string): string {
  return `Ask for at most ${allowed} rows: a value read answers one row per node it names, a history read one row per value in its window, and a browse one row per child of the node, so name fewer nodes, narrow the window or give it a limit, or browse a node further down.`;
}

export const OPCUAREAD_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "opcuaread.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintOpcuaread,
  rowCapAdvice: opcuareadRowCapAdvice,
  admit: admitOpcuareadStatement,
  shapeAdvice:
    "The request's shape falls outside what a bounded OPC UA read may be, which is a decision about the contract rather than about a valid console request; a differently shaped read may still be admitted.",
});
