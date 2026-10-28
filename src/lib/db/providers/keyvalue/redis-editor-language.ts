import type { EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { registerRedisLanguage } from "./redis-editor-syntax";

/** The Redis command language (#427): no formatter, because the SQL formatter rewrites a command, and fuchsia. */
export const REDIS_EDITOR_LANGUAGE = Object.freeze<EditorLanguageContribution>({
  monacoId: "redis",
  register: registerRedisLanguage,
  accent: "border-hue-fuchsia/40",
});
