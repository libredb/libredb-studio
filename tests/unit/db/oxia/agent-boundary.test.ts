/**
 * The Oxia agent boundary, replayed from what Oxia 0.18.0 answered calls sent raw over gRPC, with no Studio check in
 * front of them (tests/fixtures/oxia/0.18.0/agent-boundary/run.sh). The server checks a token and nothing else: a
 * second subject reads, overwrites and deletes the first subject's key and deletes a shard's every key, so no principal
 * can be proved and the closed table is the boundary. Every call the table refuses, sent against the same server, is
 * honoured, which is why each is refused before the network; every read the table holds, run through the provider over
 * the captured keys, answers no key name or value.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { OxiaProvider } from "@/lib/db/providers/keyvalue/oxia/index";
import { createFakeOxiaClient } from "../../../helpers/oxia-fake-client";
import { oxiaConnection } from "../../../helpers/oxia-connection";

const DIR = posix.join(import.meta.dir.replaceAll("\\", "/"), "../../../fixtures/oxia/0.18.0/agent-boundary");

interface Answer {
  readonly outcome: "ok" | "error";
  readonly code?: number;
  readonly details?: string;
  // biome-ignore lint/suspicious/noExplicitAny: a captured gRPC answer is JSON of many shapes.
  readonly messages?: readonly any[];
  readonly open?: true;
}

interface OpenCapture {
  readonly $captured: { readonly image: string; readonly version: string };
  readonly keys: Readonly<Record<string, string>>;
  readonly partitionKey: string;
  readonly before: { readonly keys: Readonly<Record<string, readonly string[]>> };
  readonly admitted: Readonly<Record<string, Answer>>;
  readonly refused: Readonly<Record<string, Answer>>;
  readonly stateBeforeDeleteRange: { readonly keys: Readonly<Record<string, readonly string[]>> };
  readonly after: { readonly keys: Readonly<Record<string, readonly string[]>> };
}

interface AuthCapture {
  readonly $captured: { readonly image: string };
  readonly probes: Readonly<Record<string, Answer>>;
  readonly after: { readonly keys: Readonly<Record<string, readonly string[]>> };
}

const read = (name: string): string => readFileSync(posix.join(DIR, name), "utf8");
const open = JSON.parse(read("open.json")) as OpenCapture;
const auth = JSON.parse(read("authenticated.json")) as AuthCapture;

const IMAGE = "oxia/oxia:0.18.0@sha256:65f9898d531c3ca48a3277247650200c8065435fd542ea9a81e51c37b90fff60";
const UNAUTHENTICATED = 16;

/** Every key the run seeded, and every value; none may reach an agent answer. */
const SEEDED_KEYS = Object.values(open.before.keys).flat();
const SEEDED_VALUES = ['{"fixture":"tenant"}', "fixture-topic-bytes", "fixture-flat-value", "fixture-pk"];

const BUDGET = { maxResultRows: 200, maxResultBytes: 64 * 1024, statementTimeoutMs: 10_000 };

describe("the captures", () => {
  test("are of the pinned image, and hold no token, key or bearer header", () => {
    expect(open.$captured.image).toBe(IMAGE);
    expect(auth.$captured.image).toBe(IMAGE);
    expect(read("run.sh")).toContain(IMAGE);
    for (const name of ["open.json", "authenticated.json"]) {
      const text = read(name);
      expect({ name, token: /eyJ[A-Za-z0-9_-]{10,}/.test(text) }).toEqual({ name, token: false });
      expect({ name, pem: /-----BEGIN/.test(text) }).toEqual({ name, pem: false });
      expect({ name, bearer: /Bearer /.test(text) }).toEqual({ name, bearer: false });
    }
  });

  test("the run seeded four keys over two shards, one of them under a partition key", () => {
    expect(SEEDED_KEYS.sort()).toEqual(
      [open.keys.tenant, open.keys.topic, open.keys.flat, open.keys.partitioned].sort() as string[],
    );
    expect(Object.keys(open.before.keys)).toEqual(["0", "1"]);
  });
});

describe("Oxia 0.18.0 has no authorization", () => {
  test("a call with no token is refused as unauthenticated", () => {
    expect(auth.probes.shardAssignmentsNoToken).toMatchObject({ outcome: "error", code: UNAUTHENTICATED });
    expect(auth.probes.listNoToken).toMatchObject({ outcome: "error", code: UNAUTHENTICATED });
  });

  test("a second subject reads, overwrites and deletes the first subject's key, and deletes a shard's every key", () => {
    for (const probe of ["putSubjectA", "getSubjectB", "overwriteSubjectB", "deleteSubjectB", "deleteRangeSubjectB"]) {
      expect({ probe, outcome: auth.probes[probe]?.outcome }).toEqual({ probe, outcome: "ok" });
    }
    expect(auth.probes.getSubjectB?.messages?.[0].gets[0].status).toBe("OK");
    expect(auth.probes.overwriteSubjectB?.messages?.[0].puts[0].status).toBe("OK");
    expect(auth.probes.deleteSubjectB?.messages?.[0].deletes[0].status).toBe("OK");
    expect(auth.probes.deleteRangeSubjectB?.messages?.[0].delete_ranges[0].status).toBe("OK");
    expect(Object.values(auth.after.keys).flat()).toEqual([]);
  });
});

