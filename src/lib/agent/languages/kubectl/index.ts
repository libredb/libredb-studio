/**
 * kubectl as one pack (#1821): its client and server facets and what the run loop executes. Its variants offer reads
 * and curated readings only, so it has no tool arms; its two curated readings are evidence tools (`./tools.ts`).
 * Execution tier, above `tools.ts`.
 */
import { clusterUsageReadInput, clusterWorkloadsReadInput } from "@/lib/db/operations/descriptors";
import type { ClusterUsageInput } from "@/lib/db/types";
import type { AgentArtifactReference, AgentToolRefusal } from "../../types";
import type { AgentLanguagePack } from "../pack";
import { KUBECTL_CLIENT_PACK, type KubectlEvidenceEvent } from "./client";
import { KUBECTL_SERVER_PACK } from "./server";
import { inspectUsageTool, profileWorkloadsTool } from "./tools";

/**
 * A cluster that serves no usage metrics writes `usage-unavailable` for the namespace the call named: the refusal alone
 * cannot tell the verdict that the cluster, not the run, is why usage was never measured.
 */
function metricsUnavailable(refusal: AgentToolRefusal, input: ClusterUsageInput): KubectlEvidenceEvent | null {
  return refusal.class === "reading-refused" && refusal.reasonCode === "METRICS_UNAVAILABLE"
    ? { kind: "usage-unavailable", namespace: input.namespace }
    : null;
}

export const KUBECTL_PACK = Object.freeze({
  id: "kubectl",
  client: KUBECTL_CLIENT_PACK,
  server: KUBECTL_SERVER_PACK,
  execution: Object.freeze({
    arms: Object.freeze({}),
    evidenceTools: Object.freeze({
      inspect_usage: Object.freeze({
        input: clusterUsageReadInput,
        run: inspectUsageTool,
        event: "usage-read",
        completed: (artifact: AgentArtifactReference, input: ClusterUsageInput): KubectlEvidenceEvent => ({
          kind: "usage-read",
          artifact,
          namespace: input.namespace,
          ...(input.selector === undefined ? {} : { selector: input.selector }),
        }),
        refused: metricsUnavailable,
      }),
      profile_workloads: Object.freeze({
        input: clusterWorkloadsReadInput,
        run: profileWorkloadsTool,
        event: "workloads-profiled",
        completed: (artifact: AgentArtifactReference, input: ClusterUsageInput): KubectlEvidenceEvent => ({
          kind: "workloads-profiled",
          artifact,
          namespace: input.namespace,
        }),
        refused: metricsUnavailable,
      }),
    }),
  }),
} satisfies AgentLanguagePack);
