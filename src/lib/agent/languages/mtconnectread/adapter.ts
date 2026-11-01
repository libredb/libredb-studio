/**
 * What the server does for an MTConnect read: the repair ledger's identity of one read, the row-cap advice, and the
 * admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitMtconnectreadStatement } from "@/lib/db/operations/mtconnectread-admission";
import { readMtconnectAgentStatement } from "@/lib/db/providers/industrial/mtconnect/agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * An MTConnect read's identity in the repair ledger: the route, path parameters and query the agent's reader sends, so
 * one request written with or without its GET, with a comment above it or with its keys in another order is one read,
 * and two reads are two. Total: a request the reader refuses is identified by its raw text, so a refused request is
 * still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintMtconnectread(text: string): string {
  const reading = readMtconnectAgentStatement(text);
  const canonical = reading.ok
    ? `mtconnectread:${JSON.stringify({
        route: reading.request.route.template,
        params: reading.request.params,
        query: Object.fromEntries(Object.entries(reading.request.query).sort(([a], [b]) => (a < b ? -1 : 1))),
      })}`
    : `mtconnectread-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The sentence for an MTConnect read refused past the row budget. An observation read answers one row per
 * observation, a device model read one row per data item and an asset read one row per asset, and none is ever cut,
 * so the advice is a smaller read.
 */
export function mtconnectreadRowCapAdvice(_statement: string, allowed: string): string {
  return `Ask for at most ${allowed} rows: an observation read answers one row per observation, a device model read one row per data item and an asset read one row per asset, so name one device, narrow the path to the data items you need, or give /sample or /assets a smaller count.`;
}

export const MTCONNECTREAD_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "mtconnectread.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintMtconnectread,
  rowCapAdvice: mtconnectreadRowCapAdvice,
  admit: admitMtconnectreadStatement,
  shapeAdvice:
    "The request's shape falls outside what a bounded MTConnect read may be, which is a decision about the contract rather than about a valid console request; a differently shaped read may still be admitted.",
});
