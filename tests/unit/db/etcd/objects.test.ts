/**
 * The etcd object surface (spec 4.1 to 4.4, 4.7, E13): the kinds, the prefix-group walk through the fake
 * client with `prefixGroups`, the set function of `keys.ts`, as its oracle, the permission-aware walks,
 * the fixed columns, and every source part of 4.4.
 *
 * The key space is `tests/helpers/etcd-walk-space.ts`, which answers a `Range` as etcd does, holds a
 * pinned revision apart from the header's, and refuses a range the grants do not cover, so a walk that
 * asked outside a reader's grants fails here the way it fails against etcd.
 */
import { describe, expect, test } from "bun:test";
import { AuthenticationError, ConnectionError, QueryError } from "@/lib/db/errors";
import { INVENTORY_LIMIT } from "@/lib/db/inventory-bounds";
import {
  callerBoundTruncationReason,
  enumerableKinds,
  keyBrowserKind,
  sourceBoundTruncationReason,
} from "@/lib/db/object-kinds";
import type { DatabaseObject, ObjectSourceDocument, ProviderCapabilities } from "@/lib/db/types";
import { EtcdError, type EtcdPermission, type EtcdRangeRequest } from "@/lib/db/providers/keyvalue/etcd/client";
import type { EtcdErrorConnection } from "@/lib/db/providers/keyvalue/etcd/errors";
import { assessCommand } from "@/lib/db/providers/keyvalue/etcd/guard";
import { groupLabel, prefixGroups, prefixRangeEnd } from "@/lib/db/providers/keyvalue/etcd/keys";
import {
  countEtcdObjects,
  describeEtcdObject,
  describeEtcdObjects,
  ETCD_GROUP_CAP,
  ETCD_OBJECT_KINDS,
  ETCD_WALK_FIRST_PAGE,
  ETCD_WALK_KEY_CAP,
  ETCD_WALK_MAX_PAGE,
  ETCD_WALK_PAGE_BYTES,
  ETCD_WALK_SEGMENT_BUDGET,
  type EtcdObjectClient,
  type EtcdSurfaceContext,
  groupReadRanges,
  listEtcdObjects,
  readEtcdObjectSource,
  surfaceErrorContext,
} from "@/lib/db/providers/keyvalue/etcd/objects";
import { describeScope, readableScope, writableScope } from "@/lib/db/providers/keyvalue/etcd/permissions";
import { viewValue } from "@/lib/db/providers/keyvalue/etcd/values";
import { readOnlySentence, refuseBeforeSend } from "@/lib/db/providers/keyvalue/etcd/write-policy";
import { createFakeEtcdClient, type FakeEtcdClient } from "../../../helpers/etcd-fake-client";
import { enc, type EtcdWalkSpace, etcdWalkSpace, type EtcdWalkSpaceOptions } from "../../../helpers/etcd-walk-space";

const CONNECTION: EtcdErrorConnection = {
  host: "etcd.test",
  port: 2379,
  runtimeReportsTlsCause: true,
  receiveCapBytes: 8 * 1024 * 1024,
  timeoutMs: 60_000,
};
/** etcd-1 answers every call below, as the connection's own member. */
const HEADER = { clusterId: "1", memberId: "10276657743932975437", revision: "100", raftTerm: "3" };
const MEMBERS = [
  {
    id: "10276657743932975437",
    name: "etcd-1",
    peerUrls: ["https://10.0.0.1:2380"],
    clientUrls: ["https://10.0.0.1:2379"],
    isLearner: false,
  },
  {
    id: "10501334649042878790",
    name: "",
    peerUrls: ["https://10.0.0.2:2380"],
    clientUrls: ["https://10.0.0.2:2379"],
    isLearner: true,
  },
];
const DENIED = () => new EtcdError("permission-denied", "etcdserver: permission denied", 7);
const COMPACTED = () => new EtcdError("compacted", "etcdserver: mvcc: required revision has been compacted", 11);
const pad = (n: number, width = 5) => String(n).padStart(width, "0");
/** The character a lossy decode puts where bytes are not UTF-8, which no name may hold (plan Review Focus 1). */
const REPLACEMENT = String.fromCharCode(0xfffd);
const en = (n: number) => n.toLocaleString("en-US");

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

const grantPrefix = (type: EtcdPermission["type"], prefix: string): EtcdPermission => ({
  type,
  key: enc(prefix),
  rangeEnd: prefixRangeEnd(enc(prefix)),
});
const grantKey = (type: EtcdPermission["type"], key: string | Uint8Array): EtcdPermission => ({
  type,
  key: typeof key === "string" ? enc(key) : key,
});
const grantFromKey = (type: EtcdPermission["type"], key: string): EtcdPermission => ({
  type,
  key: enc(key),
  rangeEnd: new Uint8Array([0]),
});

/** A user who is not root, its scopes from `readableScope` and `writableScope` over its grants (spec 4.7). */
function reader(grants: readonly EtcdPermission[], over: Partial<EtcdSurfaceContext> = {}): EtcdSurfaceContext {
  return surface({
    readable: readableScope(grants),
    writable: writableScope(grants),
    principal: { name: "reader", via: "password" },
    ...over,
  });
}

function surfaceClient(
  keys: Iterable<string | Uint8Array>,
  overrides: Partial<EtcdObjectClient> = {},
  options: EtcdWalkSpaceOptions = {},
): { readonly client: FakeEtcdClient; readonly space: EtcdWalkSpace } {
  const space = etcdWalkSpace(keys, options);
  const client = createFakeEtcdClient({
    range: space.range,
    memberList: async () => ({ header: HEADER, members: MEMBERS }),
    alarmList: async () => [],
    leaseLeases: async () => ({ header: HEADER, ids: ["7587863092875085001", "7587863092875085000"] }),
    userList: async () => ["reader", "root"],
    roleList: async () => ["reader", "root"],
    ...overrides,
  });
  return { client, space };
}

const rangeRequests = (client: FakeEtcdClient) =>
  client.calls.filter((call) => call.method === "range").map((call) => call.args[0] as EtcdRangeRequest);
const names = (rows: readonly DatabaseObject[]) => rows.map((row) => row.name);
const textOf = (document: ObjectSourceDocument, index: number) => (document.parts[index] as { text: string }).text;

describe("the declaration (spec 4.1, 3.4)", () => {
  test("six kinds in 4.1's order: the key enumerated by the Keys panel alone and editable, three whose count is their listing", () => {
    expect(ETCD_OBJECT_KINDS.map((kind) => [kind.id, kind.role, kind.label, kind.labelPlural])).toEqual([
      ["prefix", "relation", "Key Prefix", "Key Prefixes"],
      ["key", "config", "Key", "Keys"],
      ["member", "config", "Member", "Members"],
      ["lease", "config", "Lease", "Leases"],
      ["user", "config", "User", "Users"],
      ["role", "config", "Role", "Roles"],
    ]);
    expect(ETCD_OBJECT_KINDS.find((kind) => kind.id === "key")).toMatchObject({
      enumeratedBy: "key-browser",
      hasSource: true,
      sourceLanguage: "json",
      acceptsSourceEdits: true,
    });
    expect(ETCD_OBJECT_KINDS.filter((kind) => kind.countIsListing === true).map((kind) => kind.id)).toEqual([
      "lease",
      "user",
      "role",
    ]);
    expect(ETCD_OBJECT_KINDS.filter((kind) => kind.hasColumns === true).map((kind) => kind.id)).toEqual(["prefix"]);
    expect(
      ETCD_OBJECT_KINDS.filter((kind) => kind.hasSource === true).map((kind) => [kind.id, kind.sourceLanguage]),
    ).toEqual([
      ["key", "json"],
      ["member", "json"],
      ["lease", "json"],
      ["user", "json"],
      ["role", "json"],
    ]);
    for (const kind of ETCD_OBJECT_KINDS) expect(kind.acceptsRowWrites).toBeUndefined();
  });

  test("the surface counts exactly the kinds the shared derivation enumerates, and never the key", async () => {
    const capabilities = { objectKinds: ETCD_OBJECT_KINDS } as unknown as ProviderCapabilities;
    const counts = await countEtcdObjects(surfaceClient(["/app/a/x"]).client, surface());
    expect(Object.keys(counts)).toEqual(enumerableKinds(capabilities).map((kind) => kind.id));
    expect(keyBrowserKind(capabilities)?.id).toBe("key");
  });

  test("the walk's bounds: G below INVENTORY_LIMIT, P below S, the first page within the growth's ceiling (KE1)", () => {
    expect(ETCD_GROUP_CAP).toBeLessThan(INVENTORY_LIMIT);
    expect(ETCD_WALK_SEGMENT_BUDGET).toBeLessThan(ETCD_WALK_KEY_CAP);
    expect(ETCD_WALK_FIRST_PAGE).toBeLessThanOrEqual(ETCD_WALK_MAX_PAGE);
    for (const bound of [
      ETCD_GROUP_CAP,
      ETCD_WALK_KEY_CAP,
      ETCD_WALK_SEGMENT_BUDGET,
      ETCD_WALK_FIRST_PAGE,
      ETCD_WALK_MAX_PAGE,
      ETCD_WALK_PAGE_BYTES,
    ]) {
      expect(Number.isInteger(bound) && bound > 0).toBe(true);
    }
  });
});

