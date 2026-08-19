import "../setup-dom";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
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
    expect(result.current.testResult!.success).toBe(true);
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
    expect(result.current.testResult!.success).toBe(false);
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
    expect(resolveAgentRunConnectionId(saved, [served])).toBe("seed:sample");
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
    expect(resolveAgentRunConnectionId(saved, [served])).toBe("seed:sqlite-embedded-sample");
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
    expect(result.current.testResult!.success).toBe(false);
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
    expect(result.current.testResult!.success).toBe(true);
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
    expect(result.current.testResult!.success).toBe(false);
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
    expect(result.current.testResult!.success).toBe(false);
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
    expect(result.current.testResult!.success).toBe(false);
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
    expect(result.current.testResult?.success).toBe(true);
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

    expect(result.current.testResult?.success).toBe(false);
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
