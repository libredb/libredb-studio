/**
 * Captures the MQTT agent path's boundary on the pinned brokers into `boundary.json`, for `docs/providers/mqtt.md`
 * section 14. Run by `tests/fixtures/mqtt/mosquitto-2.1.2/agent-boundary/run.sh`, which starts a Mosquitto 2.1.2
 * broker with authentication on (a user that may only read, and one that may read and write) and a stock EMQX 5.8.9,
 * makes the credentials for the run, takes the raw `$SYS` reads, and removes everything after.
 *
 * What it records:
 *   reads             what each admitted agent read answered through a real `MqttProvider` on the agent profile, and
 *                     every packet each of its sessions wrote, read from the bytes through a recording socket;
 *   refusedBeforeSend each refused agent request, by what it is, with its refusal's opening words and how many
 *                     sessions it opened (0);
 *   rawRefused        what two filters agent mode refuses answer when THIS script sends them raw, with the provider's
 *                     own session (a wildcard below the root) and with the broker's own client (a shared subscription);
 *   rawPublish        what a raw PUBLISH with the agent's credentials and with the writer's does, sent by the broker's
 *                     own client and never by Studio;
 *   sys               what each broker's `$SYS` tree carries: whether any topic name or payload holds a connected
 *                     client's id, user name or an address;
 *   state             the broker's retained set before and after the agent reads.
 *
 * The capture records no credential, not even its name, no topic name the fixture seeded and no payload: an answer is
 * recorded as its figures and as whether it carried any of them. Each is checked before the file is written.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import path from "node:path";
import { MqttProvider } from "@/lib/db/providers/keyvalue/mqtt/index";
import { type MqttTransport, type MqttTransportFactory, readTopics } from "@/lib/db/providers/keyvalue/mqtt/session";
import type { QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set; run this through run.sh`);
  return value;
};

const PORT = Number(required("MQTT_PORT"));
const EMQX_PORT = Number(required("MQTT_EMQX_PORT"));
const BROKER = required("MQTT_BROKER");
const WORK = required("MQTT_WORK");
const OUT = required("MQTT_OUT");
const AGENT_USER = required("MQTT_AGENT_USER");
const AGENT_SECRET = required("MQTT_AGENT_SECRET");
const WRITER_USER = required("MQTT_WRITER_USER");
const WRITER_SECRET = required("MQTT_WRITER_SECRET");
const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 10_000, maxResultRows: 200, maxResultBytes: 1_000_000 };

/** The retained topics the fixture seeds; their names stand for people and devices and must reach no answer. */
const SEEDED = [
  ["homes/ayse-yilmaz/door", "door-payload-open"],
  ["people/alice/heart-rate", "heart-payload-71"],
  ["factory/press-7/temp", "temp-payload-21"],
  ["factory/press-7/state", "state-payload-run"],
] as const;
/** A topic a publisher writes to live, never retained. */
const LIVE = "factory/press-7/rpm";
/** The connected device's client id and the user name the EMQX device connects with. */
const DEVICE_ID = "device-ayse-yilmaz-01";
const DEVICE_USER = "device-user-ayse";
const WITHHELD = [...SEEDED.flat(), LIVE, "ayse", "alice", "press-7", DEVICE_ID, DEVICE_USER];
const SECRETS = [AGENT_USER, AGENT_SECRET, WRITER_USER, WRITER_SECRET];

/** A docker call's output; a client that ends on its own timeout exits non-zero, and its output is still the answer. */
const docker = (...args: string[]): string => {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout === "string") return stdout;
    throw error;
  }
};
const publish = (args: string[]): { readonly exitCode: number } => {
  try {
    execFileSync("docker", ["exec", BROKER, "mosquitto_pub", ...args], { stdio: "ignore" });
    return { exitCode: 0 };
  } catch (error) {
    return { exitCode: (error as { status?: number }).status ?? -1 };
  }
};
const asWriter = ["-u", WRITER_USER, "-P", WRITER_SECRET];
const asAgent = ["-u", AGENT_USER, "-P", AGENT_SECRET];

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Every packet one session wrote: its type, and for a SUBSCRIBE its filters and options. */
interface SessionLog {
  readonly packets: Buffer[];
}
const sessions: SessionLog[] = [];