describe("the prefix-group walk (spec 4.1, 4.3)", () => {
  test("every row of 4.1's table, each group named <prefix>*, equal to the set function over the same keys", async () => {
    const keys = [
      "/registry/pods/default/nginx",
      "/apisix/routes/1",
      "/apisix/plugins",
      "/service/batman/leader",
      "/config/a",
      "/config/b",
      "/app/cfg",
      "/app/x/y",
      "config/app/x",
      "/feature-flag",
      "plain",
      "compact_rev_key",
    ];
    const { client, space } = surfaceClient(keys);
    const rows = await listEtcdObjects(client, surface(), "prefix");
    expect(names(rows)).toEqual([
      "/apisix/routes/*",
      "/app/x/*",
      "/config/*",
      "/registry/pods/*",
      "/service/batman/*",
      "config/app/*",
    ]);
    expect([...names(rows)].sort()).toEqual(prefixGroups(space.keys).groups.map(groupLabel).sort());
    expect(rows[0]).toEqual({ path: ["/apisix/routes/*"], name: "/apisix/routes/*", kind: "prefix" });
  });

  test("the sets of 4.1's tests: a mixed set, Cilium's and APISIX's", async () => {
    const cases: [string[], string[]][] = [
      [
        ["/registry/health", "/registry/pods/default/nginx", "/app/a/x", "/app/b", "/feature-flag"],
        ["/app/a/*", "/registry/pods/*"],
      ],
      [
        ["cilium/.heartbeat", "cilium/.initlock/r/1", "cilium/state/nodes/v1/c/n"],
        ["cilium/.initlock/*", "cilium/state/*"],
      ],
      [
        ["/apisix/consumers/jack", "/apisix/plugins", "/apisix/routes/1"],
        ["/apisix/consumers/*", "/apisix/routes/*"],
      ],
    ];
    const listed = await Promise.all(
      cases.map(([keys]) => listEtcdObjects(surfaceClient(keys).client, surface(), "prefix")),
    );
    expect(listed.map(names)).toEqual(cases.map(([, groups]) => groups));
  });

  test("keys that strain the path model: every row is a group named <prefix>*, none is a key, none holds a replacement character (plan Review Focus 1)", async () => {
    const keys: (string | Uint8Array)[] = [
      "/a//b",
      "/app/",
      "/",
      "/sp ace/x/y",
      "/quo\"te/it's/y",
      "/new\nline/x/y",
      "/hash#/x/y",
      "/dollar$/x/y",
      "/-lead/x/y",
      new Uint8Array([0x2f, 0xff, 0xfe, 0x2f, 0x78]),
      new Uint8Array([...enc("/bin/"), 0xff, 0xfe, ...enc("/x")]),
      "/bin/ok/x",
      new Uint8Array([...enc("/values/"), 0xff]),
      "/values/a",
    ];
    const { client, space } = surfaceClient(keys);
    const rows = await listEtcdObjects(client, surface(), "prefix");
    expect([...names(rows)].sort()).toEqual(prefixGroups(space.keys).groups.map(groupLabel).sort());
    const texts = keys.filter((key): key is string => typeof key === "string");
    for (const row of rows) {
      expect(row.name.endsWith("/*")).toBe(true);
      expect(row.name).not.toContain(REPLACEMENT);
      expect(texts).not.toContain(row.name);
      expect(row.path).toEqual([row.name]);
    }
    expect(names(rows)).toContain("/app/*");
    expect(names(rows)).toContain("/values/*");
    expect(names(rows)).toContain("/bin/ok/*");
  });

  test("keys only, a positive limit on every page, and every page after the first at the first page's revision (spec 4.3, E14)", async () => {
    const space = etcdWalkSpace(Array.from({ length: 450 }, (_unused, index) => `/flat/${pad(index)}`));
    let answered = 0;
    const client = createFakeEtcdClient({
      range: async (request) => {
        const answer = await space.range(request);
        answered += 1;
        // etcd's header names the store's current revision, which moves; the walk keeps the first one.
        return { ...answer, header: { ...answer.header, revision: String(100 + answered) } };
      },
    });
    await listEtcdObjects(client, surface(), "prefix");
    const requests = rangeRequests(client);
    // Each page starts just past the last key of the page before it, so a call the adapter renews and
    // sends again continues the walk and never restarts it (plan Review Focus 3).
    expect(requests.map((request) => request.key)).toEqual([
      new Uint8Array([0]),
      new Uint8Array([...enc("/flat/00099"), 0]),
      new Uint8Array([...enc("/flat/00299"), 0]),
    ]);
    expect(requests[0].revision).toBeUndefined();
    for (const request of requests.slice(1)) expect(request.revision).toBe("101");
    for (const request of requests) {
      expect(request.keysOnly).toBe(true);
      expect(request.limit).toBeGreaterThan(0);
      expect(request.countOnly).toBeUndefined();
      expect(request.serializable).toBeUndefined();
    }
  });

  test("the page size starts at the first page and doubles while pages stay small, never past its ceiling (KE1)", async () => {
    const expected: number[] = [];
    for (let size = ETCD_WALK_FIRST_PAGE; expected.length < 9; size = Math.min(size * 2, ETCD_WALK_MAX_PAGE)) {
      expected.push(size);
    }
    // Flat first segments each below P, so every key is read before its segment is decided.
    const needed = expected.reduce((sum, size) => sum + size, 0) + 1;
    const perSegment = ETCD_WALK_SEGMENT_BUDGET - 1;
    const keys = Array.from(
      { length: needed },
      (_unused, index) => `/s${pad(Math.floor(index / perSegment), 3)}/${pad(index % perSegment)}`,
    );
    const { client } = surfaceClient(keys);
    await listEtcdObjects(client, surface(), "prefix");
    const limits = rangeRequests(client).map((request) => request.limit);
    expect(limits.slice(0, expected.length)).toEqual(expected);
    for (const limit of limits) expect(limit).toBeLessThanOrEqual(ETCD_WALK_MAX_PAGE);
  });

  test("a page whose keys reach ETCD_WALK_PAGE_BYTES stops the growth (KE1)", async () => {
    const width = Math.ceil(ETCD_WALK_PAGE_BYTES / ETCD_WALK_FIRST_PAGE);
    const keys = Array.from(
      { length: ETCD_WALK_FIRST_PAGE * 3 },
      (_unused, index) => `/big/${pad(index)}${"x".repeat(width)}`,
    );
    const { client } = surfaceClient(keys);
    await listEtcdObjects(client, surface(), "prefix");
    expect(
      rangeRequests(client)
        .map((request) => request.limit)
        .slice(0, 3),
    ).toEqual([ETCD_WALK_FIRST_PAGE, ETCD_WALK_FIRST_PAGE, ETCD_WALK_FIRST_PAGE]);
  });

  test("a page that ends inside a recorded group sends the next page from that group's range end (spec 4.3)", async () => {
    const keys = [...Array.from({ length: 500 }, (_unused, index) => `/a/b/${pad(index, 3)}`), "/c/d/e"];
    const { client, space } = surfaceClient(keys);
    expect(names(await listEtcdObjects(client, surface(), "prefix"))).toEqual(["/a/b/*", "/c/d/*"]);
    expect(rangeRequests(client)[1].key).toEqual(prefixRangeEnd(enc("/a/b/")));
    expect(space.served()).toBe(ETCD_WALK_FIRST_PAGE + 1);
  });

  test("past G groups the listing holds the first G and the count is a floor naming the cap; exactly G is exact (spec 4.3, KE1)", async () => {
    const over = Array.from({ length: ETCD_GROUP_CAP + 1 }, (_unused, index) => `/g/${pad(index)}/k`);
    const rows = await listEtcdObjects(surfaceClient(over).client, surface(), "prefix");
    expect(rows).toHaveLength(ETCD_GROUP_CAP);
    expect(rows[0].name).toBe("/g/00000/*");
    expect((await countEtcdObjects(surfaceClient(over).client, surface())).prefix).toEqual({
      count: ETCD_GROUP_CAP,
      sampledFrom: `one key-prefix walk capped at ${en(ETCD_GROUP_CAP)} groups`,
    });
    const exact = over.slice(0, ETCD_GROUP_CAP);
    expect((await countEtcdObjects(surfaceClient(exact).client, surface())).prefix).toEqual({ count: ETCD_GROUP_CAP });
  });

  test("past S keys the walk stops, reads no more than S, and the count is a floor naming the bound (spec 4.3, KE1)", async () => {
    const perSegment = ETCD_WALK_SEGMENT_BUDGET - 1;
    const segments = Math.ceil(ETCD_WALK_KEY_CAP / perSegment) + 1;
    const keys = Array.from(
      { length: segments * perSegment },
      (_unused, index) => `/s${pad(Math.floor(index / perSegment), 3)}/${pad(index % perSegment)}`,
    );
    const { client, space } = surfaceClient(keys);
    const counts = await countEtcdObjects(client, surface());
    expect(counts.prefix).toEqual({
      count: Math.floor(ETCD_WALK_KEY_CAP / perSegment),
      sampledFrom: `one key-prefix walk that stopped after ${en(ETCD_WALK_KEY_CAP)} keys`,
    });
    expect(space.served()).toBe(ETCD_WALK_KEY_CAP);
  });

  test("one first segment of 200,000 two-segment keys ahead of the other groups is recorded undecided at P with a floor on its row, and the groups after it are still listed (spec 4.3, R13 D9, plan Review Focus 4)", async () => {
    const keys = [...Array.from({ length: 200_000 }, (_unused, index) => `/flat/${pad(index, 6)}`), "/zeta/a/b"];
    const { client, space } = surfaceClient(keys);
    expect(await listEtcdObjects(client, surface(), "prefix")).toEqual([
      {
        path: ["/flat/*"],
        name: "/flat/*",
        kind: "prefix",
        status: `At least ${en(ETCD_WALK_SEGMENT_BUDGET)} keys; this prefix was not read to the end, so its deeper groups are not listed`,
      },
      { path: ["/zeta/a/*"], name: "/zeta/a/*", kind: "prefix" },
    ]);
    // P keys of the segment and at most the page that reached P, then the one key after its range.
    expect(space.served()).toBeLessThanOrEqual(ETCD_WALK_SEGMENT_BUDGET + ETCD_WALK_MAX_PAGE + 1);
    expect((await countEtcdObjects(surfaceClient(keys).client, surface())).prefix).toEqual({
      count: 2,
      sampledFrom: `one key-prefix walk that read at most ${en(ETCD_WALK_SEGMENT_BUDGET)} keys under any one prefix`,
    });
  });

  test("a compaction between pages is one that overtook the walk, never etcd's typed-revision sentence (plan Review Focus 2)", async () => {
    const sentence =
      "A compaction overtook the key-prefix walk: etcd compacted revision 100, the revision its pages are pinned to, after the first page was read, so the groups read are not the whole listing and none is shown. Refresh the object tree to run the walk again. (etcd: mvcc: required revision has been compacted)";
    const compactedAfterFirstPage = () => {
      const space = etcdWalkSpace(Array.from({ length: 450 }, (_unused, index) => `/flat/${pad(index)}`));
      let answered = 0;
      return surfaceClient([], {
        range: async (request) => {
          answered += 1;
          if (answered > 1) throw COMPACTED();
          return space.range(request);
        },
      }).client;
    };
    const error = await listEtcdObjects(compactedAfterFirstPage(), surface(), "prefix").catch((caught) => caught);
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(sentence);
    expect(error.message).not.toContain("ask for a later revision");
    const counts = await countEtcdObjects(compactedAfterFirstPage(), surface());
    expect(counts.prefix).toEqual({ unavailable: sentence });
    expect(counts.member).toEqual({ count: 2 });
  });

  test("a failure between pages never presents a partial listing: a member that stopped, a sign-in not renewed, a lost quorum (plan Review Focus 3)", async () => {
    const cases: [EtcdError, typeof ConnectionError | typeof AuthenticationError, string][] = [
      [
        new EtcdError("unavailable", "etcdserver: server stopped", 14),
        ConnectionError,
        "etcd did not answer the Key Prefixes listing.",
      ],
      [new EtcdError("unauthenticated", "etcdserver: invalid auth token", 16), AuthenticationError, "sign-in"],
      [new EtcdError("no-leader", "etcdserver: no leader", 14), ConnectionError, "lost quorum"],
    ];
    const check = async ([failure, kind, words]: (typeof cases)[number]) => {
      const failingAfterFirstPage = () => {
        const space = etcdWalkSpace(Array.from({ length: 450 }, (_unused, index) => `/flat/${pad(index)}`));
        let answered = 0;
        return surfaceClient([], {
          range: async (request) => {
            answered += 1;
            if (answered > 1) throw failure;
            return space.range(request);
          },
        }).client;
      };
      const error = await listEtcdObjects(failingAfterFirstPage(), surface(), "prefix").catch((caught) => caught);
      expect(error).toBeInstanceOf(kind);
      expect(error.message).toContain(words);
      const counts = await countEtcdObjects(failingAfterFirstPage(), surface());
      expect(counts.prefix).toEqual({ unavailable: error.message });
      // The members come from a serializable MemberList, so the tree still answers them.
      expect(counts.member).toEqual({ count: 2 });
    };
    await Promise.all(cases.map(check));
  });

  test("a thrown value that is not a database error is a defect, and surfaces as itself", async () => {
    const defect = new TypeError("x is undefined");
    const failing = () => surfaceClient([], { range: async () => Promise.reject(defect) }).client;
    await expect(countEtcdObjects(failing(), surface())).rejects.toBe(defect);
    await expect(listEtcdObjects(failing(), surface(), "prefix")).rejects.toBe(defect);
  });
});

