/**
 * The PromQL statement language: its server adapter, its admission, its prompt texts and its posture, each held to the
 * provider's own reader and withheld-item sentences so no copy can drift from the reason it names.
 */
import { describe, expect, test } from "bun:test";
import { AGENT_LANGUAGE_COPY, AGENT_WORKFLOW_VARIANTS } from "@/lib/agent/agent-manifest";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { fingerprintPromql, promqlRowCapAdvice } from "@/lib/agent/languages/promql/adapter";
import { PROMQL_CLIENT_PACK } from "@/lib/agent/languages/promql/client";
import {
  LANGUAGE_BASE_DEFINITIONS,
  languageServer,
  languageServerPack,
  WORKFLOW_TOOL_RULES,
} from "@/lib/agent/languages/server";
import { agentPosture } from "@/lib/agent/posture";
import {
  admitPromqlStatement,
  PROMQL_AGENT_MAX_STATEMENT_CHARS,
  promqlAgentReadInput,
} from "@/lib/db/operations/promql-admission";
import { PROMETHEUS_AGENT_PROJECTION } from "@/lib/db/providers/timeseries/prometheus/agent-projection";
import { PROMETHEUS_AGENT_READS } from "@/lib/db/providers/timeseries/prometheus/agent-statement";

const BUDGETS = AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets;
const WITHHELD = `${PROMETHEUS_AGENT_PROJECTION.flags} ${PROMETHEUS_AGENT_PROJECTION.urls}`;

describe("the server adapter", () => {
  test("the fingerprint is the expression the reader admits, outer whitespace aside", () => {
    const one = fingerprintPromql("up");
    expect(fingerprintPromql("  up\n")).toBe(one);
    expect(fingerprintPromql("up[5m]")).not.toBe(one);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the fingerprint is total: a refused read is identified by its raw text, so it is refused again", () => {
    expect(fingerprintPromql("up&time=0")).toBe(fingerprintPromql("up&time=0"));
    expect(fingerprintPromql("up&time=0 ")).not.toBe(fingerprintPromql("up&time=0"));
  });

  test("the row-cap advice names fewer series or samples, never a cut", () => {
    expect(AGENT_LANGUAGE_COPY.promql.adviceKeys).toEqual([]);
    expect(promqlRowCapAdvice("up", "2")).toBe(
      "Ask for at most 2 rows: a vector answers one row per series and a matrix one per sample, so aggregate (sum by (job) (...)), narrow the selector with label matchers, or shorten a range vector or widen a subquery's step, and run it again.",
    );
    expect(languageServer("promql").shapeAdvice).toContain("a valid PromQL expression");
    expect(languageServer("promql").readOperation).toBe("promql.query.read");
  });
});

