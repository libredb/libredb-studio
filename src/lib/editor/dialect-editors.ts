import type { EditorLanguage } from "@/lib/db/editor-language";
import { BUNDLED_DIALECT_EDITORS } from "@/lib/db/engine-catalog/query-editor.generated";
import type { QueryTab } from "@/lib/types";

/**
 * How a tab of each type is edited: the Monaco language it renders in. What that language registers, completes,
 * formats and tints is its contribution's, in the editor language registry (`src/lib/db/editor-language/`).
 *
 * Keyed by tab type rather than by dialect, because the tab type is the value a tab persists: a restored tab
 * resolves its language from this record without the connection's capabilities. It therefore holds the tab types
 * no dialect declares too (`sql`, `mongodb`, `promql`), beside the dialects' (`src/lib/db/query-dialects.ts`).
 */
export interface DialectEditor {
  /** The Monaco language id a tab of this type renders in, a key of the editor language registry. */
  readonly monacoId: EditorLanguage;
}

/**
 * Every tab type's language, as `editorLanguageForTabType` and `QueryEditor` read it: the Monaco language each engine
 * declaration states in its `editor.language` for the tab type its tabs open under, projected from the admitted
 * declarations into the generated query editor module (docs/providers/CONTRACT.md, clause M-77), which holds every
 * declaration of one tab type to one language. Tab types that render in one language share its formatter, since the
 * formatter is the language's. Each engine's reasons for its tab type's language are in its provider document.
 */
export const DIALECT_EDITORS: Readonly<Record<QueryTab["type"], DialectEditor>> = BUNDLED_DIALECT_EDITORS;
