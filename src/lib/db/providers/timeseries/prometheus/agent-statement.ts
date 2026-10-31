/**
 * The agent's reader of one PromQL read: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure. A read is one PromQL expression, the console's own statement: `query()` sends the editor's text unchanged as
 * the expression of one instant query, and so does the agent path, through the same request builder. The console
 * leaves every judgement of the text to the server; this reader refuses, before anything is sent, a text the server
 * could only refuse or one that is not an expression at all, and says why in agent mode's own words with its list of
 * reads.
 *
 * It is a lexer, not a pattern list. It mirrors the top level of the v3.13.3 lexer (`lexStatements` and
 * `lexInsideBraces` in `promql/parser/lex.go`): the closed table of what may start a token there, `#` comments to the
 * end of a line, the three string forms with their escapes, numbers and durations, identifiers and keywords, the
 * operators, and the brackets, whose nesting it checks. A character that table has no row for is refused where it
 * stands; `$`, which starts a dashboard variable such as `$__range`, a dashboard's time-range directive that only a
 * dashboard expands, gets its own sentence. Inside a label matcher's braces only a label name, a string, a comma and the
 * four matcher operators may stand, so a JSON request (`{"query": "up", "time": 0}`) is refused at its colon.
 *
 * Nothing but the expression is ever sent: the time, range, step, limit and every other request parameter are not
 * written by the model, so a parameter written into the text (`up&time=0`) is refused at its `&`, and could not reach
 * the request even if it were not, since the expression travels as one form field.
 *
 * Not the boundary. The boundary is the provider's structural closed table: the transport builds requests only to the
 * paths of its own table, the one POST being the instant query, and PromQL has no construct that writes.
 */

const NOTHING_SENT = "Nothing was sent.";

/** What agent mode reads on Prometheus, in the words every refusal of the reader repeats. */
export const PROMETHEUS_AGENT_READS =
  "Agent mode on Prometheus reads with one PromQL expression per read, written as the console writes it and evaluated as an instant query at the server's own now, the way the console runs it; a range vector or a subquery inside the expression is how a read covers a window. The expression alone is sent: no time, range, step, limit or other request parameter can be written, the server's time-out is set from the read's time budget, and an answer past the row or byte budget is refused, never cut. Only the instant query and the provider's own read endpoints are ever called, never a write, an admin or a lifecycle endpoint.";

/** Why a read was refused, in the reader's words; the list of reads follows it. */
const PROMETHEUS_AGENT_SENTENCES = {
  reads: PROMETHEUS_AGENT_READS,
  refusal: (reason: string): string => `${reason} ${PROMETHEUS_AGENT_READS} ${NOTHING_SENT}`,
} as const;

export type PrometheusAgentReading =
  | { readonly ok: true; readonly expression: string }
  | { readonly ok: false; readonly code: "statement"; readonly message: string };

/** Brackets the lexer pairs, by their opening character. */
const CLOSERS: Readonly<Record<string, string>> = Object.freeze({ "(": ")", "[": "]", "{": "}" });
const OPENERS: Readonly<Record<string, string>> = Object.freeze({ ")": "(", "]": "[", "}": "{" });

/** The single characters that are a whole token outside braces: the punctuation and the arithmetic operators. */
const SINGLE_TOKENS: ReadonlySet<string> = new Set([",", ":", "@", "+", "-", "*", "/", "%", "^"]);

/** The comparison characters, which may stand alone or before `=` (and `=` before `~`). */
const COMPARISONS: ReadonlySet<string> = new Set(["=", "<", ">"]);

const QUOTES: ReadonlySet<string> = new Set(['"', "'", "`"]);

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

/** `isAlpha` in lex.go: ASCII letters and the underscore. */
function isAlpha(character: string): boolean {
  return character === "_" || (character >= "a" && character <= "z") || (character >= "A" && character <= "Z");
}

/** What a metric name, a recording rule's name or a keyword continues with: `:` included, as lex.go reads it. */
function continuesIdentifier(character: string): boolean {
  return isAlpha(character) || isDigit(character) || character === ":";
}

/** What a number or a duration continues with: `5m`, `1h30m`, `0x1f`, `1.5`, `1e3`. Its validity is the server's. */
function continuesNumber(character: string): boolean {
  return isAlpha(character) || isDigit(character) || character === ".";
}

class Refusal extends Error {}

const refuse = (reason: string): never => {
  throw new Refusal(reason);
};

