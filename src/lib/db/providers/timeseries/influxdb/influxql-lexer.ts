/**
 * InfluxQL text, read as tokens exactly as the influxql v1.4.1 scanner reads it (SPEC 5.3, E1).
 *
 * Pure, and shipped to the browser: the editor's tokens provider, the read policy and the
 * generators all read InfluxQL through this module, so what the editor colours as a comment or a
 * regex is what the policy skips. It imports nothing. On 1.x and 2.x the policy is the only
 * boundary before `DROP DATABASE`, so every rule below is the scanner's (`scanner.go` at v1.4.1,
 * the version InfluxDB 1.13.1 pins), and a text the two would read differently is the attack
 * (J1 1.2, B1 to B5): a lone `\r` ending a `--` comment, a `\\` inside a regex, a `/` after
 * `::field`, a NUL.
 *
 * A regex is not a scanner token: the parser asks for one at fixed places. Rather than list those
 * places, which missed `WITH MEASUREMENT = /re/` once (R13), the rule is by operand: a lone `/`
 * is division when the previous significant token ends an operand, and starts a regex everywhere
 * else. Every extra regex place this gives is one where a `/` has no left operand, so the server
 * fails the whole request there. At a statement's start the parser reads the first token with
 * `Scan`, so a lone `/` is an operator. A `/*` is a block comment in every position (R32): outside
 * the parser's true regex places the server skips the whole comment, so a regex read there could
 * end inside the comment and hide a later `;`, and at those places a regex body starting with `*`
 * never compiles, so the request fails whatever the lexer reads.
 *
 * Three scanner behaviours the SPEC table does not state are kept, because a lexer that splits a
 * token the scanner keeps whole is a lexer that disagrees with it: a word directly followed by a
 * double quote is one quoted identifier holding the quoted part (`scanIdent`), digits followed by
 * letters are one duration whatever the letters (`scanNumber`), and a number's trailing `.` is
 * part of the number (`scanNumber`). A `$` is always a bound parameter, as `scanIdent(false)`
 * reads it.
 *
 * `lexInfluxql` is total: a fault is an `invalid` token and lexing goes on after it. A string, a
 * quoted identifier or a regex holding a fault is one invalid token from its opening character,
 * the first fault by position naming it; a control character inside a comment is its own invalid
 * token and the comment goes on around it, so a block comment across lines reads the same line by
 * line. `tokenizeInfluxqlLine` is the same reading over one line from a carried state; joined
 * across lines its tokens equal `lexInfluxql`'s in kinds and boundaries. Only the faults can
 * differ: only the whole text can tell an open block comment is never closed, and a string or a
 * quoted identifier cut by a line end is `unterminated-*` line by line but `newline-in-*` in the
 * whole text.
 */

export type InfluxqlTokenKind =
  | "whitespace"
  | "line-comment"
  | "block-comment"
  | "string"
  | "quoted-identifier"
  | "identifier"
  | "keyword"
  | "number"
  | "duration"
  | "bound-parameter"
  | "regex"
  | "operator"
  | "punctuation"
  | "semicolon"
  | "invalid";

export type InfluxqlLexFault =
  | "control-character"
  | "non-ascii"
  /** Printable ASCII the scanner has no token for: `{ } [ ] ? @ # \` \ ~`, and `!` alone. */
  | "illegal-character"
  | "unterminated-string"
  | "unterminated-identifier"
  | "unterminated-regex"
  | "unterminated-comment"
  | "newline-in-string"
  | "newline-in-identifier"
  | "newline-in-regex"
  | "bad-escape";

export interface InfluxqlToken {
  readonly kind: InfluxqlTokenKind;
  /** Offset into the normalised text (or the line), in UTF-16 code units. */
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
  /** A keyword: the ASCII upper-cased word; an identifier, a quoted identifier, a string: the unescaped value. */
  readonly value?: string;
  /** Set on an `invalid` token only. */
  readonly fault?: InfluxqlLexFault;
}

/**
 * The keywords map of influxql v1.4.1 `token.go`: every token between `keywordBeg` and
 * `keywordEnd`, plus `AND`, `OR`, `TRUE` and `FALSE`, upper case (R19). Pinned to the file as
 * captured at the tag by `tests/fixtures/influxdb/influxql-v1.4.1-keywords.json`. InfluxDB 2.9.1
 * pins v1.3.0, whose map lacks `FUTURE` and `PAST`; neither is a first keyword, `INTO` or an
 * operand end, so the policy reads both pins the same.
 */
