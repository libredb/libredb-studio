import type * as Monaco from "monaco-editor";
import { type ShellLineState, shellLineStatesEqual } from "@/lib/db/console/shell-words";
import {
  INITIAL_S3_LEX_STATE,
  type S3TokenRole,
  tokenizeS3Line,
} from "@/lib/db/providers/objectstore/s3/console/lexer";

/**
 * Monaco language for the S3 editor text, one AWS CLI read command or Studio's own preview,
 * in Oxia's shape (`oxia-language.ts`).
 *
 * Not a Monarch grammar: the tokens provider calls the provider's own lexer, `tokenizeS3Line`, one physical line at a
 * time, and the parser reads the text through the same shell-word reader, so a word the editor draws as one word is
 * the word the provider runs. Monaco 0.57.0 registers no language `s3`, which `tests/isolated/monaco-language-ids.test.ts`
 * holds.
 */
export const S3_LANGUAGE_ID = "s3";

/** Each token role as a token type the editor's two themes colour (`monaco-theme.ts`). */
const TOKEN_TYPES: Readonly<Record<S3TokenRole, string>> = {
  // The stripped `$`, `%` and `aws` carry no meaning of their own, so they are drawn as a comment is.
  lead: "comment",
  service: "keyword",
  operation: "keyword",
  flag: "function",
  path: "string",
  word: "identifier",
  string: "string",
  comment: "comment",
  whitespace: "",
  // Text the provider refuses, coloured by the base theme's own rule for it.
  invalid: "invalid",
};

/** The tokens provider's state: the shared reader's own, compared with shellLineStatesEqual. */
export class S3TokensState implements Monaco.languages.IState {
  constructor(readonly lex: ShellLineState) {}

  /** The reader's state is never written to, so a copy shares it. */
  clone(): S3TokensState {
    return new S3TokensState(this.lex);
  }

  equals(other: Monaco.languages.IState): boolean {
    return other instanceof S3TokensState && shellLineStatesEqual(this.lex, other.lex);
  }
}

/** Register the S3 language on a Monaco instance. Idempotent: a no-op once the language is registered. */
export function registerS3Language(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((lang) => lang.id === S3_LANGUAGE_ID)) {
    return;
  }

  monaco.languages.register({ id: S3_LANGUAGE_ID });

  monaco.languages.setTokensProvider(S3_LANGUAGE_ID, {
    getInitialState: () => new S3TokensState(INITIAL_S3_LEX_STATE),
    // Monaco hands back the state this provider returned for the line before.
    tokenize: (line, state) => {
      const reading = tokenizeS3Line(line, (state as S3TokensState).lex);
      return {
        tokens: reading.tokens.map((token) => ({ startIndex: token.start, scopes: TOKEN_TYPES[token.role] })),
        endState: new S3TokensState(reading.state),
      };
    },
  });

  monaco.languages.setLanguageConfiguration(S3_LANGUAGE_ID, {
    comments: { lineComment: "#" },
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });
}
