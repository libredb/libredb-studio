/**
 * What the server does for a Modbus read: the repair ledger's identity of one read, the row-cap advice, and the
 * admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitModbusreadStatement } from "@/lib/db/operations/modbusread-admission";
import { readModbusAgentStatement } from "@/lib/db/providers/industrial/modbus/agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * A Modbus read's identity in the repair ledger: the read the agent's reader sends, so one request written with its
 * keys in another order or other spacing is one read, and two blocks are two. Total: a request the reader refuses is
 * identified by its raw text, so a refused request is still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintModbusread(text: string): string {
  const reading = readModbusAgentStatement(text);
  const canonical = reading.ok ? `modbusread:${JSON.stringify(reading.plan)}` : `modbusread-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The sentence for a Modbus read refused past the row budget. A points read answers one row per point, a block one
 * row per item (or per decoded value) and identification one row per object, and none is ever cut, so the advice is a
 * smaller read.
 */
export function modbusreadRowCapAdvice(_statement: string, allowed: string): string {
  return `Ask for at most ${allowed} rows: a points read answers one row per point it names, a block one row per coil, input or register (one per decoded value with "type"), and identification one row per object, so name fewer points, read a shorter block, or ask for a lower identification level.`;
}

export const MODBUSREAD_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "modbusread.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintModbusread,
  rowCapAdvice: modbusreadRowCapAdvice,
  admit: admitModbusreadStatement,
  shapeAdvice:
    "The request's shape falls outside what a bounded Modbus read may be, which is a decision about the contract rather than about a valid console request; a differently shaped read may still be admitted.",
});
