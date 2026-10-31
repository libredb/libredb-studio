/**
 * The tool definitions the snmpget command language's workflows are offered: the statement tool for one SNMP read.
 */
import { z } from "zod";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readSnmpgetStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const SNMPGET_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    "Run one bounded SNMP read, written as one of the console's four commands on one line: get OID [OID ...] for the named instances' values; next OID [OID ...] for the instance after each; walk SUBTREE [limit N] for every instance under a subtree; or table ENTRY for a conceptual table's rows, named by its entry (table ifEntry). Write an OID numerically (1.3.6.1.2.1.1.1.0) or by a name the bundled MIB modules define (sysDescr.0, ifDescr, hrStorageTable). Values are answered as the console renders them: a number, text, or hex for bytes that are not showable text. The security and target modules under 1.3.6.1.6.3 (SNMP-TARGET-MIB, SNMP-NOTIFICATION-MIB, SNMP-PROXY-MIB, SNMP-USER-BASED-SM-MIB, SNMP-VIEW-BASED-ACM-MIB and SNMP-COMMUNITY-MIB) are withheld, since they hold community strings, user names and access rules: a get or next landing inside one answers a row typed withheld with no value, and a walk or table reaching one, such as walk 1 or walk 1.3.6.1.6.3, is refused. A set and every other command are refused before anything is sent, and a walk or table holding more instances than the row budget is refused rather than cut, and you are told why.",
  inputSchema: readSnmpgetStatementSchema,
  operationId: "snmpget.query.read",
});

const SNMPGET_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: SNMPGET_RUN_READ_QUERY,
});

/** The investigation sends commands through the one statement tool; `operations` sends none. */
export const SNMPGET_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: SNMPGET_STATEMENT_TOOLS,
});
