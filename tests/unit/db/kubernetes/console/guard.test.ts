/**
 * The confirmation gate's view of a kubectl statement: what the parser refuses, the editor refuses with the same
 * sentence before anything is sent; a read is sent.
 */
import { describe, expect, test } from "bun:test";
import { kubectlRefusal } from "@/lib/db/providers/platform/kubernetes/console/guard";
import { PAGING_CLAUSE_SENTENCE } from "@/lib/db/providers/platform/kubernetes/console/paging";
import { parseKubectl } from "@/lib/db/providers/platform/kubernetes/console/parse";

describe("kubectlRefusal", () => {
  test.each([
    "kubectl delete pod web",
    "kubectl exec -it pod/x -- sh",
    "kubectl get pods -o jsonpath='{.items[*].metadata.name}'",
    "kubectl logs -f deploy/web",
    "kubectl get events --sort-by=.lastTimestamp",
    "kubectl get all -n shop",
    "kubectl get pods --token=abc",
    "get pods | head",
    "get pods\nget nodes",
    "",
  ])("%j is refused with the parser's own sentence", (text) => {
    const parsed = parseKubectl(text);
    expect(parsed.ok).toBe(false);
    expect(kubectlRefusal(text)).toBe(parsed.ok ? "unreachable" : parsed.refusal.message);
  });

  test("a read is sent", () => {
    expect(kubectlRefusal("kubectl get pods -n shop")).toBeUndefined();
    expect(kubectlRefusal("$ kubectl describe deployment/web -n shop")).toBeUndefined();
    expect(kubectlRefusal("kubectl get pods\n# libredb:page offset=0 limit=5")).toBeUndefined();
  });

  test("a paging line typed under a statement that cannot page is refused as the provider refuses it", () => {
    expect(kubectlRefusal("kubectl describe pod web\n# libredb:page offset=0 limit=5")).toBe(PAGING_CLAUSE_SENTENCE);
  });
});
