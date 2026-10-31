/**
 * The agent's reader of one Firestore statement: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure. It reads the text with the console's own parser (`console/parser.ts`), so a statement is read by one grammar
 * wherever it is written, and then admits only the parsed statements of a closed table of four metadata reads, each
 * mapped to one request of the provider's closed request table: the root collection ids, the subcollection ids of one
 * document the statement names in full, one whole collection's or collection group's document count, and one document
 * the statement names in full, answered with its existence, create time and update time. Everything else is refused
 * with the agent's own sentence, or, for a statement the console's parser cannot read (a write, a bad path, a second
 * statement), the parser's sentence followed by the agent's reads.
 *
 * Metadata only. Collection ids and the database id are object names; document ids and paths count as stored values,
 * since they name users and tenants, and so do field names and field values, since a map's keys are often ids. So no
 * statement here returns a document, a document id or a field: no query, listDocuments, getAll or explain. A count
 * narrowed by a filter, an order, a cursor, an offset, a limit or a projection would let narrower and narrower counts
 * spell out stored values, and a sum, an average or a nearest-neighbour search reads them outright, so the only count
 * is a whole collection's or a whole collection group's.
 *
 * Not the boundary. The boundary is the provider's structural closed table: the agent's reads reach the transport only
 * through `FirestoreAgentClient` (`agent-client.ts`), which holds these four requests alone over the closed request
 * table of `requests.ts`. This is what lets the model read why it was refused, before anything is sent.
 */
import { QueryError } from "@/lib/db/errors";
import { type AggregationSpec, parseStatement, type QueryOps, type Statement } from "./console/parser";
import { verbParentHasColon } from "./names";

export type FirestoreAgentRefusalCode = "request" | "metadata-only" | "oracle";

/** The metadata operations, each one row of the table and one projection of the answer. */
export type FirestoreAgentOperation = "list-collections" | "count" | "document";

/** What a count counts: one collection, at the root or under a named document, or every collection of one id. */
export type FirestoreCountSource =
  | { readonly kind: "collection"; readonly path: readonly string[] }
  | { readonly kind: "collectionGroup"; readonly collectionId: string };

/** One read the agent may send. */
export type FirestoreAgentPlan =
  /** `parent` is [] for the database root, or the path of one document the statement names in full. */
  | { readonly op: "list-collections"; readonly parent: readonly string[] }
  | { readonly op: "count"; readonly source: FirestoreCountSource }
  | { readonly op: "document"; readonly path: readonly string[] };

export type FirestoreAgentReading =
  | { readonly ok: true; readonly plan: FirestoreAgentPlan }
  | { readonly ok: false; readonly code: FirestoreAgentRefusalCode; readonly message: string };

const NOTHING_SENT = "Nothing was sent.";

const AGENT_READS =
  'Agent mode on Firestore reads metadata only, one statement per read: db.listCollections() for the root collection ids, db.doc("PATH").listCollections() for the subcollection ids of one document the request names in full, db.collection("PATH").count() or db.collectionGroup("ID").count() for one whole collection\'s document count, with nothing narrowing it, and db.doc("PATH").get() for whether one document the request names in full exists and when it was created and last updated, never its fields.';

export const FIRESTORE_AGENT_SENTENCES = {
  reads: AGENT_READS,
  empty: `The request holds no statement. ${AGENT_READS} ${NOTHING_SENT}`,
  narrowed: `A count narrowed by where, orderBy, a cursor (startAt, startAfter, endAt, endBefore), offset, limit or select is withheld, since narrower and narrower counts would reveal stored values: agent mode counts only a whole collection or a whole collection group. ${AGENT_READS} ${NOTHING_SENT}`,
  valueOracle: `A sum, an average or a nearest-neighbour search reads stored field values, which agent mode never does. ${AGENT_READS} ${NOTHING_SENT}`,
  documents: `That reads documents, whose ids, field names and values count as stored values, so agent mode never sends it. ${AGENT_READS} ${NOTHING_SENT}`,
  documentIds: `listDocuments() lists document ids, which count as stored values, so agent mode never sends it. ${AGENT_READS} ${NOTHING_SENT}`,
  explain: `explain() answers a query plan that names indexed fields and, with analyze, runs the query, so agent mode never sends it. ${AGENT_READS} ${NOTHING_SENT}`,
  colon: `Firestore reads a colon in the last id of a listing's or a count's parent document as the start of a method name, so Studio cannot list or count under that document. ${AGENT_READS} ${NOTHING_SENT}`,
  control: `A path cannot hold a control character. ${AGENT_READS} ${NOTHING_SENT}`,
  /** `message` is the console parser's refusal, which names a position in the statement; the agent's reads follow it. */
  request: (message: string): string => `${message} ${AGENT_READS} ${NOTHING_SENT}`,
} as const;

