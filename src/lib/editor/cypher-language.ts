import type * as Monaco from "monaco-editor";
import {
  CYPHER_INITIAL_STATE,
  CYPHER_KEYWORDS,
  type CypherLineState,
  type CypherToken,
  tokenizeCypherLine,
} from "@/lib/db/graph/cypher/lexer";

/**
 * Monaco language for Cypher, the editor text of a graph connection (Neo4j spec 6.5).
 *
 * Not a Monarch grammar, for the reason `etcd-language.ts` gives: the tokens provider calls the graph
 * layer's own lexer, `tokenizeCypherLine`, one physical line at a time, and the read policy reads the
 * text through the same lexer, so a word the editor draws as a word is the word the policy judges (N9).
 * The state carried from line to line is the lexer's own `CypherLineState`, which is bounded.
 *
 * The id is `graph-cypher` and never `cypher`: Monaco's basic contribution registers a `cypher`
 * language of its own at load time, and `registerCypherLanguage` returns early on an id that already
 * exists, so registering under that id would leave Monaco's tokenizer in charge and nothing on screen
 * would say so (`tests/isolated/monaco-language-ids.test.ts`).
 */
export const CYPHER_LANGUAGE_ID = "graph-cypher";

/** Punctuation that separates rather than operates, drawn as a delimiter; every other mark is an operator. */
const DELIMITERS: ReadonlySet<string> = new Set(["(", ")", "[", "]", "{", "}", ",", ".", ":", ";"]);

/** Each lexer token as a token type the editor's two themes colour (`monaco-theme.ts`). */
function tokenType(token: CypherToken): string {
  switch (token.kind) {
    case "word":
      // A word's value is uppercased by the lexer, so `match` is the keyword `MATCH`.
      return CYPHER_KEYWORDS.has(token.value) ? "keyword" : "identifier";
    case "backtick":
      return "identifier.quoted";
    case "parameter":
      return "variable";
    case "punct":
      return DELIMITERS.has(token.text) ? "delimiter" : "operator";
    case "whitespace":
      return "";
    default:
      // string, number and comment are drawn in the token type of their own name.
      return token.kind;
  }
}

/** The tokens provider's state: the lexer's own, compared field by field. */
export class CypherTokensState implements Monaco.languages.IState {
  constructor(readonly lex: CypherLineState) {}

  /** The lexer's state is never written to, so a copy shares it. */
  clone(): CypherTokensState {
    return new CypherTokensState(this.lex);
  }

  equals(other: Monaco.languages.IState): boolean {
    if (!(other instanceof CypherTokensState) || other.lex.in !== this.lex.in) return false;
    return this.lex.in !== "string" || (other.lex as typeof this.lex).quote === this.lex.quote;
  }
}

/**
 * Register the Cypher language on a Monaco instance. Idempotent: safe to call on every editor mount,
 * and a no-op once the language is registered.
 */
export function registerCypherLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((lang) => lang.id === CYPHER_LANGUAGE_ID)) {
    return;
  }

  monaco.languages.register({ id: CYPHER_LANGUAGE_ID });

  monaco.languages.setTokensProvider(CYPHER_LANGUAGE_ID, {
    getInitialState: () => new CypherTokensState(CYPHER_INITIAL_STATE),
    // Monaco hands back the state this provider returned for the line before.
    tokenize: (line, state) => {
      const reading = tokenizeCypherLine(line, (state as CypherTokensState).lex);
      return {
        tokens: reading.tokens.map((token) => ({ startIndex: token.start, scopes: tokenType(token) })),
        endState: new CypherTokensState(reading.state),
      };
    },
  });

  monaco.languages.setLanguageConfiguration(CYPHER_LANGUAGE_ID, {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: "{", close: "}" },
      { open: "'", close: "'", notIn: ["string", "comment"] },
      { open: '"', close: '"', notIn: ["string", "comment"] },
      { open: "`", close: "`", notIn: ["string", "comment"] },
    ],
  });
}