describe("the permission-aware walk (spec 4.7, plan Review Focus 5)", () => {
  const KEYS = [
    "/app/a/x",
    "/app/b",
    "/app/cfg",
    "/app/x/a",
    "/app/x/b",
    "/app/x/c",
    "/config/a",
    "/config/b",
    "/registry/pods/default/nginx",
    "/secret/x/y",
  ];
  const guarded = (grants: readonly EtcdPermission[], overrides: Partial<EtcdObjectClient> = {}) =>
    surfaceClient(KEYS, overrides, { readable: grants });
  /** READ on the whole key space, key 0x00 to range_end 0x00, held without the root role. */
  const EVERY_KEY_GRANT: readonly EtcdPermission[] = [
    { type: "read", key: new Uint8Array([0]), rangeEnd: new Uint8Array([0]) },
  ];

  test("granted /app/cfg and the prefix /app/x/, the walk answers /app/x/* alone and asks for nothing outside the grants", async () => {
    const grants = [grantKey("read", "/app/cfg"), grantPrefix("read", "/app/x/")];
    const { client } = guarded(grants);
    expect(await listEtcdObjects(client, reader(grants), "prefix")).toEqual([
      { path: ["/app/x/*"], name: "/app/x/*", kind: "prefix" },
    ]);
  });

  test("granted /app/x/a and /app/x/b, the walk answers /app/x/* once, carrying the two keys it may read", async () => {
    const grants = [grantKey("read", "/app/x/a"), grantKey("read", "/app/x/b")];
    expect(await listEtcdObjects(guarded(grants).client, reader(grants), "prefix")).toEqual([
      { path: ["/app/x/*"], name: "/app/x/*", kind: "prefix", readRanges: [{ key: "/app/x/a" }, { key: "/app/x/b" }] },
    ]);
    expect((await countEtcdObjects(guarded(grants).client, reader(grants))).prefix).toEqual({
      count: 1,
      sampledFrom: "the 2 ranges etcd user reader may read",
    });
  });

  test("a single-key grant inside a flat group opens and counts the group with no permission error (spec 4.1, 4.7)", async () => {
    const grants = [grantKey("read", "/config/a")];
    expect(await listEtcdObjects(guarded(grants).client, reader(grants), "prefix")).toEqual([
      { path: ["/config/*"], name: "/config/*", kind: "prefix", readRanges: [{ key: "/config/a" }] },
    ]);
    expect((await countEtcdObjects(guarded(grants).client, reader(grants))).prefix).toEqual({
      count: 1,
      sampledFrom: "the 1 range etcd user reader may read",
    });
  });

  test("READ on a prefix beside READWRITE on a prefix inside it, and two roles whose ranges overlap: every group listed once", async () => {
    const grants = [grantPrefix("read", "/app/"), grantPrefix("readwrite", "/app/x/"), grantPrefix("read", "/app/x/")];
    const { client, space } = guarded(grants);
    const rows = await listEtcdObjects(client, reader(grants), "prefix");
    const under = KEYS.filter((key) => key.startsWith("/app/")).map(enc);
    expect(names(rows)).toEqual(prefixGroups(under).groups.map(groupLabel));
    expect(new Set(names(rows)).size).toBe(rows.length);
    expect(space.served()).toBeLessThanOrEqual(under.length);
  });

  test("a range a recorded group holds whole is not read, and one that starts inside it is read from the group's end (spec 4.3, 4.7)", async () => {
    const grants: EtcdPermission[] = [
      grantKey("read", "/app/x/a"),
      grantKey("read", "/app/x/b"),
      { type: "read", key: enc("/app/x/m"), rangeEnd: enc("/app/z") },
    ];
    const keys = ["/app/x/a", "/app/x/b", "/app/x/n", "/app/y/1"];
    const { client } = surfaceClient(keys, {}, { readable: grants });
    expect(names(await listEtcdObjects(client, reader(grants), "prefix"))).toEqual(["/app/x/*", "/app/y/*"]);
    // /app/x/a records /app/x/*, /app/x/b lies inside it, and the third range is read from the group's end.
    expect(rangeRequests(client).map((request) => request.key)).toEqual([
      enc("/app/x/a"),
      prefixRangeEnd(enc("/app/x/")),
    ]);
  });

  test("once a group is recorded past the end of the grant being read, the walk leaves that grant and reads nothing more of it", async () => {
    const inside = Array.from({ length: ETCD_WALK_FIRST_PAGE + 50 }, (_unused, index) => `/app/x/big/${pad(index)}`);
    const grants = [grantPrefix("read", "/app/x/big/")];
    const { client } = surfaceClient([...KEYS, ...inside], {}, { readable: grants });
    expect(await listEtcdObjects(client, reader(grants), "prefix")).toEqual([
      { path: ["/app/x/*"], name: "/app/x/*", kind: "prefix", readRanges: [{ prefix: "/app/x/big/" }] },
    ]);
    // The first page records /app/x/* and its jump lands past the grant, so no second page is sent.
    expect(rangeRequests(client)).toHaveLength(1);
  });

  test("a from-key grant walks from its key to the end of the key space, and nowhere before it", async () => {
    const grants = [grantFromKey("read", "/config/")];
    expect(names(await listEtcdObjects(guarded(grants).client, reader(grants), "prefix"))).toEqual([
      "/config/*",
      "/registry/pods/*",
      "/secret/x/*",
    ]);
  });

  test("a grant whose key is not UTF-8 is walked by its bytes, and no generated read addresses it", async () => {
    const binary = new Uint8Array([...enc("/app/x/"), 0xff]);
    const grants = [grantKey("read", binary)];
    const { client } = surfaceClient([...KEYS, binary], {}, { readable: grants });
    expect(await listEtcdObjects(client, reader(grants), "prefix")).toEqual([
      { path: ["/app/x/*"], name: "/app/x/*", kind: "prefix", readRanges: [] },
    ]);
  });

  test("READ on the whole key space without the root role lists every group once, scoped to its one range", async () => {
    // The scopes as the provider builds them: a readable union that holds every key is the `all` of root,
    // so the principal the provider carries for a user who is not root is what scopes the walk (spec 4.7).
    const context = reader(EVERY_KEY_GRANT);
    expect(context.readable).toEqual({ kind: "all" });
    const { client, space } = guarded(EVERY_KEY_GRANT);
    const rows = await listEtcdObjects(client, context, "prefix");
    expect(names(rows)).toEqual(prefixGroups(space.keys).groups.map(groupLabel));
    for (const row of rows) expect(row.readRanges).toBeUndefined();
    expect((await countEtcdObjects(guarded(EVERY_KEY_GRANT).client, context)).prefix).toEqual({
      count: rows.length,
      sampledFrom: "the 1 range etcd user reader may read",
    });
  });

  test("a user who is not root whose grants read every key is still scoped: the users and roles folders carry 4.3's sentences, and a refused walk names what it may read (spec 4.3, 4.7, 5.6)", async () => {
    const refused = surfaceClient(KEYS, {
      range: async () => Promise.reject(DENIED()),
      userList: async () => Promise.reject(DENIED()),
      roleList: async () => Promise.reject(DENIED()),
    }).client;
    const counts = await countEtcdObjects(refused, reader(EVERY_KEY_GRANT));
    expect(counts.user).toEqual({
      unavailable: "Listing users needs the etcd root role, which reader does not hold (etcd: permission denied)",
    });
    expect(counts.role).toEqual({
      unavailable: "Listing roles needs the etcd root role, which reader does not hold (etcd: permission denied)",
    });
    // The grants changed on the server since they were read: the table's sentence names what they read.
    expect((counts.prefix as { unavailable: string }).unavailable).toContain("etcd user reader may read: every key.");
  });

  test("a walk a bound stopped under a scope names both, the bound and then the ranges (spec 4.3, 4.7)", async () => {
    const grants = [grantPrefix("read", "/g/")];
    const keys = Array.from({ length: ETCD_GROUP_CAP + 1 }, (_unused, index) => `/g/${pad(index)}/k`);
    const { client } = surfaceClient(keys, {}, { readable: grants });
    expect((await countEtcdObjects(client, reader(grants))).prefix).toEqual({
      count: ETCD_GROUP_CAP,
      sampledFrom: `one key-prefix walk capped at ${en(ETCD_GROUP_CAP)} groups, over the 1 range etcd user reader may read`,
    });
  });

  test("the scoped count says how many ranges were walked and never names one (E13)", async () => {
    const grants = [grantKey("read", "/app/x/a"), grantPrefix("read", "/config/")];
    const counts = await countEtcdObjects(guarded(grants).client, reader(grants));
    expect(counts.prefix).toEqual({ count: 2, sampledFrom: "the 2 ranges etcd user reader may read" });
    expect(JSON.stringify(counts)).not.toContain("/app/x/a");
    expect(JSON.stringify(counts)).not.toContain("/config/");
  });

  test("a user with no range to read is sent nothing and answers no group, its count scoped to 0 ranges (spec 4.7)", async () => {
    // The scope the provider also passes while a refused read of the grants is its own to report.
    const context = surface({
      readable: { kind: "ranges", ranges: [] },
      writable: { kind: "ranges", ranges: [] },
      principal: { name: "reader", via: "password" },
    });
    const { client } = surfaceClient(KEYS, {}, { readable: [] });
    expect(await listEtcdObjects(client, context, "prefix")).toEqual([]);
    expect((await countEtcdObjects(client, context)).prefix).toEqual({
      count: 0,
      sampledFrom: "the 0 ranges etcd user reader may read",
    });
    expect(rangeRequests(client)).toEqual([]);
  });

  test("a walk etcd refuses names what the user may read (spec 5.6)", async () => {
    const grants = [grantPrefix("read", "/app/")];
    // The grants changed on the server since they were read: etcd now refuses the range.
    const { client } = surfaceClient(KEYS, {}, { readable: [] });
    const counts = await countEtcdObjects(client, reader(grants));
    expect("unavailable" in counts.prefix).toBe(true);
    // The table's sentence names the range the walk asked for, then what the user may read.
    expect((counts.prefix as { unavailable: string }).unavailable).toContain(
      "etcd refused the Key Prefixes listing on /app/ (prefix):",
    );
    expect((counts.prefix as { unavailable: string }).unavailable).toContain(
      `etcd user reader may read: ${describeScope(readableScope(grants))}.`,
    );
  });

  test("surfaceErrorContext names what the user may read wherever the grants were read (spec 5.6)", () => {
    const grants = [grantPrefix("read", "/app/")];
    expect(surfaceErrorContext(surface(), "get")).toEqual({ command: "get", write: false, connection: CONNECTION });
    expect(surfaceErrorContext(reader(grants), "get", { write: true, range: "/app/x" })).toEqual({
      command: "get",
      write: true,
      range: "/app/x",
      readable: { user: "reader", ranges: describeScope(readableScope(grants)) },
      connection: CONNECTION,
    });
    // A user who is not root is scoped even when its grants read every key (spec 4.7).
    expect(surfaceErrorContext(reader(EVERY_KEY_GRANT), "get")).toEqual({
      command: "get",
      write: false,
      readable: { user: "reader", ranges: "every key" },
      connection: CONNECTION,
    });
  });

  test("a context scoped to grants that carries no principal is a composition defect, raised by every sentence that names the user", async () => {
    const grants = [grantKey("read", "/config/a")];
    const orphan = reader(grants, { principal: undefined });
    const defect =
      "An etcd surface context scoped to a user's grants carries no principal: the provider builds both from one connect (spec 4.7)";
    expect(() => surfaceErrorContext(orphan, "get")).toThrow(defect);
    await expect(countEtcdObjects(surfaceClient(KEYS).client, orphan)).rejects.toThrow(defect);
    const refused = surfaceClient([], { userList: async () => Promise.reject(DENIED()) }).client;
    await expect(listEtcdObjects(refused, surface({ principal: undefined }), "user")).rejects.toThrow(
      "carries no principal",
    );
  });
});

