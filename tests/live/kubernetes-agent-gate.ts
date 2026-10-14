/**
 * The live agent gate for Kubernetes: one agent run per workflow against a seeded throwaway k3d cluster of
 * docker/kubernetes/, driven by the configured model, with every request body sent to that model searched for the
 * values docker/kubernetes/sample.yaml plants.
 *
 * The runs act as the `secret-reader` persona, which may get and list Secrets in `shop`, so the Secret-name and
 * Secret-key rules meet Secrets the identity can really read: a gate run as an identity that is refused every Secret
 * would pass whether those rules held or not. The provider is opened under the read-only profile, as the agent
 * opens it, and each run is opened the way the start route opens it, with the workflow's statement language and its
 * variant's verifier, then driven by `runInvestigation` itself with the provider behind `acquireProvider`.
 *
 * It prints, per workflow, the verdict, how many reads came back at the per-statement row cap, and every planted
 * value found in a model request; it exits 1 if any was found. Of the repository's `.env` it reads only the `LLM_*`
 * keys `createAgentModel` reads, and it writes nothing inside the repository: the run ledgers live in a temporary
 * directory it removes.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/), with the cluster seeded by
 * docker/kubernetes/seed.sh and an LLM configured:
 *   K8S_ENV_DIR=<dir outside the repository> bun tests/live/kubernetes-agent-gate.ts
 */
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { persistedRunFacts, workflowAvailability } from "@/lib/agent/agent-manifest";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { runInvestigation } from "@/lib/agent/investigation";
import { createAgentModel } from "@/lib/agent/model-adapter";
import type { AgentFetch } from "@/lib/agent/provider-registry";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import type { AgentRunEvent, AgentRunWorkflowType } from "@/lib/agent/types";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { KubernetesProvider } from "@/lib/db/providers/platform/kubernetes/index";
import { importKubeconfig } from "@/lib/kubernetes/kubeconfig-import";
import type { QueryResult } from "@/lib/types";
import { KUBERNETES_SAMPLE_MARKERS as M } from "../helpers/kubernetes-markers";
import { connectionOf, insideDirectory } from "./kubernetes-evidence";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CLUSTER = "k8s-probe";
const PERSONA = "secret-reader";
const QUERY_TIMEOUT_MS = 30_000;
const KUBECTL_READ = "kubectl.query.read";

/** The question each workflow is asked, about the namespace the sample data plants its findings in. */
const OBJECTIVES: Readonly<Record<Exclude<AgentRunWorkflowType, "operations">, string>> = {
  investigation: "What is wrong in the shop namespace?",
  "data-analysis": "Which pods in shop restarted most?",
  "query-optimization": "Which containers in shop are over-provisioned?",
  "database-assessment": "Is the shop namespace healthy?",
};

/** Every planted value no model request may carry, the Secret value also in the base64 form the API answers it in. */
const PLANTED: Readonly<Record<string, string>> = {
  secretValue: M.secretValue,
  secretValueBase64: Buffer.from(M.secretValue, "utf8").toString("base64"),
  secretName: M.secretName,
  envValue: M.envValue,
  configMapValue: M.configMapValue,
  annotationValue: M.annotationValue,
  argsValue: M.argsValue,
  headerValue: M.headerValue,
};

/** The K8S_ENV_DIR seed.sh wrote, refused when unset, relative or inside the repository. */
function envDirectory(): string {
  const dir = process.env.K8S_ENV_DIR;
  if (dir === undefined || !path.isAbsolute(dir)) {
    throw new Error("set K8S_ENV_DIR to the absolute directory docker/kubernetes/seed.sh wrote");
  }
  if (insideDirectory(ROOT, dir)) throw new Error("K8S_ENV_DIR must be outside the repository: it holds tokens");
  return dir;
}

/** A fetch that keeps every request body it sends, as text, before sending it unchanged. */
function recordingFetch(bodies: string[]): AgentFetch {
  return async (input, init) => {
    if (typeof init?.body === "string") bodies.push(init.body);
    else if (init?.body !== undefined && init.body !== null) bodies.push(await new Response(init.body).text());
    else if (input instanceof Request) bodies.push(await input.clone().text());
    return fetch(input, init);
  };
}

/** The planted values each body carries, by marker name. */
function plantedIn(bodies: readonly string[]): string[] {
  return Object.entries(PLANTED).flatMap(([name, value]) =>
    bodies.some((body) => body.includes(value)) ? [name] : [],
  );
}

/** How many kubectl reads came back with as many rows as the per-statement cap admits. */
function readsAtCap(events: readonly AgentRunEvent[], cap: number): { readonly atCap: number; readonly reads: number } {
  const reads = events.flatMap((event) =>
    event.kind === "tool-completed" && event.artifact.operationId === KUBECTL_READ ? [event.artifact.summary] : [],
  );
  return { atCap: reads.filter((summary) => summary.rowCount >= cap).length, reads: reads.length };
}

