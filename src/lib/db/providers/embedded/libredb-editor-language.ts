import type { EditorLanguageCode } from "@/lib/db/editor-language/types";
import { registerLibreDBLanguage } from "./libredb-editor-syntax";

/**
 * The LibreDB command language (#427): no formatter, and violet, the accent its declaration states in
 * `editor.language.accent`.
 */
export const LIBREDB_EDITOR_LANGUAGE = Object.freeze<EditorLanguageCode>({
  monacoId: "libredb",
  register: registerLibreDBLanguage,
});