export const INFLUXQL_KEYWORDS: ReadonlySet<string> = new Set([
  "ALL",
  "ALTER",
  "ANALYZE",
  "AND",
  "ANY",
  "AS",
  "ASC",
  "BEGIN",
  "BY",
  "CARDINALITY",
  "CONTINUOUS",
  "CREATE",
  "DATABASE",
  "DATABASES",
  "DEFAULT",
  "DELETE",
  "DESC",
  "DESTINATIONS",
  "DIAGNOSTICS",
  "DISTINCT",
  "DROP",
  "DURATION",
  "END",
  "EVERY",
  "EXACT",
  "EXPLAIN",
  "FALSE",
  "FIELD",
  "FOR",
  "FROM",
  "FUTURE",
  "GRANT",
  "GRANTS",
  "GROUP",
  "GROUPS",
  "IN",
  "INF",
  "INSERT",
  "INTO",
  "KEY",
  "KEYS",
  "KILL",
  "LIMIT",
  "MEASUREMENT",
  "MEASUREMENTS",
  "NAME",
  "OFFSET",
  "ON",
  "OR",
  "ORDER",
  "PASSWORD",
  "PAST",
  "POLICIES",
  "POLICY",
  "PRIVILEGES",
  "QUERIES",
  "QUERY",
  "READ",
  "REPLICATION",
  "RESAMPLE",
  "RETENTION",
  "REVOKE",
  "SELECT",
  "SERIES",
  "SET",
  "SHARD",
  "SHARDS",
  "SHOW",
  "SLIMIT",
  "SOFFSET",
  "STATS",
  "SUBSCRIPTION",
  "SUBSCRIPTIONS",
  "TAG",
  "TO",
  "TRUE",
  "USER",
  "USERS",
  "VALUES",
  "VERBOSE",
  "WHERE",
  "WITH",
  "WRITE",
]);

/** `\r\n` and a lone `\r` become `\n`, as the scanner's reader does before anything else (C1). */
export function normaliseInfluxqlNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** ASCII-only upper case: `a` to `z` and nothing else, so no locale can turn `into` into `İNTO` (C3). */
export function foldAscii(word: string): string {
  return word.replace(/[a-z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 32));
}

/**
 * What a line starts inside. `previous` is the class of the last significant token before it:
 * none yet or a `;` (`start`), an operand end (`operand`), or anything else (`other`, a regex place).
 */
export interface InfluxqlLineState {
  readonly inBlockComment: boolean;
  readonly previous: "start" | "operand" | "other";
}

export const INITIAL_INFLUXQL_LINE_STATE: InfluxqlLineState = { inBlockComment: false, previous: "start" };

/** Operators, longest first, so `=~` is never read as `=` then `~`. `/` is decided by the operand rule. */
const OPERATORS = ["=~", "!~", "!=", "<>", "<=", ">=", "::", "=", "<", ">", "+", "-", "*", "%", "&", "|", "^", ":"];

/** The four escapes of a string and a quoted identifier (`ScanString`). */
const STRING_ESCAPES: Readonly<Record<string, string>> = { n: "\n", "\\": "\\", '"': '"', "'": "'" };

const isAsciiLetter = (ch: string): boolean => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
const isWordChar = (ch: string): boolean => isAsciiLetter(ch) || isDigit(ch) || ch === "_";
const isWhitespace = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n";
/** A C0 control other than tab and newline, or DEL: refused anywhere, inside quotes and comments too. */
const isControl = (ch: string): boolean => (ch < " " && ch !== "\t" && ch !== "\n") || ch === "\u007f";

/** A quoted part's end, its unescaped value and the first fault in it by position. */
interface Quoted {
  readonly end: number;
  readonly value: string;
  readonly fault?: InfluxqlLexFault;
}

