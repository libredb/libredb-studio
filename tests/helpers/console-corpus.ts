/**
 * What the console grammar makes of a corpus, as data two runtimes can compare (vector-family spec 3.4): each
 * case's verdict and message from the parser, its formatted text, a digest of the tokens the editor's tokens
 * provider draws, and, for a case that names a field where an integer is required, the shared integer reader's
 * verdict. The corpus test computes this under Bun and again in a Node child process from a bundle of this file,
 * and the two must be equal.
 */
import { createHash } from "node:crypto";
import type * as Monaco from "monaco-editor";
import type { ConsoleDialectSpec, RouteSpec } from "@/lib/db/console/dialect";
import { formatConsole } from "@/lib/db/console/format";
import { ConsoleRefusal, parseConsole } from "@/lib/db/console/parser";
import { type TaggedJson, toJsonText } from "@/lib/db/console/tagged-json";
import { vectorNumbers } from "@/lib/db/vector/dense";
import { registerConsoleLanguage } from "@/lib/editor/console-language";

export interface CorpusTable {
  readonly spec: ConsoleDialectSpec;
  readonly routes: readonly RouteSpec[];
}

export interface CorpusCase {
  readonly name: string;
  /** The key of the table, in the tables handed over with the cases, the text is read against. */
  readonly table: string;
  readonly text: string;
  /** False for the bound cases, whose texts are too large to format and draw: only the verdict is kept. */
  readonly full: boolean;
  /** A body key whose value is read as an integer, as a field that requires one reads it. */
  readonly integerAt?: string;
}

export interface CorpusOutcome {
  readonly name: string;
  /** `accepted`, or the refusal's reason. */
  readonly verdict: string;
  readonly message: string | null;
  readonly op: string | null;
  readonly body: string | null;
  /** The formatted text, or `refused:<reason>`. */
  readonly formatted: string | null;
  /** The sha256 of every line's tokens as the tokens provider draws them. */
  readonly tokens: string | null;
  /** The integer reader's sentence for `integerAt`'s value, or `accepted`. */
  readonly integer: string | null;
}

function refusalOrThrow(error: unknown): ConsoleRefusal {
  if (error instanceof ConsoleRefusal) return error;
  throw error;
}

function formatted(spec: ConsoleDialectSpec, text: string): string {
  try {
    return formatConsole(spec, text);
  } catch (error) {
    return `refused:${refusalOrThrow(error).reason}`;
  }
}

/** The tokens the editor draws for the text, one line at a time from the state the line before left. */
function drawnTokens(table: CorpusTable, text: string): string {
  let provider: Monaco.languages.TokensProvider | undefined;
  const monaco = {
    languages: {
      getLanguages: () => [],
      register: () => {},
      setTokensProvider: (_id: string, registered: Monaco.languages.TokensProvider) => {
        provider = registered;
      },
      setLanguageConfiguration: () => {},
      registerCompletionItemProvider: () => {},
      CompletionItemKind: { Value: 13 },
    },
  } as unknown as typeof Monaco;
  registerConsoleLanguage(monaco, table);
  if (provider === undefined) throw new Error("registerConsoleLanguage set no tokens provider");
  const drawing = provider;
  let state = drawing.getInitialState();
  const lines = text.split("\n").map((line) => {
    const result = drawing.tokenize(line, state);
    state = result.endState;
    return result.tokens.map((token) => `${token.startIndex}:${token.scopes}`).join(" ");
  });
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export function corpusOutcomes(
  tables: Readonly<Record<string, CorpusTable>>,
  cases: readonly CorpusCase[],
): CorpusOutcome[] {
  return cases.map((entry) => {
    const table = tables[entry.table];
    if (table === undefined) throw new Error(`${entry.name} names the table ${entry.table}, which was not handed over`);
    let verdict = "accepted";
    let message: string | null = null;
    let op: string | null = null;
    let body: string | null = null;
    let integer: string | null = null;
    try {
      const request = parseConsole(table.spec, table.routes, entry.text);
      op = request.route.op;
      body = toJsonText(request.body);
      if (entry.integerAt !== undefined) {
        const value: TaggedJson = request.body[entry.integerAt] ?? null;
        const read = vectorNumbers({ name: entry.integerAt, kind: "dense", dtype: "int8", dimension: 1 }, [value]);
        integer = Array.isArray(read) ? "accepted" : (read as { sentence: string }).sentence;
      }
    } catch (error) {
      const refusal = refusalOrThrow(error);
      verdict = refusal.reason;
      message = refusal.message;
    }
    return {
      name: entry.name,
      verdict,
      message,
      op,
      body,
      formatted: entry.full ? formatted(table.spec, entry.text) : null,
      tokens: entry.full ? drawnTokens(table, entry.text) : null,
      integer,
    };
  });
}
