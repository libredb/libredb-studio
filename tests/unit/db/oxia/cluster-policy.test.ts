/**
 * The dial policy, health and the deadline re-read through the recorded wire (SB3-5.6, SB1-5.4, SB1-9.4, SB1-9.5).
 *
 * The real adapter and the real provider run over synthetic server answers (SB3-6.3), and every assertion reads the
 * wire's log: which addresses were dialled, with which TLS identity, and which calls carried the token. No CI job
 * starts the cluster fixture, so this file is what holds the dial policy in CI: a refused leader is never opened and
 * never sent the token, and Test Connection runs the policy over every leader the shard map names.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildOxiaConnectionOptions,
  leaderPlaintextTokenRefusal,
} from "@/lib/db/providers/keyvalue/oxia/connection-options";
import { OXIA_HEALTH_DEADLINE_MS, OXIA_MAX_DATA_SERVERS } from "@/lib/db/providers/keyvalue/oxia/constants";
import {
  deadlineSeconds,
  OXIA_HEALTH_NO_SHARD_MAP,
  OxiaError,
  silentAssignmentsSentence,
  snapshotInvalidSentence,
} from "@/lib/db/providers/keyvalue/oxia/errors";
import { createGrpcOxiaClient } from "@/lib/db/providers/keyvalue/oxia/grpc-client";
import { OxiaProvider } from "@/lib/db/providers/keyvalue/oxia/index";
import { oxiaHash } from "@/lib/db/providers/keyvalue/oxia/routing";
import { type DatabaseConnection, type SSHTunnelConfig, TUNNEL_FAR_END, type WithTunnelFarEnd } from "@/lib/types";
import { oxiaConnection } from "../../../helpers/oxia-connection";
import {
  type RecordedCall,
  type RecordedOxiaWire,
  recordedOxiaWire,
  syntheticCall,
  syntheticCapture,
  type WireEvent,
} from "../../../helpers/oxia-wire";

const BOOT = "oxia.example.com:6648"; // a host that is not this machine
const LOCAL = "localhost:6648";
const TOKEN = "CANARY.token-1"; // within the token's character rule (SB1-4.4)
const call = () => ({ signal: new AbortController().signal, deadline: Date.now() + 2_000 });

const ASSIGNMENTS = "io.oxia.proto.v1.OxiaClient/GetShardAssignments";
const LIST = "io.oxia.proto.v1.OxiaClient/List";
const READ = "io.oxia.proto.v1.OxiaClient/Read";
const CHECK = "grpc.health.v1.Health/Check";
const HASH_SPACE = 2 ** 32;
const LAST_HASH = HASH_SPACE - 1;
const OK_END = { kind: "status", code: 0, details: "" } as const;
const WHOLE = { startInclusive: "", endExclusive: "" };

/** Every wire a test built, so afterEach can hold each to "no call the test did not plan". */
const wires: RecordedOxiaWire[] = [];

afterEach(() => {
  for (const wire of wires.splice(0)) expect(wire.unmatched()).toEqual([]);
});

interface AssignmentOptions {
  readonly ids?: readonly string[];
  readonly end?: RecordedCall["end"];
  readonly namespace?: string;
}

interface HashRange {
  readonly min: number;
  readonly max: number;
}

/** Shard `index`'s range in a map of `count` shards with equal hash ranges covering the whole hash space. */
function hashRange(index: number, count: number): HashRange {
  const size = Math.floor(HASH_SPACE / count);
  return { min: index * size, max: index === count - 1 ? LAST_HASH : (index + 1) * size - 1 };
}

