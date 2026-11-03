/**
 * The live captures of MCP's `run_s3_read` under a seed's agent read key, `mcp.json` beside each
 * tests/fixtures/s3/agent-scope/<set>/run.sh, written by tests/live/s3-mcp-agent-key.ts through the real /api/mcp
 * route. This holds what docs/providers/s3.md section 15.7 says of them: the connection's own key lists every bucket,
 * the agent key without s3:ListAllMyBuckets is answered its granted buckets alone, so MCP signed with it, every named
 * read of a bucket it is granted nothing on answers as one that does not exist, and no answer holds a key name, the
 * metadata marker or the endpoint's port.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { S3_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/objectstore/s3/agent-metadata-read";

const ROOT = posix.resolve(import.meta.dir.replaceAll("\\", "/"), "../../../..");
const SETS = ["silo-RELEASE.2026-09-16T00-00-00Z", "rustfs-1.0.1", "garage-v2.4.1"] as const;
const GRANTED = ["scope-granted", "scope-objects-only", "scope-versions"];

interface Read {
  readonly connection: string;
  readonly statement: string;
  readonly isError: boolean;
  readonly rows?: ReadonlyArray<Record<string, unknown>>;
  readonly text?: string;
}

interface Capture {
  readonly server: string;
  readonly ownKeyListing: readonly string[];
  readonly listing: { readonly unlisted: Read; readonly scoped: Read };
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
  JSON.parse(readFileSync(posix.join(ROOT, "tests/fixtures/s3/agent-scope", set, "mcp.json"), "utf8")) as Capture;

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
  test("a key holding s3:ListAllMyBuckets lists every bucket name on Silo and RustFS, and only its granted ones on Garage", () => {
    for (const set of SETS) {
      const capture = load(set);
      const scoped = names(capture.listing.scoped);
      if (capture.server === "garage") expect(scoped).toEqual(GRANTED);
      else expect(scoped).toContain("scope-other");
    }
  });

  test("RustFS opens a public bucket to the agent key, and Silo and Garage do not", () => {
    for (const set of SETS) {
      const capture = load(set);
      const head = capture.reads.find((read) => read.statement === "aws s3api head-bucket --bucket scope-public");
      expect(head?.isError).toBe(capture.server !== "rustfs");
    }
  });
});
