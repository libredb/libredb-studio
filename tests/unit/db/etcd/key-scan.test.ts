/**
 * The Keys panel's pages over etcd (spec 4.6, 4.7): the declaration, the opaque cursor, one walk pinned
 * to its first page's revision, the total its first page counted, the keys that are not UTF-8 counted
 * in `skipped`, and every refusal raised before any request.
 *
 * The key space is `tests/helpers/etcd-walk-space.ts`, which answers a `Range` as etcd does and refuses a
 * range a reader's grants do not cover, so a page that asked outside the grants fails here as it would
 * against etcd.
 */
import { describe, expect, test } from "bun:test";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { keyScanShape } from "@/lib/db/types";
import { EtcdError, type EtcdPermission, type EtcdRangeRequest } from "@/lib/db/providers/keyvalue/etcd/client";
import type { EtcdErrorConnection } from "@/lib/db/providers/keyvalue/etcd/errors";
import { prefixRangeEnd } from "@/lib/db/providers/keyvalue/etcd/keys";
import {
  decodeScanCursor,
  encodeScanCursor,
  ETCD_KEY_SCAN,
  scanEtcdKeysPage,
} from "@/lib/db/providers/keyvalue/etcd/key-scan";
import type { EtcdSurfaceContext } from "@/lib/db/providers/keyvalue/etcd/objects";
import { describeScope, readableScope, writableScope } from "@/lib/db/providers/keyvalue/etcd/permissions";
import { createFakeEtcdClient, type FakeEtcdClient } from "../../../helpers/etcd-fake-client";
import { enc, etcdWalkSpace, type EtcdWalkSpaceOptions } from "../../../helpers/etcd-walk-space";

const CONNECTION: EtcdErrorConnection = {
  host: "etcd.test",
  port: 2379,
  runtimeReportsTlsCause: true,
  receiveCapBytes: 8 * 1024 * 1024,
  timeoutMs: 60_000,
};
const COMPACTED = () => new EtcdError("compacted", "etcdserver: mvcc: required revision has been compacted", 11);
const pad = (n: number, width = 5) => String(n).padStart(width, "0");
/** The character a lossy decode puts where bytes are not UTF-8, which no name may hold (plan Review Focus 1). */
const REPLACEMENT = String.fromCharCode(0xfffd);

function surface(over: Partial<EtcdSurfaceContext> = {}): EtcdSurfaceContext {
  return {
    readable: { kind: "all" },
    writable: { kind: "all" },
    signal: new AbortController().signal,
    now: () => 0,
    errors: CONNECTION,
    ...over,
  };
}
const grantPrefix = (prefix: string): EtcdPermission => ({
  type: "read",
  key: enc(prefix),
  rangeEnd: prefixRangeEnd(enc(prefix)),
});
const grantKey = (key: string): EtcdPermission => ({ type: "read", key: enc(key) });
function reader(grants: readonly EtcdPermission[], over: Partial<EtcdSurfaceContext> = {}): EtcdSurfaceContext {
  return surface({
    readable: readableScope(grants),
    writable: writableScope(grants),
    principal: { name: "reader", via: "password" },
    ...over,
  });
}
function spaceClient(keys: Iterable<string | Uint8Array>, options: EtcdWalkSpaceOptions = {}) {
  const space = etcdWalkSpace(keys, options);
  return { client: createFakeEtcdClient({ range: space.range }), space };
}
const rangeRequests = (client: FakeEtcdClient) => client.calls.map((call) => call.args[0] as EtcdRangeRequest);
const start = (count = ETCD_KEY_SCAN.defaultCount, pattern?: string) => ({
  cursor: "0",
  count,
  ...(pattern === undefined ? {} : { pattern }),
});

describe("the declaration (spec 4.6, KE3b)", () => {
  test("a / convention, an opaque cursor, a literal prefix and a total the walk counts", () => {
    expect(keyScanShape(ETCD_KEY_SCAN)).toEqual({
      separator: "/",
      cursor: "opaque",
      pattern: "prefix",
      totalScope: "walk",
    });
    expect(ETCD_KEY_SCAN.defaultCount).toBeGreaterThan(0);
    expect(ETCD_KEY_SCAN.defaultCount).toBeLessThanOrEqual(ETCD_KEY_SCAN.maxCount);
  });
});

