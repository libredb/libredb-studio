/**
 * What the server does for an InfluxQL read: the repair ledger's identity of one read, the row-cap advice in the
 * statement's own words, and the admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitInfluxqlStatement } from "@/lib/db/operations/influxql-admission";
import { lexInfluxql } from "@/lib/db/providers/timeseries/influxdb/influxql-lexer";
import { readInfluxqlAgentStatement } from "@/lib/db/providers/timeseries/influxdb/influxql-agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * An InfluxQL read's identity in the repair ledger: its tokens, whitespace dropped and keywords folded, so
 * `SELECT * FROM home` and `select *  from home` are one read and `FROM home` and `FROM "home2"` are two. Total: a
 * statement the agent's reader refuses is identified by its raw text, so a refused statement is still refused the
 * second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintInfluxql(text: string): string {
  const canonical = readInfluxqlAgentStatement(text).ok
    ? `influxql:${JSON.stringify(
        lexInfluxql(text)
          .filter((token) => token.kind !== "whitespace")
          .map((token) => [token.kind, token.value ?? text.slice(token.start, token.end)]),
      )}`
    : `influxql-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The row-cap advice of each statement kind. The keys are the language copy's `adviceKeys`, and
 * `statement-languages.test.ts` holds the two to each other.
 */
const INFLUXQL_ROW_CAP_ADVICE: Readonly<Record<string, (allowed: string) => string>> = Object.freeze({
  SELECT: (allowed: string) =>
    `Ask for at most ${allowed} rows: narrow the time range (WHERE time > now() - 1h), aggregate with GROUP BY time(...), or bound it with LIMIT and SLIMIT, since LIMIT counts per series, and run it again.`,
  SHOW: (allowed: string) =>
    `Ask for at most ${allowed} rows: narrow it with FROM, WITH KEY or WHERE, or bound it with LIMIT, and run it again.`,
});

/** The sentence for an InfluxQL read refused past the row budget. Exported for its tests, like the fingerprint. */
export function influxqlRowCapAdvice(statement: string, allowed: string): string {
  const reading = readInfluxqlAgentStatement(statement);
  const advice = reading.ok ? INFLUXQL_ROW_CAP_ADVICE[reading.statement] : undefined;
  return advice === undefined
    ? `Ask for at most ${allowed} rows: narrow the read to fewer rows, and run it again.`
    : advice(allowed);
}

export const INFLUXQL_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "influxql.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintInfluxql,
  rowCapAdvice: influxqlRowCapAdvice,
  admit: admitInfluxqlStatement,
  shapeAdvice:
    "The statement's shape falls outside what a bounded read-only read may be, which is a decision about the contract rather than about a valid InfluxQL statement; a differently shaped read may still be admitted.",
});
