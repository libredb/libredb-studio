/**
 * The tool definitions the oxiacli command language's workflows are offered: the statement tool for one metadata read.
 */
import { z } from "zod";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readOxiacliStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const OXIACLI_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    "Run one bounded Oxia metadata read, written as one command on one line: shards for the namespace's shard and leader counts, get <key> for one key you name, which answers its existence, version, creation and modification times, value size and whether it is ephemeral, or list alone, which answers how many keys the namespace holds and never their names. Single-quote a key that holds a space. Answers carry names, counts and sizes only. Key names and stored values are withheld, so range-scan, a count over a range or prefix you name, a comparison or secondary-index get, a partition key, a namespace or address, every write, delete, session and notification, and every other flag are refused before anything is sent, and a namespace holding more keys than the row budget is refused rather than counted in part, and you are told why.",
  inputSchema: readOxiacliStatementSchema,
  operationId: "oxiacli.query.read",
});

const OXIACLI_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: OXIACLI_RUN_READ_QUERY,
});

/** The investigation sends commands through the one statement tool; `operations` sends none. */
export const OXIACLI_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: OXIACLI_STATEMENT_TOOLS,
});
