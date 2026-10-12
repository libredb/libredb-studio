/**
 * Fixtures the Firestore console tests share: one target, its document root, and readers for the QueryError a
 * statement is refused with.
 */
import { QueryError } from "@/lib/db/errors";
import type { FirestoreTarget } from "@/lib/db/providers/document/firestore/names";

export const TARGET: FirestoreTarget = { projectId: "demo-studio", databaseId: "(default)" };
export const DOCUMENTS = "projects/demo-studio/databases/(default)/documents";

/** The full document name of a path relative to TARGET's document root. */
export function full(path: string): string {
  return `${DOCUMENTS}/${path}`;
}

/** The QueryError `run` throws; any other outcome fails the test. */
export function refusal(run: () => unknown): QueryError {
  try {
    run();
  } catch (error) {
    if (error instanceof QueryError) return error;
    throw error;
  }
  throw new Error("expected a QueryError, and nothing was thrown");
}

/** The QueryError the promise rejects with; any other outcome fails the test. */
export async function refusalAsync(run: () => Promise<unknown>): Promise<QueryError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof QueryError) return error;
    throw error;
  }
  throw new Error("expected a QueryError, and nothing was thrown");
}

/** A seeded PRNG (mulberry32): one seed gives one sequence on every platform, so a failing input can be replayed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}