describe("every call the agent's table refuses, the server honours", () => {
  test("a put, a delete and a delete-range change the server", () => {
    expect(open.refused.put?.messages?.[0].puts[0].status).toBe("OK");
    expect(open.refused.delete?.messages?.[0].deletes[0].status).toBe("OK");
    expect(open.refused.deleteRangeEveryKey?.messages?.[0].delete_ranges[0].status).toBe("OK");
    const shard = Object.keys(open.after.keys).find((id) => open.after.keys[id].length === 0);
    expect(shard).toBeDefined();
    expect(open.stateBeforeDeleteRange.keys[shard as string].length).toBeGreaterThan(0);
  });

  test("a sequence put writes a key the server names, and the sequence stream stays open", () => {
    const sequenceKey = open.refused.sequencePut?.messages?.[0].puts[0].key as string;
    expect(sequenceKey.startsWith(open.keys.sequence)).toBe(true);
    expect(open.refused.getSequenceUpdates).toMatchObject({ outcome: "ok", open: true });
  });

  test("a session is created, an ephemeral put carries its session id and client identity, and closing it deletes it", () => {
    expect(open.refused.createSession?.messages?.[0].session_id).toBeDefined();
    const version = open.refused.ephemeralGet?.messages?.[0].gets[0].version;
    expect(version.session_id).toBe(open.refused.createSession?.messages?.[0].session_id);
    expect(version.client_identity).toBe("fixture-identity");
    expect(open.refused.ephemeralGetAfterClose?.messages?.[0].gets[0].status).toBe("KEY_NOT_FOUND");
  });

  test("notifications stream, a floor get names a neighbouring key, and internal keys list on request", () => {
    expect(open.refused.getNotifications).toMatchObject({ outcome: "ok", open: true });
    const floor = open.refused.getFloor?.messages?.[0].gets[0];
    expect(floor.status).toBe("OK");
    expect(SEEDED_KEYS).toContain(floor.key);
    expect(floor.key).not.toBe(open.keys.missing);
    const internal = open.refused.listInternalKeys?.messages?.flatMap((message) => message.keys) as string[];
    expect(internal.some((key) => key.startsWith("__oxia/"))).toBe(true);
    const scanned = open.refused.rangeScanEveryKey?.messages?.[0].records[0];
    expect(SEEDED_KEYS).toContain(scanned.key);
    expect(scanned.value).toBeDefined();
  });

  test("another namespace is not served, and the shard map names this one", () => {
    expect(open.admitted.shardAssignmentsOtherNamespace).toMatchObject({ outcome: "error", code: 5 });
    expect(Object.keys(open.admitted.shardAssignments?.messages?.[0].namespaces)).toEqual(["default"]);
  });
});

describe("the provider over the captured keys", () => {
  /** A fake server holding the captured keys and values, routed as the server routed them. */
  function provider() {
    const value = (text: string) => new TextEncoder().encode(text);
    const fake = createFakeOxiaClient({
      order: "hierarchical",
      shards: 2,
      records: [
        { key: open.keys.tenant as string, value: value(SEEDED_VALUES[0]) },
        { key: open.keys.topic as string, value: value(SEEDED_VALUES[1]) },
        { key: open.keys.flat as string, value: value(SEEDED_VALUES[2]) },
        { key: open.keys.partitioned as string, value: value(SEEDED_VALUES[3]), partitionKey: open.partitionKey },
      ],
    });
    const built = new OxiaProvider(oxiaConnection(), {}, { readOnly: true, sendsStatements: true }, () => fake);
    return { built, fake };
  }

  test("every read the table holds answers no seeded key name or value", async () => {
    const { built } = provider();
    await built.connect();
    const statements = [
      "shards",
      `get ${open.keys.tenant}`,
      `get ${open.keys.partitioned}`,
      `get ${open.keys.missing}`,
      "list",
      "list --prefix /admin/",
      "list -s /a -e /z",
    ];
    for (const statement of statements) {
      // oxlint-disable-next-line no-await-in-loop -- one command at a time, as the agent sends them.
      const text = JSON.stringify(await built.queryReadOnly(statement, BUDGET));
      for (const secret of [...SEEDED_KEYS, ...SEEDED_VALUES]) {
        expect({ statement, leaked: text.includes(secret) }).toEqual({ statement, leaked: false });
      }
    }
    await built.disconnect();
  });

  test("every call the server honoured above is refused before the network", async () => {
    const { built, fake } = provider();
    await built.connect();
    const before = fake.calls.length;
    const refused = [
      `put ${open.keys.scratch} fixture-written`,
      `delete ${open.keys.scratch}`,
      "delete-range / /z",
      `notifications`,
      `sequence-updates ${open.keys.sequence}`,
      `get -t floor ${open.keys.missing}`,
      `get --index fixture-index ${open.keys.tenant}`,
      `get -p ${open.partitionKey} ${open.keys.partitioned}`,
      "list --internal-keys",
      "range-scan",
      "-n no-such-namespace shards",
      "-n no-such-namespace list",
    ];
    for (const statement of refused) {
      // oxlint-disable-next-line no-await-in-loop -- one command at a time, as the agent sends them.
      await expect(built.queryReadOnly(statement, BUDGET)).rejects.toThrow("Nothing was sent.");
    }
    expect(fake.calls.length).toBe(before);
    await built.disconnect();
  });
});
