/**
 * The live captures of MCP's `run_s3_read` under a seed's agent read key, `mcp.json` beside each
 * tests/fixtures/s3/agent-scope/<set>/run.sh, written by tests/live/s3-mcp-agent-key.ts through the real /api/mcp
 * route. This holds what docs/providers/s3.md section 15.7 says of them: the connection's own key lists every bucket,
 * the agent key without s3:ListAllMyBuckets is answered its granted buckets alone, so MCP signed with it, the agent key
 * holding it is answered only the listed buckets whose HeadBucket the server answers it 200, the rest counted in a note
 * that names none, every named read of a bucket it is granted nothing on answers as one that does not exist, and no
 * answer holds a key name, the metadata marker or the endpoint's port.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { S3_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/objectstore/s3/agent-metadata-read";

const ROOT = resolve(import.meta.dir, "../../../..");
const SETS = ["silo-RELEASE.2026-09-16T00-00-00Z", "rustfs-1.0.1", "garage-v2.4.1"] as const;
const GRANTED = ["scope-granted", "scope-objects-only", "scope-versions"];

interface Read {
  readonly connection: string;
  readonly statement: string;
  readonly isError: boolean;
  readonly rows?: ReadonlyArray<Record<string, unknown>>;
  readonly notes?: readonly string[];
  readonly text?: string;
}

type AgentKey = "unlisted" | "scoped";

interface Capture {
  readonly server: string;
  readonly ownKeyListing: readonly string[];
  /** What a raw ListBuckets signed with each agent key answered. */
  readonly rawListed: Readonly<Record<AgentKey, readonly string[]>>;
  /** What a raw HeadBucket of each bucket signed with each agent key answered. */
  readonly heads: Readonly<Record<AgentKey, Readonly<Record<string, number>>>>;
  readonly listing: Readonly<Record<AgentKey, Read>>;
  readonly listingCost: Readonly<
    Record<
      AgentKey,
      { readonly listedByServer: number; readonly requests: { ListBuckets: number; HeadBucket: number } }
    >
  >;
  readonly oracle: Readonly<Record<string, boolean>>;
  readonly reads: readonly Read[];
  readonly refused: readonly Read[];
  readonly limits: {
    readonly timeout: { readonly answered_ms: number };
    readonly cancel: { readonly answered_ms: number };
  };
  readonly leaks: readonly string[];
  readonly failures: readonly string[];
}

const load = (set: string): Capture =>
  JSON.parse(readFileSync(join(ROOT, "tests/fixtures/s3/agent-scope", set, "mcp.json"), "utf8")) as Capture;

const names = (read: Read) => (read.rows ?? []).map((row) => String(row.bucket)).sort();

describe.each(SETS)("the MCP capture on %s", (set) => {
  const capture = load(set);

  test("passed every check, with no leak", () => {
    expect(capture.failures).toEqual([]);
    expect(capture.leaks).toEqual([]);
  });

  test("the agent key without the bucket listing is answered its granted buckets, where the connection's own key lists every bucket", () => {
    expect(capture.ownKeyListing).toContain("scope-other");
    expect(names(capture.listing.unlisted).length).toBeGreaterThan(0);
    for (const bucket of names(capture.listing.unlisted)) expect(GRANTED).toContain(bucket);
  });

  test("every named read of a bucket granted nothing answers as one that does not exist, in the one sentence", () => {
    expect(Object.values(capture.oracle).every(Boolean)).toBe(true);
    const ungranted = capture.reads.filter((read) => read.statement.includes("scope-other"));
    expect(ungranted).toHaveLength(6);
    for (const read of ungranted) {
      expect(read.isError).toBe(true);
      expect(read.text).toContain(S3_AGENT_FAILURE_SENTENCES.notFound);
    }
  });

  test("every refused form was refused before it reached the server, and the limits answered on time", () => {
    for (const read of capture.refused)
      expect(read.text).toStartWith("The command was refused before it reached the server");
    expect(capture.limits.timeout.answered_ms).toBeLessThan(1_000);
    expect(capture.limits.cancel.answered_ms).toBeLessThan(1_500);
  });
});

describe("what the captures show of each server's grants", () => {
  test("a HeadBucket signed with the agent key is answered 200 for a bucket it may list and 403 or 404 for one it may not", () => {
    for (const set of SETS) {
      const { server, heads } = load(set);
      for (const key of ["unlisted", "scoped"] as const) {
        expect(heads[key]["scope-granted"]).toBe(200);
        expect(heads[key]["scope-versions"]).toBe(200);
        expect(heads[key]["scope-other"]).toBe(403);
        expect(heads[key]["scope-missing"]).toBe(server === "garage" ? 404 : 403);
        // Garage grants read on the whole bucket; Silo and RustFS hold s3:GetObject alone there, which no HEAD needs.
        expect(heads[key]["scope-objects-only"]).toBe(server === "garage" ? 200 : 403);
        expect(heads[key]["scope-public"]).toBe(server === "rustfs" ? 200 : 403);
      }
    }
  });

  test("the server lists every bucket name to a key holding s3:ListAllMyBuckets on Silo and RustFS, and only its granted ones on Garage", () => {
    for (const set of SETS) {
      const { server, rawListed } = load(set);
      if (server === "garage") expect(rawListed.scoped).toEqual(GRANTED);
      else expect(rawListed.scoped).toContain("scope-other");
    }
  });

  test.each(SETS)(
    "on %s each agent key's listing names only the listed buckets its HEAD is answered, counting the rest",
    (set) => {
      const capture = load(set);
      for (const key of ["unlisted", "scoped"] as const) {
        const readable = capture.rawListed[key].filter((bucket) => capture.heads[key][bucket] === 200);
        expect(names(capture.listing[key])).toEqual(readable);
        expect(names(capture.listing[key])).not.toContain("scope-other");
        const withheld = capture.rawListed[key].length - readable.length;
        expect(capture.listing[key].notes ?? []).toEqual(
          withheld === 0 ? [] : [S3_AGENT_FAILURE_SENTENCES.withheldBuckets(withheld)],
        );
        expect(capture.listingCost[key].requests).toEqual({
          ListBuckets: 1,
          HeadBucket: capture.rawListed[key].length,
        });
      }
    },
  );

  test("the scoped agent key is answered two buckets on Silo, three on RustFS and Garage", () => {
    const scoped = Object.fromEntries(SETS.map((set) => [load(set).server, names(load(set).listing.scoped)]));
    expect(scoped).toEqual({
      silo: ["scope-granted", "scope-versions"],
      rustfs: ["scope-granted", "scope-public", "scope-versions"],
      garage: GRANTED,
    });
  });

  test("RustFS opens a public bucket to the agent key, and Silo and Garage do not", () => {
    for (const set of SETS) {
      const capture = load(set);
      const head = capture.reads.find((read) => read.statement === "aws s3api head-bucket --bucket scope-public");
      expect(head?.isError).toBe(capture.server !== "rustfs");
    }
  });
});
