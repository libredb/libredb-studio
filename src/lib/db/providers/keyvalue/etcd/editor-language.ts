import type { EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { registerEtcdLanguage } from "./editor-syntax";

/**
 * The etcdctl command line (#1089). No formatter.
 *
 * Sky, the light blue of etcd's own mark, between SQL's blue and JSON's cyan and neither of them: its command line is
 * no SQL and no JSON, and no guard reads it either.
 */
export const ETCD_EDITOR_LANGUAGE = Object.freeze<EditorLanguageContribution>({
  monacoId: "etcd",
  register: registerEtcdLanguage,
  accent: "border-hue-sky/40",
});
