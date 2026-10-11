/**
 * The kubectl dialect's history mask: the six credential flags the console refuses are the flags query history
 * masks, so a line pasted with a token or a Secret's value is stored without it, whatever form the flag takes.
 */
import { describe, expect, test } from "bun:test";
import { CREDENTIAL_FLAGS } from "@/lib/db/providers/platform/kubernetes/console/commands";
import { QUERY_DIALECTS } from "@/lib/db/query-dialects";
import type { ProviderCapabilities } from "@/lib/db/types";
import { historyMaskOf, maskStatementForHistory } from "@/lib/history-mask";

const SECRET = "eyJhbGciOi-history-marker";

const KUBECTL: ProviderCapabilities = {
  queryLanguage: "json",
  queryDialect: "kubectl",
  supportsExplain: false,
  supportsExternalQueryLimiting: true,
  supportsCreateTable: false,
  supportsInlineRowEdit: false,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: false,
  defaultPort: 6443,
  schemaRefreshPattern: "(?!)",
};

describe("the kubectl history mask", () => {
  // The shared registry writes the six flags literally, so it imports nothing from the provider; this pins them equal.
  test("the dialect declares exactly the console's credential flags", () => {
    expect(QUERY_DIALECTS.kubectl.historyMask).toEqual({ credentialFlags: [...CREDENTIAL_FLAGS] });
    expect(historyMaskOf(KUBECTL)).toEqual({ credentialFlags: [...CREDENTIAL_FLAGS] });
  });

  test.each([
    `kubectl get pods --token=${SECRET}`,
    `kubectl get pods --token ${SECRET} -n shop`,
    `kubectl --password '${SECRET} two' get pods`,
    `kubectl get pods "--client-key=${SECRET}"`,
    `kubectl get pods --client-certificate=/home/${SECRET}.crt`,
    `kubectl get pods --token=${SECRET} | head`,
  ])("%j is stored without its credential", (text) => {
    const stored = maskStatementForHistory(text, historyMaskOf(KUBECTL));
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain("kubectl");
  });

  test.each([
    `kubectl create secret generic db --from-literal=password=${SECRET}`,
    `kubectl create secret generic db --from-literal password=${SECRET}`,
    `kubectl create secret docker-registry reg --docker-server=r.io --docker-username=u --docker-password=${SECRET}`,
    `kubectl create secret docker-registry reg --docker-password ${SECRET}`,
  ])("%j, a Secret-creating line the console refuses, is stored without its value", (text) => {
    const stored = maskStatementForHistory(text, historyMaskOf(KUBECTL));
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain("kubectl create secret");
  });

  test("before the connection's metadata loads, the kubectl flags are masked too", () => {
    expect(maskStatementForHistory(`kubectl get pods --token=${SECRET}`, historyMaskOf(undefined))).not.toContain(
      SECRET,
    );
  });
});
