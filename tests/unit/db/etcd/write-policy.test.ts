/**
 * The server-side decisions of E6 and E8 (spec 3.6, R13 A6).
 *
 * E8's spelling table is driven from the text a user types, through the real parser and guard.ts's
 * classification, so a spelling that parses to a protected range is refused whatever its quoting.
 * The content rows feed the stored values execute.ts reads first; no refusal carries a value's bytes.
 */
import { describe, expect, test } from "bun:test";
import type { EtcdBytes } from "@/lib/db/providers/keyvalue/etcd/client";
import { parseEtcdCommand } from "@/lib/db/providers/keyvalue/etcd/commands";
import { assessCommand, type CommandAssessment } from "@/lib/db/providers/keyvalue/etcd/guard";
import {
  type PolicyRefusal,
  type ReadOnlySource,
  readOnlySentence,
  refuseBeforeSend,
  refuseLeaseRevoke,
  refuseReadOnly,
  refuseStoredValues,
} from "@/lib/db/providers/keyvalue/etcd/write-policy";

const LIMITS = { maxLimit: 500, txnRangeLimit: 50, maxCommandTimeoutMs: 60_000, maxWatchWindowMs: 55_000 };
const utf8 = (text: string): EtcdBytes => new TextEncoder().encode(text);
const bytes = (...parts: ReadonlyArray<string | readonly number[]>): EtcdBytes =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? Array.from(utf8(part)) : Array.from(part))));
const SECRET = "libredb-fixture-secret";

function assess(text: string): CommandAssessment {
  const parsed = parseEtcdCommand(text, LIMITS);
  if (!parsed.ok) throw new Error(`expected ${JSON.stringify(text)} to parse, got: ${parsed.refusal.message}`);
  return assessCommand(parsed.parsed.command);
}

const before = (text: string, readOnly?: ReadOnlySource): PolicyRefusal | undefined =>
  refuseBeforeSend(assess(text), readOnly === undefined ? {} : { readOnly });

const PREFIX_SENTENCE = (name: string) =>
  `This write reaches the Kubernetes key prefix ${name}, so Studio refuses it: Kubernetes objects are written through the Kubernetes API, never straight into etcd.`;
const KEY_SENTENCE =
  "This write reaches compact_rev_key, the key kube-apiserver keeps its compaction clock in, so Studio refuses it: kube-apiserver owns that key.";

/** An envelope carrying the secret marker in its raw object, as spec 9 seeds it. */
const ENVELOPE = bytes(
  [0x6b, 0x38, 0x73, 0x00, 0x0a, 0x0f, 0x0a, 0x02],
  "v1",
  [0x12, 0x09],
  "ConfigMap",
  [0x12, SECRET.length],
  SECRET,
);

describe("E6's three sentences", () => {
  test("say where the read-only mode was set", () => {
    expect(readOnlySentence("seed")).toBe("This connection is read-only (set in the operator's seed file).");
    expect(readOnlySentence("connection")).toBe(
      "This connection is read-only: turn off Read-only in its settings to write.",
    );
    expect(readOnlySentence("execution-profile")).toBe(
      "This run opens the connection read-only (agent execution profile).",
    );
  });

  test("refuseReadOnly refuses a value edit and a maintenance operation in each arm, and passes a read-write provider", () => {
    for (const source of ["seed", "connection", "execution-profile"] as const) {
      expect(refuseReadOnly({ readOnly: source })).toEqual({ reason: "read-only", message: readOnlySentence(source) });
    }
    expect(refuseReadOnly({})).toBeUndefined();
  });
});

describe("refuseBeforeSend: E6 before any request (spec 3.6 E6)", () => {
  const writes = [
    "put /app/cfg v",
    "put /app/cfg --ignore-value",
    "del /app/cfg",
    "del /app/ --prefix",
    "txn\n\nput /app/a 1",
    'txn\nmod("/app/a") = "0"\n\n\ndel /app/a',
    "lease grant 60",
    "lease revoke 694d8147df1dc4c8",
    "lease keep-alive --once 694d8147df1dc4c8",
  ];

  test.each(["seed", "connection", "execution-profile"] as const)(
    "every write command is refused in the %s arm, with its sentence",
    (source) => {
      for (const text of writes)
        expect(before(text, source)).toEqual({ reason: "read-only", message: readOnlySentence(source) });
    },
  );

  test("E6 is decided before E8: a protected write on a read-only connection names the read-only mode", () => {
    expect(before("del /registry/ --prefix", "seed")).toEqual({
      reason: "read-only",
      message: readOnlySentence("seed"),
    });
  });

  test("a read passes a read-only provider, a txn that only reads included", () => {
    for (const text of [
      "get /app/ --prefix",
      "watch /app/ --prefix",
      "lease list",
      'txn\nmod("/a") > "0"\n\nget /a',
      "member list",
    ]) {
      expect(before(text, "seed")).toBeUndefined();
    }
  });
});

