/**
 * The RabbitMQ fixture and the test-only code around it, held to the rules the live checks rest on.
 *
 * The compose services pin every image by digest, bind only loopback ports, bound their memory and raise the file
 * limit a broker with many streams needs; the seed one-shot runs the repository's own seed on a pinned Bun with the
 * repository mounted read-only; no service mounts the evidence-only configuration. The test-only publishers, the
 * `basic.get` control and the admin client exist so the provider never needs them: no module under `src/` imports
 * them, and the provider's encoder table is still exactly the read path's thirteen frames. Each rule that reads a
 * file is also run on a planted copy with one fault, so a rule that cannot fail is caught here.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ENCODERS } from "@/lib/db/providers/stream/rabbitmq/amqp/codec";
import { patternBytes, patternSha256 } from "../../../helpers/rabbitmq-body-pattern";
import {
  type AmqpRecording,
  captureNames,
  captureSecretHits,
  type ManagementExchange,
  recordingDial,
  recordingTransport,
  stubAnswers,
  stubKey,
} from "../../../helpers/rabbitmq-captures";
import {
  RABBITMQ_42_IMAGE,
  RABBITMQ_429_DIGEST,
  RABBITMQ_436_DIGEST,
  RABBITMQ_FIXTURE_IMAGE,
  RABBITMQ_NIGHTLY_IMAGE,
  RABBITMQ_SEED_IMAGE,
  liveTarget,
} from "../../../helpers/rabbitmq-live";
import { requestKey } from "../../../helpers/rabbitmq-management-stub";
import { controlMoved, parseDeliveryMetrics, rowDifferences, TAKE_COUNTERS } from "../../../helpers/rabbitmq-oracle";
import { decodeValue, encodeMessage, encodeValue, v } from "../../../helpers/rabbitmq-test-amqp10";
import {
  ByteWriter,
  contentFrames,
  FrameSplitter,
  methodFrame,
  methodId,
} from "../../../helpers/rabbitmq-test-amqp091";
import { fixturePasswords, RABBITMQ_SEED_TABLE, readerPattern, seedHash } from "../../../live/rabbitmq-seed";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

interface Service {
  readonly image?: string;
  readonly container_name?: string;
  readonly profiles?: readonly string[];
  readonly ports?: readonly string[];
  readonly volumes?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly entrypoint?: readonly string[];
  readonly working_dir?: string;
  readonly depends_on?: Readonly<Record<string, { readonly condition: string }>>;
  readonly ulimits?: { readonly nofile?: { readonly soft: number; readonly hard: number } };
  readonly healthcheck?: { readonly test?: readonly string[] };
  readonly deploy?: { readonly resources?: { readonly limits?: { readonly memory?: string; readonly cpus?: string } } };
  readonly memswap_limit?: string;
}

const COMPOSE = parseYaml(read("database-compose.yml"), { merge: true }) as { services: Record<string, Service> };
const BROKERS = [
  "rabbitmq",
  "rabbitmq-42",
  "rabbitmq-cluster-1",
  "rabbitmq-cluster-2",
  "rabbitmq-cluster-3",
  "rabbitmq-tls",
];
const SEEDS: Readonly<Record<string, string>> = { "rabbitmq-init": "rabbitmq", "rabbitmq-42-init": "rabbitmq-42" };
const PINNED_BROKER_IMAGES = [RABBITMQ_FIXTURE_IMAGE, RABBITMQ_42_IMAGE];

/** Every published port that is not bound to 127.0.0.1, across the given services. */
function exposedPorts(services: Readonly<Record<string, Service>>): string[] {
  return Object.entries(services).flatMap(([name, service]) =>
    (service.ports ?? []).filter((port) => !String(port).startsWith("127.0.0.1:")).map((port) => `${name}: ${port}`),
  );
}

