import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import { OXIA_MAX_TEXT_BYTES } from "@/lib/languages/oxiacli/constants";
import { OXIA_DESTRUCTIVE_OPERATIONS, oxiaRefusal, readOxiaOperations } from "@/lib/languages/oxiacli/guard";

/**
 * Oxia's row of the confirmation gate's vocabulary (O10, C17).
 *
 * guard.ts reads the text with the parser the provider runs, so what asks and what runs are one
 * parse. v1 only reads, so nothing asks; what guard.ts refuses (a write or stream verb, a key under __oxia/, a refused
 * flag) the editor refuses before anything is sent.
 */
export const OXIA_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = Object.freeze({
  operations: OXIA_DESTRUCTIVE_OPERATIONS,
  read: readOxiaOperations,
  decidesAlone: true,
  // A command names keys, and an Oxia key path names Pulsar tenants, namespaces and topics (SEC-05), so no
  // Oxia statement is posted for an AI analysis.
  safetyAnalysis: false,
  refuse: oxiaRefusal,
  maxTextBytes: OXIA_MAX_TEXT_BYTES,
});
