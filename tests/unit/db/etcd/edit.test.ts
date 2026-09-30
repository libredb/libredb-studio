/**
 * The guarded value edit (spec 4.5), driven through the shared fake client (plan Contract C12).
 *
 * The build reads the key once and answers a plan whose unit is one etcd `Txn` in etcdctl's txn
 * words, or one of 4.5's refusals with its sentence; the Source tab's reason for not offering the
 * edit is held to the build's refusal, so one fact reads as one sentence on both surfaces (spec 4.4).
 * The apply's tests, below the build's, send that unit and read every outcome of 4.5's list, and hold
 * the unit, rendered as an etcdctl txn body and parsed by commands.ts, equal to the request the apply
 * sends, over keys and values that strain the path model and both word rules (plan Review Focus 1).
 */
import { describe, expect, test } from "bun:test";
import { isObjectEditBuildResponseShape, isObjectEditOutcomeShape } from "@/lib/api/object-edit-wire";
import { QueryError, TimeoutError } from "@/lib/db/errors";
import { EDIT_CHARACTER_LIMIT, planExecutableLength, renderSegments } from "@/lib/db/object-edit";
import { SOURCE_CHARACTER_LIMIT, sourceBoundTruncationReason } from "@/lib/db/object-kinds";
import {
  EtcdError,
  type EtcdKeyValue,
  type EtcdRangeResponse,
  type EtcdResponseHeader,
  type EtcdTxnRequest,
  type EtcdTxnResponse,
} from "@/lib/db/providers/keyvalue/etcd/client";
import { type EtcdParseLimits, parseEtcdCommand } from "@/lib/db/providers/keyvalue/etcd/commands";
import { applyEtcdValueEdit, buildEtcdValueEdit, type EtcdEditPlanStamp } from "@/lib/db/providers/keyvalue/etcd/edit";
import { type EtcdErrorConnection, toEtcdError, toProviderError } from "@/lib/db/providers/keyvalue/etcd/errors";
import { assessCommand } from "@/lib/db/providers/keyvalue/etcd/guard";
import { quoteGoString, quoteTxnWord } from "@/lib/db/providers/keyvalue/etcd/lexer";
import { type EtcdSurfaceContext, readEtcdObjectSource } from "@/lib/db/providers/keyvalue/etcd/objects";
import { describeScope } from "@/lib/db/providers/keyvalue/etcd/permissions";
import { viewValue, withheldLabel } from "@/lib/db/providers/keyvalue/etcd/values";
import { readOnlySentence, refuseBeforeSend, refuseReadOnly } from "@/lib/db/providers/keyvalue/etcd/write-policy";
import type { ObjectEditBuild, ObjectEditPlan, ObjectEditRequest, ObjectEditUnit } from "@/lib/db/types";
import { createFakeEtcdClient } from "../../../helpers/etcd-fake-client";

const encoder = new TextEncoder();
const b = (text: string): Uint8Array => encoder.encode(text);

const CONNECTION: EtcdErrorConnection = {
  host: "etcd.test",
  port: 2379,
  runtimeReportsTlsCause: true,
  receiveCapBytes: 8 * 1024 * 1024,
  timeoutMs: 60_000,
};

/** A user who is not root, signed in with a password (spec 4.7). */
const READER = { name: "reader", via: "password" } as const;

/** Root, or auth off: every key readable and writable, read-write, and a clock that stands still. */
function surface(over: Partial<EtcdSurfaceContext> = {}): EtcdSurfaceContext {
  return {
    readable: { kind: "all" },
    writable: { kind: "all" },
    signal: new AbortController().signal,
    now: () => 1_000,
    errors: CONNECTION,
    ...over,
  };
}

const STAMP: EtcdEditPlanStamp = {
  type: "etcd",
  connectionFingerprint: "fingerprint-of-etcd.test",
  planId: "plan-1",
  issuedAt: "2026-09-30T12:00:00.000Z",
};

const HEADER: EtcdResponseHeader = { clusterId: "1", memberId: "10276657743932975437", revision: "7", raftTerm: "2" };

function kv(key: string | Uint8Array, value: string | Uint8Array, modRevision = "7"): EtcdKeyValue {
  return {
    key: typeof key === "string" ? b(key) : key,
    value: typeof value === "string" ? b(value) : value,
    createRevision: "3",
    modRevision,
    version: "2",
    lease: "0",
  };
}

function rangeAnswer(kvs: readonly EtcdKeyValue[]): EtcdRangeResponse {
  return { header: HEADER, kvs, more: false, count: String(kvs.length) };
}

/** A client whose one key holds `value`: every read answers it. */
function holding(key: string | Uint8Array, value: string | Uint8Array, modRevision = "7") {
  return createFakeEtcdClient({ range: async () => rangeAnswer([kv(key, value, modRevision)]) });
}

function edit(key: string, text: string, over: Partial<ObjectEditRequest> = {}): ObjectEditRequest {
  return { path: [key], kind: "key", partId: "value", text, ...over };
}

function refusalOf(answer: ObjectEditBuild) {
  if (answer.built) throw new Error("expected a refusal, got a plan");
  return answer.refusal;
}

/** The sentence a write-policy.ts refusal carries, or the test fails: write-policy.ts must refuse. */
function policyMessage(refusal: { readonly message: string } | undefined): string {
  if (refusal === undefined) throw new Error("expected write-policy.ts to refuse");
  return refusal.message;
}

/** The plan a build over `stored` issues for `text`, or the test fails. */
async function planFor(
  key: string,
  stored: string | Uint8Array,
  text: string,
  modRevision = "7",
): Promise<ObjectEditPlan> {
  const answer = await buildEtcdValueEdit(holding(key, stored, modRevision), surface(), edit(key, text), STAMP);
  if (!answer.built) throw new Error(`expected a plan for ${JSON.stringify(key)}, got: ${answer.refusal.sentence}`);
  return answer.plan;
}

/** A grpc-js ServiceError, as the adapter hands it to toEtcdError (plan C5). */
function grpc(code: number, details: string): Error {
  return Object.assign(new Error(`${code} STATUS: ${details}`), { code, details, metadata: {} });
}

/** The put guard.ts classifies for a value edit of `key`: the command write-policy.ts decides E8 over. */
function valueEditPut(key: string) {
  return {
    kind: "put",
    key: b(key),
    value: new Uint8Array(0),
    prevKv: false,
    ignoreValue: false,
    ignoreLease: true,
  } as const;
}

/** A protobuf envelope as kube-apiserver writes one: "k8s\0", then runtime.Unknown's TypeMeta (v1, ConfigMap). */
const ENVELOPE = new Uint8Array([
  ...b("k8s\x00"),
  0x0a,
  0x0f,
  0x0a,
  0x02,
  ...b("v1"),
  0x12,
  0x09,
  ...b("ConfigMap"),
  0x12,
  0x00,
]);

/** A value encrypted at rest by kube-apiserver (E9 row 2). */
const ENCRYPTED = b("k8s:enc:aescbc:v1:key1:ciphertext");

