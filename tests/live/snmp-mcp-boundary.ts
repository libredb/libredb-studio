/**
 * Live check of MCP's `run_snmp_read` on the Net-SNMP 5.9.4 agent docker/snmp builds, captured into `boundary.json`
 * beside `tests/fixtures/snmp/5.9.4/mcp-boundary/run.sh`, which starts the agent with a configuration of its own: a
 * census community reading the whole tree, a broad one reading it but the device and installed-software tables
 * (hrDevice and hrSWInstalled, which hold no withheld subtree), so a walk of the host group fits the row budget, a
 * crossing one whose view is hrSystem, hrSWRun and hrSWRunPerf, so a walk of the host group crosses the running
 * processes within one page, a narrow one whose view holds the system group alone, a writer, and markers
 * planted where a credential would sit (a running process's arguments, an SNMPv3 user's keys, two notification
 * targets' communities, and the extend, exec and procfix directives' commands).
 *
 * WHY THIS EXISTS. `run_snmp_read` serves SNMP through the boundary agent mode uses: the connection is acquired under
 * the agent read-only profile by the factory itself, and every command goes through the provider's `queryReadOnly`,
 * the agent's client of Get, GetNext and GetBulk alone behind the valve, with every withheld subtree decided on the
 * answer. The MCP fence in front of it, the agent's own admission, is defence in depth. So this script drives the
 * tool's own handler (`runStatement`) with a seed connection, fenced as MCP registers it and with the fence removed:
 *
 *   census     the whole tree read raw with the image's own snmpwalk and the census community: every identifier whose
 *              value or instance suffix carries a planted marker lies inside a withheld subtree;
 *   reads      a get, a next, a walk and a table under the broad community, through the tool: rows, and whether the
 *              answer carried a marker or a community;
 *   withheld   a walk of every subtree that holds a marker's root, a get of a marked instance and a next that lands in
 *              one, through the tool: nothing marked answered, and the notes name each withheld subtree;
 *   crossing   a walk of the host group under the crossing community, which the agent answers raw inside hrSWRun:
 *              rows on both sides of it through the tool, none inside it, so the step-over is shown on the answer;
 *   scope      the narrow community (layer one, the agent's view): what its view holds answers, an object outside it
 *              and a missing one answer alike;
 *   refused    every form the agent refuses, fenced (nothing acquired) and unfenced (the provider refuses it before
 *              anything is sent), and the over-budget walk;
 *   writes     a raw Set with the writer's community, the positive control, changes sysContact, while the same Set
 *              through the unfenced tool with the same community sends nothing and changes nothing;
 *   limits     a read at the least timeout_ms of an agent that stopped answering after the acquisition, and a client
 *              cancel: when MCP answered and when the provider's own read ended.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. The capture records no community and no
 * marker: an answer is recorded as its figures and as whether it carried any of them. Each is checked before the file
 * is written; any failed check ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the agent holds after the one before.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { posix } from "node:path";
import { AGENT_LANGUAGE_COPY } from "@/lib/agent/agent-manifest";
import { languageServer } from "@/lib/agent/languages/server";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import { withheldSubtreeOf } from "@/lib/db/providers/network/snmp/agent-statement";
import type { DatabaseProvider } from "@/lib/db/types";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, type ToolResult } from "@/lib/mcp/output";
import { timeoutText } from "@/lib/mcp/tools/read-query-limits";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set; run this through run.sh`);
  return value;
};

const PORT = Number(required("SNMP_MCP_PORT"));
const OUT = required("SNMP_MCP_OUT");
const CONTAINER = required("SNMP_MCP_CONTAINER");
const IMAGE = required("SNMP_MCP_IMAGE");
const CENSUS = required("SNMP_MCP_CENSUS");
const BROAD = required("SNMP_MCP_BROAD");
const CROSS = required("SNMP_MCP_CROSS");
const NARROW = required("SNMP_MCP_NARROW");
const WRITER = required("SNMP_MCP_WRITER");
const ENCODE = (value: string) => [...new TextEncoder().encode(value)].join(".");
const SECRETS = [CENSUS, BROAD, CROSS, NARROW, WRITER].flatMap((community) => [community, ENCODE(community)]);
/** Every planted value starts with this word, and so do the SNMPv3 user's and the directives' names. */
const MARKER = "marker";
const MARKED = [MARKER, ENCODE(MARKER)];
/** The planted values themselves, which neither an answer nor the capture may carry. */
const PLANTED = [
  "markeruser",
  "markerauthpass1",
  "markerprivpass1",
  "markertrapcomm1",
  "markertrapsess1",
  "markerextendarg1",
  "markerexecarg1",
  "markerprocfix1",
  "markercmdline1",
];

