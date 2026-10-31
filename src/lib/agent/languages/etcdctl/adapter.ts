/**
 * What the server does for an etcd metadata read: the repair ledger's identity of one read, the row-cap advice, and
 * the admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitEtcdctlStatement } from "@/lib/db/operations/etcdctl-admission";
import { readEtcdAgentStatement } from "@/lib/db/providers/keyvalue/etcd/agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * An etcd read's identity in the repair ledger: the read the agent's reader sends, so `get /a` and `get "/a"` are one
 * read and two keys are two. Total: a command the reader refuses is identified by its raw text, so a refused command
 * is still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintEtcdctl(text: string): string {
  const reading = readEtcdAgentStatement(text);
  const canonical = reading.ok
    ? `etcdctl:${JSON.stringify(reading.plan, (_name, value: unknown) => (value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value))}`
    : `etcdctl-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The sentence for an etcd read refused past the row budget. A key, the key count and the cluster's status answer one
 * row, so only a list (members, alarms, leases) can pass the budget, and the advice names the reads that answer one.
 * Exported for its tests, like the fingerprint.
 */
export function etcdctlRowCapAdvice(_statement: string, allowed: string): string {
  return `Ask for at most ${allowed} rows: member list, alarm list and lease list answer one row per member, alarm or lease, so read one lease with lease timetolive, or the cluster with endpoint status.`;
}

export const ETCDCTL_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "etcdctl.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintEtcdctl,
  rowCapAdvice: etcdctlRowCapAdvice,
  admit: admitEtcdctlStatement,
  shapeAdvice:
    "The command's shape falls outside what a bounded metadata read may be, which is a decision about the contract rather than about a valid etcdctl command; a differently shaped read may still be admitted.",
});