describe("buildEtcdValueEdit: one read of the key, then the plan (spec 4.5)", () => {
  test("one read of the key, and one txn unit in etcdctl's words: the compare, the put, the read on failure", async () => {
    const client = holding("/app/cfg", '{"feature":false}');
    const answer = await buildEtcdValueEdit(client, surface(), edit("/app/cfg", '{"feature":true}'), STAMP);
    expect(client.calls).toEqual([
      { method: "range", args: [{ key: b("/app/cfg"), limit: 1 }, { signal: expect.any(AbortSignal) }] },
    ]);
    expect(answer).toEqual({
      built: true,
      plan: {
        planVersion: 1,
        planId: "plan-1",
        issuedAt: "2026-09-30T12:00:00.000Z",
        connectionFingerprint: "fingerprint-of-etcd.test",
        // STAMP.type and not the literal, so the only deferred type error is STAMP's own (plan Global Constraints).
        type: STAMP.type,
        path: ["/app/cfg"],
        kind: "key",
        partId: "value",
        strategy: "guarded-atomic-batch",
        unit: {
          medium: "command",
          name: "txn",
          arguments: ['mod("/app/cfg") = "7"', "put", "--ignore-lease", "/app/cfg"],
          payload: {
            text: '{"feature":true}',
            language: "json",
            segments: [{ from: "user", start: 0, end: 16 }],
          },
          trailing: ["get", "/app/cfg"],
          payloadLabel: "value",
        },
        session: [],
        revision: { check: "guarded", token: "7", basis: "mod_revision", scope: "server" },
        consequences: [],
      },
      preimage: { text: '{"feature":false}', language: "json" },
    });
    expect(isObjectEditBuildResponseShape(answer)).toBe(true);
  });

  test("the payload is the reader's own text in one user segment, and the unit counts every token it sends", async () => {
    const plan = await planFor("/app/cfg", "old", "new text");
    if (plan.unit.medium !== "command") throw new Error("expected a command unit");
    expect(renderSegments("new text", plan.unit.payload.segments)).toBe("new text");
    // txn, the compare, put, --ignore-lease and the key, the payload, then get and the key (spec 3.4).
    expect(planExecutableLength(plan.unit)).toBe(3 + 21 + 3 + 14 + 8 + "new text".length + 3 + 8);
  });

  test("each side's language is 4.4's rule, json when the text parses as JSON and plaintext otherwise (R13 D11)", async () => {
    const toText = await buildEtcdValueEdit(
      holding("/app/cfg", '{"a":1}'),
      surface(),
      edit("/app/cfg", "not json"),
      STAMP,
    );
    const toJson = await buildEtcdValueEdit(holding("/app/cfg", "plain"), surface(), edit("/app/cfg", "[1, 2]"), STAMP);
    if (!toText.built || !toJson.built) throw new Error("expected two plans");
    if (toText.plan.unit.medium !== "command" || toJson.plan.unit.medium !== "command")
      throw new Error("command units");
    expect([toText.plan.unit.payload.language, toText.preimage.language]).toEqual(["plaintext", "json"]);
    expect([toJson.plan.unit.payload.language, toJson.preimage.language]).toEqual(["json", "plaintext"]);
  });

  test("a key that begins with - is written after --, in the put and in the read, and stays Go-quoted in the compare", async () => {
    const plan = await planFor("-k", "old", "new");
    expect(plan.unit.medium === "command" && [plan.unit.arguments, plan.unit.trailing]).toEqual([
      ['mod("-k") = "7"', "put", "--ignore-lease", "--", "-k"],
      ["get", "--", "-k"],
    ]);
  });

  test("a key that is not a bare word is a Go-quoted txn request word, and its compare is Go-quoted too", async () => {
    const plan = await planFor("/app/a b", "old", "new");
    expect(plan.unit.medium === "command" && [plan.unit.arguments, plan.unit.trailing]).toEqual([
      ['mod("/app/a b") = "7"', "put", "--ignore-lease", '"/app/a b"'],
      ["get", '"/app/a b"'],
    ]);
  });

  test("the revision is the read's mod_revision, etcd's 64-bit decimal string, never a number", async () => {
    const plan = await planFor("/app/cfg", "old", "new", "9223372036854775807");
    expect(plan.revision).toEqual({
      check: "guarded",
      token: "9223372036854775807",
      basis: "mod_revision",
      scope: "server",
    });
    expect(plan.unit.medium === "command" && plan.unit.arguments[0]).toBe('mod("/app/cfg") = "9223372036854775807"');
  });
});

describe("buildEtcdValueEdit: the refusals that send nothing (spec 4.5, E6, E8)", () => {
  for (const source of ["seed", "connection", "execution-profile"] as const) {
    test(`read-only from ${source}: E6's sentence as a privilege refusal, whatever the request, and nothing is read`, async () => {
      const client = createFakeEtcdClient();
      const sentence = policyMessage(refuseReadOnly({ readOnly: source }));
      for (const request of [edit("/app/cfg", "v"), edit("/app/cfg", "v", { kind: "prefix" })]) {
        // oxlint-disable-next-line no-await-in-loop -- one client records every request, read after the loop.
        expect(await buildEtcdValueEdit(client, surface({ readOnly: source }), request, STAMP)).toEqual({
          built: false,
          refusal: { refusal: "privilege", sentence, at: { within: "none" } },
        });
      }
      expect(sentence).toContain(readOnlySentence(source));
      expect(client.calls).toEqual([]);
    });
  }

  test("a part other than the value is refused, not raised, since the conformance helper submits the first readable part", async () => {
    const client = createFakeEtcdClient();
    const answer = await buildEtcdValueEdit(client, surface(), edit("/app/cfg", "{}", { partId: "metadata" }), STAMP);
    expect(refusalOf(answer)).toEqual({
      refusal: "unsupported",
      sentence: "etcd keeps a key's metadata itself: only its value is edited.",
      at: { within: "none" },
    });
    expect(client.calls).toEqual([]);
  });

  test("another kind, and a path that is not one key, are raised before any request", async () => {
    const client = createFakeEtcdClient();
    const cases: ReadonlyArray<readonly [ObjectEditRequest, string]> = [
      [
        edit("/app/", "v", { kind: "prefix" }),
        "etcd edits only the value of a key, and this request names another kind.",
      ],
      [
        edit("/app/cfg", "v", { path: [] }),
        "An etcd key is addressed by one path segment, the whole key, and this one has 0.",
      ],
      [
        edit("/app/cfg", "v", { path: ["/app", "cfg"] }),
        "An etcd key is addressed by one path segment, the whole key, and this one has 2.",
      ],
      [edit("", "v"), 'An etcd key is never empty: etcd answers "key is not provided".'],
      [
        edit("/bin/\uD800/x", "v"),
        "This key is not UTF-8 text, so it names no stored key: a key that is not UTF-8 is read and written with a typed command.",
      ],
    ];
    for (const [request, message] of cases) {
      const attempt = buildEtcdValueEdit(client, surface(), request, STAMP);
      // oxlint-disable-next-line no-await-in-loop -- one client records every request, read after the loop.
      await expect(attempt).rejects.toThrow(QueryError);
      // oxlint-disable-next-line no-await-in-loop -- the same rejection, read for its sentence.
      await expect(attempt).rejects.toThrow(message);
    }
    expect(client.calls).toEqual([]);
  });

  for (const key of [
    "/registry/pods/default/nginx",
    "registry/secrets/default/token",
    "/bootstrap/x",
    "compact_rev_key",
  ]) {
    test(`a protected key, ${key}, is refused with write-policy's E8 sentence before any request`, async () => {
      const client = createFakeEtcdClient();
      const sentence = policyMessage(refuseBeforeSend(assessCommand(valueEditPut(key)), {}));
      expect(refusalOf(await buildEtcdValueEdit(client, surface(), edit(key, "v"), STAMP))).toEqual({
        refusal: "unsupported",
        sentence,
        at: { within: "none" },
      });
      expect(client.calls).toEqual([]);
    });
  }
});