describe("groupReadRanges (spec 3.4, 4.7)", () => {
  const group = prefixGroups([enc("/app/x/a")]).groups[0];

  test("undefined where the scope covers the group", () => {
    expect(groupReadRanges(group, { kind: "all" })).toBeUndefined();
    expect(groupReadRanges(group, readableScope([grantPrefix("read", "/app/")]))).toBeUndefined();
  });

  test("a single key, a prefix and a start and end key, in byte order", () => {
    const grants: EtcdPermission[] = [
      grantKey("read", "/app/x/a"),
      grantPrefix("read", "/app/x/p/"),
      { type: "read", key: enc("/app/x/r"), rangeEnd: enc("/app/x/t") },
    ];
    expect(groupReadRanges(group, readableScope(grants))).toEqual([
      { key: "/app/x/a" },
      { prefix: "/app/x/p/" },
      { start: "/app/x/r", end: "/app/x/t" },
    ]);
    expect(groupReadRanges(group, readableScope([grantFromKey("read", "/app/x/m")]))).toEqual([
      { start: "/app/x/m", end: "/app/x0" },
    ]);
  });

  test("a piece whose bytes are not UTF-8 is left out, and a group whose every piece is left out answers []", () => {
    const binary = new Uint8Array([...enc("/app/x/"), 0xff]);
    expect(groupReadRanges(group, readableScope([grantKey("read", binary), grantKey("read", "/app/x/a")]))).toEqual([
      { key: "/app/x/a" },
    ]);
    expect(groupReadRanges(group, readableScope([grantKey("read", binary)]))).toEqual([]);
    // The same for a prefix piece, and for a start and end piece whose start or end is not UTF-8.
    const binaryPrefix = new Uint8Array([...enc("/app/x/"), 0xff, 0x2f]);
    const pieces: EtcdPermission[][] = [
      [{ type: "read", key: binaryPrefix, rangeEnd: prefixRangeEnd(binaryPrefix) }],
      [{ type: "read", key: enc("/app/x/r"), rangeEnd: new Uint8Array([...enc("/app/x/"), 0xff]) }],
      [{ type: "read", key: new Uint8Array([...enc("/app/x/"), 0xfe]), rangeEnd: enc("/app/x0") }],
    ];
    for (const grants of pieces) expect(groupReadRanges(group, readableScope(grants))).toEqual([]);
  });
});

