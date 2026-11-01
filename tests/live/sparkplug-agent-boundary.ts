/**
 * The Sparkplug agent path's boundary, measured against the fixture's own broker and publisher and against a stock
 * EMQX with the same publisher, and written to one `boundary.json` per broker, in
 * `tests/fixtures/sparkplug/mosquitto-2.0.22/agent-boundary/` and `tests/fixtures/sparkplug/emqx-5.8.9/agent-boundary/`,
 * by the `run.sh` in the first of them, which starts both and removes them after.
 *
 * What it records, per broker:
 * - `reads`: each admitted agent read through the provider's own `queryReadOnly`, its one projected row, how many
 *   warnings it carried, whether the last is the completeness sentence, and every packet it wrote, summarised (a
 *   SUBSCRIBE as its filter count and whether a filter holds a wildcard or a `$`, never the filter text);
 * - `refusedBeforeSend`: requests outside the closed table, each refused before a session opened;
 * - `rawRefused`: what the refused filters would answer if a subscriber sent them, through the provider's session and
 *   never through agent mode, as counts only;
 * - `rawCommand`: whether the broker takes an NCMD the capture script publishes with the reader's (anonymous) access;
 * - `retained`: the broker's retained set, counted and hashed, before and after the agent reads.
 *
 * It holds no id the publisher seeded, no metric name and no credential (this provider sends none): the probe checks
 * the capture's text before it writes, and refuses to write one that holds a seeded name.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import path from "node:path";
import { RefusedBeforeSendError } from "@/lib/db/errors";
import { SPARKPLUG_COMPLETENESS } from "@/lib/db/providers/industrial/sparkplug/agent-read";
import { dialAndRead, SparkplugProvider, type SparkplugReader } from "@/lib/db/providers/industrial/sparkplug/index";
import { readOnce, type Transport, type TransportFactory } from "@/lib/db/providers/industrial/sparkplug/session";
import { parseTopic } from "@/lib/db/providers/industrial/sparkplug/topics";
import type { DatabaseConnection } from "@/lib/types";

const SEEDED = [
  "SekoyaPlant",
  "AnkaraPlant",
  "Line1",
  "Line2",
  "Line3",
  "Line4",
  "Press01",
  "Mixer1",
  "sparkplug-fixture-publisher",
  "BatchName",
  "CycleCount",
  "GripperClosed",
  "Humidity",
  "MixerSpeed",
  "MotorRunning",
  "PressForce",
  "RecipeName",
  "ShiftName",
  "StrokeCount",
  "Temperature",
];

const BUDGET = { maxResultRows: 200, maxResultBytes: 1_000_000, statementTimeoutMs: 10_000 } as const;

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`sparkplug-agent-boundary: ${name} is not set`);
  return value;
}

/** A packet as the capture records it: its type, and for CONNECT and SUBSCRIBE what the boundary claims. */
function summarise(bytes: Uint8Array): Record<string, unknown> {
  const type = (bytes[0] as number) >> 4;
  if (type === 1) {
    const flags = bytes[1 + 1 + 2 + 4 + 1] as number;
    return {
      packet: "CONNECT",
      cleanStart: (flags & 0x02) !== 0,
      will: (flags & 0x04) !== 0,
      credentials: (flags & 0xc0) !== 0,
    };
  }
  if (type === 8) {
    let at = 1;
    while ((bytes[at] as number) & 0x80) at++;
    at += 1 + 2 + 1;
    const filters: string[] = [];
    while (at < bytes.length) {
      const length = ((bytes[at] as number) << 8) | (bytes[at + 1] as number);
      filters.push(new TextDecoder().decode(bytes.subarray(at + 2, at + 2 + length)));
      at += 2 + length + 1;
    }
    return {
      packet: "SUBSCRIBE",
      filters: filters.length,
      wildcard: filters.some((one) => one.includes("+") || one.includes("#")),
      dollar: filters.some((one) => one.startsWith("$")),
      namespace: filters.every((one) => one.startsWith("spBv1.0/")),
    };
  }
  const names: Record<number, string> = { 3: "PUBLISH", 10: "UNSUBSCRIBE", 12: "PINGREQ", 14: "DISCONNECT" };
  return { packet: names[type] ?? `type-${type}` };
}

