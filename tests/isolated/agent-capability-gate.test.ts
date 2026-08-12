/**
 * The start path's model gate (`docs/BACKLOG.md` B18).
 *
 * `probeAgentModel` establishes positively that a configured model calls tools, honours
 * the schema its arguments are declared against, and streams — and until now nothing
 * called it. Its own docblock claimed "the run service asks this module first", which
 * was aspiration rather than description: an incapable model was discovered at its
 * first tool call, after a run had opened and spent a drive answering in prose.
 *
 * Four decisions are pinned here, because B18 asks for them to be recorded rather than
 * implied:
 *
 *  1. **Planning mode is not probed.** That mode is toolless by contract, so tool
 *     calling is not a capability it needs. Probing it would spend a model round trip
 *     to answer a question the mode does not ask.
 *  2. **Only an ESTABLISHED incapability refuses.** The probe THROWS for a bad key, a
 *     quota, a 5xx or a dropped socket — none of which say anything about the model —
 *     and the gate lets those through rather than adding a failure mode to the start
 *     path. The drive then reports them honestly (`model-rate-limited`,
 *     `model-unavailable`), which it did not do before Phase A and does now.
 *  3. **Positive verdicts are cached; nothing else is.** A model that called a tool
 *     will keep calling tools, so paying for that round trip once is enough. A refusal
 *     is not cached because an operator can fix the server without changing the model
 *     id — an `ollama` endpoint serving something else under the same name is the case
 *     — and the cost of re-probing falls only on someone whose runs are already
 *     failing.
 *  4. **The key is the model's identity**, so a configuration change misses the cache
 *     by construction instead of needing an invalidation hook.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { LLMConfigError, LLMRateLimitError } from "@/lib/llm/types";
import type { AgentModel } from "@/lib/agent/model-adapter";
import type { AgentCapabilityProbeResult } from "@/lib/agent/capability-probe";

const probeAgentModel = mock<(model: AgentModel) => Promise<AgentCapabilityProbeResult>>(async () => ({
  supported: true,
  capabilities: { toolCalling: true, structuredOutput: true, streaming: true },
}));

mock.module("@/lib/agent/capability-probe", () => ({ probeAgentModel }));

const model = (modelId = "gemini-3.5-flash-lite"): AgentModel =>
  ({ provider: "gemini", modelId, model: {} }) as unknown as AgentModel;

const createAgentModel = mock<() => Promise<AgentModel>>(async () => model());

mock.module("@/lib/agent/model-adapter", () => ({ createAgentModel }));

const { admitAgentModel, resetAgentCapabilityCache } = await import("@/lib/agent/capability-gate");

const REFUSAL = {
  supported: false as const,
  refusal: {
    provider: "gemini" as const,
    modelId: "gemini-3.5-flash-lite",
    capabilities: { toolCalling: false, structuredOutput: false, streaming: true },
    missing: ["toolCalling" as const],
    message: "This model does not call tools. Use the AI Assistant or Natural Language Query instead.",
  },
};

beforeEach(() => {
  resetAgentCapabilityCache();
  probeAgentModel.mockClear();
  createAgentModel.mockClear();
  createAgentModel.mockImplementation(async () => model());
  probeAgentModel.mockImplementation(async () => ({
    supported: true,
    capabilities: { toolCalling: true, structuredOutput: true, streaming: true },
  }));
});

afterEach(() => {
  resetAgentCapabilityCache();
});

describe("the model gate on the start path", () => {
  test("a planning run is admitted without spending a model call", async () => {
    const verdict = await admitAgentModel("planning");

    expect(verdict.kind).toBe("allowed");
    expect(probeAgentModel).not.toHaveBeenCalled();
  });

  test("an agent run is probed, and admitted when the model can drive one", async () => {
    const verdict = await admitAgentModel("agent");

    expect(verdict.kind).toBe("allowed");
    expect(probeAgentModel).toHaveBeenCalledTimes(1);
  });

  test("a model established as unable to call tools is refused, with the probe's own words", async () => {
    probeAgentModel.mockImplementation(async () => REFUSAL);

    const verdict = await admitAgentModel("agent");

    expect(verdict).toMatchObject({ kind: "refused", refusal: { missing: ["toolCalling"] } });
  });

  test("a probe that says nothing about the model admits the run", async () => {
    // A quota is not a capability. Refusing here would replace an honest run-level
    // failure with a start-level one, for a condition that clears itself.
    probeAgentModel.mockImplementation(async () => {
      throw new LLMRateLimitError("quota exceeded", "gemini");
    });

    const verdict = await admitAgentModel("agent");

    expect(verdict.kind).toBe("allowed");
  });

  test("a capable model is probed once, however many runs follow", async () => {
    await admitAgentModel("agent");
    await admitAgentModel("agent");
    await admitAgentModel("agent");

    expect(probeAgentModel).toHaveBeenCalledTimes(1);
  });

  test("a refusal is re-probed, because the operator may have fixed the server", async () => {
    probeAgentModel.mockImplementation(async () => REFUSAL);
    expect((await admitAgentModel("agent")).kind).toBe("refused");

    probeAgentModel.mockImplementation(async () => ({
      supported: true,
      capabilities: { toolCalling: true, structuredOutput: true, streaming: true },
    }));
    expect((await admitAgentModel("agent")).kind).toBe("allowed");
    expect(probeAgentModel).toHaveBeenCalledTimes(2);
  });

  test("a different model is a different question", async () => {
    // The cache key IS the configuration, so changing the model misses it without any
    // invalidation hook — which is the point of keying it that way.
    createAgentModel.mockImplementationOnce(async () => model("gemini-3.5-pro"));
    await admitAgentModel("agent");
    await admitAgentModel("agent");

    expect(probeAgentModel).toHaveBeenCalledTimes(2);
  });

  test("a model that cannot even be built admits the run", async () => {
    // An unconfigured provider says nothing about a model's capabilities, and the start
    // path must not gain a way to fail that it did not have.
    createAgentModel.mockImplementationOnce(async () => {
      throw new LLMConfigError("Gemini API key is required", "gemini");
    });

    const verdict = await admitAgentModel("agent");

    expect(verdict.kind).toBe("allowed");
    expect(probeAgentModel).not.toHaveBeenCalled();
  });
});
