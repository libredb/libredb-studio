/**
 * Cypher text, read as statements (spec 3.2).
 *
 * Pure, and shipped to the browser. A statement ends at a `;` the lexer reads as punctuation, so a
 * `;` inside a string, a backtick name or a comment never splits. What a statement carries is what
 * the read policy needs: its significant tokens, the source slice they span, and the prefixes that
 * change how the engine runs it (`CYPHER <version>`, then `EXPLAIN` or `PROFILE`).
 */

import type { CypherToken } from "./lexer";

export interface CypherStatement {
  /** The source slice from the first to the last significant token, so without a trailing `;` or edge comments. */
  readonly text: string;
  /** Significant tokens only: no whitespace, no comment, no separating `;`. */
  readonly tokens: readonly CypherToken[];
  /** The number of a leading `CYPHER <n>` prefix, as written. */
  readonly cypherVersion?: string;
  /** A leading `EXPLAIN`, after any `CYPHER <n>` prefix. */
  readonly explain: boolean;
  /** A leading `PROFILE`, after any `CYPHER <n>` prefix. */
  readonly profile: boolean;
}

const isSignificant = (token: CypherToken): boolean => token.kind !== "whitespace" && token.kind !== "comment";
const isSeparator = (token: CypherToken): boolean => token.kind === "punct" && token.text === ";";

/**
 * One statement from the tokens between two separators, or undefined when none is significant.
 * `CYPHER` followed by anything but a number (an option such as `runtime=slotted`) sets no version,
 * and its words stay in the tokens for the policy to read.
 * `text` joins the run's token texts rather than slicing the source, which is the same string only
 * because `lexCypher` is lossless: every character lands in exactly one token (lexer.test.ts pins it).
 */
function statementOf(run: readonly CypherToken[]): CypherStatement | undefined {
  const tokens = run.filter(isSignificant);
  if (tokens.length === 0) return undefined;
  const first = run.indexOf(tokens[0]);
  const last = run.indexOf(tokens[tokens.length - 1]);
  const text = run
    .slice(first, last + 1)
    .map((token) => token.text)
    .join("");

  let at = 0;
  let cypherVersion: string | undefined;
  if (tokens[0].kind === "word" && tokens[0].value === "CYPHER" && tokens[1]?.kind === "number") {
    cypherVersion = tokens[1].text;
    at = 2;
  }
  const prefix = tokens[at]?.kind === "word" ? tokens[at].value : undefined;
  return {
    text,
    tokens,
    ...(cypherVersion === undefined ? {} : { cypherVersion }),
    explain: prefix === "EXPLAIN",
    profile: prefix === "PROFILE",
  };
}

/** Splits on `;` tokens; drops statements with no significant token. */
export function splitCypherStatements(tokens: readonly CypherToken[]): CypherStatement[] {
  const statements: CypherStatement[] = [];
  let run: CypherToken[] = [];
  const close = (): void => {
    const statement = statementOf(run);
    if (statement !== undefined) statements.push(statement);
    run = [];
  };
  for (const token of tokens) {
    if (isSeparator(token)) close();
    else run.push(token);
  }
  close();
  return statements;
}
