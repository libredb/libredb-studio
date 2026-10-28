import type { EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { registerOxiaLanguage } from "./editor-syntax";

/**
 * The Oxia command line, drawn over the provider's own lexer. No formatter: the SQL formatter rewrites a command line,
 * and the console formatter is the HTTP grammar's (SB2-4.5).
 *
 * Purple's `-alt` step (#424): no guard reads an Oxia command, so its draft stands beside the amber "not checked"
 * chip, and orange is ruled out for PromQL's reason. Of the declared `-alt` steps, purple's stands furthest from every
 * status hue and every other language in both palettes (0.076 in OKLab from Cypher's purple, its nearest), measured.
 */
export const OXIA_EDITOR_LANGUAGE = Object.freeze<EditorLanguageContribution>({
  monacoId: "oxia",
  register: registerOxiaLanguage,
  accent: "border-hue-purple-alt/40",
});
