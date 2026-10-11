/**
 * The MQTT provider's own surface (#1635 spec 10), every declaration and every refusal.
 *
 * EVERY SURFACE A BROKER DOES NOT HAVE IS ASSERTED BY NAME, not left to a default. A panel that drew an empty
 * table where there is no table, or offered maintenance against a connection that cannot write, would be
 * lying by omission; these tests are what hold each of those answers to the sentence that explains it.
 *
 * The transport arms are exercised against a loopback server this file starts, so the dial path runs in CI
 * with no broker: a provider whose socket code is never executed by a test is a provider whose first real
 * connection is its first test.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { MqttProvider } from "@/lib/db/providers/keyvalue/mqtt/index";
import {
  MQTT_CONNECT_TIMEOUT_MS,
  MQTT_DEFAULT_PORT,
  MQTT_IP_SERVER_NAME,
} from "@/lib/db/providers/keyvalue/mqtt/constants";
import {
  countMqttObjects,
  describeMqttObject,
  describeMqttObjects,
  listMqttObjects,
  MQTT_OBJECT_KINDS,
  mqttSourceDocument,
} from "@/lib/db/providers/keyvalue/mqtt/objects";
import { encodeString, encodeVariableByteInteger } from "@/lib/db/providers/keyvalue/mqtt/encoder";
import {
  tlsServerName,
  type MqttTopicRow,
  type MqttTransport,
  type MqttTransportFactory,
} from "@/lib/db/providers/keyvalue/mqtt/session";
import type { DatabaseConnection, SSLMode } from "@/lib/types";

const CONNACK = Buffer.from([0x20, 0x03, 0x00, 0x00, 0x00]);
const SUBACK = Buffer.from([0x90, 0x04, 0x00, 0x01, 0x00, 0x00]);

function publish(topic: string, payload: string, retain = true, expiry?: number): Buffer {
  const props =
    expiry === undefined
      ? Buffer.from([0x00])
      : Buffer.concat([
          Buffer.from(encodeVariableByteInteger(5)),
          Buffer.from([0x02, (expiry >> 24) & 0xff, (expiry >> 16) & 0xff, (expiry >> 8) & 0xff, expiry & 0xff]),
        ]);
  const body = Buffer.concat([Buffer.from(encodeString(topic)), props, Buffer.from(payload, "utf8")]);
  return Buffer.concat([
    Buffer.from([retain ? 0x31 : 0x30]),
    Buffer.from(encodeVariableByteInteger(body.length)),
    body,
  ]);
}

/** A transport that answers a script and then closes, as a read that ends on the wire does. */
function scripted(chunks: readonly Buffer[]): MqttTransportFactory {
  return () => {
    const handlers = new Map<string, ((value: never) => void)[]>();
    const emit = (event: string, value?: unknown): void => {
      for (const handler of handlers.get(event) ?? []) (handler as (v: unknown) => void)(value);
    };
    const transport: MqttTransport = {
      write(): void {},
      on(event: string, handler: (value: never) => void): void {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      once(event: string, handler: () => void): void {
        if (event !== "ready") return;
        queueMicrotask(() => {
          handler();
          for (const chunk of chunks) emit("data", chunk);
          emit("close");
        });
      },
      destroy(): void {},
    };
    return { transport, readyEvent: "ready" };
  };
}

function connection(over: Partial<Record<string, unknown>> = {}): DatabaseConnection {
  return {
    id: "mqtt-test",
    name: "lab",
    type: "mqtt",
    host: "127.0.0.1",
    port: 1883,
    database: "#",
    ...over,
  } as unknown as DatabaseConnection;
}

const SCRIPT = [CONNACK, SUBACK, publish("plant/line1/state", "RUN"), publish("plant/line2/state", "IDLE", true, 300)];

function openProvider(over: Partial<Record<string, unknown>> = {}, chunks: readonly Buffer[] = SCRIPT): MqttProvider {
  return new MqttProvider(connection(over), {}, scripted(chunks));
}

describe("the declarations, every member written out", () => {
  const capabilities = openProvider().getCapabilities();

  test("it declares its own dialect, so a connection never falls through to MongoDB's tab", () => {
    expect(capabilities.queryLanguage).toBe("json");
    // The exact fault `queryDialect` exists for (#427): a `json` provider with no dialect gets MongoDB's tab.
    expect(capabilities.queryDialect).toBe("mqtt");
    expect(capabilities.defaultPort).toBe(MQTT_DEFAULT_PORT);
  });

  test("read-only is declared true, and it is structural rather than a mode", () => {
    expect(capabilities.enforcesReadOnly).toBe(true);
    // A connection that ticked the box off would still write nothing: there is no code that can.
    expect(openProvider({ readOnly: false }).getCapabilities().enforcesReadOnly).toBe(true);
  });

  test("every surface a broker does not have is declared false, not left to a default", () => {
    for (const flag of [
      "supportsExplain",
      "supportsExternalQueryLimiting",
      "supportsCreateTable",
      "supportsInlineRowEdit",
      "supportsTestDataGeneration",
      "supportsResultPagination",
      "supportsTransactions",
      "declaresForeignKeys",
      "tablesAreDerivedGroupings",
      "supportsMaintenance",
      "supportsConnectionString",
    ] as const) {
      expect(capabilities[flag]).toBe(false);
    }
    expect(capabilities.maintenanceOperations).toEqual([]);
    expect(capabilities.containerLevels).toEqual([]);
    // A pattern that matches nothing: no read this provider runs changes the tree.
    expect(capabilities.schemaRefreshPattern).toBe("(?!)");
    expect(capabilities.statementTerminator).toBe("none");
  });

  test("it declares exactly one object kind, the key-browser topic", () => {
    expect(capabilities.objectKinds).toHaveLength(1);
    const kind = MQTT_OBJECT_KINDS[0]!;
    expect(kind.id).toBe("topic");
    expect(kind.enumeratedBy).toBe("key-browser");
    expect(kind.hasSource).toBe(true);
    expect(kind.sourceLanguage).toBe("json");
    // Absent, and that is what keeps the Source tab read-only.
    expect(kind.acceptsSourceEdits).toBeUndefined();
  });

  test("the labels name a topic and a message, and every unavailable action says why", () => {
    const labels = openProvider().getLabels();
    expect(labels.entityName).toBe("Topic");
    expect(labels.rowName).toBe("Message");
    for (const sentence of [labels.analyzeGlobalDesc, labels.vacuumGlobalDesc]) {
      expect(sentence.length).toBeGreaterThan(40);
    }
    // The maintenance sentence says the reason is structural, not a setting.
    expect(labels.vacuumGlobalDesc).toMatch(/no code that can write/);
  });

  test("a prepared query is never limited, because a read carries its own budgets", () => {
    const prepared = openProvider().prepareQuery("anything");
    expect(prepared).toEqual({ query: "anything", wasLimited: false, limit: 0, offset: 0 });
  });
});

describe("the connection's own fields, refused before a socket is opened", () => {
  test("a connection with no address is refused by name", async () => {
    await expect(openProvider({ host: "" }).connect()).rejects.toThrow(DatabaseConfigError);
    await expect(openProvider({ host: "   " }).connect()).rejects.toThrow(/needs a broker address/);
  });

  test("a port outside 1 to 65,535 is refused", async () => {
    for (const port of [0, -1, 65_536, 1.5]) {
      await expect(openProvider({ port }).connect()).rejects.toThrow(/between 1 and 65,535/);
    }
  });

  /**
   * THE NAME PROMISED A TRANSPORT DECISION AND THE BODY CHECKED CONSTRUCTION. It built two providers and
   * asserted both were `MqttProvider`, which is true however the SSL mode is read - including if it were
   * ignored entirely. The decision is visible only in what is dialled, so that is what this reads.
   */
  /**
   * THE NAME PROMISED A TRANSPORT DECISION AND THE BODY CHECKED CONSTRUCTION. It built two providers and
   * asserted both were `MqttProvider`, which holds however the SSL mode is read, including if it were ignored
   * entirely. The decision is visible only in what is dialled, so that is what this reads.
   *
   * ALL FIVE MODES, NOT TWO. A later mutation run showed why: with `disable` and `require` alone, rewriting
   * the rule as `mode === "require"` passed the whole suite, and the three verifying modes would then have
   * silently dialled PLAIN TCP - a connection a reader asked to verify a certificate, carrying their password
   * in the clear. Only `disable` means plain.
   */
  test("every SSL mode decides the transport, and only `disable` means plain TCP", async () => {
    const dialled: { mode: string; tls: boolean }[] = [];
    const record: MqttTransportFactory = (options) => {
      dialled.push({ mode: "", tls: options.tls });
      throw new QueryError("the dial is refused once it has been seen", "mqtt");
    };

    const modes: SSLMode[] = ["disable", "require", "verify-system", "verify-ca", "verify-full"];
    for (const mode of modes) {
      dialled.length = 0;
      await expect(new MqttProvider(connection({ ssl: { mode } }), {}, record).connect()).rejects.toThrow();
      expect(dialled).toHaveLength(1);
      expect({ mode, tls: dialled[0]?.tls }).toEqual({ mode, tls: mode !== "disable" });
    }

    // And an absent SSL block is plain, which is what a connection typed with no SSL panel means.
    dialled.length = 0;
    await expect(new MqttProvider(connection({}), {}, record).connect()).rejects.toThrow();
    expect(dialled[0]?.tls).toBe(false);
  });

  /**
   * CERTIFICATE VERIFICATION IS ON UNLESS THE READER TURNS IT OFF, and nothing asserted that.
   *
   * `dialBroker` reads `options.rejectUnauthorized ?? true`. A mutation run flipped that default to `false`
   * and the whole suite stayed green: every TLS connection would have accepted any certificate, including an
   * attacker's, while the dialog still said the mode was `verify-full`. The default is the security property,
   * so it is pinned here along with both explicit values.
   */
  test("TLS verifies the certificate unless the connection says otherwise", async () => {
    const seen: (boolean | undefined)[] = [];
    const record: MqttTransportFactory = (options) => {
      seen.push(options.rejectUnauthorized);
      throw new QueryError("the dial is refused once it has been seen", "mqtt");
    };

    for (const over of [{}, { rejectUnauthorized: true }, { rejectUnauthorized: false }]) {
      await expect(
        new MqttProvider(connection({ ssl: { mode: "require", ...over } }), {}, record).connect(),
      ).rejects.toThrow();
    }
    // `require` with nothing said resolves to FALSE, which is the house rule in `src/lib/types.ts`: require
    // encrypts and verifies nothing, because a self-hosted broker ordinarily presents a self-signed
    // certificate, and the hint under the selector says exactly that. An explicit value always wins.
    expect(seen).toEqual([false, true, false]);

    // And every verifying mode resolves to TRUE with nothing said, which is the other half of the rule.
    for (const mode of ["verify-system", "verify-ca", "verify-full"] as const) {
      seen.length = 0;
      await expect(new MqttProvider(connection({ ssl: { mode } }), {}, record).connect()).rejects.toThrow();
      expect({ mode, verify: seen[0] }).toEqual({ mode, verify: true });
    }

    // The dial's own fallback, for a direct session call that names no mode, read from the production path
    // rather than from this file's idea of it. It is the safe one.
    const source = readFileSync(
      path.join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "..",
        "src",
        "lib",
        "db",
        "providers",
        "keyvalue",
        "mqtt",
        "session.ts",
      ),
      "utf8",
    );
    expect(source).toContain("rejectUnauthorized: options.rejectUnauthorized ?? true");
    expect(source).not.toContain("rejectUnauthorized: options.rejectUnauthorized ?? false");
  });
});

