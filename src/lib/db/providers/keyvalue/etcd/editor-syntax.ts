import type * as Monaco from "monaco-editor";
import {
  INITIAL_LEX_STATE,
  type LexState,
  type LexTokenKind,
  lexStatesEqual,
  tokenizeLine,
} from "@/lib/db/providers/keyvalue/etcd/lexer";

/**
 * Monaco language for the etcd editor text, a subset of etcdctl's command line (#1089, section 3.3).
 *
 * Not a Monarch grammar: the tokens provider calls the provider's own lexer, `tokenizeLine`, one
 * physical line at a time, and the parser reads the text through the same lexer, so a word the editor
 * draws as one word is the word the provider runs, holding the same bytes. A Monarch grammar would be a
 * second reading of the quoting rules, and Redis's shows what that costs: it treats `\.` inside a string
 * as an escape where the provider's tokenizer has none, so the editor draws as one word what the provider
 * reads as two (R01 9.5). The state the provider carries from line to line is the lexer's own, which is
 * bounded whatever the text holds.
 */
export const ETCD_LANGUAGE_ID = "etcd";

/** Each lexer token kind as a token type the editor's two themes colour (`monaco-theme.ts`). */
const TOKEN_TYPES: Readonly<Record<LexTokenKind, string>> = {
  word: "identifier",
  // A flag is a command's modifier, coloured as Redis colours its argument keywords.
  flag: "function",
  string: "string",
  comment: "comment",
  operator: "operator",
  whitespace: "",
  // Text the provider refuses, coloured by the base theme's own rule for it.
  invalid: "invalid",
};

/** The tokens provider's state: the lexer's own, compared with lexStatesEqual. */
export class EtcdTokensState implements Monaco.languages.IState {
  constructor(readonly lex: LexState) {}

  /** The lexer's state is never written to, so a copy shares it. */
  clone(): EtcdTokensState {
    return new EtcdTokensState(this.lex);
  }

  equals(other: Monaco.languages.IState): boolean {
    return other instanceof EtcdTokensState && lexStatesEqual(this.lex, other.lex);
  }
}

/**
 * Register the etcd language on a Monaco instance. Idempotent: safe to call on every editor mount, and a
 * no-op once the language is registered.
 */
export function registerEtcdLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((lang) => lang.id === ETCD_LANGUAGE_ID)) {
    return;
  }

  monaco.languages.register({ id: ETCD_LANGUAGE_ID });

  monaco.languages.setTokensProvider(ETCD_LANGUAGE_ID, {
    getInitialState: () => new EtcdTokensState(INITIAL_LEX_STATE),
    // Monaco hands back the state this provider returned for the line before.
    tokenize: (line, state) => {
      const reading = tokenizeLine(line, (state as EtcdTokensState).lex);
      return {
        tokens: reading.tokens.map((token) => ({ startIndex: token.start, scopes: TOKEN_TYPES[token.kind] })),
        endState: new EtcdTokensState(reading.state),
      };
    },
  });

  monaco.languages.setLanguageConfiguration(ETCD_LANGUAGE_ID, {
    comments: { lineComment: "#" },
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "(", close: ")" },
    ],
  });
}
