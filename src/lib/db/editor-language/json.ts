import type { EditorLanguageContribution } from "./types";

/**
 * JSON formatting, for MongoDB queries and every JSON read request alike (Kafka's, RabbitMQ's, the industrial
 * engines'). A read request is read from `JSON.parse`'s value alone, so its formatted text reads as the typed one
 * (#1088). Text that is not JSON throws, and the editor leaves it as written.
 */
const formatJson = (text: string): string => JSON.stringify(JSON.parse(text), null, 2);

/**
 * Monaco's built-in `json`: MongoDB's query language and the language of every JSON read request. No one engine owns
 * it, so its formatter and accent are declared here, in the shared layer, and an engine's completion source joins the
 * row in the registry.
 */
export const JSON_EDITOR_LANGUAGE = Object.freeze<EditorLanguageContribution>({
  monacoId: "json",
  format: formatJson,
  accent: "border-hue-cyan/40",
});