describe("members (spec 4.1, 4.3)", () => {
  test("a serializable MemberList, each member named <name> (<id>) or its id alone, its path the unpadded hex id", async () => {
    const { client } = surfaceClient([]);
    expect(await listEtcdObjects(client, surface(), "member")).toEqual([
      { path: ["8e9e05c52164694d"], name: "etcd-1 (8e9e05c52164694d)", kind: "member" },
      { path: ["91bc3c398fb3c146"], name: "91bc3c398fb3c146", kind: "member" },
    ]);
    expect(client.calls.find((call) => call.method === "memberList")?.args[0]).toEqual({ linearizable: false });
  });

  test("a member's alarms are its status, in etcd's words, and only on the member that raised them", async () => {
    const { client } = surfaceClient([], {
      alarmList: async () => [
        { memberId: "10276657743932975437", alarm: "nospace" },
        { memberId: "10276657743932975437", alarm: "corrupt" },
      ],
    });
    const rows = await listEtcdObjects(client, surface(), "member");
    expect(rows.map((row) => row.status)).toEqual(["NOSPACE, CORRUPT", undefined]);
  });

  test("alarms that could not be read leave every member listed, each saying so in etcd's words", async () => {
    const { client } = surfaceClient([], {
      alarmList: async () => Promise.reject(new EtcdError("no-leader", "etcdserver: no leader", 14)),
    });
    const rows = await listEtcdObjects(client, surface(), "member");
    expect(rows.map((row) => row.status)).toEqual([
      "The alarms raised on this member could not be read (etcd: no leader)",
      "The alarms raised on this member could not be read (etcd: no leader)",
    ]);
  });

  test("a MemberList that fails is the folder's refusal, and a defect in the alarm read surfaces as itself", async () => {
    const failed = () =>
      surfaceClient([], {
        memberList: async () => Promise.reject(new EtcdError("unavailable", "etcdserver: request timed out", 14)),
      }).client;
    await expect(listEtcdObjects(failed(), surface(), "member")).rejects.toBeInstanceOf(ConnectionError);
    expect((await countEtcdObjects(failed(), surface())).member).toEqual({
      unavailable: "etcd did not answer the Members listing. (etcd: request timed out)",
    });
    const defect = new TypeError("alarm is undefined");
    const { client } = surfaceClient([], { alarmList: async () => Promise.reject(defect) });
    await expect(listEtcdObjects(client, surface(), "member")).rejects.toBe(defect);
  });
});

describe("leases, users and roles (spec 4.3, 4.7)", () => {
  test("leases as 16 hex digits in order, users and roles by name, each count its listing's length", async () => {
    const { client } = surfaceClient([]);
    expect(await listEtcdObjects(client, surface(), "lease")).toEqual([
      { path: ["694d8147df1dc4c8"], name: "694d8147df1dc4c8", kind: "lease" },
      { path: ["694d8147df1dc4c9"], name: "694d8147df1dc4c9", kind: "lease" },
    ]);
    expect(names(await listEtcdObjects(client, surface(), "user"))).toEqual(["reader", "root"]);
    expect(names(await listEtcdObjects(client, surface(), "role"))).toEqual(["reader", "root"]);
    const counts = await countEtcdObjects(client, surface());
    expect([counts.lease, counts.user, counts.role]).toEqual([{ count: 2 }, { count: 2 }, { count: 2 }]);
  });

  test("a lease whose negative id no typed command reads back is left out, and the count says how many as a floor", async () => {
    const leases = (ids: readonly string[]) =>
      surfaceClient([], { leaseLeases: async () => ({ header: HEADER, ids }) }).client;
    // etcd grants an id a client chooses, a negative one included; lease list prints -5 as -000000000000005.
    const one = leases(["-5", "7587863092875085000"]);
    expect(await listEtcdObjects(one, surface(), "lease")).toEqual([
      { path: ["694d8147df1dc4c8"], name: "694d8147df1dc4c8", kind: "lease" },
    ]);
    expect((await countEtcdObjects(one, surface())).lease).toEqual({
      count: 1,
      sampledFrom:
        "the leases with a positive id, leaving out 1 lease with a negative id, which etcd holds only when a client chose it and Studio does not address",
    });
    expect((await countEtcdObjects(leases(["-5", "-6"]), surface())).lease).toEqual({
      count: 0,
      sampledFrom:
        "the leases with a positive id, leaving out 2 leases with a negative id, which etcd holds only when a client chose it and Studio does not address",
    });
  });

  test("a user who is not root is refused the three listings: each folder carries 4.3's sentence, and each listing raises it", async () => {
    const refused = () =>
      surfaceClient([], {
        leaseLeases: async () => Promise.reject(DENIED()),
        userList: async () => Promise.reject(DENIED()),
        roleList: async () => Promise.reject(DENIED()),
      }).client;
    const context = reader([grantPrefix("read", "/app/")]);
    const counts = await countEtcdObjects(refused(), context);
    expect(counts.lease).toEqual({
      unavailable: "Listing leases needs READ on every leased key in the cluster (etcd: permission denied)",
    });
    expect(counts.user).toEqual({
      unavailable: "Listing users needs the etcd root role, which reader does not hold (etcd: permission denied)",
    });
    expect(counts.role).toEqual({
      unavailable: "Listing roles needs the etcd root role, which reader does not hold (etcd: permission denied)",
    });
    expect(counts.member).toEqual({ count: 2 });
    const kinds = ["lease", "user", "role"];
    const errors = await Promise.all(
      kinds.map((kind) => listEtcdObjects(refused(), context, kind).catch((caught) => caught)),
    );
    for (const [index, error] of errors.entries()) {
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe((counts[kinds[index]] as { unavailable: string }).unavailable);
    }
  });

  test("any other failure of the three listings is the error table's sentence", async () => {
    const failed = async () => Promise.reject(new EtcdError("unavailable", "etcdserver: leader changed", 14));
    const { client } = surfaceClient([], { leaseLeases: failed, userList: failed, roleList: failed });
    const counts = await countEtcdObjects(client, surface());
    // Each in its own listing's words.
    expect([counts.lease, counts.user, counts.role]).toEqual([
      { unavailable: "etcd did not answer the Leases listing. (etcd: leader changed)" },
      { unavailable: "etcd did not answer the Users listing. (etcd: leader changed)" },
      { unavailable: "etcd did not answer the Roles listing. (etcd: leader changed)" },
    ]);
  });
});

