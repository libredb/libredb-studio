/**
 * Runs the SNMP agent's own reads through the provider against the snmpd 5.9.4 fixture that
 * tests/fixtures/snmp/5.9.4/agent-boundary/run.sh started, reads the withheld security and target subtrees raw, and
 * writes what the agent answered into that run.sh's directory as boundary.json.
 *
 *   bun tests/live/snmp-agent-boundary.ts
 *
 * The environment names the agent: SNMP_AGENT_PORT (its UDP port on 127.0.0.1), SNMP_AGENT_OUT (the directory to
 * write) and SNMP_AGENT_SET (what run.sh's raw Set drew, already reduced to the agent's reason). The community is the
 * fixture's own (`tests/fixtures/snmp/identity.ts`), and the capture records no credential value at all: a withheld
 * subtree is recorded by how many instances it answered, the distinct object columns without their instance suffixes,
 * and whether any identifier or value carried the community, never by an identifier or a value. Before anything is
 * written the whole capture is checked for the community and for its decimal spelling as an instance suffix, and the
 * script stops if either is there.
 *
 * The raw reads go through the provider's own exchange (`client.ts`), never through the agent path, which is the point:
 * what is measured is what the agent answers a raw read of each subtree. The raw Set is sent by run.sh with the
 * image's own snmpset, never by Studio. The agent's input counters (snmpInPkts, snmpInSetRequests) are read before and
 * after the agent's refused statements and after all of its reads, so the capture shows the refusals sent nothing and
 * the agent path sent no Set.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs no file under tests/live/.
 */
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the agent holds then.
import { randomInt } from "node:crypto";
import { writeFileSync } from "node:fs";
import { posix } from "node:path";
import { openExchange, resolveTarget } from "@/lib/db/providers/network/snmp/client";
import { SNMP_WITHHELD_SUBTREES } from "@/lib/db/providers/network/snmp/agent-statement";
import { SnmpProvider } from "@/lib/db/providers/network/snmp/index";
import { isWithinSubtree } from "@/lib/db/providers/network/snmp/objects";
import { PDU_GET, PDU_GET_NEXT } from "@/lib/db/providers/network/snmp/valve";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { FIXTURE_COMMUNITY } from "../fixtures/snmp/identity";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const PORT = Number(env("SNMP_AGENT_PORT"));
const OUT = env("SNMP_AGENT_OUT");
const SET = env("SNMP_AGENT_SET");
const DATE = new Date().toISOString().slice(0, 10);
const READ_ONLY: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 50, maxResultBytes: 1_000_000, statementTimeoutMs: 5_000 };
const SUFFIX = [...new TextEncoder().encode(FIXTURE_COMMUNITY)].join(".");

const IN_PKTS = [1, 3, 6, 1, 2, 1, 11, 1, 0];
const IN_SETS = [1, 3, 6, 1, 2, 1, 11, 17, 0];

const target = await resolveTarget("127.0.0.1", PORT);
const raw = await openExchange({ target, community: FIXTURE_COMMUNITY, deadlineMs: 3_000 });
const requestId = () => randomInt(1, 0x7fffffff);

async function counter(oid: readonly number[]): Promise<number> {
  const answer = await raw.send(PDU_GET, requestId(), [oid], undefined);
  if (!("varbinds" in answer)) throw new Error(`no answer for ${oid.join(".")}`);
  return [...answer.varbinds[0].value].reduce((n, b) => n * 256 + b, 0);
}

/**
 * One withheld subtree read raw with GetNext, recorded by counts and flags alone. `depth` is how many sub-identifiers
 * below the root name a column, the table's entry and column (or the scalar), so no recorded prefix reaches an index.
 */
async function rawSubtree(root: readonly number[], depth: number) {
  const columns = new Set<string>();
  let instances = 0;
  let carriesCommunity = false;
  let suffixSpellsCommunity = false;
  let from = root;
  for (;;) {
    const answer = await raw.send(PDU_GET_NEXT, requestId(), [from], undefined);
    if (!("varbinds" in answer)) throw new Error(`no answer under ${root.join(".")}`);
    const varbind = answer.varbinds[0];
    if (!isWithinSubtree(root, varbind.oid) || varbind.tag === 0x82) break;
    instances += 1;
    const dotted = varbind.oid.join(".");
    // The column is the table's entry and column (or the scalar), the identifier without what follows them.
    columns.add(varbind.oid.slice(0, root.length + depth).join("."));
    if (new TextDecoder().decode(varbind.value).includes(FIXTURE_COMMUNITY)) carriesCommunity = true;
    if (dotted.includes(SUFFIX)) suffixSpellsCommunity = true;
    from = varbind.oid;
  }
  return { instances, columnPrefixes: [...columns].sort(), carriesCommunity, suffixSpellsCommunity };
}

const connection = {
  id: "agent-boundary",
  name: "agent-boundary",
  type: "snmp",
  host: "127.0.0.1",
  port: PORT,
  password: FIXTURE_COMMUNITY,
  createdAt: new Date(),
} as unknown as DatabaseConnection;

