import { describe, expect, test } from "bun:test";
import { QUERY_DIALECTS } from "@/lib/db/query-dialects";
import { kubectlGetQuery, kubectlRowActionQuery } from "@/lib/db/providers/platform/kubernetes/generators";
import type { ProviderCapabilities } from "@/lib/db/types";
import { DIALECT_EDITORS } from "@/lib/editor/dialect-editors";
import { editorLanguageForTabType, resolveTabType } from "@/lib/editor/tab-language";
import { generateSelectQuery, generateTableQuery } from "@/lib/query-generators";

const KUBECTL: ProviderCapabilities = {
  queryLanguage: "json",
  queryDialect: "kubectl",
  supportsExplain: false,
  supportsExternalQueryLimiting: false,
  supportsCreateTable: false,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: false,
  defaultPort: 6443,
  schemaRefreshPattern: "(?!)",
};

describe("the kubectl dialect's records", () => {
  test("a kubectl connection opens kubectl tabs, which render in the kubectl language with no formatter", () => {
    expect(resolveTabType(KUBECTL)).toBe("kubectl");
    expect(editorLanguageForTabType("kubectl")).toBe("kubectl");
    expect(DIALECT_EDITORS.kubectl).toEqual({ monacoId: "kubectl" });
  });

  test("offers no profile, model, count statement or SQL export", () => {
    expect(QUERY_DIALECTS.kubectl).toEqual({
      tabType: "kubectl",
      offersColumnProfiling: false,
      offersCodeGeneration: false,
      offersCountQuery: false,
      offersSqlExport: false,
      historyMask: {
        credentialFlags: [
          "--token",
          "--password",
          "--client-key",
          "--client-certificate",
          "--from-literal",
          "--docker-password",
        ],
      },
    });
  });

  test("a tree click and Generate Command write one get, never a MongoDB document", () => {
    expect(generateTableQuery(["shop", "widgets.probe.libredb.dev"], KUBECTL)).toBe(
      "kubectl get widgets.probe.libredb.dev -n shop",
    );
    expect(generateSelectQuery(["Cluster", "node/k3d-0"], [], KUBECTL)).toBe("kubectl get node/k3d-0");
  });
});

describe("the row action statements", () => {
  test("Describe uses the stored name, which already carries its kind, with -n but not under Cluster", () => {
    expect(kubectlRowActionQuery(["shop", "pod/web-6f7d"], "describe")).toBe("kubectl describe pod/web-6f7d -n shop");
    expect(kubectlRowActionQuery(["Cluster", "clusterrole/system:aggregate-to-view"], "describe")).toBe(
      "kubectl describe clusterrole/system:aggregate-to-view",
    );
  });

  test("Logs reads the last 50 lines of a pod, the rows a table's preview reads", () => {
    expect(kubectlRowActionQuery(["shop", "pod/web-1"], "logs")).toBe("kubectl logs pod/web-1 -n shop --tail=50");
  });

  test("List gets a custom resource type's objects, in the namespace or across the cluster", () => {
    expect(kubectlRowActionQuery(["shop", "widgets.probe.libredb.dev"], "list")).toBe(
      "kubectl get widgets.probe.libredb.dev -n shop",
    );
    expect(kubectlRowActionQuery(["Cluster", "nodes.metrics.k8s.io"], "list")).toBe("kubectl get nodes.metrics.k8s.io");
    expect(kubectlGetQuery(["Cluster", "nodes.metrics.k8s.io"])).toBe("kubectl get nodes.metrics.k8s.io");
  });

  test("an action the provider does not declare is a programming error", () => {
    expect(() => kubectlRowActionQuery(["shop", "pod/web"], "exec")).toThrow(
      'Kubernetes declares no row action "exec"',
    );
  });
});
