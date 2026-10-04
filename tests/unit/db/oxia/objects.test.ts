/**
 * The Oxia object surface over the shared fake (SB2-7.1 to SB2-7.5, SB2-7.7): the two kinds, the shard count and rows,
 * the key listing's refusal, describe for both kinds, and every Source part.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import type { ObjectSourcePart } from "@/lib/db/types";
import type { OxiaCallOptions, OxiaClient, OxiaSnapshot } from "@/lib/db/providers/keyvalue/oxia/client";
import { OXIA_INTERNAL_KEY_SENTENCE } from "@/lib/db/providers/keyvalue/oxia/commands";
import {
  countOxiaObjects,
  describeOxiaObject,
  describeOxiaObjects,
  listOxiaObjects,
  OXIA_KEYS_LISTED_ELSEWHERE,
  OXIA_OBJECT_KINDS,
  readOxiaObjectSource,
} from "@/lib/db/providers/keyvalue/oxia/objects";
import type { OrderVerdict } from "@/lib/db/providers/keyvalue/oxia/order";
import { shardFor } from "@/lib/db/providers/keyvalue/oxia/routing";
import { hexDump } from "@/lib/db/providers/keyvalue/oxia/values";
import type { OxiaSurface } from "@/lib/db/providers/keyvalue/oxia/walks";
import { createFakeOxiaClient, type FakeOxiaClient, type FakeOxiaOptions } from "../../../helpers/oxia-fake-client";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const DETECTED: OrderVerdict = { order: "hierarchical", learnedBy: "ceiling-probe" };
const call = (): OxiaCallOptions => ({ signal: new AbortController().signal, deadline: Date.now() + 10_000 });

/** A surface over the fake, as index.ts builds one: the snapshot read once, and the verdict the test names. */
function surfaceOver(fake: FakeOxiaClient, verdict: OrderVerdict = DETECTED): OxiaSurface {
  let snapshot: OxiaSnapshot | undefined;
  return {
    client: fake,
    snapshot: async (options) => {
      snapshot ??= await fake.getSnapshot(options);
      return snapshot;
    },
    order: async () => verdict,
  };
}

function setup(options: Partial<FakeOxiaOptions> = {}, verdict?: OrderVerdict) {
  const fake = createFakeOxiaClient({ order: "hierarchical", records: [], ...options });
  return { fake, surface: surfaceOver(fake, verdict) };
}

const textOf = (part: ObjectSourcePart): string => ("text" in part ? part.text : `unavailable: ${part.unavailable}`);

describe("OXIA_OBJECT_KINDS (SB2-7.1)", () => {
  test("is the shard and the key the Keys panel enumerates, frozen, with no columns, edits or children", () => {
    expect(OXIA_OBJECT_KINDS).toEqual([
      { id: "shard", role: "config", label: "Shard", labelPlural: "Shards", hasSource: true, sourceLanguage: "json" },
      {
        id: "key",
        role: "config",
        label: "Key",
        labelPlural: "Keys",
        enumeratedBy: "key-browser",
        hasSource: true,
        sourceLanguage: "json",
      },
    ]);
    expect(Object.isFrozen(OXIA_OBJECT_KINDS)).toBe(true);
  });
});

describe("count and list (SB2-7.2)", () => {
  test("the shard count is the snapshot's, and the key is never counted", async () => {
    const { surface } = setup({ shards: 5 });
    expect(await countOxiaObjects(surface, call())).toEqual({ shard: { count: 5 } });
  });

  test("one row per shard, in ascending id as numbers, with its inclusive hash range and no leader", async () => {
    const { fake, surface } = setup();
    const leader = { host: "localhost", port: 6648, address: "localhost:6648", bootstrap: true };
    fake.setSnapshot({
      namespace: "default",
      readAt: 0,
      shards: [
        { id: "10", minHash: 2_863_311_530, maxHash: 4_294_967_295, leader },
        { id: "2", minHash: 1_431_655_765, maxHash: 2_863_311_529, leader },
        { id: "1", minHash: 0, maxHash: 1_431_655_764, leader },
      ],
    });
    expect(await listOxiaObjects(surface, "shard", call())).toEqual([
      { path: ["1"], name: "Shard 1", kind: "shard", status: "hashes 0 to 1431655764" },
      { path: ["2"], name: "Shard 2", kind: "shard", status: "hashes 1431655765 to 2863311529" },
      { path: ["10"], name: "Shard 10", kind: "shard", status: "hashes 2863311530 to 4294967295" },
    ]);
  });

  test("the key kind is refused by name, with no call", async () => {
    const { fake, surface } = setup();
    const listing = listOxiaObjects(surface, "key", call());
    await expect(listing).rejects.toBeInstanceOf(QueryError);
    await expect(listing).rejects.toThrow(OXIA_KEYS_LISTED_ELSEWHERE);
    expect(OXIA_KEYS_LISTED_ELSEWHERE).toBe("Keys are listed in the Keys panel and with list in the console.");
    expect(fake.calls).toEqual([]);
  });

  test("any other kind is refused", async () => {
    const { surface } = setup();
    await expect(listOxiaObjects(surface, "table", call())).rejects.toThrow('Oxia declares no object kind "table"');
  });
});