/** A plain TCP transport to the loopback broker that records every packet written to it. */
const recording =
  (port: number): MqttTransportFactory =>
  () => {
    const socket = netConnect({ host: "127.0.0.1", port });
    const log: SessionLog = { packets: [] };
    sessions.push(log);
    const write = socket.write.bind(socket);
    (socket as unknown as MqttTransport).write = (bytes: Buffer) => {
      log.packets.push(Buffer.from(bytes));
      write(bytes);
    };
    return { transport: socket as unknown as MqttTransport, readyEvent: "connect" };
  };

/** A SUBSCRIBE's filters and their options bytes. */
function subscription(bytes: Buffer): { readonly filters: string[]; readonly options: number[] } {
  let at = 1;
  while ((bytes[at] as number) & 0x80) at += 1;
  at += 3;
  at += 1 + (bytes[at] as number);
  const filters: string[] = [];
  const options: number[] = [];
  while (at < bytes.length) {
    const length = bytes.readUInt16BE(at);
    filters.push(bytes.subarray(at + 2, at + 2 + length).toString("utf8"));
    options.push(bytes[at + 2 + length] as number);
    at += 3 + length;
  }
  return { filters, options };
}

/** What a session wrote, with a filter recorded as `#`, as the requested topic, or as something else. */
function described(log: SessionLog, requested?: string) {
  return log.packets.map((bytes) => {
    const type = (bytes[0] as number) >> 4;
    if (type === 1) {
      const nameLength = bytes.readUInt16BE(2);
      const flags = bytes[2 + 2 + nameLength + 1] as number;
      const properties = [
        ...bytes.subarray(2 + 2 + nameLength + 5, 2 + 2 + nameLength + 5 + (bytes[2 + 2 + nameLength + 4] as number)),
      ];
      return {
        packet: "CONNECT",
        cleanStart: (flags & 0x02) !== 0,
        will: (flags & 0x3c) !== 0,
        sessionExpiryZero: properties.join(",") === "17,0,0,0,0",
      };
    }
    if (type === 8) {
      const { filters, options } = subscription(bytes);
      return {
        packet: "SUBSCRIBE",
        filters: filters.map((filter) =>
          filter === "#" ? "#" : filter === requested ? "<the requested topic>" : "<other>",
        ),
        options,
      };
    }
    return { packet: ({ 12: "PINGREQ", 14: "DISCONNECT" } as Record<number, string>)[type] ?? `type ${type}` };
  });
}

const carries = (text: string, words: readonly string[]) => words.some((word) => text.includes(word));
const answerText = (result: QueryResult) => JSON.stringify({ f: result.fields, r: result.rows, w: result.warnings });

function provider(port: number, credentials: boolean): MqttProvider {
  const connection = {
    id: "mqtt-agent-boundary",
    name: "mqtt agent boundary",
    type: "mqtt",
    host: "127.0.0.1",
    port,
    ...(credentials ? { user: AGENT_USER, password: AGENT_SECRET } : {}),
  } as DatabaseConnection;
  return new MqttProvider(connection, {}, { readOnly: true, sendsStatements: true }, recording(port));
}

async function read(target: MqttProvider, statement: string, requested?: string) {
  const before = sessions.length;
  const result = await target.queryReadOnly(statement, BUDGET);
  return {
    fields: result.fields,
    rows: result.rows,
    warnings: (result.warnings ?? []).map((warning) => warning.message),
    carriesWithheld: carries(answerText(result), WITHHELD),
    carriesCredential: carries(answerText(result), SECRETS),
    sent: sessions.slice(before).map((log) => described(log, requested)),
  };
}

/** The retained set, read raw with the writer's credentials: how many, and a digest of every topic and payload. */
function retained(): { readonly count: number; readonly sha256: string } {
  const lines = docker("exec", BROKER, "mosquitto_sub", ...asWriter, "-v", "-t", "#", "--retained-only", "-W", "2")
    .split("\n")
    .filter((line) => line !== "")
    .sort();
  return { count: lines.length, sha256: sha(lines.join("\n")) };
}

