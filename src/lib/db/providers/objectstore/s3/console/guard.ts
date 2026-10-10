/**
 * What an S3 command is to the confirmation gate: the vocabulary row's `read`, `refuse` and
 * its empty set of destructive operations, read by `src/lib/db/destructive-commands.ts`.
 *
 * Pure, and shipped to the browser, with the parser the provider runs, so what asks and what runs are one parse of
 * one text. v1 only reads, so nothing asks; what the parser refuses, the editor refuses before anything is sent.
 * The browser knows no connection, so it reads with an empty context: an --endpoint-url, a --region or a bucket
 * that names another connection's is accepted here and refused by the provider (Oxia's split).
 */
import { parseS3Command } from "./commands";

/** The operations the confirmation gate asks about: none, because v1 only reads. */
export const S3_DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set<string>();

/** The vocabulary row's `refuse`: the parser with the browser's context; undefined to send. */
export function s3Refusal(text: string): string | undefined {
  const parsed = parseS3Command(text, {});
  return parsed.ok ? undefined : parsed.refusal.message;
}

/** The vocabulary row's `read`: [kind] for a text s3Refusal accepts; undefined otherwise. */
export function readS3Operations(text: string): readonly string[] | undefined {
  const parsed = parseS3Command(text, {});
  return parsed.ok ? [parsed.parsed.command.kind] : undefined;
}