describe("the admission", () => {
  test("is the provider's reader, plus a length the agent's contract names", () => {
    expect(admitPromqlStatement("sum by (job) (up)")).toBeNull();
    expect(admitPromqlStatement("up&time=0")).toEqual({
      code: "statement",
      message: expect.stringContaining(PROMETHEUS_AGENT_READS),
    });
    const long = `up${" + up".repeat(1000)}`;
    expect(long.length).toBeGreaterThan(PROMQL_AGENT_MAX_STATEMENT_CHARS);
    expect(admitPromqlStatement(long)).toEqual({
      code: "agent-too-large",
      message: `The expression is longer than ${PROMQL_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`,
    });
    expect(languageServer("promql").admit?.("up")).toBeNull();
  });

  test("the descriptor's input is strict, carries the statement, and refuses what the admission refuses", () => {
    expect(promqlAgentReadInput.safeParse({ statement: "up" }).success).toBe(true);
    expect(promqlAgentReadInput.safeParse({ statement: "up", sql: "x" }).success).toBe(false);
    const refused = promqlAgentReadInput.safeParse({ statement: "up[$__range]" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["statement"]);
    expect(refused.error?.issues[0]?.message).toStartWith("$ is not PromQL");
  });
});

describe("the prompt texts", () => {
  test("the tool description names one instant expression, the counting and the refusals", () => {
    for (const workflow of ["investigation", "data-analysis"] as const) {
      const description = languageServerPack("promql").toolOverrides[workflow]?.run_read_query?.description ?? "";
      expect(description).toContain("evaluated as an instant query at the server's own now");
      expect(description).toContain("one row per series");
      expect(description).toContain("every sample counted as a row");
      expect(description).toContain("no time, range, step, limit or other request parameter can be written");
      expect(description).toContain("refused rather than cut");
    }
    expect(Object.keys(LANGUAGE_BASE_DEFINITIONS)).not.toContain("promql");
  });

  test("the rules, the grounding advice and the ungrounded note carry every withheld item's reason", () => {
    expect(WORKFLOW_TOOL_RULES.promql.investigation).toContain(WITHHELD);
    expect(WORKFLOW_TOOL_RULES.promql["data-analysis"]).toContain("call present_answer");
    const grounding = languageServerPack("promql").grounding;
    expect(grounding.omissionAdvice).toStartWith(
      "Metrics are listed with their label names, and rules, scrape pools and targets by name, never with a value.",
    );
    expect(grounding.omissionAdvice).toContain(WITHHELD);
    expect(grounding.relations).toBe(false);
    expect(grounding.ungrounded?.("The capture failed.", { singular: "metric", plural: "metrics" })).toBe(
      `The capture failed.\nSo nothing about this server has been established for you: not one metric name. ${WITHHELD} Read what you need with run_read_query, starting with up.`,
    );
    expect(grounding.planningRules).toBeUndefined();
  });

  test("the investigation, the data analysis and the operations workflow are offered, and nothing auto-executes", () => {
    expect(Object.keys(AGENT_WORKFLOW_VARIANTS.promql).sort()).toEqual([
      "data-analysis",
      "investigation",
      "operations",
    ]);
    expect(AGENT_WORKFLOW_VARIANTS.promql.investigation?.canAutoExecute).toBe(false);
    expect(AGENT_WORKFLOW_VARIANTS.promql["data-analysis"]?.canAutoExecute).toBe(false);
  });
});

describe("the posture on Prometheus", () => {
  const posture = agentPosture({ mode: "agent", engine: "prometheus", engineLabel: "Prometheus", handover: false });

  test("names what the agent reads, what is withheld and that it cannot write, and counts nothing it never named", () => {
    expect(posture.headline).toBe("Reads only");
    expect(posture.qualifier).toBe(
      `${BUDGETS.maxResultRows} rows and ${BUDGETS.statementTimeoutMs / 1000} s per read, over a transport whose only POST is the instant query`,
    );
    expect(posture.body).toContain("a vector one row per series, a matrix one row per sample");
    expect(posture.body).toContain(
      "Its inventory names the metrics and their label names, the rule groups and rules, and the scrape pools and targets.",
    );
    expect(posture.body).toContain("Withheld are the server's command-line flags");
    expect(posture.body).toContain("no admin, remote-write, OTLP or lifecycle call can be sent");
    expect(posture.body).not.toMatch(/metadata only|annotation|scrape health/);
    const widened = agentPosture({ mode: "agent", engine: "prometheus", engineLabel: "Prometheus", handover: true });
    expect(widened).toEqual(posture);
    expect(PROMQL_CLIENT_PACK.posture.handoverTerms()).toContain("the hand-over is not offered on this engine");
  });

  test("plan mode reads its own strip, since the grounding is several read endpoints", () => {
    const plan = agentPosture({ mode: "planning", engine: "prometheus", engineLabel: "Prometheus", handover: false });
    expect(plan.qualifier).toBe("the server's read endpoints ground it, and no PromQL it drafted is evaluated");
    expect(plan.body).toContain("Plan mode never sends the PromQL it wrote.");
    expect(plan.body).toContain("the server's flags are not read");
  });
});
