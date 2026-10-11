import "../setup-dom";

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionGlobalConfig } from "framer-motion";

import { CONNECTION_IMPORT_ACTION_ID } from "@/components/ConnectionImportPanel";
import { ConnectionModal } from "@/components/ConnectionModal";
import { getDBConfig } from "@/lib/db-ui-config";
import { importKubeconfig, KUBECONFIG_IMPORT_SENTENCES } from "@/lib/kubernetes/kubeconfig-import";

/**
 * The Kubernetes entry declares the kubeconfig import, and the real dialog, the real form hook and the real importer
 * fill a new connection from a pasted kubeconfig, with nothing mocked. Every kubeconfig here is synthesized.
 */

// The dialog's banners animate in; happy-dom cancels an animation still running when the test ends, which surfaces
// as an unhandled AbortError, so animations finish at once here.
MotionGlobalConfig.skipAnimations = true;

afterEach(cleanup);

const CA = "-----BEGIN CERTIFICATE-----\nMIIBtestca\n-----END CERTIFICATE-----\n";
const TOKEN = "k8s-dialog-marker-token";

function kubeconfig(user: string): string {
  return `apiVersion: v1
kind: Config
current-context: rancher
clusters:
  - name: rancher
    cluster:
      server: https://rancher.example/k8s/clusters/c-m-abc12
      certificate-authority-data: ${Buffer.from(CA, "utf8").toString("base64")}
      tls-server-name: api.internal
users:
  - name: reader
    user:
      ${user}
contexts:
  - name: rancher
    context:
      cluster: rancher
      user: reader
      namespace: shop
`;
}

function value(id: string): string {
  return (document.getElementById(id) as HTMLInputElement).value;
}

async function importInto(text: string) {
  render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
  await act(async () => {
    fireEvent.click(screen.getByTestId(CONNECTION_IMPORT_ACTION_ID));
  });
  fireEvent.change(screen.getByTestId("connection-import-text"), { target: { value: text } });
  // Read stays disabled until the declaration's load, a real dynamic import here, has settled (the shared import panel).
  await waitFor(() => {
    expect((screen.getByTestId("connection-import-read") as HTMLButtonElement).disabled).toBe(false);
  });
  fireEvent.click(screen.getByTestId("connection-import-read"));
  const [context] = await screen.findAllByTestId("connection-import-context");
  fireEvent.click(context);
}

describe("the Kubernetes connection import", () => {
  test("the entry declares it, and its loader resolves to the browser importer itself", async () => {
    const declaration = getDBConfig("kubernetes").connectionImport;
    expect(declaration?.label).toBe("Import kubeconfig");
    expect(await declaration?.load()).toBe(importKubeconfig);
  });

  test("a pasted kubeconfig fills host, port, API path, TLS server name, token, default namespace and the CA", async () => {
    await importInto(kubeconfig(`token: ${TOKEN}`));
    expect([
      value("name"),
      value("host"),
      value("port"),
      value("apiPath"),
      value("tlsServerName"),
      value("password"),
      value("database"),
    ]).toEqual(["rancher", "rancher.example", "443", "/k8s/clusters/c-m-abc12", "api.internal", TOKEN, "shop"]);
    expect((screen.getByPlaceholderText(/Paste CA cert content here/) as HTMLTextAreaElement).value).toBe(CA);
  });

  test("a user that signs in through exec fills no token, and the dialog says why", async () => {
    await importInto(kubeconfig(`exec:\n        command: ${TOKEN}`));
    expect(value("password")).toBe("");
    expect(screen.getByTestId("connection-test-result").textContent).toContain(
      KUBECONFIG_IMPORT_SENTENCES.credentialPlugin,
    );
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
