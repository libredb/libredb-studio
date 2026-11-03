/**
 * run_s3_read: MCP's s3api arm, run by the statement core over the real S3 provider the factory builds, through the real
 * route, seed file, MCP context and handler, against a loopback listener answering as an S3 server.
 *
 * Nothing is stubbed between the seed file and the socket, so what this file holds is what an operator's seed gets: the
 * connection is acquired under the agent read-only profile with the seed's agent read key overlaid, every request the
 * provider sends is signed, and the listener reads the access key ID each one was signed with. The connection's own
 * key may list and read every bucket; the agent key is granted one bucket and may not list the others, so an answer
 * that held another bucket's name would show MCP had signed with the connection's key.
 *
 * Every answer carries names, counts and flags only: no object key, ETag, version id, user metadata or endpoint. A
 * bucket or key the agent key may not read answers in the same words as one that does not exist. Every refused form is
 * refused before anything is acquired, and nothing but GET and HEAD reaches the listener.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { languageServer } from "@/lib/agent/languages/server";
import { getServerAuditBuffer } from "@/lib/audit";
import { S3_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/objectstore/s3/agent-metadata-read";
import { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { timeoutText } from "@/lib/mcp/tools/read-query-limits";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import { pinMcpTestEnvironment, resetMcpTestState, waitFor, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";
import { bucketsXml, errorXml, objectsXml } from "../../helpers/s3-fake-transport";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-s3-"));
const serve = handlerServe(testAuthInfo());
const server = languageServer("s3api");
const RUN_S3_READ_ARM = mcpStatementArm("run_s3_read");

/** Stand-in keys, joined so no literal credential is written: the connection's own, wider key and the agent's. */
const OWN_KEY = ["AKID", "OWN", "STANDIN"].join("");
const OWN_SECRET = ["not", "a", "real", "own", "secret"].join("-");
const AGENT_KEY = ["AKID", "AGENT", "STANDIN"].join("");
const AGENT_SECRET = ["not", "a", "real", "agent", "secret"].join("-");

/** A key name and a metadata value planted in the store, which no answer may carry. */
const KEY_NAME = "tenant-acme/payroll-2026.csv";
const MARKER = "planted-metadata-marker";

/** What each key may read: the connection's own key every bucket, the agent key `sales` alone. */
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  [OWN_KEY]: ["sales", "payroll", "slow", "big"],
  [AGENT_KEY]: ["sales", "slow", "big"],
};
/** The buckets that exist. `absent` does not. */
const BUCKETS = ["sales", "payroll", "slow", "big"];
/** What the agent key is answered for the bucket listing: only its granted buckets, as a key without list-all is. */
const AGENT_LISTING = ["sales"];

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly keyId: string | null;
}

let seen: Seen[] = [];
let listener: Server;
let port = 0;
/** When the listener saw the hanging request's socket close. */
let slowClosedAt: number | null = null;

function keyIdOf(request: IncomingMessage): string | null {
  return /Credential=([^/]+)\//.exec(request.headers.authorization ?? "")?.[1] ?? null;
}

function answer(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://listener");
  const keyId = keyIdOf(request);
  seen.push({ method: request.method ?? "", path: `${url.pathname}${url.search}`, keyId });
  const xml = (body: string, status = 200) => {
    response.writeHead(status, { "content-type": "application/xml", "content-length": Buffer.byteLength(body) });
    response.end(request.method === "HEAD" ? undefined : body);
  };
  const granted = keyId === null ? [] : (GRANTS[keyId] ?? []);
  if (url.pathname === "/") return xml(bucketsXml(keyId === OWN_KEY ? BUCKETS : AGENT_LISTING));
  const [, bucket = "", ...rest] = url.pathname.split("/");
  const key = decodeURIComponent(rest.join("/"));
  // A bucket that exists and is not granted answers 403, a missing one 404, as Garage answers them.
  if (!BUCKETS.includes(bucket)) return xml(errorXml("NoSuchBucket", `The bucket ${bucket} does not exist`), 404);
  if (!granted.includes(bucket)) return xml(errorXml("AccessDenied", `Access denied to ${bucket}`), 403);
  if (bucket === "slow") {
    request.socket.once("close", () => {
      slowClosedAt = Date.now();
    });
    return;
  }
  if (key === "") {
    if (request.method === "HEAD") {
      response.writeHead(200, { "x-amz-bucket-region": "us-east-1" });
      response.end();
      return;
    }
    if (url.search === "?location=") return xml("<LocationConstraint/>");
    if (url.search === "?versioning=")
      return xml("<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>");
    if (url.searchParams.get("list-type") === "2") {
      // Paged as a server pages a whole-bucket listing: at most max-keys a page, the next page behind a token.
      const count = bucket === "big" ? 1_001 : 2;
      const from = Number(url.searchParams.get("continuation-token") ?? "0");
      const to = Math.min(count, from + Number(url.searchParams.get("max-keys") ?? "1000"));
      return xml(
        objectsXml({
          keys: Array.from({ length: to - from }, (_, index) => ({ key: `${KEY_NAME}.${from + index}`, size: 10 })),
          truncated: to < count,
          ...(to < count ? { token: String(to) } : {}),
        }),
      );
    }
  }
  if (key === KEY_NAME && request.method === "HEAD") {
    response.writeHead(200, {
      "content-length": "4096",
      "last-modified": "Mon, 02 Nov 2026 10:00:00 GMT",
      "x-amz-storage-class": "STANDARD",
      etag: '"0123456789abcdef0123456789abcdef"',
      "x-amz-version-id": "version-standin",
      "x-amz-meta-owner": MARKER,
    });
    response.end();
    return;
  }
  xml(errorXml("NoSuchKey", `The key ${key} does not exist`), 404);
}

