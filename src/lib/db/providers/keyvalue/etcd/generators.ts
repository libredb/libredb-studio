/**
 * The etcd dialect's generators (#1089, section 6.4): what a tree click on a group runs and what Generate Command
 * writes, collected as the dialect's row by `DIALECT_GENERATORS` in `src/lib/db/query-generators/index.ts`.
 * Browser-safe: it reads only the key encoding and the lexer's quoting.
 */
import { commentName, objectSegment } from "@/lib/db/query-generators/shared";
import type { DialectGenerators, GeneratorScope } from "@/lib/db/query-generators/types";
import type { ObjectReadRange } from "@/lib/db/types";
import { encodeKey } from "./keys";
import { quoteGoString, quoteTxnWord, quoteWord } from "./lexer";

/**
 * An etcd key-prefix group's prefix (#1089, section 6.4): the row name without its final `*` where the
 * name ends in `/*`, the only name keys.ts `groupLabel` writes (`/app/config/*` reads `/app/config/`).
 * Any other segment is the prefix as it stands, so a hand-built path still reads a bounded prefix, and
 * never a key with a `*` in it.
 */
function etcdGroupPrefix(name: string): string {
  return name.endsWith("/*") ? name.slice(0, -1) : name;
}

/** The rows a generated etcd read asks for: the preview page the other arms read (#1089 6.4). */
const ETCD_READ_LIMIT_FLAG = "--limit=50";

/** The sample key's last segment and the sample value of Generate Command's write forms (#1089 6.4). */
const ETCD_SAMPLE_NAME = "example";
const ETCD_SAMPLE_VALUE = "value";

/**
 * Whether a word holds a character Studio's editor does not keep as the etcd command line spells it: a
 * carriage return, which has no spelling there, since the editor ends a line at it and the lexer's
 * `quoteWord` throws for one, or a line or paragraph separator, U+2028 or U+2029, which Monaco offers to
 * remove from the text the moment it lands, as an unusual line terminator, so a form that kept it raw
 * between single quotes would name other bytes once the offer is taken. A form that names one is written
 * as a txn request instead, whose Go quoting escapes each of them (#1089 6.4).
 */
const holdsUnkeptCharacter = (word: string): boolean => /[\r\u2028\u2029]/.test(word);

/**
 * A group's name as an etcd note names it: `commentName`'s JSON quoting, with a line or paragraph separator,
 * which JSON leaves raw and the editor does not keep (`holdsUnkeptCharacter`), written as its `\u` escape, which
 * JSON reads back as the same character (#1089 6.4).
 */
const etcdCommentName = (name: string): string =>
  commentName(name).replace(/[\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16)}`);

/**
 * One etcd request: the command, then its arguments through `quote`, the word rule of the place the
 * request lands, then the flags; or, where an argument begins with `-`, the flags, `--` and the arguments,
 * because etcdctl reads a word that begins with `-` as a flag (#1089 6.4, R11 ETCD-6).
 */
function etcdRequest(
  command: string,
  args: readonly string[],
  flags: readonly string[],
  quote: (word: string) => string,
): string {
  const words = args.map(quote);
  const dashed = args.some((arg) => arg.startsWith("-"));
  return [command, ...(dashed ? [...flags, "--", ...words] : [...words, ...flags])].join(" ");
}

/** A word of a txn request: bare when it is safe text, else Go-quoted (lexer.ts `quoteTxnWord`). */
const etcdTxnWord = (word: string): string => quoteTxnWord(encodeKey(word));

/** A piece of a group's range as a get names it: its keys, and `--prefix` for a prefix (#1089 4.7). */
function etcdPieceGet(piece: ObjectReadRange): { readonly keys: readonly string[]; readonly flags: readonly string[] } {
  if ("key" in piece) return { keys: [piece.key], flags: [] };
  if ("prefix" in piece) return { keys: [piece.prefix], flags: ["--prefix"] };
  return { keys: [piece.start, piece.end], flags: [] };
}

/**
 * The read of one piece (#1089 6.4): a get on the command line with the preview's `--limit`, or, where a
 * key holds a character the editor does not keep as the command line spells it (`holdsUnkeptCharacter`),
 * a txn whose success list holds the Go-quoted get with no `--limit`, since the provider sends a txn's
 * ranged get with its own page size (#1089 5.1.4). The txn closes its success and failure lists with a
 * blank line each, so no line below it is read as one of its requests.
 */
function etcdRead(piece: ObjectReadRange): string {
  const { keys, flags } = etcdPieceGet(piece);
  if (keys.some(holdsUnkeptCharacter)) {
    return ["txn", "", etcdRequest("get", keys, flags, etcdTxnWord), "", ""].join("\n");
  }
  return etcdRequest("get", keys, [...flags, ETCD_READ_LIMIT_FLAG], quoteWord);
}

/**
 * A form written as comment lines (#1089 6.4): every physical line behind `# `, and a blank one as `#`, so a
 * form that spans lines, a quoted key holding a newline or a txn, is commented on each of them and never
 * leaves a runnable remainder.
 */