describe("refuseBeforeSend: E8's prefix and key half, spelling by spelling (spec 3.6 E8)", () => {
  test.each([
    ["the exact key", "put /registry/pods/default/nginx v", "/registry/"],
    ["the exact key, deleted", "del /registry/pods/default/nginx", "/registry/"],
    ["a range ending inside the prefix", "del /reg /registry/x", "/registry/"],
    ["a range from before the prefix to after it", "del /a /z", "/registry/"],
    ["--prefix of the parent /", "del / --prefix", "/registry/"],
    ["--prefix of the parent /reg", "del /reg --prefix", "/registry/"],
    ["--from-key from a smaller key", "del /a --from-key", "/registry/"],
    ["del '' --prefix, the whole key space", "del '' --prefix", "/registry/"],
    ["del '' --from-key, the whole key space", "del '' --from-key", "/registry/"],
    ["a txn with the write in its failure branch", 'txn\nmod("/app/k") = "5"\n\n\nput /registry/x v', "/registry/"],
    [
      "a protected key written with Go escapes in a txn branch (R11 ETCD-5)",
      'txn\n\n\nput "\\x2fregistry/x" v',
      "/registry/",
    ],
    ["a put --lease on a protected key", "put --lease=694d8147df1dc4c8 /registry/events/default/e v", "/registry/"],
    ["a slash-less secrets root", "put registry/secrets/default/s v", "registry/"],
    ["OpenShift's root", "put /kubernetes.io/configmaps/ns/c v", "/kubernetes.io/"],
    ["OpenShift's own root", "put openshift.io/oauth/x v", "openshift.io/"],
    ["k3s's bootstrap root", "del /bootstrap/ --prefix", "/bootstrap/"],
    ["k3s's root", "del k3s/ --prefix", "k3s/"],
    ["RKE2's root, inferred", "put rke2/apiaddresses x", "rke2/"],
    ["del a d, which the slash-less roots refuse", "del a d", "bootstrap/"],
    ["del c --from-key, which the slash-less roots refuse", "del c --from-key", "registry/"],
  ])("%s: %j is refused, naming %s", (_label, text, name) => {
    expect(before(text)).toEqual({ reason: "protected-prefix", message: PREFIX_SENTENCE(name) });
  });

  test.each([
    ["del compact_rev_key"],
    ["put compact_rev_key 1"],
    ["del c d"],
    ["del compact --prefix"],
    ['txn\nmod("/app/k") = "5"\n\n\nput compact_rev_key 1'],
    ['txn\nmod("/app/k") = "5"\n\n\ndel compact_rev_key'],
  ])("%j is refused as kube-apiserver's key (R11 ETCD-1)", (text) => {
    expect(before(text)).toEqual({ reason: "protected-key", message: KEY_SENTENCE });
  });

  test("a txn whose protected write is one of many is refused whole", () => {
    expect(before("txn\n\nput /app/a 1\nput /app/b 2\n\ndel /registry/x")).toMatchObject({
      reason: "protected-prefix",
    });
  });

  test("reads, compares and writes outside the protected set pass", () => {
    for (const text of [
      "get /registry/ --prefix",
      "watch '' --prefix",
      'txn\nmod("/registry/pods/x") > "0"\n\nget /registry/pods/x',
      "put /app/cfg v",
      "del /app/ --prefix",
      "del /tenant-a/ --prefix",
      "put /registry v",
      "put compact_rev_key2 v",
      "lease grant 60",
      "lease revoke 694d8147df1dc4c8",
    ]) {
      expect(before(text)).toBeUndefined();
    }
  });
});

