/**
 * The sentence plan mode states after "Write it in" for an S3 connection, built from the
 * parser's own table, so a read or a flag the parser takes is named here too; both examples parse and classify as
 * reads.
 */
import { describe, expect, test } from "bun:test";
import { parseS3Command, S3_COMMAND_TABLE } from "@/lib/db/providers/objectstore/s3/console/commands";
import { readS3Operations } from "@/lib/db/providers/objectstore/s3/console/guard";
import {
  S3_DRAFTED_READS,
  S3_STATEMENT_EXAMPLES,
  s3StatementLanguage,
  s3Usage,
} from "@/lib/db/providers/objectstore/s3/console/statement-language";

describe("s3StatementLanguage", () => {
  test("plan mode drafts the nine AWS CLI reads, never preview", () => {
    expect(S3_DRAFTED_READS).toEqual([
      "ls",
      "list-buckets",
      "list-objects-v2",
      "list-object-versions",
      "head-bucket",
      "head-object",
      "get-object-tagging",
      "get-bucket-location",
      "get-bucket-versioning",
    ]);
  });

  test("a usage writes the lead, the arguments and each flag, optional ones in brackets", () => {
    const usageOf = (operation: string) => {
      const entry = S3_COMMAND_TABLE.find((candidate) => candidate.operation === operation);
      if (entry === undefined) throw new Error(operation);
      return s3Usage(entry);
    };
    expect(usageOf("ls")).toBe(
      "aws s3 ls [PATH] [--recursive] [--page-size N] [--human-readable] [--summarize] [--bucket-name-prefix BUCKET_NAME_PREFIX]",
    );
    expect(usageOf("head-object")).toBe("aws s3api head-object --bucket BUCKET --key KEY");
    expect(usageOf("list-objects-v2")).toBe(
      "aws s3api list-objects-v2 --bucket BUCKET [--prefix PREFIX] [--delimiter /] [--encoding-type url] [--max-items N] [--starting-token STARTING_TOKEN] [--page-size N]",
    );
    expect(usageOf("preview")).toBe(
      "preview PATH [--format text|json|ndjson|csv|tsv|parquet|hex] [--columns COLUMNS] [--max-rows N] [--schema]",
    );
  });

  test("the sentence names every drafted row's usage, the row bound and both examples", () => {
    const sentence = s3StatementLanguage();
    for (const entry of S3_COMMAND_TABLE.filter((candidate) => S3_DRAFTED_READS.includes(candidate.operation))) {
      expect(sentence).toContain(s3Usage(entry));
    }
    expect(sentence.startsWith("the AWS CLI read command this editor runs: exactly one command per run")).toBe(true);
    expect(sentence).toContain("with --max-items at most 500;");
    expect(sentence).toContain(
      "for example aws s3 ls s3://sales/2026/ or aws s3api head-object --bucket sales --key 2026/orders.csv;",
    );
    expect(sentence.endsWith("is the user's to run with the AWS CLI and is never drafted")).toBe(true);
  });

  test("both examples parse and classify as reads", () => {
    expect(S3_STATEMENT_EXAMPLES).toEqual([
      "aws s3 ls s3://sales/2026/",
      "aws s3api head-object --bucket sales --key 2026/orders.csv",
    ]);
    for (const example of S3_STATEMENT_EXAMPLES) expect(parseS3Command(example, {}).ok).toBe(true);
    expect(readS3Operations(S3_STATEMENT_EXAMPLES[0])).toEqual(["ls"]);
    expect(readS3Operations(S3_STATEMENT_EXAMPLES[1])).toEqual(["head-object"]);
  });
});
