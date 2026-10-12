/**
 * Completion for the `firestore` editor language (Firestore spec 5.4).
 *
 * Pure utility module (no React). What is offered: `db` at the start; after a `.` on the top-level chain, the methods
 * the chain's state takes next, by the Admin SDK's state machine; inside the first string argument of `collection`,
 * `collectionGroup` or `doc`, the collection ids the tree has already listed; inside the second string argument of
 * `where`, the ten operators. Collection ids come from the schema context the editor holds, read on each request, so
 * completion never sends a request. Every inserted id is escaped for the quote it goes into, so it reads back as that id.
 */
import type * as Monaco from "monaco-editor";
import { FIRESTORE_LANGUAGE_ID } from "./firestore-language";

export type FirestoreChainState = "root" | "collection" | "query" | "vector" | "aggregation" | "document" | "end";

const QUERY_STEPS: Readonly<Record<string, FirestoreChainState>> = {
  where: "query",
  orderBy: "query",
  limit: "query",
  offset: "query",
  startAt: "query",
  startAfter: "query",
  endAt: "query",
  endBefore: "query",
  select: "query",
  findNearest: "vector",
  count: "aggregation",
  aggregate: "aggregation",
  explain: "end",
  get: "end",
};

/** The chain's state machine: from each state, each method it takes and the state that method leads to. */
export const FIRESTORE_CHAIN: Readonly<Record<FirestoreChainState, Readonly<Record<string, FirestoreChainState>>>> = {
  root: { collection: "collection", collectionGroup: "query", doc: "document", listCollections: "end", getAll: "end" },
  collection: { doc: "document", listDocuments: "end", ...QUERY_STEPS },
  query: QUERY_STEPS,
  vector: { explain: "end", get: "end" },
  aggregation: { explain: "end", get: "end" },
  document: { collection: "collection", get: "end", listCollections: "end" },
  end: {},
};

export const FIRESTORE_OPERATORS: readonly string[] = Object.freeze([
  "<",
  "<=",
  "==",
  "!=",
  ">=",
  ">",
  "array-contains",
  "in",
  "not-in",
  "array-contains-any",
]);

const PATH_METHODS: ReadonlySet<string> = new Set(["collection", "collectionGroup", "doc"]);

export type FirestoreCompletionContext =
  | { readonly kind: "root"; readonly start: number }
  | { readonly kind: "method"; readonly state: FirestoreChainState; readonly start: number }
  | { readonly kind: "collection"; readonly quote: string; readonly start: number }
  | { readonly kind: "operator"; readonly quote: string; readonly start: number };

/** An open call, bracket or brace: the method a `(` follows ("" for anything else), and which argument is being written. */
interface OpenCall {
  readonly method: string;
  argument: number;
}

/** What one left-to-right read of a text leaves open at its end. */
interface Reading {
  readonly calls: OpenCall[];
  readonly chain: string[];
  rooted: boolean;
  quote: { readonly char: string; readonly start: number } | null;
  inComment: boolean;
  lastSignificant: string;
}

const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;

function read(text: string): Reading {
  const reading: Reading = { calls: [], chain: [], rooted: false, quote: null, inComment: false, lastSignificant: "" };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (reading.quote !== null) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === reading.quote.char) {
        reading.quote = null;
        reading.lastSignificant = char;
      }
      index += 1;
      continue;
    }
    if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index);
      if (end === -1) {
        reading.inComment = true;
        return reading;
      }
      index = end;
      continue;
    }
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      if (end === -1) {
        reading.inComment = true;
        return reading;
      }
      index = end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      reading.quote = { char, start: index };
      index += 1;
      continue;
    }
    WORD.lastIndex = index;
    const word = WORD.exec(text)?.[0];
    if (word !== undefined) {
      if (reading.calls.length === 0) {
        if (reading.lastSignificant === "." && reading.rooted) reading.chain.push(word);
        else if (word === "db" && !reading.rooted) reading.rooted = true;
      }
      reading.lastSignificant = word;
      index += word.length;
      continue;
    }
    if (char === "(") {
      reading.calls.push({
        method: /^[A-Za-z_]/.test(reading.lastSignificant) ? reading.lastSignificant : "",
        argument: 0,
      });
    } else if (char === "[" || char === "{") {
      reading.calls.push({ method: "", argument: 0 });
    } else if (char === ")" || char === "]" || char === "}") {
      reading.calls.pop();
    } else if (char === "," && reading.calls.length > 0) {
      reading.calls[reading.calls.length - 1].argument += 1;
    }
    if (!/\s/.test(char)) reading.lastSignificant = char;
    index += 1;
  }
  return reading;
}

