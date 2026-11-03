/**
 * The s3api command language's MCP facet: `run_s3_read`, one AWS CLI command on one line, read and admitted by the
 * agent's own S3 reader.
 *
 * The MCP module runs it through the provider's `queryReadOnly` under the agent read-only profile, so a call reads what
 * an agent read reads: one read of the closed table of six metadata reads, sent through the agent's client, which holds
 * those reads alone over a transport that sends GET and HEAD only, and answered through the metadata-only projection of
 * names, counts and flags, never an object key it was not given, a body, user metadata, a tag, an ETag, a version id or
 * the endpoint.
 *
 * MCP reads S3 only under the seed's agent read key (`MCP_AGENT_CREDENTIAL_REQUIRED`), never under the connection's
 * own key, so the buckets a call reaches are that key's grants, enforced by the server: the bucket listing answers the
 * names that key may list, and a bucket or key it may not read answers as a missing one. The answer carries the
 * provider's warnings as its notes, since each is Studio's own sentence naming no stored value, and a pinned
 * connection's listing would otherwise read as a store of one bucket.
 *
 * No `database` key: a connection's database setting is the bucket it is pinned to, an object name, so list_connections
 * keeps it, and every read names its own bucket. S3 declares no relation kind, so the facet holds no tables, and
 * inspect_schema refuses an S3 connection by name and points here.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const S3API_MCP_FACET = Object.freeze({
  tool: "run_s3_read",
  title: "Run a read-only S3 metadata read",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  holdsNoTables: true,
  answersWarnings: true,
  describe: ({ engines, limits }) =>
    `Run one read-only S3 metadata read on a connection: one AWS CLI command on one line, with or without aws: s3api list-buckets for every bucket's name and creation time; s3api head-bucket --bucket BUCKET for whether a bucket exists and its region; s3api get-bucket-location --bucket BUCKET; s3api get-bucket-versioning --bucket BUCKET; s3 ls s3://BUCKET --recursive --summarize for one whole bucket's object count and total size, never its keys; or s3api head-object --bucket BUCKET --key KEY for one object you name in full, which answers its existence, size, last-modified time and storage class. Single-quote a key that holds a space. Answers carry names, counts and flags only: object keys, bodies, user metadata, tags, ETags, version ids, owners, ACLs, policies and the endpoint are withheld, so listing keys or versions, reading an object or its tags, a preview, a --prefix, --delimiter, --starting-token or key path, every write, and every other flag or global option are refused before the server is reached, and a bucket holding more objects than the row budget is refused rather than counted in part. Every read is signed with the connection's agent read key, never the connection's own key, so the bucket list holds the names that key may list, and a bucket or key it may not read answers in the same sentence as one that does not exist. On a connection pinned to one bucket the bucket list answers that bucket alone, and the answer's notes say so. inspect_schema refuses an S3 connection, since S3 holds no table. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, so read one bucket you name instead of the bucket list.`,
  words: {
    fewerFields: "Read one bucket you name with head-bucket instead of the bucket list",
    readPast: (shown: number, cut: "max_rows" | "result_bytes") =>
      `read past the ${shown} row${shown === 1 ? "" : "s"} returned, ${cut === "max_rows" ? "raise max_rows (at most 500), or " : ""}read one bucket you name with head-bucket, since an S3 read is never paged.`,
    rowOverCap:
      "One row of this result is larger than the 32 KiB result limit, which a name, a count and a flag never are. Run the read again.",
    reached: "the server",
  },
} as const satisfies AgentLanguageMcpFacet);