beforeAll(async () => {
  listener = createServer(answer);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  port = (listener.address() as { port: number }).port;
});

afterAll(() => {
  listener.closeAllConnections();
  listener.close();
  rmSync(dir, { recursive: true, force: true });
});

const STORE = () => ({
  id: "store",
  type: "s3",
  host: "127.0.0.1",
  port,
  user: OWN_KEY,
  password: OWN_SECRET,
  agentUser: AGENT_KEY,
  agentPassword: AGENT_SECRET,
});

beforeEach(() => {
  seen = [];
  slowClosedAt = null;
  writeSeedFile(dir, [STORE(), { ...STORE(), id: "pinned", database: "sales" }]);
});

afterEach(async () => {
  // Whatever a case did, every request MCP made the provider send was a GET or a HEAD signed with the agent key.
  for (const request of seen) {
    expect(["GET", "HEAD"]).toContain(request.method);
    expect(request.keyId).toBe(AGENT_KEY);
  }
  await resetMcpTestState();
});

interface Answered {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown>): Promise<Answered> {
  const session = await connectClient(serve, { negotiation: "legacy" });
  try {
    return (await session.client.callTool({ name, arguments: args })) as Answered;
  } finally {
    await session.close();
  }
}

const s3 = (statement: string, extra: Record<string, unknown> = {}) =>
  call("run_s3_read", { connection_id: "seed:store", statement, ...extra });

const textOf = (result: Answered): string => result.content.map((block) => block.text).join("\n");

/** Nothing a store holds beyond names, counts and flags, nor either key's secret, appears in `text`. */
function expectNoStoredValue(text: string): void {
  for (const value of [KEY_NAME, MARKER, "0123456789abcdef", "version-standin", OWN_SECRET, AGENT_SECRET])
    expect(text).not.toContain(value);
  expect(text).not.toContain(`${port}`);
}

const mcpEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation");

describe("the tool", () => {
  test("is listed read-only, with the statement schema and no offset or database", async () => {
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const tools = (await session.client.listTools()).tools;
      const tool = tools.find((candidate) => candidate.name === "run_s3_read");
      expect(tool?.description).toBe(RUN_S3_READ_ARM.description);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
        "connection_id",
        "statement",
        "max_rows",
        "timeout_ms",
      ]);
    } finally {
      await session.close();
    }
  });

  test("describes S3-compatible object storage as the engine it runs on", () => {
    expect(RUN_S3_READ_ARM.engines).toBe("S3-compatible object storage");
  });

  test("list_connections names it as the S3 connection's read tool, with the pinned bucket and no credential", async () => {
    const result = await call("list_connections", {});
    expect(result.structuredContent?.connections).toEqual([
      { id: "seed:store", name: "store", engine: "s3", read_tool: "run_s3_read" },
      { id: "seed:pinned", name: "pinned", engine: "s3", database: "sales", read_tool: "run_s3_read" },
    ]);
    expect(textOf(result)).not.toContain(AGENT_KEY);
    expect(textOf(result)).not.toContain(OWN_KEY);
    expect(seen).toEqual([]);
  });

  test("inspect_schema refuses an S3 connection by name, pointing at run_s3_read, and sends nothing", async () => {
    const result = await call("inspect_schema", { connection_id: "seed:store" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("run_s3_read");
    expect(seen).toEqual([]);
  });
});

