/**
 * The opcuaread request language's MCP facet: `run_opcua_read`, one of the OPC UA console's two reads or agent mode's
 * one-level browse, read and admitted by the agent's own OPC UA reader.
 *
 * The MCP module runs it through the provider's `queryReadOnly` under the agent read-only profile, so a call reads what
 * an agent read reads: one session opened for that read alone, through a client that holds Browse, BrowseNext, Read
 * and HistoryRead and nothing else, every value answered with its node's engineering units and EU range or "no units
 * published", and only beneath the read roots the seed entry declares, proved by a walk down from them on that session.
 * Every other node id answers exactly as an id the server does not hold, with nothing sent for it. A connection whose
 * seed declares no roots is refused at load and again at open (`READ_ROOTS_REQUIRED`). The answer carries the
 * provider's warnings as its notes: the roots a browse of the Objects folder lists, how many references of a member
 * lead outside them, and how a history read ended.
 *
 * The session's identity is no principal: the pinned fixture accepted an anonymous Write, so the boundary is the
 * provider's read-only client and the read roots; an agent credential the seed carries decides only what the server
 * shows, which narrows the walk further.
 *
 * No `database` key: one connection is one endpoint. A node is a key the Keys panel walks and OPC UA declares no
 * relation kind, so the facet holds no table, and inspect_schema refuses an OPC UA connection by name.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const OPCUAREAD_MCP_FACET = Object.freeze({
  tool: "run_opcua_read",
  title: "Run a read-only OPC UA read",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  holdsNoTables: true,
  answersWarnings: true,
  describe: ({ engines, limits }) =>
    `Run one read-only OPC UA read on a connection: one JSON object, {"read": ["ns=3;s=SlowUInt1", ...]} for node values, {"history": "<node id>", "start", "end", "limit"} for one node's raw history, or {"browse": "<node id>"} for one level of children. It reads only beneath the read roots the connection's operator declared, and {"browse": "i=85"} lists them; start there when the question names no node. Every other node id, namespace 0 and the server's configuration, roles and sessions among them, answers exactly as a node the server does not hold (statusCode BadNodeIdUnknown, no value), and nothing is sent for it. Each value carries its engineering units and EU range, or no units published; never assume a unit. Two facts about nodes outside the roots can reach an answer: a browse of a node says how many of its references lead outside, naming none, and a value whose units property lies outside answers that its units were not read. Only Browse, Read and HistoryRead are sent; another key is refused before sending. The session's identity is no boundary: a server may accept an anonymous write. inspect_schema refuses an OPC UA connection. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, so name fewer nodes, narrow a history window or browse further down.`,
  words: {
    fewerFields: "Name fewer nodes, or browse a node further down,",
    readPast: (shown: number, cut: "max_rows" | "result_bytes") =>
      `read past the ${shown} row${shown === 1 ? "" : "s"} returned, ${cut === "max_rows" ? "raise max_rows (at most 500), or " : ""}name fewer nodes, give a history read a narrower window or a limit, or browse a node further down, since an OPC UA read is never paged.`,
    rowOverCap:
      "One row of this result is larger than the 32 KiB result limit. Read that node alone, or a narrower window of its history, and run it again.",
    reached: "the server",
  },
} as const satisfies AgentLanguageMcpFacet);
