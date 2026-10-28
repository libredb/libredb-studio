import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import {
  MILVUS_DESTRUCTIVE_OPERATIONS,
  milvusRefusal,
  readMilvusOperations,
} from "@/lib/db/providers/vector/milvus/guard";
import { MILVUS_CONSOLE } from "@/lib/db/providers/vector/milvus/routes";

/**
 * Milvus's row of the confirmation gate's vocabulary (vector-family spec 5.7, E10).
 *
 * The provider's own guard.ts reads the text with the parser the provider runs, so what asks and what runs are one
 * parse. A v1 request only reads, so nothing asks; what guard.ts refuses (a write route, a server-side function, an
 * endpoint-bearing key) the editor refuses before anything is sent.
 */
export const MILVUS_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: MILVUS_DESTRUCTIVE_OPERATIONS,
  read: readMilvusOperations,
  decidesAlone: true,
  // A request carries vectors, filters and values, so no Milvus statement is posted for an AI analysis.
  safetyAnalysis: false,
  refuse: milvusRefusal,
  maxTextBytes: MILVUS_CONSOLE.maxTextBytes,
};