describe("the key kind and undeclared kinds (spec 3.4, 4.3)", () => {
  test("the key is refused by name by listEtcdObjects, pointing at the Keys panel, with no request", async () => {
    const { client } = surfaceClient(["/app/a/x"]);
    await expect(listEtcdObjects(client, surface(), "key")).rejects.toThrow(
      'The etcd kind "key" is listed by the Keys panel alone, a page at a time: open the Keys panel to walk the keys.',
    );
    expect(client.calls).toEqual([]);
  });

  test("a kind etcd does not declare is refused by name by every surface", async () => {
    const { client } = surfaceClient([]);
    await expect(listEtcdObjects(client, surface(), "alarm")).rejects.toThrow('etcd declares no object kind "alarm"');
    expect(() => describeEtcdObject(["x"], "alarm")).toThrow('etcd declares no object kind "alarm"');
    expect(() => describeEtcdObjects("alarm", [])).toThrow('etcd declares no object kind "alarm"');
    await expect(readEtcdObjectSource(client, surface(), ["x"], "alarm")).rejects.toThrow(
      'etcd declares no object kind "alarm"',
    );
    expect(client.calls).toEqual([]);
  });
});

describe("describe (spec 4.2)", () => {
  test("a group answers the seven fixed columns of 4.2 with no read; every other kind answers none", () => {
    expect(describeEtcdObject(["/apisix/routes/*"], "prefix").columns.map((column) => column.name)).toEqual([
      "key",
      "value",
      "value_encoding",
      "create_revision",
      "mod_revision",
      "version",
      "lease",
    ]);
    for (const kind of ["key", "member", "lease", "user", "role"]) {
      expect(describeEtcdObject(["x"], kind)).toEqual({ path: ["x"], columns: [], indexes: [], foreignKeys: [] });
    }
  });

  test("describeEtcdObjects answers every listed group, marks no walk bound, and a caller's bound in the shared sentence", () => {
    const listed = Array.from({ length: ETCD_GROUP_CAP }, (_unused, index) => ({
      path: [`/g/${pad(index)}/*`],
      name: `/g/${pad(index)}/*`,
      kind: "prefix",
    }));
    const whole = describeEtcdObjects("prefix", listed);
    expect(whole.details).toHaveLength(ETCD_GROUP_CAP);
    expect(whole.truncated).toBeUndefined();
    expect(whole.details[0]).toEqual(describeEtcdObject(["/g/00000/*"], "prefix"));
    expect(describeEtcdObjects("prefix", listed, 2)).toEqual({
      details: whole.details.slice(0, 2),
      truncated: { limit: 2, reason: callerBoundTruncationReason(2) },
    });
    expect(describeEtcdObjects("prefix", listed.slice(0, 2), 2).truncated).toBeUndefined();
    expect(describeEtcdObjects("member", [{ path: ["8e9e05c52164694d"], name: "etcd-1", kind: "member" }])).toEqual({
      details: [],
    });
  });

  test("a path of the wrong shape, and a prefix path that names no group, are refused", () => {
    expect(() => describeEtcdObject([], "prefix")).toThrow('An etcd "prefix" path is [name], received []');
    expect(() => describeEtcdObject(["/a/*", "x"], "member")).toThrow('An etcd "member" path is [name]');
    expect(() => describeEtcdObject(["/app/cfg"], "prefix")).toThrow(
      'An etcd "prefix" path names a key-prefix group such as /app/*, received ["/app/cfg"]',
    );
  });
});