describe("a read, and everything that reads from it", () => {
  test("connect reads the broker, and the panel's page is drawn from that one read", async () => {
    const provider = openProvider();
    await provider.connect();
    expect(provider.isConnected()).toBe(true);

    const page = await provider.scanKeysPage!({ cursor: "0", count: 100 });
    expect(page.keys).toEqual(["plant/line1/state", "plant/line2/state"]);
    // The server's own lifetime, and nothing computed from it.
    expect(page.types["plant/line2/state"]).toBe("300s left");
    expect(page.types["plant/line1/state"]).toBe("retained");
    expect(page.readOutcome?.endReason).toMatch(/connection closed/);

    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
  });

  test("every surface refuses by name before the connection is open", async () => {
    const provider = openProvider();
    await expect(provider.scanKeysPage!({ cursor: "0", count: 10 })).rejects.toThrow(/not open/);
    await expect(provider.describeObject(["a"], "topic")).resolves.toBeDefined();
    await expect(provider.getOverview()).rejects.toThrow(/not open/);
  });

  test("the console read is refused with the protocol reason, not a generic error", async () => {
    const provider = openProvider();
    await provider.connect();
    await expect(provider.query()).rejects.toThrow(QueryError);
    await expect(provider.query()).rejects.toThrow(/no command that lists topics/);
  });

  test("a broker names no container level, so none is listed", async () => {
    await expect(openProvider().listContainers()).resolves.toEqual([]);
  });

  test("nothing is counted, because a broker publishes no count", async () => {
    await expect(openProvider().countObjects()).resolves.toEqual({});
    expect(countMqttObjects()).toEqual({});
  });

  test("the Objects tree refuses to list topics and says where they are listed", async () => {
    await expect(openProvider().listObjects([], "topic")).rejects.toThrow(/Keys panel/);
  });

  test("a topic has no columns, indexes or foreign keys, and says so with empty lists", async () => {
    const detail = await openProvider().describeObject(["plant/line1/state"], "topic");
    expect(detail).toEqual({ path: ["plant/line1/state"], columns: [], indexes: [], foreignKeys: [] });
    await expect(openProvider().describeObjects([], "topic")).resolves.toEqual({ details: [] });
  });

  test("an undeclared kind is refused by every object surface", () => {
    expect(() => listMqttObjects("table")).toThrow(/declares no object kind/);
    expect(() => describeMqttObject([], "table")).toThrow(/declares no object kind/);
    expect(() => describeMqttObjects("table")).toThrow(/declares no object kind/);
    expect(() => mqttSourceDocument([], "table", undefined)).toThrow(/declares no object kind/);
  });

  /**
   * The Source tab opens a second read scoped to that one topic, which is the only read that keeps a payload.
   * The tree itself holds names only: a payload held per row is what makes a reader slow enough for a broker
   * to start dropping on its behalf.
   */
  test("the Source tab carries the payload and the facts, each in its own part", async () => {
    const provider = openProvider({}, [CONNACK, SUBACK, publish("plant/line1/state", '{"v":1}')]);
    await provider.connect();
    const document = await provider.readObjectSource!(["plant/line1/state"], "topic");
    expect(document.path).toEqual(["plant/line1/state"]);
    expect(document.parts).toHaveLength(2);
    const payload = document.parts[0] as Record<string, unknown>;
    expect(payload.label).toBe("Payload");
    expect(payload.language).toBe("json");
    expect(payload.text).toBe('{"v":1}');
    // `partial`, because this is the last message the broker sent and not the topic's history.
    expect(payload.form).toBe("partial");
    expect(payload.origin).toBe("stored");
    const metadata = document.parts[1] as Record<string, unknown>;
    expect(metadata.label).toBe("Metadata");
    // Real JSON, because the Source tab's caption says a rendered part is JSON and the body must be what
    // the caption claims: an earlier version was three plain-text lines under that sentence.
    expect(metadata.language).toBe("json");
    const facts = JSON.parse(String(metadata.text)) as Record<string, unknown>;
    expect(facts.retained).toBe(true);
    expect(facts.payloadBytes).toBe(7);
  });

  /**
   * A topic the broker did not send is not a topic that is absent, and the sentence has to say that: MQTT
   * delivers a retained message at subscribe time and a live one when it is published, and neither is a
   * listing a client can ask for.
   */
  test("a topic the read did not see gets the broker's own reason, not an empty payload", () => {
    const document = mqttSourceDocument(["ghost/topic"], "topic", undefined);
    const part = document.parts[0] as Record<string, unknown>;
    expect(part.label).toBe("Payload");
    expect(String(part.unavailable)).toMatch(/not a topic that is absent/);
    expect(part.text).toBeUndefined();
  });

  test("a message with no lifetime says the broker named none, rather than showing a zero", () => {
    const row: MqttTopicRow = { retained: true, payloadBytes: 3 };
    const facts = JSON.parse(
      String((mqttSourceDocument(["a"], "topic", row).parts[1] as Record<string, unknown>).text),
    ) as Record<string, unknown>;
    // Null, not zero: the broker named no lifetime, which is not the same as naming none left.
    expect(facts.lifetimeSeconds).toBeNull();
    expect(String(facts.lifetimeNote)).toMatch(/carried no Message Expiry Interval/);
  });

  test("a lifetime is reported as the server's answer, with the reason nothing is computed from it", () => {
    const row: MqttTopicRow = { retained: false, payloadBytes: 3, lifetimeSeconds: 1000 };
    const facts = JSON.parse(
      String((mqttSourceDocument(["a"], "topic", row).parts[1] as Record<string, unknown>).text),
    ) as Record<string, unknown>;
    expect(facts.lifetimeSeconds).toBe(1000);
    expect(String(facts.lifetimeNote)).toMatch(/The server's own answer/);
    expect(String(facts.lifetimeNote)).toMatch(/nothing is computed from it/);
  });

  test("an empty payload renders as empty text rather than as the string 'undefined'", () => {
    const row: MqttTopicRow = { retained: true, payloadBytes: 0 };
    const part = mqttSourceDocument(["a"], "topic", row).parts[0] as Record<string, unknown>;
    expect(part.text).toBe("");
  });
});

describe("health and overview say what a broker can and cannot answer", () => {
  test("before a read, health reports not connected rather than healthy", async () => {
    const health = await openProvider().getHealth();
    expect(health.databaseSize).toBe("unknown");
    expect(health.cacheHitRatio).toBe("unknown");
    expect(health.slowQueries).toEqual([]);
    expect(health.activeSessions).toEqual([]);
  });

  test("after a read, health reports the topics that read saw", async () => {
    const provider = openProvider();
    await provider.connect();
    const health = await provider.getHealth();
    expect(health.databaseSize).toBe("2 topics");
  });

  test("the overview names the protocol version and no table or index count", async () => {
    const provider = openProvider();
    await provider.connect();
    const overview = await provider.getOverview();
    expect(overview.version).toBe("MQTT 5.0");
    expect(overview.uptime).toBe("unknown");
    expect(overview.tableCount).toBe(0);
    expect(overview.indexCount).toBe(0);
    expect(overview.databaseSize).toMatch(/2 topics seen in the last read/);
  });

  test("every statistics surface answers an empty list, because a broker publishes none", async () => {
    const provider = openProvider();
    await expect(provider.getPerformanceMetrics()).resolves.toEqual({});
    await expect(provider.getSlowQueries()).resolves.toEqual([]);
    await expect(provider.getActiveSessions()).resolves.toEqual([]);
    await expect(provider.getTableStats()).resolves.toEqual([]);
    await expect(provider.getIndexStats()).resolves.toEqual([]);
    await expect(provider.getStorageStats()).resolves.toEqual([]);
  });

  test("maintenance is refused with the structural reason", async () => {
    await expect(openProvider().runMaintenance()).rejects.toThrow(/no code that can write/);
  });
});

describe("the broker ends the read itself", () => {
  test("a server DISCONNECT is reported as one, and the scope is incomplete", async () => {
    // DISCONNECT, reason code 0x8B (Server shutting down), no properties.
    const disconnect = Buffer.from([0xe0, 0x02, 0x8b, 0x00]);
    const provider = openProvider({}, [CONNACK, SUBACK, publish("a/b", "1"), disconnect]);
    await provider.connect();
    const page = await provider.scanKeysPage!({ cursor: "0", count: 10 });
    expect(page.readOutcome?.scope).toBe("incomplete");
    expect(page.readOutcome?.endReason).toMatch(/broker closed the connection/);
    expect(page.keys).toEqual(["a/b"]);
  });
});

describe("the real transport, against a loopback server", () => {
  const servers: Server[] = [];
  afterAll(() => {
    for (const server of servers) server.close();
  });

  /** A server that accepts and says nothing, so the dial runs and the handshake times out. */
  function silentServer(): Promise<number> {
    return new Promise((resolve) => {
      const server = createServer(() => {});
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
  }

  /**
   * This covers the dial path itself, which no scripted transport can: a provider whose socket code is never
   * run by a test is a provider whose first real connection is its first test.
   */
  test("a plain TCP dial reaches a listening server", async () => {
    const port = await silentServer();
    const provider = new MqttProvider(connection({ port }));
    // The dial succeeds and the server then says nothing, which must fail rather than resolve an empty
    // tree: a broker that never sent CONNACK never agreed to speak MQTT, and "no topics" would be a wrong
    // answer rather than an empty one.
    await expect(provider.connect()).rejects.toThrow(/sent no CONNACK/);
  }, 20_000);

  test("a closed port is reported as unreachable, naming the transport error", async () => {
    const port = await silentServer();
    await new Promise<void>((resolve) => {
      servers[servers.length - 1]!.close(() => resolve());
    });
    const provider = new MqttProvider(connection({ port }));
    await expect(provider.connect()).rejects.toThrow(/could not be reached/);
  }, 20_000);

  /**
   * NODE REFUSES AN IP LITERAL AS A SERVER NAME, and the first version passed the host straight through:
   * measured against the lab's TLS brokers on 18883 and 11885, every TLS connection to `127.0.0.1` failed
   * with "Setting the TLS ServerName to an IP address is not permitted", with and without certificate
   * verification. TLS to an address rather than a hostname did not work at all, and no unit test saw it
   * because none opened a real TLS socket.
   */
  test("a broker addressed by IP is sent a name that cannot resolve, never the address", () => {
    for (const address of ["127.0.0.1", "10.0.0.7", "::1", "fe80::1"]) {
      expect(tlsServerName(address)).toBe(MQTT_IP_SERVER_NAME);
    }
    // What RFC 6761 reserves `.invalid` for: a name guaranteed not to resolve.
    expect(MQTT_IP_SERVER_NAME.endsWith(".invalid")).toBe(true);
  });

  test("a hostname is sent as typed, because SNI and verification both read it", () => {
    for (const host of ["broker.example.com", "localhost", "mqtt.internal"]) {
      expect(tlsServerName(host)).toBe(host);
    }
  });

  /**
   * A LISTENING SOCKET THAT ANSWERS NOTHING USED TO HANG THE READ FOREVER. Every timer started in the
   * session's ready handler, which fires on `secureConnect` for a TLS dial, so a server that accepted the
   * TCP connection and never finished the handshake reached no timer at all and the promise never settled:
   * a connection dialog that spins with no error. The dial now carries its own clock.
   */
  test("a TLS dial that never completes its handshake fails on the clock, it does not hang", async () => {
    const port = await silentServer();
    const provider = new MqttProvider(connection({ port, ssl: { mode: "require" } }));
    const started = Date.now();
    await expect(provider.connect()).rejects.toThrow(/did not finish the TLS handshake/);
    // Bounded by the connect timeout, not by the caller giving up.
    expect(Date.now() - started).toBeLessThan(MQTT_CONNECT_TIMEOUT_MS + 5_000);
  }, 30_000);
});

/**
 * A credential never crosses the network in the clear without the reader saying so (#1635).
 *
 * THE DIALOG PROMISED THIS AND NO CODE DID IT. The password hint and the override box both told the reader
 * that a password sent without TLS to a host that is not this machine "is refused unless this is ticked", and
 * `sessionOptions()` never read `allowInsecureAuth` at all: driven through the real provider, a password typed
 * against a remote broker with the SSL mode on `disable` reached the wire inside the CONNECT packet with the
 * box unticked. Every other engine carrying a secret calls `plaintextSecretRefusal`; this one called nothing.
 *
 * The exemptions are the helper's, shared with those engines: loopback, TLS, an SSH tunnel, or no secret.
 */
describe("a password without TLS", () => {
  const refuse: MqttTransportFactory = () => {
    throw new QueryError("the dial is refused once it has been reached", "mqtt");
  };
  const open = (over: Record<string, unknown>): MqttProvider =>
    new MqttProvider(connection({ host: "broker.example.net", user: "sensor", ...over }), {}, refuse);

  test("to a remote broker is refused, and the refusal names the box that allows it", async () => {
    const attempt = open({ password: "s3cret", ssl: { mode: "disable" } }).connect();
    await expect(attempt).rejects.toThrow(DatabaseConfigError);
    await expect(open({ password: "s3cret", ssl: { mode: "disable" } }).connect()).rejects.toThrow(
      /without TLS to a host that is not this machine/,
    );
    // The remedy, and the box, both named: a refusal with no way forward is a dead end.
    await expect(open({ password: "s3cret", ssl: { mode: "disable" } }).connect()).rejects.toThrow(
      /Send the password without TLS/,
    );
  });

  /**
   * Refused BEFORE the dial, which is the whole point: a refusal after the socket opens has already sent the
   * CONNECT. `refuse` throws the moment it is called, so reaching it is how we know the check passed.
   */
  test("is refused before any socket is opened", async () => {
    let dialled = 0;
    const counting: MqttTransportFactory = () => {
      dialled += 1;
      throw new QueryError("dialled", "mqtt");
    };
    const provider = new MqttProvider(
      connection({ host: "broker.example.net", user: "sensor", password: "s3cret", ssl: { mode: "disable" } }),
      {},
      counting,
    );
    await expect(provider.connect()).rejects.toThrow(DatabaseConfigError);
    expect(dialled).toBe(0);
  });

  test("is allowed once the reader ticks the box, which is what the box is for", async () => {
    await expect(
      open({ password: "s3cret", ssl: { mode: "disable" }, allowInsecureAuth: true }).connect(),
    ).rejects.toThrow(/the dial is refused once it has been reached/);
  });

  /** The exemptions, each one a case where the credential does not cross an untrusted path. */
  test("is allowed to this machine, under TLS, through a tunnel, and when there is no password", async () => {
    const reached = /the dial is refused once it has been reached/;
    // Loopback: the password does not leave the host.
    await expect(
      new MqttProvider(
        connection({ host: "127.0.0.1", user: "sensor", password: "s3cret", ssl: { mode: "disable" } }),
        {},
        refuse,
      ).connect(),
    ).rejects.toThrow(reached);
    // TLS: the password is encrypted.
    await expect(open({ password: "s3cret", ssl: { mode: "require" } }).connect()).rejects.toThrow(reached);
    // A tunnel carries it.
    await expect(
      open({ password: "s3cret", ssl: { mode: "disable" }, sshTunnel: { enabled: true } }).connect(),
    ).rejects.toThrow(reached);
    // And with no password there is nothing to protect.
    await expect(open({ ssl: { mode: "disable" } }).connect()).rejects.toThrow(reached);
  });
});

/**
 * The SSL / TLS panel draws a CA certificate, a client certificate and a key for every engine with TLS.
 *
 * ALL THREE WERE DRAWN AND DISCARDED. `dialBroker` passed only `servername` and `rejectUnauthorized`, so a
 * broker signed by a private CA was unreachable in `verify-ca` with the CA pasted into the box, and a broker
 * asking for a client certificate refused the handshake with the certificate on screen.
 */
describe("the TLS panel's certificate boxes", () => {
  test("reach the dial as ca, cert and key", async () => {
    const seen: Record<string, unknown>[] = [];
    const record: MqttTransportFactory = (options) => {
      seen.push(options as unknown as Record<string, unknown>);
      throw new QueryError("the dial is refused once it has been seen", "mqtt");
    };
    await expect(
      new MqttProvider(
        connection({
          ssl: {
            mode: "verify-ca",
            caCert: "-----BEGIN CERTIFICATE-----ca-----END CERTIFICATE-----",
            clientCert: "-----BEGIN CERTIFICATE-----client-----END CERTIFICATE-----",
            clientKey: "-----BEGIN PRIVATE KEY-----key-----END PRIVATE KEY-----",
          },
        }),
        {},
        record,
      ).connect(),
    ).rejects.toThrow();

    expect(seen[0]?.caCert).toContain("ca");
    expect(seen[0]?.clientCert).toContain("client");
    expect(seen[0]?.clientKey).toContain("key");

    // And the production dial hands each one to Node under the name `tls.connect` reads.
    const source = readFileSync(
      path.join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "..",
        "src",
        "lib",
        "db",
        "providers",
        "keyvalue",
        "mqtt",
        "session.ts",
      ),
      "utf8",
    );
    for (const pair of ["{ ca: options.caCert }", "{ cert: options.clientCert }", "{ key: options.clientKey }"]) {
      expect(source).toContain(pair);
    }
  });

  test("an empty box is not sent as an empty certificate", async () => {
    const seen: Record<string, unknown>[] = [];
    const record: MqttTransportFactory = (options) => {
      seen.push(options as unknown as Record<string, unknown>);
      throw new QueryError("the dial is refused once it has been seen", "mqtt");
    };
    await expect(
      new MqttProvider(
        connection({ ssl: { mode: "require", caCert: "", clientCert: "", clientKey: "" } }),
        {},
        record,
      ).connect(),
    ).rejects.toThrow();
    expect(seen[0]?.caCert).toBeUndefined();
    expect(seen[0]?.clientCert).toBeUndefined();
    expect(seen[0]?.clientKey).toBeUndefined();
  });
});
