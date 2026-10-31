/**
 * The tool definitions the modbusread request language's workflows are offered: the statement tool for one Modbus
 * read.
 */
import { z } from "zod";
import { MODBUS_AGENT_DEVICE_GAP_MS } from "@/lib/db/providers/industrial/modbus/agent-pacing";
import { MODBUS_AGENT_RUN_REQUESTS } from "@/lib/db/providers/industrial/modbus/agent-read";
import { MAX_IDENTIFICATION_ROUNDS } from "@/lib/db/providers/industrial/modbus/constants";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readModbusreadStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const MODBUSREAD_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description: `Run one bounded Modbus read, written as one JSON object the way the console writes it: {"read": ["name", ...]} for points the connection's register map names, answered decoded as the map declares them; {"unit": 1, "table": "holding_register", "address": 0, "count": 10} for one block of one table (coil, discrete_input, holding_register or input_register; unit 1 to 255; a zero-based address; at most 125 registers or 2000 bits), with optional "type", "wordOrder" and "byteOrder" to decode registers; or {"identify": "basic"} (basic, regular or extended) for the device identification objects, answered as text when their bytes are text and as hex otherwise. Only Read Coils, Read Discrete Inputs, Read Holding Registers, Read Input Registers and Read Device Identification are sent: a write, a function code, any other key and every other request are refused before anything is sent. Reads of one device are taken one at a time with a ${MODBUS_AGENT_DEVICE_GAP_MS} ms gap after each, so a read may wait its turn within its time budget; one run sends at most ${MODBUS_AGENT_RUN_REQUESTS} requests to Modbus devices (a points read one per block it plans, a block one, identification up to ${MAX_IDENTIFICATION_ROUNDS}). A read holding more rows than the row budget is refused rather than cut, and you are told why.`,
  inputSchema: readModbusreadStatementSchema,
  operationId: "modbusread.query.read",
});

const MODBUSREAD_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: MODBUSREAD_RUN_READ_QUERY,
});

/** The investigation sends requests through the one statement tool; `operations` sends none. */
export const MODBUSREAD_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: MODBUSREAD_STATEMENT_TOOLS,
});
