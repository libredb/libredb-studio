/**
 * The etcd fixtures and their one reader (spec 10, gate 4; plan Contract C11): the directory is exactly the
 * catalog, every capture says which server build and which member answered it and holds no secret, the reader
 * revives what grpc-js handed over, and the recorded transport answers, refuses and cancels by C11's rules.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ETCD_FIXTURE_NAMES,
  etcdCapture,
  etcdFixture,
  type RecordedEtcdCall,
  recordedEtcdWire,
  reviveEtcdCapture,
  reviveEtcdFixture,
} from "../../../helpers/etcd-fixtures";
import { discoverTestFiles } from "../../../runner/discover";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const DIR = path.join(ROOT, "tests/fixtures/etcd");
const SERVICES = ["etcd", "etcd-cluster", "etcd-auth", "etcd-auth-password", "transport"];
const IMAGE = "gcr.io/etcd-development/etcd:v3.7.2";
const DIGEST = "sha256:7c6c239825d00e3f6328a69caafd54be92063acf0c2ce78b8394699f52b75dc3";

/** Spec E11's RPCs as "<service>/<method>" (plan C5), in its order; KV/Put is not one. */
const ALLOWLISTED_RPCS = [
  "KV/Range",
  "KV/DeleteRange",
  "KV/Txn",
  "Watch/Watch",
  "Lease/LeaseGrant",
  "Lease/LeaseRevoke",
  "Lease/LeaseKeepAlive",
  "Lease/LeaseTimeToLive",
  "Lease/LeaseLeases",
  "Cluster/MemberList",
  "Maintenance/Status",
  "Maintenance/Alarm",
  "KV/Compact",
  "Maintenance/Defragment",
  "Auth/AuthStatus",
  "Auth/Authenticate",
  "Auth/UserList",
  "Auth/UserGet",
  "Auth/RoleList",
  "Auth/RoleGet",
];

function filesOnDisk(): string[] {
  return SERVICES.flatMap((service) =>
    readdirSync(path.join(DIR, service))
      .filter((file) => file.endsWith(".json"))
      .map((file) => `${service}/${file.slice(0, -".json".length)}`),
  ).sort();
}

/** Every [key, value] pair of a parsed JSON value, at any depth. */
function entries(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.flatMap(entries);
  if (value === null || typeof value !== "object") return [];
  const pairs: Array<[string, unknown]> = [];
  for (const [key, item] of Object.entries(value)) pairs.push([key, item], ...entries(item));
  return pairs;
}

const liveCall = (signal: AbortSignal = new AbortController().signal) => ({
  metadata: { hasleader: "true" },
  deadline: new Date(0),
  signal,
});

