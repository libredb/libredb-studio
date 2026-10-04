/**
 * One Oxia outcome as the grid shows it (SB2-5.4, SB2-6.1, SB2-6.6): each verb's columns, every cell rule, and every
 * notice word for word, the three stop notices as SB1-9.3a words them.
 */
import { describe, expect, test } from "bun:test";
import type {
  OxiaKeysAnswer,
  OxiaRecordsAnswer,
  OxiaRecordView,
  OxiaVersion,
} from "@/lib/db/providers/keyvalue/oxia/client";
import { type OxiaCommand, type ParsedOxiaCommand, parseOxiaCommand } from "@/lib/db/providers/keyvalue/oxia/commands";
import { OXIA_CELL_LIMIT } from "@/lib/db/providers/keyvalue/oxia/constants";
import type { OrderVerdict } from "@/lib/db/providers/keyvalue/oxia/order";
import { OXIA_RECORD_FIELDS, type OxiaOutcome, oxiaResult } from "@/lib/db/providers/keyvalue/oxia/results";

const NS = "default";
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const VERSION: OxiaVersion = {
  versionId: "9007199254740993",
  modificationsCount: "2",
  createdTimestamp: "0",
  modifiedTimestamp: "1791067058375",
};

function record(
  key: string,
  value: string | Uint8Array | undefined,
  version: Partial<OxiaVersion> = {},
): OxiaRecordView {
  const bytes = typeof value === "string" ? utf8(value) : value;
  return { key, ...(bytes === undefined ? {} : { value: bytes }), version: { ...VERSION, ...version }, shard: "1" };
}

/** The text parsed with the browser's context; its command and its matched globals. */
function parse(text: string, context = {}): ParsedOxiaCommand {
  const parsed = parseOxiaCommand(text, context);
  if (!parsed.ok) throw new Error(parsed.refusal.message);
  return parsed.parsed;
}

const HIERARCHICAL: OrderVerdict = { order: "hierarchical", learnedBy: "ceiling-probe" };
const NATURAL: OrderVerdict = { order: "natural", learnedBy: "decisive-list" };

/** The result of a get typed as `text` that answered `answer`. */
function getResult(text: string, answer: OxiaRecordView | undefined, verdict?: OrderVerdict) {
  const parsed = parse(text);
  const outcome = {
    kind: "get",
    command: parsed.command as Extract<OxiaCommand, { kind: "get" }>,
    answer,
    namespace: NS,
    ...(verdict === undefined ? {} : { verdict }),
  } as OxiaOutcome;
  return oxiaResult(outcome, parsed, OXIA_CELL_LIMIT, 7);
}

function listResult(text: string, answer: Partial<OxiaKeysAnswer>, verdict: OrderVerdict = HIERARCHICAL) {
  const parsed = parse(text);
  const full: OxiaKeysAnswer = { keys: [], more: false, shardsRead: 3, ...answer };
  const outcome = {
    kind: "list",
    command: parsed.command as Extract<OxiaCommand, { kind: "list" }>,
    answer: full,
    namespace: NS,
    verdict,
  } as OxiaOutcome;
  return oxiaResult(outcome, parsed, OXIA_CELL_LIMIT, 7);
}

function scanResult(text: string, answer: Partial<OxiaRecordsAnswer>, verdict: OrderVerdict = HIERARCHICAL) {
  const parsed = parse(text);
  const full: OxiaRecordsAnswer = { records: [], more: false, shardsRead: 3, ...answer };
  const outcome = {
    kind: "range-scan",
    command: parsed.command as Extract<OxiaCommand, { kind: "range-scan" }>,
    answer: full,
    namespace: NS,
    verdict,
  } as OxiaOutcome;
  return oxiaResult(outcome, parsed, OXIA_CELL_LIMIT, 7);
}

const messages = (result: { readonly warnings?: readonly { readonly message: string }[] }): string[] =>
  (result.warnings ?? []).map((warning) => warning.message);

