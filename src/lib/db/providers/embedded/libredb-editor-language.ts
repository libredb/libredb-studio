import type { EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { registerLibreDBLanguage } from "./libredb-editor-syntax";

/** The LibreDB command language (#427): no formatter, and violet. */
export const LIBREDB_EDITOR_LANGUAGE = Object.freeze<EditorLanguageContribution>({
  monacoId: "libredb",
  register: registerLibreDBLanguage,
  accent: "border-hue-violet/40",
});
