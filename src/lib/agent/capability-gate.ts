/**
 * Whether a configured model may drive an agent run (`docs/BACKLOG.md` B18).
 *
 * `capability-probe.ts` has always been able to answer "can this model call tools",
 * and its docblock has always said "the run service asks this module first" — which
 * was aspiration, not description. Nothing called it, so a model that answers in prose
 * was discovered at its first tool call: the run opened, spent a drive and ended having
 * established nothing. This module is the caller, and it sits on the start path so a
 * refusal arrives before a run exists rather than as a run that failed.
 *
 * Four decisions, stated because B18 asks for them to be recorded rather than implied:
 *
 * **Planning mode is not probed.** It is toolless by contract (`types.ts`), so tool
 * calling is not among the capabilities it needs, and probing would spend a model round
 * trip answering a question the mode does not ask. The probe's own docblock leaves this
 * choice to the caller; this is the caller making it.
 *
 * **Only an ESTABLISHED incapability refuses.** The probe throws — in this
 * repository's `LLMError` vocabulary — for a bad key, a quota, an unpaid account, a
 * 5xx or a dropped socket, none of which say anything about what the model can do.
 * Those are let through. B18's own reservation was that a mandatory probe "adds a
 * failure mode to the start path", and this is the answer to it: the start path gains
 * no new way to fail, because the only new refusal is one the probe positively
 * established. What happens to those runs is no longer a mystery either — since Phase A
 * a drive reports `model-rate-limited`, `model-unauthorized` or `model-unavailable`
 * rather than sitting at `queued`.
 *
 * **Positive verdicts are cached, and nothing else is.** A model that called a tool
 * will keep calling tools, so that round trip is worth paying once — the alternative is
 * a preflight on every run, which is the sort of cost that gets features turned off. A
 * refusal is deliberately NOT cached: an operator can fix the server without changing
 * the model id (an `ollama` endpoint serving something else under the same name is the
 * case the probe's docblock already warns about), so a cached refusal would outlive the
 * problem. Re-probing costs a round trip to someone whose runs are already failing.
 *
 * **The cache key is the model's identity**, so a configuration change misses by
 * construction. There is no invalidation hook to forget to call, and no TTL to tune:
 * the thing that would change the answer also changes the key. The one case it cannot
 * see is a server swapped behind an unchanged id, which is exactly why refusals are not
 * cached.
 */

import type { AgentRunMode } from "./types";
import type { AgentCapabilityRefusal } from "./capability-probe";
import { probeAgentModel } from "./capability-probe";
import { type AgentModel, createAgentModel } from "./model-adapter";
import { logger } from "@/lib/logger";

export type AgentCapabilityGateVerdict =
  | { readonly kind: "allowed" }
  | { readonly kind: "refused"; readonly refusal: AgentCapabilityRefusal };

/**
 * Model identities established as able to drive a run. Process-scoped on purpose: a
 * restarted server re-establishes it, which costs one round trip and is the honest
 * answer to "was that still true after the restart".
 */
const established = new Set<string>();

const identityOf = (model: AgentModel): string => `${model.provider}:${model.modelId}`;

/** Test seam. A process-wide cache is exactly the state a suite must be able to clear. */
export function resetAgentCapabilityCache(): void {
  established.clear();
}

/**
 * The model is built here rather than taken as an argument, and a construction failure
 * is swallowed for the same reason a probe failure is: an unconfigured provider is not
 * a statement about a model's capabilities, and the start path must not gain a new way
 * to fail. The drive builds its own model moments later and reports that honestly.
 */
export async function admitAgentModel(mode: AgentRunMode): Promise<AgentCapabilityGateVerdict> {
  if (mode === "planning") return { kind: "allowed" };

  let model: AgentModel;
  try {
    model = await createAgentModel();
  } catch (error) {
    logger.warn("Model could not be built for the capability gate; starting the run anyway", {
      route: "agent/capability-gate",
      error: error instanceof Error ? error.name : "unknown",
    });
    return { kind: "allowed" };
  }

  const identity = identityOf(model);
  if (established.has(identity)) return { kind: "allowed" };

  let result: Awaited<ReturnType<typeof probeAgentModel>>;
  try {
    result = await probeAgentModel(model);
  } catch (error) {
    // Not a verdict about the model. Logged rather than surfaced, because the run is
    // about to be started and its own failure will carry the reason.
    logger.warn("Model capability probe was inconclusive; starting the run anyway", {
      route: "agent/capability-gate",
      provider: model.provider,
      modelId: model.modelId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { kind: "allowed" };
  }

  if (result.supported) {
    established.add(identity);
    return { kind: "allowed" };
  }

  logger.warn("Model refused an agent run: its capabilities were established as absent", {
    route: "agent/capability-gate",
    provider: result.refusal.provider,
    modelId: result.refusal.modelId,
    missing: result.refusal.missing.join(","),
  });
  return { kind: "refused", refusal: result.refusal };
}
