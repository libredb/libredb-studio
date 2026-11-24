import type { EditorLanguageCode } from "./types";

/**
 * JSON formatting, for MongoDB queries and every JSON read request alike (Kafka's, RabbitMQ's, the industrial
 * engines'). A read request is read from `JSON.parse`'s value alone, so its formatted text reads as the typed one
 * (#1088). Text that is not JSON throws, and the editor leaves it as written.
 */
const formatJson = (text: string): string => JSON.stringify(JSON.parse(text), null, 2);

/**
 * Monaco's built-in `json`: MongoDB's query language and the language of every JSON read request. No one engine owns
 * it, so its formatter is declared here, in the shared layer, its accent is the one the declarations state in
 * `editor.language.accent`, and an engine's completion source joins the row in the registry.
 */
export const JSON_EDITOR_LANGUAGE = Object.freeze<EditorLanguageCode>({
  monacoId: "json",
  format: formatJson,
});