describe("the cursor (spec 4.6)", () => {
  test("k:, the next key in base64url, the pinned revision and the total, read back as they were written", () => {
    const cursor = encodeScanCursor(enc("/app/x"), "105", "42");
    expect(cursor).toBe("k:L2FwcC94:105:42");
    expect(decodeScanCursor(cursor)).toEqual({ nextKey: enc("/app/x"), revision: "105", total: "42" });
    const binary = new Uint8Array([0x2f, 0xff, 0x00]);
    expect(decodeScanCursor(encodeScanCursor(binary, "7", "0"))).toEqual({
      nextKey: binary,
      revision: "7",
      total: "0",
    });
    expect(decodeScanCursor("0")).toBe("start");
    // The largest revision and count etcd holds are read; one more is not a cursor this provider wrote.
    expect(decodeScanCursor("k:AA:9223372036854775807:9223372036854775807")).toEqual({
      nextKey: new Uint8Array([0]),
      revision: "9223372036854775807",
      total: "9223372036854775807",
    });
  });

  test("a cursor this provider did not write reads as none", () => {
    for (const cursor of [
      "",
      "1",
      "k::1:1",
      "k:AA:0:1",
      "k:AA:01:1",
      "k:AA:1:01",
      "k:AA:1",
      "k:AA:1:1:1",
      "x:AA:1:1",
      "k:A=:1:1",
      "k:AB:1:1",
      "k:AA:12345678901234567890:1",
      "k:AA:9223372036854775808:1",
      "k:AA:1:9223372036854775808",
    ]) {
      expect(decodeScanCursor(cursor)).toBeUndefined();
    }
  });
});

describe("a page (spec 4.6)", () => {
  const KEYS = Array.from({ length: 5 }, (_unused, index) => `/app/${index}`);

  test("the first page is one keys_only Range over the prefix range, its count the walk's total, its revision pinned in the cursor", async () => {
    const { client } = spaceClient([...KEYS, "/apple/x"]);
    const page = await scanEtcdKeysPage(client, surface(), start(2, "/app/"));
    expect(page).toEqual({
      keys: ["/app/0", "/app/1"],
      cursor: encodeScanCursor(new Uint8Array([...enc("/app/1"), 0]), "100", "5"),
      total: 5,
      types: {},
    });
    expect(rangeRequests(client)).toEqual([
      { key: enc("/app/"), rangeEnd: prefixRangeEnd(enc("/app/")), limit: 2, keysOnly: true },
    ]);
  });

  test("a later page reads from the cursor's key at its revision, and answers the total the first page counted", async () => {
    const { client } = spaceClient([...KEYS, "/apple/x"], { revision: "130" });
    const cursor = encodeScanCursor(new Uint8Array([...enc("/app/1"), 0]), "100", "5");
    const page = await scanEtcdKeysPage(client, surface(), { cursor, count: 2, pattern: "/app/" });
    expect(page).toMatchObject({ keys: ["/app/2", "/app/3"], total: 5 });
    expect(decodeScanCursor(page.cursor)).toMatchObject({ revision: "100", total: "5" });
    expect(rangeRequests(client)[0]).toEqual({
      key: new Uint8Array([...enc("/app/1"), 0]),
      rangeEnd: prefixRangeEnd(enc("/app/")),
      limit: 2,
      keysOnly: true,
      revision: "100",
    });
    const last = await scanEtcdKeysPage(client, surface(), { cursor: page.cursor, count: 2, pattern: "/app/" });
    expect(last).toMatchObject({ keys: ["/app/4"], cursor: "0", total: 5 });
  });

  test("no pattern and an empty one walk the whole key space; a prefix walks exactly its bytes and never a sibling that shares them", async () => {
    const { client } = spaceClient(["/app/x", "/apple/x", "plain"]);
    const every = { key: new Uint8Array([0]), rangeEnd: new Uint8Array([0]) };
    expect((await scanEtcdKeysPage(client, surface(), start())).keys).toEqual(["/app/x", "/apple/x", "plain"]);
    // An empty pattern is no pattern: etcd refuses an empty key, so it is never sent as a prefix of no bytes.
    expect((await scanEtcdKeysPage(client, surface(), start(10, ""))).keys).toEqual(["/app/x", "/apple/x", "plain"]);
    expect((await scanEtcdKeysPage(client, surface(), start(10, "/app/"))).keys).toEqual(["/app/x"]);
    const requests = rangeRequests(client);
    expect(requests[0]).toMatchObject(every);
    expect(requests[1]).toMatchObject(every);
    expect(requests[2]).toMatchObject({ key: enc("/app/"), rangeEnd: prefixRangeEnd(enc("/app/")) });
  });

  test("a key that is not UTF-8 is counted in skipped with the reason, never listed with replacement characters (plan Review Focus 1)", async () => {
    const { client } = spaceClient([
      "/app/a",
      new Uint8Array([...enc("/app/"), 0xff]),
      new Uint8Array([0x2f, 0xff, 0xfe]),
    ]);
    const page = await scanEtcdKeysPage(client, surface(), start());
    expect(page.keys).toEqual(["/app/a"]);
    expect(page.total).toBe(3);
    expect(page.skipped).toEqual({
      count: 2,
      reason:
        "they are not UTF-8 text, so no name a row can carry addresses them; read them with a typed get, which shows them in base64",
    });
    for (const key of page.keys) expect(key).not.toContain(REPLACEMENT);
  });

  test("keys that strain the path model are listed as exactly their text (plan Review Focus 1)", async () => {
    const keys = ["/a//b", "/app/", "/", "/sp ace", "/q\"uo'te", "/new\nline", "/#hash", "/$HOME", "-lead"];
    const { client } = spaceClient(keys);
    const page = await scanEtcdKeysPage(client, surface(), start());
    expect([...page.keys].sort()).toEqual([...keys].sort());
    expect(page.skipped).toBeUndefined();
  });

  test("a very flat directory is paged and never read whole (plan Review Focus 4)", async () => {
    const { client, space } = spaceClient(
      Array.from({ length: 200_000 }, (_unused, index) => `/flat/${pad(index, 6)}`),
    );
    const page = await scanEtcdKeysPage(client, surface(), start(ETCD_KEY_SCAN.defaultCount, "/flat/"));
    expect(page.keys).toHaveLength(ETCD_KEY_SCAN.defaultCount);
    expect(page.total).toBe(200_000);
    expect(space.served()).toBe(ETCD_KEY_SCAN.defaultCount);
  });
});