/** Every host port bound by two services of the whole compose file. */
function doubleBoundPorts(services: Readonly<Record<string, Service>>): string[] {
  const owners = new Map<string, string>();
  const doubles: string[] = [];
  for (const [name, service] of Object.entries(services)) {
    for (const port of service.ports ?? []) {
      const parts = String(port).split(":");
      const host = parts.length === 3 ? `${parts[0]}:${parts[1]}` : parts[0];
      const owner = owners.get(host);
      if (owner) doubles.push(`${host}: ${owner} and ${name}`);
      else owners.set(host, name);
    }
  }
  return doubles;
}

/** The compose variables the fixture's passwords come from; a value of a password key is exactly one of them. */
const PASSWORD_VARIABLES = ["${RABBITMQ_LIVE_ADMIN_PASSWORD}", "${RABBITMQ_LIVE_FIXTURE_PASSWORD}"];
/** The first command of each broker's entrypoint, before the image's own. */
const PASSWORD_GUARD = 'test -n "$$RABBITMQ_DEFAULT_PASS" || {';

/** Every environment value whose key names a password, across the given services, as written in the file. */
function passwordValues(
  services: Readonly<Record<string, Service>>,
): { service: string; key: string; value: string }[] {
  return Object.entries(services).flatMap(([service, { environment }]) =>
    Object.entries(environment ?? {})
      .filter(([key]) => /PASS/.test(key))
      .map(([key, value]) => ({ service, key, value: String(value) })),
  );
}

