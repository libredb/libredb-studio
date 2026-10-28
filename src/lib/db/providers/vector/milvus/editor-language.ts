import { formatConsole } from "@/lib/db/console/format";
import type { EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { MILVUS_CONSOLE, MILVUS_ROUTES } from "./routes";

/**
 * The Milvus console request (vector-family spec 3.4, 5.7): its dialect and route table register the language, and
 * Format goes through the console formatter, which keeps every literal's bytes.
 *
 * Teal: a hue no other language uses and none of the rail's three status hues. No guard reads it.
 */
export const MILVUS_EDITOR_LANGUAGE = Object.freeze<EditorLanguageContribution>({
  monacoId: "milvus",
  console: Object.freeze({ spec: MILVUS_CONSOLE, routes: MILVUS_ROUTES }),
  format: (text: string) => formatConsole(MILVUS_CONSOLE, text),
  accent: "border-hue-teal/40",
});