/** A real socket whose every write is recorded before it is sent. */
function recording(port: number, sent: Record<string, unknown>[][]): TransportFactory {
  return () => {
    const socket = netConnect({ host: "127.0.0.1", port });
    const packets: Record<string, unknown>[] = [];
    sent.push(packets);
    const transport = {
      write(bytes: Uint8Array) {
        packets.push(summarise(bytes));
        socket.write(bytes);
      },
      on: (event: string, handler: (...args: unknown[]) => void) => socket.on(event, handler),
      once: (event: string, handler: () => void) => socket.once(event, handler),
      destroy: () => socket.destroy(),
    } as unknown as Transport;
    return { transport, readyEvent: "connect" };
  };
}

function connection(port: number): DatabaseConnection {
  return {
    id: "capture",
    name: "capture",
    type: "sparkplug",
    host: "127.0.0.1",
    port,
    database: "",
  } as DatabaseConnection;
}

const READS: readonly (readonly [string, string])[] = [
  ["window", '{"read": "window"}'],
  ["group-seen", '{"read": "group", "group": "SekoyaPlant"}'],
  ["group-not-seen", '{"read": "group", "group": "NoSuchPlant"}'],
  ["edge-node-seen", '{"read": "edgeNode", "group": "SekoyaPlant", "edgeNode": "Line1"}'],
  ["edge-node-not-seen", '{"read": "edgeNode", "group": "SekoyaPlant", "edgeNode": "Line9"}'],
  ["device-seen", '{"read": "device", "group": "SekoyaPlant", "edgeNode": "Line1", "device": "Press01"}'],
  ["device-not-seen", '{"read": "device", "group": "SekoyaPlant", "edgeNode": "Line1", "device": "Press99"}'],
];

const REFUSED: readonly string[] = [
  '{"read": "group", "group": "X#"}',
  '{"read": "group", "group": "+"}',
  '{"read": "edgeNode", "group": "X", "edgeNode": "Y/NDATA"}',
  '{"read": "group", "group": "STATE"}',
  '{"read": "window", "topic": "$sparkplug/certificates/#"}',
  '{"read": "window", "filter": "$share/g/spBv1.0/#"}',
  '{"read": "publish"}',
  '{"read": "NCMD", "group": "X", "edgeNode": "Y"}',
  '{"read": "window", "rebirth": true}',
  '{"read": "window", "hostId": "H"}',
  '{"read": "window", "will": {}}',
  JSON.stringify({ read: "group", group: "x".repeat(1_025) }),
];

const RAW_FILTERS: readonly (readonly [string, string])[] = [
  ["wildcard-below-the-namespace", "spBv1.0/+/NBIRTH/+"],
  ["stored-certificates", "$sparkplug/certificates/#"],
  ["host-state", "spBv1.0/STATE/#"],
  ["shared-subscription", "$share/pr321/spBv1.0/#"],
];

/** A shell command in the broker's network, with the fixture's own Mosquitto clients. */
function inBroker(container: string, image: string, script: string): string {
  const run = spawnSync(
    "docker",
    ["run", "--rm", "--network", `container:${container}`, "--entrypoint", "sh", image, "-c", script],
    { encoding: "utf8" },
  );
  return run.stdout;
}

function retained(container: string, image: string) {
  const out = inBroker(
    container,
    image,
    "mosquitto_sub -h 127.0.0.1 -p 1883 --retained-only -v -t '#' -t '$sparkplug/#' -W 3 2>/dev/null; true",
  );
  const lines = out
    .split("\n")
    .filter((line) => line !== "")
    .sort();
  return { messages: lines.length, sha256: createHash("sha256").update(lines.join("\n")).digest("hex") };
}