describe("refusals, each before any request (spec 4.6, E14, R11 CF-18)", () => {
  test("a database is refused naming the field: etcd walks one key space", async () => {
    const { client } = spaceClient(["/app/a"]);
    const error = await scanEtcdKeysPage(client, surface(), { ...start(), database: 0 }).catch((caught) => caught);
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(
      'etcd walks one key space and has no numbered database, so "database" names nothing: leave it out.',
    );
    expect(client.calls).toEqual([]);
  });

  test("a count outside 1 to maxCount is refused, because a Range limit of 0 reads the whole range (E14)", async () => {
    const { client } = spaceClient(["/app/a"]);
    const refusals = await Promise.all(
      [0, 1.5, ETCD_KEY_SCAN.maxCount + 1].map((count) =>
        scanEtcdKeysPage(client, surface(), start(count)).catch((caught) => caught),
      ),
    );
    for (const error of refusals) {
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toBe(
        `"count" must be a whole number from 1 to ${ETCD_KEY_SCAN.maxCount.toLocaleString("en-US")}.`,
      );
    }
    expect(client.calls).toEqual([]);
  });

  test("a cursor this provider did not write and a prefix that is not exact text are refused", async () => {
    const { client } = spaceClient(["/app/a"]);
    const foreign = await scanEtcdKeysPage(client, surface(), { cursor: "12", count: 10 }).catch((caught) => caught);
    expect(foreign).toBeInstanceOf(DatabaseConfigError);
    expect(foreign.message).toBe("This cursor was not written by the etcd provider: start the walk again.");
    const inexact = await scanEtcdKeysPage(client, surface(), start(10, "/app/\uD800")).catch((caught) => caught);
    expect(inexact).toBeInstanceOf(DatabaseConfigError);
    expect(inexact.message).toBe(
      "The prefix holds a character that is not text, so it names no exact bytes: type it again.",
    );
    expect(client.calls).toEqual([]);
  });
});

