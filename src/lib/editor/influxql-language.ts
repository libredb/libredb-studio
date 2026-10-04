import type * as Monaco from "monaco-editor";
import {
  INITIAL_INFLUXQL_LINE_STATE,
  type InfluxqlLineState,
  type InfluxqlTokenKind,
  tokenizeInfluxqlLine,
} from "@/lib/db/providers/timeseries/influxdb/influxql-lexer";

/**
 * Monaco language for InfluxQL, the editor text of an InfluxDB (InfluxQL) connection (InfluxDB spec 6.7, I12).
 *
 * Not a Monarch grammar, for the reason `etcd-language.ts` gives: the tokens provider calls the provider's own
 * browser-safe lexer, `tokenizeInfluxqlLine`, one physical line at a time, and the read policy reads the text
 * through the same lexer, so what the editor colours as a comment or a regex is what the policy skips. The
 * state carried from line to line is the lexer's own `InfluxqlLineState`: whether a block comment is open, and
 * the class of the last significant token, which decides whether a `/` on a later line divides or opens a regex.
 *
 * The id `influxql` is not one Monaco 0.57.0 ships (`tests/isolated/monaco-language-ids.test.ts`), so the early
 * return below never leaves Monaco's own tokenizer in charge.
 */
export const INFLUXQL_LANGUAGE_ID = "influxql";

/**
 * Each lexer token kind as a token type the editor's two themes colour (`monaco-theme.ts`). A bound parameter
 * is drawn as `invalid`, the type of a lexical fault, because the read policy refuses it as it refuses one.
 */
const TOKEN_TYPES: Readonly<Record<InfluxqlTokenKind, string>> = {
  whitespace: "",
  "line-comment": "comment",
  "block-comment": "comment",
  string: "string",
  "quoted-identifier": "identifier",
  identifier: "identifier",
  keyword: "keyword",
  number: "number",
  duration: "number",
  "bound-parameter": "invalid",
  regex: "regexp",
  operator: "operator",
  punctuation: "delimiter",
  semicolon: "delimiter",
  invalid: "invalid",
};

/** The tokens provider's state: the lexer's own, compared field by field. */
export class InfluxqlTokensState implements Monaco.languages.IState {
  constructor(readonly lex: InfluxqlLineState) {}

  /** The lexer's state is never written to, so a copy shares it. */
  clone(): InfluxqlTokensState {
    return new InfluxqlTokensState(this.lex);
  }

  equals(other: Monaco.languages.IState): boolean {
    return (
      other instanceof InfluxqlTokensState &&
      other.lex.inBlockComment === this.lex.inBlockComment &&
      other.lex.previous === this.lex.previous
    );
  }
}

/**
 * Register the InfluxQL language on a Monaco instance. Idempotent: safe to call on every editor mount, and a
 * no-op once the language is registered.
 */
export function registerInfluxqlLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((lang) => lang.id === INFLUXQL_LANGUAGE_ID)) {
    return;
  }

  monaco.languages.register({ id: INFLUXQL_LANGUAGE_ID });

  monaco.languages.setTokensProvider(INFLUXQL_LANGUAGE_ID, {
    getInitialState: () => new InfluxqlTokensState(INITIAL_INFLUXQL_LINE_STATE),
    // Monaco hands back the state this provider returned for the line before.
    tokenize: (line, state) => {
      const reading = tokenizeInfluxqlLine(line, (state as InfluxqlTokensState).lex);
      return {
        tokens: reading.tokens.map((token) => ({ startIndex: token.start, scopes: TOKEN_TYPES[token.kind] })),
        endState: new InfluxqlTokensState(reading.state),
      };
    },
  });

  monaco.languages.setLanguageConfiguration(INFLUXQL_LANGUAGE_ID, {
    comments: { lineComment: "--", blockComment: ["/*", "*/"] },
    brackets: [["(", ")"]],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "'", close: "'", notIn: ["string", "comment"] },
      { open: '"', close: '"', notIn: ["string", "comment"] },
    ],
  });
}
