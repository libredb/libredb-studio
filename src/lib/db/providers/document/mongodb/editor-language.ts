import type { EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { registerMongoDBCompletionProvider } from "./editor-completions";

/**
 * JSON formatting, for MongoDB queries and every JSON read request alike (Kafka's, RabbitMQ's, the industrial
 * engines'). A read request is read from `JSON.parse`'s value alone, so its formatted text reads as the typed one
 * (#1088). Text that is not JSON throws, and the editor leaves it as written.
 */
const formatJson = (text: string): string => JSON.stringify(JSON.parse(text), null, 2);

/**
 * Monaco's built-in `json`, MongoDB's query language and the language of every JSON read request.
 *
 * The MongoDB completion source registers for MongoDB's JSON only (#1088). A json editor also holds JSON of a dialect
 * of its own, a Kafka read request, and there the source's snippets are MongoDB documents that dialect refuses, while
 * its field items offer a topic's result columns as if they were keys of the request. So it registers only where the
 * declared capabilities name no dialect, the rule `offersColumnProfiling` reads, and still where none are passed, as
 * the published component's callers always had it.
 */
export const JSON_EDITOR_LANGUAGE = Object.freeze<EditorLanguageContribution>({
  monacoId: "json",
  format: formatJson,
  completions: (monaco, context) =>
    context.capabilities?.queryDialect === undefined
      ? registerMongoDBCompletionProvider(monaco, context.schemaCache)
      : undefined,
  accent: "border-hue-cyan/40",
});
