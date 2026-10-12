import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import {
  FIRESTORE_CHAIN,
  FIRESTORE_OPERATORS,
  firestoreCompletionCollectionsOf,
  firestoreCompletionContext,
  registerFirestoreCompletionProvider,
} from "@/lib/editor/firestore-completions";

describe("firestoreCompletionCollectionsOf", () => {
  test("reads top-level collection names from the schema context, deduplicated in first-seen order", () => {
    expect(
      firestoreCompletionCollectionsOf([
        { name: "users", path: ["users"] },
        { name: "orders" },
        { name: "users", path: ["users"] },
        { name: "deep", path: ["users", "deep"] },
        { name: 7 },
        null,
        "loose",
      ]),
    ).toEqual(["users", "orders"]);
  });

  test("answers nothing for a context that is not a list", () => {
    expect(firestoreCompletionCollectionsOf(undefined)).toEqual([]);
    expect(firestoreCompletionCollectionsOf({ name: "users" })).toEqual([]);
  });
});

describe("firestoreCompletionContext", () => {
  test.each([
    ["", { kind: "root", start: 0 }],
    ["d", { kind: "root", start: 0 }],
    ["await ", { kind: "root", start: 6 }],
    ["db.", { kind: "method", state: "root", start: 3 }],
    ["/* x */ db.", { kind: "method", state: "root", start: 11 }],
  ])("at %j", (before, expected) => {
    expect(firestoreCompletionContext(before)).toEqual(expected as never);
  });

  test.each([
    ['db.collection("users").', "collection"],
    ['db.collection("users")\n  .', "collection"],
    ['db.collectionGroup("orders").', "query"],
    ['db.collection("users").where("age", ">=", 18).', "query"],
    ['db.collection("u").count().', "aggregation"],
    ['db.collection("docs").findNearest({ limit: 1 }).', "vector"],
    ['db.doc("users/alice").', "document"],
    ['db.collection("users").doc("alice").collection("orders").', "collection"],
    ['db.collection("u").get().', "end"],
  ])("offers the methods of the chain's state after %j", (before, state) => {
    expect(firestoreCompletionContext(before)).toEqual({ kind: "method", state: state as never, start: before.length });
  });

  test.each([
    ['db.collection("a\\"b").', "collection"],
    ["// a note\ndb.", "root"],
  ])("reads past an escaped quote and a closed line comment at %j", (before, state) => {
    expect(firestoreCompletionContext(before)).toEqual({ kind: "method", state: state as never, start: before.length });
  });

  test("replaces only the typed part of a method name", () => {
    const before = 'db.collection("users").wh';
    expect(firestoreCompletionContext(before)).toEqual({
      kind: "method",
      state: "collection",
      start: before.length - 2,
    });
  });

  test.each([
    ['db.collection("', '"'],
    ["db.collection('us", "'"],
    ["db.collectionGroup(`", "`"],
    ['db.doc("us', '"'],
  ])("offers collection ids inside the first string argument at %j", (before, quote) => {
    expect(firestoreCompletionContext(before)).toEqual({
      kind: "collection",
      quote,
      start: before.lastIndexOf(quote) + 1,
    });
  });

  test("offers the operators inside where's second string argument", () => {
    const before = 'db.collection("users").where("age", "';
    expect(firestoreCompletionContext(before)).toEqual({ kind: "operator", quote: '"', start: before.length });
  });

  test.each([
    ['db.collection("users").where("'],
    ['db.collection("users").where("age", "==", '],
    ['db.collection("users").set().'],
    ["// db."],
    ["/* db."],
    ['db.collection("a") x'],
    ["admin.firestore()."],
  ])("offers nothing at %j", (before) => {
    expect(firestoreCompletionContext(before)).toBeUndefined();
  });
});

describe("registerFirestoreCompletionProvider", () => {
  type Item = { label: string; kind: number; insertText: string; range: unknown };
  type Provider = {
    triggerCharacters?: string[];
    provideCompletionItems: (
      model: unknown,
      position: { lineNumber: number; column: number },
    ) => { suggestions: Item[] };
  };

  function register(collections: readonly string[]) {
    let captured: { languageId: string; provider: Provider } | undefined;
    let read = 0;
    const monaco = {
      languages: {
        CompletionItemKind: { Keyword: 17, Method: 0, Folder: 23, Operator: 11 },
        registerCompletionItemProvider: (languageId: string, provider: Provider) => {
          captured = { languageId, provider };
          return { dispose: () => {} };
        },
      },
    } as unknown as typeof Monaco;
    const disposable = registerFirestoreCompletionProvider(monaco, () => {
      read += 1;
      return collections;
    });
    if (captured === undefined) throw new Error("no provider registered");
    return { ...captured, disposable, reads: () => read };
  }

  const at = (provider: Provider, text: string) =>
    provider.provideCompletionItems(
      { getValue: () => text, getOffsetAt: () => text.length },
      { lineNumber: 1, column: text.length + 1 },
    ).suggestions;

  test("registers for the firestore language with its trigger characters, and can be disposed", () => {
    const { languageId, provider, disposable } = register([]);
    expect(languageId).toBe("firestore");
    expect(provider.triggerCharacters).toEqual([".", '"', "'", "`"]);
    expect(typeof disposable.dispose).toBe("function");
  });

  test("offers db at the start and the state's methods after a dot", () => {
    const { provider } = register([]);
    expect(at(provider, "")).toEqual([
      {
        label: "db",
        kind: 17,
        insertText: "db",
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      },
    ]);
    expect(at(provider, "db.").map((item) => item.label)).toEqual(Object.keys(FIRESTORE_CHAIN.root));
    expect(at(provider, 'db.collection("u").get().')).toEqual([]);
  });

  test("offers the listed collection ids, quoted for the string they go into, reading them on each request", () => {
    const { provider, reads } = register(['a"b', "c`${d}", "users"]);
    expect(reads()).toBe(0);
    expect(at(provider, 'db.collection("').map((item) => [item.label, item.insertText, item.kind])).toEqual([
      ['a"b', 'a\\"b', 23],
      ["c`${d}", "c`${d}", 23],
      ["users", "users", 23],
    ]);
    expect(at(provider, "db.collection(`").map((item) => item.insertText)).toEqual(['a"b', "c\\`\\${d}", "users"]);
    expect(reads()).toBe(2);
  });

  test("offers the ten operators inside where's second argument", () => {
    const { provider } = register([]);
    const items = at(provider, 'db.collection("u").where("a", "');
    expect(items.map((item) => item.label)).toEqual([...FIRESTORE_OPERATORS]);
    expect(items.every((item) => item.kind === 11)).toBe(true);
  });

  test("offers nothing where the typed part spans a line, or where the context offers nothing", () => {
    const { provider } = register(["users"]);
    expect(at(provider, 'db.collection("u\n')).toEqual([]);
    expect(at(provider, "// db.")).toEqual([]);
  });
});