/** Reads a `'` string or a `"` identifier opening at `at`, as `ScanString` does. */
function scanQuoted(text: string, at: number): Quoted {
  const quote = text[at];
  const what = quote === "'" ? "string" : "identifier";
  let fault: InfluxqlLexFault | undefined;
  let value = "";
  let i = at + 1;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === quote) return { end: i + 1, value, fault };
    if (ch === "\n") return { end: i, value, fault: fault ?? `newline-in-${what}` };
    if (ch === "\\") {
      const escaped = STRING_ESCAPES[text[i + 1] ?? ""];
      if (escaped !== undefined) {
        value += escaped;
        i += 2;
        continue;
      }
      // Any other pair is BADESCAPE; the character after the backslash is read again.
      fault ??= "bad-escape";
      i += 1;
      continue;
    }
    if (isControl(ch)) fault ??= "control-character";
    value += ch;
    i += 1;
  }
  return { end: i, value, fault: fault ?? `unterminated-${what}` };
}

/**
 * Reads a regex opening at `at`, as `ScanDelimited` does with the one escape `\/`: every other
 * backslash is a literal and the character after it is read again.
 */
function scanRegex(text: string, at: number): { readonly end: number; readonly fault?: InfluxqlLexFault } {
  let fault: InfluxqlLexFault | undefined;
  let i = at + 1;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "/") return { end: i + 1, fault };
    if (ch === "\n") return { end: i, fault: fault ?? "newline-in-regex" };
    if (ch === "\\" && text[i + 1] === "/") {
      i += 2;
      continue;
    }
    if (isControl(ch)) fault ??= "control-character";
    i += 1;
  }
  return { end: i, fault: fault ?? "unterminated-regex" };
}

