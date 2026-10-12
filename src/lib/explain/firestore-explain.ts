import { isQueryError } from "@/lib/db/errors";
import { parseStatement, type Statement } from "@/lib/db/providers/document/firestore/console/parser";
import type { ExplainPlanInput, ExplainStrategy, ExplainTreeNode } from "./types";

/**
 * The Firestore explain strategy's marker (spec 5.7): the text the Explain button puts before a statement. It lies
 * outside the console grammar, where `--` is not a token, so the provider recognises it only at offset 0 and a
 * failed strip is a parse error, never a run.
 */
export const FIRESTORE_EXPLAIN_MARKER = "-- libredb:firestore-explain\n";

/** Why the strategy declines each statement kind that has no plan, one sentence per kind. */
export const FIRESTORE_EXPLAIN_DECLINES = Object.freeze({
  getDocument: "A document read by its path has no query plan: Explain plans a query.",
  getAll: "getAll() reads documents by their paths and has no query plan: Explain plans a query.",
  listCollections: "listCollections() lists collection ids and has no query plan: Explain plans a query.",
  listDocuments: "listDocuments() lists document names and has no query plan: Explain plans a query.",
  alreadyExplained:
    "This statement already calls explain(): run it to see its plan, or remove explain() and press Explain.",
});

/** The parsed statement, or null where the parser refuses the text. Any other failure is raised. */
function parsed(text: string): Statement | null {
  try {
    return parseStatement(text);
  } catch (error) {
    if (isQueryError(error)) return null;
    throw error;
  }
}

/** The sentence a statement that has no plan is declined with, or null for a query, a vector query or an aggregation. */
function declineOf(statement: Statement): string | null {
  switch (statement.kind) {
    case "getDocument":
      return FIRESTORE_EXPLAIN_DECLINES.getDocument;
    case "getAll":
      return FIRESTORE_EXPLAIN_DECLINES.getAll;
    case "listCollections":
      return FIRESTORE_EXPLAIN_DECLINES.listCollections;
    case "listDocuments":
      return FIRESTORE_EXPLAIN_DECLINES.listDocuments;
    default:
      return statement.explain === undefined ? null : FIRESTORE_EXPLAIN_DECLINES.alreadyExplained;
  }
}

/** The one explain row a Firestore explain answers (Firestore spec 5.6): `indexesUsed`, and `executionStats` or null. */
interface FirestoreExplainRow {
  readonly indexesUsed: readonly unknown[];
  readonly executionStats: Readonly<Record<string, unknown>> | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isExplainRow(raw: unknown): raw is FirestoreExplainRow {
  return (
    isRecord(raw) && Array.isArray(raw.indexesUsed) && (raw.executionStats === null || isRecord(raw.executionStats))
  );
}

const valueText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/** A count Firestore sends as an int64 string or a number, or undefined for anything else. */
function countOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/**
 * One index the plan used. Google's pages spell the scope `query_scope` and `queryScope`, so both are read; every
 * other key is shown rather than dropped, because the report's format is outside Google's deprecation policy.
 */
function indexNode(entry: unknown): ExplainTreeNode {
  if (!isRecord(entry)) return { label: "Index", detail: valueText(entry), children: [] };
  const properties = typeof entry.properties === "string" ? entry.properties : undefined;
  const details: string[] = [];
  const scope = entry.query_scope ?? entry.queryScope;
  if (scope !== undefined) details.push(`scope: ${valueText(scope)}`);
  for (const [key, value] of Object.entries(entry)) {
    if (key === "query_scope" || key === "queryScope") continue;
    if (key === "properties" && properties !== undefined) continue;
    details.push(`${key}: ${valueText(value)}`);
  }
  return {
    label: properties === undefined ? "Index" : `Index ${properties}`,
    ...(details.length > 0 && { detail: details.join("; ") }),
    children: [],
  };
}

/** The execution statistics, every key as sent, with the returned-document count as the node's metric. */
function statsNode(stats: Readonly<Record<string, unknown>>): ExplainTreeNode {
  const returned = countOf(stats.resultsReturned);
  return {
    label: "Execution statistics",
    detail: Object.entries(stats)
      .map(([key, value]) => `${key}: ${valueText(value)}`)
      .join("; "),
    ...(returned !== undefined && { metrics: { actualRows: returned } }),
    children: [],
  };
}

export const firestoreExplainStrategy: ExplainStrategy = {
  format: "firestore-explain",
  // Firestore bills a plan request like a query, so an ordinary run sends none; the Explain button still does.
  backgroundPlan: false,
  // Plan-only in both modes: the provider sends `analyze: false` whatever the mode, so estimate equals analyze. Text the
  // parser refuses is marked too, so the server answers with the parser's own sentence.
  buildSql(text) {
    const statement = parsed(text);
    if (statement !== null && declineOf(statement) !== null) return null;
    return `${FIRESTORE_EXPLAIN_MARKER}${text}`;
  },
  declineReason(text) {
    const statement = parsed(text);
    return statement === null ? null : declineOf(statement);
  },
  extractPlan(result) {
    return result.rows?.[0] ?? null;
  },
  toRenderModel(raw): ExplainPlanInput | null {
    if (!isExplainRow(raw)) return null;
    const count = raw.indexesUsed.length;
    return {
      kind: "tree",
      root: {
        label: "Firestore query plan",
        detail: `${count} ${count === 1 ? "index" : "indexes"} used`,
        children: [
          ...raw.indexesUsed.map(indexNode),
          ...(raw.executionStats === null ? [] : [statsNode(raw.executionStats)]),
        ],
      },
      raw,
    };
  },
};
