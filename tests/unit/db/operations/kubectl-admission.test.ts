import { describe, expect, test } from "bun:test";
import {
  admitKubectlStatement,
  KUBECTL_AGENT_MAX_STATEMENT_CHARS,
  type KubectlAdmissionCode,
  kubectlAgentReadInput,
} from "@/lib/db/operations/kubectl-admission";
import { AGENT_PAGING_SENTENCE } from "@/lib/db/providers/platform/kubernetes/console/paging";

/**
 * The agent's admission of a kubectl line: every read the console admits is admitted, every console refusal is
 * refused with its own code and sentence, and the two agent-only refusals are the 4,096-character contract and the
 * paging clause, so the model narrows instead of paging past the row cap.
 */
const CONSOLE_READS = [
  "get pods -n shop",
  "kubectl get pods --namespace=shop -l app=web",
  "get deploy web -n shop -o yaml",
  "describe pod web-1 -n shop",
  "logs web-1 -n shop --tail=50",
  "top pod -n shop",
  "events -n shop --types=Warning",
  "api-resources --namespaced=true",
  "explain pods.spec.containers",
  "auth can-i list secrets -n shop",
  "auth whoami",
  "version",
];

const CONSOLE_REFUSALS: readonly (readonly [string, KubectlAdmissionCode])[] = [
  ["delete pod web-1 -n shop", "not-read-only"],
  ["exec web-1 -- sh", "not-read-only"],
  ["port-forward web-1 8080", "not-read-only"],
  ["get pods | grep web", "shell"],
  ["", "empty"],
  ["logs -f web-1", "follow"],
  ["get pods,svc", "one-type"],
];

describe("admitKubectlStatement", () => {
  test.each(CONSOLE_READS)("admits %s", (statement) => {
    expect(admitKubectlStatement(statement)).toBeNull();
  });

  test.each(CONSOLE_REFUSALS)("refuses %s with the console's own code", (statement, code) => {
    expect(admitKubectlStatement(statement)?.code).toBe(code);
  });

  test("the paging clause is refused, so a read is narrowed rather than paged", () => {
    expect(admitKubectlStatement("get pods -n shop\n# libredb:page offset=0 limit=50")).toEqual({
      code: "agent-paging",
      message: AGENT_PAGING_SENTENCE,
    });
  });

  test("4,096 characters are admitted and 4,097 are not", () => {
    const at = `get pods -n shop -l app=${"a".repeat(KUBECTL_AGENT_MAX_STATEMENT_CHARS - 24)}`;
    expect(at.length).toBe(KUBECTL_AGENT_MAX_STATEMENT_CHARS);
    expect(admitKubectlStatement(at)?.code).not.toBe("agent-too-large");
    expect(admitKubectlStatement(`${at}a`)?.code).toBe("agent-too-large");
  });

  test("multi-byte text is measured in characters, the contract the model reads", () => {
    const text = `get pods -n shop -l app=${"é".repeat(KUBECTL_AGENT_MAX_STATEMENT_CHARS - 24)}`;
    expect(admitKubectlStatement(text)?.code).not.toBe("agent-too-large");
  });
});

describe("kubectlAgentReadInput", () => {
  test("is strict and carries the reader's sentence on a refusal", () => {
    expect(kubectlAgentReadInput.safeParse({ statement: "get pods -n shop" }).success).toBe(true);
    expect(kubectlAgentReadInput.safeParse({ statement: "get pods", sql: "x" }).success).toBe(false);
    const refused = kubectlAgentReadInput.safeParse({ statement: "delete pod web-1" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe(admitKubectlStatement("delete pod web-1")?.message);
  });
});