describe("describe (SB2-7.3)", () => {
  test("both kinds answer no columns, with no read", () => {
    for (const kind of ["shard", "key"]) {
      expect(describeOxiaObject(["0"], kind)).toEqual({ path: ["0"], columns: [], indexes: [], foreignKeys: [] });
      expect(describeOxiaObjects(kind)).toEqual({ details: [] });
    }
  });

  test("a path of another length, or an undeclared kind, is refused", () => {
    expect(() => describeOxiaObject(["a", "b"], "key")).toThrow('An Oxia "key" path is [name], received ["a","b"]');
    expect(() => describeOxiaObject([], "shard")).toThrow('An Oxia "shard" path is [name], received []');
    expect(() => describeOxiaObject(["0"], "prefix")).toThrow('Oxia declares no object kind "prefix"');
    expect(() => describeOxiaObjects("prefix")).toThrow('Oxia declares no object kind "prefix"');
  });
});

describe("a shard's Source (SB2-7.4)", () => {
  test("one rendered JSON part: namespace, id, hash range, the parsed leader, the order in words, the shard count", async () => {
    const { surface } = setup();
    const snapshot = await surface.snapshot(call());
    const shard = snapshot.shards[0];
    const document = await readOxiaObjectSource(
      surface,
      ["0"].map(() => shard.id),
      "shard",
      undefined,
      call(),
    );

    expect(document.path).toEqual([shard.id]);
    expect(document.kind).toBe("shard");
    expect(document.parts).toHaveLength(1);
    const [part] = document.parts;
    expect(part).toMatchObject({ id: "shard", label: "Shard", language: "json", form: "complete", origin: "rendered" });
    expect(JSON.parse(textOf(part))).toEqual({
      namespace: "default",
      shard: shard.id,
      hash_range: { min_inclusive: String(shard.minHash), max_inclusive: String(shard.maxHash) },
      leader: shard.leader.address,
      key_order: "hierarchical",
      key_order_learned: "hierarchical, detected from key order",
      shards_in_namespace: snapshot.shards.length,
    });
  });

  test("an assumed verdict is named as SB2-9.3 words it", async () => {
    const { surface } = setup({}, { order: "hierarchical", learnedBy: "assumed", exhausted: true });
    const id = (await surface.snapshot(call())).shards[0].id;
    const [part] = (await readOxiaObjectSource(surface, [id], "shard", undefined, call())).parts;
    expect(JSON.parse(textOf(part)).key_order_learned).toBe(
      "hierarchical, assumed: Studio could not tell the orders apart from the keys read",
    );
  });

  test("a shard id the snapshot does not hold is refused", async () => {
    const { surface } = setup();
    await expect(readOxiaObjectSource(surface, ["99"], "shard", undefined, call())).rejects.toThrow(
      "This namespace has no shard 99: shards are listed under Shards.",
    );
  });

  test("the refused id is shown as a key is: quoted when it needs quotes", async () => {
    const { surface } = setup();
    await expect(readOxiaObjectSource(surface, ["no such"], "shard", undefined, call())).rejects.toThrow(
      "This namespace has no shard 'no such': shards are listed under Shards.",
    );
  });

  test("the caller's bound cuts the text and marks it", async () => {
    const { surface } = setup();
    const id = (await surface.snapshot(call())).shards[0].id;
    const [part] = (await readOxiaObjectSource(surface, [id], "shard", 10, call())).parts;
    expect(textOf(part)).toHaveLength(10);
    // A rendered JSON part stays complete under the caller's bound; the shared mark says it was cut.
    expect(part).toMatchObject({ form: "complete", truncated: { limit: 10 } });
  });
});