describe("failures between pages (plan Review Focus 2 and 3)", () => {
  test("a compaction since the walk began tells the reader to start the walk again, never etcd's typed-revision sentence", async () => {
    const client = createFakeEtcdClient({ range: async () => Promise.reject(COMPACTED()) });
    const cursor = encodeScanCursor(enc("/app/1"), "100", "5");
    const error = await scanEtcdKeysPage(client, surface(), { cursor, count: 2, pattern: "/app/" }).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      "A compaction overtook this walk of the keys: etcd compacted revision 100, the revision its pages are pinned to, after the walk began, so it cannot go on from this page. Start the walk again. (etcd: mvcc: required revision has been compacted)",
    );
    expect(error.message).not.toContain("ask for a later revision");
  });

  test("a compaction that overtakes the first page's count of another readable range says the same, and answers no page", async () => {
    const grants = [grantPrefix("/app/a/"), grantPrefix("/app/x/")];
    const space = etcdWalkSpace(["/app/a/1", "/app/x/a"], { readable: grants });
    const client = createFakeEtcdClient({
      range: async (request) => (request.countOnly === true ? Promise.reject(COMPACTED()) : space.range(request)),
    });
    const error = await scanEtcdKeysPage(client, reader(grants), start()).catch((caught) => caught);
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toContain("A compaction overtook this walk of the keys: etcd compacted revision 100,");
  });

  test("a member that stopped is a connection failure, never a partial page", async () => {
    const client = createFakeEtcdClient({
      range: async () => Promise.reject(new EtcdError("unavailable", "etcdserver: server stopped", 14)),
    });
    const cursor = encodeScanCursor(enc("/app/1"), "100", "5");
    const error = await scanEtcdKeysPage(client, surface(), { cursor, count: 2, pattern: "/app/" }).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toContain("etcd did not answer the Keys panel walk.");
  });

  test("a sign-in that was not renewed and a lost quorum are raised as themselves (plan Review Focus 3)", async () => {
    const cases: [EtcdError, typeof AuthenticationError | typeof ConnectionError, string][] = [
      [new EtcdError("unauthenticated", "etcdserver: invalid auth token", 16), AuthenticationError, "sign-in"],
      [new EtcdError("no-leader", "etcdserver: no leader", 14), ConnectionError, "lost quorum"],
    ];
    const cursor = encodeScanCursor(enc("/app/1"), "100", "5");
    const errors = await Promise.all(
      cases.map(([failure]) =>
        scanEtcdKeysPage(createFakeEtcdClient({ range: async () => Promise.reject(failure) }), surface(), {
          cursor,
          count: 2,
        }).catch((caught) => caught),
      ),
    );
    for (const [index, [, kind, words]] of cases.entries()) {
      expect(errors[index]).toBeInstanceOf(kind);
      expect(errors[index].message).toContain(words);
    }
  });

  test("a failure in a later readable range of a page fails the page whole, with no key of the ranges before it", async () => {
    const grants = [grantPrefix("/app/a/"), grantPrefix("/app/x/")];
    const space = etcdWalkSpace(["/app/a/1", "/app/x/a"], { readable: grants });
    let answered = 0;
    const client = createFakeEtcdClient({
      range: async (request) => {
        if (request.countOnly === true) return space.range(request);
        answered += 1;
        if (answered > 1) throw new EtcdError("unavailable", "etcdserver: server stopped", 14);
        return space.range(request);
      },
    });
    const outcome = await scanEtcdKeysPage(client, reader(grants), start()).catch((caught) => caught);
    expect(outcome).toBeInstanceOf(ConnectionError);
    expect(outcome).not.toHaveProperty("keys");
  });
});