/** One scan over `text` from `state`; `wholeText` says whether the end of `text` is the end of the statement text. */
function scan(
  text: string,
  state: InfluxqlLineState,
  wholeText: boolean,
): { readonly tokens: InfluxqlToken[]; readonly state: InfluxqlLineState } {
  const tokens: InfluxqlToken[] = [];
  let previous = state.previous;
  /** The end of the last `::`: a word starting exactly there is a cast type, an operand end (B3). */
  let castEnd = -1;

  /** A comment over [from, to), with each control character in it cut out as its own invalid token. */
  const comment = (kind: "line-comment" | "block-comment", from: number, to: number): void => {
    let pieceStart = from;
    for (let i = from; i < to; i += 1) {
      if (!isControl(text[i] as string)) continue;
      if (i > pieceStart) tokens.push({ kind, start: pieceStart, end: i });
      tokens.push({ kind: "invalid", start: i, end: i + 1, fault: "control-character" });
      pieceStart = i + 1;
    }
    if (to > pieceStart) tokens.push({ kind, start: pieceStart, end: to });
  };

  /** Records a significant token and the class it leaves for the next `/`. */
  const significant = (token: InfluxqlToken, next: InfluxqlLineState["previous"]): void => {
    tokens.push(token);
    previous = next;
  };

  let i = 0;
  if (state.inBlockComment) {
    const close = text.indexOf("*/");
    if (close < 0) {
      comment("block-comment", 0, text.length);
      return { tokens, state: { inBlockComment: true, previous } };
    }
    comment("block-comment", 0, close + 2);
    i = close + 2;
  }

  while (i < text.length) {
    const start = i;
    const ch = text[i] as string;
    const next = text[i + 1] ?? "";

    if (isWhitespace(ch)) {
      while (i < text.length && isWhitespace(text[i] as string)) i += 1;
      tokens.push({ kind: "whitespace", start, end: i });
      continue;
    }

    if (ch === "-" && next === "-") {
      const newline = text.indexOf("\n", i);
      i = newline < 0 ? text.length : newline;
      comment("line-comment", start, i);
      continue;
    }

    if (ch === "/") {
      if (next === "*") {
        const close = text.indexOf("*/", i + 2);
        if (close >= 0) {
          i = close + 2;
          comment("block-comment", start, i);
          continue;
        }
        i = text.length;
        if (wholeText) {
          tokens.push({ kind: "invalid", start, end: i, fault: "unterminated-comment" });
          continue;
        }
        comment("block-comment", start, i);
        return { tokens, state: { inBlockComment: true, previous } };
      }
      if (previous === "other") {
        const regex = scanRegex(text, i);
        i = regex.end;
        significant(
          regex.fault ? { kind: "invalid", start, end: i, fault: regex.fault } : { kind: "regex", start, end: i },
          "operand",
        );
        continue;
      }
      i += 1;
      significant({ kind: "operator", start, end: i }, "other");
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quoted = scanQuoted(text, i);
      i = quoted.end;
      const kind = ch === "'" ? "string" : "quoted-identifier";
      significant(
        quoted.fault
          ? { kind: "invalid", start, end: i, fault: quoted.fault }
          : { kind, start, end: i, value: quoted.value },
        "operand",
      );
      continue;
    }

    if (isAsciiLetter(ch) || ch === "_" || ch === "$") {
      const bound = ch === "$";
      if (bound) i += 1;
      while (i < text.length && isWordChar(text[i] as string)) i += 1;
      const word = text.slice(start, i);
      if (text[i] === '"') {
        // `scanIdent` reads a double quote right after a word as the rest of the same token.
        const quoted = scanQuoted(text, i);
        i = quoted.end;
        significant(
          quoted.fault
            ? { kind: "invalid", start, end: i, fault: quoted.fault }
            : bound
              ? { kind: "bound-parameter", start, end: i }
              : { kind: "quoted-identifier", start, end: i, value: quoted.value },
          "operand",
        );
        continue;
      }
      if (bound) {
        significant({ kind: "bound-parameter", start, end: i }, "operand");
        continue;
      }
      const folded = foldAscii(word);
      if (!INFLUXQL_KEYWORDS.has(folded)) {
        significant({ kind: "identifier", start, end: i, value: word }, "operand");
        continue;
      }
      const operand = start === castEnd || folded === "TRUE" || folded === "FALSE";
      significant({ kind: "keyword", start, end: i, value: folded }, operand ? "operand" : "other");
      continue;
    }

    if (isDigit(ch) || (ch === "." && isDigit(next))) {
      while (i < text.length && isDigit(text[i] as string)) i += 1;
      let kind: "number" | "duration" = "number";
      if (text[i] === ".") {
        // `scanNumber` takes the `.` whether or not a digit follows it; a decimal takes no unit.
        i += 1;
        while (i < text.length && isDigit(text[i] as string)) i += 1;
      } else if (isAsciiLetter(text[i] ?? "")) {
        kind = "duration";
        while (i < text.length && (isAsciiLetter(text[i] as string) || isDigit(text[i] as string))) i += 1;
      }
      significant({ kind, start, end: i }, "operand");
      continue;
    }

    if (ch === ";") {
      i += 1;
      significant({ kind: "semicolon", start, end: i }, "start");
      continue;
    }

    if (ch === "(" || ch === ")" || ch === "," || ch === ".") {
      i += 1;
      significant({ kind: "punctuation", start, end: i }, ch === ")" ? "operand" : "other");
      continue;
    }

    const operator = OPERATORS.find((op) => text.startsWith(op, i));
    if (operator !== undefined) {
      i += operator.length;
      if (operator === "::") castEnd = i;
      significant({ kind: "operator", start, end: i }, operator === "*" ? "operand" : "other");
      continue;
    }

    // Whatever is left is a fault. A text holding one is refused, so a `/` after it reads as division.
    const code = text.codePointAt(i) as number;
    i += code > 0xffff ? 2 : 1;
    const fault: InfluxqlLexFault = isControl(ch)
      ? "control-character"
      : code > 0x7f
        ? "non-ascii"
        : "illegal-character";
    significant({ kind: "invalid", start, end: i, fault }, "operand");
  }

  return { tokens, state: { inBlockComment: false, previous } };
}

/** Every token of a normalised text (`normaliseInfluxqlNewlines` first). Total: never throws. */
export function lexInfluxql(text: string): readonly InfluxqlToken[] {
  return scan(text, INITIAL_INFLUXQL_LINE_STATE, true).tokens;
}

/**
 * The tokens of one line (no `\n` in it), offsets into the line, read from the state the line
 * before left: a block comment can span lines, and the operand rule can depend on the last
 * significant token of an earlier line. Never throws.
 */
export function tokenizeInfluxqlLine(
  line: string,
  state: InfluxqlLineState,
): { readonly tokens: readonly InfluxqlToken[]; readonly state: InfluxqlLineState } {
  return scan(line, state, false);
}
