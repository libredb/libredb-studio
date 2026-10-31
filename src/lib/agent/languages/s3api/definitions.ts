/**
 * The tool definitions the s3api command language's workflows are offered: the statement tool for one metadata read.
 */
import { z } from "zod";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentLanguageServerPack } from "../pack";

const readS3apiStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const S3API_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    "Run one bounded S3 metadata read, written as one AWS CLI command on one line, with or without aws: s3api list-buckets for every bucket's name and creation time; s3api head-bucket --bucket BUCKET for whether a bucket exists and its region; s3api get-bucket-location --bucket BUCKET; s3api get-bucket-versioning --bucket BUCKET; s3 ls s3://BUCKET --recursive --summarize for one whole bucket's object count and total size, never its keys; or s3api head-object --bucket BUCKET --key KEY for one object you name in full, which answers its existence, size, last-modified time and storage class. Single-quote a key that holds a space. Answers carry names, counts and flags only. Object keys, bodies, user metadata, tags, ETags, version ids, owners, ACLs, policies and the endpoint are withheld, so listing keys or versions, reading an object or its tags, a preview, a --prefix, --delimiter, --starting-token or key path, every write, and every other flag or global option are refused before anything is sent, and a bucket holding more objects than the row budget is refused rather than counted in part, and you are told why.",
  inputSchema: readS3apiStatementSchema,
  operationId: "s3api.query.read",
});

const S3API_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: S3API_RUN_READ_QUERY,
});

/** The investigation sends commands through the one statement tool; `operations` sends none. */
export const S3API_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: S3API_STATEMENT_TOOLS,
});