describe("a user who is not root (spec 4.7)", () => {
  const KEYS = ["/app/a/1", "/app/a/2", "/app/b", "/app/x/a", "/app/x/b", "/app/x/c", "/config/a", "/config/b"];

  test("the walk reads only the pieces the grants cover, counts each other piece once at the pinned revision, and answers their sum", async () => {
    const grants = [grantPrefix("/app/a/"), grantKey("/app/x/b"), grantKey("/config/a")];
    const { client } = spaceClient(KEYS, { readable: grants });
    const page = await scanEtcdKeysPage(client, reader(grants), start());
    expect(page).toMatchObject({ keys: ["/app/a/1", "/app/a/2", "/app/x/b", "/config/a"], cursor: "0", total: 4 });
    const requests = rangeRequests(client);
    const counted = requests.filter((request) => request.countOnly === true);
    expect(counted).toHaveLength(2);
    expect(counted[0]).toMatchObject({ key: enc("/app/x/b"), limit: 1, countOnly: true, revision: "100" });
    expect(counted[1]).toMatchObject({ key: enc("/config/a"), limit: 1, countOnly: true, revision: "100" });
    for (const request of requests.slice(1)) expect(request.revision).toBe("100");
    // Every read that fills the page is keys_only, the later pieces' reads included.
    for (const request of requests.filter((each) => each.countOnly !== true)) expect(request.keysOnly).toBe(true);
  });

  test("granted /app/x/a and /app/x/b, Browse Keys on /app/x/* lists both, and its total is 2 (spec 4.1, 4.7)", async () => {
    const grants = [grantKey("/app/x/a"), grantKey("/app/x/b")];
    const { client } = spaceClient(KEYS, { readable: grants });
    expect(await scanEtcdKeysPage(client, reader(grants), start(ETCD_KEY_SCAN.defaultCount, "/app/x/"))).toMatchObject({
      keys: ["/app/x/a", "/app/x/b"],
      cursor: "0",
      total: 2,
    });
  });

  test("a page fills across pieces while it has room, and the next page resumes in the right piece", async () => {
    const grants = [grantPrefix("/app/a/"), grantPrefix("/app/x/")];
    const { client } = spaceClient(KEYS, { readable: grants });
    const first = await scanEtcdKeysPage(client, reader(grants), start(3));
    expect(first).toMatchObject({ keys: ["/app/a/1", "/app/a/2", "/app/x/a"], total: 5 });
    const second = await scanEtcdKeysPage(client, reader(grants), { cursor: first.cursor, count: 3 });
    expect(second).toMatchObject({ keys: ["/app/x/b", "/app/x/c"], cursor: "0", total: 5 });
  });

  test("a page whose room runs out as a piece ends resumes at the start of the next piece", async () => {
    const grants = [grantPrefix("/app/a/"), grantPrefix("/app/x/")];
    const { client } = spaceClient(KEYS, { readable: grants });
    const first = await scanEtcdKeysPage(client, reader(grants), start(2));
    expect(first.keys).toEqual(["/app/a/1", "/app/a/2"]);
    expect(decodeScanCursor(first.cursor)).toMatchObject({ nextKey: enc("/app/x/") });
  });

  test("overlapping grants of two roles count each key once", async () => {
    const grants = [grantPrefix("/app/"), grantPrefix("/app/x/")];
    const { client } = spaceClient(KEYS, { readable: grants });
    const page = await scanEtcdKeysPage(client, reader(grants), start());
    expect(page.total).toBe(6);
    expect(new Set(page.keys).size).toBe(page.keys.length);
  });

  test("a prefix outside every grant answers no keys and a total of 0 with no request", async () => {
    const grants = [grantPrefix("/app/")];
    const { client } = spaceClient(KEYS, { readable: grants });
    expect(await scanEtcdKeysPage(client, reader(grants), start(10, "/config/"))).toEqual({
      keys: [],
      cursor: "0",
      total: 0,
      types: {},
    });
    expect(client.calls).toEqual([]);
  });

  test("a cursor whose key lies outside every readable piece is refused: the grants changed, so the walk starts again", async () => {
    const grants = [grantPrefix("/app/a/")];
    const { client } = spaceClient(KEYS, { readable: grants });
    const cursor = encodeScanCursor(enc("/config/a"), "100", "2");
    await expect(scanEtcdKeysPage(client, reader(grants), { cursor, count: 10 })).rejects.toThrow(
      "This cursor does not continue a walk of the keys this connection may read under this prefix: start the walk again.",
    );
    expect(client.calls).toEqual([]);
  });

  test("a page etcd refuses names what the user may read", async () => {
    const grants = [grantPrefix("/app/")];
    const { client } = spaceClient(KEYS, { readable: [] });
    const error = await scanEtcdKeysPage(client, reader(grants), start()).catch((caught) => caught);
    expect(error).toBeInstanceOf(QueryError);
    // The table's sentence names the range the page asked for, then what the user may read.
    expect(error.message).toContain("etcd refused the Keys panel walk on /app/ (prefix):");
    expect(error.message).toContain(`etcd user reader may read: ${describeScope(readableScope(grants))}.`);
  });
});
