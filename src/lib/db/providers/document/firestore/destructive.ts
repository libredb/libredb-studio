import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import { LIMITS as FIRESTORE_LIMITS } from "@/lib/db/providers/document/firestore/constants";
import { firestoreRefusal } from "@/lib/db/providers/document/firestore/console/guard";

/**
 * Firestore's row of the confirmation gate's vocabulary (spec 3.2), on the S3 and Kubernetes model.
 *
 * The console's own guard reads the text with the parser the provider runs, so what is refused and what runs are one
 * parse. A statement only reads, so nothing asks; what the guard refuses (a write method, a second statement, the
 * modular API, a `${` in a template string) the editor refuses before anything is sent, past the console's 64 KiB
 * bound. A statement names collections, ids and values, so none is posted for an AI analysis.
 */
export const FIRESTORE_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: new Set<string>(),
  read: () => [],
  decidesAlone: true,
  safetyAnalysis: false,
  refuse: (text) => firestoreRefusal(text) ?? undefined,
  maxTextBytes: FIRESTORE_LIMITS.maxConsoleBytes,
};
