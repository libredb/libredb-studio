import type { EditorLanguageCode } from "@/lib/db/editor-language/types";
import { registerPromqlLanguage } from "./editor-syntax";

/**
 * PromQL (#1085). No formatter: the SQL formatter rewrote `up == 0` as `up = = 0`.
 *
 * Its accent, which the declaration states in `editor.language.accent`, is indigo rather than Prometheus's own orange:
 * orange sits next to the rail's amber, and a PromQL draft is always shown beside the amber "not checked" chip, because
 * no guard reads PromQL (`validatePlanStatement` declines it, so `guardReading` answers `unexamined`).
 */
export const PROMQL_EDITOR_LANGUAGE = Object.freeze<EditorLanguageCode>({
  monacoId: "promql",
  register: registerPromqlLanguage,
});
