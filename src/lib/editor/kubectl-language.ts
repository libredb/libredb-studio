import type * as Monaco from "monaco-editor";
import { type ShellLineState, shellLineStatesEqual } from "@/lib/db/console/shell-words";
import {
  INITIAL_KUBECTL_LEX_STATE,
  type KubectlTokenRole,
  tokenizeKubectlLine,
} from "@/lib/db/providers/platform/kubernetes/console/lexer";

/**
 * Monaco language for the Kubernetes console text, one kubectl read command, in Oxia's shape (`oxia-language.ts`).
 *
 * Not a Monarch grammar: the tokens provider calls the console's own lexer, `tokenizeKubectlLine`, one physical line
 * at a time, and the parser reads the text through the same shell-word reader, so a word the editor draws as one word
 * is the word the provider runs. The state carried from line to line is the shared reader's own, five small values
 * whatever the text holds. No completion provider: v1 draws the text and completes nothing.
 */
export const KUBECTL_LANGUAGE_ID = "kubectl";

/** Each token role as a token type the editor's two themes colour (`monaco-theme.ts`). */
const TOKEN_TYPES: Readonly<Record<KubectlTokenRole, string>> = {
  // The stripped prompt and `kubectl` carry no meaning of their own, so they are drawn as a comment is.
  lead: "comment",
  verb: "keyword",
  // A flag is a command's modifier, coloured as etcd and Oxia colour their flags.
  flag: "function",
  word: "identifier",
  string: "string",
  comment: "comment",
  whitespace: "",
  // Text the provider refuses, coloured by the base theme's own rule for it.
  invalid: "invalid",
};

/** The tokens provider's state: the shared reader's own, compared with shellLineStatesEqual. */
export class KubectlTokensState implements Monaco.languages.IState {
  constructor(readonly lex: ShellLineState) {}

  /** The reader's state is never written to, so a copy shares it. */
  clone(): KubectlTokensState {
    return new KubectlTokensState(this.lex);
  }

  equals(other: Monaco.languages.IState): boolean {
    return other instanceof KubectlTokensState && shellLineStatesEqual(this.lex, other.lex);
  }
}

/**
 * Register the kubectl language on a Monaco instance. Idempotent: safe to call on every editor mount, and a no-op once
 * the language is registered.
 */
export function registerKubectlLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((lang) => lang.id === KUBECTL_LANGUAGE_ID)) {
    return;
  }

  monaco.languages.register({ id: KUBECTL_LANGUAGE_ID });

  monaco.languages.setTokensProvider(KUBECTL_LANGUAGE_ID, {
    getInitialState: () => new KubectlTokensState(INITIAL_KUBECTL_LEX_STATE),
    // Monaco hands back the state this provider returned for the line before.
    tokenize: (line, state) => {
      const reading = tokenizeKubectlLine(line, (state as KubectlTokensState).lex);
      return {
        tokens: reading.tokens.map((token) => ({ startIndex: token.start, scopes: TOKEN_TYPES[token.role] })),
        endState: new KubectlTokensState(reading.state),
      };
    },
  });

  monaco.languages.setLanguageConfiguration(KUBECTL_LANGUAGE_ID, {
    comments: { lineComment: "#" },
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });
}