/** A shard map over `leaders.length` shards with equal hash ranges covering 0 to 4294967295, ids "0", "1", ... (or `ids`). */
function assignments(target: string, leaders: readonly string[], options: AssignmentOptions = {}): RecordedCall {
  const namespace = options.namespace ?? "default";
  return syntheticCall({
    target,
    method: ASSIGNMENTS,
    request: { namespace },
    messages: [
      {
        namespaces: {
          [namespace]: {
            assignments: leaders.map((leader, index) => {
              const range = hashRange(index, leaders.length);
              return {
                shard: options.ids?.[index] ?? String(index),
                leader,
                int32_hash_range: { min_hash_inclusive: range.min, max_hash_inclusive: range.max },
              };
            }),
            shard_key_router: "XXHASH3",
          },
        },
      },
    ],
    end: options.end ?? { kind: "open" },
  });
}

/** A wire over `calls`, registered for the afterEach check. */
function wireOver(calls: readonly RecordedCall[]): RecordedOxiaWire {
  const wire = recordedOxiaWire([syntheticCapture(calls)]);
  wires.push(wire);
  return wire;
}

/** The provider over a wire: the real adapter, the recorded transport. */
function providerOver(calls: readonly RecordedCall[], connection: DatabaseConnection, queryTimeout = 2_000) {
  const wire = wireOver(calls);
  const provider = new OxiaProvider(connection, { queryTimeout }, {}, (options) =>
    createGrpcOxiaClient(options, wire.transport),
  );
  return { wire, provider };
}

/** The adapter alone over a wire, with the options the provider would build for `connection`. */
function adapterOver(calls: readonly RecordedCall[], connection: DatabaseConnection) {
  const wire = wireOver(calls);
  const options = buildOxiaConnectionOptions(connection, { executionReadOnly: false, queryTimeout: 2_000 });
  return { wire, client: createGrpcOxiaClient(options, wire.transport) };
}

const opens = (log: readonly WireEvent[]) => log.filter((event) => event.kind === "open");
const callsTo = (log: readonly WireEvent[], target: string) =>
  log.filter((event) => event.kind === "call" && event.target === target);
const message = async (run: Promise<unknown>): Promise<string> =>
  run.then(
    () => "resolved",
    (error: Error) => error.message,
  );
const kinds = (log: readonly WireEvent[]) => log.map((event) => event.kind);

/** The List request the adapter sends for the whole of a shard: the literal of grpc-client.ts `wireRange`. */
function listRequest(shard: string): object {
  return { shard, start_inclusive: "", end_exclusive: "", include_internal_keys: false };
}

/** The Read request the adapter sends for one EQUAL get with its value: grpc-client.ts `read` over `wireGet`. */
function readRequest(shard: string, key: string): object {
  return { shard, gets: [{ key, include_value: true, comparison_type: "EQUAL" }] };
}

/** The Health/Check request: grpc-client.ts `health` (SB1-9.5: `service: ""`). */
const HEALTH_REQUEST: object = { service: "" };

/** A List of the whole of `shard` on `target`, answering `keys` then ending. */
function listCall(target: string, shard: string, keys: readonly string[] = ["/a"]): RecordedCall {
  return syntheticCall({ target, method: LIST, request: listRequest(shard), messages: [{ keys }], end: OK_END });
}

function healthCall(target: string, status: string): RecordedCall {
  return syntheticCall({ target, method: CHECK, request: HEALTH_REQUEST, messages: [{ status }], end: OK_END });
}

/** The first of /k0, /k1, ... whose oxiaHash falls in shard `index`'s range of an `assignments` map over `count` shards. */
function keyOnShard(index: number, count: number): string {
  const range = hashRange(index, count);
  for (let n = 0; ; n += 1) {
    const key = `/k${n}`;
    const hash = oxiaHash(key);
    if (hash >= range.min && hash <= range.max) return key;
  }
}

/** A refusal names no token: neither the message nor any log entry holds it. */
function holdsNoToken(wire: RecordedOxiaWire, text: string): void {
  expect(text).not.toContain(TOKEN);
  expect(JSON.stringify(wire.log)).not.toContain(TOKEN);
}

/** An enabled SSH tunnel; the provider reads only `enabled`, the rest makes the type whole. */
const TUNNEL: SSHTunnelConfig = {
  enabled: true,
  host: "bastion.example.com",
  port: 22,
  username: "tunnel",
  authMethod: "password",
};

