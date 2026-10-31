/**
 * The agent's reader of one S3 command (`agent-statement.ts`): the closed table of six metadata reads, read with the
 * console's own parser and each pinned to the plan the provider sends, and every command outside it refused before
 * anything is sent, in agent mode's own words with the list of reads.
 */
import { describe, expect, test } from "bun:test";
import { readS3AgentStatement, S3_AGENT_SENTENCES } from "@/lib/db/providers/objectstore/s3/agent-statement";

const refused = (text: string, context: { readonly pinnedBucket?: string } = {}) => {
  const reading = readS3AgentStatement(text, context);
  if (reading.ok) throw new Error(`expected a refusal of ${text}, got ${JSON.stringify(reading.plan)}`);
  return reading;
};

describe("the closed table of reads", () => {
  test("the bucket listing, with or without aws", () => {
    expect(readS3AgentStatement("aws s3api list-buckets")).toEqual({ ok: true, plan: { op: "list-buckets" } });
    expect(readS3AgentStatement("s3api list-buckets")).toEqual({ ok: true, plan: { op: "list-buckets" } });
  });

  test("one bucket's head, location and versioning", () => {
    expect(readS3AgentStatement("aws s3api head-bucket --bucket sales")).toEqual({
      ok: true,
      plan: { op: "head-bucket", bucket: "sales" },
    });
    expect(readS3AgentStatement("aws s3api get-bucket-location --bucket=sales")).toEqual({
      ok: true,
      plan: { op: "get-bucket-location", bucket: "sales" },
    });
    expect(readS3AgentStatement("aws s3api get-bucket-versioning --bucket sales")).toEqual({
      ok: true,
      plan: { op: "get-bucket-versioning", bucket: "sales" },
    });
  });

  test("a whole bucket's summary, written as the console's recursive summarized listing, with or without a slash", () => {
    for (const text of [
      "aws s3 ls s3://sales --recursive --summarize",
      "aws s3 ls s3://sales/ --summarize --recursive",
      "s3 ls s3://sales --recursive --summarize",
    ]) {
      expect(readS3AgentStatement(text)).toEqual({ ok: true, plan: { op: "summary", bucket: "sales" } });
    }
  });

  test("one object's head, for the key the command names in full", () => {
    expect(readS3AgentStatement("aws s3api head-object --bucket sales --key 2026/orders.csv")).toEqual({
      ok: true,
      plan: { op: "head-object", bucket: "sales", key: "2026/orders.csv" },
    });
    expect(readS3AgentStatement("aws s3api head-object --bucket sales --key 'with space.txt'")).toEqual({
      ok: true,
      plan: { op: "head-object", bucket: "sales", key: "with space.txt" },
    });
  });

  test("a pinned connection reads its own bucket", () => {
    expect(readS3AgentStatement("aws s3api head-bucket --bucket sales", { pinnedBucket: "sales" })).toEqual({
      ok: true,
      plan: { op: "head-bucket", bucket: "sales" },
    });
  });
});

