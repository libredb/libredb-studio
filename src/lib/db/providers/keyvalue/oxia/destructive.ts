import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import { OXIA_MAX_TEXT_BYTES } from "@/lib/db/providers/keyvalue/oxia/constants";
import { OXIA_DESTRUCTIVE_OPERATIONS, oxiaRefusal, readOxiaOperations } from "@/lib/db/providers/keyvalue/oxia/guard";

/**
 * Oxia's row of the confirmation gate's vocabulary (O10, C17).
 *
 * The provider's own guard.ts reads the text with the parser the provider runs, so what asks and what runs are one
 * parse. v1 only reads, so nothing asks; what guard.ts refuses (a write or stream verb, a key under __oxia/, a refused
 * flag) the editor refuses before anything is sent.
 */
export const OXIA_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: OXIA_DESTRUCTIVE_OPERATIONS,
  read: readOxiaOperations,
  decidesAlone: true,
  // A command names keys, and an Oxia key path names Pulsar tenants, namespaces and topics (SEC-05), so no
  // Oxia statement is posted for an AI analysis.
  safetyAnalysis: false,
  refuse: oxiaRefusal,
  maxTextBytes: OXIA_MAX_TEXT_BYTES,
};