describe("refuseStoredValues: E8's content rule (spec 3.6 E8)", () => {
  const key = utf8("/tenant-a/configmaps/default/cm");

  test("a single-key target holding the k8s\\x00 envelope refuses the whole command, naming the key and the label", () => {
    const refusal = refuseStoredValues([{ key, stored: ENVELOPE }]);
    expect(refusal).toEqual({
      reason: "kubernetes-value",
      message: `/tenant-a/configmaps/default/cm holds a Kubernetes value (Kubernetes protobuf (v1, ConfigMap), ${ENVELOPE.length} bytes), so Studio refuses the write: Kubernetes objects are written through the Kubernetes API, never straight into etcd.`,
    });
    expect(refusal?.message).not.toContain(SECRET);
  });

  test("a single-key target holding a k8s:enc: value refuses the whole command", () => {
    const stored = bytes("k8s:enc:aescbc:v1:key1:", SECRET);
    const refusal = refuseStoredValues([{ key: utf8("/tenant-a/configmaps/default/cm-encrypted"), stored }]);
    expect(refusal?.reason).toBe("kubernetes-value");
    expect(refusal?.message).toContain(`(Kubernetes encrypted (aescbc, key1), ${stored.length} bytes)`);
    expect(refusal?.message).not.toContain(SECRET);
  });

  test("an absent key, a plain JSON value and CBOR outside a protected prefix refuse nothing", () => {
    expect(
      refuseStoredValues([
        { key: utf8("/tenant-a/new"), stored: undefined },
        { key: utf8("/tenant-a/json"), stored: utf8('{"a":1}') },
        { key: utf8("/tenant-a/cbor"), stored: bytes([0xd9, 0xd9, 0xf7, 0xa0]) },
      ]),
    ).toBeUndefined();
    expect(refuseStoredValues([])).toBeUndefined();
  });

  test("a target whose read answered PermissionDenied is refused, since etcd grants WRITE without READ", () => {
    expect(refuseStoredValues([{ key: utf8("/w/only"), stored: "unreadable" }])).toEqual({
      reason: "unreadable-target",
      message:
        "Studio could not read /w/only before writing it, so it cannot tell whether the key holds a Kubernetes object, and it refuses the write: a write needs READ on each key it names as well as WRITE.",
    });
  });

  test("the first target that refuses decides, in the order written", () => {
    const refusal = refuseStoredValues([
      { key: utf8("/a"), stored: utf8("plain") },
      { key: utf8("/b"), stored: "unreadable" },
      { key, stored: ENVELOPE },
    ]);
    expect(refusal?.reason).toBe("unreadable-target");
  });

  test("a key is named in the quoting a person types it in", () => {
    expect(refuseStoredValues([{ key: utf8("/a b"), stored: "unreadable" }])?.message).toContain(
      "could not read '/a b' before",
    );
    expect(refuseStoredValues([{ key: bytes("/", [0xff]), stored: "unreadable" }])?.message).toContain(
      'could not read "/\\xff" before',
    );
  });
});

describe("refuseLeaseRevoke: E8's lease half (spec 3.6 E8)", () => {
  test("a lease holding one protected key among others is refused, naming the prefix and never the key", () => {
    const refusal = refuseLeaseRevoke([utf8("/leases/session-2"), utf8("/registry/events/default/nginx.1")]);
    expect(refusal).toEqual({
      reason: "lease-protected",
      message:
        "This lease holds a key under the Kubernetes key prefix /registry/, and revoking the lease deletes it, so Studio refuses it: Kubernetes objects are written through the Kubernetes API, never straight into etcd.",
    });
    expect(refusal?.message).not.toContain("nginx.1");
  });

  test("a lease holding compact_rev_key is refused, naming the key and its owner", () => {
    expect(refuseLeaseRevoke([utf8("compact_rev_key")])).toEqual({
      reason: "lease-protected",
      message:
        "This lease holds compact_rev_key, the key kube-apiserver keeps its compaction clock in, and revoking the lease deletes it, so Studio refuses it: kube-apiserver owns that key.",
    });
  });

  test("a lease whose keys could not be read is refused, since Kubernetes attaches its keys to leases", () => {
    expect(refuseLeaseRevoke("unreadable")).toEqual({
      reason: "lease-unreadable",
      message:
        "Studio could not read the keys this lease holds, so it refuses to revoke it: revoking a lease deletes every key it holds, and Kubernetes attaches its keys to leases.",
    });
  });

  test("a lease holding no protected key, or no key at all, passes", () => {
    expect(refuseLeaseRevoke([utf8("/leases/session-1")])).toBeUndefined();
    expect(refuseLeaseRevoke([])).toBeUndefined();
  });
});
