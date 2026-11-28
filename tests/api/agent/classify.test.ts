/**
 * `POST /api/agent/classify` — the endpoint the rail calls between the Start press
 * and the run opening
 * (`docs/superpowers/specs/2026-08-16-agent-workflow-inference-design.md`).
 *
 * What these pin, beyond the shape checks: the session is verified before the
 * runtime flag is read, so an unauthenticated caller cannot use this route to learn
 * whether an agent surface exists here; and the route never turns a classifier
 * outcome into an error, because the classifier's whole contract is that it always
 * answers.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { configureAgentModel, restoreAgentModel } from "../../helpers/agent-model-env";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { AGENT_ENABLED_ENV } from "@/lib/agent/config";
import { AGENT_MAX_OBJECTIVE_LENGTH } from "@/lib/agent/execution-policy";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import * as realAuth from "@/lib/auth";
import * as realClassifier from "@/lib/agent/workflow-classifier";
import * as realSeed from "@/lib/seed/resolve-connection";
import { legacyAgentEngine, notReviewedSentence, openWorkflows } from "@/lib/agent/agent-manifest";
import { noAdapterSentence } from "@/lib/agent/posture";
import { servedEngineRecord, serverCatalogInstalled } from "@/lib/db/server-catalog";
import { AGENT_PACKAGE_ENGINES, agentPackageCatalog } from "../../helpers/agent-package-catalog";
import { craftedCatalog, withCatalog } from "../../helpers/package-catalog";
import { servedResolveOver } from "../../helpers/served-resolve";

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "ada" }),
);

const mockClassify = mock<typeof realClassifier.classifyAgentWorkflow>(async () => ({
  workflowType: "query-optimization",
  outcome: "classified",
}));

const mockResolveConnection = mock(async (body: { connectionId?: string }) => ({
  id: body.connectionId ?? "seed:sales",
  name: "Sales",
  type: "postgres",
}));

/**
 * Re-applied in `beforeEach` as well as at import time: `mock.module` replaces a
 * module process-wide, so the file currently running has to own the module whatever
 * order the runner loaded the agent suites in.
 */
function installMocks(): void {
  mock.module("@/lib/auth", () => ({
    ...realAuth,
    getSession: mockGetSession,
    readSession: mock(async () => {
      const s = await mockGetSession();
      return s ? { kind: "authenticated", session: s } : { kind: "anonymous" };
    }),
  }));
  mock.module("@/lib/agent/workflow-classifier", () => ({
    ...realClassifier,
    classifyAgentWorkflow: mockClassify,
  }));
  mock.module("@/lib/seed/resolve-connection", () => ({
    ...realSeed,
    resolveServedConnection: servedResolveOver(mockResolveConnection),
  }));
}

installMocks();

const { POST } = await import("@/app/api/agent/classify/route");

function classifyRequest(body: unknown): Request {
  return createMockRequest("/api/agent/classify", { method: "POST", body });
}

beforeEach(() => {
  installMocks();
  clearRateLimitState();
  mockGetSession.mockResolvedValue({ role: "user", username: "ada" });
  delete process.env[AGENT_ENABLED_ENV];
  configureAgentModel();
  mockClassify.mockClear();
  mockResolveConnection.mockClear();
  mockClassify.mockImplementation(async () => ({ workflowType: "query-optimization", outcome: "classified" }));
});

afterEach(() => {
  restoreAgentModel();
});

