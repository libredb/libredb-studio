import type { EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { registerMongoDBCompletionProvider } from "./editor-completions";

/**
 * MongoDB's completion source for the shared `json` language, the one part of that row MongoDB owns.
 *
 * It registers for MongoDB's JSON only (#1088). A json editor also holds JSON of a dialect of its own, a Kafka read
 * request, and there the source's snippets are MongoDB documents that dialect refuses, while its field items offer a
 * topic's result columns as if they were keys of the request. So it registers only where the declared capabilities
 * name no dialect, the rule `offersColumnProfiling` reads, and still where none are passed, as the published
 * component's callers always had it.
 */
export const MONGODB_JSON_COMPLETIONS: NonNullable<EditorLanguageContribution["completions"]> = (monaco, context) =>
  context.capabilities?.queryDialect === undefined
    ? registerMongoDBCompletionProvider(monaco, context.schemaCache)
    : undefined;
