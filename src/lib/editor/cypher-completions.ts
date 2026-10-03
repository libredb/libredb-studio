/**
 * Cypher completion for the `graph-cypher` editor language (Neo4j spec 6.5, SR6).
 *
 * Pure utility module (no React). The position a suggestion is for is read through the graph layer's
 * own lexer, so a colon inside a string or a comment opens nothing, and the names offered come from the
 * schema objects the editor already holds, each read through `parseGraphObjectSegment` of its path: a
 * label and a relationship type of one name are told apart by their kind, never by a lowercased table
 * name as the SQL completion cache keeps them.
 *
 * What is offered where:
 * - after `:` (or `|`) inside a node pattern, or in a label predicate outside any pattern: node labels;
 * - after `:` (or `|`) inside a relationship pattern: relationship types;
 * - after an identifier and `.`: the property names of every label and relationship type;
 * - after `CALL`: the profile's allowed procedures, the only ones the read policy lets through;
 * - after `SHOW`: the profile's allowed forms that begin with the words typed so far, each inserting only
 *   the words still to come, so the replaced text never holds a space or a newline for Monaco to filter on;
 * - elsewhere: the lexer's keyword table.
 *
 * The profile is handed in by the caller (`graphPolicyProfileOf` in `src/lib/db/graph-policy-profiles.ts`),
 * so this module imports no provider. Without one, `CALL` and `SHOW` offer nothing rather than a guess.
 */
import type * as Monaco from "monaco-editor";
import {
  CYPHER_INITIAL_STATE,
  CYPHER_KEYWORDS,
  type CypherToken,
  tokenizeCypherLine,
} from "@/lib/db/graph/cypher/lexer";
import { CypherNameError, quoteCypherName } from "@/lib/db/graph/cypher/quote";
import { parseGraphObjectSegment } from "@/lib/db/graph/objects";
import type { GraphPolicyProfile } from "@/lib/db/graph/profile";
import { CYPHER_LANGUAGE_ID } from "./cypher-language";

/** The names Cypher completion offers, each list sorted. */
export interface CypherCompletionSchema {
  readonly labels: readonly string[];
  readonly relationshipTypes: readonly string[];
  readonly properties: readonly string[];
}

/** A schema object as the editor's `schemaContext` carries it: only its path and its column names are read. */
export interface CypherSchemaObject {
  readonly path?: readonly string[];
  readonly columns?: readonly { readonly name: string }[];
}

/**
 * The completion names of a schema: labels and relationship types from the kind-qualified last segment of
 * each path, properties from the columns of those two kinds. Indexes, constraints and any path no graph
 * kind produced contribute nothing.
 */
export function cypherCompletionSchemaOf(objects: readonly CypherSchemaObject[]): CypherCompletionSchema {
  const labels = new Set<string>();
  const relationshipTypes = new Set<string>();
  const properties = new Set<string>();
  for (const object of objects) {
    const segment = object.path?.[object.path.length - 1];
    const parsed = segment === undefined ? undefined : parseGraphObjectSegment(segment);
    if (parsed?.kind === "label") labels.add(parsed.name);
    else if (parsed?.kind === "relationship_type") relationshipTypes.add(parsed.name);
    else continue;
    for (const column of object.columns ?? []) properties.add(column.name);
  }
  return {
    labels: [...labels].sort((a, b) => a.localeCompare(b, "en")),
    relationshipTypes: [...relationshipTypes].sort((a, b) => a.localeCompare(b, "en")),
    properties: [...properties].sort((a, b) => a.localeCompare(b, "en")),
  };
}

export type CypherCompletionKind = "label" | "relationship-type" | "property" | "procedure" | "show" | "keyword";

/** What to offer at the end of `text`, and the offset in `text` where the replaced text begins. */
export interface CypherCompletionContext {
  readonly kind: CypherCompletionKind;
  readonly start: number;
  /** For `show` only: the complete words already typed after `SHOW`, uppercased. */
  readonly showWords?: readonly string[];
}

/** The innermost bracket still open among `tokens`, or undefined when none is. */
function openBracket(tokens: readonly CypherToken[]): string | undefined {
  const stack: string[] = [];
  for (const token of tokens) {
    if (token.kind !== "punct") continue;
    if (token.text === "(" || token.text === "[" || token.text === "{") stack.push(token.text);
    else if (token.text === ")" || token.text === "]" || token.text === "}") stack.pop();
  }
  return stack[stack.length - 1];
}

/** Whether `words` begins at least one of the forms. */
function beginsAForm(words: readonly string[], forms: readonly (readonly string[])[]): boolean {
  return forms.some((form) => words.every((word, index) => form[index] === word));
}

/**
 * The completion context at the end of `text`, the editor's text up to the cursor; undefined inside a
 * string, a comment or an open backtick name, where nothing is offered. `showForms` are the profile's
 * allowed SHOW forms, which decide how far after `SHOW` its context runs.
 */