describe("POST /api/agent/classify", () => {
  test("an unauthenticated caller is refused before anything is classified", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST(classifyRequest({ objective: "why is checkout slow" }));

    expect(res.status).toBe(401);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  /*
    The order matters and is the reason this test exists beside the one above: the
    401 is decided before the runtime flag is read, so the 404 is only ever visible
    to a caller who already has a session. An unauthenticated probe of this route
    learns nothing about whether the operator enabled an agent.
  */
  test("the surface does not exist once the operator switches the agent off", async () => {
    process.env[AGENT_ENABLED_ENV] = "false";

    const res = await POST(classifyRequest({ objective: "why is checkout slow" }));
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(404);
    expect(body.error).toBe("The agent runtime is not enabled on this server");
    expect(mockClassify).not.toHaveBeenCalled();
  });

  /*
    Governance mode holds the agent off in this version (docs/GOVERNANCE.md): the same
    404 as the operator's off-switch, after the session check and before the body or
    the connection is read, with a model configured.
  */
  test("governance: classify answers 404", async () => {
    const saved = process.env.GOVERNANCE_SOURCE;
    process.env.GOVERNANCE_SOURCE = "postgres";
    try {
      const res = await POST(classifyRequest({ objective: "why is checkout slow", connectionId: "seed:sales" }));
      const body = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(404);
      expect(body.error).toBe("The agent runtime is not enabled on this server");
      expect(mockResolveConnection).not.toHaveBeenCalled();
      expect(mockClassify).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.GOVERNANCE_SOURCE;
      else process.env.GOVERNANCE_SOURCE = saved;
    }
  });

  test("a body that is not JSON is refused", async () => {
    const res = await POST(
      new Request("http://localhost/api/agent/classify", { method: "POST", body: "not json at all" }),
    );
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(body.error).toBe("Request body must be JSON");
    expect(mockClassify).not.toHaveBeenCalled();
  });

  test("a missing objective is refused", async () => {
    const res = await POST(classifyRequest({}));
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(body.error).toBe("objective must be a non-empty string");
    expect(mockClassify).not.toHaveBeenCalled();
  });

  test("an objective of nothing but whitespace is refused", async () => {
    const res = await POST(classifyRequest({ objective: "   \n  " }));

    expect(res.status).toBe(400);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  test("an objective past the run route's own bound is refused", async () => {
    const res = await POST(classifyRequest({ objective: "x".repeat(AGENT_MAX_OBJECTIVE_LENGTH + 1) }));
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(body.error).toBe(`objective must be at most ${AGENT_MAX_OBJECTIVE_LENGTH} characters`);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  test("a classified objective answers with the workflow the classifier named", async () => {
    const res = await POST(classifyRequest({ objective: "this update takes 40 seconds, why" }));
    const body = await parseResponseJSON<{ workflowType: string; outcome: string }>(res);

    expect(res.status).toBe(200);
    expect(body).toEqual({ workflowType: "query-optimization", outcome: "classified" });
    expect(mockClassify).toHaveBeenCalledWith("this update takes 40 seconds, why");
  });

  test("a Kubernetes connection is classified in kubectl's own terms", async () => {
    mockResolveConnection.mockResolvedValueOnce({ id: "seed:cluster", name: "Cluster", type: "kubernetes" });

    const res = await POST(
      classifyRequest({ objective: "which pods are over-provisioned", connectionId: "seed:cluster", mode: "agent" }),
    );

    expect(res.status).toBe(200);
    expect(mockResolveConnection).toHaveBeenCalledWith(
      { connectionId: "seed:cluster" },
      { role: "user", username: "ada" },
    );
    expect(mockClassify).toHaveBeenCalledWith("which pods are over-provisioned", {
      statementLanguage: "kubectl",
      workflows: openWorkflows("agent", legacyAgentEngine("kubernetes")),
    });
  });

  test("classifies in the statement language the connection's engine record grants", async () => {
    mockResolveConnection.mockResolvedValueOnce({ id: "seed:cluster", name: "Cluster", type: "kubernetes" });

    const res = await withCatalog(craftedCatalog({ kubernetes: { statementLanguage: "sql" } }), () =>
      POST(
        classifyRequest({ objective: "which pods are over-provisioned", connectionId: "seed:cluster", mode: "agent" }),
      ),
    );

    expect(res.status).toBe(200);
    // The workflows are the ones availability opens on the same record: SQL's variants need a composed catalog read,
    // which no SQL dialect of Kubernetes supplies, so only the operations workflow opens.
    expect(mockClassify).toHaveBeenCalledWith("which pods are over-provisioned", {
      statementLanguage: "sql",
      workflows: ["operations"],
    });
    expect(openWorkflows("agent", legacyAgentEngine("kubernetes"))).toContain("investigation");
    expect(serverCatalogInstalled()).toBe(false);
  });

  test("an SQL connection is classified in SQL's terms", async () => {
    const res = await POST(
      classifyRequest({ objective: "why is checkout slow", connectionId: "seed:sales", mode: "agent" }),
    );

    expect(res.status).toBe(200);
    expect(mockClassify).toHaveBeenCalledWith("why is checkout slow", {
      statementLanguage: "sql",
      workflows: openWorkflows("agent", legacyAgentEngine("postgres")),
    });
  });

  test("a LibreDB connection is classified in its own family's terms", async () => {
    mockResolveConnection.mockResolvedValueOnce({ id: "seed:store", name: "Store", type: "libredb" });

    const res = await POST(
      classifyRequest({ objective: "which keys hold a role", connectionId: "seed:store", mode: "agent" }),
    );

    expect(res.status).toBe(200);
    expect(mockClassify).toHaveBeenCalledWith("which keys hold a role", {
      statementLanguage: "libredbkv",
      workflows: openWorkflows("agent", legacyAgentEngine("libredb")),
    });
  });

  test("an InfluxDB (InfluxQL) connection is classified in its own family's terms", async () => {
    mockResolveConnection.mockResolvedValueOnce({ id: "seed:metrics", name: "Metrics", type: "influxdb" });

    const res = await POST(
      classifyRequest({ objective: "which room ran hottest", connectionId: "seed:metrics", mode: "agent" }),
    );

    expect(res.status).toBe(200);
    expect(mockClassify).toHaveBeenCalledWith("which room ran hottest", {
      statementLanguage: "influxql",
      workflows: openWorkflows("agent", legacyAgentEngine("influxdb")),
    });
  });

  test("a Weaviate connection is classified in its own family's terms", async () => {
    mockResolveConnection.mockResolvedValueOnce({ id: "seed:vectors", name: "Vectors", type: "weaviate" });

    const res = await POST(
      classifyRequest({
        objective: "how many objects each collection holds",
        connectionId: "seed:vectors",
        mode: "agent",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockClassify).toHaveBeenCalledWith("how many objects each collection holds", {
      statementLanguage: "weaviateapi",
      workflows: openWorkflows("agent", legacyAgentEngine("weaviate")),
    });
  });

  test("a Qdrant connection is classified in its own family's terms", async () => {
    mockResolveConnection.mockResolvedValueOnce({ id: "seed:points", name: "Points", type: "qdrant" });

    const res = await POST(
      classifyRequest({
        objective: "how many points each collection holds",
        connectionId: "seed:points",
        mode: "agent",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockClassify).toHaveBeenCalledWith("how many points each collection holds", {
      statementLanguage: "qdrantapi",
      workflows: openWorkflows("agent", legacyAgentEngine("qdrant")),
    });
  });

  test("a Neo4j connection is classified in its own family's terms", async () => {
    mockResolveConnection.mockResolvedValueOnce({ id: "seed:graph", name: "Graph", type: "neo4j" });

    const res = await POST(classifyRequest({ objective: "who knows whom", connectionId: "seed:graph", mode: "agent" }));

    expect(res.status).toBe(200);
    expect(mockClassify).toHaveBeenCalledWith("who knows whom", {
      statementLanguage: "cypher",
      workflows: openWorkflows("agent", legacyAgentEngine("neo4j")),
    });
  });

  test("a Milvus connection is classified in its own family's terms", async () => {
    mockResolveConnection.mockResolvedValueOnce({ id: "seed:vectors", name: "Vectors", type: "milvus" });

    const res = await POST(
      classifyRequest({ objective: "which collections are loaded", connectionId: "seed:vectors", mode: "agent" }),
    );

    expect(res.status).toBe(200);
    expect(mockClassify).toHaveBeenCalledWith("which collections are loaded", {
      statementLanguage: "milvusrpc",
      workflows: openWorkflows("agent", legacyAgentEngine("milvus")),
    });
  });

  test("a Redis connection is classified in its own family's terms", async () => {
    mockResolveConnection.mockResolvedValueOnce({ id: "seed:cache", name: "Cache", type: "redis" });

    const res = await POST(
      classifyRequest({ objective: "how many keys are there", connectionId: "seed:cache", mode: "agent" }),
    );

    expect(res.status).toBe(200);
    expect(mockClassify).toHaveBeenCalledWith("how many keys are there", {
      statementLanguage: "rediscli",
      workflows: openWorkflows("agent", legacyAgentEngine("redis")),
    });
  });

  test("a connection with no statement language is classified in SQL's terms", async () => {
    mockResolveConnection.mockResolvedValueOnce({ id: "seed:lake", name: "Lake", type: "spark" });

    const res = await POST(
      classifyRequest({ objective: "what is connected", connectionId: "seed:lake", mode: "agent" }),
    );

    expect(res.status).toBe(200);
    expect(mockClassify).toHaveBeenCalledWith("what is connected", {
      statementLanguage: undefined,
      workflows: openWorkflows("agent", legacyAgentEngine("spark")),
    });
  });

  /*
    F2: the classifier is offered only the workflows a run on the connection opens in the run's mode, so an
    Automatic run is never classified into a workflow Start then refuses. In agent mode these four engines offer no
    operations reading, so the operations workflow does not open there; plan mode opens every workflow.
  */
  test.each(["mqtt", "sparkplug", "opcua", "mtconnect"] as const)(
    "an agent-mode run on %s is offered no operations workflow",
    async (type) => {
      mockResolveConnection.mockResolvedValueOnce({ id: "seed:plant", name: "Plant", type });

      const res = await POST(
        classifyRequest({ objective: "why is the line slow", connectionId: "seed:plant", mode: "agent" }),
      );

      expect(res.status).toBe(200);
      expect(mockClassify).toHaveBeenCalledTimes(1);
      const [, options] = mockClassify.mock.calls[0];
      expect(options?.workflows).toEqual(["investigation"]);
    },
  );

  test.each(["mqtt", "sparkplug", "opcua", "mtconnect"] as const)(
    "a plan-mode run on %s is offered every workflow",
    async (type) => {
      mockResolveConnection.mockResolvedValueOnce({ id: "seed:plant", name: "Plant", type });

      const res = await POST(
        classifyRequest({ objective: "why is the line slow", connectionId: "seed:plant", mode: "planning" }),
      );

      expect(res.status).toBe(200);
      const [, options] = mockClassify.mock.calls[0];
      expect(options?.workflows).toEqual([
        "investigation",
        "query-optimization",
        "database-assessment",
        "operations",
        "data-analysis",
      ]);
    },
  );

  test("an agent-mode run on an engine with no statement language is offered only the operations workflow", async () => {
    mockResolveConnection.mockResolvedValueOnce({ id: "seed:lake", name: "Lake", type: "spark" });

    const res = await POST(classifyRequest({ objective: "what is running", connectionId: "seed:lake", mode: "agent" }));

    expect(res.status).toBe(200);
    expect(mockClassify).toHaveBeenCalledWith("what is running", {
      statementLanguage: undefined,
      workflows: ["operations"],
    });
  });

  test("classify answers a package engine's connection", async () => {
    const { BARE, REQUESTING, READING } = AGENT_PACKAGE_ENGINES;
    await withCatalog(agentPackageCatalog(), async () => {
      const post = async (type: string, mode: string) => {
        mockResolveConnection.mockResolvedValueOnce({ id: "seed:acme", name: "Acme", type });
        const res = await POST(classifyRequest({ objective: "what is slow", connectionId: "seed:acme", mode }));
        return { status: res.status, body: await parseResponseJSON<Record<string, unknown>>(res) };
      };

      // Plan mode opens every workflow on a package engine with no register row, in SQL's terms.
      expect(await post(BARE, "planning")).toEqual({
        status: 200,
        body: { workflowType: "query-optimization", outcome: "classified" },
      });
      expect(mockClassify).toHaveBeenLastCalledWith("what is slow", {
        statementLanguage: undefined,
        workflows: ["investigation", "query-optimization", "database-assessment", "operations", "data-analysis"],
      });

      // Agent mode opens nothing on a package engine with no row: refused by name, the classifier never asked.
      mockClassify.mockClear();
      const bare = servedEngineRecord(BARE);
      expect(await post(BARE, "agent")).toEqual({
        status: 400,
        body: { error: noAdapterSentence(bare.displayName, false), refused: "engine-unsupported" },
      });
      const requesting = servedEngineRecord(REQUESTING);
      expect(await post(REQUESTING, "agent")).toEqual({
        status: 400,
        body: { error: notReviewedSentence(requesting.displayName, false), refused: "engine-unsupported" },
      });
      expect(mockClassify).not.toHaveBeenCalled();

      // A package engine whose row grants one reading is offered only the operations workflow.
      expect((await post(READING, "agent")).status).toBe(200);
      expect(mockClassify).toHaveBeenCalledWith("what is slow", {
        statementLanguage: undefined,
        workflows: ["operations"],
      });
    });
  });

  test("a connection without a mode is refused before it is resolved", async () => {
    const res = await POST(classifyRequest({ objective: "why is checkout slow", connectionId: "seed:sales" }));
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(body.error).toBe('mode must be "planning" or "agent" when connectionId is provided');
    expect(mockResolveConnection).not.toHaveBeenCalled();
    expect(mockClassify).not.toHaveBeenCalled();
  });

  test.each([["plan"], [42], [""]])("a mode of %p is refused", async (mode) => {
    const res = await POST(classifyRequest({ objective: "why is checkout slow", connectionId: "seed:sales", mode }));
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(body.error).toBe('mode must be "planning" or "agent" when connectionId is provided');
    expect(mockResolveConnection).not.toHaveBeenCalled();
    expect(mockClassify).not.toHaveBeenCalled();
  });

  test("with no connection id nothing is resolved and no language is passed", async () => {
    const res = await POST(classifyRequest({ objective: "why is checkout slow" }));

    expect(res.status).toBe(200);
    expect(mockResolveConnection).not.toHaveBeenCalled();
    expect(mockClassify).toHaveBeenCalledWith("why is checkout slow");
  });

  test.each([[42], [""], ["   "]])("a connection id of %p is refused", async (connectionId) => {
    const res = await POST(classifyRequest({ objective: "why is checkout slow", connectionId }));
    const body = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(body.error).toBe("connectionId must be a non-empty string when provided");
    expect(mockClassify).not.toHaveBeenCalled();
  });

  /*
    The fallback is a 200, not an error. The classifier resolves rather than rejects
    for exactly this reason: the rail is about to open a run that works either way,
    and `outcome` is what lets it say "opened as Ask, could not classify" instead of
    presenting the default as a verdict.
  */
  test("an unclassified objective is a successful answer carrying the fallback", async () => {
    mockClassify.mockImplementation(async () => ({ workflowType: "investigation", outcome: "unclassified" }));

    const res = await POST(classifyRequest({ objective: "hello" }));
    const body = await parseResponseJSON<{ workflowType: string; outcome: string }>(res);

    expect(res.status).toBe(200);
    expect(body).toEqual({ workflowType: "investigation", outcome: "unclassified" });
  });

  /*
    The classifier's contract says it never throws, so nothing here should ever reach
    the catch — but the route keeps one anyway, because a contract is a promise about
    a module and not a property of this handler. A 500 that says nothing about the
    server's internals is the repository-wide answer.
  */
  test("an unexpected failure is reported through the shared error response", async () => {
    mockClassify.mockImplementation(async () => {
      throw new Error("classifier exploded");
    });

    const res = await POST(classifyRequest({ objective: "why is checkout slow" }));

    expect(res.status).toBe(500);
  });
});