interface GateRun {
  readonly workflowType: AgentRunWorkflowType;
  readonly verdict: string;
  readonly reads: number;
  readonly atCap: number;
  readonly hits: readonly string[];
}

/** One run of `workflowType` as the secret-reader persona, driven to its end. */
async function gateRun(
  workflowType: Exclude<AgentRunWorkflowType, "operations">,
  provider: KubernetesProvider,
  connection: ReturnType<typeof connectionOf>,
  dataDir: string,
): Promise<GateRun> {
  // A cold process per run: a run on a connection an earlier run read is grounded on that reading instead.
  forgetHeldSnapshots();
  const availability = workflowAvailability("agent", workflowType, "kubernetes");
  if (!availability.open) throw new Error(`${workflowType} does not open on kubernetes`);
  const facts = persistedRunFacts("agent", workflowType, availability);
  if (facts.statementLanguage !== "kubectl") throw new Error(`${workflowType} does not open as a kubectl run`);

  const store = new AgentRunStore({
    world: createLocalWorld({ dataDir: path.join(dataDir, workflowType), recoverActiveRuns: false }),
  });
  const tracker = new ExecutionBudgetTracker();
  const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 3_600_000, maxArtifacts: 180 });
  const service = new AgentRunService({ store, resources: { tracker, artifacts } });
  const run = await service.start({
    mode: "agent",
    workflowType,
    ...facts,
    actor: { sessionId: "kubernetes-agent-gate", role: "user" },
    connectionId: connection.id,
    objective: OBJECTIVES[workflowType],
  });

  const bodies: string[] = [];
  const budget = AGENT_WORKFLOW_BUDGETS[workflowType];
  await runInvestigation(run.runId, {
    service,
    model: await createAgentModel({ fetch: recordingFetch(bodies) }),
    resources: {
      connection,
      capabilities: provider.getCapabilities(),
      labels: provider.getLabels(),
      registry: createCanonicalOperationRegistry(),
      scope: createTargetScope(connection.id),
      tracker,
      artifacts,
      deadline: new AgentRunDeadline(budget.runDeadlineMs),
      repairs: new AgentRepairLedger(),
      acquireProvider: async () => provider,
    },
  });

  const view = await store.read(run.runId);
  if (!view) throw new Error(`run ${run.runId} has no ledger`);
  const finished = view.record.events.find((event) => event.kind === "run-finished");
  if (finished?.kind !== "run-finished") throw new Error(`${workflowType}: the run did not finish`);
  const goal = finished.goalVerdict;
  const verdict =
    goal === undefined
      ? `no verdict (${finished.stopReason ?? finished.reason ?? "no reason"})`
      : `${goal.outcome} by ${goal.verifier}${goal.unmet === undefined ? "" : `, unmet: ${goal.unmet.join(", ")}`}`;
  const cap = readsAtCap(view.record.events, budget.policy.budgets.maxResultRows);
  return { workflowType, verdict, ...cap, hits: plantedIn(bodies) };
}

async function main(): Promise<number> {
  const file = path.join(envDirectory(), CLUSTER, `${PERSONA}.yaml`);
  const imported = importKubeconfig(readFileSync(file, "utf8"));
  const context = imported.contexts[0];
  if (context === undefined) throw new Error(`${file}: ${imported.refusals.join(" ")}`);
  const connection = { ...connectionOf(context, PERSONA), id: "kubernetes-agent-gate", name: "kubernetes agent gate" };

  const provider = new KubernetesProvider(connection, { queryTimeout: QUERY_TIMEOUT_MS }, {}, { readOnly: true });
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "kubernetes-agent-gate-"));
  const runs: GateRun[] = [];
  try {
    await provider.connect();
    for (const workflowType of Object.keys(OBJECTIVES) as (keyof typeof OBJECTIVES)[]) {
      // One run at a time on purpose: each starts from a cold snapshot cache, which a parallel run would refill.
      // oxlint-disable-next-line no-await-in-loop
      const run = await gateRun(workflowType, provider, connection, dataDir);
      runs.push(run);
      console.log(
        `${run.workflowType}: ${run.verdict}; ${run.atCap} of ${run.reads} reads at the row cap; ` +
          (run.hits.length === 0 ? "no planted value found" : `PLANTED VALUES FOUND: ${run.hits.join(", ")}`),
      );
    }
  } finally {
    await provider.disconnect();
    rmSync(dataDir, { recursive: true, force: true });
  }
  return runs.some((run) => run.hits.length > 0) ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
