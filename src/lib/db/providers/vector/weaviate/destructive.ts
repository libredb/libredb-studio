import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import {
  readWeaviateOperations,
  WEAVIATE_DESTRUCTIVE_OPERATIONS,
  weaviateRefusal,
} from "@/lib/db/providers/vector/weaviate/guard";
import { WEAVIATE_CONSOLE } from "@/lib/db/providers/vector/weaviate/routes";

/**
 * Weaviate's row of the confirmation gate's vocabulary (#1566 spec 3.4).
 *
 * As Qdrant, the provider's own guard.ts reads the text with the parser the provider runs. A v1 request only reads,
 * so nothing asks; what guard.ts refuses (a write route, a model-calling key, an alpha other than 0, an unknown key)
 * the editor refuses before anything is sent.
 */
export const WEAVIATE_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: WEAVIATE_DESTRUCTIVE_OPERATIONS,
  read: readWeaviateOperations,
  decidesAlone: true,
  // A request carries vectors, filters and property values, so no Weaviate statement is posted for an AI analysis.
  safetyAnalysis: false,
  refuse: weaviateRefusal,
  maxTextBytes: WEAVIATE_CONSOLE.maxTextBytes,
};