describe("buildEtcdValueEdit: the read, and what it found (spec 4.4, 4.5, 4.7, E9)", () => {
  test("a read etcd refuses is raised in 5.6's words, naming the key and what the user may read", async () => {
    const readable = { kind: "ranges", ranges: [{ key: b("/app/"), rangeEnd: b("/app0") }] } as const;
    const client = createFakeEtcdClient({
      range: async () => {
        throw toEtcdError(grpc(7, "etcdserver: permission denied"));
      },
    });
    const attempt = buildEtcdValueEdit(
      client,
      surface({ principal: READER, readable, writable: readable }),
      edit("/config/b", "v"),
      STAMP,
    );
    await expect(attempt).rejects.toThrow(QueryError);
    await expect(attempt).rejects.toThrow('etcd refused the get on "/config/b"');
    await expect(attempt).rejects.toThrow(`etcd user reader may read: ${describeScope(readable)}.`);
  });

  test("a user who is not root is named with what it may read, even when its grants read every key (spec 4.7, 5.6)", async () => {
    const client = createFakeEtcdClient({
      range: async () => {
        throw toEtcdError(grpc(7, "etcdserver: permission denied"));
      },
    });
    const attempt = buildEtcdValueEdit(client, surface({ principal: READER }), edit("/app/cfg", "v"), STAMP);
    await expect(attempt).rejects.toThrow('etcd refused the get on "/app/cfg"');
    await expect(attempt).rejects.toThrow("etcd user reader may read: every key.");
  });

  test("a read that meets its deadline is a TimeoutError, as any read's is (spec 5.6)", async () => {
    const client = createFakeEtcdClient({
      range: async () => {
        throw toEtcdError(grpc(4, "Deadline exceeded after 3.000s,remote_addr=127.0.0.1:2379"));
      },
    });
    await expect(buildEtcdValueEdit(client, surface(), edit("/app/cfg", "v"), STAMP)).rejects.toThrow(TimeoutError);
  });

  test("a key etcd no longer holds is a QueryError naming it", async () => {
    const client = createFakeEtcdClient({ range: async () => rangeAnswer([]) });
    await expect(buildEtcdValueEdit(client, surface(), edit("/app/gone", "v"), STAMP)).rejects.toThrow(
      'etcd holds no key "/app/gone": it may have been deleted since the Source tab read it.',
    );
  });

  test("a key the user may read but not write is refused with 4.4's sentence, after the one read (spec 4.7)", async () => {
    const client = holding("/app/cfg", "v");
    const context = surface({ principal: READER, writable: { kind: "ranges", ranges: [] } });
    expect(refusalOf(await buildEtcdValueEdit(client, context, edit("/app/cfg", "w"), STAMP))).toEqual({
      refusal: "privilege",
      sentence: "etcd user reader may read this key but not write it",
      at: { within: "none" },
    });
    expect(client.calls.map((call) => call.method)).toEqual(["range"]);
  });

  test("a context scoped to grants but carrying no principal is a composition defect, raised", async () => {
    const context = surface({ writable: { kind: "ranges", ranges: [] } });
    await expect(buildEtcdValueEdit(holding("/app/cfg", "v"), context, edit("/app/cfg", "w"), STAMP)).rejects.toThrow(
      "carries no principal",
    );
  });

  for (const [name, value, sentence] of [
    [
      "a withheld value",
      ENVELOPE,
      `Studio does not edit a value it withholds: ${withheldLabel(b("/tenant-a/cm"), ENVELOPE)}.`,
    ],
    ["an empty value", b(""), "The value is empty (0 bytes). Write it with a typed put in the editor."],
    [
      "a value of whitespace only",
      b(" \n\t "),
      "The value holds only whitespace (4 bytes). Write it with a typed put in the editor.",
    ],
  ] as const) {
    test(`${name} on a key the user may not write is refused for its value first, in 4.5's order (spec 4.4, 4.7)`, async () => {
      const context = surface({ principal: READER, writable: { kind: "ranges", ranges: [] } });
      const answer = await buildEtcdValueEdit(
        holding("/tenant-a/cm", value),
        context,
        edit("/tenant-a/cm", "w"),
        STAMP,
      );
      expect(refusalOf(answer)).toEqual({ refusal: "unsupported", sentence, at: { within: "none" } });
    });
  }

  for (const [name, value] of [
    ["a protobuf envelope", ENVELOPE],
    ["an encrypted value", ENCRYPTED],
  ] as const) {
    test(`${name} under a custom prefix is withheld (E9), so it is refused with its label and never shown`, async () => {
      const key = "/tenant-a/configmaps/default/cm";
      const label = withheldLabel(b(key), value);
      expect(label).toBeDefined();
      expect(refusalOf(await buildEtcdValueEdit(holding(key, value), surface(), edit(key, "{}"), STAMP))).toEqual({
        refusal: "unsupported",
        sentence: `Studio does not edit a value it withholds: ${label}.`,
        at: { within: "none" },
      });
    });
  }

  test("an empty value is refused with 4.4's fact, and the way to write it", async () => {
    expect(refusalOf(await buildEtcdValueEdit(holding("/e", ""), surface(), edit("/e", "v"), STAMP))).toEqual({
      refusal: "unsupported",
      sentence: "The value is empty (0 bytes). Write it with a typed put in the editor.",
      at: { within: "none" },
    });
  });

  test("a value that is not UTF-8 is shown as base64 and refused", async () => {
    const answer = await buildEtcdValueEdit(
      holding("/bin", new Uint8Array([0xff, 0xfe])),
      surface(),
      edit("/bin", "v"),
      STAMP,
    );
    expect(refusalOf(answer)).toEqual({
      refusal: "unsupported",
      sentence: "The value is not UTF-8 text, so it is shown as base64 and is not edited here.",
      at: { within: "none" },
    });
  });

  test("a value of whitespace only is refused with 4.4's fact, its size in bytes, and the way to write it", async () => {
    expect(refusalOf(await buildEtcdValueEdit(holding("/w", " \n\t "), surface(), edit("/w", "v"), STAMP))).toEqual({
      refusal: "unsupported",
      sentence: "The value holds only whitespace (4 bytes). Write it with a typed put in the editor.",
      at: { within: "none" },
    });
  });

  test("a value past EDIT_CHARACTER_LIMIT was shown cut, so it is refused as a guard; one at the limit builds", async () => {
    const over = await buildEtcdValueEdit(
      holding("/big", "a".repeat(EDIT_CHARACTER_LIMIT + 1)),
      surface(),
      edit("/big", "b"),
      STAMP,
    );
    expect(refusalOf(over)).toEqual({
      refusal: "guard",
      sentence: `The value is ${(EDIT_CHARACTER_LIMIT + 1).toLocaleString("en-US")} characters and the Source tab shows at most ${EDIT_CHARACTER_LIMIT.toLocaleString("en-US")}, so the text you edited is a cut copy of it, and applying it would delete everything past the bound. Write it with a typed put in the editor.`,
      at: { within: "none" },
    });
    const at = await buildEtcdValueEdit(
      holding("/big", "a".repeat(EDIT_CHARACTER_LIMIT)),
      surface(),
      edit("/big", "b"),
      STAMP,
    );
    expect(at.built).toBe(true);
  });

  test("an unchanged text is refused, which is what the conformance helper's unchanged submission meets", async () => {
    expect(
      refusalOf(await buildEtcdValueEdit(holding("/app/cfg", "same"), surface(), edit("/app/cfg", "same"), STAMP)),
    ).toEqual({
      refusal: "definition",
      sentence: "This text is identical to the value etcd holds.",
      at: { within: "none" },
    });
  });

  test("a text holding a lone surrogate has no UTF-8 bytes to store, so it is refused", async () => {
    expect(
      refusalOf(await buildEtcdValueEdit(holding("/app/cfg", "old"), surface(), edit("/app/cfg", "a\uD800"), STAMP)),
    ).toEqual({
      refusal: "definition",
      sentence: "This text holds a lone UTF-16 surrogate, which is not text, so it has no bytes to store: remove it.",
      at: { within: "none" },
    });
  });

  test("plan Review Focus 1: a key no path can carry is never reached through one", async () => {
    const stored = new Uint8Array([...b("/bin/"), 0xff, 0xfe, ...b("/x")]);
    const replaced = "/bin/\uFFFD\uFFFD/x";
    const client = createFakeEtcdClient({
      range: async (request) =>
        rangeAnswer(
          request.key.length === stored.length && request.key.every((byte, at) => byte === stored[at])
            ? [kv(stored, "v")]
            : [],
        ),
    });
    await expect(buildEtcdValueEdit(client, surface(), edit(replaced, "w"), STAMP)).rejects.toThrow(
      `etcd holds no key "${replaced}"`,
    );
    // U+FFFD in a path is that character's own bytes, never a stand-in for the bytes a key that is not UTF-8 holds.
    expect(client.calls).toEqual([
      { method: "range", args: [{ key: b(replaced), limit: 1 }, { signal: expect.any(AbortSignal) }] },
    ]);
    expect(b(replaced)).not.toEqual(stored);
  });
});