/**
 * The broker's state an agent read could change: its retained set. A session left behind is ruled out by the CONNECT
 * itself (Clean Start and a zero Session Expiry Interval, recorded in `sent`): Mosquitto's own `$SYS` client counters
 * move with the fixture's live publisher and were measured to underflow, so they are not read as evidence here.
 */
function state() {
  return { retained: retained() };
}

const IPV4 = /(?:^|[^0-9])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?:$|[^0-9])/;

/** What a raw `$SYS` read carried, as counts and as whether it held a client's id, user name or an address. */
function sysSummary(file: string, users: readonly string[]) {
  const lines = readFileSync(path.join(WORK, file), "utf8")
    .split("\n")
    .filter((line) => line !== "");
  const topics = new Set(lines.map((line) => line.split(" ", 1)[0] as string));
  const topicText = [...topics].join("\n");
  return {
    messages: lines.length,
    distinctTopics: topics.size,
    topicNamesCarryClientId: topicText.includes(DEVICE_ID),
    payloadsCarryClientId: lines.some((line) => line.slice(line.indexOf(" ") + 1).includes(DEVICE_ID)),
    carryUserName: carries(lines.join("\n"), users),
    carryAnAddress: lines.some((line) => IPV4.test(line)),
  };
}

const firstSentence = (message: string): string => /^[\s\S]*?\.(?=\s|$)/.exec(message)?.[0] ?? message;

