/**
 * What the console grammar makes of a corpus, as data two runtimes can compare (vector-family spec 3.4): each
 * case's verdict and message from the parser, its formatted text, a digest of the tokens the editor's tokens
 * provider draws, and, for a case that names a place where an integer is required, the verdict of an integer rule
 * composed from the shared tag check and range check. The corpus test computes this under Bun and again in a Node child process from a bundle of this file,
 * and the two must be equal.
 */
import { createHash } from "node:crypto";
import type * as Monaco from "monaco-editor";
import type { ConsoleDialectSpec, RouteSpec } from "@/lib/db/console/dialect";
import { formatConsole } from "@/lib/db/console/format";
import { ConsoleRefusal, parseConsole } from "@/lib/db/console/parser";
import { checkIntRange, type IntRange, isTaggedInt, type TaggedJson, toJsonText } from "@/lib/db/console/tagged-json";
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
  /** A place in the body whose value is read as an integer, as a field that requires one reads it. */
  readonly integerAt?: IntegerPlace;
}

/** Where an integer is required: the path to the value from the body, the name a refusal gives it, and its range. */
export interface IntegerPlace {
  readonly path: readonly (string | number)[];
  readonly field: string;
  readonly range: IntRange;
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
  /** The integer rule's sentence for the value at `integerAt`, or `accepted`. */
  readonly integer: string | null;
}

function kindOf(value: TaggedJson | undefined): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/**
 * What a field that requires an integer makes of a parsed value: a stand-in for the integer rule each provider's
 * request rules write, composed from the two shared pieces such a rule reads, `isTaggedInt` and `checkIntRange`.
 * Only a literal the lexer read as an integer is one; an object shaped like a tag is an object.
 */
function integerVerdict(body: TaggedJson, place: IntegerPlace): string {
  let value: TaggedJson | undefined = body;
  for (const step of place.path) {
    value = (value as Readonly<Record<string | number, TaggedJson>> | undefined)?.[step];
  }
  if (value === undefined || !isTaggedInt(value)) return `${place.field} must be an integer, found ${kindOf(value)}.`;
  if (!checkIntRange(value, place.range)) return `${place.field} is ${value.digits}, outside the ${place.range} range.`;
  return "accepted";
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
      if (entry.integerAt !== undefined) integer = integerVerdict(request.body, entry.integerAt);
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