describe("one fact, one sentence: the Source tab's reason for not offering the edit is the build's refusal (spec 4.4)", () => {
  const CASES: ReadonlyArray<
    readonly [name: string, key: string, value: Uint8Array, over: Partial<EtcdSurfaceContext>]
  > = [
    ["a read-only seed connection (E6)", "/app/cfg", b('{"v":1}'), { readOnly: "seed" }],
    [
      "a key outside the writable union (spec 4.7)",
      "/app/cfg",
      b('{"v":1}'),
      { principal: READER, writable: { kind: "ranges", ranges: [] } },
    ],
    ["a value that is not UTF-8 (spec 4.4)", "/values/bin", new Uint8Array([0xff, 0xfe, 0x00]), {}],
    ["a JSON value under a protected prefix (E8)", "/registry/configmaps/default/cm", b('{"kind":"ConfigMap"}'), {}],
    [
      "a value that is not UTF-8 on a key the user may not write (4.5's order)",
      "/values/bin",
      new Uint8Array([0xff, 0xfe, 0x00]),
      { principal: READER, writable: { kind: "ranges", ranges: [] } },
    ],
    [
      "a read-only connection on a protected key (E6 before E8)",
      "/registry/configmaps/default/cm",
      b('{"kind":"ConfigMap"}'),
      { readOnly: "connection" },
    ],
    [
      "a value that is not UTF-8 under a protected prefix (E8 before 4.4)",
      "/registry/pods/default/x",
      new Uint8Array([0xff, 0xfe]),
      {},
    ],
  ];
  for (const [name, key, value, over] of CASES) {
    test(name, async () => {
      const document = await readEtcdObjectSource(holding(key, value), surface(over), [key], "key");
      const part = document.parts.find((candidate) => candidate.id === "value");
      const answer = await buildEtcdValueEdit(holding(key, value), surface(over), edit(key, "another text"), STAMP);
      expect(part !== undefined && "edit" in part ? part.edit : "no readable value part").toEqual({
        offered: false,
        reason: refusalOf(answer).sentence,
      });
    });
  }

  test("the metadata part, which etcd keeps itself", async () => {
    const document = await readEtcdObjectSource(holding("/app/cfg", "v"), surface(), ["/app/cfg"], "key");
    const part = document.parts.find((candidate) => candidate.id === "metadata");
    const request = edit("/app/cfg", "{}", { partId: "metadata" });
    const answer = await buildEtcdValueEdit(holding("/app/cfg", "v"), surface(), request, STAMP);
    expect(part !== undefined && "edit" in part ? part.edit : "no readable metadata part").toEqual({
      offered: false,
      reason: refusalOf(answer).sentence,
    });
  });
});

describe("one fact, one sentence: a value the Source tab does not show is the fact the build refuses (spec 4.4, E9)", () => {
  const CASES: ReadonlyArray<readonly [name: string, key: string, value: Uint8Array]> = [
    ["a withheld value (E9)", "/tenant-a/configmaps/default/cm", ENVELOPE],
    ["an empty value", "/e", b("")],
    ["a value of one whitespace byte", "/w", b(" ")],
    ["a value of whitespace only", "/w", b(" \n\t ")],
  ];
  for (const [name, key, value] of CASES) {
    test(name, async () => {
      const document = await readEtcdObjectSource(holding(key, value), surface(), [key], "key");
      const part = document.parts.find((candidate) => candidate.id === "value");
      if (part === undefined || !("unavailable" in part)) {
        throw new Error("expected the Source tab to withhold the value");
      }
      const answer = await buildEtcdValueEdit(holding(key, value), surface(), edit(key, "another text"), STAMP);
      expect(refusalOf(answer).sentence).toContain(part.unavailable);
    });
  }
});

// ============================================================================
// The apply (spec 4.5)
// ============================================================================

const LIMITS: EtcdParseLimits = {
  maxLimit: 500,
  txnRangeLimit: 100,
  maxCommandTimeoutMs: 60_000,
  maxWatchWindowMs: 55_000,
};

/** errors.ts's facts for the apply's send, as edit.ts builds them for "/app/cfg" on an unscoped connection. */
const SENT = { command: "value edit", write: true, range: '"/app/cfg"', connection: CONNECTION };

type CommandUnit = Extract<ObjectEditUnit, { readonly medium: "command" }>;

function commandUnit(plan: ObjectEditPlan): CommandUnit {
  if (plan.unit.medium !== "command") throw new Error("expected a command unit");
  return plan.unit;
}

function applied(revision: string): EtcdTxnResponse {
  const header = { ...HEADER, revision };
  return { header, succeeded: true, responses: [{ op: "put", response: { header } }] };
}

function notSucceeded(kvs: readonly EtcdKeyValue[]): EtcdTxnResponse {
  return { header: HEADER, succeeded: false, responses: [{ op: "range", response: rangeAnswer(kvs) }] };
}