describe("a read under the agent read key", () => {
  test("the bucket list holds the agent key's buckets alone, behind the notice, recorded under the tool", async () => {
    const result = await s3("aws s3api list-buckets");
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: MCP_UNTRUSTED_NOTICE });
    expect(result.structuredContent).toMatchObject({
      connection_id: "seed:store",
      rows: [{ bucket: "sales", created: "2026-10-09T13:13:17.442Z" }],
      row_count: 1,
      truncated: false,
    });
    // The connection's own key would list payroll too: its absence is the proof MCP signed with the agent key.
    expect(textOf(result)).not.toContain("payroll");
    expect(result.structuredContent?.notes).toBeUndefined();
    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /?max-buckets=10000",
      "GET /?max-buckets=10000",
    ]);
    expect(mcpEvents().map((event) => [event.action, event.target, event.result])).toEqual([
      ["run_s3_read", "mcp/decision", "success"],
      ["run_s3_read", "mcp/execution", "success"],
    ]);
    expectNoStoredValue(JSON.stringify(mcpEvents()));
  });

  test("a pinned connection answers its one bucket and says so in the notes, sending no listing", async () => {
    const result = await call("run_s3_read", { connection_id: "seed:pinned", statement: "aws s3api list-buckets" });
    expect(result.structuredContent?.rows).toEqual([{ bucket: "sales", created: null }]);
    expect(result.structuredContent?.notes).toEqual([S3_AGENT_FAILURE_SENTENCES.pinned]);
    expect(seen.some((request) => request.path.startsWith("/?"))).toBe(false);
  });

  test.each([
    ["head-bucket", "aws s3api head-bucket --bucket sales", { bucket: "sales", exists: true, region: "us-east-1" }],
    ["get-bucket-location", "aws s3api get-bucket-location --bucket sales", { bucket: "sales", location: "us-east-1" }],
    [
      "get-bucket-versioning",
      "aws s3api get-bucket-versioning --bucket sales",
      { bucket: "sales", status: "Enabled", mfa_delete: null },
    ],
    [
      "the summary",
      "aws s3 ls s3://sales --recursive --summarize",
      { bucket: "sales", objects: 2, total_size_bytes: 20 },
    ],
    [
      "head-object",
      `aws s3api head-object --bucket sales --key ${KEY_NAME}`,
      {
        bucket: "sales",
        exists: true,
        size_bytes: 4096,
        last_modified: "2026-11-02T10:00:00.000Z",
        storage_class: "STANDARD",
      },
    ],
  ])("%s answers names, counts and flags only", async (_read, statement, row) => {
    const result = await s3(statement);
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent?.rows).toEqual([row]);
    expectNoStoredValue(JSON.stringify(result));
  });
});

describe("a bucket or key the agent key may not read", () => {
  /** An answer's words with the bucket it named taken out, so two buckets' answers can be compared. */
  const words = (result: Answered, bucket: string) => textOf(result).replaceAll(bucket, "<bucket>");

  test.each([
    ["head-bucket", (bucket: string) => `aws s3api head-bucket --bucket ${bucket}`],
    ["get-bucket-location", (bucket: string) => `aws s3api get-bucket-location --bucket ${bucket}`],
    ["get-bucket-versioning", (bucket: string) => `aws s3api get-bucket-versioning --bucket ${bucket}`],
    ["the summary", (bucket: string) => `aws s3 ls s3://${bucket} --recursive --summarize`],
    ["head-object", (bucket: string) => `aws s3api head-object --bucket ${bucket} --key ${KEY_NAME}`],
  ])("%s of a bucket granted nothing answers as one that does not exist", async (_read, statement) => {
    const ungranted = await s3(statement("payroll"));
    const missing = await s3(statement("absent"));
    expect(ungranted.isError).toBe(true);
    expect(words(ungranted, "payroll")).toBe(words(missing, "absent"));
    expect(textOf(ungranted)).toContain(S3_AGENT_FAILURE_SENTENCES.notFound);
    expectNoStoredValue(textOf(ungranted));
  });

  test("head-object of a key that does not exist answers as one in a bucket granted nothing", async () => {
    const absentKey = await s3("aws s3api head-object --bucket sales --key absent.csv");
    const ungranted = await s3(`aws s3api head-object --bucket payroll --key ${KEY_NAME}`);
    expect(absentKey.isError).toBe(true);
    expect(textOf(absentKey).replaceAll("sales", "<bucket>")).toBe(textOf(ungranted).replaceAll("payroll", "<bucket>"));
  });
});