const provider = new SnmpProvider(connection, { queryTimeout: 5_000 }, READ_ONLY);
await provider.connect();

/** One agent statement through `queryReadOnly`: its rows, or its refusal's class and sentence. */
async function agentRead(statement: string, budget: ReadOnlyStatementBudget = BUDGET) {
  try {
    const result = await provider.queryReadOnly(statement, budget);
    return {
      statement,
      rowCount: result.rowCount,
      fields: result.fields,
      rows: result.rows,
      warnings: result.warnings,
    };
  } catch (error) {
    return { statement, refused: (error as Error).name, message: (error as Error).message };
  }
}

const setsAtStart = await counter(IN_SETS);
const withheld = [];
// The framework's modules hold their tables one node down (vacmObjects, usmMIBObjects); Net-SNMP's extension holds
// nsVacmAccessTable at its root, so its column is one sub-identifier nearer, and the next is the group name's length.
const COLUMN_DEPTH: Readonly<Record<string, number>> = { "NET-SNMP-VACM-MIB": 3 };
for (const entry of SNMP_WITHHELD_SUBTREES) {
  const depth = COLUMN_DEPTH[entry.module] ?? 4;
  withheld.push({ module: entry.module, root: entry.root.join("."), raw: await rawSubtree(entry.root, depth) });
}

// What sends nothing (refused, or a withheld identifier answered without asking): the agent's input counter, read raw
// before and after, moves by the one read after alone.
const pktsBefore = await counter(IN_PKTS);
const notSent = [];
for (const statement of [
  "set 1.3.6.1.2.1.1.5.0 s changed",
  "walk 1",
  "walk 1.3.6.1.6.3.18",
  "walk 1.3.6.1.4.1.8072.1.9",
  "table 1.3.6.1.6.3.16.1.2",
  "bulkwalk 1.3.6.1.2.1",
  "get 1.3.6.1.6.3.18.1.1.1.2.1",
  "next 1.3.6.1.6.3.15.1",
]) {
  notSent.push(await agentRead(statement));
}
const pktsAfter = await counter(IN_PKTS);

const reads = [];
for (const statement of [
  "get sysDescr.0 sysName.0 sysUpTime.0",
  "next sysDescr.0",
  "walk ifDescr",
  "table ifEntry",
  "walk 1.3.6.1.4.1.8072.9999.9999",
  "table 1.3.6.1.4.1.8072.9999.9999.10.1",
  "next 1.3.6.1.6.3.11.99 1.3.6.1.6.3.14.99",
  "walk 1.3.6.1.6.3",
]) {
  reads.push(await agentRead(statement));
}

/**
 * Walks that cover a withheld subtree and step over it, recorded by their size, their warnings and how many answered
 * objects lie inside a withheld subtree (none may), never by their rows: the enterprise subtree is large.
 */
const WIDE: ReadOnlyStatementBudget = { maxResultRows: 5_000, maxResultBytes: 4_000_000, statementTimeoutMs: 20_000 };
const steppedOver = [];
for (const statement of ["walk 1.3.6.1.4.1.8072.1", "walk 1.3.6.1.4.1"]) {
  const read = await agentRead(statement, WIDE);
  const answered = "rows" in read ? read : undefined;
  const objects = (answered?.rows ?? []).map((row) => String(row.object).split(".").map(Number));
  steppedOver.push({
    statement,
    rowCount: answered?.rowCount,
    refused: "refused" in read ? read.message : undefined,
    warned: (answered?.warnings ?? []).map((warning) => warning.message.split(" ")[0]),
    insideWithheld: objects.filter((oid) => SNMP_WITHHELD_SUBTREES.some((entry) => isWithinSubtree(entry.root, oid)))
      .length,
  });
}
const overBudget = await agentRead("walk ifEntry", { ...BUDGET, maxResultRows: 3 });
const setsAtEnd = await counter(IN_SETS);
const health = await provider.getHealth();
await provider.disconnect();
raw.close();

const capture = {
  measured: DATE,
  agent: "docker/snmp (Net-SNMP snmpd 5.9.4+dfsg-2+deb13u1), rocommunity over view everything",
  budget: BUDGET,
  withheld,
  rawSet: { reason: SET, sentBy: "run.sh with the image's snmpset, never by Studio" },
  notSent,
  notSentReachedNothing: { snmpInPktsBefore: pktsBefore, snmpInPktsAfter: pktsAfter, rawReadsBetween: 1 },
  reads,
  steppedOver,
  overBudget,
  health: { description: health.description, uptimeRead: health.uptime !== "" },
  agentPathSentNoSet: { snmpInSetRequestsAtStart: setsAtStart, snmpInSetRequestsAtEnd: setsAtEnd },
};

const text = `${JSON.stringify(capture, null, 2)}\n`;
if (text.includes(FIXTURE_COMMUNITY) || text.includes(SUFFIX)) {
  throw new Error("the capture holds the community or its instance spelling, so nothing was written");
}
writeFileSync(posix.join(OUT.replaceAll("\\", "/"), "boundary.json"), text);
console.log(`wrote boundary.json: ${notSent.length} not sent, ${reads.length} reads, ${withheld.length} subtrees`);
