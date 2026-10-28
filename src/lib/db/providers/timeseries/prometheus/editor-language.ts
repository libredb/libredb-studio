import type { EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { registerPromqlLanguage } from "./editor-syntax";

/**
 * PromQL (#1085). No formatter: the SQL formatter rewrote `up == 0` as `up = = 0`.
 *
 * Indigo rather than Prometheus's own orange: orange sits next to the rail's amber, and a PromQL draft is always shown
 * beside the amber "not checked" chip, because no guard reads PromQL (`validatePlanStatement` declines it, so
 * `guardReading` answers `unexamined`).
 */
export const PROMQL_EDITOR_LANGUAGE = Object.freeze<EditorLanguageContribution>({
  monacoId: "promql",
  register: registerPromqlLanguage,
  accent: "border-hue-indigo/40",
});
