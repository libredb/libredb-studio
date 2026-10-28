import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import {
  QDRANT_DESTRUCTIVE_OPERATIONS,
  qdrantRefusal,
  readQdrantOperations,
} from "@/lib/db/providers/vector/qdrant/guard";
import { QDRANT_CONSOLE } from "@/lib/db/providers/vector/qdrant/routes";

/**
 * Qdrant's row of the confirmation gate's vocabulary (vector-family spec 6.7).
 *
 * The provider's own guard.ts reads the text with the parser the provider runs, so what asks and what runs are one
 * parse. A v1 request only reads, so nothing asks; what guard.ts refuses (a write route, an inference input other
 * than local BM25, an unknown key) the editor refuses before anything is sent.
 */
export const QDRANT_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: QDRANT_DESTRUCTIVE_OPERATIONS,
  read: readQdrantOperations,
  decidesAlone: true,
  // A request carries vectors, filters and payload values, so no Qdrant statement is posted for an AI analysis.
  safetyAnalysis: false,
  refuse: qdrantRefusal,
  maxTextBytes: QDRANT_CONSOLE.maxTextBytes,
};
