import type * as Monaco from "monaco-editor";
import { type ShellLineState, shellLineStatesEqual } from "@/lib/db/console/shell-words";
import { INITIAL_OXIA_LEX_STATE, type OxiaTokenRole, tokenizeOxiaLine } from "@/lib/db/providers/keyvalue/oxia/lexer";

/**
 * Monaco language for the Oxia editor text, one `oxia client` read command (SB2-4.6), in etcd's shape
 * (`etcd-language.ts`).
 *
 * Not a Monarch grammar: the tokens provider calls the provider's own lexer, `tokenizeOxiaLine`, one physical line at
 * a time, and the parser reads the text through the same shell-word reader, so a word the editor draws as one word
 * is the word the provider runs. The state carried from line to line is the shared reader's own, five small values
 * whatever the text holds.
 */
export const OXIA_LANGUAGE_ID = "oxia";

/** Each token role as a token type the editor's two themes colour (`monaco-theme.ts`). */
const TOKEN_TYPES: Readonly<Record<OxiaTokenRole, string>> = {
  // The stripped `$`, `oxia` and `client` carry no meaning of their own, so they are drawn as a comment is.
  lead: "comment",
  verb: "keyword",
  // A flag is a command's modifier, coloured as etcd colours its flags.
  flag: "function",
  word: "identifier",
  string: "string",
  comment: "comment",
  whitespace: "",
  // Text the provider refuses, coloured by the base theme's own rule for it.
  invalid: "invalid",
};

/** The tokens provider's state: the shared reader's own, compared with shellLineStatesEqual. */
export class OxiaTokensState implements Monaco.languages.IState {
  constructor(readonly lex: ShellLineState) {}

  /** The reader's state is never written to, so a copy shares it. */
  clone(): OxiaTokensState {
    return new OxiaTokensState(this.lex);
  }

  equals(other: Monaco.languages.IState): boolean {
    return other instanceof OxiaTokensState && shellLineStatesEqual(this.lex, other.lex);
  }
}

/**
 * Register the Oxia language on a Monaco instance. Idempotent: safe to call on every editor mount, and a no-op once
 * the language is registered.
 */
export function registerOxiaLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((lang) => lang.id === OXIA_LANGUAGE_ID)) {
    return;
  }

  monaco.languages.register({ id: OXIA_LANGUAGE_ID });

  monaco.languages.setTokensProvider(OXIA_LANGUAGE_ID, {
    getInitialState: () => new OxiaTokensState(INITIAL_OXIA_LEX_STATE),
    // Monaco hands back the state this provider returned for the line before.
    tokenize: (line, state) => {
      const reading = tokenizeOxiaLine(line, (state as OxiaTokensState).lex);
      return {
        tokens: reading.tokens.map((token) => ({ startIndex: token.start, scopes: TOKEN_TYPES[token.role] })),
        endState: new OxiaTokensState(reading.state),
      };
    },
  });

  monaco.languages.setLanguageConfiguration(OXIA_LANGUAGE_ID, {
    comments: { lineComment: "#" },
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });
}