/** A clock that answers each time in turn, then keeps the last. */
function stepping(...times: number[]): () => number {
  let at = 0;
  return () => times[Math.min(at++, times.length - 1)];
}

/**
 * The unit as etcdctl's `txn` reads a body from its standard input: compares, an empty line, the put
 * with the payload as a txn request word, an empty line, the read (spec 4.5, 5.1.4). A value that
 * begins with `-` is written after `--`, unless the key already put one before it.
 */
function renderTxnBody(unit: CommandUnit): string {
  const [compare, ...put] = unit.arguments;
  const dash = !put.includes("--") && unit.payload.text.startsWith("-") ? ["--"] : [];
  const request = [...put, ...dash, quoteTxnWord(b(unit.payload.text))].join(" ");
  return `txn\n${compare}\n\n${request}\n\n${(unit.trailing ?? []).join(" ")}\n`;
}

/** What that body asks etcd for, read with the editor's own parser, the oracle the apply is held to. */
function oracleTxn(body: string): EtcdTxnRequest {
  const result = parseEtcdCommand(body, LIMITS);
  if (!result.ok) throw new Error(`the rendered body does not parse: ${result.refusal.message}`);
  const txn = result.parsed.command;
  if (txn.kind !== "txn" || txn.compares.length !== 1 || txn.success.length !== 1 || txn.failure.length !== 1) {
    throw new Error("the rendered body is not one compare, one request and one request");
  }
  const [compare] = txn.compares;
  const [put] = txn.success;
  const [get] = txn.failure;
  if (compare.target !== "mod" || compare.operator !== "=" || put.kind !== "put" || get.kind !== "get") {
    throw new Error("the rendered body is not the value edit's shape");
  }
  expect([put.lease, put.prevKv, put.ignoreValue, put.ignoreLease]).toEqual([undefined, false, false, true]);
  expect(get).toEqual({
    kind: "get",
    key: get.key,
    prefix: false,
    fromKey: false,
    keysOnly: false,
    countOnly: false,
    consistency: "l",
  });
  return {
    compare: [{ key: compare.key, target: "mod", result: "equal", operand: compare.operand }],
    success: [{ op: "put", request: { key: put.key, value: put.value, ignoreLease: true } }],
    failure: [{ op: "range", request: { key: get.key, limit: 1 } }],
  };
}

describe("applyEtcdValueEdit: one Txn, built from the unit alone (spec 4.5)", () => {
  test("one Txn: one MOD EQUAL compare, one put with ignoreLease, one range of the key on failure", async () => {
    const plan = await planFor("/app/cfg", '{"v":1}', '{"v":2}');
    const context = surface();
    const client = createFakeEtcdClient({ txn: async () => applied("8") });
    await applyEtcdValueEdit(client, context, plan);
    expect(client.calls).toEqual([
      {
        method: "txn",
        args: [
          {
            compare: [{ key: b("/app/cfg"), target: "mod", result: "equal", operand: "7" }],
            success: [{ op: "put", request: { key: b("/app/cfg"), value: b('{"v":2}'), ignoreLease: true } }],
            failure: [{ op: "range", request: { key: b("/app/cfg"), limit: 1 } }],
          },
          { signal: context.signal },
        ],
      },
    ]);
  });

  test("succeeded is applied, carrying the Txn's revision, which is the key's new mod_revision", async () => {
    const plan = await planFor("/app/cfg", "old", "new");
    const outcome = await applyEtcdValueEdit(createFakeEtcdClient({ txn: async () => applied("8") }), surface(), plan);
    expect(outcome).toEqual({
      outcome: "applied",
      revision: { check: "guarded", token: "8", basis: "mod_revision", scope: "server" },
      duration: 0,
    });
    expect(isObjectEditOutcomeShape(outcome)).toBe(true);
  });

  test("the duration is read from the injected clock, from the apply's start to its answer", async () => {
    const plan = await planFor("/app/cfg", "old", "new");
    const client = createFakeEtcdClient({ txn: async () => applied("8") });
    const outcome = await applyEtcdValueEdit(client, surface({ now: stepping(100, 142) }), plan);
    expect(outcome.duration).toBe(42);
  });
});

describe("applyEtcdValueEdit: refused before any request (spec E6, E8, 5.6)", () => {
  for (const source of ["seed", "connection", "execution-profile"] as const) {
    test(`read-only from ${source}: a plan built read-write is refused with E6's sentence, and nothing is sent`, async () => {
      const plan = await planFor("/app/cfg", "old", "new");
      const client = createFakeEtcdClient();
      const sentence = policyMessage(refuseReadOnly({ readOnly: source }));
      expect(await applyEtcdValueEdit(client, surface({ readOnly: source }), plan)).toEqual({
        outcome: "refused",
        refusal: { refusal: "privilege", sentence, at: { within: "none" } },
        duration: 0,
      });
      expect(sentence).toContain(readOnlySentence(source));
      expect(client.calls).toEqual([]);
    });
  }

  test("a read-only provider refuses a plan it did not build as well, and never throws (spec E6)", async () => {
    const plan = await planFor("/app/cfg", "old", "new");
    const client = createFakeEtcdClient();
    const foreign = { ...plan, unit: { ...commandUnit(plan), name: "put" } };
    expect((await applyEtcdValueEdit(client, surface({ readOnly: "seed" }), foreign)).outcome).toBe("refused");
    expect(client.calls).toEqual([]);
  });

  test("E8: a plan whose one key is protected is refused with write-policy's sentence, and nothing is sent", async () => {
    const plan = await planFor("/app/cfg", "old", "new");
    const moved = JSON.parse(JSON.stringify(plan).replaceAll("/app/cfg", "/registry/cfg")) as ObjectEditPlan;
    const parsed = parseEtcdCommand(renderTxnBody(commandUnit(moved)), LIMITS);
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    const sentence = policyMessage(refuseBeforeSend(assessCommand(parsed.parsed.command), {}));
    expect(sentence).toContain("/registry/");
    const client = createFakeEtcdClient();
    expect(await applyEtcdValueEdit(client, surface(), moved)).toEqual({
      outcome: "refused",
      refusal: { refusal: "unsupported", sentence, at: { within: "none" } },
      duration: 0,
    });
    expect(client.calls).toEqual([]);
  });
});

