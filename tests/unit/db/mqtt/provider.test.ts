/**
 * The MQTT provider's own surface (`docs/providers/mqtt.md` sections 4 and 9), every declaration and refusal.
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
import { MQTT_CONNECT_TIMEOUT_MS, MQTT_DEFAULT_PORT } from "@/lib/db/providers/keyvalue/mqtt/constants";
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
   * THE SERVER NAME AND THE IDENTITY ARE TWO DIFFERENT THINGS, and this provider conflated them.
   *
   * Node refuses an IP literal as `servername`, so the first version substituted the unresolvable
   * `mqtt.invalid` - and Node then checked the CERTIFICATE against that name too, so every `verify-` mode
   * failed with `ERR_TLS_CERT_ALTNAME_INVALID` against a broker addressed by IP, however correct its IP SAN.
   * Verified TLS to an address did not work at all. The tests that stood here asserted that substitution,
   * so they pinned the defect.
   *
   * The rule is now the one `tlsAgentOptions` gives: SNI only for a DNS name, and the certificate checked
   * against the identity rather than against whatever `servername` happened to be.
   */
  test("no server name is sent for a broker addressed by IP, and the identity is still the address", () => {
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
    expect(source).toContain("...(isIP(identity) === 0 ? { servername: identity } : {})");
    expect(source).toContain("checkServerIdentity(identity, certificate)");
    // The substitution is gone from the CODE, not merely unused. Comments are stripped first, because the
    // docblock that explains the defect names it, and a test that failed on prose would fail on the fix.
    const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");
    expect(code).not.toContain("mqtt.invalid");
    expect(code).not.toContain("MQTT_IP_SERVER_NAME");
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

/**
 * Refresh means a new read (`docs/providers/mqtt.md` section 5).
 *
 * IT DID NOT. `connect()` performed one read and every page was served from it for the life of the
 * connection, so a topic retained after connect never appeared however many times the reader pressed
 * refresh - while the panel's own sentence said "Reading again, or narrowing the topic filter, sees more".
 * It read again and saw the same tree, which is the shape of silent failure this provider exists to avoid.
 *
 * The transport below answers a different broker on each dial, which is what a broker that gained a topic
 * between two reads looks like from here.
 */
describe("a refreshed page", () => {
  const CONNACK = Buffer.from([0x20, 0x03, 0x00, 0x00, 0x00]);
  const SUBACK = Buffer.from([0x90, 0x04, 0x00, 0x01, 0x00, 0x00]);

  /** One retained PUBLISH, hand-encoded. */
  function publish(topic: string): Buffer {
    const name = Buffer.from(topic, "utf8");
    const body = Buffer.concat([
      Buffer.from([(name.length >> 8) & 0xff, name.length & 0xff]),
      name,
      Buffer.from([0x00]),
      Buffer.from("x", "utf8"),
    ]);
    return Buffer.concat([Buffer.from([0x31, body.length]), body]);
  }

  /** A transport whose answer changes between dials, and that counts them. */
  function changing(scripts: readonly (readonly Buffer[])[]): { factory: MqttTransportFactory; dials: () => number } {
    let dial = 0;
    const factory: MqttTransportFactory = () => {
      const chunks = scripts[Math.min(dial, scripts.length - 1)] ?? [];
      dial += 1;
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
    return { factory, dials: () => dial };
  }

  /** The case Cevheri measured: a topic retained after connect has to appear on a refresh. */
  test("lists a topic the broker retained after connect", async () => {
    const before = [CONNACK, SUBACK, publish("fabrika/hat1/durum")];
    const after = [...before, publish("fabrika/hat2/durum")];
    const { factory, dials } = changing([before, after]);

    const provider = new MqttProvider(connection({}), {}, factory);
    await provider.connect();

    // The first page is the connect read, so opening a connection still costs one read and not two.
    const first = await provider.scanKeysPage!({ cursor: "0", count: 100 });
    expect(first.keys).toEqual(["fabrika/hat1/durum"]);
    expect(dials()).toBe(1);

    // The refresh reads the broker again, and sees what it gained.
    const refreshed = await provider.scanKeysPage!({ cursor: "0", count: 100 });
    expect([...refreshed.keys].sort()).toEqual(["fabrika/hat1/durum", "fabrika/hat2/durum"]);
    expect(dials()).toBe(2);
  });

  /** And a topic the broker no longer retains disappears, which the held read could never show. */
  test("drops a topic the broker no longer has", async () => {
    const before = [CONNACK, SUBACK, publish("gider/konu"), publish("kalir/konu")];
    const after = [CONNACK, SUBACK, publish("kalir/konu")];
    const { factory } = changing([before, after]);

    const provider = new MqttProvider(connection({}), {}, factory);
    await provider.connect();
    await provider.scanKeysPage!({ cursor: "0", count: 100 });

    const refreshed = await provider.scanKeysPage!({ cursor: "0", count: 100 });
    expect(refreshed.keys).toEqual(["kalir/konu"]);
  });

  /**
   * THE READ'S OWN ACCOUNT TRAVELS WITH IT. A refresh replaces the tree, so it has to replace the sentence
   * about that tree too: a stale "the read reached its time budget" beside a fresh list would describe a read
   * the reader is no longer looking at.
   */
  test("replaces the read's own account of itself, not only the list", async () => {
    const full = [CONNACK, SUBACK, publish("a/b")];
    const refused = [CONNACK, Buffer.from([0x90, 0x04, 0x00, 0x01, 0x00, 0x87])];
    const { factory } = changing([full, refused]);

    const provider = new MqttProvider(connection({}), {}, factory);
    await provider.connect();
    const first = await provider.scanKeysPage!({ cursor: "0", count: 100 });
    expect(first.readOutcome?.endReason).not.toMatch(/refused the subscription/);

    const refreshed = await provider.scanKeysPage!({ cursor: "0", count: 100 });
    expect(refreshed.keys).toEqual([]);
    expect(refreshed.readOutcome?.endReason).toMatch(/refused the subscription/);
    expect(refreshed.readOutcome?.scope).toBe("incomplete");
  });

  /** Health reads the same stored read, so it moves with the refresh rather than reporting the first tree. */
  test("is what Health reports afterwards", async () => {
    const before = [CONNACK, SUBACK, publish("bir/konu")];
    const after = [...before, publish("iki/konu")];
    const { factory } = changing([before, after]);

    const provider = new MqttProvider(connection({}), {}, factory);
    await provider.connect();
    await provider.scanKeysPage!({ cursor: "0", count: 100 });
    expect((await provider.getHealth()).databaseSize).toBe("1 topic");

    await provider.scanKeysPage!({ cursor: "0", count: 100 });
    expect((await provider.getHealth()).databaseSize).toBe("2 topics");
  });
  /**
   * TYPING IS NOT A REFRESH. The panel restarts its walk on every change of the pattern box, so a first page
   * with a new pattern narrows the read already held; only the same question asked again reads the broker.
   */
  test("a changed pattern filters the held read and opens no connection", async () => {
    const before = [CONNACK, SUBACK, publish("fabrika/hat1/durum"), publish("depo/raf1")];
    const after = [...before, publish("fabrika/hat2/durum")];
    const { factory, dials } = changing([before, after]);

    const provider = new MqttProvider(connection({}), {}, factory);
    await provider.connect();
    await provider.scanKeysPage!({ cursor: "0", count: 100 });
    for (const pattern of ["f", "fa", "fab", "fabrika/"]) {
      // oxlint-disable-next-line no-await-in-loop -- keystrokes arrive one after another, so each page lands first.
      const page = await provider.scanKeysPage!({ cursor: "0", count: 100, pattern });
      expect(page.keys).toEqual(["fabrika/hat1/durum"]);
    }
    expect(dials()).toBe(1);

    // The same pattern again is the refresh button, and it reads the broker.
    const refreshed = await provider.scanKeysPage!({ cursor: "0", count: 100, pattern: "fabrika/" });
    expect(refreshed.keys).toEqual(["fabrika/hat1/durum", "fabrika/hat2/durum"]);
    expect(dials()).toBe(2);
  });

  test("a reconnect costs one read, not two", async () => {
    const script = [CONNACK, SUBACK, publish("bir/konu")];
    const { factory, dials } = changing([script]);

    const provider = new MqttProvider(connection({}), {}, factory);
    await provider.connect();
    await provider.scanKeysPage!({ cursor: "0", count: 100 });
    await provider.disconnect();
    await provider.connect();
    await provider.scanKeysPage!({ cursor: "0", count: 100 });
    expect(dials()).toBe(2);
  });

  /** The broker's own refusal code reaches the panel, so the remedy is the code's and not a generic one. */
  test("a refused subscription carries the broker's code and that code's remedy to the panel", async () => {
    const refused = [CONNACK, Buffer.from([0x90, 0x04, 0x00, 0x01, 0x00, 0x87])];
    const { factory } = changing([refused]);

    const provider = new MqttProvider(connection({}), {}, factory);
    await provider.connect();
    const page = await provider.scanKeysPage!({ cursor: "0", count: 100 });
    expect(page.readOutcome?.endReason).toMatch(/0x87/);
    expect(page.readOutcome?.endReason).toMatch(/sensors\/#/);
  });
  /** A topic's Source tab subscribes to that topic byte for byte, and an empty name is not a topic. */
  test("the Source tab subscribes to the exact topic, spaces included, and refuses an empty one", async () => {
    const subscribed: string[] = [];
    const factory: MqttTransportFactory = () => {
      const handlers = new Map<string, ((value: never) => void)[]>();
      const emit = (event: string, value?: unknown): void => {
        for (const handler of handlers.get(event) ?? []) (handler as (v: unknown) => void)(value);
      };
      const transport: MqttTransport = {
        write(bytes: Buffer): void {
          // SUBSCRIBE: fixed header, a one-byte length here, packet id, empty properties, then the filter.
          if ((bytes[0] as number) >> 4 !== 8) return;
          const at = 2 + 2 + 1;
          const length = ((bytes[at] as number) << 8) | (bytes[at + 1] as number);
          subscribed.push(bytes.subarray(at + 2, at + 2 + length).toString("utf8"));
        },
        on(event: string, handler: (value: never) => void): void {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        once(event: string, handler: () => void): void {
          if (event !== "ready") return;
          queueMicrotask(() => {
            handler();
            for (const chunk of [CONNACK, SUBACK, publish(" padded ")]) emit("data", chunk);
            emit("close");
          });
        },
        destroy(): void {},
      };
      return { transport, readyEvent: "ready" };
    };

    const provider = new MqttProvider(connection({}), {}, factory);
    await provider.connect();
    const source = await provider.readObjectSource!([" padded "], "topic");
    expect(subscribed.at(-1)).toBe(" padded ");
    expect(JSON.stringify(source)).toContain('"origin":"stored"');
    await expect(provider.readObjectSource!([""], "topic")).rejects.toThrow(DatabaseConfigError);
  });

  /** The connection's typed filter is trimmed where it is read, so a stray space is not a different filter. */
  test("the connection's own filter field is trimmed before it is subscribed to", async () => {
    const subscribed: string[] = [];
    const factory: MqttTransportFactory = () => {
      const handlers = new Map<string, ((value: never) => void)[]>();
      const transport: MqttTransport = {
        write(bytes: Buffer): void {
          if ((bytes[0] as number) >> 4 !== 8) return;
          const length = ((bytes[5] as number) << 8) | (bytes[6] as number);
          subscribed.push(bytes.subarray(7, 7 + length).toString("utf8"));
        },
        on(event: string, handler: (value: never) => void): void {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
        once(event: string, handler: () => void): void {
          if (event !== "ready") return;
          queueMicrotask(() => {
            handler();
            for (const listener of handlers.get("data") ?? []) (listener as (v: unknown) => void)(CONNACK);
            for (const listener of handlers.get("data") ?? []) (listener as (v: unknown) => void)(SUBACK);
            for (const listener of handlers.get("close") ?? []) (listener as () => void)();
          });
        },
        destroy(): void {},
      };
      return { transport, readyEvent: "ready" };
    };
    const provider = new MqttProvider(connection({ database: "  sensors/#  " }), {}, factory);
    await provider.connect();
    expect(subscribed).toEqual(["sensors/#"]);
  });
});
