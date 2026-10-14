import { describe, expect, test } from "bun:test";
import { AGENT_LANGUAGE_COPY } from "@/lib/agent/agent-manifest";
import { fingerprintKubectl, kubectlRowCapAdvice, languageServer } from "@/lib/agent/statement-languages";

/**
 * kubectl's server half: the repair ledger's identity of one read, and the row-cap advice written in the command's
 * own flags. SQL's adapter is held by the D6 golden file and `tools.test.ts`.
 */

describe("the kubectl fingerprint", () => {
  test("is the same for one read written three ways", () => {
    const one = fingerprintKubectl("get pods -n shop");
    expect(fingerprintKubectl("kubectl get pods --namespace=shop")).toBe(one);
    expect(fingerprintKubectl("get   pods  -n   shop")).toBe(one);
  });

  test("differs when a flag's value differs", () => {
    expect(fingerprintKubectl("get pods -n shop")).not.toBe(fingerprintKubectl("get pods -n web"));
    expect(fingerprintKubectl("get pods -n shop -l app=a")).not.toBe(fingerprintKubectl("get pods -n shop -l app=A"));
  });

  test("-n Shop and -n shop do not collide: one parses and one does not", () => {
    expect(fingerprintKubectl("get pods -n Shop")).not.toBe(fingerprintKubectl("get pods -n shop"));
  });

  test("is total: malformed text and the paging clause are fingerprinted, not thrown", () => {
    expect(fingerprintKubectl("get pods | grep x")).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintKubectl("get pods -n shop\n# libredb:page offset=0 limit=5")).not.toBe(
      fingerprintKubectl("get pods -n shop"),
    );
  });
});

describe("row-cap advice by command", () => {
  test.each([
    ["get pods -A", ["-n", "-l", "--field-selector"]],
    ["top pod -A", ["-n", "-l"]],
    ["logs web-1 --all-containers", ["--tail", "-c"]],
    ["events -A", ["-n", "--for", "--types"]],
  ] as const)("%s names only flags its command takes", (statement, flags) => {
    const advice = kubectlRowCapAdvice(statement, "200");
    for (const flag of flags) expect(advice).toContain(flag);
    expect(advice).toContain("200");
    expect(advice).not.toContain("LIMIT");
  });

  test("every advice key of the kubectl copy has its own sentence", () => {
    const generic = kubectlRowCapAdvice("version", "200");
    const statementFor: Readonly<Record<string, string>> = {
      get: "get pods",
      top: "top pod",
      logs: "logs web-1",
      events: "events -n shop",
    };
    for (const command of AGENT_LANGUAGE_COPY.kubectl.adviceKeys) {
      expect(kubectlRowCapAdvice(statementFor[command] as string, "200"), command).not.toBe(generic);
    }
  });

  test("a command without advice of its own, or a line that does not parse, gets the generic sentence", () => {
    expect(kubectlRowCapAdvice("version", "200")).toContain("at most 200 rows");
    expect(kubectlRowCapAdvice("get pods | grep x", "200")).toBe(kubectlRowCapAdvice("version", "200"));
  });
});

describe("the shape advice", () => {
  // No kubectl read reaches a shape denial through run_read_query today: the reader refuses an over-long line before
  // the policy does. The sentence is still the language's own, so a later path that does reach one says the right thing.
  test("kubectl speaks of a valid kubectl statement, and SQL keeps the sentence the golden file holds", () => {
    expect(languageServer("kubectl").shapeAdvice).toContain("a valid kubectl statement");
    expect(languageServer("kubectl").shapeAdvice).not.toContain("SQL");
    expect(languageServer("sql").shapeAdvice).toBeUndefined();
  });
});