describe("what is refused before anything is sent", () => {
  test("an empty command", () => {
    expect(refused("   ")).toEqual({ ok: false, code: "request", message: S3_AGENT_SENTENCES.empty });
    expect(refused("aws")).toEqual({ ok: false, code: "request", message: S3_AGENT_SENTENCES.empty });
  });

  test.each([
    "aws s3api list-objects-v2 --bucket sales",
    "aws s3api list-object-versions --bucket sales",
    "aws s3api get-object-tagging --bucket sales --key a.txt",
    "preview s3://sales/a.txt",
    "aws s3api get-object --bucket sales --key a.txt out.txt",
    "aws s3api put-object --bucket sales --key a.txt",
    "aws s3api delete-object --bucket sales --key a.txt",
    "aws s3 cp s3://sales/a.txt -",
    "aws s3 rm s3://sales/a.txt",
    "aws s3 presign s3://sales/a.txt",
    "aws s3api get-bucket-policy --bucket sales",
    "aws s3api get-bucket-acl --bucket sales",
    "aws s3api get-bucket-cors --bucket sales",
    "aws s3api get-bucket-lifecycle-configuration --bucket sales",
    "aws s3api get-object-acl --bucket sales --key a.txt",
    "aws s3api select-object-content --bucket sales --key a.txt",
    "aws sts get-caller-identity",
    "ls",
  ])("a read outside the table: %s", (text) => {
    expect(refused(text)).toEqual({ ok: false, code: "metadata-only", message: S3_AGENT_SENTENCES.metadataOnly });
  });

  test.each([
    "aws s3api list-objects-v2 --bucket sales --prefix 2026/",
    "aws s3api list-objects-v2 --bucket sales --delimiter /",
    "aws s3api list-object-versions --bucket sales --prefix a",
    "aws s3api list-buckets --prefix sa",
    "aws s3 ls --bucket-name-prefix sa",
    "aws s3 ls s3://sales/2026/ --recursive --summarize",
    "aws s3 ls s3://sales/a --recursive --summarize",
    "aws s3api list-objects-v2 --bucket sales --starting-token eyJ9",
  ])("a filter or position that would bisect key or bucket names: %s", (text) => {
    expect(refused(text)).toEqual({ ok: false, code: "metadata-only", message: S3_AGENT_SENTENCES.filter });
  });

  test.each([
    "aws s3 ls",
    "aws s3 ls s3://sales",
    "aws s3 ls s3://sales --recursive",
    "aws s3 ls s3://sales --summarize",
    "aws s3 ls s3://sales/ --human-readable",
  ])("a listing that is not the whole bucket's summary: %s", (text) => {
    expect(refused(text)).toEqual({ ok: false, code: "metadata-only", message: S3_AGENT_SENTENCES.listing });
  });

  test.each([
    "aws s3api list-buckets --max-items 5",
    "aws s3api list-buckets --output json",
    "aws s3api list-buckets --no-cli-pager",
    "aws s3api head-bucket --bucket sales --region us-east-1",
    "aws s3api head-bucket --bucket sales --endpoint-url http://other:9000",
    "aws --region us-east-1 s3api head-bucket --bucket sales",
    "aws s3 ls s3://sales --recursive --summarize --page-size 10",
    "aws s3 ls s3://sales --recursive --summarize --human-readable",
    "aws s3api head-object --bucket sales --key a.txt --expected-bucket-owner 1",
    "aws s3api head-object --bucket sales --key a.txt --version-id v1",
    "aws s3api head-object --bucket sales --key a.txt --range bytes=0-1",
    "aws s3api head-object --bucket sales --key a.txt --profile x",
    "aws s3api head-object --bucket sales --key a.txt --debug",
    "aws s3api head-object --bucket sales --kye a.txt",
  ])("a flag outside the table: %s", (text) => {
    expect(refused(text)).toEqual({ ok: false, code: "arguments", message: S3_AGENT_SENTENCES.flags });
  });

  test("an address the console's parser refuses keeps its sentence, followed by agent mode's reads", () => {
    for (const text of [
      "aws s3api head-object --bucket sales --key ../x",
      "aws s3api head-object --bucket sales --key a/../../x",
      "aws s3api head-object --bucket sales --key /a",
      "aws s3api head-object --bucket 'bad bucket' --key a",
      `aws s3api head-object --bucket sales --key ${"k".repeat(1025)}`,
      "aws s3api head-bucket",
      "aws s3api head-object --bucket sales",
    ]) {
      const refusal = refused(text);
      expect(refusal.code).toBe("request");
      expect(refusal.message.endsWith(`${S3_AGENT_SENTENCES.reads} Nothing was sent.`)).toBe(true);
    }
  });

  test("a NUL in a key is refused by the parser, and no refusal quotes the key", () => {
    const refusal = refused("aws s3api head-object --bucket sales --key 'secret-tenant\u0000x'");
    expect(refusal.code).toBe("request");
    expect(refusal.message).not.toContain("secret-tenant");
  });

  test("another bucket on a pinned connection", () => {
    const refusal = refused("aws s3api head-object --bucket other --key a.txt", { pinnedBucket: "sales" });
    expect(refusal.code).toBe("request");
    expect(refusal.message).toContain("sales");
    expect(refused("aws s3 ls s3://other --recursive --summarize", { pinnedBucket: "sales" }).code).toBe("request");
  });

  test("shell syntax and a second command are the parser's refusals", () => {
    expect(refused("aws s3api list-buckets | cat").code).toBe("request");
    expect(refused("aws s3api list-buckets; aws s3 rm s3://a/b").code).toBe("request");
    expect(refused("FOO=1 aws s3api list-buckets").code).toBe("request");
  });

  test("no refusal quotes a key, a prefix or a token the command wrote", () => {
    for (const text of [
      "aws s3api list-objects-v2 --bucket sales --prefix tenant-marker/",
      "aws s3api get-object-tagging --bucket sales --key tenant-marker.txt",
      "aws s3api head-object --bucket sales --key a --tenant-marker x",
      "aws s3 ls s3://sales/tenant-marker --recursive --summarize",
    ]) {
      expect(refused(text).message).not.toContain("tenant-marker");
    }
  });

  test("every agent sentence lists the reads and says nothing was sent", () => {
    for (const sentence of [
      S3_AGENT_SENTENCES.empty,
      S3_AGENT_SENTENCES.metadataOnly,
      S3_AGENT_SENTENCES.filter,
      S3_AGENT_SENTENCES.listing,
      S3_AGENT_SENTENCES.flags,
    ]) {
      expect(sentence).toContain(S3_AGENT_SENTENCES.reads);
      expect(sentence.endsWith("Nothing was sent.")).toBe(true);
    }
  });
});
