/**
 * How a Redis editor text becomes the ONE command a run sends: one reading, shared by the
 * provider that runs it and by the confirmation gate and editor refusal that read it first, so
 * what asks, what is refused and what runs are the same parse (docs/providers/redis.md 3.4a).
 *
 * THE RULE: each non-empty line is its own command. A line continues onto the next only when it
 * ends inside an open quoted argument (a multi-line value, an `EVAL` script, a `FUNCTION LOAD`
 * library) or inside an unfinished JSON command, whose braces and brackets are not yet balanced.
 * `#` comment lines are dropped wherever they stand, and the first blank line ends what a run
 * reads: the schema explorer's cheatsheet is a list of alternatives separated by blank lines, so
 * running the whole buffer runs its first command. A second command before that blank line is
 * refused, naming its line, and nothing is sent.
 *
 * WHY NOT THE OLD BLOCK RULE. Until this reading the first blank-line-delimited block was ONE
 * command and a newline outside quotes was ordinary whitespace, so a command wrapped over two
 * lines ran whole. The same rule turned the far more common `RPUSH mq x` / `RPUSH mq y` into one
 * `RPUSH mq x RPUSH mq y`: measured on Redis 8.10.2 and Valkey 9.1.2, it answered `(integer) 4`
 * and the list held `x, RPUSH, mq, y`, with nothing on screen to say the second line was data.
 *
 * WHY BRACKETS COUNT ONLY FOR A JSON COMMAND. A plain argument cannot carry a JSON value or a Lua
 * script across lines without quotes, because whitespace splits it and quote characters are
 * stripped, so outside quotes a bracket is ordinary key text: `user:{42}` is a cluster hash tag,
 * and a key such as `a{b` would otherwise hold its line open and glue the next command onto it,
 * which is the defect this reading exists to stop.
 */

/** What one run of a Redis editor text sends. */
export type RedisCommandText =
  | { readonly kind: "empty" }
  | { readonly kind: "json"; readonly body: string }
  | { readonly kind: "plain"; readonly words: readonly string[] }
  | { readonly kind: "refused"; readonly refusal: string };

/** One command read off the text, and the index of the first line after it. */
type ReadCommand = { readonly command: RedisCommandText; readonly next: number };

/** The longest command word a refusal quotes, so a line with no whitespace cannot flood the message. */
const QUOTED_WORD_LIMIT = 40;

/** A line that is no command: blank, or a `#` comment. Only asked where no quoted argument is open. */
function isChrome(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/**
 * A plain command from `start`. The quoting is redis-cli's without its escapes: whitespace outside
 * quotes separates arguments, a `"` or `'` opens a quoted run that only the same character closes,
 * and quoted and unquoted runs with no whitespace between them make one argument (`a"b c"d` is
 * `ab cd`). A quoted run makes an argument even when it is empty, so `SET k ""` sends the empty
 * string rather than dropping it. The command ends with its first line unless a quote is still
 * open there, and inside one the line break is data, a blank or `#`-leading line included, so
 * `SET note "line1` / `#tag"` stores a two-line value.
 *
 * A quote still open at the end of the text is refused rather than closed there. Measured before
 * this: `SET greeting it's` / `GET greeting` stored `its` plus a newline plus `GET greeting`, because
 * the apostrophe opened a run that swallowed every later line, blank-line alternatives included.
 * Continuing is right only when the quote closes later; when it never does, the lines it took were
 * meant as commands.
 */
function readPlain(lines: readonly string[], start: number): ReadCommand {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote = "";
  let quoteLine = 0;
  let index = start;
  for (; index < lines.length; index++) {
    if (index > start) current += "\n";
    for (const ch of lines[index]) {
      if (quote !== "") {
        if (ch === quote) quote = "";
        else current += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        quoteLine = index + 1;
        started = true;
      } else if (/\s/.test(ch)) {
        if (started) words.push(current);
        current = "";
        started = false;
      } else {
        current += ch;
        started = true;
      }
    }
    if (quote === "") break;
  }
  if (quote !== "") return { command: { kind: "refused", refusal: unclosedQuote(quoteLine, quote) }, next: index };
  if (started) words.push(current);
  return { command: { kind: "plain", words }, next: index + 1 };
}

/**
 * A JSON command from `start`: lines are taken until its braces and brackets balance, counted
 * outside JSON strings with JSON's own `\` escape, so `JSON.stringify(cmd, null, 2)` reads whole.
 * A `#` line inside it is dropped, since a JSON string carries no literal newline and no line of
 * one can begin with `#`; a blank line ends it, so an unbalanced body fails `JSON.parse` rather
 * than swallowing the next alternative.
 */
function readJson(lines: readonly string[], start: number): ReadCommand {
  const body: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let index = start;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (index > start) {
      if (line.trim() === "") break;
      if (line.trim().startsWith("#")) continue;
    }
    body.push(line);
    for (const ch of line) {
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
    }
    if (depth <= 0) {
      index++;
      break;
    }
  }
  return { command: { kind: "json", body: body.join("\n") }, next: index };
}

/** The refusal for a second command on `line` (1-based), quoting its first word. */
function secondCommand(line: number, text: string): string {
  const word = text.split(/\s/, 1)[0];
  const shown = word.length > QUOTED_WORD_LIMIT ? `${word.slice(0, QUOTED_WORD_LIMIT)}...` : word;
  return (
    `Line ${line} holds a second command, which begins with ${JSON.stringify(shown)}: each line is one ` +
    "Redis command, and Studio runs one command per run. Select the line to run it, and the editor sends " +
    "the selection. A command continues onto the next line only inside a quoted argument or an unfinished " +
    "JSON command."
  );
}

/** The refusal for a quoted argument opened on `line` (1-based) that the text never closes. */
function unclosedQuote(line: number, quote: string): string {
  return (
    `Line ${line} opens a quoted argument with ${quote} that never closes, so it would take every line ` +
    "after it as data. Close the quote, or use the JSON command form for a value that holds a quote " +
    'character: {"command": "SET", "args": ["k", "it\'s"]}.'
  );
}

/** Read an editor text to the one command a run sends, or to why it sends none. */
export function readRedisCommandText(text: string): RedisCommandText {
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length && isChrome(lines[start])) start++;
  if (start === lines.length) return { kind: "empty" };

  // The first character of the first command line picks the form, the test the provider has
  // always dispatched on.
  const read = lines[start].trimStart().startsWith("{") ? readJson(lines, start) : readPlain(lines, start);
  for (let index = read.next; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === "") break;
    if (line.startsWith("#")) continue;
    return { kind: "refused", refusal: secondCommand(index + 1, line) };
  }
  return read.command;
}

/** The editor's refusal for a Redis text, or undefined to send it: the same reading the provider runs. */
export function redisRefusal(text: string): string | undefined {
  const read = readRedisCommandText(text);
  return read.kind === "refused" ? read.refusal : undefined;
}
