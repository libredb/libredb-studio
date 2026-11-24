/**
 * The tool definitions kubectl's workflows are offered (#1821): the statement tool for a kubectl read, the resources
 * card, and the two readings only a cluster has.
 */
import { z } from "zod";
import { clusterUsageReadInput, clusterWorkloadsReadInput } from "@/lib/db/operations/descriptors";
import { parseQuantity } from "@/lib/languages/kubectl/quantity";
import { AGENT_EVIDENCE_CONTRACT, evidenceSchema } from "../../tool-contracts";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentEvidenceReference } from "../../types";
import type { AgentLanguageServerPack, AgentRecommendationCard } from "../pack";

/**
 * A Kubernetes quantity as a manifest states one: `250m`, `0.5`, `512Mi`, `1Gi`. Read by the same parser that reads
 * the cluster's own figures, so a value this accepts is one the API server would accept too.
 */
const resourceQuantity = z
  .string()
  .min(1)
  .max(32)
  .refine((text) => parseQuantity(text) !== undefined, "not a Kubernetes quantity, such as 250m, 0.5, 512Mi or 1Gi");
const resourceQuantities = z.strictObject({ cpu: resourceQuantity.optional(), memory: resourceQuantity.optional() });
const resourceSettings = z.strictObject({ requests: resourceQuantities, limits: resourceQuantities });

/**
 * The resource-efficiency card: one container's requests and limits, as they are and as the run proposes them.
 *
 * No `statement`: the change is to a workload's manifest, which nothing here writes and no editor runs, so there is
 * nothing to hand over. The owner is named so the user knows which manifest holds the container. `rationale` and
 * `evidence` are declared as `recommendationSchema` declares them, against the same evidence schema.
 */
const resourcesRecommendationSchema = z.strictObject({
  change: z.literal("resources"),
  namespace: z.string().min(1),
  // Any kind `inspect_usage` reports: a database operator's custom resource owns pods as a Deployment does.
  ownerKind: z.string().min(1),
  ownerName: z.string().min(1),
  container: z.string().min(1),
  current: resourceSettings,
  proposed: resourceSettings,
  rationale: z.string().min(1),
  evidence: z.array(evidenceSchema).min(1),
});

/** The resources card's record, once the core has verified its evidence: the container's new settings, as proposed. */
export const KUBECTL_RESOURCES_CARD = Object.freeze<
  AgentRecommendationCard<z.infer<typeof resourcesRecommendationSchema>>
>({
  inputSchema: resourcesRecommendationSchema,
  record(_events, card) {
    const { container, ownerKind, ownerName } = card;
    return {
      kind: "recommended",
      recommendation: {
        ...card,
        // Carried by the schema's `.min(1)`, as on the statement card.
        evidence: card.evidence as [AgentEvidenceReference, ...AgentEvidenceReference[]],
      },
      // The container and the owner are text the model itself sent in this call, so quoting them back adds no
      // untrusted content.
      modelText: `Recommendation recorded: new requests and limits for container ${container} of ${ownerKind}/${ownerName}, offered to the user and not applied. It is theirs to apply.`,
    };
  },
});

const readKubectlStatementSchema = z.strictObject({
  statement: z.string().min(1),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

const KUBECTL_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    "Run one bounded read-only kubectl statement: get, describe, logs, top, events, api-resources, api-versions, explain, auth can-i, auth whoami or version, with or without the kubectl word. Writes, exec, port-forward, proxy, watches and Studio's paging line are refused before the cluster is reached, and you are told why.",
  inputSchema: readKubectlStatementSchema,
  operationId: "kubectl.query.read",
});

/** The kubectl overrides every kubectl workflow that sends a statement shares. */
const KUBECTL_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: KUBECTL_RUN_READ_QUERY,
});

const KUBECTL_RECOMMEND_CHANGE: AgentToolDefinition = Object.freeze({
  name: "recommend_change",
  description: `Propose one change to one container's CPU and memory requests and limits, for the user to apply themselves. Nothing is applied by this run and nothing here changes the cluster. State the current and the proposed values as Kubernetes quantities, and cite the inspect_usage reading the change rests on. ${AGENT_EVIDENCE_CONTRACT}`,
  inputSchema: resourcesRecommendationSchema,
});

/**
 * Resource efficiency, the kubectl query-optimization: the statement tools plus the resources card. Only this variant
 * proposes a change to a container's resources, so only it replaces `recommend_change`.
 */
const KUBECTL_RESOURCE_EFFICIENCY_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  ...KUBECTL_STATEMENT_TOOLS,
  recommend_change: KUBECTL_RECOMMEND_CHANGE,
});

/** Kubectl `operations` sends no statement, so it replaces nothing. */
export const KUBECTL_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: KUBECTL_STATEMENT_TOOLS,
  "query-optimization": KUBECTL_RESOURCE_EFFICIENCY_TOOLS,
  "database-assessment": KUBECTL_STATEMENT_TOOLS,
  "data-analysis": KUBECTL_STATEMENT_TOOLS,
});

/** The two readings only a cluster answers, defined once beside every other tool in `AGENT_TOOL_DEFINITIONS`. */
export const KUBECTL_BASE_DEFINITIONS = Object.freeze({
  inspect_usage: {
    name: "inspect_usage",
    description:
      "Read how much CPU and memory each container in one namespace uses right now, against its requests and limits. Pass namespace, and a label selector to narrow it. One row per container: its pod and owning workload, CPU in millicores and memory in bytes as numbers, its requests and limits, and usage divided by request. The figures are metrics-server's latest sample over its window, a moment and not a history. More than 500 containers are refused: narrow by selector.",
    inputSchema: clusterUsageReadInput,
    operationId: "cluster.usage.read",
  },
  profile_workloads: {
    name: "profile_workloads",
    description:
      "Profile the workloads of one namespace: one row per Deployment, StatefulSet, DaemonSet, Job, CronJob and bare Pod, and one per other controller that owns a pod there (an operator's custom resource, a Rollout, an orphan ReplicaSet) with no desired count, with desired and ready counts in the kind's own terms, pods not ready, cumulative restarts with the latest termination's reason and time, how many containers run without requests, limits, a readiness probe or a liveness probe, and the Warning events by reason. Pass namespace. More than 500 workloads are refused.",
    inputSchema: clusterWorkloadsReadInput,
    operationId: "cluster.workloads.read",
  },
} satisfies Partial<Record<AgentToolName, AgentToolDefinition>>);