async function main(): Promise<void> {
  for (const [topic, payload] of SEEDED) publish([...asWriter, "-r", "-t", topic, "-m", payload]);
  // A live publisher, never retained, for the whole run.
  docker(
    "exec",
    "-d",
    BROKER,
    "sh",
    "-c",
    `while :; do mosquitto_pub -u '${WRITER_USER}' -P '${WRITER_SECRET}' -t '${LIVE}' -m 1200; sleep 0.2; done`,
  );
  const before = state();

  const agent = provider(PORT, true);
  const connectBefore = sessions.length;
  await agent.connect();
  const connect = sessions.slice(connectBefore).map((log) => described(log));

  const reads = {
    window: await read(agent, '{"read": "window"}'),
    topicSeenRetained: await read(agent, JSON.stringify({ read: "topic", topic: SEEDED[0][0] }), SEEDED[0][0]),
    topicSeenLive: await read(agent, JSON.stringify({ read: "topic", topic: LIVE }), LIVE),
    topicNotSeen: await read(agent, '{"read": "topic", "topic": "homes/nobody-here/door"}', "homes/nobody-here/door"),
  };

  const refusedRequests: readonly (readonly [string, string])[] = [
    ["a publish", '{"read": "publish", "topic": "homes/ayse-yilmaz/door"}'],
    ["a will", '{"read": "window", "will": {"topic": "homes/ayse-yilmaz/door", "payload": "x"}}'],
    ["a wildcard below the root", '{"read": "topic", "topic": "homes/+/door"}'],
    ["a multi-level wildcard below the root", '{"read": "topic", "topic": "homes/#"}'],
    ["a shared subscription", '{"read": "topic", "topic": "$share/g/factory/#"}'],
    ["a $SYS topic", '{"read": "topic", "topic": "$SYS/broker/clients/connected"}'],
    ["a filter of its own", '{"read": "window", "filter": "homes/#"}'],
    ["a subscription option", '{"read": "topic", "topic": "factory/press-7/temp", "retainHandling": 2}'],
  ];
  const refusedBeforeSend = [];
  for (const [what, statement] of refusedRequests) {
    const opened = sessions.length;
    const message = await agent.queryReadOnly(statement, BUDGET).then(
      () => "admitted",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    refusedBeforeSend.push({
      request: what,
      refusal: firstSentence(message),
      carriesWithheld: carries(message, WITHHELD),
      sessionsOpened: sessions.length - opened,
    });
  }

  const after = state();

  // Sent by this script, never by agent mode: what the refused filters answer raw.
  const wildcard = await readTopics({
    host: "127.0.0.1",
    port: PORT,
    tls: false,
    user: AGENT_USER,
    password: AGENT_SECRET,
    filter: "homes/+/door",
  });
  const sharedLines = docker("exec", BROKER, "mosquitto_sub", ...asAgent, "-t", "$share/g/factory/#", "-W", "2")
    .split("\n")
    .filter((line) => line !== "").length;
  const rawRefused = {
    wildcardBelowRoot: {
      topicsSeen: wildcard.topics.size,
      namesASeededTopic: [...wildcard.topics.keys()].some((topic) => carries(topic, WITHHELD)),
    },
    sharedSubscription: { messagesTakenIn2s: sharedLines },
  };

  // Sent by this script with the broker's own client, never by Studio.
  const target = SEEDED[0][0];
  const beforeRaw = retained();
  const agentPublish = publish([...asAgent, "-q", "1", "-r", "-t", target, "-m", "CHANGED"]);
  const afterAgentPublish = retained();
  const writerPublish = publish([...asWriter, "-q", "1", "-r", "-t", "raw/probe", "-m", "x"]);
  const afterWriterPublish = retained();
  publish([...asWriter, "-r", "-t", "raw/probe", "-n"]);
  const rawPublish = {
    asAgent: { exitCode: agentPublish.exitCode, retainedChanged: afterAgentPublish.sha256 !== beforeRaw.sha256 },
    asWriter: {
      exitCode: writerPublish.exitCode,
      retainedChanged: afterWriterPublish.sha256 !== afterAgentPublish.sha256,
    },
  };

  // EMQX, stock and anonymous: the window and one topic.
  docker(
    "run",
    "--rm",
    "--network",
    "container:pr320-agent-emqx",
    "--entrypoint",
    "mosquitto_pub",
    "eclipse-mosquitto:2.1.2-alpine@sha256:860aeb5d63ce509508f6dcfb2bc8a1c1dd2bc60555b562b45ce90e52d8dabb0f",
    "-h",
    "127.0.0.1",
    "-r",
    "-t",
    "factory/press-7/temp",
    "-m",
    "temp-payload-21",
  );
  const emqx = provider(EMQX_PORT, false);
  await emqx.connect();
  const emqxReads = {
    window: await read(emqx, '{"read": "window"}'),
    topicSeenRetained: await read(emqx, '{"read": "topic", "topic": "factory/press-7/temp"}', "factory/press-7/temp"),
  };

  const capture = {
    brokers: {
      mosquitto:
        "eclipse-mosquitto:2.1.2-alpine@sha256:860aeb5d63ce509508f6dcfb2bc8a1c1dd2bc60555b562b45ce90e52d8dabb0f",
      emqx: "emqx/emqx:5.8.9@sha256:35b46f7aa7a0d51f3959e4344221ac5ec7f948b03e43099286b6c40a07bb393b",
    },
    budget: BUDGET,
    connect,
    reads,
    refusedBeforeSend,
    rawRefused,
    rawPublish,
    sys: {
      mosquitto: sysSummary("mosquitto-sys.txt", [WRITER_USER]),
      emqx: sysSummary("emqx-sys.txt", [DEVICE_USER]),
    },
    // The retained set's digest is compared here and not recorded: a hex digest reads as a secret to a scanner.
    state: {
      retainedBefore: before.retained.count,
      retainedAfter: after.retained.count,
      retainedUnchanged: before.retained.sha256 === after.retained.sha256,
    },
    emqx: emqxReads,
  };

  const text = `${JSON.stringify(capture, null, 2)}\n`;
  // The capture's own words name what it checks, so the checks read only the recorded answers and figures.
  for (const secret of SECRETS) if (text.includes(secret)) throw new Error("the capture carries a credential");
  for (const word of WITHHELD)
    if (text.includes(word)) throw new Error("the capture carries a seeded topic, payload or client");
  if (/password|passwd|secret/i.test(text)) throw new Error("the capture carries a credential-shaped key");
  writeFileSync(path.join(OUT, "boundary.json"), text);
  await agent.disconnect();
  await emqx.disconnect();
}

await main();
