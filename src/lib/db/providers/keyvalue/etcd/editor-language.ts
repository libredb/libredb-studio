import type { EditorLanguageCode } from "@/lib/db/editor-language/types";
import { registerEtcdLanguage } from "./editor-syntax";

/**
 * The etcdctl command line (#1089). No formatter.
 *
 * Its accent, which the declaration states in `editor.language.accent`, is sky, the light blue of etcd's own mark,
 * between SQL's blue and JSON's cyan and neither of them: its command line is no SQL and no JSON, and no guard reads it
 * either.
 */
export const ETCD_EDITOR_LANGUAGE = Object.freeze<EditorLanguageCode>({
  monacoId: "etcd",
  register: registerEtcdLanguage,
});
