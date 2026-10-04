/**
 * The key sets the Oxia order, merge, cursor and walk tests stand on (contract section 20.2).
 *
 * `j4Keyset` is a port of the J4 keyspace prototype's `keyset.mjs`, so its keys are the ones the prototype seeded into
 * real servers and measured; `pulsarKeyset` is the tree of the SB1 engine prototype's `seed.mjs`; `blindSpotKeyset` is
 * the namespace of SB1-7.2 whose first keys hold no "/". `splitByPosition` is a partition for tests that need shards,
 * not Oxia's routing: the merge and selection rules hold for any partition.
 */
import { type KeyOrder, keyComparator } from "@/lib/db/providers/keyvalue/oxia/order";

/** The prototype's edge keys, in its order. */
const EDGE: readonly string[] = [
  "/a",
  "/a/b",
  "/a/b/c",
  "/a/bb",
  "/a/b/",
  "/a/c",
  "/ab",
  "/b",
  "/b/c",
  "/a/b/c/d",
  "/z",
  "/a//",
  "/a/b//",
  "/a//x",
  "/a//x/y",
  "/a///",
  "/c/d",
  "/x/y",
  "flat",
  "a",
  "a-b",
  "a.b",
  "a/b",
  "a/z",
  "a/b/c",
  "b/c",
  "z",
  "/",
  "//",
  "///",
  "x//y",
  "x/",
  "/a/\u0000x",
  "/a\u0000",
  "/a/b\u0000/c",
  "/ü/ß",
  "/\u{1F600}/x",
  "/a b/c",
  "/a.b/c",
  "/a-b/c",
  "/a/b.c",
  "/orphan/p/q/r",
  "/orphan/p/q/s",
  "/deep/1/2/3/4/5/6/7/8/9",
  "/p",
  "/p/",
  "/p//",
  "/p///",
  "/p/x",
  "/p/x/",
  "/p/x/y",
  "/p/x//",
  "/p.",
  "/p./q",
  "/p-/q",
  "/p0/q",
  "/pq/x",
  "/p/\u0000/z",
  "/p/\u0000z/w",
  "/p/\u{10FFFF}",
  "/p/x/y/z/w",
  "/p//q",
  "/p//q/r",
  "pre",
  "pre/x",
  "pre.x",
  "prf",
  "/pre",
  "/pre/x",
];

/** The symbols of the prototype's random keys, in its order. */
const ALPHA: readonly string[] = ["a", "b", "/", "/", ".", "-", "0", "z", "\u0000", "ü", "~", " ", "\u{1F600}"];

/** The prototype's seeded generator: the same sequence on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomKeys(n: number, seed = 42): string[] {
  const r = rng(seed);
  const out = new Set<string>();
  while (out.size < n) {
    const length = 1 + Math.floor(r() * 9);
    let key = "";
    for (let i = 0; i < length; i++) key += ALPHA[Math.floor(r() * ALPHA.length)];
    if (!key.startsWith("__oxia")) out.add(key);
  }
  return [...out];
}

const J4_KEYSET: readonly string[] = [...new Set([...EDGE, ...randomKeys(3000)])];

/** J4's deterministic keyset (the prototype's generator), unsorted. */
export function j4Keyset(): readonly string[] {
  return J4_KEYSET;
}

/** The leaves of the Pulsar-shaped tree, in the SB1 engine prototype's insertion order. */
const PULSAR_LEAVES: readonly string[] = [
  "/admin/clusters/global",
  "/admin/clusters/standalone/failureDomain/rack-a",
  "/admin/clusters/standalone/namespaceIsolationPolicies",
  "/admin/local-policies/public/default",
  "/admin/partitioned-topics/public/default/persistent/orders",
  "/admin/policies/acme/orders",
  "/admin/policies/acme/payments",
  "/admin/policies/public/default",
  "/admin/policies/public/functions",
  "/loadbalance/brokers/broker-1:8080",
  "/loadbalance/brokers/broker-2:8080",
  "/loadbalance/bundle-data/public/default/0x00000000_0x40000000",
  "/loadbalance/leader",
  "/managed-ledgers/acme/orders/persistent/created",
  "/managed-ledgers/public/default/persistent/orders-partition-0/sub-0",
  "/managed-ledgers/public/default/persistent/orders-partition-1/sub-1",
  "/managed-ledgers/public/default/persistent/orders-partition-2/sub-2",
  "/namespace/public/default/0x00000000_0xffffffff",
  "/schemas/public/default/orders",
  "/ledgers/00/0000/L0001",
  "/ledgers/00/0000/L0002",
  "/stream/storage/ledger-1",
];

/** The Pulsar-shaped set of SB1-8.4 (the tree of `SB1-engine/seed.mjs` with `bulk` keys under /bulk/). */
export function pulsarKeyset(bulk: number): readonly string[] {
  const keys = new Set<string>();
  // Every parent of each leaf as an empty key (Pulsar's createParents), the leaf last.
  for (const leaf of PULSAR_LEAVES) {
    const parts = leaf.split("/");
    for (let i = 2; i <= parts.length; i++) keys.add(parts.slice(0, i).join("/"));
  }
  // An orphan subtree with no parents.
  for (const key of ["/orphan/deep/a/b/c/one", "/orphan/deep/a/b/c/two", "/orphan/other/x", "orphan-flat/p/q"]) {
    keys.add(key);
  }
  for (let i = 0; i < bulk; i++) keys.add(`/bulk/key-${String(i).padStart(5, "0")}`);
  const tail = ["config", "feature-flag.dark-mode", "user:42", "zz-last-flat", "/a", "/z", "app/x", "app/y/z"];
  for (const key of [...tail, "svc//", "/x//y"]) keys.add(key);
  return [...keys];
}

/** The blind-spot set of SB1-7.2: `flat` keys "!0000"..., then "#svc/a", "#svc/a/x", "#svc/b", then ".z0" to ".z9". */
export function blindSpotKeyset(flat: number): readonly string[] {
  const keys: string[] = [];
  for (let i = 0; i < flat; i++) keys.push(`!${String(i).padStart(4, "0")}`);
  keys.push("#svc/a", "#svc/a/x", "#svc/b");
  for (let i = 0; i < 10; i++) keys.push(`.z${i}`);
  return keys;
}

/** The keys sorted as a server of that order stores them. */
export function sortedKeys(keys: readonly string[], order: KeyOrder): readonly string[] {
  return [...keys].sort(keyComparator(order));
}

/**
 * Every key of `keys` split over `shards` by position (key i to shard i mod shards), each shard in server order. A
 * partition, not Oxia's routing.
 */
export function splitByPosition(
  keys: readonly string[],
  shards: number,
  order: KeyOrder,
): readonly (readonly string[])[] {
  const parts: string[][] = Array.from({ length: shards }, () => []);
  keys.forEach((key, i) => {
    parts[i % shards].push(key);
  });
  const cmp = keyComparator(order);
  return parts.map((part) => part.sort(cmp));
}
