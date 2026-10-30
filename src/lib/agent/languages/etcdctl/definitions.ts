/**
 * The tool definitions the etcdctl command language's workflows are offered: the statement tool for one metadata read.
 */
import { z } from "zod";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readEtcdctlStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const ETCDCTL_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    'Run one bounded etcd metadata read, written as one etcdctl command on one line: endpoint status, member list, alarm list, auth status, lease list, lease timetolive <lease id> (without --keys), get "" --prefix --count-only for the count of every key, or get <key> for one key you name, which answers its existence, revisions, version, lease and value size. Double-quote a key that holds a space. Answers carry names, counts and sizes only. Key names and stored values are withheld, so every get over a range or a prefix, every value, watch, txn, write and maintenance call, and every flag but the two of the key count are refused before anything is sent, and you are told why.',
  inputSchema: readEtcdctlStatementSchema,
  operationId: "etcdctl.query.read",
});

const ETCDCTL_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: ETCDCTL_RUN_READ_QUERY,
});

/** The investigation sends commands through the one statement tool; `operations` sends none. */
export const ETCDCTL_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: ETCDCTL_STATEMENT_TOOLS,
});