/** The index just past the string that opens at `start`, or a refusal when it is not closed. */
function endOfString(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === quote) return index + 1;
    // A raw string holds anything up to its backtick; the other two take escapes and end at a line break.
    if (quote !== "`") {
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === "\n" || character === "\r") break;
    }
    index += 1;
  }
  return refuse(
    `A string is not closed: the ${quote} opened at character ${start + 1} has no closing ${quote} on its line.`,
  );
}

/** The index of the end of the comment that opens at `start`: the next line break, or the end of the text. */
function endOfComment(text: string, start: number): number {
  let index = start;
  while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index += 1;
  return index;
}

function scanWhile(text: string, start: number, accepts: (character: string) => boolean): number {
  let index = start;
  while (index < text.length && accepts(text[index])) index += 1;
  return index;
}

function unknownCharacter(character: string, position: number, insideBraces: boolean): never {
  if (character === "$") {
    return refuse(
      `$ is not PromQL: a dashboard variable such as $__range, $__interval or $__rate_interval is a dashboard's time-range directive, which only a dashboard expands (character ${position + 1}); write the duration itself, such as [5m].`,
    );
  }
  if (insideBraces) {
    return refuse(
      `The character "${character}" cannot stand inside a label matcher's braces (character ${position + 1}): only label names, quoted strings, commas and the matchers =, !=, =~ and !~ can.`,
    );
  }
  return refuse(
    `The character "${character}" is not PromQL (character ${position + 1}), so the text is not one expression: agent mode sends the expression alone, and a request parameter cannot be written beside it.`,
  );
}

/** Reads the whole text, or refuses at the first thing that is not a PromQL token or a bracket out of place. */
function lex(text: string): void {
  const open: Array<{ readonly bracket: string; readonly at: number }> = [];
  let holdsToken = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const insideBraces = open.length > 0 && open[open.length - 1].bracket === "{";
    if (character === " " || character === "\t" || character === "\n" || character === "\r") {
      index += 1;
      continue;
    }
    if (character === "#") {
      index = endOfComment(text, index);
      continue;
    }
    holdsToken = true;
    if (QUOTES.has(character)) {
      index = endOfString(text, index);
    } else if (isAlpha(character)) {
      index = scanWhile(text, index, insideBraces ? (next) => isAlpha(next) || isDigit(next) : continuesIdentifier);
    } else if (character === "!") {
      const next = text[index + 1];
      if (next !== "=" && next !== "~") return refuse(`"!" stands only in "!=" and "!~" (character ${index + 1}).`);
      index += 2;
    } else if (character === "=") {
      index += text[index + 1] === "=" || text[index + 1] === "~" ? 2 : 1;
    } else if (character === ",") {
      index += 1;
    } else if (insideBraces && character !== "}") {
      return unknownCharacter(character, index, true);
    } else if (isDigit(character) || (character === "." && isDigit(text[index + 1] ?? ""))) {
      index = scanWhile(text, index, continuesNumber);
    } else if (COMPARISONS.has(character)) {
      index += text[index + 1] === "=" ? 2 : 1;
    } else if (SINGLE_TOKENS.has(character)) {
      index += 1;
    } else if (Object.hasOwn(CLOSERS, character)) {
      open.push({ bracket: character, at: index });
      index += 1;
    } else if (Object.hasOwn(OPENERS, character)) {
      const last = open.pop();
      if (last === undefined || last.bracket !== OPENERS[character]) {
        return refuse(`"${character}" closes nothing that is open (character ${index + 1}).`);
      }
      index += 1;
    } else {
      return unknownCharacter(character, index, false);
    }
  }
  const unclosed = open.pop();
  if (unclosed !== undefined) {
    refuse(
      `"${unclosed.bracket}" is not closed: the one opened at character ${unclosed.at + 1} has no "${CLOSERS[unclosed.bracket]}".`,
    );
  }
  if (!holdsToken) {
    refuse("The text holds no PromQL expression once its # comments and whitespace are removed.");
  }
}

/**
 * One agent read read to the expression the provider sends, or to why it sends nothing. Never sends anything. The
 * expression is the text exactly as written: the reader judges it and never rewrites it.
 */
export function readPrometheusAgentStatement(text: string): PrometheusAgentReading {
  try {
    lex(text);
    return { ok: true, expression: text };
  } catch (error) {
    // The lexer refuses with a Refusal only; anything else is a defect.
    if (!(error instanceof Refusal)) throw error;
    return { ok: false, code: "statement", message: PROMETHEUS_AGENT_SENTENCES.refusal(error.message) };
  }
}