describe("columns per verb (SB2-6.1)", () => {
  test("OXIA_RECORD_FIELDS are the CLI's names, in order", () => {
    expect(OXIA_RECORD_FIELDS).toEqual([
      "key",
      "value",
      "value_encoding",
      "version_id",
      "modifications_count",
      "created_timestamp",
      "modified_timestamp",
      "ephemeral",
      "session_id",
      "client_identity",
    ]);
  });

  test("get: the record fields, and secondary_index_key last with --index only", () => {
    expect(getResult("get /a", record("/a", "x")).fields).toEqual([...OXIA_RECORD_FIELDS]);
    expect(
      getResult("get --index by-email a@x", { ...record("/users/1", "x"), secondaryIndexKey: "a@x" }).fields,
    ).toEqual([...OXIA_RECORD_FIELDS, "secondary_index_key"]);
  });

  test("range-scan: the record fields, with --index or without, never secondary_index_key", () => {
    expect(scanResult("range-scan a b", {}).fields).toEqual([...OXIA_RECORD_FIELDS]);
    expect(scanResult("range-scan --index i a b", {}).fields).toEqual([...OXIA_RECORD_FIELDS]);
  });

  test("list: the key alone, and no column types", () => {
    const result = listResult("list", { keys: ["/a", "/b"] });
    expect(result.fields).toEqual(["key"]);
    expect(result.rows).toEqual([{ key: "/a" }, { key: "/b" }]);
    expect(result.rowCount).toBe(2);
    expect(result.columnTypes).toBeUndefined();
  });

  test("the record results describe version_id and client_identity", () => {
    expect(getResult("get /a", record("/a", "x")).columnTypes).toEqual({
      version_id: "int64, per shard",
      client_identity: "string, client-reported",
    });
  });

  test("the execution time is the caller's", () => {
    expect(getResult("get /a", record("/a", "x")).executionTime).toBe(7);
  });
});

describe("cells (SB2-6.1)", () => {
  test("a record row, its int64 strings exact past 2^53, its timestamps as ISO 8601", () => {
    expect(getResult("get /a", record("/a", '{"x":1}')).rows).toEqual([
      {
        key: "/a",
        value: '{"x":1}',
        value_encoding: "json",
        version_id: "9007199254740993",
        modifications_count: "2",
        created_timestamp: "1970-01-01T00:00:00.000Z",
        modified_timestamp: "2026-10-03T22:37:38.375Z",
        ephemeral: false,
        session_id: null,
        client_identity: null,
      },
    ]);
  });

  test("a timestamp past the date range is the decimal string and ms", () => {
    const row = getResult("get /a", record("/a", "x", { modifiedTimestamp: "8640000000000001" })).rows[0];
    expect(row.modified_timestamp).toBe("8640000000000001 ms");
  });

  test("ephemeral comes from session_id, and client_identity empty is null", () => {
    const row = getResult("get /a", record("/a", "x", { sessionId: "77", clientIdentity: "" })).rows[0];
    expect([row.ephemeral, row.session_id, row.client_identity]).toEqual([true, "77", null]);
    const named = getResult("get /a", record("/a", "x", { clientIdentity: "broker-1" })).rows[0];
    expect(named.client_identity).toBe("broker-1");
  });

  test("value_encoding: text, hex, --hex forcing hex, and a cut cell", () => {
    expect(getResult("get /a", record("/a", "plain")).rows[0].value_encoding).toBe("text");
    expect(getResult("get /a", record("/a", Uint8Array.of(0x08, 0x01))).rows[0]).toMatchObject({
      value: "0801",
      value_encoding: "hex",
    });
    expect(getResult("get --hex /a", record("/a", "{}")).rows[0]).toMatchObject({
      value: "7b7d",
      value_encoding: "hex",
    });
    const long = getResult("get /a", record("/a", "t".repeat(OXIA_CELL_LIMIT + 1))).rows[0];
    expect([String(long.value).length, long.value_encoding]).toEqual([OXIA_CELL_LIMIT, "text, cut"]);
    const scan = scanResult("range-scan --hex a b", { records: [record("/a", "{}")] }).rows[0];
    expect(scan).toMatchObject({ value: "7b7d", value_encoding: "hex" });
  });

  test("an EQUAL get with no index shows the asked key, whatever the record carries (F16)", () => {
    expect(getResult("get /asked", record("/other", "x")).rows[0].key).toBe("/asked");
  });

  test("a comparison get, an index get and a range-scan show the key the server returned", () => {
    expect(getResult("get -t floor /b", record("/a", "x"), HIERARCHICAL).rows[0].key).toBe("/a");
    const indexed = getResult(
      "get --index by-email a@x",
      { ...record("/users/1", "x"), secondaryIndexKey: "a@x" },
      NATURAL,
    );
    expect(indexed.rows[0]).toMatchObject({ key: "/users/1", secondary_index_key: "a@x" });
    expect(scanResult("range-scan a b", { records: [record("/a", "x")] }).rows[0].key).toBe("/a");
  });

  test("an index get whose winner carried no secondary key shows null in the column", () => {
    expect(getResult("get --index i k", record("/p", "x"), NATURAL).rows[0].secondary_index_key).toBeNull();
  });

  test("a withheld value: the sentence in the cell, withheld as the encoding, and the version shown", () => {
    const result = getResult("get /big", { ...record("/big", undefined), withheld: true });
    expect(result.rows[0]).toMatchObject({
      value: "value larger than 16 MiB, withheld",
      value_encoding: "withheld",
      version_id: "9007199254740993",
    });
  });

  test("a record with no value and no withheld mark is a defect of the caller", () => {
    expect(() => getResult("get /a", record("/a", undefined))).toThrow(
      "An Oxia record reached the grid with no value and no withheld mark: a console read always asks for the value",
    );
  });
});

