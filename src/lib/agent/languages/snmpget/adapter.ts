/**
 * What the server does for an SNMP read: the repair ledger's identity of one read, the row-cap advice, and the
 * admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitSnmpgetStatement } from "@/lib/db/operations/snmpget-admission";
import { readSnmpAgentStatement } from "@/lib/db/providers/network/snmp/agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * An SNMP read's identity in the repair ledger: the read the agent's reader sends, so `get sysDescr.0` and
 * `get .1.3.6.1.2.1.1.1.0` are one read, and two identifiers are two. Total: a command the reader refuses is identified
 * by its raw text, so a refused command is still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintSnmpget(text: string): string {
  const reading = readSnmpAgentStatement(text);
  const canonical = reading.ok ? `snmpget:${JSON.stringify(reading.plan)}` : `snmpget-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The sentence for an SNMP read refused past the row budget. A get or a next answers one row per identifier, a walk
 * one row per instance under its subtree and a table one row per index, and none is ever cut, so the advice is a
 * narrower subtree.
 */
export function snmpgetRowCapAdvice(_statement: string, allowed: string): string {
  return `Ask for at most ${allowed} rows: get and next answer one row per object they name, walk one row per instance under its subtree and table one row per index, so walk a narrower subtree (one column, such as ifDescr, rather than ifEntry) or name the instances with get.`;
}

export const SNMPGET_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "snmpget.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintSnmpget,
  rowCapAdvice: snmpgetRowCapAdvice,
  admit: admitSnmpgetStatement,
  shapeAdvice:
    "The command's shape falls outside what a bounded SNMP read may be, which is a decision about the contract rather than about a valid console command; a differently shaped read may still be admitted.",
});
