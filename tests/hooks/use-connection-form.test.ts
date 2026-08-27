import "../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { useEffect, useRef } from "react";
import { renderHook, act } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";

// ── Shared mocks — process-wide singletons (no contamination) ────────────────
import { mockToastSuccess, mockToastError } from "../helpers/mock-sonner";
import "../helpers/mock-navigation";

// ── Mock @/lib/db-ui-config ─────────────────────────────────────────────────
const DEFAULT_PORTS: Record<string, string> = {
  mysql: "3306",
  mongodb: "27017",
  redis: "6379",
  couchbase: "8091",
};

mock.module("@/lib/db-ui-config", () => ({
  getDBConfig: (type: string) => ({
    label: type.charAt(0).toUpperCase() + type.slice(1),
    icon: "Database",
    color: "#000",
    defaultPort: DEFAULT_PORTS[type] ?? "5432",
    // Mirrors the real config: the URI-addressed providers offer the toggle.
    showConnectionStringToggle: type === "mongodb" || type === "couchbase",
    // Mirrors the real config: the file-addressed engines take a path and nothing
    // else. A mock that gave every type the full network field set would hide what
    // the editor does to a SQLite or LibreDB connection, which is exactly where it
    // went wrong.
    connectionFields:
      type === "sqlite" || type === "libredb" ? ["database"] : ["host", "port", "user", "password", "database"],
  }),
}));

import { useConnectionForm } from "@/hooks/use-connection-form";
import { resolveAgentRunConnectionId } from "@/hooks/use-connection-payload";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";

