/**
 * The Cypher read policy (spec 5.2).
 *
 * Pure, and shipped to the browser. It reads tokens, not text: a word inside a string, a comment or
 * a backtick name is never a keyword, and a keyword split by a comment is still one word sequence.
 * It is fail-closed: a bare word that names a denied clause is refused wherever it stands, even where
 * Cypher would read it as a property or a map key, and the refusal tells the user to backtick it.
 *
 * The policy holds no engine's names. Every list it compares against comes from the profile, so an
 * empty deny list refuses nothing and an empty allow list allows nothing; what it refuses on its own
 * is a unicode escape, text that does not lex, an empty text, more than one statement, and parameters.
 * A leading `CYPHER <n>` is refused when the profile's dialect has no version prefix.
 *
 * A unicode escape is refused before the text is lexed, wherever it stands: Neo4j 5.26.31 decodes a
 * backslash-u and four hex digits before it reads the text, in a backtick name, a string and a comment
 * alike, so an escaped backtick, quote or line break ends that construct early on the server while the
 * lexer reads it whole. A backslash-u is an escape when an odd run of backslashes ends at it, as the
 * server reads it; an upper-case U the server keeps as written.
 */

import type { GraphPolicyProfile } from "../profile";
import { CYPHER_KEYWORDS, CypherLexError, type CypherLexErrorReason, type CypherToken, lexCypher } from "./lexer";
import { cypherUnicodeEscapeIn } from "./quote";
import { type CypherStatement, splitCypherStatements } from "./statements";

export type CypherRefusalCode =
  | "unicode-escape"
  | "lex-error"
  | "empty"
  | "multiple-statements"
  | "denied-prefix"
  | "denied-word"
  | "denied-procedure"
  | "denied-namespace"
  | "denied-show"
  | "denied-function"
  | "parameters-unsupported"
  /** Produced only by an engine's statement gate, never by `checkCypherRead`. */
  | "server-classification";

export interface CypherRefusal {
  readonly code: CypherRefusalCode;
  /** The word, procedure, namespace, form or prefix refused. */
  readonly subject: string;
  /** Offset in the original text. */
  readonly position?: number;
  /** The full sentence the user reads. */
  readonly message: string;
}

export type CypherReadVerdict =
  | {
      readonly allowed: true;
      readonly statement: CypherStatement;
      /** `SHOW` is the first token after the prefixes. */
      readonly isShow: boolean;
      /** The statement holds at least one allowlisted `CALL <name>`. */
      readonly callsProcedure: boolean;
    }
  | { readonly allowed: false; readonly refusal: CypherRefusal };

const LEX_REASONS: Record<CypherLexErrorReason, string> = {
  "unterminated-string": "unterminated string",
  "unterminated-comment": "unterminated comment",
  "unterminated-backtick": "unterminated backtick name",
  "invalid-escape": "invalid escape",
  "unexpected-character": "unexpected character",
};

/** The words that end a SHOW form: the clauses that may follow any allowed form. */
const SHOW_CLAUSE_WORDS: ReadonlySet<string> = new Set(["YIELD", "WHERE", "RETURN", "ORDER", "SKIP", "LIMIT"]);

const isWord = (token: CypherToken | undefined, value: string): boolean =>
  token?.kind === "word" && token.value === value;
const isPunct = (token: CypherToken | undefined, text: string): boolean =>
  token?.kind === "punct" && token.text === text;
const isNamePart = (token: CypherToken | undefined): boolean => token?.kind === "word" || token?.kind === "backtick";

interface QualifiedName {
  /** The parts' names joined by dots: a word as typed, a backtick name unquoted. */
  readonly joined: string;
  readonly parts: number;
  /** The index after the last part. */
  readonly end: number;
}

/** The maximal run `part (. part)*` starting at `at`; zero parts when no name starts there. */
function qualifiedNameAt(tokens: readonly CypherToken[], at: number): QualifiedName {
  const names: string[] = [];
  let index = at;
  while (isNamePart(tokens[index])) {
    const token = tokens[index];
    names.push(token.kind === "word" ? token.text : token.value);
    index += 1;
    if (!(isPunct(tokens[index], ".") && isNamePart(tokens[index + 1]))) break;
    index += 1;
  }
  return { joined: names.join("."), parts: names.length, end: index };
}