describe("the key's source (spec 4.4, 4.5, E6, E8, E9)", () => {
  type Entry = { readonly value: string | Uint8Array; readonly lease?: string };
  function keyClient(entries: Readonly<Record<string, Entry>>, overrides: Partial<EtcdObjectClient> = {}) {
    return createFakeEtcdClient({
      range: async (request) => {
        const entry = entries[new TextDecoder().decode(request.key)];
        return {
          header: HEADER,
          kvs:
            entry === undefined
              ? []
              : [
                  {
                    key: request.key,
                    value: typeof entry.value === "string" ? enc(entry.value) : entry.value,
                    createRevision: "12",
                    modRevision: "14",
                    version: "3",
                    lease: entry.lease ?? "0",
                  },
                ],
          more: false,
          count: entry === undefined ? "0" : "1",
        };
      },
      leaseTimeToLive: async (id) => ({ header: HEADER, id, ttl: "31535000", grantedTtl: "31536000", keys: [] }),
      ...overrides,
    });
  }
  const readKey = (client: FakeEtcdClient, key: string, context = surface(), limit?: number) =>
    readEtcdObjectSource(client, context, [key], "key", limit);

  test("a JSON value is Part 1 in json, stored and offered for edit; Part 2 is the metadata, never offered", async () => {
    const client = keyClient({ "/apisix/routes/1": { value: '{"uri":"/hello"}' } });
    const document = await readKey(client, "/apisix/routes/1");
    expect(document.path).toEqual(["/apisix/routes/1"]);
    expect(document.kind).toBe("key");
    expect(document.parts[0]).toEqual({
      id: "value",
      label: "Value",
      text: '{"uri":"/hello"}',
      language: "json",
      form: "complete",
      origin: "stored",
      edit: { offered: true },
    });
    expect(document.parts[1]).toMatchObject({
      id: "metadata",
      label: "Metadata",
      language: "json",
      form: "complete",
      origin: "rendered",
      edit: { offered: false, reason: "etcd keeps a key's metadata itself: only its value is edited." },
    });
    expect(JSON.parse(textOf(document, 1))).toEqual({
      key: "/apisix/routes/1",
      create_revision: "12",
      mod_revision: "14",
      version: "3",
      lease: null,
      value_encoding: "json",
      value_bytes: 16,
    });
    expect(rangeRequests(client)).toEqual([{ key: enc("/apisix/routes/1"), limit: 1 }]);
  });

  test("a text value is plaintext, the one fallback part language (R13 D11)", async () => {
    const document = await readKey(
      keyClient({ "/service/batman/leader": { value: "postgresql0" } }),
      "/service/batman/leader",
    );
    expect(document.parts[0]).toMatchObject({ text: "postgresql0", language: "plaintext", origin: "stored" });
    expect(JSON.parse(textOf(document, 1)).value_encoding).toBe("text");
  });

  test("a value that is not UTF-8 is base64 in plaintext, rendered, and not offered for edit, saying why", async () => {
    const document = await readKey(
      keyClient({ "/values/bin": { value: new Uint8Array([0xff, 0xfe]) } }),
      "/values/bin",
    );
    expect(document.parts[0]).toMatchObject({
      text: "//4=",
      language: "plaintext",
      origin: "rendered",
      edit: {
        offered: false,
        reason: "The value is not UTF-8 text, so it is shown as base64 and is not edited here.",
      },
    });
  });

  test("a withheld value is Part 1's refusal carrying E9's label and never a byte of the value; the metadata stays", async () => {
    const key = "/tenant-a/configmaps/default/cm-encrypted";
    const value = "k8s:enc:aescbc:v1:key1:secret-bytes";
    const document = await readKey(keyClient({ [key]: { value } }), key);
    expect(document.parts[0]).toEqual({
      id: "value",
      label: "Value",
      unavailable: viewValue(enc(key), enc(value), Number.POSITIVE_INFINITY).text,
    });
    expect(JSON.parse(textOf(document, 1))).toMatchObject({
      key,
      value_encoding: "withheld",
      value_bytes: value.length,
    });
    expect(JSON.stringify(document)).not.toContain("secret-bytes");
  });

  test("an empty value and a value of whitespace only are refusals naming the fact, with value_bytes in the metadata (R12 CIC-16)", async () => {
    const client = keyClient({
      "/values/empty": { value: "" },
      "/values/blank": { value: "   " },
      "/values/one": { value: " " },
    });
    const empty = await readKey(client, "/values/empty");
    expect(empty.parts[0]).toEqual({ id: "value", label: "Value", unavailable: "The value is empty (0 bytes)." });
    expect(JSON.parse(textOf(empty, 1)).value_bytes).toBe(0);
    expect((await readKey(client, "/values/blank")).parts[0]).toEqual({
      id: "value",
      label: "Value",
      unavailable: "The value holds only whitespace (3 bytes).",
    });
    expect((await readKey(client, "/values/one")).parts[0]).toEqual({
      id: "value",
      label: "Value",
      unavailable: "The value holds only whitespace (1 byte).",
    });
  });

  test("a leased key carries its lease in hex and the lease's granted and remaining TTL", async () => {
    const client = keyClient({ "/leases/session-1": { value: "held", lease: "7587863092875085000" } });
    const document = await readKey(client, "/leases/session-1");
    expect(JSON.parse(textOf(document, 1))).toMatchObject({
      lease: "694d8147df1dc4c8",
      lease_granted_ttl: "31536000",
      lease_remaining_ttl: "31535000",
    });
    expect(client.calls.find((call) => call.method === "leaseTimeToLive")?.args.slice(0, 2)).toEqual([
      "7587863092875085000",
      false,
    ]);
  });

  test("a lease that expired after the key was read leaves the TTL out and says so", async () => {
    const client = keyClient(
      { "/leases/session-1": { value: "held", lease: "7587863092875085000" } },
      { leaseTimeToLive: async (id) => ({ header: HEADER, id, ttl: "-1", grantedTtl: "0", keys: [] }) },
    );
    const document = await readKey(client, "/leases/session-1");
    expect(document.parts[1].label).toBe("Metadata (the lease expired after the key was read)");
    expect(JSON.parse(textOf(document, 1))).not.toHaveProperty("lease_remaining_ttl");
  });

  test("read-only mode offers no edit, in E6's sentence for where it was set (spec E6)", async () => {
    const client = keyClient({ "/app/cfg": { value: '{"a":1}' } });
    const sources = ["seed", "connection", "execution-profile"] as const;
    const documents = await Promise.all(sources.map((readOnly) => readKey(client, "/app/cfg", surface({ readOnly }))));
    for (const [index, document] of documents.entries()) {
      expect(document.parts[0]).toMatchObject({ edit: { offered: false, reason: readOnlySentence(sources[index]) } });
    }
  });

  test("a protected key offers no edit, in E8's sentence (spec E8)", async () => {
    const key = "/registry/configmaps/default/cm";
    const document = await readKey(keyClient({ [key]: { value: '{"kind":"ConfigMap"}' } }), key);
    const refusal = refuseBeforeSend(
      assessCommand({
        kind: "put",
        key: enc(key),
        value: new Uint8Array(0),
        prevKv: false,
        ignoreValue: false,
        ignoreLease: true,
      }),
      {},
    );
    expect(refusal).toBeDefined();
    expect(document.parts[0]).toMatchObject({ language: "json", edit: { offered: false, reason: refusal?.message } });
  });

  /** E8's message for the put the value edit of `key` would send, which a protected key meets. */
  const protectedKeyRefusal = (key: string) => {
    const refusal = refuseBeforeSend(
      assessCommand({
        kind: "put",
        key: enc(key),
        value: new Uint8Array(0),
        prevKv: false,
        ignoreValue: false,
        ignoreLease: true,
      }),
      {},
    );
    expect(refusal).toBeDefined();
    return refusal?.message;
  };

  test("a CBOR object under a protected prefix is base64 in plaintext, rendered, and offered no edit, in E8's sentence (spec 4.4, E8, E9)", async () => {
    const key = "/registry/pods/default/nginx";
    // CBOR's self-described tag 0xd9 0xd9 0xf7, which kube-apiserver writes before every CBOR object, then {"a": 1}.
    const value = new Uint8Array([0xd9, 0xd9, 0xf7, 0xa1, 0x61, 0x61, 0x01]);
    const document = await readKey(keyClient({ [key]: { value } }), key);
    expect(document.parts[0]).toMatchObject({
      text: "2dn3oWFhAQ==",
      language: "plaintext",
      origin: "rendered",
      edit: { offered: false, reason: protectedKeyRefusal(key) },
    });
    expect(JSON.parse(textOf(document, 1)).value_encoding).toBe("kubernetes-cbor");
  });

  test("the edit's reasons come in 4.5's order: read-only mode before a key outside the writable union (spec E6, 4.7)", async () => {
    const context = reader([grantPrefix("read", "/app/")], { readOnly: "connection" });
    const document = await readKey(keyClient({ "/app/cfg": { value: '{"a":1}' } }), "/app/cfg", context);
    expect(document.parts[0]).toMatchObject({ edit: { offered: false, reason: readOnlySentence("connection") } });
  });

  test("the edit's reasons come in 4.5's order: a protected key before a value that is not UTF-8 (spec E8)", async () => {
    const key = "/registry/x";
    const document = await readKey(keyClient({ [key]: { value: new Uint8Array([0xff, 0xfe]) } }), key);
    expect(document.parts[0]).toMatchObject({
      text: "//4=",
      edit: { offered: false, reason: protectedKeyRefusal(key) },
    });
  });

  test("the edit's reasons come in 4.5's order: a value that is not UTF-8 before a key outside the writable union (spec 4.7)", async () => {
    const client = keyClient({ "/app/bin": { value: new Uint8Array([0xff, 0xfe]) } });
    const document = await readKey(client, "/app/bin", reader([grantPrefix("read", "/app/")]));
    expect(document.parts[0]).toMatchObject({
      text: "//4=",
      edit: {
        offered: false,
        reason: "The value is not UTF-8 text, so it is shown as base64 and is not edited here.",
      },
    });
  });

  test("edit.offered follows the writable union: a key read but not written says 4.4's sentence (spec 4.7, plan Review Focus 5)", async () => {
    const grants = [grantPrefix("read", "/app/"), grantPrefix("readwrite", "/app/x/")];
    const client = keyClient({ "/app/cfg": { value: '{"a":1}' }, "/app/x/a": { value: '{"a":1}' } });
    expect((await readKey(client, "/app/cfg", reader(grants))).parts[0]).toMatchObject({
      edit: { offered: false, reason: "etcd user reader may read this key but not write it" },
    });
    expect((await readKey(client, "/app/x/a", reader(grants))).parts[0]).toMatchObject({ edit: { offered: true } });
    await expect(
      readKey(client, "/app/cfg", surface({ writable: writableScope(grants), principal: undefined })),
    ).rejects.toThrow("carries no principal");
  });

  test("keys with an empty segment, a trailing /, the key / alone, a space, both quotes, a newline, #, $ or a leading - are read by exactly their bytes (plan Review Focus 1)", async () => {
    const keys = [
      "/a//b",
      "/app/",
      "/",
      "/app/sp ace",
      "/app/q\"uo'te",
      "/app/new\nline",
      "/app/#hash",
      "/app/$HOME",
      "-lead/key",
    ];
    const read = async (key: string) => {
      const client = keyClient({ [key]: { value: "v" } });
      const document = await readKey(client, key);
      expect(rangeRequests(client)[0].key).toEqual(enc(key));
      expect(document.path).toEqual([key]);
      expect(JSON.parse(textOf(document, 1)).key).toBe(key);
    };
    await Promise.all(keys.map(read));
  });

  test("a path whose text is not exact, an empty key, and a path of the wrong shape are refused before any request", async () => {
    const client = keyClient({});
    await expect(readKey(client, "\uD800")).rejects.toThrow(
      "This key is not UTF-8 text, so it names no stored key: a key that is not UTF-8 is read and written with a typed command.",
    );
    await expect(readKey(client, "")).rejects.toThrow(
      'An etcd key is never empty: etcd answers "key is not provided".',
    );
    await expect(readEtcdObjectSource(client, surface(), ["/a", "/b"], "key")).rejects.toThrow(
      'An etcd "key" path is [name], received ["/a","/b"]',
    );
    expect(client.calls).toEqual([]);
  });

  test("a key that does not exist is a QueryError naming it", async () => {
    const error = await readKey(keyClient({}), "/app/no-such-key").catch((caught) => caught);
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe('etcd holds no key "/app/no-such-key"');
  });

  test("a read etcd refuses names the key and what the user may read", async () => {
    const grants = [grantPrefix("read", "/app/")];
    const client = keyClient({}, { range: async () => Promise.reject(DENIED()) });
    const error = await readKey(client, "/cfg/x", reader(grants)).catch((caught) => caught);
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toContain("etcd refused the get on /cfg/x");
    expect(error.message).toContain(`etcd user reader may read: ${describeScope(readableScope(grants))}.`);
  });

  test("a caller's bound cuts each part through the shared helper and marks it", async () => {
    const value = '{"uri":"/hello/world"}';
    const document = await readKey(keyClient({ "/apisix/routes/1": { value } }), "/apisix/routes/1", surface(), 8);
    expect(document.parts[0]).toMatchObject({
      text: value.slice(0, 8),
      truncated: { limit: 8, reason: sourceBoundTruncationReason(8) },
    });
    expect(document.parts[1]).toMatchObject({ truncated: { limit: 8, reason: sourceBoundTruncationReason(8) } });
  });
});

