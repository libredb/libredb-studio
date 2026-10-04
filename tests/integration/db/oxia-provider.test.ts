/**
 * Oxia provider, end to end over the real adapter and the recorded wire (SB3-5.5).
 *
 * Every capture under tests/fixtures/oxia/ was written by tests/live/oxia-evidence.ts against a live compose fixture
 * (docker/oxia/README.md) and is held by the digest tests/fixtures/oxia/README.md records. Each run of
 * tests/live/oxia-live-support.ts is replayed here through the real `OxiaProvider` and the real adapter over
 * `recordedOxiaWire`, and must answer what the server answered; the replay opens no socket. The object-surface
 * contract (SB2-7.6) runs over the 0.16.10 conformance capture. `mock.module()` is not used.
 *
 * Servers: oxia/oxia:0.16.10 and oxia/oxia:0.17.1, each pinned by digest in the fixtures README.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseOxiaCommand } from "@/lib/db/providers/keyvalue/oxia/commands";
import { namespaceNotFoundSentence, receiveCapNotice, runBudgetNotice } from "@/lib/db/providers/keyvalue/oxia/errors";
import { createGrpcOxiaClient } from "@/lib/db/providers/keyvalue/oxia/grpc-client";
import { OxiaProvider } from "@/lib/db/providers/keyvalue/oxia/index";
import { keyOrderWords } from "@/lib/db/providers/keyvalue/oxia/labels";
import { WITHHELD_VALUE_TEXT } from "@/lib/db/providers/keyvalue/oxia/values";
import {
  OXIA_CONFORMANCE,
  OXIA_FIXTURES,
  OXIA_RUN_COMMANDS,
  OXIA_RUNS,
  OXIA_TOKEN_FILES,
  type OxiaCaptureSet,
  type OxiaFixture,
  type OxiaRun,
  type OxiaRunMaterial,
  type OxiaRunSteps,
  playOxiaRun,
} from "../../live/oxia-live-support";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import { oxiaConnection } from "../../helpers/oxia-connection";
import { loadOxiaCapture, type OxiaCapture, type RecordedCall, recordedOxiaWire } from "../../helpers/oxia-wire";
import { loadTlsFixtures } from "../../helpers/tls-fixtures";

const ROOT = path.resolve(import.meta.dir, "../../..");
const FIXTURES = path.join(ROOT, "tests/fixtures/oxia");
const SETS: readonly OxiaCaptureSet[] = [
  "0.16.10",
  "0.17.1",
  "0.16.10-natural",
  "0.16.10-natural-blind",
  "0.16.10-auth",
];

/** Every capture the README's table names: the rows `| <set>/<name>.json | <sha256> |`. */
const TABLE: readonly string[] = readFileSync(path.join(FIXTURES, "README.md"), "utf8")
  .split("\n")
  .map((line) => /^\| (\S+\/\S+\.json) \| [0-9a-f]{64} \|$/.exec(line)?.[1])
  .filter((file): file is string => file !== undefined)
  .sort();

/** The replay dials nothing: the committed throwaway CAs, because the TLS panel parses one, and a placeholder token. */
const tls = loadTlsFixtures();
const material: OxiaRunMaterial = {
  ca: tls.ca,
  otherCa: tls.otherCa,
  tokens: Object.fromEntries(OXIA_TOKEN_FILES.map((file) => [file, "replayed.token"])),
};

function fixtureOf(set: string): OxiaFixture {
  const fixture = OXIA_FIXTURES.find((row) => row.set === set);
  if (fixture === undefined) throw new Error(`no fixture for the set ${set}`);
  return fixture;
}

function runOf(name: string): OxiaRun {
  const run = OXIA_RUNS.find((row) => row.name === name);
  if (run === undefined) throw new Error(`no run named ${name}`);
  return run;
}

function split(file: string): { readonly set: string; readonly name: string } {
  return { set: path.dirname(file), name: path.basename(file, ".json") };
}

/** The auth family's sentence quotes the configured token's own expiry, so its replay is compared without it. */
function compared(name: string, summary: unknown): unknown {
  return JSON.parse(
    JSON.stringify(summary, (key, value: unknown) =>
      name.startsWith("auth-") && key === "message" ? undefined : value,
    ),
  );
}

/** The step the support module leaves to a Bun player, so that it loads under Node (ruling R30). */
const STEPS: OxiaRunSteps = { assertSurface: (provider) => assertObjectSurface(provider, OXIA_CONFORMANCE) };

/** Replays one capture through its run, and answers the summary and the wire. */
async function replay(file: string) {
  const { set, name } = split(file);
  const capture = loadOxiaCapture(file);
  const wire = recordedOxiaWire([capture]);
  const summary = await playOxiaRun(runOf(name), fixtureOf(set), material, wire.transport, STEPS);
  return { capture, wire, summary };
}