/** The advice a refusal gives when the word refused may be a name: the backtick form, as typed. */
const nameAdvice = (subject: string, typed: string): string =>
  ` If ${subject} is a name here (a property, a map key or a label), write it in backticks, as \`${typed}\`.`;

/** Checks one text against the profile: one statement, read-only, every name it calls allowed. */
export function checkCypherRead(text: string, profile: GraphPolicyProfile): CypherReadVerdict {
  const engine = profile.engineLabel;
  const policy = profile.readPolicy;
  const refuse = (code: CypherRefusalCode, subject: string, message: string, position?: number): CypherReadVerdict => ({
    allowed: false,
    refusal: { code, subject, message, ...(position === undefined ? {} : { position }) },
  });

  // The pattern lives with the quoting, so a name `quoteCypherName` accepts never holds an escape refused here.
  const escape = cypherUnicodeEscapeIn(text);
  if (escape !== undefined) {
    const { position, escape: subject } = escape;
    return refuse(
      "unicode-escape",
      subject,
      `The statement holds the escape ${subject}, which the server decodes before it reads the text, so it could end a name, a string or a comment early and the server would run a statement other than the one checked. It was not run: type the character itself.`,
      position,
    );
  }

  let lexed: CypherToken[];
  try {
    lexed = lexCypher(text);
  } catch (error) {
    if (!(error instanceof CypherLexError)) throw error;
    return refuse(
      "lex-error",
      error.reason,
      `The statement could not be read: ${LEX_REASONS[error.reason]} at character ${error.position + 1}.`,
      error.position,
    );
  }

  const statements = splitCypherStatements(lexed);
  if (statements.length === 0) return refuse("empty", "", "There is no statement to run.");
  if (statements.length > 1) {
    return refuse(
      "multiple-statements",
      String(statements.length),
      `${engine} runs one statement at a time, and this text holds ${statements.length}. Run them one by one.`,
      statements[1].tokens[0].start,
    );
  }

  const statement = statements[0];
  const tokens = statement.tokens;
  if (statement.cypherVersion !== undefined && !profile.dialect.supportsVersionPrefix) {
    const prefix = `CYPHER ${statement.cypherVersion}`;
    return refuse(
      "denied-prefix",
      prefix,
      `${prefix} is not supported on ${engine} connections in this version.`,
      tokens[0].start,
    );
  }
  let start = statement.cypherVersion === undefined ? 0 : 2;
  for (const prefix of ["EXPLAIN", "PROFILE"] as const) {
    if (!(prefix === "EXPLAIN" ? statement.explain : statement.profile)) continue;
    if (policy.refusedPrefixes.includes(prefix)) {
      return refuse(
        "denied-prefix",
        prefix,
        `${prefix} is not supported on ${engine} connections in this version.`,
        tokens[start].start,
      );
    }
    start += 1;
  }

  // Every qualified name is checked, called or not, so `apoc`.name, a property of a variable named apoc, is
  // refused too: fail closed, since telling a property path from a call to a namespaced name is the parser's work.
  const refuseNamespace = (name: QualifiedName, position: number): CypherReadVerdict | undefined => {
    const lower = name.joined.toLowerCase();
    const namespace = policy.deniedNamespaces.find((prefix) => lower.startsWith(prefix));
    if (namespace === undefined) return undefined;
    return refuse(
      "denied-namespace",
      namespace,
      `${namespace}* is not allowed on ${engine} connections in this version, because its procedures and functions can reach the network or the file system. A name starting ${namespace} is refused in any position, called or not, so a variable named ${namespace.replace(/\.$/, "")} must be renamed.`,
      position,
    );
  };

  let isShow = false;
  let callsProcedure = false;
  /** The index after the last qualified name already checked, so a run is checked once, from its start. */
  let checkedUntil = start;
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];

    if (token.kind === "parameter") {
      return refuse(
        "parameters-unsupported",
        token.text,
        `Parameters such as ${token.text} are not supported on ${engine} connections in this version: write the value into the statement.`,
        token.start,
      );
    }

    // After a dot, CALL and SHOW are property keys; before a colon, map keys. Neither starts a clause.
    const isClausePosition = !isPunct(tokens[index - 1], ".") && !isPunct(tokens[index + 1], ":");

    if (isClausePosition && isWord(token, "CALL")) {
      const next = tokens[index + 1];
      if (isPunct(next, "{") || isPunct(next, "(")) {
        // A subquery `CALL { ... }` or a scoped one `CALL (vars) { ... }`: the scope holds only variables
        // or `*`, so the scope and the body are walked by the same rules as the rest of the statement.
        index += 1;
        continue;
      }
      const name = qualifiedNameAt(tokens, index + 1);
      const allowed = policy.allowedProcedures.join(", ");
      if (next === undefined || name.parts === 0 || (next.kind === "word" && CYPHER_KEYWORDS.has(next.value))) {
        // No name follows, as in `MATCH (n:CALL)`, or a keyword does, as in `WITH 1 AS call RETURN call`: the
        // word is a name there, not a call.
        return refuse(
          "denied-procedure",
          "CALL",
          `CALL is not allowed here: a read-only ${engine} connection can call only ${allowed}.${nameAdvice("CALL", token.text)}`,
          token.start,
        );
      }
      const position = next.start;
      const denied = refuseNamespace(name, position);
      if (denied !== undefined) return denied;
      if (!policy.allowedProcedures.includes(name.joined)) {
        return refuse(
          "denied-procedure",
          name.joined,
          `CALL ${name.joined} is not allowed: a read-only ${engine} connection can call only ${allowed}.`,
          position,
        );
      }
      callsProcedure = true;
      index = name.end;
      checkedUntil = name.end;
      continue;
    }

    if (isClausePosition && isWord(token, "SHOW")) {
      const form: string[] = [];
      const typed: string[] = [];
      for (let at = index + 1; at < tokens.length; at += 1) {
        const part = tokens[at];
        if (part.kind === "word" && SHOW_CLAUSE_WORDS.has(part.value)) break;
        form.push(
          part.kind === "word" ? part.value : part.kind === "backtick" || part.kind === "string" ? "*" : part.text,
        );
        // The subject names what was typed as words, names and strings, never the punctuation after a SHOW name.
        if (part.kind === "word" || part.kind === "backtick" || part.kind === "string") {
          typed.push(part.kind === "word" ? part.value : part.text);
        }
      }
      const matches = policy.allowedShowForms.some(
        (allowed) => allowed.length === form.length && allowed.every((word, at) => word === "*" || word === form[at]),
      );
      if (!matches) {
        const subject = ["SHOW", ...typed].join(" ");
        // No word follows, as in `MATCH (n:SHOW)` or `MATCH (show)`: the word may be a name.
        const after = tokens[index + 1];
        const advice =
          after?.kind !== "word" || SHOW_CLAUSE_WORDS.has(after.value) ? nameAdvice("SHOW", token.text) : "";
        return refuse(
          "denied-show",
          subject,
          `${subject} is not allowed on a read-only ${engine} connection.${advice}`,
          token.start,
        );
      }
      if (index === start) isShow = true;
    }

    if (index >= checkedUntil && isNamePart(token)) {
      const name = qualifiedNameAt(tokens, index);
      checkedUntil = name.end;
      // One backticked part holding dots and called, such as `apoc.text.join`(...), may resolve to the
      // namespaced function, so it is read as a qualified name: fail closed.
      const calledDotted = token.kind === "backtick" && token.value.includes(".") && isPunct(tokens[name.end], "(");
      if (name.parts > 1 || calledDotted) {
        const denied = refuseNamespace(name, token.start);
        if (denied !== undefined) return denied;
        const lower = name.joined.toLowerCase();
        if (isPunct(tokens[name.end], "(") && !policy.allowedQualifiedFunctions.includes(lower)) {
          return refuse(
            "denied-function",
            name.joined,
            `${name.joined}() is not allowed: a read-only ${engine} connection calls only built-in functions.`,
            token.start,
          );
        }
      }
    }

    if (token.kind === "word") {
      const sequence = policy.deniedWords.find((words) =>
        words.every((word, at) => tokens[index + at]?.kind === "word" && tokens[index + at].value === word),
      );
      if (sequence !== undefined) {
        const subject = sequence.join(" ");
        const typed = tokens
          .slice(index, index + sequence.length)
          .map((word) => word.text)
          .join(" ");
        return refuse(
          "denied-word",
          subject,
          `${subject} is not allowed: ${engine} connections are read-only in this version.${nameAdvice(subject, typed)}`,
          token.start,
        );
      }
    }

    index += 1;
  }

  return { allowed: true, statement, isShow, callsProcedure };
}
