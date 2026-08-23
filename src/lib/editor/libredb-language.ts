import type * as Monaco from "monaco-editor";

/**
 * Monaco language for the LibreDB command grammar.
 *
 * LibreDB queries are neither SQL nor MongoDB JSON, so reusing the `json`
 * language mis-highlights them (and would flag commands as invalid JSON). This
 * registers a minimal language whose tokens map onto the editor's shared
 * `db-dark` theme: the verbs (get/put/delete/prefix/range) as keywords, `#`
 * line comments, quoted strings, and numbers. Everything else (keys like
 * `users:1`) reads as a plain identifier.
 */
const LIBREDB_LANGUAGE_ID = "libredb";

const LIBREDB_KEYWORDS = ["get", "put", "delete", "prefix", "range"];

/**
 * Register the LibreDB language on a Monaco instance. Idempotent — safe to call
 * on every editor mount; it no-ops once the language is already registered.
 */
export function registerLibreDBLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((lang) => lang.id === LIBREDB_LANGUAGE_ID)) {
    return;
  }

  monaco.languages.register({ id: LIBREDB_LANGUAGE_ID });

  monaco.languages.setMonarchTokensProvider(LIBREDB_LANGUAGE_ID, {
    ignoreCase: true,
    keywords: LIBREDB_KEYWORDS,
    tokenizer: {
      root: [
        // A line is a comment only when it STARTS with `#` (after whitespace),
        // matching the provider's parser — `#` inside a key/value stays data.
        [/^\s*#.*$/, "comment"],
        // Both quote rules are single-line on purpose. The Redis tokenizer carries
        // a string state across the line break (U10) because its `commandBody()`
        // treats a newline inside an open quoted argument as data; this provider is
        // line-based — `firstCommandLine()` takes the first non-comment LINE and
        // `tokenize()` rejects an unmatched quote (docs/providers/libredb.md §5.1)
        // — so a value here can never span a line, and a state carried across lines
        // would paint the rest of a cheatsheet as one value the provider never sees
        // that way.
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
        [/\b\d+(\.\d+)?\b/, "number"],
        // A key like `users:1` is one identifier token: a letter/underscore start
        // followed by word chars and key punctuation (`:` `.` `-` `*` `/`). Exact
        // verb matches map to `keyword` via cases; everything else is identifier.
        [/[a-zA-Z_][\w:.*/-]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
      ],
    },
  });

  monaco.languages.setLanguageConfiguration(LIBREDB_LANGUAGE_ID, {
    comments: { lineComment: "#" },
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "{", close: "}" },
      { open: "[", close: "]" },
    ],
  });
}
