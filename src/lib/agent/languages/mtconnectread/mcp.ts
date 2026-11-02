/**
 * The mtconnectread language's MCP facet: `run_mtconnect_read`, one request line read and admitted by the agent's own
 * MTConnect adapter.
 *
 * The MCP module reads it with the agent's own reader, admission and `queryReadOnly`, so a call sends what an agent read
 * sends: `GET /probe`, then one GET of a route of the closed table, and its answer leaves out the agent's own adapter
 * connections, and every URL's user name, password, query string and fragment in an asset, as an agent read's does
 * (`agent-withheld.ts` in the provider). Observations and asset documents are the machine's own data and are answered.
 *
 * No `database` key: an MTConnect connection reads one agent and names a device in the request line, and declares no
 * `catalogSessions`, so `providerInDatabase` would refuse every call that named one, as the agent's own tool leaves it
 * out. Data items and conditions are relations inspect_schema lists, so the language holds tables.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const MTCONNECTREAD_MCP_FACET = Object.freeze({
  tool: "run_mtconnect_read",
  title: "Run a read-only MTConnect read",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  holdsNoTables: false,
  describe: ({ engines, limits }) =>
    `Run one read-only MTConnect read on a connection: one request line, GET implied, written as the console writes it, such as "/current", "/LATHE-1/current?path=//DataItem[@type=\\"POSITION\\"]", "/sample?from=120&count=50", "/assets" or "/asset/TOOL-1". It reads one of nine GET routes: /probe for the device model, /current for the current observations, /sample for a page of the buffer and /assets for the assets, each for every device or for one, and /asset/{assetIds} for assets by id. A path is //DataItem alternatives testing @id, @name, @type, @subType or @category for equality with a value a readable data item holds. A PUT, a POST, /cancel, a streaming parameter (interval, heartbeat, frequency) and a second request line are refused before the agent is reached. Each read reads the agent's device model first. The agent's own adapter connections, whose names and values carry the adapter's network address, are left out of every answer. Observations are answered as the console renders them, and each asset with its document as XML text, where everything from a URL's :// to the last @ in the value, and from the first ? or # after that to the end of the value, reads [withheld], so its user name, password, query string and fragment never reach the answer. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, so narrow the read with a device, a path or a smaller count.`,
  words: {
    fewerFields: "Name one device, narrow the path or give /sample or /assets a smaller count",
    readPast: (shown: number) =>
      `read past the ${shown} rows returned, read /sample from the sequence after the last one returned, or split the read by device or path, since an MTConnect read is never paged.`,
    rowOverCap:
      "One row of this result is larger than the 32 KiB result limit, as an asset with a long document can be, and a row is never cut. Read other rows, with a narrower path or other asset ids, and run it again.",
    reached: "the agent",
  },
} as const satisfies AgentLanguageMcpFacet);
