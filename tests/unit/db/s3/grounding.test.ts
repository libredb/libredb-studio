/**
 * What plan mode is told about an S3 connection: bucket
 * names reach grounding through the enumerable `bucket` kind; object keys never do, because the agent's walk skips
 * key-browser kinds. The capture reads the bucket list once, and nothing on a pinned connection.
 */
import { describe, expect, test } from "bun:test";
import { captureContextSnapshot } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import type { AgentToolContext } from "@/lib/agent/tools";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import type { QueryResult } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { s3Connection } from "../../../helpers/s3-connection";
import {
  bucketsXml,
  type FakeS3Handler,
  fakeS3Transport,
  objectsXml,
  xmlAnswer,
} from "../../../helpers/s3-fake-transport";

/** A root-level key, so the pinned probe's level page (prefix "", delimiter "/") is one a server may send. */
const SECRET_KEY = "tenant-secret-marker-report.csv";

/** The context-snapshot suite's harness with the provider behind it, as the Oxia grounding test builds it. */
function agentContext(provider: S3Provider, connection: DatabaseConnection): AgentToolContext {
  const clock = () => 1_000;
  return {
    runId: "run-s3",
    modelId: "unmeasured-model-for-tests",
    mode: "planning",
    workflowType: "investigation",
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
  };
}

/** Bucket lists and, if anything asked, a listing that would carry a secret key name. */
const HANDLER: FakeS3Handler = (request) =>
  request.target.path === "/"
    ? xmlAnswer(bucketsXml(["archive", "sales"]))
    : xmlAnswer(objectsXml({ keys: [SECRET_KEY] }));

describe("plan-mode grounding on S3", () => {
  test("unpinned: the inventory holds the bucket rows, read from one bucket list, and no object key", async () => {
    const connection = s3Connection({ id: "s3-grounding" });
    const fake = fakeS3Transport(HANDLER);
    const provider = new S3Provider(connection, {}, {}, { createTransport: fake.createTransport });
    await provider.connect();
    const before = fake.exchanges.length;

    const capture = await captureContextSnapshot(agentContext(provider, connection));

    expect(capture.kind).toBe("captured");
    if (capture.kind !== "captured") return;
    expect(capture.snapshot.objects.map((object) => [object.kind, object.name])).toEqual([
      ["bucket", "archive"],
      ["bucket", "sales"],
    ]);
    expect(JSON.stringify(capture)).not.toContain("tenant-secret-marker");
    // The count and the listing of the countIsListing kind are answered by one ListBuckets, and no ListObjectsV2 is sent.
    expect(fake.lines().slice(before)).toEqual(["GET /?max-buckets=10000"]);
  });

  test("pinned: the one bucket, with no request at all", async () => {
    const connection = s3Connection({ id: "s3-grounding-pinned", database: "sales" });
    const fake = fakeS3Transport(HANDLER);
    const provider = new S3Provider(connection, {}, {}, { createTransport: fake.createTransport });
    await provider.connect();
    const before = fake.exchanges.length;

    const capture = await captureContextSnapshot(agentContext(provider, connection));

    expect(capture.kind).toBe("captured");
    if (capture.kind !== "captured") return;
    expect(capture.snapshot.objects.map((object) => object.name)).toEqual(["sales"]);
    expect(fake.exchanges.length).toBe(before);
  });
});