function refuse(code: FirestoreAgentRefusalCode, message: string): FirestoreAgentReading {
  return { ok: false, code, message };
}

/** Whether a count reads every document of its source: no filter, order, cursor, offset, limit or projection. */
function whole(ops: QueryOps): boolean {
  return (
    ops.where.length === 0 &&
    ops.orderBy.length === 0 &&
    ops.limit === undefined &&
    ops.offset === undefined &&
    ops.select === undefined &&
    ops.start === undefined &&
    ops.end === undefined
  );
}

/** Whether the one aggregation is a count; a sum or an average reads the values it adds up. */
function countsOnly(aggregations: readonly AggregationSpec[]): boolean {
  return aggregations.length === 1 && aggregations[0].op === "count";
}

/** A segment holding a C0 control character or DEL, which no path a request names needs. */
function holdsControl(segments: readonly string[]): boolean {
  return segments.some((segment) => {
    for (let index = 0; index < segment.length; index += 1) {
      const code = segment.charCodeAt(index);
      if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
  });
}

/** The plan of one parsed statement, or why it is refused. */
function planOf(statement: Statement): FirestoreAgentReading {
  switch (statement.kind) {
    case "listCollections":
      if (verbParentHasColon(statement.parent)) return refuse("request", FIRESTORE_AGENT_SENTENCES.colon);
      return { ok: true, plan: { op: "list-collections", parent: statement.parent } };
    case "getDocument":
      return { ok: true, plan: { op: "document", path: statement.path } };
    case "aggregate": {
      if (statement.explain !== undefined) return refuse("metadata-only", FIRESTORE_AGENT_SENTENCES.explain);
      if (!countsOnly(statement.aggregations)) return refuse("oracle", FIRESTORE_AGENT_SENTENCES.valueOracle);
      if (!whole(statement.ops)) return refuse("oracle", FIRESTORE_AGENT_SENTENCES.narrowed);
      const { source } = statement;
      if (source.kind === "collectionGroup")
        return {
          ok: true,
          plan: { op: "count", source: { kind: "collectionGroup", collectionId: source.collectionId } },
        };
      if (verbParentHasColon(source.path.slice(0, -1))) return refuse("request", FIRESTORE_AGENT_SENTENCES.colon);
      return { ok: true, plan: { op: "count", source: { kind: "collection", path: source.path } } };
    }
    case "vector":
      if (statement.explain !== undefined) return refuse("metadata-only", FIRESTORE_AGENT_SENTENCES.explain);
      return refuse("oracle", FIRESTORE_AGENT_SENTENCES.valueOracle);
    case "query":
      if (statement.explain !== undefined) return refuse("metadata-only", FIRESTORE_AGENT_SENTENCES.explain);
      return refuse("metadata-only", FIRESTORE_AGENT_SENTENCES.documents);
    case "listDocuments":
      return refuse("metadata-only", FIRESTORE_AGENT_SENTENCES.documentIds);
    case "getAll":
      return refuse("metadata-only", FIRESTORE_AGENT_SENTENCES.documents);
  }
}

/** The path segments a plan names, for the control-character check. */
function segmentsOf(plan: FirestoreAgentPlan): readonly string[] {
  switch (plan.op) {
    case "list-collections":
      return plan.parent;
    case "document":
      return plan.path;
    case "count":
      return plan.source.kind === "collection" ? plan.source.path : [plan.source.collectionId];
  }
}

/** One agent statement read to the request the provider sends, or to why it sends nothing. Never sends anything. */
export function readFirestoreAgentStatement(text: string): FirestoreAgentReading {
  if (text.trim() === "") return refuse("request", FIRESTORE_AGENT_SENTENCES.empty);
  let statement: Statement;
  try {
    statement = parseStatement(text);
  } catch (error) {
    // The parser refuses with a QueryError only; anything else is a defect and passes as it is.
    if (!(error instanceof QueryError)) throw error;
    return refuse("request", FIRESTORE_AGENT_SENTENCES.request(error.message));
  }
  const reading = planOf(statement);
  if (reading.ok && holdsControl(segmentsOf(reading.plan))) return refuse("request", FIRESTORE_AGENT_SENTENCES.control);
  return reading;
}