let failures = 0;
function check(ok: boolean, line: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

const docker = (...args: string[]): string =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

/** The image's own snmpwalk inside the container, numeric identifiers, one line per instance. */
const rawWalk = (community: string, oid: string): string[] =>
  docker("exec", CONTAINER, "snmpwalk", "-v2c", "-c", community, "-On", "-t", "3", "127.0.0.1", oid)
    .split("\n")
    .filter((line) => line.startsWith("."));
const rawGet = (oid: string): string =>
  docker("exec", CONTAINER, "snmpget", "-v2c", "-c", BROAD, "-On", "-t", "3", "127.0.0.1", oid).trim();

function seed(name: string, community: string): ManagedConnection {
  return {
    id: `seed:live-${name}`,
    name,
    seedId: `live-${name}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "snmp",
    host: "127.0.0.1",
    port: PORT,
    password: community,
    createdAt: new Date(),
  } as unknown as ManagedConnection;
}

const RUN_SNMP_READ = mcpStatementArm("run_snmp_read");
/** The tool with its reader removed as a fence: the boundary under test. */
const UNFENCED: McpStatementArm = { ...RUN_SNMP_READ, fence: () => null };
const NOT_SENT = "The statement was refused before it reached the database: ";
const server = languageServer("snmpget");

/** When the last provider handed out settled its `queryReadOnly`, measured from the call. */
let lastSettledAt: number | null = null;
/** Run once, after the next acquisition and before its read: the agent stops answering. */
let afterAcquire: (() => void) | null = null;

async function mcp(
  connection: ManagedConnection,
  args: Partial<McpStatementInput> & { readonly statement: string },
  arm: McpStatementArm = RUN_SNMP_READ,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ readonly result: ToolResult; readonly acquired: ExecutionProfile[] }> {
  const acquired: ExecutionProfile[] = [];
  const context = {
    caller: { username: "live", role: "admin" },
    visibleConnections: async () => [connection],
    resolve: async () => connection,
    acquire: async (target: ManagedConnection, profile: ExecutionProfile) => {
      acquired.push(profile);
      const provider: DatabaseProvider = await acquireExecutionProfileProvider(target, profile);
      const hook = afterAcquire;
      afterAcquire = null;
      hook?.();
      return new Proxy(provider, {
        get(base, name, receiver) {
          const value = Reflect.get(base, name, receiver);
          if (name !== "queryReadOnly" || typeof value !== "function") return value;
          return (...callArgs: unknown[]) => {
            lastSettledAt = null;
            const started = Date.now();
            const settled = (value as (...a: unknown[]) => Promise<unknown>).apply(base, callArgs);
            void settled.then(
              () => (lastSettledAt = Date.now() - started),
              () => (lastSettledAt = Date.now() - started),
            );
            return settled;
          };
        },
      });
    },
  } as unknown as McpConnectionContext;
  const input = arm.inputSchema.parse({ connection_id: connection.id, ...args }) as McpStatementInput;
  const result = await runStatement(arm, input, { context, signal });
  clearProviderCache();
  return { result, acquired };
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => ("text" in part ? part.text : "")).join(" ");
const carries = (text: string, words: readonly string[]) => words.some((word) => text.includes(word));

interface Answered {
  readonly rows: Record<string, unknown>[];
  readonly notes?: string[];
}
const answerOf = (result: ToolResult): Answered => result.structuredContent as unknown as Answered;

/** An answer as the capture records it: its row count, its notes, and whether it carried anything withheld. */
function recorded(result: ToolResult) {
  const text = JSON.stringify(result);
  const answered = answerOf(result);
  return {
    isError: result.isError === true,
    ...(result.isError === true
      ? { text: textOf(result).slice(0, 400) }
      : { rows: answered.rows.length, notes: answered.notes ?? [] }),
    carriesMarker: carries(text, MARKED),
    carriesCommunity: carries(text, SECRETS),
  };
}

const rowsOf = (result: ToolResult) => answerOf(result).rows ?? [];

async function main(): Promise<void> {
  const broad = seed("broad", BROAD);
  const narrow = seed("narrow", NARROW);
  const writer = seed("writer", WRITER);

  // The census: every marked identifier the raw walk answers, by the withheld subtree it lies in.
  const census = rawWalk(CENSUS, ".1");
  const marked = census.filter((line) => carries(line, MARKED));
  const markedRoots = new Map<string, number>();
  let markedOutside = 0;
  for (const line of marked) {
    const oid = line.slice(1, line.indexOf(" ")).split(".").map(Number);
    const entry = withheldSubtreeOf(oid);
    if (entry === undefined) markedOutside++;
    else markedRoots.set(entry.module, (markedRoots.get(entry.module) ?? 0) + 1);
  }
  check(census.length > 1000, `census: the raw walk of 1 answered ${census.length} instances`);
  check(marked.length > 0, `census: ${marked.length} instances carry a planted marker`);
  check(markedOutside === 0, `census: every marked instance lies inside a withheld subtree (${markedOutside} outside)`);
  for (const name of [
    "HOST-RESOURCES-MIB::hrSWRun",
    "UCD-SNMP-MIB::prErrFixCmd",
    "UCD-SNMP-MIB::extTable",
    "NET-SNMP-AGENT-MIB::nsExtensions",
    "SNMP-TARGET-MIB",
  ]) {
    check((markedRoots.get(name) ?? 0) > 0, `census: a marker lies inside ${name}`);
  }

  // The reads, under the broad community.
  const reads: Record<string, ReturnType<typeof recorded>> = {};
  for (const statement of ["get sysDescr.0 sysUpTime.0", "next sysDescr.0", "walk system", "table ifEntry"]) {
    const read = await mcp(broad, { statement });
    reads[statement] = recorded(read.result);
    check(
      !read.result.isError && rowsOf(read.result).length > 0 && !reads[statement].carriesCommunity,
      `reads: ${statement} answers ${rowsOf(read.result).length} rows, no community`,
    );
    check(read.acquired.join(",") === "agent-read-only", `reads: ${statement} acquired under agent-read-only alone`);
  }

  // The withheld subtrees, through the tool.
  const pid = (census.find((line) => line.startsWith(".1.3.6.1.2.1.25.4.2.1.5.") && line.includes(MARKER)) ?? "")
    .split(" ")[0]
    .split(".")
    .at(-1);
  const withheldReads: Record<string, ReturnType<typeof recorded>> = {};
  const expectNotes: Array<[string, string[]]> = [
    ["walk host", ["HOST-RESOURCES-MIB::hrSWRun"]],
    ["walk 1.3.6.1.4.1.2021", ["UCD-SNMP-MIB::prErrFixCmd", "UCD-SNMP-MIB::extTable"]],
    ["walk 1.3.6.1.6.3", []],
    [`get hrSWRunParameters.${pid} sysName.0`, ["HOST-RESOURCES-MIB::hrSWRun"]],
    ["next 1.3.6.1.2.1.25.3.99", ["HOST-RESOURCES-MIB::hrSWRun"]],
    ["next 1.3.6.1.4.1.8072.1.2.99999", ["NET-SNMP-AGENT-MIB::nsExtensions"]],
    ["next 1.3.6.1.4.1.2021.8", ["UCD-SNMP-MIB::extTable"]],
  ];
  for (const [statement, modules] of expectNotes) {
    const read = await mcp(broad, { statement });
    withheldReads[statement] = recorded(read.result);
    const notes = answerOf(read.result).notes ?? [];
    check(
      !read.result.isError && !withheldReads[statement].carriesMarker && !withheldReads[statement].carriesCommunity,
      `withheld: ${statement} answers ${rowsOf(read.result).length} rows, no marker and no community`,
    );
    check(
      modules.every((module) => notes.some((note) => note.startsWith(`${module} (`))),
      `withheld: ${statement} notes name ${modules.join(", ") || "the framework modules"}`,
    );
  }

  // The notes are the request's; the crossing is the answer's. Under the crossing community, whose view is hrSystem,
  // hrSWRun and hrSWRunPerf alone, the agent answers the running processes raw, and a walk of the host group fits one
  // page, so its answer has rows on both sides of hrSWRun (hrSWRunPerf after it) and must have none inside it.
  const HR_SW_RUN = [1, 3, 6, 1, 2, 1, 25, 4];
  const side = (oid: readonly number[]): number => {
    const order = oid.slice(0, HR_SW_RUN.length).findIndex((arc, i) => arc !== HR_SW_RUN[i]);
    return order === -1 ? 0 : oid[order] < HR_SW_RUN[order] ? -1 : 1;
  };
  const crossRaw = rawWalk(CROSS, ".1.3.6.1.2.1.25").map((line) =>
    line.slice(1, line.indexOf(" ")).split(".").map(Number),
  );
  const crossRead = await mcp(seed("crossing", CROSS), { statement: "walk host" });
  const crossRows = rowsOf(crossRead.result).map((row) => String(row.object).split(".").map(Number));
  const crossing = {
    ...recorded(crossRead.result),
    rawInside: crossRaw.filter((oid) => side(oid) === 0).length,
    truncatedBy: (answerOf(crossRead.result) as unknown as { truncated_by?: string | null }).truncated_by ?? null,
    before: crossRows.filter((oid) => side(oid) === -1).length,
    inside: crossRows.filter((oid) => side(oid) === 0).length,
    after: crossRows.filter((oid) => side(oid) === 1).length,
    hrSWRunPerf: crossRows.some((oid) => oid.join(".").startsWith("1.3.6.1.2.1.25.5.")),
  };
  check(
    crossing.rawInside > 0,
    `crossing: the raw walk of host answers ${crossing.rawInside} instances inside hrSWRun`,
  );
  check(
    !crossRead.result.isError &&
      crossing.truncatedBy === null &&
      crossing.inside === 0 &&
      crossing.before > 0 &&
      crossing.hrSWRunPerf &&
      !crossing.carriesMarker,
    `crossing: walk host through the tool (cut: ${crossing.truncatedBy}) answers ${crossing.before} rows before hrSWRun, ${crossing.inside} inside, ${crossing.after} after, hrSWRunPerf among them, no marker`,
  );

  // Layer one: the narrow community's view holds the system group alone.
  const narrowSystem = await mcp(narrow, { statement: "get sysDescr.0" });
  const outsideView = await mcp(narrow, { statement: "get ifDescr.1" });
  const missing = await mcp(narrow, { statement: "get ifDescr.99999" });
  const narrowWalk = await mcp(narrow, { statement: "walk mib-2" });
  check(rowsOf(narrowSystem.result)[0]?.value !== null, "scope: the narrow community reads its view");
  check(
    JSON.stringify(rowsOf(outsideView.result)) ===
      JSON.stringify(rowsOf(missing.result)).replace("1.3.6.1.2.1.2.2.1.2.99999", "1.3.6.1.2.1.2.2.1.2.1"),
    `scope: an object outside the view and a missing one answer alike (${String(rowsOf(outsideView.result)[0]?.type)})`,
  );
  check(
    rowsOf(narrowWalk.result).every((row) => String(row.object).startsWith("1.3.6.1.2.1.1.")),
    `scope: the narrow walk of mib-2 answers the system group alone (${rowsOf(narrowWalk.result).length} rows)`,
  );

  // The refused forms: fenced, nothing is acquired and the agent reader's own refusal answers in its words; unfenced,
  // the provider refuses before anything is sent.
  const forms: readonly (readonly [string, string])[] = [
    ["a set", "set sysContact.0 s changed"],
    ["a walk inside the community module", "walk 1.3.6.1.6.3.18"],
    ["a table of the running processes", "table hrSWRunTable"],
    ["a walk of the extend directives", "walk 1.3.6.1.4.1.8072.1.3"],
    ["a walk of the exec directives", "walk 1.3.6.1.4.1.2021.8"],
    ["a trap", "trap 1.3.6.1.6.3.1.1.5.1"],
    ["Net-SNMP's tool syntax", "snmpget -v2c -c public 127.0.0.1 sysDescr.0"],
  ];
  const refused = [];
  for (const [what, statement] of forms) {
    const refusal = server.admit?.(statement);
    const fenced = await mcp(broad, { statement });
    const unfenced = await mcp(broad, { statement }, UNFENCED);
    const ownWords =
      refusal !== null &&
      refusal !== undefined &&
      textOf(fenced.result) ===
        `The ${AGENT_LANGUAGE_COPY.snmpget.noun} was refused before it reached the agent (${refusal.code}). ${refusal.message}`;
    check(
      fenced.result.isError === true && fenced.acquired.length === 0 && ownWords,
      `refused: ${what} fenced, in its own words (${refusal?.code}), nothing acquired`,
    );
    check(textOf(unfenced.result).includes(NOT_SENT), `refused: ${what} unfenced, refused before anything was sent`);
    refused.push({ request: what, code: refusal?.code, ownWords, fenced: textOf(fenced.result).slice(0, 80) });
  }
  const overBudget = await mcp(broad, { statement: "walk 1.3.6.1.4.1.8072.1.2" });
  check(
    textOf(overBudget.result).startsWith(
      "The result has more than 1000 rows, the most this server reads for one call.",
    ) && textOf(overBudget.result).includes(server.rowCapAdvice("walk 1.3.6.1.4.1.8072.1.2", "1000")),
    "refused: a walk past the 1000-row budget is refused with the way to narrow it",
  );

  // The positive control: a raw Set with the writer's community changes sysContact; the same Set through the
  // unfenced tool, with the same community, changes nothing.
  const contactBefore = rawGet(".1.3.6.1.2.1.1.4.0");
  docker(
    "exec",
    CONTAINER,
    "snmpset",
    "-v2c",
    "-c",
    WRITER,
    "-t",
    "3",
    "127.0.0.1",
    ".1.3.6.1.2.1.1.4.0",
    "s",
    "raw-set",
  );
  const contactAfterRaw = rawGet(".1.3.6.1.2.1.1.4.0");
  check(
    contactAfterRaw.includes("raw-set") && contactAfterRaw !== contactBefore,
    "writes: the writer's raw Set changed sysContact",
  );
  const unfencedSet = await mcp(writer, { statement: "set sysContact.0 s tool-set" }, UNFENCED);
  const contactAfterTool = rawGet(".1.3.6.1.2.1.1.4.0");
  check(
    textOf(unfencedSet.result).includes(NOT_SENT) && contactAfterTool === contactAfterRaw,
    "writes: the same Set through the unfenced tool, with the writer's community, sent nothing and changed nothing",
  );

  // The limits: the agent stops answering after the acquisition, so the read itself meets the deadline.
  const pause = () => docker("pause", CONTAINER);
  const unpause = () => docker("unpause", CONTAINER);
  afterAcquire = pause;
  const leastStarted = Date.now();
  const least = await mcp(broad, { statement: "get sysDescr.0", timeout_ms: 500 });
  const leastMs = Date.now() - leastStarted;
  await Bun.sleep(300);
  const leastReadEndedMs = lastSettledAt;
  unpause();
  check(
    textOf(least.result) === timeoutText(500) && leastMs < 1_000,
    `limits: at the least timeout_ms a silent agent is the timeout answer (${leastMs} ms)`,
  );
  check(
    leastReadEndedMs !== null && leastReadEndedMs < 1_000,
    `limits: the provider's own read ended at the time left (${leastReadEndedMs} ms)`,
  );
  afterAcquire = pause;
  const controller = new AbortController();
  const cancelStarted = Date.now();
  const pending = mcp(broad, { statement: "get sysDescr.0", timeout_ms: 3_000 }, RUN_SNMP_READ, controller.signal);
  setTimeout(() => controller.abort(), 1_000);
  const cancelled = await pending;
  const cancelIn = Date.now() - cancelStarted;
  await Bun.sleep(3_000);
  const cancelReadEndedMs = lastSettledAt;
  unpause();
  check(
    textOf(cancelled.result) === MCP_CANCELLED_TEXT && cancelIn < 1_500,
    `limits: a cancel answers (${cancelIn} ms)`,
  );
  check(
    cancelReadEndedMs !== null && cancelReadEndedMs >= 1_500 && cancelReadEndedMs < 3_500,
    `limits: the cancelled read still ended at its own time left, not at the cancel (${cancelReadEndedMs} ms)`,
  );

  const capture = {
    $captured: {
      image: IMAGE,
      date: new Date().toISOString().slice(0, 10),
      runtime: `bun ${Bun.version}`,
      communities:
        "census: view of 1; broad: view of 1 but hrDevice (1.3.6.1.2.1.25.3) and hrSWInstalled (1.3.6.1.2.1.25.6); crossing: hrSystem, hrSWRun and hrSWRunPerf (1.3.6.1.2.1.25.1, .4 and .5); narrow: view of the system group alone; writer: read-write view of 1 (made per run, not recorded)",
      markers:
        "a running process's arguments, an SNMPv3 user's keys, two notification targets' communities, and the extend, exec and procfix directives' commands",
    },
    census: {
      instances: census.length,
      marked: marked.length,
      markedOutsideWithheld: markedOutside,
      markedByWithheldSubtree: Object.fromEntries([...markedRoots.entries()].sort()),
    },
    reads,
    withheld: withheldReads,
    crossing,
    scope: {
      narrowSystem: recorded(narrowSystem.result),
      outsideViewType: rowsOf(outsideView.result)[0]?.type ?? null,
      missingType: rowsOf(missing.result)[0]?.type ?? null,
      narrowWalkOfMib2Rows: rowsOf(narrowWalk.result).length,
    },
    refused,
    overBudget: textOf(overBudget.result).slice(0, 200),
    writes: {
      rawSetChangedSysContact: contactAfterRaw !== contactBefore,
      unfencedToolSetChangedSysContact: contactAfterTool !== contactAfterRaw,
    },
    limits: {
      leastTimeoutAnsweredMs: leastMs,
      leastReadEndedMs,
      cancelAnsweredMs: cancelIn,
      cancelReadEndedMs,
    },
  };
  const text = `${JSON.stringify(capture, null, 2)}\n`;
  check(!carries(text, SECRETS), "capture: no community");
  check(!carries(text, [...PLANTED, ...PLANTED.map(ENCODE)]), "capture: no planted value");
  if (failures === 0) writeFileSync(posix.join(OUT, "boundary.json"), text);
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