/** A4's connection: the local forward at 127.0.0.1:40123, the far end oxia.internal:6648. */
function tunnelled(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection & WithTunnelFarEnd {
  return {
    ...oxiaConnection({ host: "127.0.0.1", port: 40123, sshTunnel: TUNNEL, ...overrides }),
    [TUNNEL_FAR_END]: { host: "oxia.internal", port: 6648 },
  };
}

/** SB1-5.4 sentence (c) for `addresses`. */
function unlistedSentence(addresses: readonly string[]): string {
  const list = addresses.join(", ");
  return `The cluster sends clients to data servers this connection does not list: ${list}. Studio dials only the endpoint and the addresses under Data servers, and sends the token to no other. To allow them, list under Data servers these addresses and every other data server of the cluster: ${list}`;
}

/** SB1-5.4 sentence (a). */
function tunnelSentence(at: string, leader: string): string {
  return `This connection reaches Oxia through a port-forward or tunnel at ${at}, but the cluster sends clients to ${leader} for its shards, which this machine cannot be assumed to reach. Run Studio where ${leader} resolves and is reachable; the Oxia provider doc shows the hosts-file and per-pod port-forward workaround.`;
}

const POD = "oxia-0.oxia-svc.pulsar.svc.cluster.local:6648";
const POD_SENTENCE = `This server calls itself ${POD}: type oxia-0.oxia-svc.pulsar.svc.cluster.local in Host, or add ${POD} to Data servers.`;

describe("A. the dial policy (SB3-5.6, SB1-5.4)", () => {
  test("A1 every leader equals the sent authority: one channel", async () => {
    const { wire, client } = adapterOver(
      [assignments(LOCAL, [LOCAL, LOCAL, LOCAL]), listCall(LOCAL, "0"), listCall(LOCAL, "1"), listCall(LOCAL, "2")],
      oxiaConnection(),
    );
    const snapshot = await client.getSnapshot(call());
    expect(snapshot.shards.map((shard) => shard.leader.bootstrap)).toEqual([true, true, true]);
    await Promise.all(
      snapshot.shards.map((shard) => client.list(shard, WHOLE, { ...call(), maxReceivedBytes: 1_000_000 }).next()),
    );
    expect(opens(wire.log)).toEqual([{ kind: "open", target: LOCAL, tls: { mode: "disable" } }]);
    const lists = wire.log.filter((event) => event.kind === "call" && event.method === LIST);
    expect(lists).toHaveLength(3);
    expect(lists.every((event) => event.target === LOCAL)).toBe(true);
    client.close();
  });

  test("A2 a leader on the same port under another host spelling: sentence (b)", async () => {
    const { wire, provider } = providerOver([assignments(BOOT, [POD])], oxiaConnection({ host: "oxia.example.com" }));
    expect(await message(provider.connect())).toBe(POD_SENTENCE);
    expect(opens(wire.log)).toHaveLength(1);
    expect(wire.log.some((event) => event.target === POD)).toBe(false);
  });

  test("A3 a loopback endpoint whose leader is another host: sentence (a)", async () => {
    const { wire, provider } = providerOver([assignments(LOCAL, ["oxia-0.internal:6648"])], oxiaConnection());
    expect(await message(provider.connect())).toBe(tunnelSentence(LOCAL, "oxia-0.internal:6648"));
    expect(opens(wire.log)).toHaveLength(1);
  });

  test("A4 the same under a tunnel", async () => {
    const { wire, provider } = providerOver([assignments("127.0.0.1:40123", ["oxia-0.internal:6648"])], tunnelled());
    expect(await message(provider.connect())).toBe(tunnelSentence("127.0.0.1:40123", "oxia-0.internal:6648"));
    expect(opens(wire.log)).toEqual([{ kind: "open", target: "127.0.0.1:40123", tls: { mode: "disable" } }]);
  });

  test("A5 listed leaders: one channel each, its own host as TLS identity, and the token with it", async () => {
    const { wire, client } = adapterOver(
      [
        assignments(BOOT, [BOOT, "oxia-1.internal:6671", "10.0.0.5:6672"]),
        listCall(BOOT, "0"),
        listCall("oxia-1.internal:6671", "1"),
        listCall("10.0.0.5:6672", "2"),
      ],
      oxiaConnection({
        host: "oxia.example.com",
        password: TOKEN,
        ssl: { mode: "verify-system" },
        dataServers: "oxia-1.internal:6671, 10.0.0.5:6672",
      }),
    );
    const snapshot = await client.getSnapshot(call());
    const options = { ...call(), maxReceivedBytes: 1_000_000 };
    // Each list() opens its channel synchronously, so the channels open in shard order.
    await Promise.all(snapshot.shards.map((shard) => client.list(shard, WHOLE, options).next()));
    expect(opens(wire.log)).toEqual([
      { kind: "open", target: BOOT, tls: { mode: "verify-system", identity: "oxia.example.com" } },
      { kind: "open", target: "oxia-1.internal:6671", tls: { mode: "verify-system", identity: "oxia-1.internal" } },
      { kind: "open", target: "10.0.0.5:6672", tls: { mode: "verify-system", identity: "10.0.0.5" } },
    ]);
    const calls = wire.log.filter((event) => event.kind === "call");
    expect(calls).toHaveLength(4);
    for (const event of calls) {
      expect(event.token).toBe(true);
      expect(event.authority).toBe(event.target);
    }
    await client.list(snapshot.shards[1] as (typeof snapshot.shards)[number], WHOLE, options).next();
    expect(opens(wire.log)).toHaveLength(3);
    client.close();
  });

  test("A6 leaders not listed: the paste-ready value, and success with it", async () => {
    const answers = [assignments(BOOT, [BOOT, "a.internal:6671", "b.internal:6672"])];
    const secured = { host: "oxia.example.com", password: TOKEN, ssl: { mode: "verify-system" } } as const;
    const { wire, provider } = providerOver(answers, oxiaConnection(secured));
    const refused = await message(provider.connect());
    expect(refused).toBe(unlistedSentence(["a.internal:6671", "b.internal:6672"]));
    expect(opens(wire.log)).toHaveLength(1);
    expect(callsTo(wire.log, "a.internal:6671")).toEqual([]);
    expect(callsTo(wire.log, "b.internal:6672")).toEqual([]);
    holdsNoToken(wire, refused);

    const pasted = refused.slice(refused.lastIndexOf(": ") + ": ".length);
    const second = providerOver(answers, oxiaConnection({ ...secured, dataServers: pasted }));
    expect(await message(second.provider.connect())).toBe("resolved");
    await second.provider.disconnect();
  });

  test("A7 every refused leader up to the Data servers bound is listed; one more refuses outright", async () => {
    const leaders = (count: number) => Array.from({ length: count }, (_, index) => `ds-${index}.internal:6648`);
    const atBound = leaders(OXIA_MAX_DATA_SERVERS);
    const listed = providerOver([assignments(BOOT, atBound)], oxiaConnection({ host: "oxia.example.com" }));
    const text = await message(listed.provider.connect());
    expect(text).toBe(unlistedSentence(atBound));
    expect(text).not.toContain("more");

    const over = leaders(OXIA_MAX_DATA_SERVERS + 1);
    const refused = providerOver([assignments(BOOT, over)], oxiaConnection({ host: "oxia.example.com" }));
    expect(await message(refused.provider.connect())).toBe(
      `The cluster sends clients to ${over.length} data servers this connection does not list, more than the ${OXIA_MAX_DATA_SERVERS} that Data servers can hold, so Studio cannot reach this namespace's shards and nothing was read.`,
    );
  });

  test.each([
    ["a leader past 300 bytes", `${"a".repeat(296)}:6648`],
    ["a leader that is no address", "not an address"],
  ])("A8 %s is refused by validation, before the policy", async (_name, leader) => {
    const { wire, provider } = providerOver(
      [assignments(BOOT, [leader])],
      oxiaConnection({ host: "oxia.example.com" }),
    );
    const text = await message(provider.connect());
    expect(text).toBe(snapshotInvalidSentence("leader"));
    expect(text).toBe(
      "The server's shard map is not one Studio can route by (a leader address is not host:port within 300 bytes), so nothing was read.",
    );
    expect(opens(wire.log)).toHaveLength(1);
    expect(wire.log.filter((event) => event.kind === "call")).toHaveLength(1);
    expect(text).not.toContain(leader);
  });

  test.each([
    [
      "a trailing dot",
      oxiaConnection({ dataServers: "oxia-1.internal.:6648" }),
      "Data servers entries must not end the host with a dot: write the name without the final dot.",
    ],
    [
      "a wildcard",
      oxiaConnection({ dataServers: "*.oxia.internal:6648" }),
      "Data servers entries name exact addresses: a wildcard (*) is not accepted, because it would match any service a tenant can create, and the token would follow.",
    ],
    [
      "one entry past the bound",
      oxiaConnection({
        dataServers: Array.from({ length: OXIA_MAX_DATA_SERVERS + 1 }, (_, index) => `ds-${index}.internal:6648`).join(
          ", ",
        ),
      }),
      `Data servers holds more than ${OXIA_MAX_DATA_SERVERS} addresses; list only the cluster's data servers.`,
    ],
    [
      "a tunnel",
      tunnelled({ dataServers: "oxia-1.internal:6648" }),
      "Data servers cannot be used with an SSH tunnel: the tunnel carries one address, and Studio would dial the data servers directly, outside it. Clear Data servers, or turn the tunnel off.",
    ],
  ])("A9 a Data servers field with %s opens nothing", async (_name, connection, sentence) => {
    const { wire, provider } = providerOver([], connection);
    expect(await message(provider.connect())).toBe(sentence);
    expect(wire.log).toEqual([]);
  });

  test("A10 a plaintext token to a listed leader that is not this machine needs the consent", async () => {
    const answers = [assignments(LOCAL, [LOCAL, "oxia-1.internal:6671"]), listCall("oxia-1.internal:6671", "1")];
    const plain = { password: TOKEN, dataServers: "oxia-1.internal:6671" };
    const { wire, provider } = providerOver(answers.slice(0, 1), oxiaConnection(plain));
    const refused = await message(provider.connect());
    expect(refused).toBe(leaderPlaintextTokenRefusal("oxia-1.internal:6671"));
    expect(refused).toBe(
      'This connection would send its token without TLS to the data server oxia-1.internal:6671, where anyone on the path can read it. Choose an SSL mode under SSL / TLS, or, if authentication is off on this server, clear the token. Or tick "Send the password without TLS", which then also covers every address under Data servers.',
    );
    expect(opens(wire.log).some((event) => event.target === "oxia-1.internal:6671")).toBe(false);
    holdsNoToken(wire, refused);

    const consented = oxiaConnection({ ...plain, allowInsecureAuth: true });
    const allowed = providerOver(answers.slice(0, 1), consented);
    expect(await message(allowed.provider.connect())).toBe("resolved");
    await allowed.provider.disconnect();

    const { wire: leaderWire, client } = adapterOver(answers, consented);
    const snapshot = await client.getSnapshot(call());
    const shard = snapshot.shards[1] as (typeof snapshot.shards)[number];
    await client.list(shard, WHOLE, { ...call(), maxReceivedBytes: 1_000_000 }).next();
    expect(opens(leaderWire.log)).toContainEqual({
      kind: "open",
      target: "oxia-1.internal:6671",
      tls: { mode: "disable" },
    });
    expect(callsTo(leaderWire.log, "oxia-1.internal:6671")).toEqual([
      {
        kind: "call",
        target: "oxia-1.internal:6671",
        authority: "oxia-1.internal:6671",
        method: LIST,
        request: listRequest("1"),
        token: true,
      },
    ]);
    client.close();
  });

  test("A11 Test Connection runs the policy over every advertised leader", async () => {
    const { wire, provider } = providerOver(
      [assignments(BOOT, [BOOT, "a.internal:6671", "c.internal:6673"])],
      oxiaConnection({ host: "oxia.example.com", dataServers: "a.internal:6671" }),
    );
    expect(await message(provider.connect())).toBe(unlistedSentence(["c.internal:6673"]));
    // The failed connect closes the client it built, so the bootstrap channel's close ends the log.
    expect(wire.log).toEqual([
      { kind: "open", target: BOOT, tls: { mode: "disable" } },
      {
        kind: "call",
        target: BOOT,
        authority: BOOT,
        method: ASSIGNMENTS,
        request: { namespace: "default" },
        token: false,
      },
      { kind: "cancel", target: BOOT, method: ASSIGNMENTS, afterMessages: 1 },
      { kind: "close", target: BOOT },
    ]);
  });
});

describe("B. the assignments stream and cancellation (SB1-9.4)", () => {
  test("B1 the assignments stream is cancelled after one message", async () => {
    const { wire, provider } = providerOver([assignments(LOCAL, [LOCAL, LOCAL, LOCAL])], oxiaConnection());
    await provider.connect();
    expect(kinds(wire.log)).toEqual(["open", "call", "cancel"]);
    expect(wire.log[2]).toEqual({ kind: "cancel", target: LOCAL, method: ASSIGNMENTS, afterMessages: 1 });
    await provider.disconnect();
    expect(wire.log.at(-1)).toEqual({ kind: "close", target: LOCAL });
    expect(kinds(wire.log)).toEqual(["open", "call", "cancel", "close"]);
  });

  test("B2 an abort cancels every open stream", async () => {
    const held = (shard: string) =>
      syntheticCall({
        target: LOCAL,
        method: LIST,
        request: listRequest(shard),
        messages: [{ keys: [`/${shard}`] }],
        end: { kind: "open" },
      });
    const { wire, client } = adapterOver(
      [assignments(LOCAL, [LOCAL, LOCAL, LOCAL]), held("0"), held("1"), held("2")],
      oxiaConnection(),
    );
    const snapshot = await client.getSnapshot(call());
    const controller = new AbortController();
    const options = { signal: controller.signal, deadline: Date.now() + 2_000, maxReceivedBytes: 1_000_000 };
    const streams = snapshot.shards.map((shard) => client.list(shard, WHOLE, options));
    expect(await Promise.all(streams.map((stream) => stream.next()))).toEqual([["/0"], ["/1"], ["/2"]]);
    const pending = streams.map((stream) =>
      stream.next().then(
        () => undefined,
        (error: unknown) => error,
      ),
    );
    controller.abort();
    const failures = await Promise.all(pending);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(OxiaError);
      expect((failure as OxiaError).category).toBe("cancelled");
    }
    const cancels = wire.log.filter((event) => event.kind === "cancel" && event.method === LIST);
    expect(cancels).toHaveLength(3);
    client.close();
  });
});

