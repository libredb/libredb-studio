import "../../setup-dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

import { WorkspaceOwnerGate } from "@/components/auth/WorkspaceOwnerGate";

const SERVER_MODE = { "/api/storage/config": { json: { provider: "postgres", serverMode: true } } };

/** A page that reads the browser copy the moment it renders, as the admin and editor pages do. */
function CopyReader({ seen }: { seen: (string | null)[] }) {
  seen.push(localStorage.getItem("libredb_connections"), localStorage.getItem("libredb_workspace_tabs_v1:default"));
  return <p>workspace page</p>;
}

describe("WorkspaceOwnerGate", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("libredb_connections", JSON.stringify([{ id: "c1", name: "Warehouse" }]));
    localStorage.setItem("libredb_workspace_tabs_v1:default", JSON.stringify({ tabs: [{ query: "SELECT 1" }] }));
    localStorage.setItem("libredb_workspace_owner", "admin@libredb.org");
    localStorage.setItem("libredb_server_migrated", "2026-10-07");
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
    localStorage.clear();
  });

  test("server mode: a page never reads a copy that belongs to a different account", async () => {
    mockGlobalFetch({ ...SERVER_MODE, "/api/auth/me": { json: { user: { username: "user@libredb.org" } } } });
    const seen: (string | null)[] = [];

    const view = render(
      <WorkspaceOwnerGate>
        <CopyReader seen={seen} />
      </WorkspaceOwnerGate>,
    );

    expect(await view.findByText("workspace page")).not.toBeNull();
    expect(seen.every((value) => value === null)).toBe(true);
    expect(localStorage.getItem("libredb_workspace_tabs_v1:default")).toBeNull();
    expect(localStorage.getItem("libredb_workspace_owner")).toBe("user@libredb.org");
  });

  test("server mode: the same account's page reads its copy", async () => {
    mockGlobalFetch({ ...SERVER_MODE, "/api/auth/me": { json: { user: { username: "admin@libredb.org" } } } });
    const seen: (string | null)[] = [];

    const view = render(
      <WorkspaceOwnerGate>
        <CopyReader seen={seen} />
      </WorkspaceOwnerGate>,
    );

    expect(await view.findByText("workspace page")).not.toBeNull();
    expect(seen.at(-2)).toBe(JSON.stringify([{ id: "c1", name: "Warehouse" }]));
  });

  test("server mode: an unreadable signed-in account shows why and renders no page", async () => {
    mockGlobalFetch({ ...SERVER_MODE, "/api/auth/me": { ok: false, status: 503, json: { error: "down" } } });
    const seen: (string | null)[] = [];

    const view = render(
      <WorkspaceOwnerGate>
        <CopyReader seen={seen} />
      </WorkspaceOwnerGate>,
    );

    const alert = await view.findByRole("alert");
    expect(alert.textContent).toContain("could not confirm the signed-in account");
    expect(seen).toEqual([]);
    expect(localStorage.getItem("libredb_workspace_owner")).toBe("admin@libredb.org");
  });

  test("a storage mode that cannot be read shows why and renders no page for a copy bound to a server account", async () => {
    mockGlobalFetch({ "/api/storage/config": { ok: false, status: 502, json: { error: "down" } } });
    const seen: (string | null)[] = [];

    const view = render(
      <WorkspaceOwnerGate>
        <CopyReader seen={seen} />
      </WorkspaceOwnerGate>,
    );

    expect((await view.findByRole("alert")).textContent).toContain("could not confirm the signed-in account");
    expect(seen).toEqual([]);
  });

  test("a storage mode that cannot be read renders the page for a copy never bound to a server account", async () => {
    localStorage.removeItem("libredb_workspace_owner");
    localStorage.removeItem("libredb_server_migrated");
    mockGlobalFetch({ "/api/storage/config": { ok: false, status: 502, json: { error: "down" } } });
    const seen: (string | null)[] = [];

    const view = render(
      <WorkspaceOwnerGate>
        <CopyReader seen={seen} />
      </WorkspaceOwnerGate>,
    );

    expect(await view.findByText("workspace page")).not.toBeNull();
    expect(seen.at(-2)).toBe(JSON.stringify([{ id: "c1", name: "Warehouse" }]));
  });

  test("local mode: the page reads the browser copy as before", async () => {
    mockGlobalFetch({ "/api/storage/config": { json: { provider: "local", serverMode: false } } });
    const seen: (string | null)[] = [];

    const view = render(
      <WorkspaceOwnerGate>
        <CopyReader seen={seen} />
      </WorkspaceOwnerGate>,
    );

    expect(await view.findByText("workspace page")).not.toBeNull();
    expect(seen.at(-2)).toBe(JSON.stringify([{ id: "c1", name: "Warehouse" }]));
    expect(localStorage.getItem("libredb_workspace_owner")).toBe("admin@libredb.org");
  });

  test("nothing renders while the check is out, and an answer after unmount changes nothing", async () => {
    let answer: (value: Response) => void = () => {};
    globalThis.fetch = (() => new Promise<Response>((resolve) => (answer = resolve))) as unknown as typeof fetch;
    const seen: (string | null)[] = [];

    const view = render(
      <WorkspaceOwnerGate>
        <CopyReader seen={seen} />
      </WorkspaceOwnerGate>,
    );
    expect(view.queryByText("workspace page")).toBeNull();
    view.unmount();
    answer(new Response(JSON.stringify({ provider: "local", serverMode: false }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(seen).toEqual([]);
  });

  test("an unreadable account answered after unmount changes nothing", async () => {
    let answer: (value: Response) => void = () => {};
    mockGlobalFetch({
      ...SERVER_MODE,
      "/api/auth/me": () =>
        new Promise((resolve) => {
          answer = () => resolve({ ok: false, status: 503, json: { error: "down" } });
        }),
    });

    const view = render(
      <WorkspaceOwnerGate>
        <p>workspace page</p>
      </WorkspaceOwnerGate>,
    );
    await waitFor(() => expect(answer).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 10));
    view.unmount();
    answer(new Response(""));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(view.queryByRole("alert")).toBeNull();
  });

  describe("another tab changes whose copy this is", () => {
    const original = window.location.reload;
    let reload: ReturnType<typeof mock>;

    beforeEach(() => {
      reload = mock(() => {});
      Object.defineProperty(window.location, "reload", { value: reload, configurable: true });
    });

    afterEach(() => {
      Object.defineProperty(window.location, "reload", { value: original, configurable: true });
    });

    function ownerChanged(key: string | null, owner: string | null) {
      if (owner === null) localStorage.removeItem("libredb_workspace_owner");
      else localStorage.setItem("libredb_workspace_owner", owner);
      act(() => {
        window.dispatchEvent(new window.StorageEvent("storage", { key, newValue: owner }));
      });
    }

    test("server mode: a different account signing in elsewhere drops the page and reloads", async () => {
      mockGlobalFetch({ ...SERVER_MODE, "/api/auth/me": { json: { user: { username: "admin@libredb.org" } } } });
      const view = render(
        <WorkspaceOwnerGate>
          <p>workspace page</p>
        </WorkspaceOwnerGate>,
      );
      expect(await view.findByText("workspace page")).not.toBeNull();

      ownerChanged("libredb_workspace_owner", "user@libredb.org");

      expect(view.queryByText("workspace page")).toBeNull();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    for (const [what, key] of [
      ["a sign-out elsewhere", "libredb_workspace_owner"],
      ["a browser copy cleared elsewhere", null],
    ] as const) {
      test(`server mode: ${what} drops the page and reloads`, async () => {
        mockGlobalFetch({ ...SERVER_MODE, "/api/auth/me": { json: { user: { username: "admin@libredb.org" } } } });
        const view = render(
          <WorkspaceOwnerGate>
            <p>workspace page</p>
          </WorkspaceOwnerGate>,
        );
        expect(await view.findByText("workspace page")).not.toBeNull();

        ownerChanged(key, null);

        expect(view.queryByText("workspace page")).toBeNull();
        expect(reload).toHaveBeenCalledTimes(1);
      });
    }

    test("server mode: other keys, and the same owner written again, keep the page", async () => {
      mockGlobalFetch({ ...SERVER_MODE, "/api/auth/me": { json: { user: { username: "admin@libredb.org" } } } });
      const view = render(
        <WorkspaceOwnerGate>
          <p>workspace page</p>
        </WorkspaceOwnerGate>,
      );
      expect(await view.findByText("workspace page")).not.toBeNull();

      act(() => {
        window.dispatchEvent(new window.StorageEvent("storage", { key: "libredb_history", newValue: "[]" }));
      });
      ownerChanged("libredb_workspace_owner", "admin@libredb.org");

      expect(view.queryByText("workspace page")).not.toBeNull();
      expect(reload).not.toHaveBeenCalled();
    });

    test("local mode: an owner key written elsewhere changes nothing", async () => {
      mockGlobalFetch({ "/api/storage/config": { json: { provider: "local", serverMode: false } } });
      const view = render(
        <WorkspaceOwnerGate>
          <p>workspace page</p>
        </WorkspaceOwnerGate>,
      );
      expect(await view.findByText("workspace page")).not.toBeNull();

      ownerChanged("libredb_workspace_owner", "user@libredb.org");

      expect(view.queryByText("workspace page")).not.toBeNull();
      expect(reload).not.toHaveBeenCalled();
    });

    test("the page stops listening once it is gone", async () => {
      mockGlobalFetch({ ...SERVER_MODE, "/api/auth/me": { json: { user: { username: "admin@libredb.org" } } } });
      const view = render(
        <WorkspaceOwnerGate>
          <p>workspace page</p>
        </WorkspaceOwnerGate>,
      );
      expect(await view.findByText("workspace page")).not.toBeNull();
      view.unmount();

      ownerChanged("libredb_workspace_owner", "user@libredb.org");

      expect(reload).not.toHaveBeenCalled();
    });
  });
});
