/**
 * The S3 console's `statementLanguage`: what plan mode states verbatim after "Write it in"
 * (`src/lib/agent/investigation.ts`), the one fact about how a statement is written that its prompt carries per
 * engine. Built from the parser's own table, as Oxia's is, so it cannot drift from what the parser takes.
 *
 * Pure, and shipped to the browser: `getLabels()` answers before connect.
 */
import { S3_COMMAND_TABLE, type S3CommandSpec, type S3FlagSpec, type S3OperationKind } from "./commands";
import { S3_RESULT_MAX_ROWS } from "./constants";

/** The reads plan mode drafts, in the table's order: every AWS CLI read; `preview` is described on its own. */
export const S3_DRAFTED_READS: readonly S3OperationKind[] = Object.freeze(
  S3_COMMAND_TABLE.filter((entry) => entry.service !== "studio").map((entry) => entry.operation),
);

/** The two reads the sentence gives as examples: a folder's listing, and one object's metadata. */
export const S3_STATEMENT_EXAMPLES: readonly [string, string] = Object.freeze([
  "aws s3 ls s3://sales/2026/",
  "aws s3api head-object --bucket sales --key 2026/orders.csv",
]) as readonly [string, string];

/** What a value flag's usage writes after its name: its value set, N for a number, else its name in capitals. */
function placeholder(flag: S3FlagSpec): string {
  if (flag.values !== undefined) return flag.values.join("|");
  if (flag.integer !== undefined) return "N";
  return flag.name.slice(2).toUpperCase().replace(/-/g, "_");
}

function flagUsage(flag: S3FlagSpec): string {
  const spelled = flag.takes === "boolean" ? flag.name : `${flag.name} ${placeholder(flag)}`;
  return flag.required === true ? spelled : `[${spelled}]`;
}

/** A command as a usage line writes it: its lead, its arguments, then each flag the parser takes. */
export function s3Usage(entry: S3CommandSpec): string {
  const lead = entry.service === "studio" ? entry.operation : `aws ${entry.service} ${entry.operation}`;
  return [lead, entry.arguments, ...entry.flags.map(flagUsage)].filter((part) => part !== "").join(" ");
}

/** Plan mode's sentence for an S3 connection, with the usage of each drafted row. */
export function s3StatementLanguage(): string {
  const usages = S3_COMMAND_TABLE.filter((entry) => S3_DRAFTED_READS.includes(entry.operation))
    .map(s3Usage)
    .join(", ");
  return `the AWS CLI read command this editor runs: exactly one command per run, written as the AWS CLI writes it, optionally after aws, with no pipe, no redirect, no second command, no environment assignment and no --profile, --endpoint-url, --region or credential option, because the connection decides where a command runs and who signs it; plan mode drafts only a read, one of ${usages}, with --max-items at most ${S3_RESULT_MAX_ROWS}; Studio's own preview s3://BUCKET/KEY shows an object's first rows and is written without aws; for example ${S3_STATEMENT_EXAMPLES[0]} or ${S3_STATEMENT_EXAMPLES[1]}; every write (cp, mv, rm, sync, mb, rb, and the s3api put, delete, create, copy and upload operations) and presign is the user's to run with the AWS CLI and is never drafted`;
}