/** The state a top-level chain of methods leads to, or undefined at a method the state machine does not take. */
function stateOf(chain: readonly string[]): FirestoreChainState | undefined {
  let state: FirestoreChainState = "root";
  for (const method of chain) {
    const next: Readonly<Record<string, FirestoreChainState>> = FIRESTORE_CHAIN[state];
    if (!Object.hasOwn(next, method)) return undefined;
    state = next[method];
  }
  return state;
}

/** Where the cursor stands, from the text before it; undefined where nothing is offered. */
export function firestoreCompletionContext(before: string): FirestoreCompletionContext | undefined {
  const whole = read(before);
  if (whole.inComment) return undefined;
  if (whole.quote !== null) {
    const call = whole.calls[whole.calls.length - 1];
    if (call === undefined) return undefined;
    const start = whole.quote.start + 1;
    if (call.argument === 0 && PATH_METHODS.has(call.method))
      return { kind: "collection", quote: whole.quote.char, start };
    if (call.argument === 1 && call.method === "where") return { kind: "operator", quote: whole.quote.char, start };
    return undefined;
  }
  const typed = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before)?.[0] ?? "";
  const start = before.length - typed.length;
  const head = read(before.slice(0, start));
  if (head.calls.length > 0) return undefined;
  if (head.rooted && head.lastSignificant === ".") {
    const state = stateOf(head.chain);
    return state === undefined ? undefined : { kind: "method", state, start };
  }
  if (!head.rooted && (head.lastSignificant === "" || head.lastSignificant === "await")) return { kind: "root", start };
  return undefined;
}

/** An id as the inside of a string in `quote`, so it reads back as the same id. */
function quoted(id: string, quote: string): string {
  let out = "";
  for (const char of id) {
    if (char === "\\" || char === quote) out += `\\${char}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (quote === "`" && char === "$") out += "\\$";
    else out += char;
  }
  return out;
}

/** The top-level collection names of the editor's schema context: each entry's name whose path, if any, is one segment. */
export function firestoreCompletionCollectionsOf(parsedSchema: unknown): string[] {
  if (!Array.isArray(parsedSchema)) return [];
  const ids = new Set<string>();
  for (const entry of parsedSchema) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, path } = entry as { name?: unknown; path?: unknown };
    if (typeof name !== "string") continue;
    if (path !== undefined && !(Array.isArray(path) && path.length === 1)) continue;
    ids.add(name);
  }
  return [...ids];
}

type ItemKind = "keyword" | "method" | "collection" | "operator";

function itemsOf(
  context: FirestoreCompletionContext,
  collections: () => readonly string[],
): readonly { readonly label: string; readonly insertText: string; readonly kind: ItemKind }[] {
  switch (context.kind) {
    case "root":
      return [{ label: "db", insertText: "db", kind: "keyword" }];
    case "method":
      return Object.keys(FIRESTORE_CHAIN[context.state]).map((method) => ({
        label: method,
        insertText: method,
        kind: "method",
      }));
    case "collection":
      return collections().map((id) => ({ label: id, insertText: quoted(id, context.quote), kind: "collection" }));
    case "operator":
      return FIRESTORE_OPERATORS.map((operator) => ({ label: operator, insertText: operator, kind: "operator" }));
  }
}

/**
 * Registers the Firestore completion item provider with Monaco.
 *
 * @param collections - Read on each request: the collection ids the editor's schema context holds, from
 *   `firestoreCompletionCollectionsOf`.
 * @returns A disposable that should be called on cleanup.
 */
export function registerFirestoreCompletionProvider(
  monaco: typeof Monaco,
  collections: () => readonly string[],
): { dispose(): void } {
  const Kind = monaco.languages.CompletionItemKind;
  const kinds: Readonly<Record<ItemKind, Monaco.languages.CompletionItemKind>> = {
    keyword: Kind.Keyword,
    method: Kind.Method,
    collection: Kind.Folder,
    operator: Kind.Operator,
  };
  return monaco.languages.registerCompletionItemProvider(FIRESTORE_LANGUAGE_ID, {
    triggerCharacters: [".", '"', "'", "`"],
    provideCompletionItems: (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
      const before = model.getValue().slice(0, model.getOffsetAt(position));
      const context = firestoreCompletionContext(before);
      if (context === undefined) return { suggestions: [] };
      const typed = before.slice(context.start);
      if (/[\r\n]/.test(typed)) return { suggestions: [] };
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: position.column - typed.length,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      };
      return {
        suggestions: itemsOf(context, collections).map((item) => ({
          label: item.label,
          kind: kinds[item.kind],
          insertText: item.insertText,
          range,
        })),
      };
    },
  });
}
