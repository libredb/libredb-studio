import type { EditorLanguageCode } from "@/lib/db/editor-language/types";
import { registerRedisLanguage } from "./redis-editor-syntax";

/**
 * The Redis command language (#427): no formatter, because the SQL formatter rewrites a command, and fuchsia, the
 * accent its declaration states in `editor.language.accent`.
 */
export const REDIS_EDITOR_LANGUAGE = Object.freeze<EditorLanguageCode>({
  monacoId: "redis",
  register: registerRedisLanguage,
});
