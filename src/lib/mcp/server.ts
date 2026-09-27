import { createMcpHandler, McpServer, type McpRequestContext } from "@modelcontextprotocol/server";
import { getAppVersion } from "@/lib/app-version";
import { logger } from "@/lib/logger";
import { McpConnectionContext, mcpCaller } from "./context";
import { redactError } from "./serializer";
import { registerStudioTools } from "./tools";

/**
 * The MCP server behind /api/mcp (#246): one handler for the process, one McpServer per request.
 *
 * createMcpHandler serves the 2026-07-28 revision and, statelessly, the 2025 revisions a default
 * client still speaks, from this one factory. The handler performs no Origin, Host or token check
 * of its own; the route in front of it does, and hands the verified identity in as authInfo. The
 * factory runs for every request the SDK serves, so it only builds objects: the connection
 * context reads the seed file lazily, the first time a tool needs it.
 *
 * Nothing ever calls mcpHandler.close(): a closed handler refuses every later request, and the
 * process's own shutdown ends every exchange with it.
 */

export const MCP_SERVER_NAME = "libredb-studio-mcp";

export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18"];

export const MCP_INSTRUCTIONS =
  "LibreDB Studio serves the database connections this deployment opted in for MCP, filtered by the role your token carries. Start with list_connections, read a connection's tables with inspect_schema, then run SQL with run_read_query. An empty connection list means no connection is opted in for your role. Every call shares one per-user rate limit with the Studio UI.";

function createStudioMcpServer({ authInfo }: McpRequestContext): McpServer {
  if (authInfo === undefined) {
    throw new Error("The MCP server factory needs the request's verified identity, and none was passed");
  }
  const version = getAppVersion();
  if (version === null) {
    throw new Error("server version unavailable: NEXT_PUBLIC_APP_VERSION is not set");
  }
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: MCP_INSTRUCTIONS,
      supportedProtocolVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
    },
  );
  registerStudioTools(server, new McpConnectionContext(mcpCaller(authInfo)));
  return server;
}

/**
 * onerror receives the requests the SDK refuses as well as its serving failures, so it reports and
 * never answers: the SDK guarantees it cannot change a response.
 */
export const mcpHandler = createMcpHandler(createStudioMcpServer, {
  legacy: "stateless",
  onerror: (error) => {
    logger.warn("MCP request refused or failed inside the SDK", { error: redactError(error).message });
  },
});
