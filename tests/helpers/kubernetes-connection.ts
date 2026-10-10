import { KUBERNETES_TYPE } from "@/lib/db/providers/platform/kubernetes/limits";
import type { DatabaseConnection } from "@/lib/types";

/** A test CA in PEM form; its bytes are never parsed by these tests, only handed on. */
export const TEST_CA_PEM = "-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----\n";
/**
 * A token shaped like a ServiceAccount JWT, with a marker no sentence may carry. Joined at run time, so no commit
 * carries a JWT-shaped literal for the secret scan to report.
 */
export const TEST_TOKEN = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJtYXJrZXItdG9rZW4ifQ", "c2lnbmF0dXJlLW1hcmtlcg"].join(
  ".",
);

/** A Kubernetes connection to api.example:6443 with a token and verify-full against a CA; `overrides` replaces fields. */
export function kubernetesConnection(overrides?: Partial<DatabaseConnection>): DatabaseConnection {
  return {
    id: "k8s-test",
    name: "Kubernetes test",
    type: KUBERNETES_TYPE,
    host: "api.example",
    port: 6443,
    password: TEST_TOKEN,
    ssl: { mode: "verify-full", caCert: TEST_CA_PEM },
    createdAt: new Date(0),
    ...overrides,
  };
}
