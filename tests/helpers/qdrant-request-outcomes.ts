/**
 * What the Qdrant console's phase 0 makes of a set of texts, as data two runtimes can compare: each text's verdict,
 * the refusal's phase, key and message, and the body it would send. tests/unit/db/qdrant/request-runtimes.test.ts
 * computes this under Bun and again in a Node child process from a bundle of this file, and the two must be equal.
 */
import { RequestRefusal } from "@/lib/db/console/dialect";
import { toJsonText } from "@/lib/db/console/tagged-json";
import { parseQdrantRequest, qdrantPhase0 } from "@/lib/db/providers/vector/qdrant/request";

export interface RequestCase {
  readonly name: string;
  readonly text: string;
}

export interface RequestOutcome {
  readonly name: string;
  /** `accepted`, or `refused`. */
  readonly verdict: string;
  readonly phase: number | null;
  readonly key: string | null;
  readonly message: string | null;
  readonly body: string | null;
}

export function requestOutcomes(cases: readonly RequestCase[]): RequestOutcome[] {
  return cases.map(({ name, text }) => {
    try {
      const plan = qdrantPhase0(parseQdrantRequest(text));
      return {
        name,
        verdict: "accepted",
        phase: null,
        key: null,
        message: null,
        body: plan.body === null ? null : toJsonText(plan.body),
      };
    } catch (error) {
      if (!(error instanceof RequestRefusal)) throw error;
      return { name, verdict: "refused", phase: error.phase, key: error.key, message: error.message, body: null };
    }
  });
}
