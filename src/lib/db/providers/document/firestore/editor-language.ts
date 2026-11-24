import type { EditorLanguageCode } from "@/lib/db/editor-language/types";
import { firestoreCompletionCollectionsOf, registerFirestoreCompletionProvider } from "./editor-completions";
import { registerFirestoreLanguage } from "./editor-syntax";

/**
 * The Firestore statement. No formatter: the JSON formatter refuses a call chain and the SQL formatter rewrites one.
 *
 * Completion (Firestore spec 5.4) offers the chain's method names by state, the operator strings, and the collection
 * ids the tree has already listed, read from the schema context on each request, so it sends no request.
 *
 * Its accent, which the declaration states in `editor.language.accent`, is pink's `-alt` step: no guard reads a
 * Firestore statement, so its draft stands beside the amber "not checked" chip, which rules out amber itself, yellow
 * and orange, and red is ruled out as a failure hue. Of the declared `-alt` steps left, pink's stands furthest from
 * every status hue and every other language in both palettes (0.062 in OKLab from Qdrant's pink, its nearest),
 * measured.
 */
export const FIRESTORE_EDITOR_LANGUAGE = Object.freeze<EditorLanguageCode>({
  monacoId: "firestore",
  register: registerFirestoreLanguage,
  completions: (monaco, context) =>
    registerFirestoreCompletionProvider(monaco, () => firestoreCompletionCollectionsOf(context.schemaObjects)),
});