describe("C. the deadline re-read (SB1-9.4)", () => {
  const KEY = keyOnShard(2, 3);
  const SILENT_READ = syntheticCall({
    target: LOCAL,
    method: READ,
    request: readRequest("2", KEY),
    messages: [],
    end: { kind: "open" },
  });

  async function deadlineOn(second: RecordedCall) {
    const { wire, provider } = providerOver(
      [assignments(LOCAL, [LOCAL, LOCAL, LOCAL]), second, SILENT_READ],
      oxiaConnection({ dataServers: "oxia-1.internal:6648" }),
      200,
    );
    await provider.connect();
    const text = await message(provider.query(`get ${KEY}`));
    const calls = wire.log.filter((event) => event.kind === "call");
    expect(calls.filter((event) => event.method === ASSIGNMENTS)).toHaveLength(2);
    expect(calls.filter((event) => event.method === READ)).toHaveLength(1);
    await provider.disconnect();
    return { wire, text };
  }

  test("C1 the shard is gone from the map", async () => {
    const { text } = await deadlineOn(assignments(LOCAL, [LOCAL, LOCAL, LOCAL, LOCAL], { ids: ["0", "1", "3", "4"] }));
    expect(text).toBe(
      "Shard 2 is not on the server any more (the shard map changed, for example by a split): run it again, and Studio reads the shard map afresh.",
    );
  });

  test("C2 the shard's leader moved", async () => {
    const { wire, text } = await deadlineOn(assignments(LOCAL, [LOCAL, LOCAL, "oxia-1.internal:6648"]));
    expect(text).toBe("Shard 2's leadership is changing on the server, so the get stopped: run it again.");
    expect(opens(wire.log).some((event) => event.target === "oxia-1.internal:6648")).toBe(false);
  });

  test("C3 the map is unchanged", async () => {
    const { text } = await deadlineOn(assignments(LOCAL, [LOCAL, LOCAL, LOCAL]));
    expect(text).toBe("The get reached its deadline of 200 ms.");
  });
});

