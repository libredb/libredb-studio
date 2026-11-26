/**
 * What the operator-facing documents say about Milvus: the Milvus bullet of `docs/SECURITY.md`, its plaintext rule,
 * row 3.8 and the audited principal, and the Milvus refusals `docs/SEED_CONNECTIONS.md` gives.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const SECURITY = read("docs/SECURITY.md");
const SEEDS = read("docs/SEED_CONNECTIONS.md");
/** The bullet of `text` that starts with `head`, up to the next top-level bullet or heading. */
function bulletOf(text: string, head: string): string {
  const start = text.indexOf(`\n- ${head}`);
  if (start < 0) throw new Error(`no bullet ${head}`);
  const rest = text.slice(start + 1);
  const end = rest.search(/\n(- |#)/);
  return end < 0 ? rest : rest.slice(0, end);
}
/** One fragment per limit of E23, in the order the spec lists them. */
const E23_FRAGMENTS: readonly string[] = [
  "Vectors and payloads reach query history and saved queries",
  "A filter's text is echoed in errors and in the Studio log.",
  "A load holds shared query-node memory until it is released",
  "Milvus RBAC hides neither the topology nor other databases' row counts from any authenticated user, since GetMetrics needs no privilege.",
  "A `dbName` in a body overrides the connection's database, so only Milvus RBAC on a user that is not root scopes a seed to one database.",
  "any user who knows a run's id can cancel it",
  "Milvus with `authorizationEnabled: false`, its default, accepts any credential or none",
  "TLS mode `require` sends the password to an unverified peer.",
  "gRPC, and every request the Milvus server itself makes, is outside the HTTP egress guard.",
  "REST `entities/get` and `entities/delete` by a VarChar id holding a quote differ from Studio's template on 3.0.2.",
  "A vendor address pasted into the connection-string box instead of the Host box still selects ClickHouse.",
  "Zilliz users should prefer a cluster-scoped user or key to a project-wide key",
  "Studio withholds only the forms it lists.",
  "The management port 9091 answers without authentication on 3.0.2, so the operator keeps it off the network.",
];

describe("SECURITY.md and SEED_CONNECTIONS.md on Milvus", () => {
  test("bulletOf reads a bullet to its end and refuses one that is absent", () => {
    expect(() => bulletOf(SECURITY, "**No such limit.**")).toThrow("no bullet");
    expect(bulletOf("x\n- a\n  b", "a")).toBe("- a\n  b");
  });

  const bullet = bulletOf(SECURITY, "**Milvus is reached over a gRPC client of Studio's own.**");
  test.each([...E23_FRAGMENTS])("the Milvus bullet keeps: %s", (fragment) => {
    expect(bullet).toContain(fragment);
  });

  test("SECURITY.md gives the Milvus plaintext rule, and row 3.8 names Milvus's write policy", () => {
    expect(bullet).toContain(
      "A Milvus password or token over no TLS is refused unless the host is a loopback address or `localhost`, or an SSH tunnel carries the connection.",
    );
    expect(SECURITY).toContain("Milvus's names where the mode was set, as etcd's does, in refusing Load and Release");
    expect(SECURITY).toContain("src/lib/db/providers/vector/milvus/write-policy.ts");
  });

  test("SEED_CONNECTIONS.md takes the milvus type and gives the record's two refusals", () => {
    expect(SEEDS).toContain("`etcd`, `neo4j`, `milvus`, `qdrant`");
    expect(SEEDS).toContain(
      "Milvus declares both: its documented default `root` pair, and no password ([providers/milvus.md](providers/milvus.md), section 4.2).",
    );
    expect(SEEDS).toContain("load refuses what the file shows; resolution refuses the rest");
  });

  const SENTENCE =
    "the Milvus user name, the user name before the colon when Password or token carries a `user:password` token with User empty, or the word `token` for a token with no colon.";
  test("SECURITY.md gives both token forms of the audited Milvus principal", () => {
    expect(SECURITY).toContain(`Milvus's provider implements it: ${SENTENCE}`);
  });
});
