/**
 * What the server does for an S3 metadata read: the repair ledger's identity of one read, the row-cap advice, and the
 * admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitS3apiStatement } from "@/lib/db/operations/s3api-admission";
import { readS3AgentStatement } from "@/lib/db/providers/objectstore/s3/agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * An S3 read's identity in the repair ledger: the read the agent's reader sends, so a command written with `aws` or
 * without it, with `--bucket=sales` or `--bucket sales`, is one read, and two keys are two. Total: a command the reader
 * refuses is identified by its raw text, so a refused command is still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintS3api(text: string): string {
  const reading = readS3AgentStatement(text);
  const canonical = reading.ok ? `s3api:${JSON.stringify(reading.plan)}` : `s3api-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The sentence for an S3 read refused past the row budget. The bucket listing answers one row per bucket and every
 * other read one row; a bucket's summary counts its objects only up to the budget, and no narrower count is offered,
 * since it would reveal key names. Exported for its tests, like the fingerprint.
 */
export function s3apiRowCapAdvice(_statement: string, allowed: string): string {
  return `Ask for at most ${allowed} rows: aws s3api list-buckets answers one row per bucket and every other read one row, and a bucket's summary counts it only when it holds at most ${allowed} objects; a count over a prefix is not one of agent mode's reads, since it would reveal key names.`;
}

export const S3API_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "s3api.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintS3api,
  rowCapAdvice: s3apiRowCapAdvice,
  admit: admitS3apiStatement,
  shapeAdvice:
    "The command's shape falls outside what a bounded metadata read may be, which is a decision about the contract rather than about a valid AWS CLI command; a differently shaped read may still be admitted.",
});