describe("a refusal", () => {
  test.each([
    ["an object listing", "aws s3api list-objects-v2 --bucket sales"],
    ["a key listing", "aws s3 ls s3://sales/"],
    ["a count over a prefix", "aws s3 ls s3://sales/tenant-acme/ --recursive --summarize"],
    ["a --prefix", "aws s3 ls s3://sales --recursive --summarize --prefix tenant"],
    ["an object read", "aws s3api get-object --bucket sales --key a.csv out.csv"],
    ["a tagging read", "aws s3api get-object-tagging --bucket sales --key a.csv"],
    ["a version listing", "aws s3api list-object-versions --bucket sales"],
    ["a preview", "preview s3://sales/a.csv"],
    ["a write", "aws s3api put-object --bucket sales --key a.csv"],
    ["a delete", "aws s3 rm s3://sales/a.csv"],
    ["another endpoint", "aws s3api list-buckets --endpoint-url http://elsewhere"],
  ])("%s is refused by the agent's admission before anything is acquired", async (_shape, line) => {
    const acquire = spyOn(McpConnectionContext.prototype, "acquire");
    try {
      const result = await s3(line);
      const refusal = server.admit?.(line);
      expect(refusal).not.toBeNull();
      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: "text",
            text: `The command was refused before it reached the server (${refusal?.code}). ${refusal?.message}`,
          },
        ],
      });
      expect(acquire).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
      expect(mcpEvents()).toEqual([
        expect.objectContaining({
          action: "run_s3_read",
          target: "mcp/decision",
          result: "failure",
          reason: "mcp_statement_refused",
        }),
      ]);
    } finally {
      acquire.mockRestore();
    }
  });

  test("a bucket holding more objects than the row budget is refused with the language's own advice, never counted in part", async () => {
    const statement = "aws s3 ls s3://big --recursive --summarize";
    const result = await s3(statement);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice(statement, "1000")}`,
    );
    expectNoStoredValue(textOf(result));
  });

  test("run_read_query refuses an S3 connection, naming run_s3_read", async () => {
    const result = await call("run_read_query", { connection_id: "seed:store", sql: "SELECT 1" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("this tool does not serve S3-compatible object storage; use run_s3_read there");
    expect(seen).toEqual([]);
  });

  test.each([
    ["an offset", { offset: 100 }],
    ["a database", { database: "sales" }],
  ])("%s is an argument this tool does not take", async (_what, extra) => {
    const result = await s3("aws s3api list-buckets", extra);
    expect(result.isError).toBe(true);
    expect(seen).toEqual([]);
  });
});

describe("the connection's own key", () => {
  const listed = (fields: Record<string, unknown>): ManagedConnection =>
    ({
      ...STORE(),
      id: "seed:store",
      name: "store",
      seedId: "store",
      managed: true,
      mcp: true,
      roles: ["admin"],
      createdAt: new Date(),
      ...fields,
    }) as unknown as ManagedConnection;

  function direct(connection: ManagedConnection, statement: string, timeoutMs = 5_000, signal?: AbortSignal) {
    const context = new McpConnectionContext({ username: "alice", role: "admin" } as never);
    spyOn(context, "resolve").mockResolvedValue(connection);
    const input = RUN_S3_READ_ARM.inputSchema.parse({
      connection_id: connection.id,
      statement,
      timeout_ms: timeoutMs,
    }) as McpStatementInput;
    return runStatement(RUN_S3_READ_ARM, input, { context, signal: signal ?? new AbortController().signal });
  }

  test("a connection with no agent key, loaded past the seed schema, is refused at open and nothing is sent", async () => {
    const result = await direct(listed({ agentUser: undefined, agentPassword: undefined }), "aws s3api list-buckets");
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: 'run_s3_read cannot run on this connection: Connection "seed:store" is read by MCP only under an agent credential of its own, and it has none: an operator sets agentUser and agentPassword on this seed. It runs on S3-compatible object storage.',
        },
      ],
    });
    expect(seen).toEqual([]);
    expectNoStoredValue(textOf(result as Answered));
  });

  test("an agent key that names the connection's own key ID is refused at open and nothing is sent", async () => {
    const result = await direct(listed({ agentUser: OWN_KEY.toLowerCase() }), "aws s3api list-buckets");
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: 'run_s3_read cannot run on this connection: Connection "seed:store" configures the connection\'s own user as the agent user, and this engine takes only an agent user of its own: name a dedicated agent user. It runs on S3-compatible object storage.',
        },
      ],
    });
    expect(seen).toEqual([]);
  });

  test("a read still waiting at timeout_ms is answered as the timeout, and the provider closed its request", async () => {
    const result = await direct(listed({}), "aws s3api head-bucket --bucket slow", 500);
    expect(result.content).toEqual([{ type: "text", text: timeoutText(500) }]);
    await waitFor(() => slowClosedAt !== null);
  });

  test("a client cancel ends the wait at once, and the read runs on until the provider's own budget ends it", async () => {
    const controller = new AbortController();
    const pending = direct(listed({}), "aws s3api head-bucket --bucket slow", 1_500, controller.signal);
    await waitFor(() => seen.some((request) => request.path === "/slow"));
    const cancelledAt = Date.now();
    controller.abort();
    const result = await pending;
    expect(result.content).toEqual([{ type: "text", text: MCP_CANCELLED_TEXT }]);
    // The cancel did not reach the request: it ended only when the read's own time budget, the time left, ran out.
    expect(slowClosedAt).toBeNull();
    await waitFor(() => slowClosedAt !== null);
    expect((slowClosedAt ?? 0) - cancelledAt).toBeGreaterThan(200);
  });
});
