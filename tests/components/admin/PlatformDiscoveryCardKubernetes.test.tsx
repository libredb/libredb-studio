import "../../setup-dom";
import "../../helpers/mock-navigation";

/**
 * The Kubernetes section of the admin Overview's discovery card (GET /api/admin/discovery, `kubernetesDiscovery`):
 * its state, the namespaces the exporter read and could not read, the connected and skipped databases, and the
 * cookie warning, shown beside the CapRover section when both sources are on. The CapRover section's own cases are
 * in PlatformDiscoveryCard.test.tsx.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import React from "react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import type { DiscoveryStatus } from "@/lib/seed/discovery-loader";
import type { KubernetesDiscoveryStatus } from "@/lib/seed/kubernetes-discovery-loader";
import { PlatformDiscoveryCard } from "@/components/admin/PlatformDiscoveryCard";

const COOKIE_WARNING =
  "The Studio session cookie can travel over plain HTTP, and it unlocks the discovered databases its user may open. Serve Studio over HTTPS, then set AUTH_COOKIE_SECURE to true and restart.";
const GENERATED_AT = "2026-10-28T08:00:00.000Z";

function kubernetes(overrides: Partial<KubernetesDiscoveryStatus> = {}): KubernetesDiscoveryStatus {
  return {
    state: "ok",
    message: "The Kubernetes discovery exporter's last scan is current",
    generatedAt: GENERATED_AT,
    checkedAt: GENERATED_AT,
    error: null,
    namespaces: [
      { name: "team-a", error: null },
      { name: "team-b", error: { code: "forbidden", message: "the exporter may not list clusters in team-b" } },
    ],
    connected: [{ name: "team-a/orders (CloudNativePG)", type: "postgres" }],
    skipped: [{ resource: "team-a/reports", reason: "the credential Secret reports-app does not exist" }],
    ...overrides,
  };
}

const CAPROVER: DiscoveryStatus = {
  platform: "caprover",
  state: "ok",
  message: "The discovery app's last scan is current",
  generatedAt: GENERATED_AT,
  checkedAt: GENERATED_AT,
  error: null,
  connected: [{ name: "pgtest (PostgreSQL)", type: "postgres" }],
  skipped: [],
};

async function renderWith(json: unknown) {
  mockGlobalFetch({ "/api/admin/discovery": { json } });
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<PlatformDiscoveryCard />);
  });
  return result;
}

const SECURE = { plainHttp: false, cookieSecureOff: false };

describe("PlatformDiscoveryCard, Kubernetes section", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("shows the state, the namespaces, and the connected and skipped databases", async () => {
    const { findByTestId, getByRole, getByText, queryByTestId, queryByRole } = await renderWith({
      discovery: null,
      kubernetesDiscovery: kubernetes(),
      transport: SECURE,
    });

    const card = await findByTestId("kubernetes-discovery-card");
    expect(getByRole("region", { name: "Platform Discovery (Kubernetes)" })).toBe(card);
    expect(queryByTestId("platform-discovery-card")).toBeNull();
    expect(getByText("Running")).not.toBeNull();
    expect(getByText("The Kubernetes discovery exporter's last scan is current")).not.toBeNull();
    expect(getByText(new Date(GENERATED_AT).toLocaleString())).not.toBeNull();
    expect(getByText("Namespaces (2)")).not.toBeNull();
    expect(getByText("team-a")).not.toBeNull();
    expect(getByText("Read")).not.toBeNull();
    expect(getByText("forbidden: the exporter may not list clusters in team-b")).not.toBeNull();
    expect(getByText("Connected (1)")).not.toBeNull();
    expect(getByText("team-a/orders (CloudNativePG)")).not.toBeNull();
    expect(getByText("Skipped (1)")).not.toBeNull();
    expect(getByText("team-a/reports")).not.toBeNull();
    expect(getByText("the credential Secret reports-app does not exist")).not.toBeNull();
    expect(queryByTestId("kubernetes-discovery-error")).toBeNull();
    expect(queryByRole("alert")).toBeNull();
  });

  test("shows the waiting state with Never and empty lists", async () => {
    const { findByTestId, getByText, getAllByText } = await renderWith({
      discovery: null,
      kubernetesDiscovery: kubernetes({
        state: "waiting",
        message: "Waiting for the Kubernetes discovery exporter's export",
        generatedAt: null,
        checkedAt: null,
        namespaces: [],
        connected: [],
        skipped: [],
      }),
      transport: SECURE,
    });

    await findByTestId("kubernetes-discovery-card");
    expect(getByText("Waiting")).not.toBeNull();
    expect(getByText("Never")).not.toBeNull();
    expect(getByText("Namespaces (0)")).not.toBeNull();
    expect(getAllByText("None")).toHaveLength(3);
  });

  test("shows the source's error", async () => {
    const { findByTestId, getByText } = await renderWith({
      discovery: null,
      kubernetesDiscovery: kubernetes({
        state: "error",
        message: "the API server answered HTTP 500",
        error: { code: "api_error", message: "the API server answered HTTP 500" },
      }),
      transport: SECURE,
    });

    await findByTestId("kubernetes-discovery-card");
    expect(getByText("Failed")).not.toBeNull();
    expect((await findByTestId("kubernetes-discovery-error")).textContent).toBe(
      "api_error: the API server answered HTTP 500",
    );
  });

  test("never renders a host name or a Secret value, even when the payload carries them", async () => {
    const extra = { host: "orders-rw.team-a.svc", password: "not-a-real-password-orders" };
    const { findByTestId, getByText } = await renderWith({
      discovery: null,
      kubernetesDiscovery: kubernetes({
        connected: [{ name: "team-a/orders (CloudNativePG)", type: "postgres", ...extra }],
        skipped: [{ resource: "team-a/reports", reason: "the credential Secret reports-app does not exist", ...extra }],
      }),
      transport: SECURE,
    });

    const card = await findByTestId("kubernetes-discovery-card");
    expect(getByText("team-a/orders (CloudNativePG)")).not.toBeNull();
    expect(card.innerHTML).not.toContain("orders-rw.team-a.svc");
    expect(card.innerHTML).not.toContain("not-a-real-password-orders");
  });

  test("warns about the cookie over plain HTTP while a database is connected, and not while none is", async () => {
    const { findByRole } = await renderWith({
      discovery: null,
      kubernetesDiscovery: kubernetes(),
      transport: { plainHttp: true, cookieSecureOff: false },
    });
    expect((await findByRole("alert")).textContent).toBe(COOKIE_WARNING);
    cleanup();
    restoreGlobalFetch();

    const { findByTestId, queryByRole } = await renderWith({
      discovery: null,
      kubernetesDiscovery: kubernetes({ connected: [] }),
      transport: { plainHttp: false, cookieSecureOff: true },
    });
    await findByTestId("kubernetes-discovery-card");
    expect(queryByRole("alert")).toBeNull();
  });

  test("shows both sources side by side when both are on", async () => {
    const { findByTestId, getByRole } = await renderWith({
      discovery: CAPROVER,
      kubernetesDiscovery: kubernetes(),
      transport: SECURE,
    });

    expect(await findByTestId("platform-discovery-card")).toBe(
      getByRole("region", { name: "Platform Discovery (CapRover)" }),
    );
    expect(await findByTestId("kubernetes-discovery-card")).toBe(
      getByRole("region", { name: "Platform Discovery (Kubernetes)" }),
    );
  });

  test("renders nothing while both sources are off", async () => {
    const { container } = await renderWith({ discovery: null, kubernetesDiscovery: null });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.innerHTML).toBe("");
  });
});
