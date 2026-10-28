import type { EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { registerKubectlLanguage } from "./editor-syntax";

/**
 * The kubectl statement, drawn over the console's lexer. No formatter: the SQL formatter rewrites a command line, and
 * the console formatter is the HTTP grammar's.
 *
 * Teal's `-alt` step: no guard reads a kubectl statement, so its draft stands beside the amber "not checked" chip,
 * which rules out amber itself, yellow and orange, and red is ruled out as a failure hue. Of the declared `-alt` steps
 * left, teal's stands furthest from every status hue and every other language in both palettes (0.071 in OKLab from
 * Milvus's teal, its nearest), measured.
 */
export const KUBECTL_EDITOR_LANGUAGE = Object.freeze<EditorLanguageContribution>({
  monacoId: "kubectl",
  register: registerKubectlLanguage,
  accent: "border-hue-teal-alt/40",
});
