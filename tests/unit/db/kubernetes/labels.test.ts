/**
 * The Kubernetes labels' statementLanguage: built from the console's command table, naming every command and flag
 * the parser takes, and each example a statement the parser runs.
 */
import { describe, expect, test } from "bun:test";
import { KUBECTL_COMMAND_TABLE } from "@/lib/db/providers/platform/kubernetes/console/commands";
import { kubectlRefusal } from "@/lib/db/providers/platform/kubernetes/console/guard";
import {
  KUBECTL_STATEMENT_EXAMPLES,
  KUBERNETES_LABELS,
  kubectlStatementLanguage,
} from "@/lib/db/providers/platform/kubernetes/labels";

describe("statementLanguage", () => {
  test("is the labels' member, and names every command and flag of the table", () => {
    const sentence = kubectlStatementLanguage();
    expect(KUBERNETES_LABELS.statementLanguage).toBe(sentence);
    for (const entry of KUBECTL_COMMAND_TABLE) {
      expect(sentence).toContain(entry.command);
      for (const flag of entry.flags) expect(sentence).toContain(`[${flag}]`);
    }
    expect(sentence).toContain("get TYPE [NAME ...] | TYPE/NAME ... [-n|--namespace]");
    expect(sentence).toContain("api-versions, explain TYPE[.FIELD ...] [--recursive]");
    expect(sentence).toStartWith("the kubectl command this editor runs: exactly one read-only command per run");
  });

  test("each example is a statement the parser runs", () => {
    for (const example of KUBECTL_STATEMENT_EXAMPLES) {
      expect(kubectlRefusal(example)).toBeUndefined();
      expect(kubectlStatementLanguage()).toContain(example);
    }
  });
});
