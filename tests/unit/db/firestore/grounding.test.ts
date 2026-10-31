/**
 * What plan mode and agent mode are told about a Firestore connection: collection ids reach grounding through the
 * enumerable `collection` kind, each with `__name__` as its one column, and nothing read from a document does, since
 * the walk skips the key-browser `document` kind and the bulk describe samples nothing. Every listing the walk sends
 * is charged to the run's read allowance, and a walk that carries none sends nothing and tells the run why.
 */
import { describe, expect, test } from "bun:test";
import { captureContextSnapshot, packContextForTask } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { languageServerPack } from "@/lib/agent/languages/server";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import type { AgentToolContext } from "@/lib/agent/tools";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { FirestoreProvider } from "@/lib/db/providers/document/firestore";
import { FIRESTORE_AGENT_WITHHELD } from "@/lib/db/providers/document/firestore/agent-surface";
import { RunReadAllowance } from "@/lib/db/read-allowance";
import type { ProviderExecutionContext, QueryResult } from "@/lib/db/types";
import { fakeSeams, jsonAnswer } from "../../../helpers/firestore-seams";
import { firestoreConnection, googleServer, requestsOf, wire } from "../../../helpers/firestore-provider";

const MARKER = "marker-field-value";

/** The run's harness with the provider behind it, as the S3 and Oxia grounding tests build it. */
function agentContext(
  provider: FirestoreProvider,
  mode: AgentToolContext["mode"],
  readAllowance?: RunReadAllowance,
): AgentToolContext {
  const clock = () => 1_000;
  const connection = firestoreConnection();
  return {
    runId: "run-firestore",
    modelId: "unmeasured-model-for-tests",
    mode,
    workflowType: "investigation",
    ...(mode === "agent" ? { statementLanguage: "fsquery" as const } : {}),
    actor: { sessionId: "session-1", role: "user" },
    connection,
    capabilities: provider.getCapabilities(),
    labels: provider.getLabels(),
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(connection.id),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2, clock),
    repairs: new AgentRepairLedger(),
    acquireProvider: async () => provider,
    clock,
    ...(readAllowance === undefined ? {} : { readAllowance }),
  };
}

/** Two root collections, and a document whose fields carry a marker if anything ever read one. */
const SERVER = googleServer(undefined, (request) =>
  request.path.endsWith(":listCollectionIds")
    ? jsonAnswer({ collectionIds: ["users", "orders"] })
    : jsonAnswer([{ document: { name: "x/users/alice", fields: { ssn: { stringValue: MARKER } } } }]),
);

async function opened(execution: ProviderExecutionContext) {
  const seams = fakeSeams({ answer: wire(SERVER) });
  const provider = new FirestoreProvider(firestoreConnection(), { queryTimeout: 30_000 }, execution, seams);
  await provider.connect();
  const probes = requestsOf(seams).length;
  return { provider, sent: () => requestsOf(seams).slice(probes) };
}

describe("grounding on Firestore", () => {
  test.each([
    ["plan mode, under the operations profile", { readOnly: true }, "planning"],
    ["agent mode, under the read-only profile", { readOnly: true, sendsStatements: true }, "agent"],
  ] as const)("%s: collection ids with __name__ alone, every listing charged", async (_name, execution, mode) => {
    const { provider, sent } = await opened(execution);
    const allowance = new RunReadAllowance(100);

    const capture = await captureContextSnapshot(agentContext(provider, mode, allowance));

    expect(capture.kind).toBe("captured");
    if (capture.kind !== "captured") return;
    expect(
      capture.snapshot.objects.map((object) => [object.kind, object.name, object.columns.map((c) => c.name)]),
    ).toEqual([
      ["collection", "orders", ["__name__"]],
      ["collection", "users", ["__name__"]],
    ]);
    expect(JSON.stringify(capture)).not.toContain(MARKER);
    expect(JSON.stringify(capture)).not.toContain("alice");
    // The count, the listing and the bulk describe each read the root ids once: three listings, three billed reads,
    // and no request that reads a document.
    expect(sent().map((request) => request.path.split(":").at(-1))).toEqual([
      "listCollectionIds",
      "listCollectionIds",
      "listCollectionIds",
    ]);
    expect(allowance.spent()).toBe(3);
    const packed = packContextForTask(capture.snapshot, "how many users are there");
    expect(packed).not.toContain(MARKER);
  });

  test("a walk with no allowance sends nothing and tells the run why no collection is listed", async () => {
    const { provider, sent } = await opened({ readOnly: true });

    const capture = await captureContextSnapshot(agentContext(provider, "planning"));

    expect(capture.kind).toBe("captured");
    if (capture.kind !== "captured") return;
    expect(capture.snapshot.objects).toEqual([]);
    expect(JSON.stringify(capture.snapshot.kinds)).toContain(FIRESTORE_AGENT_WITHHELD.noAllowance);
    expect(sent()).toEqual([]);
  });

  test("a walk past the allowance loses the capture rather than reading on uncharged", async () => {
    const { provider, sent } = await opened({ readOnly: true });
    const allowance = new RunReadAllowance(1);

    const capture = await captureContextSnapshot(agentContext(provider, "planning", allowance));

    expect(capture.kind).toBe("unavailable");
    expect(sent()).toHaveLength(1);
    expect(allowance.spent()).toBe(1);
  });

  test("the advice claims only what the snapshot keeps: ids and __name__, never a field or a value", () => {
    const advice = languageServerPack("fsquery").grounding.omissionAdvice;
    expect(advice).toContain("each with __name__ as its one column");
    expect(advice).toContain("no document id, field name or field value is listed");
  });
});