describe("the member, lease, user and role sources (spec 4.4)", () => {
  const STATUS = {
    header: HEADER,
    version: "3.7.2",
    dbSize: "20480",
    dbSizeInUse: "16384",
    dbSizeQuota: "2147483648",
    leader: "10276657743932975437",
    raftIndex: "42",
    raftTerm: "3",
    raftAppliedIndex: "42",
    errors: [],
    isLearner: false,
    storageVersion: "3.7.0",
  };
  const client = (overrides: Partial<EtcdObjectClient> = {}) =>
    surfaceClient([], { status: async () => STATUS, ...overrides }).client;

  test("the member this connection reaches: its fields and its own Status, the leader as a boolean", async () => {
    const fake = client();
    const document = await readEtcdObjectSource(fake, surface(), ["8e9e05c52164694d"], "member");
    // The MemberList is serializable, as the listing's is, so the source answers during a quorum loss (spec 4.4).
    expect(fake.calls.find((call) => call.method === "memberList")?.args[0]).toEqual({ linearizable: false });
    expect(document.parts.map((part) => part.id)).toEqual(["member", "status"]);
    expect(JSON.parse(textOf(document, 0))).toEqual({
      id: "8e9e05c52164694d",
      name: "etcd-1",
      peerURLs: ["https://10.0.0.1:2380"],
      clientURLs: ["https://10.0.0.1:2379"],
      isLearner: false,
    });
    expect(JSON.parse(textOf(document, 1))).toEqual({
      version: "3.7.2",
      dbSize: "20480",
      dbSizeInUse: "16384",
      dbSizeQuota: "2147483648",
      leader: true,
      raftTerm: "3",
      raftIndex: "42",
      raftAppliedIndex: "42",
      errors: [],
      storageVersion: "3.7.0",
    });
  });

  test("any other member: its fields and a status part naming the member reached, with no Status read (E3)", async () => {
    const fake = client();
    const document = await readEtcdObjectSource(fake, surface(), ["91bc3c398fb3c146"], "member");
    expect(document.parts[1]).toEqual({
      id: "status",
      label: "Status",
      unavailable:
        "etcd reports a member's status only to a connection that reaches it, and this connection reaches etcd-1 (8e9e05c52164694d): connect to this member to read its status.",
    });
    expect(fake.calls.some((call) => call.method === "status")).toBe(false);
  });

  test("a Status answered by another member after a failover is not shown as this member's", async () => {
    const fake = client({
      status: async () => ({ ...STATUS, header: { ...HEADER, memberId: "18249187646912138824" } }),
    });
    const document = await readEtcdObjectSource(fake, surface(), ["8e9e05c52164694d"], "member");
    expect(document.parts[1]).toMatchObject({ id: "status", unavailable: expect.stringContaining("fd422379fda50e48") });
  });

  test("a member id reads in any padding and case; an unknown id and text that is not hex are refused naming them", async () => {
    expect((await readEtcdObjectSource(client(), surface(), ["0008E9E05C52164694D"], "member")).path).toEqual([
      "0008E9E05C52164694D",
    ]);
    await expect(readEtcdObjectSource(client(), surface(), ["abc"], "member")).rejects.toThrow(
      "etcd has no member abc",
    );
    await expect(readEtcdObjectSource(client(), surface(), ["etcd-1"], "member")).rejects.toThrow(
      '"etcd-1" is not an etcd member id: a member id is hex, as member list prints it.',
    );
  });

  test("a lease: its TTL, granted TTL and attached keys, a key that is not UTF-8 in base64", async () => {
    const fake = client({
      leaseTimeToLive: async (id) => ({
        header: HEADER,
        id,
        ttl: "100",
        grantedTtl: "3600",
        keys: [enc("/leases/session-1"), new Uint8Array([0xff])],
      }),
    });
    const document = await readEtcdObjectSource(fake, surface(), ["694d8147df1dc4c8"], "lease");
    expect(JSON.parse(textOf(document, 0))).toEqual({ id: "694d8147df1dc4c8", TTL: "100", grantedTTL: "3600" });
    expect(JSON.parse(textOf(document, 1))).toEqual([
      { key: "/leases/session-1" },
      { key: "/w==", key_encoding: "base64" },
    ]);
    expect(fake.calls.find((call) => call.method === "leaseTimeToLive")?.args.slice(0, 2)).toEqual([
      "7587863092875085000",
      true,
    ]);
  });

  test("keys a user may not read keep the TTL, read without them, and carry etcd's sentence (spec 4.4)", async () => {
    const fake = client({
      leaseTimeToLive: async (id, keys) =>
        keys ? Promise.reject(DENIED()) : { header: HEADER, id, ttl: "100", grantedTtl: "3600", keys: [] },
    });
    const document = await readEtcdObjectSource(fake, surface(), ["694d8147df1dc4c8"], "lease");
    expect(JSON.parse(textOf(document, 0)).TTL).toBe("100");
    expect(document.parts[1]).toEqual({
      id: "keys",
      label: "Attached keys",
      unavailable: "The keys attached to this lease could not be read (etcd: permission denied)",
    });
  });

  test("a TTL of -1 is not found naming the lease; text that is not hex is refused; other failures are the table's", async () => {
    const gone = client({
      leaseTimeToLive: async (id) => ({ header: HEADER, id, ttl: "-1", grantedTtl: "0", keys: [] }),
    });
    await expect(readEtcdObjectSource(gone, surface(), ["694d8147df1dc4c8"], "lease")).rejects.toThrow(
      "etcd answered the lease timetolive: lease 694d8147df1dc4c8 not found or expired.",
    );
    await expect(readEtcdObjectSource(gone, surface(), ["lease-1"], "lease")).rejects.toThrow(
      '"lease-1" is not an etcd lease id: a lease id is hex, as lease list prints it.',
    );
    const down = client({
      leaseTimeToLive: async () => Promise.reject(new EtcdError("unavailable", "etcdserver: request timed out", 14)),
    });
    await expect(readEtcdObjectSource(down, surface(), ["694d8147df1dc4c8"], "lease")).rejects.toBeInstanceOf(
      ConnectionError,
    );
  });

  test("a negative lease id, as lease list prints one, is refused before any request in the grammar's words", async () => {
    const fake = client();
    // etcd grants an id a client chooses, a negative one included; lease list prints -5 as -000000000000005.
    const error = await readEtcdObjectSource(fake, surface(), ["-000000000000005"], "lease").catch((caught) => caught);
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      '"-000000000000005" is a negative lease id, as lease list prints one: Studio does not address a negative id, which etcd holds only when a client chose it.',
    );
    expect(fake.calls).toEqual([]);
  });

  test("a user: its name and roles; one etcd does not hold is refused naming it", async () => {
    const fake = client({
      userGet: async (name) =>
        name === "reader"
          ? ["reader"]
          : Promise.reject(new EtcdError("failed-precondition", "etcdserver: user name not found", 9)),
    });
    expect(JSON.parse(textOf(await readEtcdObjectSource(fake, surface(), ["reader"], "user"), 0))).toEqual({
      name: "reader",
      roles: ["reader"],
    });
    await expect(readEtcdObjectSource(fake, surface(), ["ghost"], "user")).rejects.toThrow(
      'etcd holds no user "ghost" (etcd: user name not found)',
    );
    const denied = client({ userGet: async () => Promise.reject(DENIED()) });
    await expect(readEtcdObjectSource(denied, surface(), ["root"], "user")).rejects.toThrow(
      "etcd refused the user get",
    );
  });

  test("a role: each permission with its type, the bytes as text or base64, and prefix only for an exact prefix range", async () => {
    const fake = client({
      roleGet: async (name) =>
        name === "reader"
          ? [
              grantPrefix("read", "/app/"),
              grantKey("readwrite", "/cfg/x"),
              { type: "write", key: enc("/a"), rangeEnd: enc("/c") },
              { type: "read", key: new Uint8Array([0x2f, 0xff]), rangeEnd: new Uint8Array([0]) },
              { type: "read", key: enc("/b"), rangeEnd: new Uint8Array([0x2f, 0xff]) },
            ]
          : Promise.reject(new EtcdError("failed-precondition", "etcdserver: role name not found", 9)),
    });
    expect(JSON.parse(textOf(await readEtcdObjectSource(fake, surface(), ["reader"], "role"), 0))).toEqual({
      name: "reader",
      permissions: [
        { type: "READ", key: "/app/", range_end: "/app0", prefix: true },
        { type: "READWRITE", key: "/cfg/x", range_end: null },
        { type: "WRITE", key: "/a", range_end: "/c" },
        { type: "READ", key: "L/8=", key_encoding: "base64", range_end: "\u0000" },
        { type: "READ", key: "/b", range_end: "L/8=", range_end_encoding: "base64" },
      ],
    });
    await expect(readEtcdObjectSource(fake, surface(), ["ghost"], "role")).rejects.toThrow(
      'etcd holds no role "ghost" (etcd: role name not found)',
    );
    const denied = client({ roleGet: async () => Promise.reject(DENIED()) });
    await expect(readEtcdObjectSource(denied, surface(), ["root"], "role")).rejects.toThrow(
      "etcd refused the role get",
    );
  });

  test("the prefix kind has no source", async () => {
    await expect(readEtcdObjectSource(client(), surface(), ["/app/*"], "prefix")).rejects.toThrow(
      'etcd publishes no definition text for the kind "prefix"',
    );
  });
});
