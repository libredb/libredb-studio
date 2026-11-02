/**
 * Live check of MCP's `run_mtconnect_read` on the pinned MTConnect fixture, captured into `boundary.json` beside
 * `tests/fixtures/mtconnect/2.8.0.4/mcp-boundary/run.sh`, which starts the compose fixture's adapter, an MQTT broker
 * and three agents of the pinned image (the fixture's own `AllowPut = false`, one with `AllowPut = true` and one with an
 * MQTT sink), and removes them all after.
 *
 * WHY THIS EXISTS. `run_mtconnect_read` serves MTConnect through the boundary agent mode uses: the connection is
 * acquired under the agent read-only profile and every request line goes through the provider's `queryReadOnly`, whose
 * client sends only GET of the nine routes of its closed table. The MCP fence in front of it, the agent's own
 * admission, is defence in depth. So this script drives the tool's own handler (`runStatement`), the fenced arm as MCP
 * registers it and the same arm with its fence removed, over a provider whose transport records every request:
 *
 *   reads             one accepted read of each route form: rows, the requests it sent, whether the answer carried the
 *                     adapter's address;
 *   writes            each write-shaped line: the fenced tool refuses it before anything is acquired; unfenced, the
 *                     provider refuses it before anything is sent; and the same PUT and POST sent raw by THIS script to
 *                     the AllowPut agent change the value they name, the positive control, while the same lines through
 *                     the unfenced tool on that agent send nothing and change nothing;
 *   refused           every other refused form, fenced and unfenced, and the count past the row budget;
 *   pathOracle        a path testing a withheld adapter id and one testing an id no item holds: answered alike;
 *   limits            a read cut at max_rows, a read at the minimum timeout_ms with the agent paused, and a client
 *                     cancel with the agent paused: when MCP answered and when the provider's own request ended;
 *   assets            File and CuttingTool assets put raw on the AllowPut agent, one with a URL carrying a user name,
 *                     password and query, one whose password holds an @ and a quote and whose fragment holds a
 *                     token, read through the tool: what reached the answer;
 *   sink              the MQTT sink agent's nine routes read raw and its model read through the tool: whether the
 *                     broker's address reached any of them;
 *   factory           one read through the factory's own profiled acquisition, as the route makes it;
 *   state             the fixture agent's buffer before and after: every observation in between, by data item.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. The fixture has no credential; the asset
 * URL carries an obviously fake one, and the capture records only whether an answer carried it, never the value, and
 * no host name. Both are checked before the file is written; any failed check ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the agent holds after the one before.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { acquireExecutionProfileProvider, executionContextFor, type ExecutionProfile } from "@/lib/db/factory";
import { createNodeTransport, type NodeRequest } from "@/lib/db/http/node-transport";
import { MTConnectProvider } from "@/lib/db/providers/industrial/mtconnect/index";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, type ToolResult } from "@/lib/mcp/output";
import { timeoutText } from "@/lib/mcp/tools/read-query-limits";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseConnection } from "@/lib/types";

const PORT = Number(process.env.MTCONNECT_MCP_PORT ?? "17422");
const PUT_PORT = Number(process.env.MTCONNECT_MCP_PUT_PORT ?? "17423");
const SINK_PORT = Number(process.env.MTCONNECT_MCP_SINK_PORT ?? "17424");
const PAUSE = process.env.MTCONNECT_MCP_PAUSE ?? "pr422-mtconnect";
const OUT = process.env.MTCONNECT_MCP_OUT ?? ".";
const IMAGE = "mtconnect/agent:2.8.0.4@sha256:c42f90850ab70d65ae5e73b14392b3041ed51065bd7bf287658db6f7260df641";
const LATHE = "LIBREDB-LATHE-1722";
/** The adapter's address as the agent writes it, which no answer may carry. */
const ADAPTER = /mtconnect-adapter/i;
/** The MQTT sink's broker, by the network alias the sink agent dials. */
const BROKER = /mqtt-broker/i;
/** The fake credential and signature the asset probe writes, which no answer may carry. */
const FAKE_SECRETS = [
  "not-a-real-user",
  "not-a-real-password",
  "not-a-real-token",
  "odd-pass",
  "odd-word",
  "not-a-real-fragment",
  "backslash-user",
  "backslash-pass",
];

