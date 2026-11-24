/**
 * Records what a live OPC UA server answers, so the integration test replays a server's own words.
 *
 * WHY A RECORDING AND NOT A LIVE TEST. The integration suite runs in CI with no plant on the
 * network, and the house rule is the one `tests/live/etcd-evidence.ts` follows: capture from a
 * pinned image once, replay through the real provider for ever after. Nothing here is invented; a
 * capture this script cannot take fails rather than being filled in.
 *
 * The fixture is Microsoft OPC PLC 2.15.10, pinned by digest, which is the first fixture of #1677:
 *
 *   docker run -d --name opcua-evidence -p 54840:50000 \
 *     mcr.microsoft.com/iotedge/opc-plc@sha256:28bbdaa2e8781fe3b8bda1bbd2d4ebe0ad5bcb1fbb83f69c74b8a92efa7fe75c \
 *     --pn=50000 --autoaccept --unsecuretransport --ut --sph --hn --slownodes=3 --fastnodes=3
 *
 * Run: `bun tests/live/opcua-evidence.ts` (writes `tests/fixtures/opcua/`).
 */
import "@/lib/db/providers/industrial/opcua/hostname-guard";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPCUA_LIBRARY_BRIDGE } from "@/lib/db/providers/industrial/opcua/library";
import { openReadOnlySession } from "@/lib/db/providers/industrial/opcua/session";
import { OPCUA_OBJECTS_FOLDER } from "@/lib/db/providers/industrial/opcua/constants";
import type { OpcuaSessionOptions } from "@/lib/db/providers/industrial/opcua/connection";

const ENDPOINT = process.env.LIBREDB_OPCUA_EVIDENCE_URL ?? "opc.tcp://127.0.0.1:54840/";
const OUT = join(import.meta.dir, "..", "fixtures", "opcua");

/** The connection the capture is taken over: None, anonymous, loopback. */
function options(): OpcuaSessionOptions {
  const url = new URL(ENDPOINT);
  return {
    endpointUrl: ENDPOINT,
    host: url.hostname,
    port: Number(url.port || "4840"),
    mode: "None",
    identity: "anonymous",
    pkiRoot: mkdtempSync(join(tmpdir(), "opcua-evidence-pki-")),
    tunnelled: false,
  };
}

/** Bytes are written as base64, because a continuation point is bytes and JSON has none. */
function jsonSafe(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { "@bytes": Buffer.from(value).toString("base64") };
  if (typeof value === "bigint") return value.toString();
  return value;
}

function write(name: string, body: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(body, jsonSafe, 2)}\n`);
  console.log(`wrote ${name}.json`);
}

const read = options();
const endpoints = await OPCUA_LIBRARY_BRIDGE.readEndpoints(read);
write("endpoints", { endpoint: ENDPOINT, endpoints });

const client = await openReadOnlySession(OPCUA_LIBRARY_BRIDGE, read);
try {
  write("limits", await client.limits());

  // The Objects folder, then every level down to the slow and fast nodes OPC PLC seeds.
  const levels: Record<string, unknown> = {};
  const toBrowse: string[] = [OPCUA_OBJECTS_FOLDER];
  const seen = new Set<string>();
  let depth = 0;
  while (toBrowse.length > 0 && depth < 4) {
    const next: string[] = [];
    for (const nodeId of toBrowse) {
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      // oxlint-disable-next-line no-await-in-loop -- one level at a time, so the capture is taken in a fixed order.
      const [answer] = await client.browse([nodeId]);
      if (answer === undefined) continue;
      levels[nodeId] = answer;
      for (const reference of answer.references) if (reference.mayHaveChildren) next.push(reference.nodeId);
    }
    // One level is enough breadth for a replay; the walk's own budget is tested in unit tests.
    toBrowse.length = 0;
    toBrowse.push(...next.slice(0, 12));
    depth += 1;
  }
  // And one Browse per CHILD of every captured level, because that is what the page does to learn
  // which rows are folders: a row is drawn as a folder only when the server answered children for
  // it, so the replay needs the server's answer for each of them too.
  const children = new Set<string>();
  for (const answer of Object.values(levels)) {
    for (const reference of (answer as { references: { nodeId: string; mayHaveChildren: boolean }[] }).references) {
      if (reference.mayHaveChildren) children.add(reference.nodeId);
    }
  }
  for (const nodeId of children) {
    if (levels[nodeId] !== undefined) continue;
    // oxlint-disable-next-line no-await-in-loop -- one node at a time, so the capture is taken in a fixed order.
    const [answer] = await client.browse([nodeId]);
    if (answer !== undefined) levels[nodeId] = answer;
  }
  write("levels", levels);

  // A read of the seeded nodes, with the ten attributes a row carries.
  const nodeIds = [
    "ns=3;s=SlowUInt1",
    "ns=3;s=FastUInt1",
    "i=2258", // Server_ServerStatus_CurrentTime, which every server holds
    "ns=3;s=HistorianInt32", // the one node `--hn` historizes
    "ns=3;s=NoSuchNodeAtAll", // the refusal, recorded as the server words it
  ];
  write("values", { nodeIds, values: await client.read(nodeIds) });

  // Raw history, from the one node `--hn` historizes and from one that keeps none, because the two
  // answers are different facts: a page of values, and `BadHistoryOperationUnsupported`.
  const historian = "ns=3;s=HistorianInt32";
  // The window is fixed here, once, and travels with the continuation: a continued read whose
  // details differ from the read that handed out the point answers BadContinuationPointInvalid.
  const window = { startTime: new Date(0), endTime: new Date(), valuesPerPage: 20 };
  const first = await client.historyRead({ nodeId: historian, ...window });
  const continued =
    first.continuationPoint === undefined
      ? undefined
      : await client.historyReadNext({ nodeId: historian, continuationPoint: first.continuationPoint, ...window });
  // And the refusal that a DIFFERENT window earns, recorded because it is the trap itself.
  const mismatched =
    first.continuationPoint === undefined
      ? undefined
      : await client.historyReadNext({
          nodeId: historian,
          continuationPoint: first.continuationPoint,
          startTime: new Date(1_000),
          endTime: new Date(),
          valuesPerPage: 20,
        });
  write("history", {
    nodeId: historian,
    page: first,
    ...(continued === undefined ? {} : { next: continued }),
    ...(mismatched === undefined ? {} : { mismatchedWindow: mismatched }),
    unhistorized: {
      nodeId: "ns=3;s=SlowUInt1",
      page: await client.historyRead({ nodeId: "ns=3;s=SlowUInt1", valuesPerPage: 20 }),
    },
  });
} finally {
  await client.close();
}
console.log("done");
