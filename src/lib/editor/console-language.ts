import type * as Monaco from "monaco-editor";
import { routeCompletions } from "@/lib/db/console/completion";
import type { ConsoleDialectSpec, RouteSpec } from "@/lib/db/console/dialect";
import {
  type ConsoleLineState,
  type ConsoleTokenKind,
  consoleLineStatesEqual,
  INITIAL_CONSOLE_STATE,
  tokenizeLine,
} from "@/lib/db/console/lexer";

/**
 * One Monaco registration for every console dialect (vector-family spec 3.5).
 *
 * Not a Monarch grammar: the tokens provider calls the console's own lexer, `tokenizeLine`, one physical line at a
 * time, with its bounded line state, so the editor draws exactly the tokens the parser reads (the etcd shape,
 * `etcd-language.ts`). The route completion provider is registered for the dialect's id alone, so no other
 * language's model ever offers a route. A dialect arrives as data, through the `console` field of its
 * `DIALECT_EDITORS` record, and nothing here names one.
 */
export interface ConsoleLanguage {
  readonly spec: ConsoleDialectSpec;
  readonly routes: readonly RouteSpec[];
}

/** Each token kind as a token type the editor's two themes colour (`monaco-theme.ts`). */
const TOKEN_TYPES: Readonly<Record<ConsoleTokenKind, string>> = {
  comment: "comment",
  method: "keyword",
  path: "function",
  "path-param": "identifier",
  query: "identifier",
  key: "identifier",
  string: "string",
  number: "number",
  keyword: "keyword",
  punctuation: "operator",
  whitespace: "",
  invalid: "invalid",
};

/** The tokens provider's state: the lexer's own, compared with `consoleLineStatesEqual`. */
export class ConsoleTokensState implements Monaco.languages.IState {
  constructor(readonly line: ConsoleLineState) {}

  /** The lexer's state is never written to, so a copy shares it. */
  clone(): ConsoleTokensState {
    return new ConsoleTokensState(this.line);
  }

  equals(other: Monaco.languages.IState): boolean {
    return other instanceof ConsoleTokensState && consoleLineStatesEqual(this.line, other.line);
  }
}

/** The method a request line names before the cursor, when the cursor sits in its route; undefined otherwise. */
function methodBeforeRoute(spec: ConsoleDialectSpec, model: Monaco.editor.ITextModel, position: Monaco.Position) {
  for (let line = 1; line < position.lineNumber; line++) {
    const text = model.getLineContent(line).trim();
    if (text !== "" && !spec.commentMarkers.some((marker) => text.startsWith(marker))) return undefined;
  }
  const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
  const match = /^\s*(\S+)\s+(\S*)$/.exec(before);
  if (match === null || !spec.methods.includes(match[1])) return undefined;
  return { method: match[1], startColumn: position.column - match[2].length };
}

/**
 * Register a console language on a Monaco instance: its id, a tokens provider over the console lexer, a language
 * configuration (brackets and the dialect's comment markers), and a route completion provider for that id alone.
 * Idempotent: a no-op once the id is registered, so a second editor mount adds no second provider.
 */
export function registerConsoleLanguage(monaco: typeof Monaco, language: ConsoleLanguage): void {
  const { spec, routes } = language;
  if (monaco.languages.getLanguages().some((registered) => registered.id === spec.id)) return;

  monaco.languages.register({ id: spec.id });

  monaco.languages.setTokensProvider(spec.id, {
    getInitialState: () => new ConsoleTokensState(INITIAL_CONSOLE_STATE),
    // Monaco hands back the state this provider returned for the line before.
    tokenize: (line, state) => {
      const reading = tokenizeLine(spec, line, (state as ConsoleTokensState).line);
      return {
        tokens: reading.tokens.map((token) => ({ startIndex: token.start, scopes: TOKEN_TYPES[token.kind] })),
        endState: new ConsoleTokensState(reading.state),
      };
    },
  });

  const lineComment = spec.commentMarkers[0];
  monaco.languages.setLanguageConfiguration(spec.id, {
    ...(lineComment === undefined ? {} : { comments: { lineComment } }),
    brackets: [
      ["{", "}"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.registerCompletionItemProvider(spec.id, {
    triggerCharacters: [" "],
    provideCompletionItems: (model, position) => {
      const place = methodBeforeRoute(spec, model, position);
      if (place === undefined) return { suggestions: [] };
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: place.startColumn,
        endColumn: position.column,
      };
      return {
        suggestions: routeCompletions(spec, routes, place.method).map((completion) => ({
          label: completion.label,
          kind: monaco.languages.CompletionItemKind.Value,
          insertText: completion.insertText,
          range,
        })),
      };
    },
  });
}
