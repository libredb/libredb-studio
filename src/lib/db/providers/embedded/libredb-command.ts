/**
 * How a LibreDB command line is read: the tokenizer the editor's commands go through, and the agent's read form on top
 * of it.
 *
 * The agent's form is a parse, not a pattern match: the text is one line, tokenized as the provider tokenizes it, and
 * the first token is looked up in a closed table of the three reads (`get`, `prefix`, `range`), each with its exact
 * arity. The two writes the grammar has (`put`, `delete`) are refused by name, and any other first token as not a
 * command at all, so a quoted or upper-case spelling of a write is still a write. The agent's boundary is the
 * read-only handle (`libredb-read-only-file.ts`), not this reader; this is what lets a model read why it was refused,
 * and the provider reads the agent's statement with it again before it opens anything.
 */

/** The reads the agent's form admits, each with what it reads. */
export type LibreDBReadCommand =
  | { readonly verb: "get"; readonly key: string }
  | { readonly verb: "prefix"; readonly prefix: string }
  | { readonly verb: "range"; readonly start: string; readonly end: string };

export type LibreDBReadRefusalCode =
  | "empty"
  | "comment"
  | "lines"
  | "unmatched-quote"
  | "write-command"
  | "unknown-command"
  | "arguments";

export type LibreDBReadReading =
  | { readonly ok: true; readonly command: LibreDBReadCommand }
  | { readonly ok: false; readonly code: LibreDBReadRefusalCode; readonly message: string };

/** The editor grammar's writes, refused by name in the agent's form. */
const WRITE_COMMANDS: ReadonlySet<string> = new Set(["put", "delete"]);

const READS = "the reads are get <key>, prefix <p> and range <start> <end>";
const NOTHING_SENT = "Nothing was sent.";

/** Any line terminator, so a second command can never hide after one the reader admitted. */
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/;

/** How long a command the reader does not know is quoted back, so a refusal stays one readable sentence. */
const NAMED_COMMAND_CHARS = 40;

/**
 * Split one command line on whitespace, keeping a single- or double-quoted token whole (Redis-style), or null for an
 * unmatched quote.
 *
 * Consecutive whitespace outside quotes is one token boundary, so unquoted `put key hello  world` stores
 * `"hello world"`; a value whose spacing matters is quoted.
 */
export function tokenizeLibreDBCommand(input: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  let sawToken = false;
  for (const ch of input) {
    if (!inQuote && (ch === '"' || ch === "'")) {
      inQuote = true;
      quoteChar = ch;
      sawToken = true;
    } else if (inQuote && ch === quoteChar) {
      inQuote = false;
    } else if (!inQuote && /\s/.test(ch)) {
      if (sawToken) {
        parts.push(current);
        current = "";
        sawToken = false;
      }
    } else {
      current += ch;
      sawToken = true;
    }
  }
  if (sawToken) parts.push(current);
  return inQuote ? null : parts;
}

function refused(code: LibreDBReadRefusalCode, sentence: string): LibreDBReadReading {
  return { ok: false, code, message: `${sentence} ${NOTHING_SENT}` };
}

/** The read `verb` names with `args`, or the refusal of arguments that do not fit it. */
function readOf(verb: string, args: readonly string[]): LibreDBReadReading | undefined {
  switch (verb) {
    case "get":
      return args.length === 1
        ? { ok: true, command: { verb, key: args[0] } }
        : refused("arguments", "get takes exactly one key: get <key>, with a key that holds a space in quotes.");
    case "prefix":
      // The kernel bounds a prefix scan by the prefix's own upper bound, which an empty prefix does not have.
      if (args.length === 1 && args[0] === "") {
        return refused("arguments", "prefix needs at least one character: to read from the first key, use range.");
      }
      return args.length === 1
        ? { ok: true, command: { verb, prefix: args[0] } }
        : refused(
            "arguments",
            "prefix takes exactly one prefix: prefix <p>, with a prefix that holds a space in quotes.",
          );
    case "range":
      return args.length === 2
        ? { ok: true, command: { verb, start: args[0], end: args[1] } }
        : refused("arguments", "range takes exactly a start and an end: range <start> <end>, the end excluded.");
  }
  return undefined;
}

/**
 * The agent's reading of `text`: exactly one read command on one line, or the refusal that names what to change.
 * Total over any text.
 */
export function readLibreDBReadCommand(text: string): LibreDBReadReading {
  const line = text.trim();
  if (line === "") return refused("empty", `The statement holds no command: write one read, where ${READS}.`);
  if (LINE_BREAK.test(line)) {
    return refused(
      "lines",
      "The statement holds more than one line: an agent read is exactly one command on one line, with no comment line.",
    );
  }
  if (line.startsWith("#")) {
    return refused("comment", `The statement is a comment: write one read without a leading #, where ${READS}.`);
  }
  const parts = tokenizeLibreDBCommand(line);
  if (parts === null) {
    return refused(
      "unmatched-quote",
      "The statement has an unmatched quote: close it, or write the key without quotes.",
    );
  }
  const [first, ...args] = parts;
  const verb = first.toLowerCase();
  if (WRITE_COMMANDS.has(verb))
    return refused("write-command", `"${verb}" writes, and an agent read only reads: ${READS}.`);
  const read = readOf(verb, args);
  if (read !== undefined) return read;
  const named = verb.length > NAMED_COMMAND_CHARS ? `${verb.slice(0, NAMED_COMMAND_CHARS)}...` : verb;
  return refused("unknown-command", `"${named}" is not a LibreDB command: ${READS}.`);
}
