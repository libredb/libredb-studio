/**
 * The tool definitions the fsquery statement language's workflows are offered: the statement tool for one metadata
 * read.
 */
import { z } from "zod";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readFsqueryStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const FSQUERY_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    'Run one bounded Firestore metadata read, written as one Admin SDK chain starting at db: db.listCollections() for the root collection ids; db.doc("PATH").listCollections() for the subcollection ids of one document you name in full; db.collection("PATH").count() or db.collectionGroup("ID").count() for one whole collection\'s document count; or db.doc("PATH").get() for whether one document you name in full exists and when it was created and last updated. Answers carry collection ids, counts, flags and times only. Document ids and paths, field names and field values count as stored values and are withheld, so a query that returns documents, listDocuments(), getAll(), a field\'s value, sum, average, findNearest, explain, and a count narrowed by where, orderBy, a cursor, offset, limit or select are refused before anything is sent, a collection holding more documents than the row budget is refused rather than counted in part, and every read is charged to the run\'s read allowance, since Firestore bills it, and you are told why.',
  inputSchema: readFsqueryStatementSchema,
  operationId: "fsquery.query.read",
});

const FSQUERY_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: FSQUERY_RUN_READ_QUERY,
});

/** The investigation sends statements through the one statement tool; `operations` sends none. */
export const FSQUERY_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: FSQUERY_STATEMENT_TOOLS,
});
