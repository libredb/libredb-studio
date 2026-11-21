import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { mock } from "bun:test";
import React from "react";
import type { DatabaseConnection } from "@/lib/types";

/*
 * The schema diff's "Fetch from connection" list and a connection whose type names no provider (FND-1), with the real
 * `@/components/ui/select` (`SchemaDiff.test.tsx` replaces it). Storage and the connection list are mocked as that file
 * mocks them.
 */

const P: DatabaseConnection = {
  id: "p",
  name: "Orders",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "orders",
  createdAt: new Date("2026-11-21T10:00:00.000Z"),
};
const P2: DatabaseConnection = { ...P, id: "p2", name: "Billing", database: "billing" };
const U = { ...P, id: "u", name: "Acme", type: "acmefoo" } as unknown as DatabaseConnection;

mock.module("@/lib/storage", () => ({
  storage: {
    getSchemaSnapshots: () => [],
    saveSchemaSnapshot: () => {},
    deleteSchemaSnapshot: () => {},
    getConnections: () => [P, P2, U],
    getActiveCatalog: () => null,
  },
}));

mock.module("@/hooks/use-all-connections", () => ({
  useAllConnections: () => ({ connections: [P, P2, U], loading: false }),
}));

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { unknownTypeSentence } from "@/lib/db/type-id";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";
import { SchemaDiff } from "@/components/SchemaDiff";

/** The connection names every `/api/db/provider-meta` request carried, in order. */
let providerMetaNames: string[] = [];

beforeEach(() => {
  providerMetaNames = [];
  mockGlobalFetch({
    "/api/db/provider-meta": async (request) => {
      const body = (await request.json()) as { connection?: { name?: string } };
      providerMetaNames.push(body.connection?.name ?? "");
      return { status: 400, json: { error: "Stub refusal" } };
    },
  });
});

afterEach(() => {
  cleanup();
  restoreGlobalFetch();
});

async function renderDiff() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<SchemaDiff schema={[]} connection={P} />);
  });
  // The source select, then the target select.
  const openTargets = () => fireEvent.keyDown(view.getAllByRole("combobox")[1], { key: "ArrowDown" });
  return { ...view, openTargets };
}

describe("the schema diff and a connection whose type names no provider (FND-1)", () => {
  test("lists it among the connections to fetch from as Unavailable, with the reason", async () => {
    const { openTargets, getByRole } = await renderDiff();

    openTargets();

    const option = getByRole("option", { name: /Acme/ });
    const sentence = unknownTypeSentence("acmefoo");
    expect(within(option).getByTitle(sentence).textContent).toBe(`Unavailable: ${sentence}`);
    expect(within(getByRole("option", { name: /Billing/ })).queryByText(/Unavailable/)).toBeNull();
  });

  test("a pick of it is refused by name before any request names it", async () => {
    const { openTargets, getByRole, findByText } = await renderDiff();

    openTargets();
    await act(async () => {
      fireEvent.keyDown(getByRole("option", { name: /Acme/ }), { key: "Enter" });
    });

    expect(
      await findByText(
        `Nothing was fetched from Acme, so the comparison on screen is not that database: ${unknownTypeSentence("acmefoo")}`,
      ),
    ).toBeTruthy();
    expect(providerMetaNames).not.toContain("Acme");
  });

  test("a pick of an available connection fetches it as before", async () => {
    const { openTargets, getByRole } = await renderDiff();

    openTargets();
    await act(async () => {
      fireEvent.keyDown(getByRole("option", { name: /Billing/ }), { key: "Enter" });
    });

    await waitFor(() => expect(providerMetaNames).toContain("Billing"));
  });
});