function etcdCommented(form: string): string {
  return form
    .split("\n")
    .map((line) => (line === "" ? "#" : `# ${line}`))
    .join("\n");
}

/**
 * Blocks a blank line apart; a block that ends in a line break, the closed txn of `etcdRead`, already ends
 * on a blank line, so it takes one line break more.
 */
function etcdBlocks(blocks: readonly string[]): string {
  return blocks.reduce((text, block) => `${text}${text.endsWith("\n") ? "\n" : "\n\n"}${block}`);
}

/**
 * What a tree click on an etcd group runs (#1089 6.4, 4.7): the read of the first piece this connection may
 * read, the whole prefix where the listing named none, and each further piece as a commented read below it.
 * A group whose every readable piece starts or ends at a key that is not UTF-8 text lists no piece
 * (keyvalue/etcd/objects.ts `groupReadRanges`), and gets a note and no read.
 */
function etcdReadText(tableName: string, scope: GeneratorScope | undefined): string {
  const [first, ...rest] = scope?.readRanges ?? [{ prefix: etcdGroupPrefix(tableName) }];
  if (first === undefined) {
    return `# No read is written for ${etcdCommentName(tableName)}: each part of it this connection may read starts or ends at a key that is not UTF-8 text.`;
  }
  return etcdBlocks([etcdRead(first), ...rest.map((piece) => etcdCommented(etcdRead(piece)))]);
}

/**
 * The txn template of Generate Command (#1089 6.4): create the key where it does not exist, else read it.
 * The compare's key is Go-quoted, as etcdctl's compare reads it, and each request word takes the txn rule.
 */
function etcdTxnTemplate(key: string): string {
  return [
    "txn",
    `create(${quoteGoString(encodeKey(key))}) = "0"`,
    "",
    etcdRequest("put", [key, ETCD_SAMPLE_VALUE], [], etcdTxnWord),
    "",
    etcdRequest("get", [key], [], etcdTxnWord),
  ].join("\n");
}

/**
 * Generate Command's other forms (#1089 6.4), each on a sample key under the group's prefix: a put, a
 * del, a watch of the prefix and the txn template. A prefix holding a character the editor does not keep
 * as the command line spells it has no command-line form, so the txn template, which spells it, is its
 * one form. A prefix that begins with `-` gets no watch: on `watch`, a `--` introduces the command etcdctl
 * runs for each event, so no watch of such a prefix parses.
 */
function etcdOtherForms(prefix: string): readonly string[] {
  const key = `${prefix}${ETCD_SAMPLE_NAME}`;
  const template = etcdTxnTemplate(key);
  if (holdsUnkeptCharacter(prefix)) return [template];
  return [
    etcdRequest("put", [key, ETCD_SAMPLE_VALUE], [], quoteWord),
    etcdRequest("del", [key], [], quoteWord),
    ...(prefix.startsWith("-") ? [] : [etcdRequest("watch", [prefix], ["--prefix"], quoteWord)]),
    template,
  ];
}

/**
 * Generate Command on an etcd group (#1089 6.4): the click's read, then the other forms as comments, so
 * running the whole buffer runs the read and a write needs an edit first. On a read-only connection it is
 * the read alone, with its pieces, and no form that writes (E6).
 */
function etcdCommandText(tableName: string, scope: GeneratorScope | undefined): string {
  const read = etcdReadText(tableName, scope);
  if (scope?.readOnly === true) return read;
  return etcdBlocks([read, ...etcdOtherForms(etcdGroupPrefix(tableName)).map(etcdCommented)]);
}

/**
 * etcd reads a group through an etcdctl command (#1089, section 6.4). A row is one group, so the click reads its
 * prefix, or the first piece of it this connection may read, bounded by the command's own `--limit`; "Generate
 * Command" writes that read on the first line and the other forms as comments below it. A group's columns are the
 * fixed shape of a get row, so none reaches the text.
 */
export const ETCD_GENERATORS: DialectGenerators = Object.freeze<DialectGenerators>({
  table: (path, _columns, scope) => etcdReadText(objectSegment(path), scope),
  select: (path, _columns, scope) => etcdCommandText(objectSegment(path), scope),
});