describe("a key's Source (SB2-7.5)", () => {
  async function source(records: FakeOxiaOptions["records"], key: string, limit?: number, options = {}) {
    const { fake, surface } = setup({ records, ...options });
    const document = await readOxiaObjectSource(surface, [key], "key", limit, call());
    return { fake, surface, document, value: document.parts[0], metadata: document.parts[1] };
  }

  test("JSON stored in the two-space form is stored; any other JSON is rendered in it", async () => {
    const pretty = '{\n  "policy": "allow"\n}';
    expect((await source([{ key: "/p", value: utf8(pretty) }], "/p")).value).toEqual({
      id: "value",
      label: "Value",
      text: pretty,
      language: "json",
      form: "complete",
      origin: "stored",
    });
    expect((await source([{ key: "/p", value: utf8('{"policy":"allow"}') }], "/p")).value).toMatchObject({
      text: pretty,
      origin: "rendered",
    });
  });

  test("text is stored plain text", async () => {
    expect((await source([{ key: "/t", value: utf8("hello\nworld") }], "/t")).value).toEqual({
      id: "value",
      label: "Value",
      text: "hello\nworld",
      language: "plaintext",
      form: "complete",
      origin: "stored",
    });
  });

  test("bytes that are not printable text, and text of blanks only, are a rendered hex dump", async () => {
    const binary = Uint8Array.of(0x08, 0x01);
    expect((await source([{ key: "/b", value: binary }], "/b")).value).toMatchObject({
      text: hexDump(binary, 65_536),
      language: "plaintext",
      form: "complete",
      origin: "rendered",
    });
    expect(textOf((await source([{ key: "/w", value: utf8("   ") }], "/w")).value)).toBe(hexDump(utf8("   "), 65_536));
  });

  test("past 65,536 bytes the dump is partial and says how many bytes are shown", async () => {
    const large = new Uint8Array(70_000);
    const { value } = await source([{ key: "/l", value: large }], "/l");
    expect(value).toMatchObject({ form: "partial", origin: "rendered" });
    expect(textOf(value)).toContain("The first 65,536 of 70,000 bytes are shown.");
  });

  test("the caller's bound cuts a value and marks it partial", async () => {
    const { value, metadata } = await source([{ key: "/t", value: utf8("x".repeat(100)) }], "/t", 10);
    expect(value).toMatchObject({ text: "x".repeat(10), form: "partial", truncated: { limit: 10 } });
    // The metadata part is rendered JSON under the same bound, and stays complete (rule 5).
    expect(textOf(metadata)).toHaveLength(10);
    expect(metadata).toMatchObject({ form: "complete", truncated: { limit: 10 } });
  });

  test("an empty value has its own sentence", async () => {
    expect((await source([{ key: "/parent", value: new Uint8Array(0) }], "/parent")).value).toEqual({
      id: "value",
      label: "Value",
      unavailable:
        "The value is empty (0 bytes). Pulsar and other ZooKeeper-style clients write parent paths this way.",
    });
  });

  test("a value over the receive cap is withheld, and its version is still shown", async () => {
    const { value, metadata } = await source([{ key: "/big", value: new Uint8Array(4096) }], "/big", undefined, {
      receiveCapBytes: 1024,
    });
    expect(value).toEqual({
      id: "value",
      label: "Value",
      unavailable:
        "The value is larger than 16 MiB, the most Studio receives in one message, so it is withheld. Its version is below.",
    });
    expect(JSON.parse(textOf(metadata))).toMatchObject({ key: "/big", value_encoding: "withheld", value_bytes: null });
  });

  test("the metadata: the cell rules of SB2-6.1, the shard that answered, the value's encoding and size", async () => {
    const { surface, metadata } = await source([{ key: "/m", value: utf8("12"), clientIdentity: "broker-1" }], "/m");
    const snapshot = await surface.snapshot(call());
    expect(metadata).toMatchObject({ id: "metadata", label: "Metadata", language: "json", form: "complete" });
    const parsed = JSON.parse(textOf(metadata));
    expect(Object.keys(parsed)).toEqual([
      "key",
      "shard",
      "version_id",
      "modifications_count",
      "created_timestamp",
      "modified_timestamp",
      "ephemeral",
      "session_id",
      "client_identity",
      "value_encoding",
      "value_bytes",
    ]);
    expect(parsed).toMatchObject({
      key: "/m",
      shard: shardFor(snapshot, "/m").id,
      ephemeral: false,
      session_id: null,
      client_identity: "broker-1",
      value_encoding: "json",
      value_bytes: 2,
    });
    expect(parsed.created_timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(typeof parsed.version_id).toBe("string");
  });

  test("the metadata's version fields are the record's own, after a second write", async () => {
    const { fake, surface } = setup({ records: [{ key: "/m", value: utf8("1") }] });
    fake.put({ key: "/m", value: utf8("2") });
    const snapshot = await surface.snapshot(call());
    const [truth] = await fake.read(
      shardFor(snapshot, "/m"),
      [{ key: "/m", comparison: "EQUAL", includeValue: false }],
      call(),
    );
    const version = truth.version as NonNullable<typeof truth.version>;
    // A rewritten key: its created and modified times differ, and it counts one modification.
    expect(version.modifiedTimestamp).not.toBe(version.createdTimestamp);
    expect(version.modificationsCount).toBe("1");
    const [, metadata] = (await readOxiaObjectSource(surface, ["/m"], "key", undefined, call())).parts;
    expect(JSON.parse(textOf(metadata))).toMatchObject({
      version_id: version.versionId,
      modifications_count: "1",
      created_timestamp: new Date(Number(version.createdTimestamp)).toISOString(),
      modified_timestamp: new Date(Number(version.modifiedTimestamp)).toISOString(),
    });
  });

  test("an empty client identity is null, as SB2-6.1's cell rule has it", async () => {
    const { metadata } = await source([{ key: "/c", value: utf8("x"), clientIdentity: "" }], "/c");
    expect(JSON.parse(textOf(metadata)).client_identity).toBeNull();
  });

  test("an ephemeral key's metadata label carries the badge with its session (SB2-12 D8)", async () => {
    const { metadata } = await source([{ key: "/e", value: utf8("x"), sessionId: "42" }], "/e");
    expect(metadata).toMatchObject({ label: "Metadata (ephemeral: deleted when session 42 ends)" });
    expect(JSON.parse(textOf(metadata))).toMatchObject({ ephemeral: true, session_id: "42" });
  });

  test("an absent key is refused with the namespace named", async () => {
    const { surface } = setup({ records: [] });
    const reading = readOxiaObjectSource(surface, ["/no/such/key"], "key", undefined, call());
    await expect(reading).rejects.toBeInstanceOf(QueryError);
    await expect(reading).rejects.toThrow("Oxia holds no key /no/such/key in namespace `default`.");
  });

  test("an absent key is named as SB2-6.1 shows a key: cut at 120 characters", async () => {
    const { surface } = setup({ records: [] });
    const key = `/k/${"x".repeat(200)}`;
    await expect(readOxiaObjectSource(surface, [key], "key", undefined, call())).rejects.toThrow(
      `Oxia holds no key /k/${"x".repeat(117)}... in namespace \`default\`.`,
    );
  });

  test("an internal key is refused before any call", async () => {
    const { fake, surface } = setup();
    await expect(readOxiaObjectSource(surface, ["__oxia/x"], "key", undefined, call())).rejects.toThrow(
      OXIA_INTERNAL_KEY_SENTENCE,
    );
    expect(fake.calls).toEqual([]);
  });

  test("a record with no value and no withheld mark is a defect of the caller", async () => {
    const { fake } = setup({ records: [{ key: "/v", value: utf8("x") }] });
    // The fake answers a value whenever one is asked; this client drops it, which no adapter may do.
    const client: OxiaClient = {
      getSnapshot: (options) => fake.getSnapshot(options),
      read: async (shard, gets, options) =>
        // oxlint-disable-next-line no-map-spread -- the fake's answers are its own, so the dropped value is a changed copy.
        (await fake.read(shard, gets, options)).map((record) => ({ ...record, value: undefined })),
      list: (shard, range, options) => fake.list(shard, range, options),
      rangeScan: (shard, range, options) => fake.rangeScan(shard, range, options),
      health: (options) => fake.health(options),
      close: () => fake.close(),
    };
    const surface: OxiaSurface = { ...surfaceOver(fake), client };
    await expect(readOxiaObjectSource(surface, ["/v"], "key", undefined, call())).rejects.toThrow(
      "An Oxia record reached the Source tab with no value and no withheld mark: the read asks for the value",
    );
  });

  test("no part offers an edit (O1)", async () => {
    const { document } = await source([{ key: "/t", value: utf8("x") }], "/t");
    for (const part of document.parts) expect("edit" in part).toBe(false);
  });

  test("the refusals are QueryErrors tagged with the provider's type", async () => {
    const { surface } = setup();
    const error = await readOxiaObjectSource(surface, ["99"], "shard", undefined, call()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(QueryError);
    expect(error).not.toBeInstanceOf(DatabaseConfigError);
    expect((error as QueryError).provider as string).toBe("oxia");
  });
});