describe("applyEtcdValueEdit: a plan this provider did not build is raised before any request (spec 4.5)", () => {
  const TAMPERED: ReadonlyArray<
    readonly [name: string, tamper: (plan: ObjectEditPlan, unit: CommandUnit) => ObjectEditPlan]
  > = [
    ["a statement unit", (plan, unit) => ({ ...plan, unit: { medium: "statement", steps: [unit.payload] } })],
    ["a command other than txn", (plan, unit) => ({ ...plan, unit: { ...unit, name: "put" } })],
    [
      "a compared revision",
      (plan) => ({ ...plan, revision: { check: "compared", token: "7", basis: "mod_revision", scope: "server" } }),
    ],
    ["another kind", (plan) => ({ ...plan, kind: "prefix" })],
    ["another part", (plan) => ({ ...plan, partId: "metadata" })],
    ["a path of two segments", (plan) => ({ ...plan, path: ["/app", "cfg"] })],
    ["a path naming another key", (plan) => ({ ...plan, path: ["/app/other"] })],
    [
      "a compare of another key",
      (plan, unit) => ({
        ...plan,
        unit: { ...unit, arguments: ['mod("/app/other") = "7"', ...unit.arguments.slice(1)] },
      }),
    ],
    [
      "a put of another key",
      (plan, unit) => ({ ...plan, unit: { ...unit, arguments: [...unit.arguments.slice(0, 3), "/app/other"] } }),
    ],
    [
      "a put of a key the addressed key begins with",
      (plan, unit) => ({ ...plan, unit: { ...unit, arguments: [...unit.arguments.slice(0, 3), "/app/cf"] } }),
    ],
    ["a read of another key", (plan, unit) => ({ ...plan, unit: { ...unit, trailing: ["get", "/app/other"] } })],
    [
      "a compare revision other than the token",
      (plan, unit) => ({
        ...plan,
        unit: { ...unit, arguments: ['mod("/app/cfg") = "6"', ...unit.arguments.slice(1)] },
      }),
    ],
    [
      "a token other than the compare revision",
      (plan) => ({ ...plan, revision: { check: "guarded", token: "6", basis: "mod_revision", scope: "server" } }),
    ],
    [
      "a create compare",
      (plan, unit) => ({
        ...plan,
        unit: { ...unit, arguments: ['create("/app/cfg") = "7"', ...unit.arguments.slice(1)] },
      }),
    ],
    [
      "a != compare",
      (plan, unit) => ({
        ...plan,
        unit: { ...unit, arguments: ['mod("/app/cfg") != "7"', ...unit.arguments.slice(1)] },
      }),
    ],
    [
      "a second compare",
      (plan, unit) => ({
        ...plan,
        unit: { ...unit, arguments: [`${unit.arguments[0]}\nversion("/app/cfg") > "0"`, ...unit.arguments.slice(1)] },
      }),
    ],
    [
      "a put without --ignore-lease",
      (plan, unit) => ({ ...plan, unit: { ...unit, arguments: [unit.arguments[0], "put", "/app/cfg"] } }),
    ],
    [
      "a put with --prev-kv",
      (plan, unit) => ({
        ...plan,
        unit: { ...unit, arguments: [unit.arguments[0], "put", "--ignore-lease", "--prev-kv", "/app/cfg"] },
      }),
    ],
    [
      "a put with a lease",
      (plan, unit) => ({
        ...plan,
        unit: { ...unit, arguments: [unit.arguments[0], "put", "--lease=694d8147df1dc4c8", "/app/cfg"] },
      }),
    ],
    [
      "a del in place of the put",
      (plan, unit) => ({ ...plan, unit: { ...unit, arguments: [unit.arguments[0], "del", "/app/cfg"] } }),
    ],
    [
      "a second request after the put",
      (plan, unit) => ({ ...plan, unit: { ...unit, arguments: [...unit.arguments, "x\nget", "/app/x"] } }),
    ],
    [
      "a second request in the success list",
      (plan, unit) => ({
        ...plan,
        unit: { ...unit, arguments: [unit.arguments[0], "del", "/app/x\nput", "--ignore-lease", "/app/cfg"] },
      }),
    ],
    ["a ranged read", (plan, unit) => ({ ...plan, unit: { ...unit, trailing: ["get", "/app/cfg", "--prefix"] } })],
    [
      "a read to a range end",
      (plan, unit) => ({ ...plan, unit: { ...unit, trailing: ["get", "/app/cfg", "/app/cfh"] } }),
    ],
    [
      "a read from the key on",
      (plan, unit) => ({ ...plan, unit: { ...unit, trailing: ["get", "/app/cfg", "--from-key"] } }),
    ],
    [
      "a read at a revision",
      (plan, unit) => ({ ...plan, unit: { ...unit, trailing: ["get", "/app/cfg", "--rev=3"] } }),
    ],
    [
      "a read with a limit",
      (plan, unit) => ({ ...plan, unit: { ...unit, trailing: ["get", "/app/cfg", "--limit=1"] } }),
    ],
    [
      "a keys-only read",
      (plan, unit) => ({ ...plan, unit: { ...unit, trailing: ["get", "/app/cfg", "--keys-only"] } }),
    ],
    [
      "a count-only read",
      (plan, unit) => ({ ...plan, unit: { ...unit, trailing: ["get", "/app/cfg", "--count-only"] } }),
    ],
    [
      "a serializable read",
      (plan, unit) => ({ ...plan, unit: { ...unit, trailing: ["get", "/app/cfg", "--consistency=s"] } }),
    ],
    ["no read on failure", (plan, unit) => ({ ...plan, unit: { ...unit, trailing: [] } })],
    [
      "a second request on failure",
      (plan, unit) => ({ ...plan, unit: { ...unit, trailing: ["get", "/app/cfg\nget", "/app/x"] } }),
    ],
    [
      "arguments that do not parse",
      (plan, unit) => ({ ...plan, unit: { ...unit, arguments: [unit.arguments[0], "put", "--nope", "/app/cfg"] } }),
    ],
    [
      "a payload holding a lone surrogate",
      (plan, unit) => ({
        ...plan,
        unit: {
          ...unit,
          payload: { ...unit.payload, text: "a\uD800", segments: [{ from: "user", start: 0, end: 2 }] },
        },
      }),
    ],
  ];
  for (const [name, tamper] of TAMPERED) {
    test(`${name}: raised as a QueryError, and nothing is sent`, async () => {
      const plan = await planFor("/app/cfg", "old", "new");
      const client = createFakeEtcdClient({ txn: async () => applied("8"), range: async () => rangeAnswer([]) });
      await expect(applyEtcdValueEdit(client, surface(), tamper(plan, commandUnit(plan)))).rejects.toThrow(QueryError);
      expect(client.calls).toEqual([]);
    });
  }

  test("the raise says the plan was not built here and that nothing was sent", async () => {
    const plan = await planFor("/app/cfg", "old", "new");
    const tampered = {
      ...plan,
      revision: { check: "guarded", token: "6", basis: "mod_revision", scope: "server" },
    } as const;
    await expect(applyEtcdValueEdit(createFakeEtcdClient(), surface(), tampered)).rejects.toThrow(
      "This etcd value edit plan was not built by this provider: its compare revision differs from its revision token. Nothing was sent.",
    );
  });
});