/** The recorded result of one capture, read member by member as the summary of tests/live/oxia-live-support.ts writes it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a summary is JSON of many shapes, one per run.
function result(file: string): any {
  return loadOxiaCapture(file).result;
}

function gets(call: RecordedCall): readonly { comparison_type: string; include_value: boolean; key: string }[] {
  return (call.request as { gets?: never[] }).gets ?? [];
}

function reads(capture: OxiaCapture): readonly RecordedCall[] {
  return capture.calls.filter((call) => call.method === "io.oxia.proto.v1.OxiaClient/Read");
}

/** The shard document's members, from a probe-order or probe-empty-namespace result. */
function shardDocument(file: string): Record<string, unknown> {
  return JSON.parse(result(file).ok.parts[0].text);
}

describe("Oxia captures", () => {
  test("the fixtures README lists exactly the captures on disk, and every digest holds", () => {
    const onDisk = SETS.flatMap((set) =>
      readdirSync(path.join(FIXTURES, set))
        .filter((file) => file.endsWith(".json"))
        .map((file) => `${set}/${file}`),
    ).sort();
    expect(TABLE.length).toBeGreaterThan(0);
    expect(onDisk).toEqual([...TABLE]);
    for (const file of TABLE) expect(loadOxiaCapture(file).file).toBe(file);
  });

  test("every run of the table has its capture in every set it names, and no capture is unnamed", () => {
    const named = OXIA_RUNS.flatMap((run) => run.sets.map((set) => `${set}/${run.name}.json`)).sort();
    expect(named).toEqual([...TABLE]);
  });

  test("no capture holds a token, a certificate or a key", () => {
    for (const file of TABLE) {
      const text = readFileSync(path.join(FIXTURES, file), "utf8");
      expect({ file, token: /eyJ[A-Za-z0-9_-]{10,}\./.test(text) }).toEqual({ file, token: false });
      expect({ file, pem: /-----BEGIN/.test(text) }).toEqual({ file, pem: false });
      expect({ file, bearer: /Bearer /.test(text) }).toEqual({ file, bearer: false });
      for (const call of loadOxiaCapture(file).calls) expect(typeof call.token).toBe("boolean");
    }
    const carried = TABLE.filter((file) => file.startsWith("0.16.10-auth/")).flatMap((file) =>
      loadOxiaCapture(file).calls.filter((call) => call.token === true),
    );
    expect(carried.length).toBeGreaterThan(0);
    for (const call of carried) expect(call.token).toBe(true);
  });

  test("every console command of the run table parses", () => {
    const commands = Object.entries(OXIA_RUN_COMMANDS);
    expect(commands.length).toBeGreaterThan(0);
    for (const [name, text] of commands) {
      const parsed = parseOxiaCommand(text, {});
      expect({ name, refusal: parsed.ok ? undefined : parsed.refusal }).toEqual({ name, refusal: undefined });
    }
  });

  test.each([...TABLE])("the replay of %s answers what the server answered", async (file) => {
    const { capture, wire, summary } = await replay(file);
    const { name } = split(file);
    expect(compared(name, summary)).toEqual(compared(name, capture.result));
    expect(wire.unmatched()).toEqual([]);
    expect(wire.unused()).toEqual([]);
  });

  test("satisfies the object-surface contract (SB2-7.6)", async () => {
    const fixture = fixtureOf("0.16.10");
    const wire = recordedOxiaWire([loadOxiaCapture("0.16.10/conformance.json")]);
    const colon = fixture.target.lastIndexOf(":");
    const provider = new OxiaProvider(
      oxiaConnection({ host: fixture.target.slice(0, colon), port: Number(fixture.target.slice(colon + 1)) }),
      { queryTimeout: 30_000 },
      {},
      (options) => createGrpcOxiaClient(options, wire.transport),
    );
    await provider.connect();
    try {
      await assertObjectSurface(provider, OXIA_CONFORMANCE);
    } finally {
      await provider.disconnect();
    }
    expect(wire.unmatched()).toEqual([]);
    expect(wire.unused()).toEqual([]);
  });

  test("the order is detected on every fixture", () => {
    for (const set of ["0.16.10", "0.17.1"])
      expect(shardDocument(`${set}/probe-order.json`).key_order).toBe("hierarchical");
    for (const set of ["0.16.10-natural", "0.16.10-natural-blind"])
      expect(shardDocument(`${set}/probe-order.json`).key_order).toBe("natural");
    expect(shardDocument("0.16.10-natural-blind/probe-order.json").key_order_learned).toBe(
      keyOrderWords({ order: "natural", learnedBy: "decisive-list" }),
    );
    expect(shardDocument("0.16.10-auth/probe-empty-namespace.json").key_order_learned).toBe(
      keyOrderWords({ order: "hierarchical", learnedBy: "empty" }),
    );
  });

  test("an unknown namespace is one sentence on both server lines", () => {
    for (const [set, code] of [
      ["0.16.10", 110],
      ["0.17.1", 5],
    ] as const) {
      const file = `${set}/assignments-unknown-namespace.json`;
      expect(result(file).error.message).toBe(namespaceNotFoundSentence("no-such-namespace"));
      const ends = loadOxiaCapture(file).calls.map((call) => call.end);
      expect(ends).toEqual([expect.objectContaining({ kind: "status", code })]);
    }
  });

  test("a value over the receive cap is withheld, not an error", () => {
    const file = "0.16.10/get-over-cap.json";
    const rows = result(file).ok.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(WITHHELD_VALUE_TEXT);
    expect(rows[0].value_encoding).toBe("withheld");
    const calls = reads(loadOxiaCapture(file));
    expect(calls.map((call) => call.end)).toEqual([
      expect.objectContaining({ kind: "status", code: 8 }),
      expect.objectContaining({ kind: "status", code: 0 }),
    ]);
    expect(gets(calls[1])).toEqual([expect.objectContaining({ comparison_type: "EQUAL", include_value: false })]);
  });

  test("both stops of a range-scan are results with a notice", () => {
    for (const set of ["0.16.10", "0.17.1"]) {
      const budget = result(`${set}/range-scan-budget.json`);
      expect(budget.ok.warnings).toContainEqual({ message: runBudgetNotice("range-scan", budget.ok.rows.length) });
      const capped = result(`${set}/range-scan-over-cap.json`);
      expect(capped.ok.warnings).toContainEqual({ message: receiveCapNotice(capped.ok.rows.length) });
    }
  });

  test("a comparison get asks every shard without values, then reads the winner once", () => {
    const calls = reads(loadOxiaCapture("0.16.10/get-floor.json"));
    const floor = calls.filter((call) => gets(call).length === 1 && gets(call)[0].comparison_type === "FLOOR");
    expect(floor).toHaveLength(3);
    for (const call of floor) expect(gets(call)[0].include_value).toBe(false);
    const exact = calls.filter((call) => gets(call).some((get) => get.comparison_type === "EQUAL"));
    expect(exact).toHaveLength(1);
    expect(gets(exact[0])).toEqual([expect.objectContaining({ comparison_type: "EQUAL", include_value: true })]);
  });

  test("the U+0000 keys are listed", () => {
    const keys = result("0.16.10/list-nul-keys.json").ok.flatMap((page: { keys: string[] }) => page.keys);
    expect(keys).toContain("/nul/\u0000");
    expect(keys).toContain("/nul/a\u0000b");
  });

  test("the first Keys page lists each key once", () => {
    const first: string[] = result("0.16.10/list-first-pages.json").ok[0].keys;
    expect(first.length).toBeGreaterThan(0);
    expect(new Set(first).size).toBe(first.length);
  });

  test("the token goes with every call of the auth fixture and with none elsewhere", async () => {
    const auth = await replay("0.16.10-auth/auth-good-token.json");
    const authCalls = auth.wire.log.filter((event) => event.kind === "call");
    expect(authCalls.length).toBeGreaterThan(0);
    for (const event of authCalls) expect(event.kind === "call" && event.token).toBe(true);
    const plain = await replay("0.16.10/assignments-default.json");
    const plainCalls = plain.wire.log.filter((event) => event.kind === "call");
    expect(plainCalls.length).toBeGreaterThan(0);
    for (const event of plainCalls) expect(event.kind === "call" && event.token).toBe(false);
  });

  test("the auth table (C8)", () => {
    const causes: Record<string, string> = {
      "auth-no-token": "empty-token",
      "auth-bad-signature": "bad-signature",
      "auth-bad-audience": "forbidden-audience",
      "auth-bad-issuer": "unknown-issuer",
      "auth-expired": "expired",
    };
    for (const [name, cause] of Object.entries(causes))
      expect(result(`0.16.10-auth/${name}.json`).ok.snapshot.error.authCause).toBe(cause);
    const good = result("0.16.10-auth/auth-good-token.json").ok;
    expect(good.snapshot.ok.shards).toHaveLength(3);
    // SB1-9.5 sends the token on Health/Check; whether the server asks for it there is what the capture shows.
    expect(good.health).toEqual({ ok: "SERVING" });
    for (const [name, cause] of Object.entries(causes))
      expect(result(`0.16.10-auth/${name}.json`).ok.health.error.authCause).toBe(cause);
  });

  test("the TLS outcomes", async () => {
    expect(result("0.16.10-auth/tls-right-ca.json").ok.shards).toHaveLength(3);
    expect(result("0.16.10-auth/tls-ip-target.json").ok.shards).toHaveLength(3);
    const ip = await replay("0.16.10-auth/tls-ip-target.json");
    const opened = ip.wire.log.filter((event) => event.kind === "open");
    expect(opened.length).toBeGreaterThan(0);
    expect(opened[0]).toEqual(expect.objectContaining({ target: "127.0.0.1:6678" }));
    expect(opened[0].kind === "open" && opened[0].tls.identity).toBe("127.0.0.1");
    expect(result("0.16.10-auth/tls-unrelated-ca.json").error.category).toBe("tls");
  });

  test("health answers SERVING on every fixture", () => {
    for (const set of SETS) expect(result(`${set}/health-serving.json`)).toEqual({ ok: "SERVING" });
  });
});
