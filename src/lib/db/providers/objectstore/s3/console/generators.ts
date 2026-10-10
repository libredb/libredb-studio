/**
 * What a tree click and Generate Command write for an S3 bucket or object, read through
 * `DIALECT_GENERATORS.s3` in `src/lib/query-generators.ts`, and the read-on command the read-on notice names for `ls`.
 *
 * Pure, and shipped to the browser, in the shape of Oxia's generators. A bucket's path is `[bucket]`, an object's
 * `[bucket, key]`. Every value is written by the value rule: `<flag>=` and the quoted value when it begins with `-`
 * (which the console reads only after `=`), else `<flag>` and the quoted value. Every command line written,
 * and every comment line without its `# `, is one the console's parser accepts; the two notes for a key no command
 * line spells are the only lines that are not commands.
 */
import { quoteShellWord } from "@/lib/db/console/shell-words";

const CR_NOTE = "# This key holds a carriage return, which a command line cannot spell: open it from the Keys panel.";
const NUL_NOTE = "# This key holds a NUL character, which a command line cannot pass: open it from the Keys panel.";

/**
 * A word as `quoteShellWord` writes it, with a lone `^` quoted: `quoteShellWord` leaves `^` bare, and the console
 * refuses a bare `^` word as a Windows line continuation.
 */
function shellWord(text: string): string {
  const word = quoteShellWord(text);
  return word === "^" ? "'^'" : word;
}

/** The value rule: `<flag>=<value>` when the value begins with -, else `<flag> <value>`, the value quoted as needed. */
export function s3FlagValue(flag: string, value: string): string {
  return value.startsWith("-") ? `${flag}=${shellWord(value)}` : `${flag} ${shellWord(value)}`;
}

/** A value the console refuses whatever its quoting: the AWS CLI would read it from a local file. */
function namesLocalFile(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.startsWith("file://") || lower.startsWith("fileb://");
}

/** The note for a key no command line spells, or undefined when it has a spelling. */
function unspelledNote(key: string): string | undefined {
  if (key.includes("\r")) return CR_NOTE;
  if (key.includes("\u0000")) return NUL_NOTE;
  return undefined;
}

const bucketOf = (path: readonly string[]): string => path[0];
const keyOf = (path: readonly string[]): string => path.slice(1).join("/");

/** `aws s3 ls s3://<bucket>/`: the bucket's top level. */
const listCommand = (bucket: string): string => `aws s3 ls ${shellWord(`s3://${bucket}/`)}`;
/** `preview s3://<bucket>/<key>`: the path word begins with s3://, never with -. */
const previewCommand = (bucket: string, key: string): string => `preview ${shellWord(`s3://${bucket}/${key}`)}`;

/** A tree click (run): the bucket's listing, or the object's preview, or the note for a key no command line spells. */
export function s3TableQuery(path: readonly string[]): string {
  const bucket = bucketOf(path);
  if (path.length === 1) return listCommand(bucket);
  const key = keyOf(path);
  return unspelledNote(key) ?? previewCommand(bucket, key);
}

/**
 * Generate Command (written, not run): the click's command, then reads as comments. A key that holds a line feed
 * spells over two lines, which no comment line holds, and a key that names a local file to the AWS CLI is refused as
 * a value, so for either the text is the preview alone.
 */
export function s3SelectQuery(path: readonly string[]): string {
  const bucket = bucketOf(path);
  if (path.length === 1)
    return [
      listCommand(bucket),
      `# aws s3api list-objects-v2 ${s3FlagValue("--bucket", bucket)} --delimiter / --max-items 50`,
      `# aws s3api get-bucket-versioning ${s3FlagValue("--bucket", bucket)}`,
    ].join("\n");
  const key = keyOf(path);
  const note = unspelledNote(key);
  if (note !== undefined) return note;
  if (key.includes("\n") || namesLocalFile(key)) return previewCommand(bucket, key);
  return [
    previewCommand(bucket, key),
    `# aws s3api head-object ${s3FlagValue("--bucket", bucket)} ${s3FlagValue("--key", key)}`,
  ].join("\n");
}

/**
 * The command the read-on notice names for `ls`, which takes no `--starting-token` in the AWS CLI: `list-objects-v2`
 * with the bucket, the prefix when it is not empty, `--delimiter /` unless the listing was recursive, and the token.
 */
export function s3ReadOnCommand(input: {
  readonly bucket: string;
  readonly prefix: string;
  readonly delimiter: boolean;
  readonly startingToken: string;
}): string {
  const parts = ["aws s3api list-objects-v2", s3FlagValue("--bucket", input.bucket)];
  if (input.prefix !== "") parts.push(s3FlagValue("--prefix", input.prefix));
  if (input.delimiter) parts.push("--delimiter /");
  parts.push(s3FlagValue("--starting-token", input.startingToken));
  return parts.join(" ");
}