describe("applyEtcdValueEdit: the answer after the send (spec 4.5, 5.6)", () => {
  test("not succeeded is a conflict carrying the value etcd holds now, read in the same round trip", async () => {
    const plan = await planFor("/app/cfg", '{"v":1}', '{"v":2}');
    const client = createFakeEtcdClient({ txn: async () => notSucceeded([kv("/app/cfg", '{"v":9}', "9")]) });
    const outcome = await applyEtcdValueEdit(client, surface(), plan);
    expect(outcome).toEqual({
      outcome: "conflict",
      conflict: "object-changed",
      current: { text: '{"v":9}', language: "json" },
      duration: 0,
    });
    expect(isObjectEditOutcomeShape(outcome)).toBe(true);
    expect(client.calls.map((call) => call.method)).toEqual(["txn"]);
  });

  test("a current value E9 withholds reaches the conflict as its label, never its bytes (spec E9)", async () => {
    const key = "/tenant-a/configmaps/default/cm";
    const plan = await planFor(key, "plain", "edited");
    const outcome = await applyEtcdValueEdit(
      createFakeEtcdClient({ txn: async () => notSucceeded([kv(key, ENVELOPE, "9")]) }),
      surface(),
      plan,
    );
    const view = viewValue(b(key), ENVELOPE, SOURCE_CHARACTER_LIMIT);
    expect(view.encoding).toBe("withheld");
    expect(outcome).toEqual({
      outcome: "conflict",
      conflict: "object-changed",
      current: { text: view.text, language: "plaintext" },
      duration: 0,
    });
    // Neither the envelope's marker nor its header bytes reach the answer, only E9's label for them.
    expect(JSON.stringify(outcome)).not.toContain("k8s\\u0000");
    expect(JSON.stringify(outcome)).not.toContain("ConfigMap\\u0012");
  });

  test("a current value that is not UTF-8 reaches the conflict as values.ts shows it, in base64", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    const plan = await planFor("/bin/x", "text", "edited");
    const outcome = await applyEtcdValueEdit(
      createFakeEtcdClient({ txn: async () => notSucceeded([kv("/bin/x", bytes, "9")]) }),
      surface(),
      plan,
    );
    const view = viewValue(b("/bin/x"), bytes, SOURCE_CHARACTER_LIMIT);
    expect(view.encoding).toBe("base64");
    expect(outcome).toEqual({
      outcome: "conflict",
      conflict: "object-changed",
      current: { text: view.text, language: "plaintext" },
      duration: 0,
    });
  });

  test("a current value past the read bound is cut there and says so, so the outcome still fits the wire", async () => {
    const plan = await planFor("/big", "small", "edited");
    const long = "x".repeat(SOURCE_CHARACTER_LIMIT + 10);
    const outcome = await applyEtcdValueEdit(
      createFakeEtcdClient({ txn: async () => notSucceeded([kv("/big", long, "9")]) }),
      surface(),
      plan,
    );
    if (outcome.outcome !== "conflict" || outcome.conflict !== "object-changed") throw new Error("expected a conflict");
    expect(outcome.current.truncated).toEqual({
      limit: SOURCE_CHARACTER_LIMIT,
      reason: sourceBoundTruncationReason(SOURCE_CHARACTER_LIMIT),
    });
    expect(outcome.current.text.length).toBeLessThanOrEqual(SOURCE_CHARACTER_LIMIT);
    expect(isObjectEditOutcomeShape(outcome)).toBe(true);
  });

  test("a key deleted since the read is refused, naming that fact, since there is no current text", async () => {
    const plan = await planFor("/app/cfg", "old", "new");
    const outcome = await applyEtcdValueEdit(
      createFakeEtcdClient({ txn: async () => notSucceeded([]) }),
      surface(),
      plan,
    );
    expect(outcome).toEqual({
      outcome: "refused",
      refusal: {
        refusal: "guard",
        sentence:
          'The key "/app/cfg" was deleted after the edit read it, so there is no current value to compare with. Nothing was written.',
        at: { within: "none" },
      },
      duration: 0,
    });
    expect(isObjectEditOutcomeShape(outcome)).toBe(true);
  });

  test("a failed compare answered without its failure read is raised, since what the key holds is unknown", async () => {
    const plan = await planFor("/app/cfg", "old", "new");
    const client = createFakeEtcdClient({ txn: async () => ({ header: HEADER, succeeded: false, responses: [] }) });
    await expect(applyEtcdValueEdit(client, surface(), plan)).rejects.toThrow(QueryError);
  });

  const NOT_APPLIED: ReadonlyArray<
    readonly [name: string, error: EtcdError, refusal: "privilege" | "definition" | "unsupported"]
  > = [
    ["request is too large", toEtcdError(grpc(3, "etcdserver: request is too large")), "definition"],
    ["too many operations", toEtcdError(grpc(3, "etcdserver: too many operations in txn request")), "definition"],
    ["a duplicate key", toEtcdError(grpc(3, "etcdserver: duplicate key given in txn request")), "definition"],
    [
      "etcd's own receive cap",
      toEtcdError(grpc(8, "grpc: received message larger than max (3145771 vs. 2097152)")),
      "definition",
    ],
    ["too many requests", toEtcdError(grpc(8, "etcdserver: too many requests")), "unsupported"],
    ["no leader under hasleader", toEtcdError(grpc(14, "etcdserver: no leader")), "unsupported"],
    ["permission denied", toEtcdError(grpc(7, "etcdserver: permission denied")), "privilege"],
    [
      "no connection established",
      toEtcdError(
        grpc(
          14,
          "No connection established. Last error: Error: connect ECONNREFUSED 127.0.0.1:2379. Resolution note: ",
        ),
      ),
      "unsupported",
    ],
    [
      "a client certificate the server requires",
      toEtcdError(
        grpc(
          14,
          "No connection established. Last error: Error: 40D8A1E2:error:0A00045C:SSL routines:ssl3_read_bytes:tlsv13 alert certificate required. Resolution note: ",
        ),
      ),
      "unsupported",
    ],
    ["a closed client", new EtcdError("closed", "The etcd client is closed"), "unsupported"],
  ];
  for (const [name, error, refusal] of NOT_APPLIED) {
    test(`${name}, on 4.5's closed list: refused with etcd's words, and nothing is read after it`, async () => {
      const plan = await planFor("/app/cfg", "old", "new");
      const client = createFakeEtcdClient({
        txn: async () => {
          throw error;
        },
        range: async () => rangeAnswer([kv("/app/cfg", "old")]),
      });
      const outcome = await applyEtcdValueEdit(client, surface(), plan);
      const sentence = toProviderError(error, SENT).message;
      expect(outcome).toEqual({
        outcome: "refused",
        refusal: { refusal, sentence, at: { within: "none" } },
        duration: 0,
      });
      expect(sentence).not.toContain("may have been applied");
      expect(isObjectEditOutcomeShape(outcome)).toBe(true);
      expect(client.calls.map((call) => call.method)).toEqual(["txn"]);
    });
  }

  test("a refusal for a user who is not root names what it may read, as 5.6 writes every refusal", async () => {
    const readable = { kind: "ranges", ranges: [{ key: b("/app/"), rangeEnd: b("/app0") }] } as const;
    const plan = await planFor("/app/cfg", "old", "new");
    const error = toEtcdError(grpc(7, "etcdserver: permission denied"));
    const client = createFakeEtcdClient({
      txn: async () => {
        throw error;
      },
    });
    const context = surface({ principal: READER, readable, writable: readable });
    const outcome = await applyEtcdValueEdit(client, context, plan);
    const scoped = { ...SENT, readable: { user: "reader", ranges: describeScope(readable) } };
    const sentence = toProviderError(error, scoped).message;
    expect(outcome).toEqual({
      outcome: "refused",
      refusal: { refusal: "privilege", sentence, at: { within: "none" } },
      duration: 0,
    });
    expect(sentence).toContain(`etcd user reader may read: ${describeScope(readable)}.`);
  });

  const NO_SPACE = toEtcdError(grpc(8, "etcdserver: mvcc: database space exceeded"));

  test("database space exceeded with the key still at the plan's revision: refused, after one read of the key", async () => {
    const plan = await planFor("/app/cfg", "old", "new");
    const context = surface();
    const client = createFakeEtcdClient({
      txn: async () => {
        throw NO_SPACE;
      },
      range: async () => rangeAnswer([kv("/app/cfg", "old", "7")]),
    });
    const outcome = await applyEtcdValueEdit(client, context, plan);
    const quota = toProviderError(NO_SPACE, { ...SENT, write: false }).message;
    expect(outcome).toEqual({
      outcome: "refused",
      refusal: {
        refusal: "unsupported",
        sentence: `${quota} The key still holds the revision the edit read, so nothing was written.`,
        at: { within: "none" },
      },
      duration: 0,
    });
    expect(quota).toContain("An admin compacts history");
    expect(quota).not.toContain("may have been applied");
    expect(client.calls).toEqual([
      { method: "txn", args: [expect.any(Object), { signal: context.signal }] },
      { method: "range", args: [{ key: b("/app/cfg"), limit: 1 }, { signal: context.signal }] },
    ]);
  });

  test("database space exceeded with the key moved on is interrupted: etcd applied the Txn, or somebody else wrote", async () => {
    const plan = await planFor("/app/cfg", "old", "new");
    const client = createFakeEtcdClient({
      txn: async () => {
        throw NO_SPACE;
      },
      range: async () => rangeAnswer([kv("/app/cfg", "new", "8")]),
    });
    expect(await applyEtcdValueEdit(client, surface(), plan)).toEqual({
      outcome: "interrupted",
      committed: "unknown",
      sentence: toProviderError(NO_SPACE, SENT).message,
      duration: 0,
    });
  });

  test("database space exceeded with the key gone is interrupted", async () => {
    const plan = await planFor("/app/cfg", "old", "new");
    const client = createFakeEtcdClient({
      txn: async () => {
        throw NO_SPACE;
      },
      range: async () => rangeAnswer([]),
    });
    expect((await applyEtcdValueEdit(client, surface(), plan)).outcome).toBe("interrupted");
  });

  test("database space exceeded whose read-back fails is interrupted, naming the read's failure too", async () => {
    const plan = await planFor("/app/cfg", "old", "new");
    const noLeader = toEtcdError(grpc(14, "etcdserver: no leader"));
    const client = createFakeEtcdClient({
      txn: async () => {
        throw NO_SPACE;
      },
      range: async () => {
        throw noLeader;
      },
    });
    const reason = toProviderError(noLeader, { ...SENT, command: "get", write: false }).message;
    expect(await applyEtcdValueEdit(client, surface(), plan)).toEqual({
      outcome: "interrupted",
      committed: "unknown",
      sentence: `${toProviderError(NO_SPACE, SENT).message} The read of the key that would have told whether it was written failed too: ${reason}`,
      duration: 0,
    });
  });

  const UNKNOWN: ReadonlyArray<readonly [name: string, error: EtcdError]> = [
    ["a deadline after the send", toEtcdError(grpc(4, "Deadline exceeded after 3.000s,remote_addr=127.0.0.1:2379"))],
    ["request timed out", toEtcdError(grpc(14, "etcdserver: request timed out"))],
    ["leader changed", toEtcdError(grpc(14, "etcdserver: leader changed"))],
    ["a dropped connection", toEtcdError(grpc(14, "Connection dropped"))],
    ["etcd's own cancel", toEtcdError(grpc(1, "etcdserver: request canceled"))],
    ["the call's own abort", new EtcdError("cancelled", "Cancelled on client", 1)],
    ["an auth answer after the one renewal", toEtcdError(grpc(16, "etcdserver: invalid auth token"))],
  ];
  for (const [name, error] of UNKNOWN) {
    test(`${name}: interrupted with committed unknown, and no read decides it, whatever it would show`, async () => {
      const plan = await planFor("/app/cfg", "old", "new");
      const client = createFakeEtcdClient({
        txn: async () => {
          throw error;
        },
        range: async () => rangeAnswer([kv("/app/cfg", "old", "7")]),
      });
      const outcome = await applyEtcdValueEdit(client, surface(), plan);
      expect(outcome).toEqual({
        outcome: "interrupted",
        committed: "unknown",
        sentence: toProviderError(error, SENT).message,
        duration: 0,
      });
      expect(toProviderError(error, SENT).message).toContain("may have been applied");
      expect(isObjectEditOutcomeShape(outcome)).toBe(true);
      expect(client.calls.map((call) => call.method)).toEqual(["txn"]);
    });
  }

  test("a thrown value that is not an EtcdError is raised as it is, for the route to answer interrupted", async () => {
    const plan = await planFor("/app/cfg", "old", "new");
    const client = createFakeEtcdClient({
      txn: async () => {
        throw new TypeError("a defect in the adapter");
      },
    });
    await expect(applyEtcdValueEdit(client, surface(), plan)).rejects.toThrow("a defect in the adapter");
  });
});

