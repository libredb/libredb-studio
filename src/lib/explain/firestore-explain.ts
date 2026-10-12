/**
 * The Firestore explain strategy's marker (spec 5.7): the text the Explain button puts before a statement. It lies
 * outside the console grammar, where `--` is not a token, so the provider recognises it only at offset 0 and a
 * failed strip is a parse error, never a run.
 */
export const FIRESTORE_EXPLAIN_MARKER = "-- libredb:firestore-explain\n";
