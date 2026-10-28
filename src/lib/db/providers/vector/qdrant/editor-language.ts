import { formatConsole } from "@/lib/db/console/format";
import type { EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { QDRANT_CONSOLE, QDRANT_ROUTES } from "./routes";

/**
 * The Qdrant console request (vector-family spec 3.4, 6.7), registered and formatted as Milvus's is.
 *
 * Pink: a hue no other language uses and none of the rail's three status hues. No guard reads a Qdrant request, so
 * its draft stands beside the amber "not checked" chip.
 */
export const QDRANT_EDITOR_LANGUAGE = Object.freeze<EditorLanguageContribution>({
  monacoId: "qdrant",
  console: Object.freeze({ spec: QDRANT_CONSOLE, routes: QDRANT_ROUTES }),
  format: (text: string) => formatConsole(QDRANT_CONSOLE, text),
  accent: "border-hue-pink/40",
});