// =============================================================================
// useConnectionForm Tests
// =============================================================================
describe("useConnectionForm", () => {
  const defaultProps = {
    isOpen: true,
    onClose: mock(() => {}),
    onConnect: mock(() => {}),
    editConnection: null as DatabaseConnection | null,
  };

  beforeEach(() => {
    defaultProps.onClose.mockClear();
    defaultProps.onConnect.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  // ── Default State ──────────────────────────────────────────────────────────

  test("default state has type postgres, host localhost, port 5432", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    expect(result.current.type).toBe("postgres");
    expect(result.current.host).toBe("localhost");
    expect(result.current.port).toBe("5432");
  });

  // ── setType Changes Database Type ──────────────────────────────────────────

  test("setType changes database type", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setType("mysql");
    });

    expect(result.current.type).toBe("mysql");
  });

  // ── Populate from editConnection ───────────────────────────────────────────

  test("populates form from editConnection on mount", () => {
    const editConn: DatabaseConnection = {
      id: "edit-1",
      name: "My PG",
      type: "postgres",
      host: "db.example.com",
      port: 5432,
      user: "pgadmin",
      password: "pgpass",
      database: "mydb",
      createdAt: new Date(),
      environment: "staging",
    };

    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, editConnection: editConn }));

    expect(result.current.type).toBe("postgres");
    expect(result.current.name).toBe("My PG");
    expect(result.current.host).toBe("db.example.com");
    expect(result.current.port).toBe("5432");
    expect(result.current.user).toBe("pgadmin");
    expect(result.current.password).toBe("pgpass");
    expect(result.current.database).toBe("mydb");
    expect(result.current.environment).toBe("staging");
  });

  // ── The edit target is applied before the first commit ────────────────────

  /**
   * The population happens DURING the render that first sees `editConnection`, not
   * in an effect afterwards. The difference is invisible to a test that reads
   * `result.current` (React Testing Library has already flushed the effects by
   * then), so this one snapshots the values as of the first commit: with an effect
   * they are the postgres defaults, and the user sees a frame of them.
   */
  test("applies the edit target in the first committed render", () => {
    const editConn: DatabaseConnection = {
      id: "edit-first-commit",
      name: "Committed First",
      type: "mysql",
      host: "db.first-commit.example",
      port: 3306,
      createdAt: new Date(),
    };

    const firstCommit: { type?: string; host?: string; name?: string } = {};

    renderHook(() => {
      const form = useConnectionForm({ ...defaultProps, editConnection: editConn });
      const recorded = useRef(false);
      // The guard, not an empty dependency array, is what pins this to the FIRST
      // commit: the effect is allowed to re-run when the values change, but only the
      // first reading is kept — which is exactly what an effect-based population
      // would have got wrong, by committing the defaults before repopulating.
      useEffect(() => {
        if (recorded.current) return;
        recorded.current = true;
        firstCommit.type = form.type;
        firstCommit.host = form.host;
        firstCommit.name = form.name;
      }, [form.type, form.host, form.name]);
      return form;
    });

    expect(firstCommit.type).toBe("mysql");
    expect(firstCommit.host).toBe("db.first-commit.example");
    expect(firstCommit.name).toBe("Committed First");
  });

  // ── Reset form when modal closes ──────────────────────────────────────────

  test("resets form when modal closes (isOpen false)", () => {
    const { result, rerender } = renderHook((props) => useConnectionForm(props), {
      initialProps: { ...defaultProps, isOpen: true },
    });

    // Set some form state
    act(() => {
      result.current.setName("TestConn");
      result.current.setUser("testuser");
      result.current.setPassword("pass123");
      result.current.setDatabase("testdb");
    });

    expect(result.current.name).toBe("TestConn");

    // Close the modal
    rerender({ ...defaultProps, isOpen: false });

    expect(result.current.name).toBe("");
    expect(result.current.user).toBe("");
    expect(result.current.password).toBe("");
    expect(result.current.database).toBe("");
    expect(result.current.type).toBe("postgres");
    expect(result.current.host).toBe("localhost");
    expect(result.current.port).toBe("5432");
  });

  /**
   * A dialog can mount already closed with an edit target — the shell renders this hook
   * whether or not the dialog is on screen — and that mount must apply the target, in
   * the first committed render, exactly as the open one does.
   *
   * The first-commit reading is the whole point: a plain `result.current` check passes
   * against the effect-based population too (React Testing Library has flushed the
   * effects by then), so it would pin nothing. Reading the first commit is what
   * separates the two — with the population in an effect, this mount commits the
   * postgres/localhost defaults first, the same frame of wrong values the open dialog
   * was fixed for.
   */
  test("a dialog mounted closed with an edit target applies it in the first committed render", () => {
    const editConn: DatabaseConnection = {
      id: "edit-closed",
      name: "Closed But Editing",
      type: "mysql",
      host: "closed.example.com",
      port: 3306,
      database: "closeddb",
      createdAt: new Date(),
    };

    const firstCommit: { name?: string; host?: string; database?: string } = {};

    const { result } = renderHook(() => {
      const form = useConnectionForm({ ...defaultProps, isOpen: false, editConnection: editConn });
      const recorded = useRef(false);
      useEffect(() => {
        if (recorded.current) return;
        recorded.current = true;
        firstCommit.name = form.name;
        firstCommit.host = form.host;
        firstCommit.database = form.database;
      }, [form.name, form.host, form.database]);
      return form;
    });

    expect(firstCommit.name).toBe("Closed But Editing");
    expect(firstCommit.host).toBe("closed.example.com");
    expect(firstCommit.database).toBe("closeddb");
    expect(result.current.name).toBe("Closed But Editing");
  });

  /**
   * The other half of the reset's guard, now that the edit target's absence is itself a
   * trigger: closing the dialog on a connection that is STILL being edited must leave
   * its fields alone. The trigger fires on that transition too, and only the guard
   * stops it from blanking the connection the dialog will reopen on.
   */
  test("closing the dialog while the edit target remains keeps that connection's fields", () => {
    const editConn: DatabaseConnection = {
      id: "edit-still-open",
      name: "Still Editing",
      type: "postgres",
      host: "still.example.com",
      port: 5432,
      user: "pgadmin",
      password: "pgpass",
      database: "stilldb",
      createdAt: new Date(),
    };

    const { result, rerender } = renderHook((props) => useConnectionForm(props), {
      initialProps: { ...defaultProps, isOpen: true, editConnection: editConn },
    });

    rerender({ ...defaultProps, isOpen: false, editConnection: editConn });

    expect(result.current.name).toBe("Still Editing");
    expect(result.current.user).toBe("pgadmin");
    expect(result.current.password).toBe("pgpass");
    expect(result.current.database).toBe("stilldb");
    expect(result.current.host).toBe("still.example.com");
  });

  /**
   * The credentials of the connection last edited must not open the NEXT dialog.
   *
   * `Studio.tsx` happens to clear `editConnection` and `isOpen` in the same handler
   * today, so `isOpen` co-changes and the close transition does the clearing — but a
   * caller that drops the edit target on its own is not doing anything wrong, and the
   * price of the hook not covering it is another connection's user, password and
   * database sitting in the Add-Connection dialog when it opens.
   */
  test("dropping the edit target while closed clears the credentials before the dialog reopens", () => {
    const editConn: DatabaseConnection = {
      id: "edit-dropped",
      name: "Prod PG",
      type: "postgres",
      host: "prod.example.com",
      port: 5432,
      user: "pgadmin",
      password: "pgpass",
      database: "prod",
      createdAt: new Date(),
    };

    const { result, rerender } = renderHook((props) => useConnectionForm(props), {
      // Widened deliberately: the point of this test is the rerender that drops the
      // target, and inferring the initial props from `editConn` alone would type the
      // field as non-nullable.
      initialProps: { ...defaultProps, isOpen: false, editConnection: editConn as DatabaseConnection | null },
    });

    expect(result.current.user).toBe("pgadmin");
    expect(result.current.password).toBe("pgpass");

    // The edit target goes away while the dialog is still closed…
    rerender({ ...defaultProps, isOpen: false, editConnection: null });
    // …and only then does it open, as the Add-Connection dialog.
    rerender({ ...defaultProps, isOpen: true, editConnection: null });

    expect(result.current.name).toBe("");
    expect(result.current.user).toBe("");
    expect(result.current.password).toBe("");
    expect(result.current.database).toBe("");
    expect(result.current.host).toBe("localhost");
  });

  // ── handleTestConnection calls POST ────────────────────────────────────────

  test("handleTestConnection calls /api/db/test-connection POST", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: true, latency: 42 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/test-connection"),
    );
    expect(testCall).toBeDefined();
    expect(testCall![1]).toMatchObject({ method: "POST" });
  });

  // ── handleTestConnection sets testResult on success ────────────────────────

  test("handleTestConnection sets testResult on success", async () => {
    mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: true, latency: 25 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    await act(async () => {
      await result.current.handleTestConnection();
    });

    expect(result.current.testResult).not.toBeNull();
    expect(result.current.testResult!.tone).toBe("success");
    expect(result.current.testResult!.message).toContain("Connected successfully");
    expect(result.current.testResult!.latency).toBe(25);
  });

  // ── handleTestConnection sets error on failure ─────────────────────────────

  test("handleTestConnection sets error on failure", async () => {
    mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: false, error: "Connection refused" } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    await act(async () => {
      await result.current.handleTestConnection();
    });

    expect(result.current.testResult).not.toBeNull();
    expect(result.current.testResult!.tone).toBe("error");
    expect(result.current.testResult!.message).toBe("Connection refused");
  });

  /*
    An edit must not silently drop what this form does not show.

    The editor rebuilds the connection from its own fields, so anything it has no
    input for used to vanish on save. Three of those matter, and none of them
    announced itself: `seedId`/`managed` are a seed copy's provenance, and losing
    them made the connection stop matching its seed — the merge on the next load
    then re-created the seed copy over the top, discarding the user's edit
    entirely, and the agent rail refused a connection it had accepted a moment
    before. `agentUser`/`agentPassword` are the least-privilege execution profile
    (#328), so dropping them silently downgrades an agent run to the connection's
    main credentials. `group` is just lost.
  */
  test("editing a connection preserves the fields the form does not manage", async () => {
    mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: true, latency: 10 } },
    });

    const seedCopy: DatabaseConnection = {
      id: "seed:sample",
      seedId: "sample",
      managed: false,
      group: "samples",
      agentUser: "agent_ro",
      agentPassword: "agent_pw",
      name: "Sample",
      type: "postgres",
      host: "db.example.com",
      port: 5432,
      user: "pgadmin",
      password: "pgpass",
      database: "mydb",
      createdAt: new Date(0),
    };

    const onConnect = mock(() => {});
    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, editConnection: seedCopy, onConnect }));

    // A presentation-only edit: the one the rail promises stays startable.
    act(() => {
      result.current.setName("My Sample");
    });

    await act(async () => {
      await result.current.handleConnect();
    });

    const saved = (onConnect.mock.calls as unknown[][])[0][0] as DatabaseConnection;
    expect(saved.name).toBe("My Sample");
    expect(saved.seedId).toBe("sample");
    expect(saved.managed).toBe(false);
    expect(saved.group).toBe("samples");
    expect(saved.agentUser).toBe("agent_ro");
    expect(saved.agentPassword).toBe("agent_pw");

    // The two sides, joined across the path a user actually takes. The rail promises
    // that a presentation-only edit stays startable; asserting the preserved fields
    // alone would not have caught this, because the earlier eligibility tests built
    // their "edited" copy by hand rather than through the editor that produces it.
    const served = { ...seedCopy, createdAt: seedCopy.createdAt.toISOString() };
    expect(resolveAgentRunConnectionId(saved, { loaded: true, seeds: [served] })).toEqual({ id: "seed:sample" });
  });

  /*
    A file-addressed engine takes a path and nothing else, and the editor shows it
    nothing else — but it used to write `host: "localhost"`, an empty user and
    password, and a `port` parsed from an empty string anyway. Harmless-looking, and
    it is what actually broke the two connections a default deployment ships: the
    seed descriptor has no host, so a copy the editor had touched no longer matched
    it, and a rename made the rail refuse the sample it had just accepted.

    Both built-in samples are file-addressed, so this is the case that matters, and
    the earlier eligibility tests used a postgres connection whose fields survive the
    round trip unchanged — which is why they passed while the real thing did not.
  */
  test("editing a file-addressed connection does not invent transport fields it never showed", async () => {
    mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: true, latency: 10 } },
    });

    const sqliteSeed: DatabaseConnection = {
      id: "seed:sqlite-embedded-sample",
      seedId: "sqlite-embedded-sample",
      managed: false,
      name: "Sample (Employees)",
      type: "sqlite",
      database: "data/sample-employees.db",
      createdAt: new Date(0),
    };

    const onConnect = mock(() => {});
    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, editConnection: sqliteSeed, onConnect }));

    act(() => {
      result.current.setName("My Employees");
    });

    await act(async () => {
      await result.current.handleConnect();
    });

    const saved = (onConnect.mock.calls as unknown[][])[0][0] as DatabaseConnection;
    expect(saved.name).toBe("My Employees");
    expect(saved.database).toBe("data/sample-employees.db");
    expect(saved.host).toBeUndefined();
    expect(saved.port).toBeUndefined();
    expect(saved.user).toBeUndefined();
    expect(saved.password).toBeUndefined();

    const served = { ...sqliteSeed, createdAt: sqliteSeed.createdAt.toISOString() };
    expect(resolveAgentRunConnectionId(saved, { loaded: true, seeds: [served] })).toEqual({
      id: "seed:sqlite-embedded-sample",
    });
  });

  // Preserving must not resurrect what the user turned OFF: the form owns TLS and
  // the tunnel, so clearing them has to survive the save.
  test("editing a connection does not resurrect transport settings the user disabled", async () => {
    mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: true, latency: 10 } },
    });

    const secured: DatabaseConnection = {
      id: "edit-2",
      name: "Secured",
      type: "postgres",
      host: "db.example.com",
      port: 5432,
      database: "mydb",
      createdAt: new Date(0),
      ssl: { mode: "require", rejectUnauthorized: true },
      sshTunnel: { enabled: true, host: "bastion", port: 22, username: "ops", authMethod: "password" },
    };

    const onConnect = mock(() => {});
    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, editConnection: secured, onConnect }));

    act(() => {
      result.current.setSSLMode("disable");
      result.current.setSSHEnabled(false);
    });

    await act(async () => {
      await result.current.handleConnect();
    });

    const saved = (onConnect.mock.calls as unknown[][])[0][0] as DatabaseConnection;
    expect(saved.ssl).toBeUndefined();
    expect(saved.sshTunnel).toBeUndefined();
  });

  // ── handleConnect calls onConnect on successful test ───────────────────────

  test("handleConnect calls onConnect on successful test", async () => {
    mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: true, latency: 10 } },
    });

    const onConnect = mock(() => {});
    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, onConnect }));

    // Set required fields for a valid connection
    act(() => {
      result.current.setName("TestConn");
      result.current.setHost("localhost");
      result.current.setPort("5432");
    });

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(onConnect).toHaveBeenCalledTimes(1);
    const connArg = (onConnect.mock.calls as unknown[][])[0][0] as DatabaseConnection;
    expect(connArg.type).toBe("postgres");
    expect(connArg.host).toBe("localhost");
  });

  // ── handleConnect does not call onConnect on failed test ───────────────────

  test("handleConnect does not call onConnect on failed test", async () => {
    mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: false, error: "Auth failed" } },
    });

    const onConnect = mock(() => {});
    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, onConnect }));

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(onConnect).not.toHaveBeenCalled();
    expect(result.current.testResult).not.toBeNull();
    expect(result.current.testResult!.tone).toBe("error");
  });

  /*
    ── A connectable server whose health surface does not answer ──

    `handleConnect` used to save only `if (result.success)`, and the route answered
    `success: false` whenever `provider.getHealth()` threw for ANY reason. That is one
    gate serving two different facts, and three published engines fell through it: on
    ScyllaDB the health read asked for Cassandra's `system_views` keyspace, which the
    build does not have (measured 2026-08-24: `Keyspace system_views does not exist`,
    code 8704), and StarRocks and SingleStore fail health for reasons of their own
    (the prepared-statement
    protocol, fixed 2026-08-24). All three connect and run statements fine, and none of them could be
    created in the dialog at all.

    A connection that `connect()`s is usable, so the route now separates the two facts
    and the save follows the connect. It is NOT silent: the first click reports what the
    server refused and saves nothing, and only a second click saves - which is why both
    arms are asserted here.
  */
  const DEGRADED_BODY = {
    success: true,
    degraded: true,
    message: "Connected, but this server answered no health data: Keyspace system_views does not exist",
  };

  test("a health surface that does not answer no longer refuses the save outright", async () => {
    mockGlobalFetch({ "/api/db/test-connection": { ok: true, json: DEGRADED_BODY } });

    const onConnect = mock(() => {});
    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, onConnect }));

    await act(async () => {
      await result.current.handleConnect();
    });

    // Nothing saved yet - but the user is told what was found, in the server's words.
    // The sentence asks the user to click again, which is neither a success nor a
    // failure, so it renders neither (#U19): the warning tone, not the green tick.
    expect(onConnect).not.toHaveBeenCalled();
    expect(result.current.testResult!.tone).toBe("warning");
    expect(result.current.testResult!.message).toContain("Keyspace system_views does not exist");
    expect(result.current.testResult!.message).toContain("again");

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  test("the sentence names the button that is actually on screen", async () => {
    // The dialog renders "Save Changes" when editing and "Establish Connection" when
    // creating; telling the user to click a button that is not there is worse than
    // telling them to click none.
    mockGlobalFetch({ "/api/db/test-connection": { ok: true, json: DEGRADED_BODY } });

    const existing: DatabaseConnection = {
      id: "edit-degraded",
      name: "Scylla ring",
      type: "cassandra",
      host: "127.0.0.1",
      port: 9042,
      database: "probe",
      createdAt: new Date(0),
    };
    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, editConnection: existing }));

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(result.current.testResult!.message).toContain("Click Save Changes again");
  });

  test("a hard connect failure is still refused however many times it is clicked", async () => {
    // The distinction the fix rests on: `success: false` is a connection that does not
    // exist, and no number of clicks may save one.
    mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: false, error: "ECONNREFUSED" } },
    });

    const onConnect = mock(() => {});
    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, onConnect }));

    await act(async () => {
      await result.current.handleConnect();
    });
    await act(async () => {
      await result.current.handleConnect();
    });

    expect(onConnect).not.toHaveBeenCalled();
    expect(result.current.testResult!.tone).toBe("error");
  });

  test("Test Connection reports the degradation rather than a bare success", async () => {
    mockGlobalFetch({ "/api/db/test-connection": { ok: true, json: DEGRADED_BODY } });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    await act(async () => {
      await result.current.handleTestConnection();
    });

    // It connected, so this is not an error - but it is not a plain success either:
    // the sentence says what is missing instead of the "Connected successfully" that
    // hid it, so it gets the warning tone (#U19).
    expect(result.current.testResult!.tone).toBe("warning");
    expect(result.current.testResult!.message).toContain("no health data");
  });

  test("closing the dialog withdraws the acknowledgement", async () => {
    // Otherwise a second connection typed into the same reopened dialog would be saved
    // on its first click, having reported nothing.
    mockGlobalFetch({ "/api/db/test-connection": { ok: true, json: DEGRADED_BODY } });

    const onConnect = mock(() => {});
    const { result, rerender } = renderHook(
      (props: { isOpen: boolean }) => useConnectionForm({ ...defaultProps, onConnect, isOpen: props.isOpen }),
      { initialProps: { isOpen: true } },
    );

    await act(async () => {
      await result.current.handleConnect();
    });
    expect(onConnect).not.toHaveBeenCalled();

    act(() => {
      rerender({ isOpen: false });
    });
    act(() => {
      rerender({ isOpen: true });
    });

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(onConnect).not.toHaveBeenCalled();
  });

  test("the platform adapter carries the same two facts", async () => {
    // The embedded surface passes `onTestConnection` instead of reaching the route, and
    // a fix that only reached the fetch path would leave the platform dialog refusing.
    const onTestConnection = mock(async () => ({ success: true, degraded: true, error: "no monitoring here" }));
    const onConnect = mock(() => {});
    const { result } = renderHook(() =>
      useConnectionForm({ ...defaultProps, onConnect, onTestConnection: onTestConnection as never }),
    );

    await act(async () => {
      await result.current.handleConnect();
    });
    expect(onConnect).not.toHaveBeenCalled();
    expect(result.current.testResult!.tone).toBe("warning");
    expect(result.current.testResult!.message).toContain("no monitoring here");

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  // ── handlePasteConnectionString parses and fills form ──────────────────────

  test("handlePasteConnectionString parses and fills form fields", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput("postgres://admin:secret@parsed-host:5432/parsed-db");
    });

    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.type).toBe("postgres");
    expect(result.current.host).toBe("parsed-host");
    expect(result.current.port).toBe("5432");
    expect(result.current.user).toBe("admin");
    expect(result.current.password).toBe("secret");
    expect(result.current.database).toBe("parsed-db");
    expect(result.current.testResult).not.toBeNull();
    expect(result.current.testResult!.tone).toBe("success");
    expect(result.current.testResult!.message).toContain("parsed successfully");
  });

  test("handlePasteConnectionString keeps the TLS intent of a pasted https ClickHouse URL", () => {
    // A ClickHouse Cloud endpoint is the common case. Losing the scheme here sends a
    // plaintext POST to the TLS port, which fails with a bare "fetch failed".
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput("https://user:pass@abc.clickhouse.cloud/default");
    });
    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.type).toBe("clickhouse");
    expect(result.current.port).toBe("8443");
    expect(result.current.sslMode).toBe("require");
  });

  test("handlePasteConnectionString leaves TLS off for a plaintext ClickHouse URL", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput("http://ch-host:8123/demo");
    });
    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.type).toBe("clickhouse");
    expect(result.current.sslMode).toBe("disable");
  });

  // Pasting is an overwrite, not a merge. After editing a TLS connection the form
  // still holds "require", and an explicit http:// URL that left it alone would be
  // saved as HTTPS against a plaintext endpoint.
  test("handlePasteConnectionString clears a stale TLS mode when the pasted URL is plaintext", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setSSLMode("require");
    });
    act(() => {
      result.current.setPasteInput("http://ch-host:8123/demo");
    });
    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.sslMode).toBe("disable");
  });

  test("handlePasteConnectionString keeps the form's TLS mode for the scheme-neutral clickhouse:// form", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setSSLMode("require");
    });
    act(() => {
      result.current.setPasteInput("clickhouse://ch-host:8123/demo");
    });
    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.sslMode).toBe("require");
  });

  // ── TLS carried in the pasted string's query string ────────────────────────

  test("handlePasteConnectionString applies a postgres sslmode from the query string", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput("postgresql://u:p@pg.example.com:5432/app?sslmode=verify-full");
    });
    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.sslMode).toBe("verify-full");
    expect(result.current.testResult!.message).toContain("parsed successfully");
    expect(result.current.testResult!.message).not.toContain("SSL Mode");
  });

  test("handlePasteConnectionString applies MySQL's ssl-mode=REQUIRED", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput("mysql://root:pw@my.example.com/app?ssl-mode=REQUIRED");
    });
    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.sslMode).toBe("require");
  });

  test("handlePasteConnectionString reads Encrypt out of an ADO.NET string", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput("Server=sql.example.com,1433;Database=db;Encrypt=True;TrustServerCertificate=True;");
    });
    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.type).toBe("mssql");
    expect(result.current.sslMode).toBe("require");
  });

  // The caution has to be VISIBLE, and visible in the right colour. The paste itself
  // worked - every other field was filled in - so this is not a red refusal (that was
  // the affordance-contradicts-the-sentence defect of #449 in the other direction: a
  // green tick over "your TLS setting was dropped"); it is the amber warning tone
  // #U19 added, because the parse both worked AND lost something.
  test("handlePasteConnectionString warns when it refuses to map an opportunistic sslmode", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput("postgres://u:p@pg.example.com/app?sslmode=prefer");
    });
    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.sslMode).toBe("disable");
    expect(result.current.testResult!.tone).toBe("warning");
    expect(result.current.testResult!.message).toContain("sslmode=prefer");
    expect(result.current.testResult!.message).toContain("SSL Mode");
    // The banner must not read as a plain, unqualified success in its own text either.
    expect(result.current.testResult!.message).not.toContain("parsed successfully");
  });

  test("an unmapped TLS parameter does not overwrite a mode the form already holds", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setSSLMode("verify-ca");
    });
    act(() => {
      result.current.setPasteInput("mysql://root:pw@my.example.com/app?ssl-mode=PREFERRED");
    });
    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.sslMode).toBe("verify-ca");
    expect(result.current.testResult!.tone).toBe("warning");
    expect(result.current.testResult!.message).toContain("ssl-mode=PREFERRED");
    expect(result.current.testResult!.message).toContain("verify-ca");
    // The fields WERE filled, and the banner must not leave the user thinking otherwise.
    expect(result.current.host).toBe("my.example.com");
    expect(result.current.testResult!.message).toContain("other fields");
  });

  // A pasted MySQL URL carrying only the boolean spelling used to reach the form with no
  // mode AND no banner. Both ends of a boolean are mappable, so this one is applied, not
  // refused - and the banner stays the plain success.
  test("handlePasteConnectionString applies MySQL's boolean useSSL=true", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput("mysql://root:pw@my.example.com/app?useSSL=true");
    });
    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.sslMode).toBe("verify-system");
    expect(result.current.testResult!.tone).toBe("success");
    expect(result.current.testResult!.message).toContain("parsed successfully");
  });

  // D26: the paste has to land on a mode the user can actually connect with. verify-system
  // verifies AND asks for no certificate file, so a Neon/Supabase URL is complete as pasted.
  test("a managed PostgreSQL URL's ssl=true lands on a verifying mode that needs no CA file", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput("postgres://user:pw@ep-cool-1.eu-central-1.aws.neon.tech/neondb?ssl=true");
    });
    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.sslMode).toBe("verify-system");
    expect(result.current.caCert).toBe("");
    expect(result.current.testResult!.tone).toBe("success");
  });

  // The banner names the modes it could not match the parameter to, so the list has to be
  // the real one - a mode missing from the sentence is a mode the user does not know exists.
  test("the unmapped-parameter banner names verify-system among the modes on offer", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput("postgres://u:p@pg.example.com/app?sslmode=prefer");
    });
    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.testResult!.message).toContain("verify-system");
  });

  // ── handlePasteConnectionString shows error for invalid string ─────────────

  test("handlePasteConnectionString shows error for invalid string", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput("not-a-valid-connection-string");
    });

    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.testResult).not.toBeNull();
    expect(result.current.testResult!.tone).toBe("error");
    expect(result.current.testResult!.message).toContain("Could not parse");
  });

  // ── environment defaults to 'local' ────────────────────────────────────────

  test("environment defaults to local", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    expect(result.current.environment).toBe("local");
  });

  // ── isEditMode is true when editConnection is provided ─────────────────────

  test("isEditMode is true when editConnection is provided", () => {
    const editConn: DatabaseConnection = {
      id: "edit-1",
      name: "Edit Conn",
      type: "mysql",
      host: "localhost",
      port: 3306,
      createdAt: new Date(),
    };

    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, editConnection: editConn }));

    expect(result.current.isEditMode).toBe(true);
  });

  test("isEditMode is false when editConnection is null", () => {
    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, editConnection: null }));

    expect(result.current.isEditMode).toBe(false);
  });

  // ── dbTypes returns array of selectable types ──────────────────────────────

  test("dbTypes returns array of selectable types", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    expect(result.current.dbTypes).toBeDefined();
    expect(Array.isArray(result.current.dbTypes)).toBe(true);
    expect(result.current.dbTypes.length).toBeGreaterThan(0);

    const types = result.current.dbTypes.map((t: { value: string }) => t.value);
    expect(types).toContain("postgres");
    expect(types).toContain("mysql");
    expect(types).toContain("mongodb");

    // Each entry has value, label, icon, color
    const first = result.current.dbTypes[0];
    expect(first).toHaveProperty("value");
    expect(first).toHaveProperty("label");
    expect(first).toHaveProperty("icon");
    expect(first).toHaveProperty("color");
  });

  // ── Every connectable type is offered by the picker (#127) ─────────────────

  // The picker must cover the whole DatabaseType union, because this form is also the EDIT
  // form: a type missing here renders the edit dialog with no tile selected. Keyed by
  // DatabaseType, so adding a provider to the union fails `typecheck` on the missing key
  // instead of silently dropping it from the UI. Set an entry to false only to hide a type
  // on purpose — and say why.
  const PICKER_COVERAGE: Record<DatabaseType, boolean> = {
    postgres: true,
    mysql: true,
    sqlite: true,
    oracle: true,
    mssql: true,
    mongodb: true,
    redis: true,
    libredb: true,
    couchbase: true,
    clickhouse: true,
    druid: true,
    // Both search ids are selectable: the same form EDITS an existing connection, so
    // an omitted type leaves the picker with nothing selected for a connection the
    // product can otherwise open (issue #424 Phase 1).
    elasticsearch: true,
    opensearch: true,
    trino: true,
    cassandra: true,
    libsql: true,
    duckdb: true,
  };

  test("dbTypes offers every database type a connection can carry", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    const offered = result.current.dbTypes.map((t: { value: string }) => t.value).sort();
    const expected = Object.entries(PICKER_COVERAGE)
      .filter(([, selectable]) => selectable)
      .map(([type]) => type)
      .sort();

    expect(offered).toEqual(expected);
  });

  test("dbTypes includes sqlite so the seeded sample connection can be edited", () => {
    const sampleConn: DatabaseConnection = {
      id: "seed:sqlite-embedded-sample",
      name: "Sample (Employees)",
      type: "sqlite",
      database: "/var/lib/libredb/sample-employees.db",
      createdAt: new Date(),
    };

    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, editConnection: sampleConn }));

    expect(result.current.type).toBe("sqlite");
    expect(result.current.dbTypes.some((t: { value: string }) => t.value === "sqlite")).toBe(true);
  });

  // ── handleTestConnection handles network error ─────────────────────────────

  test("handleTestConnection sets network error on fetch failure", async () => {
    // Mock fetch to throw
    globalThis.fetch = (async () => {
      throw new Error("Network error");
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    await act(async () => {
      await result.current.handleTestConnection();
    });

    expect(result.current.testResult).not.toBeNull();
    expect(result.current.testResult!.tone).toBe("error");
    expect(result.current.testResult!.message).toContain("Network error");
  });

  // ── Edit mode with Oracle serviceName ──────────────────────────────────

  test("populates Oracle serviceName and showAdvanced in edit mode", () => {
    const editConn: DatabaseConnection = {
      id: "edit-oracle",
      name: "Oracle DB",
      type: "oracle",
      host: "oracle.example.com",
      port: 1521,
      user: "sys",
      password: "oraclepass",
      database: "ORCL",
      serviceName: "myservice",
      createdAt: new Date(),
    };

    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, editConnection: editConn }));

    expect(result.current.type).toBe("oracle");
    expect(result.current.serviceName).toBe("myservice");
    expect(result.current.showAdvanced).toBe(true);
  });

  // ── Edit mode with MSSQL instanceName ──────────────────────────────────

  test("populates MSSQL instanceName and showAdvanced in edit mode", () => {
    const editConn: DatabaseConnection = {
      id: "edit-mssql",
      name: "MSSQL DB",
      type: "mssql",
      host: "mssql.example.com",
      port: 1433,
      user: "sa",
      password: "mssqlpass",
      database: "master",
      instanceName: "SQLEXPRESS",
      createdAt: new Date(),
    };

    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, editConnection: editConn }));

    expect(result.current.type).toBe("mssql");
    expect(result.current.instanceName).toBe("SQLEXPRESS");
    expect(result.current.showAdvanced).toBe(true);
  });

  // ── Edit mode with SSL config ──────────────────────────────────────────

  test("populates SSL config in edit mode", () => {
    const editConn: DatabaseConnection = {
      id: "edit-ssl",
      name: "SSL PG",
      type: "postgres",
      host: "ssl.example.com",
      port: 5432,
      createdAt: new Date(),
      ssl: {
        mode: "verify-full",
        caCert: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
        clientCert: "-----BEGIN CERTIFICATE-----\nCLIENT\n-----END CERTIFICATE-----",
        clientKey: "-----BEGIN KEY-----\nKEY\n-----END KEY-----",
      },
    };

    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, editConnection: editConn }));

    expect(result.current.sslMode).toBe("verify-full");
    expect(result.current.caCert).toContain("CA");
    expect(result.current.clientCert).toContain("CLIENT");
    expect(result.current.clientKey).toContain("KEY");
    expect(result.current.showSSL).toBe(true);
  });

  // ── Edit mode with SSH tunnel ──────────────────────────────────────────

  test("populates SSH tunnel config in edit mode", () => {
    const editConn: DatabaseConnection = {
      id: "edit-ssh",
      name: "SSH PG",
      type: "postgres",
      host: "internal.example.com",
      port: 5432,
      createdAt: new Date(),
      sshTunnel: {
        enabled: true,
        host: "bastion.example.com",
        port: 22,
        username: "tunneluser",
        authMethod: "privateKey",
        privateKey: "-----BEGIN RSA PRIVATE KEY-----\nKEY\n-----END RSA PRIVATE KEY-----",
        passphrase: "keypass",
      },
    };

    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, editConnection: editConn }));

    expect(result.current.sshEnabled).toBe(true);
    expect(result.current.showSSH).toBe(true);
    expect(result.current.sshHost).toBe("bastion.example.com");
    expect(result.current.sshPort).toBe("22");
    expect(result.current.sshUsername).toBe("tunneluser");
    expect(result.current.sshAuthMethod).toBe("privateKey");
    expect(result.current.sshPrivateKey).toContain("RSA PRIVATE KEY");
    expect(result.current.sshPassphrase).toBe("keypass");
  });

  // ── Edit mode with SSH password auth ───────────────────────────────────

  test("populates SSH password auth in edit mode", () => {
    const editConn: DatabaseConnection = {
      id: "edit-ssh-pw",
      name: "SSH PG",
      type: "postgres",
      host: "internal.example.com",
      port: 5432,
      createdAt: new Date(),
      sshTunnel: {
        enabled: true,
        host: "bastion.example.com",
        port: 2222,
        username: "sshuser",
        authMethod: "password",
        password: "sshpass",
      },
    };

    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, editConnection: editConn }));

    expect(result.current.sshAuthMethod).toBe("password");
    expect(result.current.sshPassword).toBe("sshpass");
  });

  // ── Edit mode with MongoDB connectionString ───────────────────────────

  test("populates MongoDB connection string mode in edit mode", () => {
    const editConn: DatabaseConnection = {
      id: "edit-mongo",
      name: "Mongo Atlas",
      type: "mongodb",
      host: "localhost",
      port: 27017,
      createdAt: new Date(),
      connectionString: "mongodb+srv://user:pass@cluster.mongodb.net/mydb",
    };

    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, editConnection: editConn }));

    expect(result.current.type).toBe("mongodb");
    expect(result.current.connectionString).toBe("mongodb+srv://user:pass@cluster.mongodb.net/mydb");
    expect(result.current.mongoConnectionMode).toBe("connectionString");
  });

  // ── buildConnection includes SSL config when mode is not disable ───────

  test("handleTestConnection includes SSL config when sslMode is not disable", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: true, latency: 30 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setSSLMode("require");
      result.current.setCaCert("test-ca-cert");
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/test-connection"),
    );
    expect(testCall).toBeDefined();
    const body = JSON.parse(testCall![1]!.body as string);
    expect(body.ssl).toBeDefined();
    expect(body.ssl.mode).toBe("require");
    expect(body.ssl.caCert).toBe("test-ca-cert");
  });

  // ── buildConnection includes SSH tunnel config ─────────────────────────

  test("handleTestConnection includes SSH tunnel config when enabled", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: true, latency: 30 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setSSHEnabled(true);
      result.current.setSSHHost("bastion.test.com");
      result.current.setSSHPort("2222");
      result.current.setSSHUsername("tunnel");
      result.current.setSSHAuthMethod("password");
      result.current.setSSHPassword("tunnelpass");
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/test-connection"),
    );
    const body = JSON.parse(testCall![1]!.body as string);
    expect(body.sshTunnel).toBeDefined();
    expect(body.sshTunnel.enabled).toBe(true);
    expect(body.sshTunnel.host).toBe("bastion.test.com");
    expect(body.sshTunnel.port).toBe(2222);
    expect(body.sshTunnel.username).toBe("tunnel");
    expect(body.sshTunnel.password).toBe("tunnelpass");
  });

  // ── buildConnection with privateKey SSH auth ───────────────────────────

  test("handleTestConnection includes SSH privateKey config", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: true, latency: 30 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setSSHEnabled(true);
      result.current.setSSHHost("bastion.test.com");
      result.current.setSSHUsername("tunnel");
      result.current.setSSHAuthMethod("privateKey");
      result.current.setSSHPrivateKey("my-private-key");
      result.current.setSSHPassphrase("mypassphrase");
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/test-connection"),
    );
    const body = JSON.parse(testCall![1]!.body as string);
    expect(body.sshTunnel.authMethod).toBe("privateKey");
    expect(body.sshTunnel.privateKey).toBe("my-private-key");
    expect(body.sshTunnel.passphrase).toBe("mypassphrase");
  });

  // ── buildConnection with MongoDB connectionString mode ─────────────────

  test("buildConnection with MongoDB connectionString mode clears host/port", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: true, latency: 20 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setType("mongodb");
      result.current.setMongoConnectionMode("connectionString");
      result.current.setConnectionString("mongodb://localhost:27017/testdb");
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/test-connection"),
    );
    const body = JSON.parse(testCall![1]!.body as string);
    expect(body.connectionString).toBe("mongodb://localhost:27017/testdb");
    expect(body.host).toBeUndefined();
    expect(body.port).toBeUndefined();
  });

  // ── buildConnection with Oracle serviceName ────────────────────────────

  test("buildConnection includes Oracle serviceName", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: true, latency: 20 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setType("oracle");
      result.current.setServiceName("MYSERVICE");
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/test-connection"),
    );
    const body = JSON.parse(testCall![1]!.body as string);
    expect(body.serviceName).toBe("MYSERVICE");
  });

  // ── buildConnection with Cassandra localDataCenter ─────────────────────

  test("buildConnection includes the Cassandra localDataCenter", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: true, latency: 20 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setType("cassandra");
      result.current.setLocalDataCenter("datacenter1");
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/test-connection"),
    );
    const body = JSON.parse(testCall![1]!.body as string);
    expect(body.localDataCenter).toBe("datacenter1");
  });

  test("a localDataCenter typed for another engine is not sent", async () => {
    // The field is Cassandra's alone. Carrying it onto a PostgreSQL connection would
    // store a topology answer that engine has no use for, exactly as `serviceName`
    // stays on Oracle.
    const fetchMock = mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: true, latency: 20 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setType("postgres");
      result.current.setLocalDataCenter("datacenter1");
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/test-connection"),
    );
    const body = JSON.parse(testCall![1]!.body as string);
    expect(body.localDataCenter).toBeUndefined();
  });

  test("populates the Cassandra localDataCenter in edit mode", () => {
    const conn: DatabaseConnection = {
      id: "c1",
      name: "Ring",
      type: "cassandra",
      host: "cassandra.internal",
      port: 9042,
      database: "probe",
      localDataCenter: "eu-west-1",
      createdAt: new Date(),
    };

    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, editConnection: conn }));

    expect(result.current.localDataCenter).toBe("eu-west-1");
  });

  test("clearing the modal clears the data centre before the next new connection", () => {
    // A leftover ring identity is not cosmetic: the next host would be dialled with
    // the previous ring's `localDataCenter`, which the driver either refuses or - if
    // the name happens to exist on the new ring - accepts as a silently wrong
    // topology. It resets with the other new-connection fields.
    const { result, rerender } = renderHook((props) => useConnectionForm(props), {
      initialProps: { ...defaultProps, isOpen: true },
    });

    act(() => {
      result.current.setType("cassandra");
      result.current.setLocalDataCenter("datacenter1");
    });

    expect(result.current.localDataCenter).toBe("datacenter1");

    rerender({ ...defaultProps, isOpen: false });

    expect(result.current.localDataCenter).toBe("");
  });

  test("editing a connection without a data centre does not inherit the last one", () => {
    // The edit effect must OVERWRITE, not skip: a connection carrying no data centre
    // has to show an empty field, otherwise the previously edited ring's name is
    // saved onto it.
    const withDC: DatabaseConnection = {
      id: "c1",
      name: "Ring",
      type: "cassandra",
      host: "cassandra.internal",
      port: 9042,
      database: "probe",
      localDataCenter: "eu-west-1",
      createdAt: new Date(),
    };
    const withoutDC: DatabaseConnection = {
      id: "c2",
      name: "Other ring",
      type: "cassandra",
      host: "cassandra-2.internal",
      port: 9042,
      database: "probe",
      createdAt: new Date(),
    };

    const { result, rerender } = renderHook((props) => useConnectionForm(props), {
      initialProps: { ...defaultProps, editConnection: withDC },
    });

    expect(result.current.localDataCenter).toBe("eu-west-1");

    rerender({ ...defaultProps, editConnection: withoutDC });

    expect(result.current.localDataCenter).toBe("");
  });

  // ── buildConnection with the MongoDB authSource ────────────────────────

  test("buildConnection includes the MongoDB authSource", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: true, latency: 20 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setType("mongodb");
      result.current.setAuthSource("admin");
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/test-connection"),
    );
    const body = JSON.parse(testCall![1]!.body as string);
    expect(body.authSource).toBe("admin");
  });

  test("an authSource typed for another engine is not sent", async () => {
    // MongoDB is the only engine here that keeps its users in a database of their
    // own, so the field stays on it, exactly as `serviceName` stays on Oracle.
    const fetchMock = mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: true, latency: 20 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setType("postgres");
      result.current.setAuthSource("admin");
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/test-connection"),
    );
    const body = JSON.parse(testCall![1]!.body as string);
    expect(body.authSource).toBeUndefined();
  });

  test("populates the MongoDB authSource in edit mode, and clears it when there is none", () => {
    // The edit effect OVERWRITES: a connection whose credentials live in the database
    // it opens must show an empty field, otherwise the last connection's `admin` is
    // saved onto it and the driver looks for the user in the wrong place.
    const withAuthDb: DatabaseConnection = {
      id: "m1",
      name: "Shop",
      type: "mongodb",
      host: "mongo.internal",
      port: 27017,
      database: "shop",
      authSource: "admin",
      createdAt: new Date(),
    };
    const withoutAuthDb: DatabaseConnection = {
      id: "m2",
      name: "Other",
      type: "mongodb",
      host: "mongo-2.internal",
      port: 27017,
      database: "shop",
      createdAt: new Date(),
    };

    const { result, rerender } = renderHook((props) => useConnectionForm(props), {
      initialProps: { ...defaultProps, editConnection: withAuthDb },
    });

    expect(result.current.authSource).toBe("admin");

    rerender({ ...defaultProps, editConnection: withoutAuthDb });

    expect(result.current.authSource).toBe("");
  });

  test("clearing the modal clears the authSource before the next new connection", () => {
    const { result, rerender } = renderHook((props) => useConnectionForm(props), {
      initialProps: { ...defaultProps, isOpen: true },
    });

    act(() => {
      result.current.setType("mongodb");
      result.current.setAuthSource("admin");
    });

    expect(result.current.authSource).toBe("admin");

    rerender({ ...defaultProps, isOpen: false });

    expect(result.current.authSource).toBe("");
  });

  // ── buildConnection with MSSQL instanceName ────────────────────────────

  test("buildConnection includes MSSQL instanceName", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/test-connection": { ok: true, json: { success: true, latency: 20 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setType("mssql");
      result.current.setInstanceName("SQLEXPRESS");
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/test-connection"),
    );
    const body = JSON.parse(testCall![1]!.body as string);
    expect(body.instanceName).toBe("SQLEXPRESS");
  });

  // ── handleConnect sets network error on fetch failure ──────────────────

  test("handleConnect sets network error on fetch failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("Network error");
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(result.current.testResult).not.toBeNull();
    expect(result.current.testResult!.tone).toBe("error");
    expect(result.current.testResult!.message).toContain("Network error");
  });

  // ── handlePasteConnectionString for MongoDB ────────────────────────────

  test("handlePasteConnectionString sets MongoDB connectionString mode", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput("mongodb://admin:pass@mongo.example.com:27017/mydb");
    });

    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.type).toBe("mongodb");
    expect(result.current.connectionString).toBe("mongodb://admin:pass@mongo.example.com:27017/mydb");
    expect(result.current.mongoConnectionMode).toBe("connectionString");
  });

  // ── handlePasteConnectionString for Couchbase ──────────────────────────

  test("handlePasteConnectionString sets Couchbase bucket and connectionString mode", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput("couchbase://admin:pass@cb.example.com:8091/travel");
    });

    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.type).toBe("couchbase");
    expect(result.current.host).toBe("cb.example.com");
    expect(result.current.port).toBe("8091");
    // The bucket rides in the `database` field.
    expect(result.current.database).toBe("travel");
    expect(result.current.connectionString).toBe("couchbase://admin:pass@cb.example.com:8091/travel");
    expect(result.current.mongoConnectionMode).toBe("connectionString");
  });

  // ── handlePasteConnectionString does nothing for empty input ───────────

  test("handlePasteConnectionString does nothing for empty input", () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput("   ");
    });

    act(() => {
      result.current.handlePasteConnectionString();
    });

    // testResult should remain null — no action taken
    expect(result.current.testResult).toBeNull();
  });

  // ── onTestConnection adapter (platform embedding) ───────────────────────

  test("handleTestConnection uses onTestConnection adapter on success", async () => {
    const fetchMock = mockGlobalFetch({});
    const onTestConnection = mock(async () => ({ success: true, latency: 42 }));

    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, onTestConnection }));

    await act(async () => {
      await result.current.handleTestConnection();
    });

    // The adapter replaces the built-in fetch entirely
    expect(onTestConnection).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.testResult?.tone).toBe("success");
    expect(result.current.testResult?.message).toBe("Connected successfully (42ms)");
    expect(result.current.testResult?.latency).toBe(42);
  });

  test("handleTestConnection uses onTestConnection adapter error on failure", async () => {
    mockGlobalFetch({});
    const onTestConnection = mock(async () => ({ success: false, error: "Auth failed" }));

    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, onTestConnection }));

    await act(async () => {
      await result.current.handleTestConnection();
    });

    expect(result.current.testResult?.tone).toBe("error");
    expect(result.current.testResult?.message).toBe("Auth failed");
  });

  test("handleConnect uses onTestConnection adapter and connects on success", async () => {
    const fetchMock = mockGlobalFetch({});
    const onTestConnection = mock(async () => ({ success: true }));

    const { result } = renderHook(() => useConnectionForm({ ...defaultProps, onTestConnection }));

    act(() => {
      result.current.setName("Adapter Conn");
    });

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(onTestConnection).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(defaultProps.onConnect).toHaveBeenCalledTimes(1);
    // Form is reset after a successful connect
    expect(result.current.name).toBe("");
  });
});