describe("D. health (SB1-9.5)", () => {
  test("D1 healthy, and the token goes with Check", async () => {
    const answers = [assignments(LOCAL, [LOCAL, LOCAL, LOCAL]), healthCall(LOCAL, "SERVING")];
    const { provider } = providerOver(answers, oxiaConnection());
    const health = await provider.getHealth();
    expect(health).toEqual({ databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] });
    expect("activeConnections" in health).toBe(false);
    await provider.disconnect();

    const withToken = providerOver(answers, oxiaConnection({ password: TOKEN }));
    await withToken.provider.getHealth();
    const checks = withToken.wire.log.filter((event) => event.kind === "call" && event.method === CHECK);
    expect(checks).toHaveLength(1);
    expect(checks.every((event) => event.kind === "call" && event.token)).toBe(true);
    await withToken.provider.disconnect();
  });

  test("D2 the server answers health but serves no shard map", async () => {
    const queryTimeout = 150;
    const silent = syntheticCall({
      target: LOCAL,
      method: ASSIGNMENTS,
      request: { namespace: "default" },
      messages: [],
      end: { kind: "open" },
    });
    const { wire, provider } = providerOver([silent, healthCall(LOCAL, "SERVING")], oxiaConnection(), queryTimeout);
    const text = await message(provider.getHealth());
    const seconds = deadlineSeconds(Math.min(OXIA_HEALTH_DEADLINE_MS, queryTimeout));
    expect(text).toContain(OXIA_HEALTH_NO_SHARD_MAP);
    expect(text).toContain(silentAssignmentsSentence(seconds));
    expect(silentAssignmentsSentence(seconds)).toStartWith(
      "The server accepted the connection but its shard map did not arrive within",
    );
    expect(text).toBe(`${OXIA_HEALTH_NO_SHARD_MAP}: ${silentAssignmentsSentence(seconds)}`);
    expect(text).not.toMatch(/restart/i);
    expect(text).not.toMatch(/0\.16/);
    expect(wire.log.some((event) => event.kind === "call" && event.method === CHECK)).toBe(true);
  });

  test("D3 a refused leader fails health with the policy's sentence, before Check", async () => {
    const { wire, provider } = providerOver(
      [assignments(BOOT, [POD]), healthCall(BOOT, "SERVING")],
      oxiaConnection({ host: "oxia.example.com" }),
    );
    expect(await message(provider.getHealth())).toBe(POD_SENTENCE);
    expect(wire.log.some((event) => event.kind === "call" && event.method === CHECK)).toBe(false);
  });

  test("D4 NOT_SERVING", async () => {
    const { provider } = providerOver(
      [assignments(LOCAL, [LOCAL, LOCAL, LOCAL]), healthCall(LOCAL, "NOT_SERVING")],
      oxiaConnection(),
    );
    expect(await message(provider.getHealth())).toBe(
      "Oxia answered the health check with NOT_SERVING: it serves no reads now.",
    );
  });
});