export function cypherCompletionContext(
  text: string,
  showForms: readonly (readonly string[])[],
): CypherCompletionContext | undefined {
  const tokens: CypherToken[] = [];
  let state = CYPHER_INITIAL_STATE;
  let offset = 0;
  for (const line of text.split("\n")) {
    const reading = tokenizeCypherLine(line, state, offset);
    tokens.push(...reading.tokens);
    state = reading.state;
    offset += line.length + 1;
  }
  const last = tokens[tokens.length - 1];
  if (state.in !== "code" || last?.kind === "comment") return undefined;

  const significant = tokens.filter((token) => token.kind !== "whitespace" && token.kind !== "comment");
  // The word being typed, when the cursor touches one; the context is read from what precedes it.
  const typing = last?.kind === "word" ? last : undefined;
  const end = significant.length - (typing === undefined ? 0 : 1);
  const start = typing?.start ?? text.length;
  const before = significant[end - 1];

  // CALL, then a dotted name begun: the whole name is replaced by the procedure chosen.
  let name = end;
  while (name >= 2 && significant[name - 1].text === "." && significant[name - 2].kind === "word") name -= 2;
  if (significant[name - 1]?.kind === "word" && significant[name - 1].value === "CALL") {
    return { kind: "procedure", start: name < end ? significant[name].start : start };
  }

  // SHOW, then nothing or words that begin an allowed form: only the word being typed is replaced, and the
  // words before it are handed on, so an item inserts the rest of its form.
  let form = end;
  while (form >= 1 && significant[form - 1].kind === "word" && significant[form - 1].value !== "SHOW") form -= 1;
  if (significant[form - 1]?.value === "SHOW") {
    const showWords = significant.slice(form, end).map((token) => token.value);
    if (showWords.length === 0 || beginsAForm(showWords, showForms)) return { kind: "show", start, showWords };
  }

  if (before?.text === ":" || before?.text === "|") {
    const bracket = openBracket(significant.slice(0, end));
    if (bracket === "[") return { kind: "relationship-type", start };
    if (bracket === "(" || (bracket === undefined && before.text === ":")) return { kind: "label", start };
  }

  const owner = significant[end - 2];
  if (before?.text === "." && (owner?.kind === "word" || owner?.kind === "backtick"))
    return { kind: "property", start };

  return { kind: "keyword", start };
}

const BARE_NAME = /^[\p{L}_][\p{L}\p{Nd}_]*$/u;

/**
 * A name as it is inserted: bare where it reads back as itself and as no word the lexer or the read
 * policy treats specially, backticked otherwise (so `n.set`, which the policy refuses, is completed as
 * ``n.`set` ``). A name `quoteCypherName` refuses cannot be written safely and is not offered.
 */
function insertName(name: string, reserved: ReadonlySet<string>): string | undefined {
  if (BARE_NAME.test(name) && !reserved.has(name.toUpperCase())) return name;
  try {
    return quoteCypherName(name);
  } catch (error) {
    if (!(error instanceof CypherNameError)) throw error;
    return undefined;
  }
}

/**
 * Registers the Cypher completion item provider with Monaco.
 *
 * @param monaco - The Monaco namespace
 * @param schema - The names of the connection's labels, relationship types and properties
 * @param policy - The engine's policy profile, whose allowlists `CALL` and `SHOW` offer; undefined offers none
 * @returns An `IDisposable` that should be called on cleanup.
 */
export function registerCypherCompletionProvider(
  monaco: typeof Monaco,
  schema: CypherCompletionSchema,
  policy: GraphPolicyProfile | undefined,
): Monaco.IDisposable {
  const Kind = monaco.languages.CompletionItemKind;
  const reserved = new Set([...CYPHER_KEYWORDS, ...(policy?.readPolicy.deniedWords.flat() ?? [])]);
  const showForms = policy?.readPolicy.allowedShowForms ?? [];

  return monaco.languages.registerCompletionItemProvider(CYPHER_LANGUAGE_ID, {
    triggerCharacters: [":", ".", "|"],
    provideCompletionItems: (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
      const text = model.getValue().slice(0, model.getOffsetAt(position));
      const context = cypherCompletionContext(text, showForms);
      if (context === undefined) return { suggestions: [] };
      const from = model.getPositionAt(context.start);
      const range = {
        startLineNumber: from.lineNumber,
        startColumn: from.column,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      };

      const names = (list: readonly string[], kind: Monaco.languages.CompletionItemKind, detail: string) =>
        list.flatMap((label) => {
          const insertText = insertName(label, reserved);
          return insertText === undefined ? [] : [{ label, kind, insertText, range, detail }];
        });
      const words = (list: readonly string[], kind: Monaco.languages.CompletionItemKind, detail: string) =>
        list.map((label) => ({ label, kind, insertText: label, range, detail }));

      const suggestions: Record<CypherCompletionKind, () => Monaco.languages.CompletionItem[]> = {
        label: () => names(schema.labels, Kind.Class, "Node label"),
        "relationship-type": () => names(schema.relationshipTypes, Kind.Struct, "Relationship type"),
        property: () => names(schema.properties, Kind.Field, "Property"),
        procedure: () => words(policy?.readPolicy.allowedProcedures ?? [], Kind.Function, "Procedure"),
        show: () => {
          // Labelled with the whole form, inserted and filtered on the words after those already typed; the
          // one being typed is Monaco's to filter on. A form typed in full leaves nothing to offer.
          const typed = context.showWords ?? [];
          const items = new Map<string, Monaco.languages.CompletionItem>();
          for (const form of showForms) {
            if (!beginsAForm(typed, [form])) continue;
            const label = form.filter((word) => word !== "*").join(" ");
            const rest = form
              .slice(typed.length)
              .filter((word) => word !== "*")
              .join(" ");
            if (rest === "" || items.has(label)) continue;
            items.set(label, {
              label,
              kind: Kind.Keyword,
              insertText: rest,
              filterText: rest,
              range,
              detail: "SHOW form",
            });
          }
          return [...items.values()];
        },
        keyword: () =>
          words(
            [...CYPHER_KEYWORDS].sort((a, b) => a.localeCompare(b, "en")),
            Kind.Keyword,
            "Keyword",
          ),
      };
      return { suggestions: suggestions[context.kind]() };
    },
  });
}