describe("plan Review Focus 1: keys and values that strain the path model, both ways through the parser", () => {
  const STRAINED: ReadonlyArray<readonly [key: string, value: string]> = [
    ["/a//b", '{"a":1}'],
    ["/app/", "line1\nline2"],
    ["/app/x/", "a\n\nb"],
    ["/", `it's "quoted"`],
    ["/app/a b", "$HOME and ${PATH}"],
    ["/app/it's", "back\\slash"],
    ['/app/say "hi"', "-starts-with-a-dash"],
    ["/app/line\nbreak", "# not a comment"],
    ["/app/#tag", "tab\there"],
    ["/app/$HOME", "--"],
    ["-flag", "-value"],
    ["--", "plain"],
    ["-a b", "a value with spaces"],
    // Runes Go's %q escapes, so the preview shows \u200b and \u202e where the eye would see nothing.
    ["/app/zero\u200Bwidth", "right\u202Eleft"],
  ];
  for (const [key, value] of STRAINED) {
    test(`${JSON.stringify(key)} holding ${JSON.stringify(value)}: the preview, the parse and the send address the same bytes`, async () => {
      const builder = holding(key, "old");
      const answer = await buildEtcdValueEdit(builder, surface(), edit(key, value), STAMP);
      if (!answer.built) throw new Error(answer.refusal.sentence);
      expect(builder.calls[0].args[0]).toEqual({ key: b(key), limit: 1 });
      const unit = commandUnit(answer.plan);
      const dash = key.startsWith("-") ? ["--"] : [];
      expect(unit.arguments).toEqual([
        `mod(${quoteGoString(b(key))}) = "7"`,
        "put",
        "--ignore-lease",
        ...dash,
        quoteTxnWord(b(key)),
      ]);
      expect(unit.trailing).toEqual(["get", ...dash, quoteTxnWord(b(key))]);
      const client = createFakeEtcdClient({ txn: async () => applied("8") });
      expect((await applyEtcdValueEdit(client, surface(), answer.plan)).outcome).toBe("applied");
      const sent = client.calls[0].args[0] as EtcdTxnRequest;
      expect(sent).toEqual(oracleTxn(renderTxnBody(unit)));
      expect(sent).toEqual({
        compare: [{ key: b(key), target: "mod", result: "equal", operand: "7" }],
        success: [{ op: "put", request: { key: b(key), value: b(value), ignoreLease: true } }],
        failure: [{ op: "range", request: { key: b(key), limit: 1 } }],
      });
    });
  }
});
