/**
 * The Sparkplug provider's agent path end to end, from the request text to the projected answer, over the session's
 * own transport seam: the closed table's reads, the counts they answer, the ids they never name, the refusals made
 * before anything is sent, the failures worded by their kind, and every other surface of an agent-mode handle
 * answering its reason.
 */
import { describe, expect, test } from "bun:test";
import { QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import {
  SPARKPLUG_COMPLETENESS,
  SPARKPLUG_EXACT_LAST_MESSAGE,
  SPARKPLUG_METADATA_ONLY,
  sparkplugAgentFilters,
} from "@/lib/db/providers/industrial/sparkplug/agent-read";
import { SPARKPLUG_AGENT_SENTENCES } from "@/lib/db/providers/industrial/sparkplug/agent-statement";
import { SPARKPLUG_AGENT_WITHHELD } from "@/lib/db/providers/industrial/sparkplug/agent-surface";
import {
  dialAndRead,
  SparkplugProvider,
  type SparkplugReadOutcome,
  type SparkplugReader,
} from "@/lib/db/providers/industrial/sparkplug/index";
import { ReadState } from "@/lib/db/providers/industrial/sparkplug/state";
import type { ProviderExecutionContext } from "@/lib/db/types";
import {
  AGENT_PROFILE,
  BUDGET,
  CONNACK,
  connection,
  metric,
  payload,
  publish,
  scripted,
  scriptedProvider,
  subscribedFilters,
  UNDECODABLE,
} from "./fake-plant";

/** Ids the plant script carries, none of which may reach an answer. */
const IDS = ["Plant-North", "Line-7", "Press-3", "Pump-9", "host-scada", "Temperature", "Pressure"];

const PLANT = [
  ...CONNACK,
  ...publish("spBv1.0/STATE/host-scada", [...new TextEncoder().encode('{"online":true,"timestamp":1}')]),
  ...publish("spBv1.0/Plant-North/NBIRTH/Line-7", payload(metric("bdSeq", 0), metric("Temperature", 21))),
  ...publish("spBv1.0/Plant-North/DBIRTH/Line-7/Press-3", payload(metric("Pressure", 4), metric("Temperature", 3))),
  ...publish("spBv1.0/Plant-North/DDATA/Line-7/Press-3", payload(metric("Pressure", 5))),
  ...publish("spBv1.0/Plant-North/NDATA/Line-7", payload(metric("Temperature", 22))),
  ...publish("spBv1.0/Plant-North/DDATA/Line-7/Pump-9", UNDECODABLE),
  ...publish("spBv1.0/Plant-North/NCMD/Line-7", payload(metric("Node Control/Rebirth", 1))),
  ...publish("spBv1.0/Plant-South/NDEATH/Line-7", payload(metric("bdSeq", 0))),
];

async function opened(reads: readonly (readonly number[])[], over = {}, execution = AGENT_PROFILE) {
  const built = scriptedProvider(reads, execution, over);
  await built.provider.connect();
  return built;
}

function holdsNoId(value: unknown): void {
  const text = JSON.stringify(value);
  for (const id of IDS) expect(text).not.toContain(id);
}

describe("only a handle opened under the agent read-only profile reads", () => {
  test.each([
    ["an editor handle", {}],
    ["an operations handle, which sends no statement", { readOnly: true }],
  ] as const)("%s refuses before anything is sent", async (_name, execution: ProviderExecutionContext) => {
    const { provider, requests } = scriptedProvider([PLANT], execution);
    await expect(provider.queryReadOnly('{"read": "window"}', BUDGET)).rejects.toThrow(
      new RefusedBeforeSendError(
        "Read-only execution requires a provider opened under the agent read-only profile",
        "sparkplug",
      ),
    );
    expect(requests).toHaveLength(0);
  });

  test("an agent handle not yet connected is refused by the connection check", async () => {
    const { provider } = scriptedProvider([PLANT]);
    await expect(provider.queryReadOnly('{"read": "window"}', BUDGET)).rejects.toThrow("Provider is not connected");
  });

  test("connecting an agent handle is a handshake: CONNECT and DISCONNECT, no subscription, nothing kept", async () => {
    const { sessions, requests } = await opened([]);
    expect(sessions[0]?.map((packet) => packet[0])).toEqual([0x10, 0xe0]);
    expect(requests[0]?.handshakeOnly).toBe(true);
  });

  test("a disconnected agent handle reads no more", async () => {
    const { provider } = await opened([PLANT]);
    await provider.disconnect();
    await expect(provider.queryReadOnly('{"read": "window"}', BUDGET)).rejects.toThrow("Provider is not connected");
  });
});

describe("the window read", () => {
  test("answers the whole namespace's totals, and no id, metric name or value", async () => {
    const { provider, sessions } = await opened([PLANT]);
    const result = await provider.queryReadOnly('{"read": "window"}', BUDGET);
    expect(subscribedFilters(sessions[1] ?? [])).toEqual(["spBv1.0/#"]);
    expect(result.fields).toEqual(SPARKPLUG_METADATA_ONLY.window?.map((one) => one.column));
    expect(result.rows).toEqual([
      {
        window_ms: expect.any(Number),
        listened_ms: expect.any(Number),
        stop_reason: "broker-closed",
        scope: "window",
        broker_reason_code: null,
        subscriptions_refused: 0,
        groups_seen: 2,
        edge_nodes_seen: 2,
        devices_seen: 2,
        messages: 8,
        nbirth: 1,
        ndeath: 1,
        ndata: 1,
        dbirth: 1,
        ddeath: 0,
        ddata: 2,
        other_messages: 2,
        // Two in the NBIRTH, two in the DBIRTH, one in each data message read; a death's bdSeq is not counted.
        metrics: 6,
        payload_bytes: expect.any(Number),
        messages_not_decodable: 1,
        payloads_not_kept: 0,
      },
    ]);
    holdsNoId(result);
    const warnings = result.warnings?.map((one) => one.message) ?? [];
    expect(warnings[0]).toContain("the whole spBv1.0 namespace");
    expect(warnings[0]).toContain("It counted 8 messages from 2 groups, 2 edge nodes and 2 devices.");
    expect(warnings).toContain(
      "1 payload could not be read as Sparkplug B and 0 payloads came past Studio's byte budget, so their metrics are not counted; their messages are.",
    );
    expect(warnings.at(-1)).toBe(SPARKPLUG_COMPLETENESS);
    expect(warnings).not.toContain(SPARKPLUG_EXACT_LAST_MESSAGE);
  });

  test("on a connection that names a group, listens to that group alone", async () => {
    const { provider, sessions } = await opened([CONNACK], { database: "Plant-North" });
    const result = await provider.queryReadOnly('{"read": "window"}', BUDGET);
    expect(subscribedFilters(sessions[1] ?? [])).toEqual(["spBv1.0/Plant-North/#"]);
    expect(result.warnings?.[0]?.message).toContain("every message of the one group this connection names");
    expect(result.warnings?.[0]?.message).toContain("It counted 0 messages from 0 groups, 0 edge nodes and 0 devices.");
    holdsNoId(result);
  });
});

describe("the exact reads", () => {
  test("a group: its own messages by type, seen, birth seen, and the id not echoed", async () => {
    const { provider, sessions } = await opened([PLANT]);
    const result = await provider.queryReadOnly('{"read": "group", "group": "Plant-North"}', BUDGET);
    expect(subscribedFilters(sessions[1] ?? [])).toEqual(["spBv1.0/Plant-North/#"]);
    expect(result.rows[0]).toMatchObject({
      seen: true,
      messages: 5,
      nbirth: 1,
      ndeath: 0,
      ndata: 1,
      dbirth: 1,
      ddeath: 0,
      ddata: 2,
      birth_seen: true,
      death_seen: false,
      last_seen_ms: expect.any(Number),
      metrics: 6,
      messages_not_decodable: 1,
    });
    expect(result.fields).toEqual(SPARKPLUG_METADATA_ONLY.group?.map((one) => one.column));
    holdsNoId(result);
    const warnings = result.warnings?.map((one) => one.message) ?? [];
    expect(warnings[0]).toContain("the one group the request named");
    expect(warnings[0]).toContain("It counted 5 messages from it.");
    expect(warnings).toContain(SPARKPLUG_EXACT_LAST_MESSAGE);
    expect(warnings.at(-1)).toBe(SPARKPLUG_COMPLETENESS);
  });

  test("an edge node: its own three topics written in full, device counts null, a death seen", async () => {
    const { provider, sessions } = await opened([PLANT]);
    const result = await provider.queryReadOnly(
      '{"read": "edgeNode", "group": "Plant-South", "edgeNode": "Line-7"}',
      BUDGET,
    );
    expect(subscribedFilters(sessions[1] ?? [])).toEqual([
      "spBv1.0/Plant-South/NBIRTH/Line-7",
      "spBv1.0/Plant-South/NDEATH/Line-7",
      "spBv1.0/Plant-South/NDATA/Line-7",
    ]);
    // The script plays the whole plant whatever the filter; only the named edge node's own topics are counted.
    expect(result.rows[0]).toMatchObject({
      seen: true,
      messages: 1,
      nbirth: 0,
      ndeath: 1,
      ndata: 0,
      dbirth: null,
      ddeath: null,
      ddata: null,
      birth_seen: false,
      death_seen: true,
      metrics: 0,
    });
    expect(result.warnings?.[0]?.message).toContain("the one edge node the request named");
    holdsNoId(result);
  });

  test("a device: its own three topics, node counts null", async () => {
    const { provider, sessions } = await opened([PLANT]);
    const result = await provider.queryReadOnly(
      '{"read": "device", "group": "Plant-North", "edgeNode": "Line-7", "device": "Press-3"}',
      BUDGET,
    );
    expect(subscribedFilters(sessions[1] ?? [])).toEqual([
      "spBv1.0/Plant-North/DBIRTH/Line-7/Press-3",
      "spBv1.0/Plant-North/DDEATH/Line-7/Press-3",
      "spBv1.0/Plant-North/DDATA/Line-7/Press-3",
    ]);
    expect(result.rows[0]).toMatchObject({
      seen: true,
      messages: 2,
      nbirth: null,
      dbirth: 1,
      ddata: 1,
      metrics: 3,
      birth_seen: true,
    });
    expect(result.warnings?.[0]?.message).toContain("the one device the request named");
    holdsNoId(result);
  });

  test("an edge node read counts the node's own messages, never its devices', even when they arrive", async () => {
    const { provider } = await opened([PLANT]);
    const result = await provider.queryReadOnly(
      '{"read": "edgeNode", "group": "Plant-North", "edgeNode": "Line-7"}',
      BUDGET,
    );
    expect(result.rows[0]).toMatchObject({ messages: 2, nbirth: 1, ndata: 1, dbirth: null, ddata: null, metrics: 3 });
  });

  test("an id not seen answers the same columns with seen false and no last message, never that it does not exist", async () => {
    const { provider } = await opened([PLANT, PLANT]);
    const hit = await provider.queryReadOnly('{"read": "group", "group": "Plant-North"}', BUDGET);
    const miss = await provider.queryReadOnly('{"read": "group", "group": "Plant-East"}', BUDGET);
    expect(miss.fields).toEqual(hit.fields);
    expect(miss.rows[0]).toMatchObject({ seen: false, messages: 0, last_seen_ms: null, birth_seen: false });
    const warnings = miss.warnings?.map((one) => one.message) ?? [];
    expect(warnings).toContain(SPARKPLUG_EXACT_LAST_MESSAGE);
    expect(warnings.at(-1)).toBe(SPARKPLUG_COMPLETENESS);
    expect(JSON.stringify(miss)).not.toContain("Plant-East");
  });
});

describe("refused before anything is sent", () => {
  test("a request outside the closed table opens no session", async () => {
    const { provider, requests } = await opened([PLANT]);
    for (const text of [
      '{"read": "group", "group": "Plant-#"}',
      '{"read": "window", "topic": "$sparkplug/certificates/#"}',
      '{"read": "NCMD", "group": "G", "edgeNode": "E"}',
      '{"read": "group", "group": "STATE"}',
    ]) {
      await expect(provider.queryReadOnly(text, BUDGET)).rejects.toBeInstanceOf(RefusedBeforeSendError);
    }
    await expect(provider.queryReadOnly('{"read": "group", "group": "+"}', BUDGET)).rejects.toThrow(
      SPARKPLUG_AGENT_SENTENCES.wildcard,
    );
    expect(requests).toHaveLength(1);
  });

  test("a time budget that cannot hold the window is refused rather than shortened", async () => {
    const { provider, requests } = await opened([PLANT]);
    await expect(
      provider.queryReadOnly('{"read": "window"}', { ...BUDGET, statementTimeoutMs: 3_999 }),
    ).rejects.toThrow(
      "Read-only execution exceeded the time budget: a Sparkplug agent read listens for a 3,000 ms window and needs at least 4,000 ms, and this read was given 3,999 ms. A window is never shortened, so nothing was sent.",
    );
    expect(requests).toHaveLength(1);
  });

  test("an estimate is refused, since Sparkplug composes no plan", async () => {
    const { provider } = await opened([PLANT]);
    await expect(provider.queryReadOnly('{"read": "window"}', BUDGET, "estimate-plan")).rejects.toThrow(
      "Sparkplug composes no estimating plan for the agent",
    );
  });

  test("a group other than the one the connection names is refused alike, seen or not", async () => {
    const { provider, requests } = await opened([PLANT], { database: "Plant-North" });
    const other = provider.queryReadOnly('{"read": "group", "group": "Plant-South"}', BUDGET).catch((e) => e);
    const absent = provider.queryReadOnly('{"read": "group", "group": "Plant-None"}', BUDGET).catch((e) => e);
    const [one, two] = await Promise.all([other, absent]);
    expect(one).toBeInstanceOf(RefusedBeforeSendError);
    expect((one as Error).message).toBe((two as Error).message);
    expect((one as Error).message).not.toContain("Plant");
    expect(requests).toHaveLength(1);
    const own = await provider.queryReadOnly('{"read": "group", "group": "Plant-North"}', BUDGET);
    expect(own.rows[0]?.seen).toBe(true);
  });
});

/** A provider whose reads answer `outcome` as given, past a CONNACK-accepting connect. */
async function answering(outcome: Partial<SparkplugReadOutcome> | (() => Promise<SparkplugReadOutcome>)) {
  let calls = 0;
  const reader: SparkplugReader = async () => {
    calls++;
    if (calls === 1) return { state: new ReadState(), endReason: "handshake", messagesSeen: 0, bytesSeen: 0 };
    if (typeof outcome === "function") return outcome();
    return { state: new ReadState(), endReason: "time-budget", messagesSeen: 0, bytesSeen: 0, ...outcome };
  };
  const provider = new SparkplugProvider(connection(), {}, AGENT_PROFILE, reader);
  await provider.connect();
  return provider;
}

describe("a failure is worded by its kind, never in the broker's or the transport's words", () => {
  test.each([
    [{ endReason: "dial-failed", transportErrorCode: "ECONNREFUSED" }, "The broker could not be reached for the read."],
    [
      { endReason: "dial-failed", transportErrorCode: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
      "The broker presented a certificate Studio does not trust for this connection",
    ],
    [{ endReason: "dial-failed" }, "The broker could not be reached for the read."],
    [
      { endReason: "connect-refused", refusalCode: 0x87 },
      "The broker refused the connection with reason code 135 (0x87), so nothing was read",
    ],
    [{ endReason: "connect-refused" }, "The broker refused the connection, so nothing was read"],
    [{ endReason: "time-budget", handshook: false }, "did not complete the MQTT 5.0 handshake"],
    [{ endReason: "frame-refused" }, "could not be read as MQTT 5.0"],
  ] as const)("%o", async (outcome, words) => {
    const provider = await answering(outcome);
    const error = await provider.queryReadOnly('{"read": "window"}', BUDGET).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toContain(words);
    expect((error as Error).message).toContain("not passed on to agent mode");
    expect((error as Error).message).not.toContain("broker.example");
  });

  test("a refused subscription is answered with its stop reason and the broker's code", async () => {
    const provider = await answering({
      endReason: "subscription-refused",
      refusalCode: 0x87,
      elapsedMs: 40,
      subscribedAtMs: 1,
    });
    const result = await provider.queryReadOnly('{"read": "window"}', BUDGET);
    expect(result.rows[0]).toMatchObject({ stop_reason: "subscription-refused", broker_reason_code: 135 });
    expect(result.warnings?.[0]?.message).toContain(
      "stopped because the broker refused every subscription with reason code 135 (0x87), so nothing was read.",
    );
    const bare = await answering({ endReason: "subscription-refused" });
    expect((await bare.queryReadOnly('{"read": "window"}', BUDGET)).warnings?.[0]?.message).toContain(
      "stopped because the broker refused every subscription, so nothing was read.",
    );
  });

  test.each([
    ["time-budget", "the window ended"],
    ["message-budget", "Studio's message budget of 50,000 messages was reached before the window ended"],
    ["byte-budget", "Studio's byte budget of 67,108,864 bytes was reached before the window ended"],
    ["broker-closed", "the broker closed the connection before the window ended"],
    [
      "wildcards-unavailable",
      "the broker said when the connection opened that it takes no wildcard subscription, so nothing was read",
    ],
  ])("the stop reason %s is said in agent mode's words", async (endReason, words) => {
    const provider = await answering({ endReason, elapsedMs: 3_000, subscribedAtMs: 20 });
    const result = await provider.queryReadOnly('{"read": "window"}', BUDGET);
    expect(result.rows[0]).toMatchObject({ stop_reason: endReason, window_ms: 3_000, listened_ms: 2_980 });
    expect(result.warnings?.[0]?.message).toContain(`stopped because ${words}.`);
  });

  test("a partly refused subscription is said, and a payload past the byte budget is counted, not dropped", async () => {
    const provider = await answering({
      subscriptionsRefused: 2,
      messages: [{ topic: "spBv1.0/G/NDATA/E", payloadBytes: 40, receivedAt: 5 }],
    });
    const result = await provider.queryReadOnly('{"read": "window"}', BUDGET);
    expect(result.rows[0]).toMatchObject({ subscriptions_refused: 2, ndata: 1, payloads_not_kept: 1, metrics: 0 });
    const warnings = result.warnings?.map((one) => one.message) ?? [];
    expect(warnings).toContain(
      "The broker refused 2 subscriptions of this read and granted the rest, so the read heard less than it asked for and its counts are lower bounds.",
    );
    expect(warnings).toContain(
      "0 payloads could not be read as Sparkplug B and 1 payload came past Studio's byte budget, so their metrics are not counted; their messages are.",
    );
  });

  test("one refused subscription of an edge node read's three is said as a lower bound", async () => {
    const provider = await answering({ subscriptionsRefused: 1 });
    const result = await provider.queryReadOnly('{"read": "edgeNode", "group": "G", "edgeNode": "E"}', BUDGET);
    expect(result.rows[0]).toMatchObject({ subscriptions_refused: 1 });
    expect(result.warnings?.map((one) => one.message)).toContain(
      "The broker refused 1 subscription of this read and granted the rest, so the read heard less than it asked for and its counts are lower bounds.",
    );
  });

  test("a stored certificate a broker delivers on an exact read is not the object's message and is not counted", async () => {
    const provider = await answering({
      messages: [{ topic: "$sparkplug/certificates/spBv1.0/G/NBIRTH/E", payloadBytes: 40, receivedAt: 5 }],
    });
    const result = await provider.queryReadOnly('{"read": "edgeNode", "group": "G", "edgeNode": "E"}', BUDGET);
    expect(result.rows[0]).toMatchObject({ seen: false, messages: 0, nbirth: 0, birth_seen: false });
  });

  test("last_seen_ms is the last message's arrival, counted from the subscription", async () => {
    const provider = await answering({
      startedAt: 1_000,
      subscribedAtMs: 100,
      elapsedMs: 3_000,
      messages: [
        { topic: "spBv1.0/G/NDATA/E", payloadBytes: 0, receivedAt: 1_300 },
        { topic: "spBv1.0/G/NDATA/E", payloadBytes: 0, receivedAt: 1_500 },
      ],
    });
    const result = await provider.queryReadOnly('{"read": "edgeNode", "group": "G", "edgeNode": "E"}', BUDGET);
    expect(result.rows[0]).toMatchObject({ last_seen_ms: 400, messages: 2 });
  });

  test("a read past the deadline is the time budget, and its late answer is dropped", async () => {
    const provider = await answering(() => new Promise<never>(() => undefined));
    const pending = provider.queryReadOnly('{"read": "window"}', { ...BUDGET, statementTimeoutMs: 4_000 });
    const error = await pending.catch((e: unknown) => e);
    expect((error as Error).message).toBe("Read-only execution exceeded the time budget: no answer within 4000ms");
  });

  test("a late rejection after the deadline is observed, not unhandled", async () => {
    const provider = await answering(
      () => new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("late")), 4_100)),
    );
    const error = await provider
      .queryReadOnly('{"read": "window"}', { ...BUDGET, statementTimeoutMs: 4_000 })
      .catch((e: unknown) => e);
    expect((error as Error).message).toContain("no answer within 4000ms");
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  test("an answer past the byte budget is refused, never cut", async () => {
    const provider = await answering({});
    const error = await provider
      .queryReadOnly('{"read": "window"}', { ...BUDGET, maxResultBytes: 10 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toContain("10");
  });

  test("a cell that does not fit its kind withholds the answer, naming the column and never the value", async () => {
    const provider = await answering({ elapsedMs: 5, subscribedAtMs: 10 });
    const error = await provider.queryReadOnly('{"read": "window"}', BUDGET).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toContain('"listened_ms"');
  });

  test("an error the agent path does not word is passed on as it is", async () => {
    const own = new Error("a defect of ours");
    const provider = await answering(() => Promise.reject(own));
    await expect(provider.queryReadOnly('{"read": "window"}', BUDGET)).rejects.toBe(own);
  });
});

describe("every other surface of an agent-mode handle answers its reason", () => {
  test("an agent-mode handle declares no level and no kind for the grounding walk, and the editor's keeps the tree", () => {
    for (const execution of [AGENT_PROFILE, { readOnly: true }]) {
      const declared = new SparkplugProvider(connection(), {}, execution).getCapabilities();
      expect(declared.containerLevels).toEqual([]);
      expect(declared.objectKinds).toEqual([]);
      expect(declared.metadataOnly).toBe(SPARKPLUG_METADATA_ONLY);
    }
    const editor = new SparkplugProvider(connection()).getCapabilities();
    expect(editor.containerLevels?.length).toBe(2);
    expect(editor.objectKinds?.map((kind) => kind.id)).toEqual(["node", "device"]);
  });

  test.each([
    ["listContainers", (p: SparkplugProvider) => p.listContainers([]), SPARKPLUG_AGENT_WITHHELD.tree],
    ["countObjects", (p: SparkplugProvider) => p.countObjects([]), SPARKPLUG_AGENT_WITHHELD.tree],
    ["listObjects", (p: SparkplugProvider) => p.listObjects([], "edge-node"), SPARKPLUG_AGENT_WITHHELD.tree],
    ["describeObject", (p: SparkplugProvider) => p.describeObject(["G"], "edge-node"), SPARKPLUG_AGENT_WITHHELD.tree],
    ["describeObjects", (p: SparkplugProvider) => p.describeObjects([], "edge-node"), SPARKPLUG_AGENT_WITHHELD.tree],
    [
      "readObjectSource",
      (p: SparkplugProvider) => p.readObjectSource(["G", "E"], "edge-node"),
      SPARKPLUG_AGENT_WITHHELD.source,
    ],
    ["getHealth", (p: SparkplugProvider) => p.getHealth(), SPARKPLUG_AGENT_WITHHELD.health],
    ["getOverview", (p: SparkplugProvider) => p.getOverview(), SPARKPLUG_AGENT_WITHHELD.overview],
    [
      "getPerformanceMetrics",
      (p: SparkplugProvider) => p.getPerformanceMetrics(),
      SPARKPLUG_AGENT_WITHHELD.performance,
    ],
    ["getSlowQueries", (p: SparkplugProvider) => p.getSlowQueries(), SPARKPLUG_AGENT_WITHHELD.slowQueries],
    ["getActiveSessions", (p: SparkplugProvider) => p.getActiveSessions(), SPARKPLUG_AGENT_WITHHELD.sessions],
    ["getTableStats", (p: SparkplugProvider) => p.getTableStats(), SPARKPLUG_AGENT_WITHHELD.tableStats],
    ["getIndexStats", (p: SparkplugProvider) => p.getIndexStats(), SPARKPLUG_AGENT_WITHHELD.indexStats],
    ["getStorageStats", (p: SparkplugProvider) => p.getStorageStats(), SPARKPLUG_AGENT_WITHHELD.storage],
  ] as const)("%s", async (_name, call, sentence) => {
    for (const execution of [AGENT_PROFILE, { readOnly: true }]) {
      const { provider } = await opened([PLANT], {}, execution);
      const error = await call(provider).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(QueryError);
      expect((error as Error).message).toBe(sentence);
    }
    // Before connecting, the connection check answers first, as on every surface.
    const { provider } = scriptedProvider([PLANT]);
    await expect(call(provider)).rejects.toThrow("Provider is not connected");
  });

  test("the console's request is refused before anything is sent, and the editor's handle still reads", async () => {
    const { provider, requests } = await opened([PLANT]);
    await expect(provider.query('{"group": "Plant-North"}')).rejects.toThrow(
      new RefusedBeforeSendError(SPARKPLUG_AGENT_WITHHELD.query, "sparkplug"),
    );
    expect(requests).toHaveLength(1);
    expect(provider.connectWarnings()).toEqual([]);

    const editor = new SparkplugProvider(connection(), {}, {}, (request) =>
      dialAndRead(request, scripted(PLANT).factory),
    );
    await editor.connect();
    expect((await editor.listContainers([])).length).toBeGreaterThan(0);
  });
});

describe("the filters are Studio's own", () => {
  test("no plan's filter subscribes to $sparkplug, STATE or a shared subscription", () => {
    for (const filters of [
      sparkplugAgentFilters({ op: "window" }, ""),
      sparkplugAgentFilters({ op: "window" }, "G"),
      sparkplugAgentFilters({ op: "group", group: "G" }, ""),
      sparkplugAgentFilters({ op: "edgeNode", group: "G", edgeNode: "E" }, ""),
      sparkplugAgentFilters({ op: "device", group: "G", edgeNode: "E", device: "D" }, ""),
    ]) {
      for (const filter of filters) {
        expect(filter.startsWith("spBv1.0/")).toBe(true);
        expect(filter).not.toContain("STATE");
        expect(filter).not.toContain("$");
      }
    }
  });
});

describe("the agent path sends no PUBLISH and no will", () => {
  test("every packet of every read, the connect's included, is one of the encoder's five, and no CONNECT has a will", async () => {
    const { provider, sessions } = await opened([PLANT, PLANT, PLANT, PLANT]);
    await provider.queryReadOnly('{"read": "window"}', BUDGET);
    await provider.queryReadOnly('{"read": "group", "group": "G"}', BUDGET);
    await provider.queryReadOnly('{"read": "edgeNode", "group": "G", "edgeNode": "E"}', BUDGET);
    await provider.queryReadOnly('{"read": "device", "group": "G", "edgeNode": "E", "device": "D"}', BUDGET);
    expect(sessions).toHaveLength(5);
    for (const session of sessions) {
      for (const packet of session) expect([0x10, 0x82, 0xa2, 0xc0, 0xe0]).toContain(packet[0] as number);
      const connect = session.find((packet) => packet[0] === 0x10) as Uint8Array;
      // Fixed header and a one-byte remaining length, then "MQTT" with its length, the level, and the flags.
      const flags = connect[1 + 1 + 2 + 4 + 1] as number;
      expect(flags & 0x04).toBe(0);
      expect(flags & 0x02).toBe(0x02);
      // No credential is sent: the connection's user and password are not read by this provider.
      expect(flags & 0xc0).toBe(0);
    }
    // Each read after the connect is one fresh session: CONNECT first, SUBSCRIBE second, DISCONNECT last.
    for (const session of sessions.slice(1)) {
      expect(session.map((packet) => packet[0])).toEqual([0x10, 0x82, 0xa2, 0xe0]);
    }
  });
});
