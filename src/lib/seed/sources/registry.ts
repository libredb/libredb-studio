/**
 * The enabled operator sources, in the fixed order file, directory, inline, env-urls (Spec A, section 5.1). A1 has
 * the file source only; A2 adds the other three here.
 */
import { createFileSource, resetFileSourceState } from "./file";
import type { OperatorSource } from "./types";

/** The enabled sources in the fixed order file, directory, inline, env-urls (A1: file only). */
export function enabledOperatorSources(): OperatorSource[] {
  return [createFileSource()];
}

/** Clears every source-level state: the file source's log set; in A2 also the directory's log set and the inline parse cache. */
export function resetOperatorSourceCaches(): void {
  resetFileSourceState();
}