describe("the compose fixture", () => {
  const services = COMPOSE.services;

  test("every RabbitMQ service exists, and only the default pair runs without a profile", () => {
    for (const name of [...BROKERS, ...Object.keys(SEEDS), "rabbitmq-tls-certs"]) expect(services[name]).toBeDefined();
    const defaults = Object.keys(services).filter((name) => name.startsWith("rabbitmq") && !services[name].profiles);
    expect(defaults.sort()).toEqual(["rabbitmq", "rabbitmq-init"]);
  });

  test("every broker runs a pinned image, and the main one is the reference the CI step and the live scripts use", () => {
    for (const name of BROKERS) expect(PINNED_BROKER_IMAGES).toContain(services[name].image as string);
    expect(services.rabbitmq.image).toBe(RABBITMQ_FIXTURE_IMAGE);
    expect(services["rabbitmq-42"].image).toBe(RABBITMQ_42_IMAGE);
    expect(services["rabbitmq-tls-certs"].image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  test("no published port is bound beyond loopback, and a planted 0.0.0.0 binding is found", () => {
    const rabbit = Object.fromEntries(Object.entries(services).filter(([name]) => name.startsWith("rabbitmq")));
    expect(exposedPorts(rabbit)).toEqual([]);
    expect(exposedPorts({ planted: { ports: ["5672:5672"] } })).toEqual(["planted: 5672:5672"]);
  });

  test("no host port of the whole compose file is bound twice, and a planted double is found", () => {
    expect(doubleBoundPorts(services)).toEqual([]);
    expect(
      doubleBoundPorts({ a: { ports: ["127.0.0.1:15692:15692"] }, b: { ports: ["127.0.0.1:15692:15672"] } }),
    ).toEqual(["127.0.0.1:15692: a and b"]);
  });

  test("every broker raises the file limit, bounds its memory without swap and is probed by rabbitmq-diagnostics", () => {
    for (const name of BROKERS) {
      const service = services[name];
      expect(service.ulimits?.nofile).toEqual({ soft: 65536, hard: 65536 });
      expect(service.deploy?.resources?.limits?.memory).toBe("1G");
      expect(service.memswap_limit).toBe("1G");
      expect(service.healthcheck?.test).toEqual(["CMD", "rabbitmq-diagnostics", "-q", "check_port_connectivity"]);
    }
  });

  test("every broker mounts the plugin list read-only, and the list enables the queue check's plugin", () => {
    for (const name of BROKERS) {
      expect(services[name].volumes).toContain("./docker/rabbitmq/enabled_plugins:/etc/rabbitmq/enabled_plugins:ro");
    }
    expect(read("docker/rabbitmq/enabled_plugins").trim()).toBe(
      "[rabbitmq_management,rabbitmq_prometheus,rabbitmq_stream_management].",
    );
  });

  test("no service mounts the evidence-only configuration, which restores guest's localhost-only rule", () => {
    const mounts = Object.values(services).flatMap((service) => service.volumes ?? []);
    expect(mounts.filter((mount) => String(mount).includes("docker/rabbitmq/evidence"))).toEqual([]);
  });

  test("no RabbitMQ service writes a password: each names its compose variable, with no default, and a planted literal is found", () => {
    const rabbit = Object.fromEntries(Object.entries(services).filter(([name]) => name.startsWith("rabbitmq")));
    expect(passwordValues(rabbit).length).toBeGreaterThan(0);
    expect(passwordValues(rabbit).filter(({ value }) => !PASSWORD_VARIABLES.includes(value))).toEqual([]);
    expect(
      passwordValues({
        planted: {
          environment: {
            RABBITMQ_DEFAULT_PASS: "planted-value",
            RABBITMQ_LIVE_ADMIN_PASSWORD: "${RABBITMQ_LIVE_ADMIN_PASSWORD:-x}",
          },
        },
      }).filter(({ value }) => !PASSWORD_VARIABLES.includes(value)),
    ).toHaveLength(2);
  });

  test("every broker refuses to start without the admin password, which RabbitMQ would replace by its default", () => {
    for (const name of BROKERS) {
      const entry = services[name].entrypoint ?? [];
      expect({ name, guarded: String(entry[2]).startsWith(PASSWORD_GUARD) }).toEqual({ name, guarded: true });
    }
  });

  test("each seed one-shot runs the repository's seed on the pinned Bun, read-only, after its broker is healthy", () => {
    for (const [name, broker] of Object.entries(SEEDS)) {
      const service = services[name];
      expect(service.image).toBe(RABBITMQ_SEED_IMAGE);
      expect(service.volumes?.length).toBeGreaterThan(0);
      for (const mount of service.volumes ?? []) expect(String(mount).endsWith(":ro")).toBe(true);
      expect(service.entrypoint).toEqual(["bun", "tests/live/rabbitmq-seed.ts"]);
      expect(service.depends_on?.[broker]).toEqual({ condition: "service_healthy" });
      expect(service.environment?.RABBITMQ_LIVE_HOST).toBe(broker);
      expect(`${String(services[broker].image).split("@")[1]}`).toBe(
        service.environment?.RABBITMQ_LIVE_DIGEST as string,
      );
    }
  });
});

describe("the live target", () => {
  test("the live target refuses a digest that is not pinned, and needs both passwords", () => {
    const env = { RABBITMQ_LIVE_ADMIN_PASSWORD: "a", RABBITMQ_LIVE_FIXTURE_PASSWORD: "b" };
    expect(liveTarget({ ...env, RABBITMQ_LIVE_DIGEST: RABBITMQ_436_DIGEST }).managementPort).toBe(15672);
    expect(liveTarget({ ...env, RABBITMQ_LIVE_DIGEST: RABBITMQ_429_DIGEST }).amqpPort).toBe(5672);
    expect(() => liveTarget({ ...env, RABBITMQ_LIVE_DIGEST: "sha256:0" })).toThrow("must be one of the pinned digests");
    expect(() => liveTarget({ RABBITMQ_LIVE_DIGEST: RABBITMQ_436_DIGEST })).toThrow(
      "RABBITMQ_LIVE_ADMIN_PASSWORD is not set",
    );
    expect(() =>
      liveTarget({ ...env, RABBITMQ_LIVE_DIGEST: RABBITMQ_436_DIGEST, RABBITMQ_LIVE_AMQP_PORT: "0" }),
    ).toThrow("RABBITMQ_LIVE_AMQP_PORT must be a port number");
  });
});

describe("the live scripts and their test-only helpers", () => {
  const LIVE = readdirSync(path.join(ROOT, "tests/live")).filter((file) => file.startsWith("rabbitmq-"));
  const HELPERS = readdirSync(path.join(ROOT, "tests/helpers")).filter((file) => file.startsWith("rabbitmq-"));

  test("the seed, the live checks and the helpers never call docker exec", () => {
    const sources = [...LIVE.map((file) => `tests/live/${file}`), ...HELPERS.map((file) => `tests/helpers/${file}`)];
    expect(sources).toContain("tests/helpers/rabbitmq-test-amqp091.ts");
    expect(sources.filter((file) => /docker["'`,\s]+exec|docker exec/.test(read(file)))).toEqual([]);
  });

  test("no module under src/ imports a test-only publisher, the basic.get control or the admin client", () => {
    const walk = (dir: string): string[] =>
      readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(`${dir}/${entry.name}`)
          : /\.(ts|tsx)$/.test(entry.name)
            ? [`${dir}/${entry.name}`]
            : [],
      );
    const files = walk("src");
    expect(files.length).toBeGreaterThan(500);
    const forbidden =
      /from\s+["'][^"']*(tests\/|rabbitmq-test-amqp|rabbitmq-basic-get|rabbitmq-live|rabbitmq-oracle|rabbitmq-seed)/;
    expect(files.filter((file) => forbidden.test(read(file)))).toEqual([]);
    expect(forbidden.test('import { basicGetOnce } from "../../tests/helpers/rabbitmq-basic-get";')).toBe(true);
  });

  test("the provider's encoder table is still the read path's thirteen frames", () => {
    expect(Object.keys(ENCODERS).sort()).toEqual(
      [
        "basic.ack",
        "basic.cancel-ok",
        "basic.consume",
        "basic.qos",
        "channel.close-ok",
        "channel.open",
        "connection.close",
        "connection.close-ok",
        "connection.open",
        "connection.start-ok",
        "connection.tune-ok",
        "heartbeat",
        "protocol-header",
      ].sort(),
    );
  });
});

describe("the body pattern", () => {
  test("its digest, computed block by block, is the digest of its bytes", () => {
    expect(patternSha256("st-orders/7", 70_000)).toBe(
      createHash("sha256").update(patternBytes("st-orders/7", 70_000)).digest("hex"),
    );
    expect(patternBytes("x", 33)).toHaveLength(33);
  });
});

describe("the test-only AMQP 0-9-1 publisher's encoding", () => {
  test("a method frame is type, channel, size, class, method, arguments and 0xCE", () => {
    expect([...methodFrame(1, 85, 10, (w) => w.u8(0))]).toEqual([1, 0, 1, 0, 0, 0, 5, 0, 85, 0, 10, 0, 0xce]);
  });

  test("a field table writes every tag RabbitMQ reads, and an empty, __proto__ or repeated name as given", () => {
    const table = new ByteWriter()
      .table([
        ["__proto__", { t: "S", v: "p" }],
        ["", { t: "t", v: true }],
        ["n", { t: "l", v: BigInt("9007199254740993") }],
        ["n", { t: "V" }],
      ])
      .bytes();
    expect(Buffer.from(table).toString("hex")).toBe(
      "00000021095f5f70726f746f5f5f530000000170007401016e6c0020000000000001016e56",
    );
  });

  test("a body is split into frames that fit the negotiated frame size", () => {
    const frames = contentFrames(1, { contentType: "text/plain" }, new Uint8Array(300), 136);
    expect(frames.map((frame) => frame[0])).toEqual([2, 3, 3, 3]);
    expect(frames.slice(1).map((frame) => frame.length - 8)).toEqual([128, 128, 44]);
  });

  test("the frame splitter returns whole frames across chunk boundaries and refuses a bad frame end", () => {
    const bytes = methodFrame(0, 10, 41, (w) => w.shortstr(""));
    const splitter = new FrameSplitter();
    expect(splitter.push(bytes.subarray(0, 5))).toEqual([]);
    const [frame] = splitter.push(bytes.subarray(5));
    expect(methodId(frame.payload)).toEqual({ classId: 10, methodId: 41 });
    const bad = bytes.slice();
    bad[bad.length - 1] = 0;
    expect(() => new FrameSplitter().push(bad)).toThrow("did not end in 0xCE");
  });
});

describe("the test-only AMQP 1.0 sender's encoding", () => {
  test("an amqp-value section round-trips through the decoder", () => {
    const encoded = encodeValue(
      v.described(0x77, v.map([v.str("a"), v.int(1)], [v.str("u"), v.uuid(new Uint8Array(16).fill(1))])),
    );
    const decoded = decodeValue(encoded, 0).value as { descriptor: bigint; value: unknown[] };
    expect(decoded.descriptor).toBe(BigInt(0x77));
    expect(decoded.value.slice(0, 2)).toEqual(["a", 1]);
    expect(decodeValue(encoded, 0).next).toBe(encoded.length);
  });

  test("a message writes its sections in the standard's order", () => {
    const bytes = encodeMessage({
      messageAnnotations: [["x-a", v.str("1")]],
      properties: { contentType: "text/plain" },
      applicationProperties: [["p", v.str("ok")]],
      body: { kind: "data", sections: [new Uint8Array([1]), new Uint8Array([2])] },
      footer: [["x-f", v.str("f")]],
    });
    const codes: bigint[] = [];
    for (let at = 0; at < bytes.length; ) {
      const section = decodeValue(bytes, at);
      codes.push((section.value as { descriptor: bigint }).descriptor);
      at = section.next;
    }
    expect(codes.map(Number)).toEqual([0x72, 0x73, 0x74, 0x75, 0x75, 0x78]);
  });
});

describe("the seed table", () => {
  test("--env prints the two fixture passwords as export lines, built from parts, and seeds nothing", () => {
    const { admin, fixture } = fixturePasswords();
    expect(admin).not.toBe(fixture);
    const run = Bun.spawnSync([process.execPath, "tests/live/rabbitmq-seed.ts", "--env"], { cwd: ROOT, env: {} });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe(
      `export RABBITMQ_LIVE_ADMIN_PASSWORD=${admin}\nexport RABBITMQ_LIVE_FIXTURE_PASSWORD=${fixture}\n`,
    );
  });

  test("every queue is named once per vhost", () => {
    const keys = RABBITMQ_SEED_TABLE.map((queue) => `${queue.vhost}/${queue.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("studio-reader's pattern names every stream it may read, and no classic or quorum queue and not st-restricted", () => {
    for (const vhost of ["/", "billing"]) {
      const pattern = new RegExp(readerPattern(vhost));
      for (const queue of RABBITMQ_SEED_TABLE.filter((q) => q.vhost === vhost)) {
        expect({ name: queue.name, matched: pattern.test(queue.name) }).toEqual({
          name: queue.name,
          matched: queue.readerMay,
        });
      }
    }
    expect(RABBITMQ_SEED_TABLE.filter((queue) => queue.readerMay && queue.type !== "stream")).toEqual([]);
    expect(new RegExp(readerPattern("/")).test("st-orders-v1")).toBe(false);
  });

  test("a large body is a pattern labelled by its stream and offset", () => {
    const orders = RABBITMQ_SEED_TABLE.find((queue) => queue.name === "st-orders");
    const patterns = (orders?.messages ?? []).flatMap((message, offset) =>
      message.via === "amqp091" && message.body.kind === "pattern" ? [{ offset, body: message.body }] : [],
    );
    expect(patterns.map(({ offset, body }) => [offset, body.label, body.size])).toEqual([
      [7, "st-orders/7", 1_048_576],
      [8, "st-orders/8", 15_728_640],
    ]);
  });
});

describe("the R-S1 oracle's arithmetic", () => {
  const types = TAKE_COUNTERS.map((counter) => `# TYPE rabbitmq_detailed_${counter} counter`).join("\n");
  const row = (vhost: string, queue: string, gets: number) =>
    `rabbitmq_detailed_queue_get_total{vhost="${vhost}",queue="${queue}"} ${gets}\nrabbitmq_detailed_queue_get_ack_total{vhost="${vhost}",queue="${queue}"} 0`;

  test("a family without its TYPE lines is a broken oracle, not an empty one", () => {
    expect(() => parseDeliveryMetrics("", "/")).toThrow("The oracle is broken");
  });

  test("rows are read for the one vhost asked, with escaped label values", () => {
    const text = [
      types,
      row("/", "q-a", 0),
      row("billing", "q-a", 9),
      row("/", 'q "quoted"', 1).replaceAll('q "quoted"', 'q \\"quoted\\"'),
    ].join("\n");
    expect(parseDeliveryMetrics(text, "/")).toEqual({
      "q-a": { queue_get_total: 0, queue_get_ack_total: 0 },
      'q "quoted"': { queue_get_total: 1, queue_get_ack_total: 0 },
    });
  });

  test("a row that appears, moves or disappears is a difference, and an unchanged absence is not", () => {
    const before = { a: { queue_get_total: 0 }, b: { queue_get_total: 0 } };
    expect(rowDifferences(["a", "b", "c"], before, before)).toEqual([]);
    expect(rowDifferences(["a", "c"], before, { a: { queue_get_total: 1 }, c: { queue_get_total: 0 } })).toEqual([
      'a: {"queue_get_total":0} -> {"queue_get_total":1}',
      'c: null -> {"queue_get_total":0}',
    ]);
  });

  test("the control passes only when queue_get_total moved by one and nothing else in the row moved", () => {
    expect(controlMoved({}, { canary: { queue_get_total: 1, queue_get_empty_total: 0 } }, "canary")).toBeNull();
    expect(controlMoved({}, {}, "canary")).toContain("by 0, not 1");
    expect(controlMoved({}, { canary: { queue_get_total: 1, queue_get_empty_total: 1 } }, "canary")).toContain(
      "also moved queue_get_empty_total",
    );
  });
});

describe("the capture seams", () => {
  const WHOAMI = "http://127.0.0.1:15672/api/whoami";
  const TYPE_CHECK =
    "http://127.0.0.1:15672/api/queues/%2F/st-orders?disable_stats=true&columns=type%2Conline%2Cmembers";

  /** A management transport factory that answers each URL with the next status of its list. */
  function answering(statuses: Record<string, number[]>) {
    return () => ({
      request: async (request: { readonly url: string }) => ({
        status: statuses[request.url]?.shift() ?? 599,
        contentType: "application/json",
        retryAfter: null,
        text: `{"at":${Date.now()},"n":${Math.random()}}`,
      }),
      close: () => {},
    });
  }

  async function record(statuses: Record<string, number[]>, urls: readonly string[]): Promise<ManagementExchange[]> {
    const sink: ManagementExchange[] = [];
    const transport = recordingTransport(answering(statuses), sink)({} as never);
    for (const url of urls)
      await transport.request({ method: "GET", url, signal: new AbortController().signal, maxResponseBytes: 1024 });
    return sink;
  }

  test("a recorded exchange is keyed exactly as the management API stub keys its request", async () => {
    const sink = await record({ [WHOAMI]: [200], [TYPE_CHECK]: [200] }, [WHOAMI, TYPE_CHECK]);
    expect(sink.map(stubKey)).toEqual([
      requestKey({ method: "GET", url: WHOAMI }),
      requestKey({ method: "GET", url: TYPE_CHECK }),
    ]);
    expect(sink.map(stubKey)).toEqual([
      "GET /api/whoami",
      "GET /api/queues/%2F/st-orders?columns=type,online,members&disable_stats=true",
    ]);
    expect(sink[1].query.startsWith("columns=type,online,members")).toBe(true);
  });

  test("a repeat with the same status is kept once, though its body moved; a repeat with another status is kept", async () => {
    const same = await record({ [WHOAMI]: [200, 200] }, [WHOAMI, WHOAMI]);
    expect(same.length).toBe(1);
    const header = { image: "", digest: "", version: "", seed: "", date: "", surface: "planted" };
    expect(Object.keys(stubAnswers({ $captured: header, exchanges: same }))).toEqual(["GET /api/whoami"]);
    const other = await record({ [WHOAMI]: [200, 401] }, [WHOAMI, WHOAMI]);
    expect(other.map((e) => e.status)).toEqual([200, 401]);
    expect(() => stubAnswers({ $captured: header, exchanges: other })).toThrow("GET /api/whoami is recorded twice");
  });

  test("the client's connection.close marks how many server bytes had arrived", async () => {
    let onData: (chunk: Uint8Array) => void = () => {};
    const socket = {
      write: () => true,
      on: (event: string, listener: (chunk: Uint8Array) => void) => {
        if (event === "data") onData = listener;
      },
      pause: () => {},
      resume: () => {},
      destroy: () => {},
      destroyed: false,
    };
    const sink: AmqpRecording[] = [];
    const wrapped = await recordingDial(async () => socket as never, sink)({} as never, new AbortController().signal);
    wrapped.on("data", () => {});
    onData(new Uint8Array(100));
    wrapped.write(methodFrame(0, 10, 51));
    expect(sink[0].clientClosedAt).toBeNull();
    onData(new Uint8Array(20));
    wrapped.write(methodFrame(0, 10, 50));
    onData(new Uint8Array(30));
    expect(sink[0].clientClosedAt).toBe(120);
  });
});

describe("the captures", () => {
  const SETS = ["4.3.6", "4.2.9", "nightly"] as const;
  const DIGESTS: Readonly<Record<string, string>> = {
    "4.3.6": RABBITMQ_436_DIGEST,
    "4.2.9": RABBITMQ_429_DIGEST,
    nightly: RABBITMQ_NIGHTLY_IMAGE.split("@")[1],
  };
  const files = SETS.flatMap((set) =>
    (["management", "amqp"] as const).flatMap((kind) =>
      captureNames(set, kind).map((name) => ({
        set,
        kind,
        name,
        file: `tests/fixtures/rabbitmq/${set}/${kind}/${name}.json`,
      })),
    ),
  );

  test("every pinned set has captures, so the checks below cannot pass empty", () => {
    for (const set of SETS) expect(files.filter((f) => f.set === set).length).toBeGreaterThan(0);
  });

  test("every capture names the digest of its set and the seed it was taken from", () => {
    // seedHash() hashes every pattern body of the seed, megabytes each, so it is computed once.
    const seed = seedHash();
    for (const { set, file } of files) {
      const header = (JSON.parse(read(file)) as { $captured: { digest: string; seed: string; image: string } })
        .$captured;
      expect({ file, digest: header.digest, seed: header.seed }).toEqual({
        file,
        digest: DIGESTS[set],
        seed,
      });
    }
  });

  test("no capture carries a fixture password, in any form an answer could hold it", () => {
    const { admin, fixture } = fixturePasswords();
    for (const { file } of files)
      expect({ file, hits: captureSecretHits(read(file), [admin, fixture]) }).toEqual({ file, hits: [] });
  });

  test("no management capture holds a key twice, so its replay answers each request as the broker did", () => {
    for (const { kind, file } of files.filter((f) => f.kind === "management")) {
      const keys = (JSON.parse(read(file)) as { exchanges: ManagementExchange[] }).exchanges.map(stubKey);
      expect({ file, kind, repeated: keys.filter((key, at) => keys.indexOf(key) !== at) }).toEqual({
        file,
        kind,
        repeated: [],
      });
    }
  });

  test("the captures stay small enough to review: 1 MiB a file (2 MiB for h3-wide's ten 84 KB tables), 8 MiB in all", () => {
    const sizes = files.map(({ file }) => ({ file, size: statSync(path.join(ROOT, file)).size }));
    for (const { file, size } of sizes) {
      const cap = file.endsWith("/amqp/read-h3-wide-first.json") ? 2 * 1_048_576 : 1_048_576;
      expect({ file, over: size > cap }).toEqual({ file, over: false });
    }
    expect(sizes.reduce((sum, { size }) => sum + size, 0)).toBeLessThanOrEqual(8 * 1_048_576);
  });
});

describe("the CI step", () => {
  interface Step {
    readonly name?: string;
    readonly run?: string;
    readonly if?: string;
  }
  const CI = parseYaml(read(".github/workflows/ci.yml")) as {
    jobs: Record<string, { name?: string; steps: Step[] }>;
  };
  const smoke = CI.jobs["functional-smoke"];
  const names = smoke.steps.map((step) => step.name);
  const step = smoke.steps.find((s) => s.name === "RabbitMQ read-only check");
  const run = step?.run ?? "";

  test("the job keeps its id and names both engines, so a red oracle never shows under a PostgreSQL label", () => {
    expect(smoke.name).toBe("Functional Smoke (PostgreSQL, RabbitMQ)");
  });

  test("the step runs after the functional smoke, with no condition, so it cannot hide that result", () => {
    expect(names.indexOf("RabbitMQ read-only check")).toBeGreaterThan(names.indexOf("Run functional smoke"));
    expect(names.indexOf("Run functional smoke")).toBeGreaterThan(-1);
    expect(step?.if).toBeUndefined();
  });

  test("the step runs the compose fixture's image with its plugin list and file limit, on loopback ports only", () => {
    expect(run).toContain(`image="${RABBITMQ_FIXTURE_IMAGE}"`);
    expect(run).toContain("--ulimit nofile=65536:65536");
    expect(run).toContain('-v "$PWD/docker/rabbitmq/enabled_plugins:/etc/rabbitmq/enabled_plugins:ro"');
    const published = run.match(/-p \S+/g) ?? [];
    expect(published.length).toBe(3);
    for (const port of published) expect(port.startsWith("-p 127.0.0.1:")).toBe(true);
  });

  test("the broker is removed on every exit, the wait is bounded at 60 s, and the seed and the check both run", () => {
    expect(run).toContain("trap 'docker rm -f libredb-ci-rabbitmq > /dev/null' EXIT");
    expect(run).toContain("end=$((SECONDS + 60))");
    expect(run).toContain('while [ "$SECONDS" -lt "$end" ]; do');
    expect(run).toContain("The RabbitMQ broker was not ready within 60 s.");
    expect(run.indexOf("bun tests/live/rabbitmq-seed.ts")).toBeLessThan(
      run.indexOf("bun tests/live/rabbitmq-read-only.ts --dedicated"),
    );
    expect(run).not.toMatch(/RABBITMQ_LIVE_[A-Z_]*PASSWORD="?[A-Za-z0-9]/);
  });

  test("the wait asks the management API before any CLI call, so a CLI run as root cannot write the Erlang cookie first", () => {
    // The image's HOME is /var/lib/rabbitmq: a `docker exec` CLI that starts before the server creates the cookie
    // there as root with mode 0400, and the server, which runs as rabbitmq, then dies reading it (eacces).
    const wait = run.slice(run.indexOf("while"), run.indexOf("done"));
    expect(wait.indexOf("curl -fsS")).toBeGreaterThan(-1);
    expect(wait.indexOf("curl -fsS")).toBeLessThan(wait.indexOf("docker exec"));
    expect(run.slice(0, run.indexOf("while")).includes("docker exec")).toBe(false);
  });

  test("the AMQP dial's runtime cases join the Node 26.10.0 step", () => {
    const node26 = CI.jobs.test.steps.find(
      (s) => s.name?.includes("on Node 26.10.0") && s.run?.includes("NODE_TRANSPORT_NODES"),
    );
    expect(node26?.run).toContain("tests/unit/db/rabbitmq/dial-runtimes.test.ts");
  });
});