describe("the notices of SB2-5.4, word for word", () => {
  test("N1: a comparison get found another key", () => {
    expect(messages(getResult("get -t floor '/b x'", record("/a", "x"), HIERARCHICAL))).toEqual([
      "get -t floor asked for '/b x'; the key found is /a.",
    ]);
    // The asked key itself found: no notice.
    expect(messages(getResult("get -t ceiling /a", record("/a", "x"), HIERARCHICAL))).toEqual([]);
  });

  test("N1 is not about an index get, which asks a secondary key and answers a primary one", () => {
    const indexed = { ...record("/users/1", "x"), secondaryIndexKey: "b@x" };
    expect(messages(getResult("get --index by-email -t floor c@x", indexed, NATURAL))).toEqual([]);
  });

  test("N2: an equal get missed, by key and by index", () => {
    expect(messages(getResult("get /no", undefined))).toEqual(["Oxia holds no key /no in namespace `default`."]);
    expect(messages(getResult("get --index by-email a@x", undefined, NATURAL))).toEqual([
      "Index by-email holds no secondary key a@x.",
    ]);
  });

  test.each([
    ["floor", "No key is at or below /k."],
    ["ceiling", "No key is at or above /k."],
    ["lower", "No key is below /k."],
    ["higher", "No key is above /k."],
  ])("N3: a %s get missed", (comparison, notice) => {
    const result = getResult(`get -t ${comparison} /k`, undefined, HIERARCHICAL);
    expect(result.rows).toEqual([]);
    expect(result.fields).toEqual([...OXIA_RECORD_FIELDS]);
    expect(messages(result)).toEqual([notice]);
  });

  test("N4: list or range-scan stopped at --limit with more keys following", () => {
    const notice = "More keys follow: this result holds the first 2. Raise --limit (at most 500), or narrow the range.";
    expect(messages(listResult("list --limit 2", { keys: ["/a", "/b"], more: true }))).toEqual([notice]);
    expect(
      messages(scanResult("range-scan --limit 2", { records: [record("/a", "x"), record("/b", "y")], more: true })),
    ).toEqual([notice]);
  });

  test("N5: range-scan stopped at the run budget, as SB1-9.3a words it", () => {
    const records = [record("/a", "x"), record("/b", "y"), record("/c", "z")];
    expect(messages(scanResult("range-scan", { records, more: true, stoppedBy: "bytes" }))).toEqual([
      "The result stopped after 3 records, at the 8 MiB of keys and values a console result holds: narrow the range, or list the keys and get the values one by one.",
    ]);
  });

  test("N5b: list stopped at the run budget, as SB1-9.3a words it", () => {
    expect(messages(listResult("list", { keys: ["/a", "/b", "/c"], more: true, stoppedBy: "bytes" }))).toEqual([
      "The result stopped after 3 keys, at the 8 MiB of keys a console result holds: narrow the range.",
    ]);
  });

  test("N5c: range-scan stopped at the receive cap, as SB1-9.3a words it, with the rows read before it", () => {
    const result = scanResult("range-scan", { records: [record("/a", "x")], more: true, stoppedBy: "receive-cap" });
    expect(result.rows).toHaveLength(1);
    expect(messages(result)).toEqual([
      "A record in this range is larger than the 16 MiB receive cap, so range-scan stopped after 1 records: list the keys with list, then read each with get, which shows such a value's version and withholds the value.",
    ]);
  });

  test("N6: -s P/ -e P// under natural order, on an empty result as on a full one", () => {
    const notice =
      "This namespace sorts keys naturally, so `/xyz//` does not bound /xyz's children; `--prefix /xyz/` lists everything under /xyz/.";
    expect(messages(listResult("list -s /xyz/ -e /xyz//", {}, NATURAL))).toEqual([notice]);
    expect(messages(scanResult("range-scan /xyz/ /xyz//", { records: [record("/xyz/a", "1")] }, NATURAL))).toEqual([
      notice,
    ]);
    // Under hierarchical order the same range holds P's children: no notice.
    expect(messages(listResult("list -s /xyz/ -e /xyz//", { keys: ["/xyz/a"] }, HIERARCHICAL))).toEqual([]);
    // MAX other than MIN + "/" is not the idiom.
    expect(messages(listResult("list -s /xyz/ -e /xyz/z", { keys: ["/xyz/a"] }, NATURAL))).toEqual([]);
  });

  test("N7: MIN ending in // and MAX = MIN + / under hierarchical order", () => {
    expect(messages(listResult("list /xyz// /xyz///", {}, HIERARCHICAL))).toEqual([
      "A key ending in / sorts one level up under hierarchical order, so this range does not hold its children; `--prefix /xyz//` lists everything under it.",
    ]);
    // MAX other than MIN + "/" is not the idiom.
    expect(messages(listResult("list /xyz// /xyz//z", { keys: ["/xyz//a"] }, HIERARCHICAL))).toEqual([]);
  });

  test("N6 and N7 are not about index bounds, which are secondary keys", () => {
    expect(messages(listResult("list --index i /xyz/ /xyz//", { indexConcatenated: true }, NATURAL))).toEqual([
      "With --index, each shard's keys are in secondary-key order and the shards follow one another in shard order: Oxia does not return the secondary key with a listed key, so Studio cannot merge them.",
      "No key of index i lies in this range.",
    ]);
  });

  test("N8: merged under an assumed order the probe proved", () => {
    expect(messages(listResult("list", { keys: ["a"] }, { order: "hierarchical", learnedBy: "assumed" }))).toEqual([
      "Keys are merged in hierarchical order, assumed: no key in this namespace holds /, and without / both orders sort keys the same way.",
    ]);
  });

  test("N8b: merged under an assumed order the byte cap ended", () => {
    const verdict: OrderVerdict = { order: "hierarchical", learnedBy: "assumed", exhausted: true };
    expect(messages(scanResult("range-scan", { records: [record("a", "1")] }, verdict))).toEqual([
      "Keys are merged in hierarchical order, assumed: Studio could not tell the orders apart from the keys read.",
    ]);
  });

  test("N8 and N8b need a merge: one shard read is no merge", () => {
    const assumed: OrderVerdict = { order: "hierarchical", learnedBy: "assumed" };
    expect(messages(listResult("list -p pk", { keys: ["a"], shardsRead: 1 }, assumed))).toEqual([]);
    // Two shards are the smallest merge.
    expect(messages(listResult("list", { keys: ["a"], shardsRead: 2 }, assumed))).toEqual([
      "Keys are merged in hierarchical order, assumed: no key in this namespace holds /, and without / both orders sort keys the same way.",
    ]);
  });

  test("N8 and N8b need a merge: an index read over many shards is concatenated, never merged", () => {
    const assumed: OrderVerdict = { order: "hierarchical", learnedBy: "assumed" };
    expect(
      messages(listResult("list --index i a b", { keys: ["/p"], shardsRead: 3, indexConcatenated: true }, assumed)),
    ).toEqual([
      "With --index, each shard's keys are in secondary-key order and the shards follow one another in shard order: Oxia does not return the secondary key with a listed key, so Studio cannot merge them.",
    ]);
  });

  test("N8 and N8b need a merge: a comparison get selects under the order and merges nothing", () => {
    const verdict: OrderVerdict = { order: "hierarchical", learnedBy: "assumed", exhausted: true };
    expect(messages(getResult("get -t floor /a", record("/a", "x"), verdict))).toEqual([]);
  });

  test("N9: --index over more than one shard", () => {
    expect(
      messages(scanResult("range-scan --index i a b", { records: [record("/p", "1")], indexConcatenated: true })),
    ).toEqual([
      "With --index, each shard's keys are in secondary-key order and the shards follow one another in shard order: Oxia does not return the secondary key with a listed key, so Studio cannot merge them.",
    ]);
  });

  test("N10: a get's value withheld", () => {
    expect(messages(getResult("get /big", { ...record("/big", undefined), withheld: true }))).toEqual([
      "The value of /big is larger than 16 MiB, the most Studio receives in one message, so it is withheld; its version is shown.",
    ]);
  });

  test("N11 and N12: a matching -a and -n, after the notices about the answer", () => {
    const parsed = parse("-a localhost:6648 -n default get /no", { endpoint: "localhost:6648", namespace: "default" });
    const outcome = {
      kind: "get",
      command: parsed.command as Extract<OxiaCommand, { kind: "get" }>,
      answer: undefined,
      namespace: NS,
    } as OxiaOutcome;
    expect(messages(oxiaResult(outcome, parsed, OXIA_CELL_LIMIT, 1))).toEqual([
      "Oxia holds no key /no in namespace `default`.",
      "-a names this connection's own endpoint, so it changes nothing: Host and Port on the connection decide where Studio connects.",
      "-n names this connection's own namespace, so it changes nothing: Namespace is set on the connection.",
    ]);
  });

  test("N13: a whole-namespace read that answered nothing", () => {
    expect(messages(listResult("list", {}))).toEqual(["The namespace `default` holds no keys."]);
    expect(messages(scanResult("range-scan", {}))).toEqual(["The namespace `default` holds no keys."]);
    // Bounds, a prefix or a partition key say nothing about the namespace.
    expect(messages(listResult("list a", {}))).toEqual([]);
    expect(messages(listResult("list --prefix /a/", {}))).toEqual([]);
    expect(messages(listResult("list -p pk", { shardsRead: 1 }))).toEqual([]);
    expect(messages(listResult("list -e /z", {}))).toEqual([]);
  });

  test("N13 is not about a stop: a stall with no rows says only where the result stopped", () => {
    expect(messages(scanResult("range-scan", { more: true, stoppedBy: "receive-cap" }))).toEqual([
      "A record in this range is larger than the 16 MiB receive cap, so range-scan stopped after 0 records: list the keys with list, then read each with get, which shows such a value's version and withholds the value.",
    ]);
    expect(messages(listResult("list", { more: true, stoppedBy: "bytes" }))).toEqual([
      "The result stopped after 0 keys, at the 8 MiB of keys a console result holds: narrow the range.",
    ]);
  });

  test("N14: an index read that answered nothing, never N13", () => {
    expect(messages(listResult("list --index by-email a b", { shardsRead: 1 }))).toEqual([
      "No key of index by-email lies in this range.",
    ]);
  });

  test("a result with no notice carries no warnings member", () => {
    expect(getResult("get /a", record("/a", "x")).warnings).toBeUndefined();
  });

  test("keys in notices are spelled by shownKey: quoted, JSON for a CR, cut at 120 characters", () => {
    expect(messages(getResult("get 'a b'", undefined))).toEqual(["Oxia holds no key 'a b' in namespace `default`."]);
    const long = `/${"k".repeat(130)}`;
    expect(messages(getResult(`get ${long}`, undefined))[0]).toBe(
      `Oxia holds no key ${long.slice(0, 120)}... in namespace \`default\`.`,
    );
    expect(messages(getResult("get -t floor /b", record("a\rb", "x"), HIERARCHICAL))).toEqual([
      'get -t floor asked for /b; the key found is "a\\rb".',
    ]);
  });
});