/** The tool as MCP registers it, and the same tool with its fence removed: the boundary under test. */
const FENCED = mcpStatementArm("run_mtconnect_read");
const UNFENCED: McpStatementArm = { ...FENCED, fence: () => null };

/** The fence's refusal: the MCP admission's own words, the same for every form it refuses. */
const FENCE_REFUSAL = "The request was refused before it reached the agent (request).";
/** The provider's refusal of a form, before anything is sent, in its own words. */
const providerRefusal = (reason: string): string =>
  `The statement was refused before it reached the database: ${reason}`;

let failures = 0;
function check(ok: boolean, line: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

const sent: string[] = [];
/** When each request the provider sent settled, by its request line, for the timeout and cancel probes. */
const settled = new Map<string, number>();

const requestLine = (request: NodeRequest): string => {
  const url = new URL(request.url);
  return `${request.method} ${url.pathname}${url.search}`;
};

function seed(name: string, port: number): ManagedConnection {
  return {
    id: `seed:${name}`,
    name,
    seedId: name,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "mtconnect",
    host: "127.0.0.1",
    port,
    createdAt: new Date(),
  } as unknown as ManagedConnection;
}

/** The factory's provider for `profile`, with a transport that records every request it sends and when it settled. */
async function recordingAcquire(connection: ManagedConnection, profile: ExecutionProfile): Promise<MTConnectProvider> {
  const provider = new MTConnectProvider(
    connection as DatabaseConnection,
    {},
    executionContextFor(profile),
    (options) => {
      const transport = createNodeTransport(options);
      return {
        request: async (request) => {
          const line = requestLine(request);
          sent.push(line);
          try {
            return await transport.request(request);
          } finally {
            settled.set(line, Date.now());
          }
        },
        close: () => transport.close(),
      };
    },
  );
  await provider.connect();
  return provider;
}

interface Call {
  readonly result: ToolResult;
  readonly acquired: number;
  readonly sent: string[];
  readonly answeredMs: number;
}

/** One MCP call through the tool's handler; `sent` holds what the call's provider sent after its open. */
async function mcp(
  connection: ManagedConnection,
  statement: string,
  options: {
    readonly arm?: McpStatementArm;
    readonly extra?: Partial<McpStatementInput>;
    readonly signal?: AbortSignal;
    readonly acquire?: (connection: ManagedConnection, profile: ExecutionProfile) => Promise<unknown>;
  } = {},
): Promise<Call> {
  let acquired = 0;
  const acquire = options.acquire ?? recordingAcquire;
  const context = {
    caller: { username: "live", role: "admin" },
    visibleConnections: async () => [connection],
    resolve: async () => connection,
    acquire: async (target: ManagedConnection, profile: ExecutionProfile) => {
      acquired++;
      const provider = await acquire(target, profile);
      // The open's own model read is the connection's, not the call's.
      sent.splice(0);
      return provider;
    },
  } as unknown as McpConnectionContext;
  const arm = options.arm ?? FENCED;
  const input = arm.inputSchema.parse({
    connection_id: connection.id,
    statement,
    ...options.extra,
  }) as McpStatementInput;
  sent.splice(0);
  const started = Date.now();
  const result = await runStatement(arm, input, { context, signal: options.signal ?? new AbortController().signal });
  return { result, acquired, sent: sent.splice(0), answeredMs: Date.now() - started };
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => ("text" in part ? part.text : "")).join(" ");

/** A refusal's first sentence: up to the first full stop that ends a sentence, not one inside a route or a list. */
const firstSentence = (message: string): string => /^[\s\S]*?\.(?=\s|$)/.exec(message)?.[0] ?? message;

const rowsOf = (result: ToolResult): readonly Record<string, unknown>[] =>
  ((result as { structuredContent?: { rows?: Record<string, unknown>[] } }).structuredContent?.rows ?? []) as Record<
    string,
    unknown
  >[];

async function nextSequence(port: number): Promise<number> {
  const text = await (await fetch(`http://127.0.0.1:${port}/current`)).text();
  return Number(/nextSequence="(\d+)"/.exec(text)?.[1]);
}

async function observationsSince(port: number, from: number): Promise<string[]> {
  const text = await (await fetch(`http://127.0.0.1:${port}/sample?from=${from}&count=1000`)).text();
  return [...text.matchAll(/dataItemId="([^"]+)"/g)].map((match) => match[1].replace(ADAPTER, "<adapter>"));
}

async function valueOf(port: number, dataItemId: string): Promise<string> {
  const text = await (await fetch(`http://127.0.0.1:${port}/${LATHE}/current`)).text();
  return new RegExp(`dataItemId="${dataItemId}"[^>]*>([^<]*)<`).exec(text)?.[1] ?? "";
}

function docker(...args: string[]): void {
  const run = Bun.spawnSync(["docker", ...args]);
  if (run.exitCode !== 0) throw new Error(`docker ${args[0]} failed`);
}

const fixture = seed("lathe", PORT);
const putAgent = seed("lathe-put", PUT_PORT);
const sinkAgent = seed("lathe-sink", SINK_PORT);

const startSequence = await nextSequence(PORT);

// One accepted read of each route form, through the tool as MCP registers it.
const READS = [
  "/probe",
  `/${LATHE}/probe`,
  "/current",
  `/${LATHE}/current`,
  '/current?path=//DataItem[@category="EVENT"]',
  "/sample?count=-5",
  `/${LATHE}/sample?path=//DataItem[@type="POSITION"]&count=-3`,
  "/assets",
  `/${LATHE}/assets`,
  "/asset/TOOL-1722",
] as const;
const reads = [];
for (const statement of READS) {
  const call = await mcp(fixture, statement);
  const answered = call.result.isError !== true;
  const carries = ADAPTER.test(JSON.stringify(call.result));
  check(answered && !carries, `read ${statement}: answered, no adapter address`);
  reads.push({
    statement,
    answered,
    rowCount: rowsOf(call.result).length,
    sent: call.sent,
    carriesAdapterAddress: carries,
  });
}

// Write-shaped lines: the fence refuses each before anything is acquired; unfenced, the provider before anything is
// sent. The PUT and POST also run unfenced against the AllowPut agent, beside the raw positive control below.
// Each row names the refusal it must draw, so a call that fails for another reason, before the fence or the provider
// reads the line, fails the check rather than passing it.
const WRITES = [
  ["PUT /probe", "PUT"],
  [`PUT /${LATHE}?x1722-pos=9999`, "PUT"],
  [`POST /${LATHE}?p1722-prog=MCP.NC`, "POST"],
  ["DELETE /asset/TOOL-1722", "DELETE"],
] as const;
const writes = [];
for (const [statement, method] of WRITES) {
  const fenced = await mcp(fixture, statement);
  const unfenced = await mcp(fixture, statement, { arm: UNFENCED });
  const fencedRefusal = firstSentence(textOf(fenced.result));
  const unfencedRefusal = firstSentence(textOf(unfenced.result));
  check(
    fenced.result.isError === true &&
      fencedRefusal === FENCE_REFUSAL &&
      fenced.acquired === 0 &&
      fenced.sent.length === 0,
    `${statement}: fenced tool refuses in the fence's words before anything is acquired`,
  );
  check(
    unfenced.result.isError === true &&
      unfencedRefusal === providerRefusal(`${method} is not a method this provider sends.`) &&
      unfenced.sent.length === 0,
    `${statement}: with the fence removed the provider refuses the method before anything is sent`,
  );
  writes.push({
    statement,
    fenced: { refused: fencedRefusal, acquired: fenced.acquired, sent: fenced.sent },
    unfenced: { refused: unfencedRefusal, sent: unfenced.sent },
  });
}
const putBefore = await valueOf(PUT_PORT, "x1722-pos");
const unfencedPut = await mcp(putAgent, `PUT /${LATHE}?x1722-pos=4242`, { arm: UNFENCED });
const putAfterMcp = await valueOf(PUT_PORT, "x1722-pos");
check(
  unfencedPut.sent.length === 0 && putBefore === putAfterMcp,
  "the unfenced PUT on the AllowPut agent sends nothing and changes nothing",
);
const rawPut = await fetch(`http://127.0.0.1:${PUT_PORT}/${LATHE}?x1722-pos=4242`, { method: "PUT" });
await rawPut.text();
const putAfterRaw = await valueOf(PUT_PORT, "x1722-pos");
check(rawPut.status === 200 && putAfterRaw === "4242", "the same PUT sent raw, the positive control, sets the value");
const positiveControl = {
  agent: "AllowPut = true",
  throughUnfencedTool: { sent: unfencedPut.sent, valueChanged: putBefore !== putAfterMcp },
  raw: { request: `PUT /${LATHE}?x1722-pos=4242`, status: rawPut.status, valueChanged: putAfterMcp !== putAfterRaw },
};

// Every other refused form, fenced and unfenced, each with the provider's reason for it. The count past the row cap is
// the provider's to refuse, so the fence lets it through and the provider's words answer both.
const PAST_THE_ROW_CAP = providerRefusal("count may not be larger than this read's row cap of 1000.");
const OUTSIDE_THE_PATH_SUBSET = providerRefusal("The path is outside what agent mode sends.");
const REFUSED = [
  ["/cancel/id=1", FENCE_REFUSAL, providerRefusal("GET /cancel/id=1 is not a route this provider runs.")],
  ["/assets/TOOL-1722", FENCE_REFUSAL, providerRefusal("GET /assets/TOOL-1722 is not a route this provider runs.")],
  ["/swagger", FENCE_REFUSAL, providerRefusal("GET /swagger is not a route this provider runs.")],
  [
    "/sample?interval=1000",
    FENCE_REFUSAL,
    providerRefusal(
      "interval is not sent by this provider: streaming is out of scope for v1: an answer never ends, and the shared transport cannot carry it.",
    ),
  ],
  [
    "/current?heartbeat=1000",
    FENCE_REFUSAL,
    providerRefusal("heartbeat is not sent by this provider: streaming is out of scope for v1."),
  ],
  [
    "/sample?frequency=1000",
    FENCE_REFUSAL,
    providerRefusal("frequency is not sent by this provider: the deprecated spelling of interval."),
  ],
  ["/current\n/sample", FENCE_REFUSAL, providerRefusal("A run sends one request.")],
  [
    "/../probe",
    FENCE_REFUSAL,
    providerRefusal(
      "device is a dot segment, which a URL resolves to another path, so what would be sent is not the route that was written.",
    ),
  ],
  ["/current?path=count(//DataItem)", FENCE_REFUSAL, providerRefusal("count() is not a function this provider sends.")],
  ["/current?path=//Adapter", FENCE_REFUSAL, OUTSIDE_THE_PATH_SUBSET],
  ['/current?path=//DataItem[starts-with(@id,"_")]', FENCE_REFUSAL, OUTSIDE_THE_PATH_SUBSET],
  ["/sample?count=1001", PAST_THE_ROW_CAP, PAST_THE_ROW_CAP],
] as const;
const refused = [];
for (const [statement, fencedWords, unfencedWords] of REFUSED) {
  const fenced = await mcp(fixture, statement);
  const unfenced = await mcp(fixture, statement, { arm: UNFENCED });
  const fencedRefusal = firstSentence(textOf(fenced.result));
  const unfencedRefusal = firstSentence(textOf(unfenced.result));
  check(
    fenced.result.isError === true &&
      fencedRefusal === fencedWords &&
      unfenced.result.isError === true &&
      unfencedRefusal === unfencedWords &&
      unfenced.sent.length === 0,
    `${JSON.stringify(statement)}: refused fenced and unfenced in the expected words, nothing sent`,
  );
  refused.push({
    statement,
    fenced: { refused: fencedRefusal, acquired: fenced.acquired },
    unfenced: { refused: unfencedRefusal, sent: unfenced.sent },
  });
}

// A path testing a withheld adapter id, and one testing an id no item holds: answered alike, the request never sent.
const ORACLE = ["_mtconnect-adapter_7878_adapter_uri", "_mtconnect-adapter_7879_adapter_uri"] as const;
const oracle = [];
for (const id of ORACLE) {
  const call = await mcp(fixture, `/current?path=//DataItem[@id="${id}"]`);
  // The refusal follows the untrusted-data notice, so its own words are the last block.
  const last = call.result.content.at(-1);
  oracle.push({ text: (last !== undefined && "text" in last ? last.text : "").replaceAll(id, "{}"), sent: call.sent });
}
const pathOracle = {
  hitAndMissAlike: oracle[0].text === oracle[1].text,
  refusal: firstSentence(oracle[0].text),
  sent: { hit: oracle[0].sent, miss: oracle[1].sent },
};
check(
  pathOracle.hitAndMissAlike && oracle.every((one) => one.sent.join() === "GET /probe"),
  "a withheld adapter id and an id no item holds are refused alike, after the model read alone",
);

// The limits: a cut at max_rows, then the minimum timeout_ms and a client cancel with the agent paused.
const cut = await mcp(fixture, "/current", { extra: { max_rows: 2 } });
const cutContent = (cut.result as { structuredContent?: Record<string, unknown> }).structuredContent;
check(cutContent?.truncated === true && cutContent?.row_count === 2, "a read past max_rows is cut to it");

// Opened before the pause, so the call's own read is what waits, not the connection's open.
const opened = await recordingAcquire(fixture, "agent-read-only");
const handOut = async () => opened;
docker("pause", PAUSE);
let timeout: Record<string, unknown>;
let cancel: Record<string, unknown>;
try {
  settled.clear();
  const timed = await mcp(fixture, "/current", { extra: { timeout_ms: 500 }, acquire: handOut });
  await Bun.sleep(1_000);
  const timedLine = [...settled.keys()].at(-1) ?? null;
  timeout = {
    timeoutMs: 500,
    answer: firstSentence(textOf(timed.result)),
    answeredWithinMs: timed.answeredMs < 1_500,
    lastRequest: timedLine,
    providerRequestEnded: timedLine !== null,
  };
  check(
    textOf(timed.result) === timeoutText(500) && timeout.providerRequestEnded === true,
    "timeout_ms 500 is answered as the timeout, and the provider ended its own request",
  );

  settled.clear();
  const controller = new AbortController();
  const started = Date.now();
  const pending = mcp(fixture, "/current", {
    extra: { timeout_ms: 3_000 },
    signal: controller.signal,
    acquire: handOut,
  });
  await Bun.sleep(200);
  controller.abort();
  const cancelled = await pending;
  const answeredAfterMs = Date.now() - started;
  const settledBeforeAnswer = settled.size;
  const until = Date.now() + 5_000;
  while (settled.size === 0 && Date.now() < until) await Bun.sleep(25);
  const endedAfterMs = settled.size === 0 ? null : Math.min(...settled.values()) - started;
  cancel = {
    timeoutMs: 3_000,
    cancelledAfterMs: 200,
    answer: firstSentence(textOf(cancelled.result)),
    answeredBeforeTheTimeLeft: answeredAfterMs < 1_000,
    providerRequestOpenWhenAnswered: settledBeforeAnswer === 0,
    providerRequestEndedNearTheTimeLeft: endedAfterMs !== null && endedAfterMs >= 2_500 && endedAfterMs < 4_500,
  };
  check(
    textOf(cancelled.result) === MCP_CANCELLED_TEXT &&
      cancel.answeredBeforeTheTimeLeft === true &&
      cancel.providerRequestOpenWhenAnswered === true &&
      cancel.providerRequestEndedNearTheTimeLeft === true,
    "a client cancel ends the wait at once, and the provider's own budget ends its request at the time left",
  );
} finally {
  docker("unpause", PAUSE);
}

// Assets put raw on the AllowPut agent, then read through the tool.
const FILE_WITH_SECRET =
  '<File assetId="FILE-1" name="program.nc" mediaType="text/plain" applicationCategory="DEVICE" applicationType="DATA" size="1024" versionId="1" state="PRODUCTION"><FileLocation href="ftp://not-a-real-user:not-a-real-password@files.example/programs/program.nc?token=not-a-real-token"/><Signature>0000</Signature><Destinations><Destination>LIBREDB-1722</Destination></Destinations><CreationTime>2026-01-01T00:00:00Z</CreationTime></File>';
const FILE_WITH_PATH =
  '<File assetId="FILE-2" name="p2.nc" mediaType="text/plain" applicationCategory="DEVICE" applicationType="DATA" size="10" versionId="1" state="PRODUCTION"><FileLocation href="file:///opt/programs/p2.nc"/><Destinations><Destination>LIBREDB-1722</Destination></Destinations><CreationTime>2026-01-01T00:00:00Z</CreationTime></File>';
// A password holding an @ and a quote, and a token in the fragment: a URL client splits the user information at the
// last @, so no part of either may reach the answer.
const FILE_WITH_ODD_SECRET =
  '<File assetId="FILE-3" name="p3.nc" mediaType="text/plain" applicationCategory="DEVICE" applicationType="DATA" size="10" versionId="1" state="PRODUCTION"><FileLocation href="ftp://not-a-real-user:odd-pass@x&apos;odd-word@files.example/programs/p3.nc#token=not-a-real-fragment"/><Destinations><Destination>LIBREDB-1722</Destination></Destinations><CreationTime>2026-01-01T00:00:00Z</CreationTime></File>';
// A location with backslashes and no :// after its scheme, which a WHATWG URL parser reads as http://user:pass@host.
const FILE_WITH_BACKSLASH_SECRET =
  '<File assetId="FILE-4" name="p4.nc" mediaType="text/plain" applicationCategory="DEVICE" applicationType="DATA" size="10" versionId="1" state="PRODUCTION"><FileLocation href="http:\\\\backslash-user:backslash-pass@files.example/programs/p4.nc"/><Destinations><Destination>LIBREDB-1722</Destination></Destinations><CreationTime>2026-01-01T00:00:00Z</CreationTime></File>';
const TOOL_WITH_PATH =
  '<CuttingTool assetId="TOOL-2" toolId="T2" serialNumber="SN-2"><Description>see //fileserver/tools/T2.pdf</Description><CuttingToolLifeCycle><ProgramToolNumber>2</ProgramToolNumber><CutterStatus><Status>NEW</Status></CutterStatus></CuttingToolLifeCycle></CuttingTool>';
const stored = [];
for (const [id, type, body] of [
  ["FILE-1", "File", FILE_WITH_SECRET],
  ["FILE-2", "File", FILE_WITH_PATH],
  ["FILE-3", "File", FILE_WITH_ODD_SECRET],
  ["FILE-4", "File", FILE_WITH_BACKSLASH_SECRET],
  ["TOOL-2", "CuttingTool", TOOL_WITH_PATH],
] as const) {
  const answer = await fetch(`http://127.0.0.1:${PUT_PORT}/asset/${id}?type=${type}&device=${LATHE}`, {
    method: "PUT",
    body,
  });
  await answer.text();
  stored.push({ asset: id, type, status: answer.status });
}
const rawAssets = await (await fetch(`http://127.0.0.1:${PUT_PORT}/assets`)).text();
const assetsRead = await mcp(putAgent, "/assets");
const assetText = JSON.stringify(assetsRead.result);
const assets = {
  stored,
  agentServesTheUserinfoAsWritten: rawAssets.includes("not-a-real-password"),
  agentServesTheOddUserinfoAsWritten: rawAssets.includes("odd-pass@x") && rawAssets.includes("odd-word@files.example"),
  agentServesTheBackslashUserinfoAsWritten: rawAssets.includes("http:\\\\backslash-user:backslash-pass@files.example"),
  throughTheTool: {
    rows: rowsOf(assetsRead.result).map((row) => ({ assetId: row.assetId, type: row.type })),
    carriesTheUserName: assetText.includes("not-a-real-user"),
    carriesThePassword: assetText.includes("not-a-real-password"),
    carriesTheQuery: assetText.includes("not-a-real-token"),
    carriesTheOddPassword: assetText.includes("odd-pass") || assetText.includes("odd-word"),
    carriesTheFragment: assetText.includes("not-a-real-fragment"),
    carriesTheBackslashUserinfo: assetText.includes("backslash-user") || assetText.includes("backslash-pass"),
    keepsTheHostAndPath: assetText.includes("ftp://[withheld]@files.example/programs/program.nc?[withheld]"),
    keepsTheOddHostAndPath: assetText.includes("ftp://[withheld]@files.example/programs/p3.nc#[withheld]"),
    keepsTheBackslashHostAndPath: rowsOf(assetsRead.result).some((row) =>
      String(row.document).includes("http:\\\\[withheld]@files.example/programs/p4.nc"),
    ),
    keepsTheFilePath: assetText.includes("file:///opt/programs/p2.nc"),
    keepsTheToolDescription: assetText.includes("//fileserver/tools/T2.pdf"),
  },
};
check(assets.agentServesTheUserinfoAsWritten, "the AllowPut agent serves a File asset's userinfo as written");
check(
  !assets.throughTheTool.carriesTheUserName &&
    !assets.throughTheTool.carriesThePassword &&
    !assets.throughTheTool.carriesTheQuery &&
    assets.throughTheTool.keepsTheHostAndPath &&
    assets.throughTheTool.keepsTheFilePath,
  "the tool answers the File asset's location with its user name, password and query withheld",
);
check(
  assets.agentServesTheOddUserinfoAsWritten &&
    !assets.throughTheTool.carriesTheOddPassword &&
    !assets.throughTheTool.carriesTheFragment &&
    assets.throughTheTool.keepsTheOddHostAndPath,
  "a password holding an @ and a quote, and a token in the fragment, reach no answer while the host and path do",
);

check(
  assets.agentServesTheBackslashUserinfoAsWritten &&
    !assets.throughTheTool.carriesTheBackslashUserinfo &&
    assets.throughTheTool.keepsTheBackslashHostAndPath,
  "a location with backslashes and no :// after its scheme reaches no answer with its user name or password",
);

// The MQTT sink agent: the broker's address, raw on every route and through the tool's model read.
const SINK_ROUTES = ["/probe", `/${LATHE}/probe`, "/current", `/${LATHE}/current`, "/sample?count=-50", "/assets"];
const sinkRaw: Record<string, boolean> = {};
for (const route of SINK_ROUTES) {
  sinkRaw[route] = BROKER.test(await (await fetch(`http://127.0.0.1:${SINK_PORT}${route}`)).text());
}
const sinkModel = await mcp(sinkAgent, "/probe");
const sinkCurrent = await mcp(sinkAgent, "/current");
const sink = {
  rawRoutesCarryingTheBroker: Object.entries(sinkRaw)
    .filter(([, carries]) => carries)
    .map(([route]) => route),
  throughTheTool: {
    probeCarriesTheBroker: BROKER.test(JSON.stringify(sinkModel.result)),
    currentCarriesTheBroker: BROKER.test(JSON.stringify(sinkCurrent.result)),
  },
};
check(
  sink.rawRoutesCarryingTheBroker.length === 0 &&
    !sink.throughTheTool.probeCarriesTheBroker &&
    !sink.throughTheTool.currentCarriesTheBroker,
  "the MQTT sink's broker address reaches no route and no answer",
);

// One read through the factory's own profiled acquisition, as the route makes it.
const viaFactory = await mcp(fixture, "/current", {
  acquire: (connection, profile) => acquireExecutionProfileProvider(connection as DatabaseConnection, profile),
});
check(viaFactory.result.isError !== true, "a read through the factory's profiled acquisition answers");

const endSequence = await nextSequence(PORT);
const capture = {
  fixture: {
    image: IMAGE,
    adapter: "docker/mtconnect-init/adapter.py, one position every 10 s",
    agents: {
      [String(PORT)]: "AllowPut = false (docker/mtconnect-init/agent.cfg)",
      [String(PUT_PORT)]: "AllowPut = true",
      [String(SINK_PORT)]: "AllowPut = false, MqttService sink to an eclipse-mosquitto 2.0.22 broker",
    },
    capturedAt: new Date().toISOString().slice(0, 10),
  },
  tool: FENCED.tool,
  reads,
  writes,
  positiveControl,
  refused,
  pathOracle,
  limits: {
    cutAtMaxRows: { rowCount: cutContent?.row_count, truncatedBy: cutContent?.truncated_by, hint: cutContent?.hint },
    timeout,
    cancel,
  },
  assets,
  sink,
  factory: { answered: viaFactory.result.isError !== true, rowCount: rowsOf(viaFactory.result).length },
  state: {
    nextSequenceBefore: startSequence,
    nextSequenceAfter: endSequence,
    observationsBetween: endSequence > startSequence ? await observationsSince(PORT, startSequence) : [],
  },
};

const text = `${JSON.stringify(capture, null, 2)}\n`;
if (ADAPTER.test(text)) throw new Error("the capture carries the adapter's address");
if (BROKER.test(text)) throw new Error("the capture carries the broker's address");
if (FAKE_SECRETS.some((secret) => text.includes(secret))) throw new Error("the capture carries a credential value");
if (/sender="/.test(text)) throw new Error("the capture carries the agent's host name");
writeFileSync(path.join(OUT, "boundary.json"), text);
console.log(`wrote ${path.join(OUT, "boundary.json")}`);
console.log(failures === 0 ? "every check passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
