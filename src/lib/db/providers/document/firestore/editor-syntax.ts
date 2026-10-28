import type * as Monaco from "monaco-editor";

/**
 * Monaco language for the Firestore console: one statement of a read-only subset of the Admin SDK's query chain
 * (docs/providers/firestore.md). A Monarch grammar over the token kinds the console's lexer reads
 * (`src/lib/db/providers/document/firestore/console/lexer.ts`): identifiers, strings in three quotes, numbers,
 * punctuation and the two comment forms. It colours; the parser decides, so a word coloured as a method is not a promise
 * the chain accepts it there. Monaco registers no language `firestore` itself, which
 * `tests/isolated/monaco-language-ids.test.ts` holds.
 */
export const FIRESTORE_LANGUAGE_ID = "firestore";

/** Every method name the grammar's chain and value constructors take, coloured as a method. */
export const FIRESTORE_METHODS: readonly string[] = Object.freeze([
  "collection",
  "collectionGroup",
  "doc",
  "listCollections",
  "getAll",
  "listDocuments",
  "where",
  "orderBy",
  "limit",
  "offset",
  "startAt",
  "startAfter",
  "endAt",
  "endBefore",
  "select",
  "findNearest",
  "count",
  "aggregate",
  "explain",
  "get",
  "fromDate",
  "fromMillis",
  "vector",
  "documentId",
  "and",
  "or",
  "sum",
  "average",
]);

export const FIRESTORE_MONARCH: Monaco.languages.IMonarchLanguage = {
  defaultToken: "invalid",
  keywords: ["db", "await", "new", "true", "false", "null", "NaN", "Infinity"],
  methods: FIRESTORE_METHODS,
  typeNames: [
    "admin",
    "firestore",
    "Timestamp",
    "FieldValue",
    "FieldPath",
    "Filter",
    "AggregateField",
    "GeoPoint",
    "Date",
  ],
  tokenizer: {
    // Every rule starts on a character no earlier rule can start on, except the number rule and the `-` rule, where the
    // number rule comes first so `-2` is one number; the last rule takes any character the grammar has no token for.
    root: [
      [/\/\/.*$/, "comment"],
      [/\/\*/, { token: "comment", next: "@blockComment" }],
      [/"/, { token: "string", next: "@doubleQuoted" }],
      [/'/, { token: "string", next: "@singleQuoted" }],
      [/`/, { token: "string", next: "@template" }],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
      [
        /[A-Za-z_][A-Za-z0-9_]*/,
        { cases: { "@keywords": "keyword", "@methods": "function", "@typeNames": "type", "@default": "identifier" } },
      ],
      [/[.,;:()[\]{}-]/, "delimiter"],
      [/[ \t\r\n]+/, ""],
      [/./, "invalid"],
    ],
    blockComment: [
      [/[^*]+/, "comment"],
      [/\*\//, { token: "comment", next: "@pop" }],
      [/\*/, "comment"],
    ],
    doubleQuoted: [
      [/[^"\\]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, { token: "string", next: "@pop" }],
    ],
    singleQuoted: [
      [/[^'\\]+/, "string"],
      [/\\./, "string.escape"],
      [/'/, { token: "string", next: "@pop" }],
    ],
    // A `${` is refused by the console's lexer, so it is drawn as the base theme draws an error.
    template: [
      [/\$\{/, "invalid"],
      [/[^`\\$]+/, "string"],
      [/\\./, "string.escape"],
      [/\$/, "string"],
      [/`/, { token: "string", next: "@pop" }],
    ],
  },
};

/** Register the Firestore language on a Monaco instance. Idempotent: a no-op once the language is registered. */
export function registerFirestoreLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((language) => language.id === FIRESTORE_LANGUAGE_ID)) return;
  monaco.languages.register({ id: FIRESTORE_LANGUAGE_ID });
  monaco.languages.setMonarchTokensProvider(FIRESTORE_LANGUAGE_ID, FIRESTORE_MONARCH);
  monaco.languages.setLanguageConfiguration(FIRESTORE_LANGUAGE_ID, {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: "{", close: "}" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "`", close: "`" },
    ],
  });
}