async function capture(port: number, container: string, image: string) {
  const before = retained(container, image);
  const sent: Record<string, unknown>[][] = [];
  const reader: SparkplugReader = (request) => dialAndRead(request, recording(port, sent));
  const provider = new SparkplugProvider(connection(port), {}, { readOnly: true, sendsStatements: true }, reader);
  await provider.connect();
  const connect = sent.at(-1);
  const reads: Record<string, unknown>[] = [];
  for (const [label, text] of READS) {
    const opened = sent.length;
    const result = await provider.queryReadOnly(text, BUDGET);
    const warnings = result.warnings?.map((one) => one.message) ?? [];
    reads.push({
      read: label,
      row: result.rows[0],
      warnings: warnings.length,
      completenessLast: warnings.at(-1) === SPARKPLUG_COMPLETENESS,
      sent: sent.slice(opened).flat(),
    });
  }
  const refusedBeforeSend: Record<string, unknown>[] = [];
  for (const text of REFUSED) {
    const opened = sent.length;
    const error = await provider.queryReadOnly(text, BUDGET).catch((caught: unknown) => caught);
    refusedBeforeSend.push({
      request: text.length > 200 ? `${text.slice(0, 40)}... (${text.length} characters)` : text,
      refusedBeforeSend: error instanceof RefusedBeforeSendError,
      sessionsOpened: sent.length - opened,
    });
  }
  const after = retained(container, image);
  const rawRefused: Record<string, unknown>[] = [];
  for (const [label, filter] of RAW_FILTERS) {
    const outcome = await readOnce({
      host: "127.0.0.1",
      port,
      filters: [filter],
      windowMs: 3_000,
      maxMessages: 10_000,
      maxBytes: 8 * 1024 * 1024,
    });
    const nodes = new Set<string>();
    for (const message of outcome.messages) {
      const topic = parseTopic(message.topic);
      if (topic.kind === "node") nodes.add(JSON.stringify([topic.groupId, topic.edgeNodeId, topic.deviceId ?? ""]));
    }
    rawRefused.push({
      filter: label,
      endReason: outcome.endReason,
      subscriptionsRefused: outcome.subscriptionsRefused,
      messages: outcome.messages.length,
      distinctNodesNamed: nodes.size,
    });
  }
  const ncmd = inBroker(
    container,
    image,
    "mosquitto_sub -h 127.0.0.1 -p 1883 -t 'spBv1.0/+/NCMD/#' -C 1 -W 6 > /tmp/ncmd 2>/dev/null & sleep 1; " +
      "mosquitto_pub -h 127.0.0.1 -p 1883 -t spBv1.0/SekoyaPlant/NCMD/Line1 -m rebirth; wait; wc -c < /tmp/ncmd",
  );
  return {
    connect,
    reads,
    refusedBeforeSend,
    rawRefused,
    rawCommand: {
      sentBy: "the capture script with the broker's own client and no credential, never Studio",
      takenByTheBroker: Number(ncmd.trim()) > 0,
    },
    retained: { before, after, unchanged: before.sha256 === after.sha256 && before.messages === after.messages },
  };
}

const image = need("SPARKPLUG_CLIENT_IMAGE");
const capturedAt = new Date().toISOString().slice(0, 10);
/** Each broker's capture in its own `<broker>-<version>/agent-boundary/` directory under `SPARKPLUG_OUT`. */
const captures: readonly (readonly [string, string, Awaited<ReturnType<typeof capture>>])[] = [
  [
    "mosquitto-2.0.22",
    "eclipse-mosquitto:2.0.22",
    await capture(Number(need("SPARKPLUG_PORT")), need("SPARKPLUG_BROKER"), image),
  ],
  ["emqx-5.8.9", "emqx/emqx:5.8.9", await capture(Number(need("SPARKPLUG_EMQX_PORT")), need("SPARKPLUG_EMQX"), image)],
];
const texts = captures.map(
  ([directory, broker, captured]) =>
    [directory, `${JSON.stringify({ capturedAt, brokers: { [broker]: captured } }, null, 2)}\n`] as const,
);
const held = SEEDED.filter((name) => texts.some(([, text]) => text.includes(name)));
if (held.length > 0) throw new Error(`sparkplug-agent-boundary: the capture holds ${held.length} seeded names`);
for (const [directory, text] of texts) {
  writeFileSync(path.join(need("SPARKPLUG_OUT"), directory, "agent-boundary", "boundary.json"), text);
}
process.stdout.write("sparkplug-agent-boundary: boundary.json written for each broker\n");
