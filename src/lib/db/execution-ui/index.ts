import { BUNDLED_EXECUTION_UI } from "@/lib/db/engine-catalog/editor.generated";
import { typeIdRow } from "@/lib/db/type-id";
import type { DatabaseType } from "@/lib/types";
import { NO_CONNECTION_EXECUTION_UI } from "./no-connection";
import type { ExecutionUiSpec } from "./types";

/**
 * Each engine's execution UI facts, one row per type id: the commit keyword and the consent deadline its declaration
 * states, `editor.commitKeyword` and `editor.consentDeadline` (docs/providers/CONTRACT.md, clause M-75), read from the
 * generated execution UI record, which `bun run engines:generate` projects from the admitted declarations. The record
 * is typed over the type-id union, so an engine with no declaration is a compile error there.
 */
export const EXECUTION_UI: Readonly<Record<DatabaseType, ExecutionUiSpec>> = BUNDLED_EXECUTION_UI;

/**
 * The spec for a connection's type: `NO_CONNECTION_EXECUTION_UI` without one, and the engine's row for a type id,
 * read through `typeIdRow`, so any other value is refused by name and a prototype key never reaches an
 * `Object.prototype` member.
 *
 * @throws {UnknownProviderError} When `type` is defined and not a type id: a string that names no provider, `""`,
 * `null`, or a value that is not text.
 */
export function executionUiFor(type: string | undefined): ExecutionUiSpec {
  if (type === undefined) return NO_CONNECTION_EXECUTION_UI;
  return typeIdRow(EXECUTION_UI, type);
}