describe("the etcd fixture directory", () => {
  test("ETCD_FIXTURE_NAMES is sorted, unique and exactly the .json files of the five service directories", () => {
    expect([...ETCD_FIXTURE_NAMES]).toEqual([...ETCD_FIXTURE_NAMES].sort());
    expect(new Set(ETCD_FIXTURE_NAMES).size).toBe(ETCD_FIXTURE_NAMES.length);
    expect(filesOnDisk()).toEqual([...ETCD_FIXTURE_NAMES]);
  });

  test("beside the five service directories there is only the README and the grammar corpus", () => {
    const others = readdirSync(DIR).filter((entry) => !SERVICES.includes(entry));
    expect(others).toContain("README.md");
    for (const entry of others) expect(["README.md", "grammar-corpus.ts"]).toContain(entry);
  });

  test("the README's catalog names every capture once, in the same order", () => {
    const readme = readFileSync(path.join(DIR, "README.md"), "utf8");
    const block = readme.slice(
      readme.indexOf("<!-- generated:catalog -->"),
      readme.indexOf("<!-- /generated:catalog -->"),
    );
    const listed = [...block.matchAll(/^\| `([^`]+)\.json` \|/gm)].map((match) => match[1]);
    expect(listed).toEqual([...ETCD_FIXTURE_NAMES]);
  });

  test("every capture names its server build, the member that answered, its runtime and an allowlisted RPC", () => {
    for (const name of ETCD_FIXTURE_NAMES) {
      const { $captured: captured, outcome } = etcdCapture(name);
      const where = { name };
      expect({ ...where, service: captured.service }).toEqual({ ...where, service: name.split("/")[0] as never });
      if (captured.service === "transport") {
        expect({ ...where, image: captured.image, digest: captured.digest }).toEqual({
          ...where,
          image: "none",
          digest: "none",
        });
      } else {
        expect({ ...where, image: captured.image, digest: captured.digest }).toEqual({
          ...where,
          image: IMAGE,
          digest: DIGEST,
        });
      }
      expect({ ...where, clusterId: captured.clusterId }).toEqual({
        ...where,
        clusterId: expect.stringMatching(/^(\d+|none)$/),
      });
      expect({ ...where, memberId: captured.memberId }).toEqual({
        ...where,
        memberId: expect.stringMatching(/^(\d+|none)$/),
      });
      if (captured.memberId === "none") expect({ ...where, outcome }).toEqual({ ...where, outcome: "fail" });
      expect(Number.isNaN(Date.parse(captured.date))).toBe(false);
      const runtime = name.endsWith(".bun")
        ? /^bun \d+\.\d+\.\d+$/
        : name.endsWith(".node")
          ? /^node \d+\.\d+\.\d+$/
          : /^bun \d+\.\d+\.\d+( and node \d+\.\d+\.\d+)?$/;
      expect({ ...where, runtime: captured.runtime }).toEqual({ ...where, runtime: expect.stringMatching(runtime) });
      expect({ ...where, allowlisted: ALLOWLISTED_RPCS.includes(captured.rpc) }).toEqual({
        ...where,
        allowlisted: true,
      });
    }
  });

  test("every capture split per runtime is one no member answered, so neither is ever searched", () => {
    const split = ETCD_FIXTURE_NAMES.filter((name) => /\.(bun|node)$/.test(name));
    expect(split.length).toBeGreaterThan(0);
    for (const name of split) {
      expect({ name, memberId: etcdCapture(name).$captured.memberId }).toEqual({ name, memberId: "none" });
    }
  });

  test("no capture holds a password, a token, a private key or a certificate", () => {
    for (const name of ETCD_FIXTURE_NAMES) {
      const raw = readFileSync(path.join(DIR, `${name}.json`), "utf8");
      expect({ name, pem: /-----BEGIN|PRIVATE KEY/.test(raw) }).toEqual({ name, pem: false });
      for (const [key, value] of entries(JSON.parse(raw))) {
        if (key === "password") expect({ name, value }).toEqual({ name, value: "<password>" });
        if (key === "token") expect({ name, value }).toEqual({ name, value: "<token>" });
      }
    }
  });

  test("the seeded Secret's marker is in the captured bytes, so E9's tests have something to hunt for", () => {
    const answer = etcdFixture<{ kvs: Array<{ key: Buffer; value: Buffer }> }>("etcd/range-prefix-registry");
    const secret = answer.kvs.find((kv) => kv.key.toString() === "/registry/secrets/default/db-creds");
    expect(secret?.value.includes("libredb-fixture-secret")).toBe(true);
  });

  test("the slash-less Secret holds the marker in base64 under the data entry marker, as seed.sh writes it", () => {
    // Named password, the entry failed the required Secret Scan: its gitleaks decodes a capture's base64.
    const answer = etcdFixture<{ kvs: Array<{ key: Buffer; value: Buffer }> }>("etcd/range-prefix-registry-slashless");
    const legacy = answer.kvs.find((kv) => kv.key.toString() === "registry/secrets/default/legacy");
    expect(JSON.parse(legacy?.value.toString() ?? "null")?.data).toEqual({
      marker: Buffer.from("libredb-fixture-secret").toString("base64"),
    });
  });

  test("the evidence harness exists and bun run test never runs it", () => {
    expect(existsSync(path.join(ROOT, "tests/live/etcd-evidence.ts"))).toBe(true);
    expect(discoverTestFiles(ROOT).filter((file) => file.startsWith("tests/live/"))).toEqual([]);
  });
});

describe("what the captures show, as the README says", () => {
  type Failure = Error & { code: number; details: string };
  type Range = { kvs: Array<{ key: Buffer; value: Buffer; version: string }> };
  type Watch = { messages: Array<{ events: Array<{ type: string; kv: { value: Buffer } }> }> };

  test("a long run of one byte is revived whole: the two size rows' requests and the value of /values/large", () => {
    const put = (name: string) =>
      (etcdCapture(name).$captured.request as { success: Array<{ request_put: { value: Buffer } }> }).success[0]
        .request_put.value;
    expect(put("etcd/error-txn-request-too-large").length).toBe(1600000);
    expect(put("etcd/error-server-receive-cap").length).toBe(2200000);
    expect(put("etcd/error-server-receive-cap").every((byte) => byte === 0x78)).toBe(true);
    const large = etcdFixture<Range>("etcd/range-prefix-values").kvs.find(
      (kv) => kv.key.toString() === "/values/large",
    );
    expect(large?.value.length).toBe(300000);
    expect(large?.value.every((byte) => byte === 0x78)).toBe(true);
  });

  test("the two receive caps answer code 8 with different texts", () => {
    expect(etcdFixture<Failure>("etcd/error-server-receive-cap")).toMatchObject({
      code: 8,
      details: "grpc: received message larger than max (2200039 vs. 2097152)",
    });
    expect(etcdFixture<Failure>("etcd/error-client-receive-cap")).toMatchObject({
      code: 8,
      details: "Received message larger than max (300059 vs 65536)",
    });
  });

  test("the history rows read the first of three versions, and watch all three", () => {
    const first = etcdFixture<Range>("etcd/range-history-rev").kvs[0];
    expect({ value: first.value.toString(), version: first.version }).toEqual({ value: "1", version: "1" });
    const events = etcdFixture<Watch>("etcd/watch-history").messages.flatMap((message) => message.events);
    expect(events.map((event) => `${event.type} ${event.kv.value.toString()}`)).toEqual(["PUT 1", "PUT 2", "PUT 3"]);
  });

  test("a token issued before an auth change still reads, and a read during one is refused as old", () => {
    expect(etcdCapture("etcd-auth-password/range-token-before-auth-change").outcome).toBe("pass");
    const still = etcdFixture<Range>("etcd-auth-password/range-token-before-auth-change");
    expect(still.kvs[0].key.toString()).toBe("/app/cfg");
    expect(etcdFixture<Failure>("etcd-auth-password/error-auth-revision-old")).toMatchObject({
      code: 3,
      details: "etcdserver: revision of auth store is old",
    });
  });

  test("a deadline over a new channel to a paused member: Node waits for the pick, Bun sends the call", () => {
    const node = etcdFixture<Failure>("etcd-cluster/error-deadline-before-pick.node");
    expect(node.code).toBe(4);
    expect(node.details).toContain("Waiting for LB pick");
    expect(node.details).not.toContain("remote_addr=");
    const bun = etcdFixture<Failure>("etcd-cluster/error-deadline-before-pick.bun");
    expect(bun.code).toBe(4);
    expect(bun.details).toContain("remote_addr=");
    expect(bun.details).not.toContain("Waiting for LB pick");
  });

  test("a deadline already passed against a name that does not resolve waits for name resolution on both", () => {
    for (const runtime of ["bun", "node"]) {
      const failure = etcdFixture<Failure>(`transport/error-deadline-name-resolution.${runtime}`);
      expect({ runtime, code: failure.code }).toEqual({ runtime, code: 4 });
      expect(failure.details).toContain("waiting for name resolution");
      expect(failure.details).not.toContain("remote_addr=");
    }
  });

  test("a disarm with member id 0 clears nothing, and the one naming the member clears the alarm", () => {
    expect(etcdFixture<{ alarms: unknown[] }>("etcd-cluster/alarm-disarm-member-zero").alarms).toEqual([]);
    const cleared = etcdFixture<{ alarms: Array<{ alarm: string; memberID: string }> }>("etcd-cluster/alarm-disarm");
    expect(cleared.alarms).toEqual([
      { alarm: "NOSPACE", memberID: etcdCapture("etcd-cluster/alarm-disarm").$captured.memberId },
    ]);
  });

  test("a certificate with no Common Name is refused a read as permission denied, and an admin read as an empty user", () => {
    expect(etcdFixture<Failure>("etcd-auth/error-permission-denied-no-common-name").details).toBe(
      "etcdserver: permission denied",
    );
    expect(etcdFixture<Failure>("etcd-auth/error-user-name-empty").details).toBe("etcdserver: user name is empty");
    expect(etcdFixture<Failure>("etcd-auth-password/error-range-no-token").details).toBe(
      "etcdserver: user name is empty",
    );
  });
});

describe("reviveEtcdFixture", () => {
  test("bytes become a Buffer and a 64-bit integer its decimal string, at any depth", () => {
    const revived = reviveEtcdFixture({
      kvs: [{ key: { $bytes: "L2FwcC9jZmc=" }, create_revision: { $int64: "7587863092875085000" } }],
      more: false,
    }) as { kvs: Array<{ key: Buffer; create_revision: string }>; more: boolean };
    expect(Buffer.isBuffer(revived.kvs[0].key)).toBe(true);
    expect(revived.kvs[0].key.toString()).toBe("/app/cfg");
    expect(revived.kvs[0].create_revision).toBe("7587863092875085000");
    expect(revived.more).toBe(false);
  });

  test("an empty $bytes is an empty Buffer, and a negative $int64 keeps its sign", () => {
    expect(reviveEtcdFixture({ $bytes: "" })).toEqual(Buffer.alloc(0));
    expect(reviveEtcdFixture({ $int64: "-1" })).toBe("-1");
  });

  test("a $filled is a Buffer of its length, every byte the one it names", () => {
    const filled = reviveEtcdFixture({ value: { $filled: { byte: 120, length: 70000 } } }) as { value: Buffer };
    expect(Buffer.isBuffer(filled.value)).toBe(true);
    expect(filled.value.length).toBe(70000);
    expect(filled.value.every((byte) => byte === 120)).toBe(true);
    expect(reviveEtcdFixture({ $filled: { byte: 255, length: 1 } })).toEqual(Buffer.from([255]));
    expect(reviveEtcdFixture({ $filled: { byte: 0, length: 0 } })).toEqual(Buffer.alloc(0));
  });

  test("a $filled whose byte or length is not one, or that holds anything else, throws", () => {
    expect(() => reviveEtcdFixture({ $filled: { byte: 256, length: 1 } })).toThrow("only");
    expect(() => reviveEtcdFixture({ $filled: { byte: -1, length: 1 } })).toThrow("only");
    expect(() => reviveEtcdFixture({ $filled: { byte: 1.5, length: 1 } })).toThrow("only");
    expect(() => reviveEtcdFixture({ $filled: { byte: 1, length: -1 } })).toThrow("only");
    expect(() => reviveEtcdFixture({ $filled: { byte: 1, length: 1.5 } })).toThrow("only");
    expect(() => reviveEtcdFixture({ $filled: { byte: "120", length: 1 } })).toThrow("only");
    expect(() => reviveEtcdFixture({ $filled: { byte: 1, length: 1, extra: 1 } })).toThrow("only");
    expect(() => reviveEtcdFixture({ $filled: { byte: 1 } })).toThrow("only");
    expect(() => reviveEtcdFixture({ $filled: null })).toThrow("only");
    expect(() => reviveEtcdFixture({ $filled: { byte: 1, length: 1 }, other: 1 })).toThrow("only");
  });

  test("any other $ key, a $int64 that is not digits, bad base64 and a $ key beside others throw", () => {
    expect(() => reviveEtcdFixture({ $bigint: "1" })).toThrow("only");
    expect(() => reviveEtcdFixture({ $int64: "1.5" })).toThrow("only");
    expect(() => reviveEtcdFixture({ $bytes: "not base64!" })).toThrow("only");
    expect(() => reviveEtcdFixture({ $bytes: "", other: 1 })).toThrow("only");
    expect(() => reviveEtcdFixture({ $int64: "1", other: 1 })).toThrow("only");
  });
});

describe("reviveEtcdCapture", () => {
  const captured = { service: "etcd", request: {}, match: {} };
  const failure = { class: "Error", message: "3 INVALID_ARGUMENT: refused", code: 3, details: "refused" };

  test("a record is exactly $captured, outcome and payload", () => {
    expect(reviveEtcdCapture("etcd/x", { $captured: captured, outcome: "pass", payload: { a: 1 } }).payload).toEqual({
      a: 1,
    });
    expect(() => reviveEtcdCapture("etcd/x", { $captured: captured, outcome: "pass", payload: {}, extra: 1 })).toThrow(
      "every capture is { $captured, outcome, payload }",
    );
    expect(() => reviveEtcdCapture("etcd/x", { $captured: captured, outcome: "pass" })).toThrow(
      "every capture is { $captured, outcome, payload }",
    );
  });

  test("an outcome other than pass or fail is refused", () => {
    expect(() => reviveEtcdCapture("etcd/x", { $captured: captured, outcome: "skipped", payload: {} })).toThrow(
      "etcd/x.json has the outcome skipped",
    );
  });

  test("a capture in another service's directory is refused", () => {
    expect(() => reviveEtcdCapture("etcd-auth/x", { $captured: captured, outcome: "pass", payload: {} })).toThrow(
      "etcd-auth/x.json says it was captured on etcd",
    );
  });

  test("a failure needs its class and message", () => {
    const revived = reviveEtcdCapture("etcd/x", { $captured: captured, outcome: "fail", payload: failure });
    expect(revived.payload).toBeInstanceOf(Error);
    const typed = reviveEtcdCapture("etcd/x", {
      $captured: captured,
      outcome: "fail",
      payload: { class: "TypeError", message: "fetch failed", code: "ECONNREFUSED" },
    }).payload as Error & { code: string };
    expect({ name: typed.name, message: typed.message, code: typed.code }).toEqual({
      name: "TypeError",
      message: "fetch failed",
      code: "ECONNREFUSED",
    });
    for (const payload of [{ message: "m", code: 3 }, { class: "Error", code: 3 }, null]) {
      expect(() => reviveEtcdCapture("etcd/x", { $captured: captured, outcome: "fail", payload })).toThrow(
        "etcd/x is a failure whose payload has no class and message",
      );
    }
  });

  test("a stream's end is open, server-end or an error, and nothing else", () => {
    const stream = (end: unknown) =>
      reviveEtcdCapture("etcd/x", { $captured: captured, outcome: "pass", payload: { messages: [], end } });
    expect(stream("open").payload).toEqual({ messages: [], end: "open" });
    expect(stream("server-end").payload).toEqual({ messages: [], end: "server-end" });
    const ended = stream({ error: failure }).payload as { end: { error: Error & { code: number } } };
    expect(ended.end.error).toBeInstanceOf(Error);
    expect(ended.end.error.code).toBe(3);
    for (const end of ["closed", undefined, null, {}]) {
      expect(() => stream(end)).toThrow('etcd/x is a stream whose end is not "open", "server-end" or { error }');
    }
  });
});

describe("etcdCapture", () => {
  test("a pass revives its answer as grpc-js hands it over", () => {
    const answer = etcdFixture<{ kvs: Array<{ key: Buffer; create_revision: string }>; count: string }>(
      "etcd/range-key",
    );
    expect(answer.kvs[0].key.toString()).toBe("/app/cfg");
    expect(answer.kvs[0].create_revision).toMatch(/^\d+$/);
    expect(answer.count).toBe("1");
  });

  test("its request and match are revived too", () => {
    const { $captured } = etcdCapture("etcd/range-key");
    expect(($captured.match.key as Buffer).toString()).toBe("/app/cfg");
    expect(($captured.request as { limit: string }).limit).toBe("1");
  });

  test("a failure is an Error carrying the gRPC status's code and details", () => {
    const error = etcdFixture<Error & { code: number; details: string }>("etcd-auth/error-permission-denied");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(7);
    expect(error.details).toBe("etcdserver: permission denied");
    expect(error.message).toBe("7 PERMISSION_DENIED: etcdserver: permission denied");
  });

  test("a stream revives its messages and its end", () => {
    const quiet = etcdFixture<{ messages: Array<{ created: boolean }>; end: unknown }>("etcd/watch-quiet");
    expect(quiet.messages[0].created).toBe(true);
    expect(quiet.end).toBe("open");
    const refused = etcdFixture<{ messages: Array<{ canceled: boolean; cancel_reason: string }> }>(
      "etcd-auth/watch-permission-denied",
    );
    expect(refused.messages.at(-1)?.canceled).toBe(true);
    expect(refused.messages.at(-1)?.cancel_reason).toContain("permission denied");
  });
});

describe("recordedEtcdWire", () => {
  test("logs each channel's options and each call before it is answered", async () => {
    const wire = recordedEtcdWire({
      answers: { "Maintenance/Status": [(_, call: RecordedEtcdCall) => ({ seen: wire.calls.length, rpc: call.rpc })] },
    });
    const channel = wire.transport({ target: "dns:127.0.0.1:2379" });
    expect(await channel.unary("Maintenance/Status", {}, liveCall())).toEqual({ seen: 1, rpc: "Maintenance/Status" });
    expect(wire.opened).toEqual([{ target: "dns:127.0.0.1:2379" }]);
    expect(wire.calls).toEqual([
      { rpc: "Maintenance/Status", request: {}, metadata: { hasleader: "true" }, deadline: new Date(0) },
    ]);
  });

  test("answers from the capture whose match the request carries, the most specific first, integers by digits", async () => {
    const channel = recordedEtcdWire().transport({});
    const key = await channel.unary("KV/Range", { key: Buffer.from("/app/cfg"), limit: 1 }, liveCall());
    expect(key).toEqual(etcdFixture("etcd/range-key"));
    const cut = await channel.unary(
      "KV/Range",
      { key: Buffer.from("/app/"), range_end: Buffer.from("/app0"), limit: 2 },
      liveCall(),
    );
    expect(cut).toEqual(etcdFixture("etcd/range-prefix-app-limit-2"));
  });

  test("a request the more specific capture does not carry falls to the less specific one", async () => {
    const channel = recordedEtcdWire().transport({});
    const whole = await channel.unary(
      "KV/Range",
      { key: Buffer.from("/app/"), range_end: Buffer.from("/app0"), limit: "500" },
      liveCall(),
    );
    expect(whole).toEqual(etcdFixture("etcd/range-prefix-app"));
  });

  test("an absent field matches a default in the capture's match, as proto3 sends none", async () => {
    const { $captured } = etcdCapture("etcd/txn-guarded-create");
    const [compare] = $captured.match.compare as Array<{ key: Buffer }>;
    const channel = recordedEtcdWire().transport({});
    const created = await channel.unary(
      "KV/Txn",
      {
        compare: [{ result: "EQUAL", target: "MOD", key: compare.key }],
        success: [{ request_put: { key: compare.key, value: Buffer.from('{"v":1}') } }],
      },
      liveCall(),
    );
    expect(created).toEqual(etcdFixture("etcd/txn-guarded-create"));
  });

  test("an absent linearizable matches a capture whose match holds false, as proto3 sends a false", async () => {
    const pairs = [
      ["etcd", "etcd/member-list-serializable"],
      ["etcd-cluster", "etcd-cluster/member-list-serializable-no-leader"],
    ] as const;
    const answers = await Promise.all(
      pairs.map(([service]) => recordedEtcdWire({ service }).transport({}).unary("Cluster/MemberList", {}, liveCall())),
    );
    pairs.forEach(([, serializable], i) => {
      expect(etcdCapture(serializable).$captured.match).toEqual({ linearizable: false });
      expect(answers[i]).toEqual(etcdFixture(serializable));
    });
  });

  test("a list in the request matches only a list of the same length", async () => {
    const { $captured } = etcdCapture("etcd/txn-guarded-create");
    const [compare] = $captured.match.compare as Array<{ key: Buffer }>;
    const channel = recordedEtcdWire().transport({});
    const put = { request_put: { key: compare.key, value: Buffer.from('{"v":1}') } };
    const twoPuts = channel.unary(
      "KV/Txn",
      { compare: [{ result: "EQUAL", target: "MOD", key: compare.key }], success: [put, put] },
      liveCall(),
    );
    await expect(twoPuts).rejects.toThrow("No etcd capture answers KV/Txn");
  });

  test("a guarded put and its conflict are told apart by the value they put", async () => {
    const { $captured } = etcdCapture("etcd/txn-guarded-put");
    const [compare] = $captured.match.compare as Array<{ key: Buffer; mod_revision: string }>;
    const channel = recordedEtcdWire().transport({});
    const put = (value: string) =>
      channel.unary(
        "KV/Txn",
        {
          compare: [{ result: "EQUAL", target: "MOD", key: compare.key, mod_revision: compare.mod_revision }],
          success: [{ request_put: { key: compare.key, value: Buffer.from(value) } }],
          failure: [{ request_range: { key: compare.key, limit: "1" } }],
        },
        liveCall(),
      );
    expect(await put('{"v":2}')).toEqual(etcdFixture("etcd/txn-guarded-put"));
    expect(await put('{"v":3}')).toEqual(etcdFixture("etcd/txn-guarded-put-conflict"));
  });

  test("a fail capture rejects with its Error", async () => {
    const channel = recordedEtcdWire({ service: "etcd-auth" }).transport({});
    const refused = channel.unary("KV/Range", { key: Buffer.from("/config/b"), limit: "1" }, liveCall());
    await expect(refused).rejects.toMatchObject({ code: 7, details: "etcdserver: permission denied" });
  });

  test("no capture answering rejects, naming the rpc and the request's bytes", async () => {
    const channel = recordedEtcdWire().transport({});
    const nowhere = channel.unary("KV/Range", { key: Buffer.from("/nowhere/"), limit: "1" }, liveCall());
    await expect(nowhere).rejects.toThrow(
      'No etcd capture answers KV/Range {"key":{"$bytes":"L25vd2hlcmUv"},"limit":"1"}',
    );
  });

  test("a capture split per runtime, or one no member answered, is read by name only", async () => {
    const channel = recordedEtcdWire({ service: "etcd-auth" }).transport({});
    expect(await channel.unary("Maintenance/Status", {}, liveCall())).toEqual(etcdFixture("etcd-auth/status"));
    const transport = recordedEtcdWire({ service: "transport" }).transport({});
    await expect(transport.unary("Maintenance/Status", {}, liveCall())).rejects.toThrow("No transport capture answers");
  });

  test("answers are used in order before the captures: a fixture, a value, a throw", async () => {
    const wire = recordedEtcdWire({
      service: "etcd-cluster",
      answers: {
        "Maintenance/Status": [
          { fixture: "etcd-cluster/error-no-leader" },
          (request) => ({ echoed: request }),
          () => {
            throw new Error("refused by the test");
          },
        ],
      },
    });
    const channel = wire.transport({});
    await expect(channel.unary("Maintenance/Status", {}, liveCall())).rejects.toMatchObject({
      details: "etcdserver: no leader",
    });
    expect(await channel.unary("Maintenance/Status", { a: 1 }, liveCall())).toEqual({ echoed: { a: 1 } });
    await expect(channel.unary("Maintenance/Status", {}, liveCall())).rejects.toThrow("refused by the test");
    // Five etcd-cluster captures answer Status {} alike; with no field to prefer one, the first by name answers.
    expect(await channel.unary("Maintenance/Status", {}, liveCall())).toEqual(
      etcdFixture("etcd-cluster/status-after-defragment"),
    );
  });

  test("a signal that aborts before the answer rejects as grpc-js does, and an aborted one at once", async () => {
    const wire = recordedEtcdWire({ answers: { "KV/Range": [() => new Promise(() => undefined)] } });
    const channel = wire.transport({});
    const controller = new AbortController();
    const pending = channel.unary("KV/Range", { key: Buffer.from("/app/cfg") }, liveCall(controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 1,
      details: "Cancelled on client",
      message: "1 CANCELLED: Cancelled on client",
    });
    await expect(channel.unary("Maintenance/Status", {}, liveCall(controller.signal))).rejects.toMatchObject({
      code: 1,
    });
    expect(wire.calls.map((call) => call.rpc)).toEqual(["KV/Range", "Maintenance/Status"]);
  });

  test("a stream is chosen by its first write, yields its messages, then waits until it is cancelled", async () => {
    const wire = recordedEtcdWire();
    const stream = wire.transport({}).stream("Watch/Watch", liveCall());
    stream.write({ create_request: { key: Buffer.from("/app/"), range_end: Buffer.from("/app0"), fragment: true } });
    stream.write({ progress_request: {} });
    const expected = etcdFixture<{ messages: object[] }>("etcd/watch-quiet").messages;
    // oxlint-disable-next-line no-await-in-loop -- a stream answers in order, so each read follows the one before it.
    for (const message of expected) expect(await stream.read()).toEqual(message);
    const waiting = stream.read();
    // The read is waiting on the open stream by now, so it is the cancel that ends it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    stream.cancel();
    stream.cancel();
    await expect(waiting).rejects.toMatchObject({ code: 1, details: "Cancelled on client" });
    await expect(stream.read()).rejects.toMatchObject({ code: 1 });
    expect(wire.cancels).toEqual(["Watch/Watch"]);
    expect(wire.writes).toEqual([{ rpc: "Watch/Watch", message: { progress_request: {} } }]);
    expect(wire.calls).toHaveLength(1);
  });

  test("a server-ended stream reads undefined, an error end rejects, and an abort ends a waiting read", async () => {
    const dropped = Object.assign(new Error("14 UNAVAILABLE: Connection dropped"), {
      code: 14,
      details: "Connection dropped",
    });
    const wire = recordedEtcdWire({
      answers: {
        "Lease/LeaseKeepAlive": [
          () => ({ messages: [], end: "server-end" }),
          () => ({ messages: [], end: { error: dropped } }),
          () => ({ messages: [], end: "open" }),
        ],
      },
    });
    const channel = wire.transport({});
    const ended = channel.stream("Lease/LeaseKeepAlive", liveCall());
    ended.write({ ID: "1" });
    expect(await ended.read()).toBeUndefined();
    const failed = channel.stream("Lease/LeaseKeepAlive", liveCall());
    failed.write({ ID: "1" });
    await expect(failed.read()).rejects.toBe(dropped);
    const controller = new AbortController();
    const open = channel.stream("Lease/LeaseKeepAlive", liveCall(controller.signal));
    open.write({ ID: "1" });
    const waiting = open.read();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 1 });
    expect(wire.cancels).toEqual([]);
  });

  test("a read issued after the stream's signal aborted rejects as cancelled at once", async () => {
    const wire = recordedEtcdWire({ answers: { "Lease/LeaseKeepAlive": [() => ({ messages: [], end: "open" })] } });
    const controller = new AbortController();
    const open = wire.transport({}).stream("Lease/LeaseKeepAlive", liveCall(controller.signal));
    open.write({ ID: "1" });
    controller.abort();
    // A read that waits would leave bun with nothing to run and hang the file, so a timer bounds it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stillWaiting = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the read is still waiting")), 1000);
    });
    await expect(Promise.race([open.read(), stillWaiting])).rejects.toMatchObject({
      code: 1,
      details: "Cancelled on client",
    });
    clearTimeout(timer);
    expect(wire.cancels).toEqual([]);
  });

  test("a stream yields its messages in the order they were captured", async () => {
    const expected = etcdFixture<{ messages: object[] }>("etcd/watch-history").messages;
    expect(expected.length).toBeGreaterThan(1);
    const wire = recordedEtcdWire({ answers: { "Watch/Watch": [{ fixture: "etcd/watch-history" }] } });
    const stream = wire.transport({}).stream("Watch/Watch", liveCall());
    stream.write({ create_request: {} });
    // oxlint-disable-next-line no-await-in-loop -- a stream answers in order, so each read follows the one before it.
    for (const message of expected) expect(await stream.read()).toEqual(message);
    stream.cancel();
  });

  test("a read before the first write is refused", async () => {
    const stream = recordedEtcdWire().transport({}).stream("Watch/Watch", liveCall());
    await expect(stream.read()).rejects.toThrow("read() before the first write");
  });

  test("every channel of one wire shares its log, and each close is counted", () => {
    const wire = recordedEtcdWire();
    wire.transport({ n: 1 }).close();
    wire.transport({ n: 2 }).close();
    expect(wire.opened).toEqual([{ n: 1 }, { n: 2 }]);
    expect(wire.closes).toBe(2);
  });
});
