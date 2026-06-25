import type * as Monaco from 'monaco-editor';

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
const LIBREDB_LANGUAGE_ID = 'libredb';

const LIBREDB_KEYWORDS = ['get', 'put', 'delete', 'prefix', 'range'];

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
        [/^\s*#.*$/, 'comment'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/\b\d+(\.\d+)?\b/, 'number'],
        [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
      ],
    },
  });

  monaco.languages.setLanguageConfiguration(LIBREDB_LANGUAGE_ID, {
    comments: { lineComment: '#' },
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '{', close: '}' },
      { open: '[', close: ']' },
    ],
  });
}
