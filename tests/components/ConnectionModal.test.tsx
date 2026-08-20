import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { mock } from "bun:test";
import React from "react";

// ── Mock framer-motion before component imports ─────────────────────────────
mock.module("framer-motion", () => {
  const passthrough = ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", props, children as React.ReactNode);

  return {
    motion: new Proxy(
      {},
      {
        get: () => passthrough,
      },
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useAnimation: () => ({ start: mock(() => {}), stop: mock(() => {}) }),
    useInView: () => true,
  };
});

// ── Mock Drawer (vaul) ──────────────────────────────────────────────────────
mock.module("@/components/ui/drawer", () => ({
  Drawer: ({ open, children }: { open?: boolean; children: React.ReactNode }) => {
    if (!open) return null;
    return React.createElement("div", { "data-testid": "drawer" }, children);
  },
  DrawerContent: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement("div", { "data-testid": "drawer-content", className }, children),
  DrawerHeader: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement("div", { "data-testid": "drawer-header", className }, children),
  DrawerTitle: ({ children }: { children: React.ReactNode }) => React.createElement("h2", null, children),
  DrawerDescription: ({ children }: { children: React.ReactNode }) => React.createElement("p", null, children),
  DrawerFooter: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement("div", { "data-testid": "drawer-footer", className }, children),
}));

// ── Mock useIsMobile — tests always use Dialog (desktop) path ───────────────
mock.module("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

// ── Mock Radix Dialog via @/components/ui/dialog ────────────────────────────
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open?: boolean;
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    if (!open) return null;
    return React.createElement("div", { "data-testid": "dialog", "data-open": open }, children);
  },
  DialogContent: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement("div", { "data-testid": "dialog-content", className }, children),
  DialogHeader: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement("div", { "data-testid": "dialog-header", className }, children),
  DialogTitle: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement("h2", { "data-testid": "dialog-title", className }, children),
  DialogFooter: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement("div", { "data-testid": "dialog-footer", className }, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) => React.createElement("p", null, children),
  DialogClose: ({ children }: { children: React.ReactNode }) => React.createElement("button", null, children),
  DialogTrigger: ({ children }: { children: React.ReactNode }) => children,
  DialogPortal: ({ children }: { children: React.ReactNode }) => children,
  DialogOverlay: () => null,
}));

// ── Mock Shadcn UI primitives ───────────────────────────────────────────────
mock.module("@/components/ui/button", () => ({
  Button: ({ children, onClick, className, disabled, ...rest }: Record<string, unknown>) =>
    React.createElement(
      "button",
      { onClick: onClick as () => void, className, disabled, ...rest },
      children as React.ReactNode,
    ),
}));

mock.module("@/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => React.createElement("input", props),
}));

mock.module("@/components/ui/label", () => ({
  Label: ({ children, className, htmlFor }: Record<string, unknown>) =>
    React.createElement("label", { className, htmlFor }, children as React.ReactNode),
}));

// ── Mock useConnectionForm hook ─────────────────────────────────────────────
const mockSetType = mock(() => {});
const mockSetName = mock(() => {});
const mockSetHost = mock(() => {});
const mockSetPort = mock(() => {});
const mockSetUser = mock(() => {});
const mockSetPassword = mock(() => {});
const mockSetDatabase = mock(() => {});
const mockSetConnectionString = mock(() => {});
const mockSetMongoConnectionMode = mock(() => {});
const mockSetEnvironment = mock(() => {});
const mockSetTestResult = mock(() => {});
const mockSetPasteInput = mock(() => {});
const mockSetShowPasteInput = mock(() => {});
const mockSetShowSSL = mock(() => {});
const mockSetSSLMode = mock(() => {});
const mockSetCaCert = mock(() => {});
const mockSetClientCert = mock(() => {});
const mockSetClientKey = mock(() => {});
const mockSetShowAdvanced = mock(() => {});
const mockSetServiceName = mock(() => {});
const mockSetInstanceName = mock(() => {});
const mockSetShowSSH = mock(() => {});
const mockSetSSHEnabled = mock(() => {});
const mockSetSSHHost = mock(() => {});
const mockSetSSHPort = mock(() => {});
const mockSetSSHUsername = mock(() => {});
const mockSetSSHAuthMethod = mock(() => {});
const mockSetSSHPassword = mock(() => {});
const mockSetSSHPrivateKey = mock(() => {});
const mockSetSSHPassphrase = mock(() => {});
const mockHandleTestConnection = mock(async () => {});
const mockHandleConnect = mock(async () => {});
const mockHandlePasteConnectionString = mock(() => {});

const mockSetLocalDataCenter = mock(() => {});

let mockFormOverrides: Record<string, unknown> = {};

function getDefaultForm() {
  return {
    type: "postgres" as const,
    setType: mockSetType,
    name: "",
    setName: mockSetName,
    host: "localhost",
    setHost: mockSetHost,
    port: "5432",
    setPort: mockSetPort,
    user: "",
    setUser: mockSetUser,
    password: "",
    setPassword: mockSetPassword,
    database: "",
    setDatabase: mockSetDatabase,
    connectionString: "",
    setConnectionString: mockSetConnectionString,
    mongoConnectionMode: "host" as const,
    setMongoConnectionMode: mockSetMongoConnectionMode,
    environment: "local" as const,
    setEnvironment: mockSetEnvironment,
    isTesting: false,
    testResult: null,
    setTestResult: mockSetTestResult,
    pasteInput: "",
    setPasteInput: mockSetPasteInput,
    showPasteInput: false,
    setShowPasteInput: mockSetShowPasteInput,
    isEditMode: false,
    showSSL: false,
    setShowSSL: mockSetShowSSL,
    sslMode: "disable" as const,
    setSSLMode: mockSetSSLMode,
    caCert: "",
    setCaCert: mockSetCaCert,
    clientCert: "",
    setClientCert: mockSetClientCert,
    clientKey: "",
    setClientKey: mockSetClientKey,
    showAdvanced: false,
    setShowAdvanced: mockSetShowAdvanced,
    serviceName: "",
    setServiceName: mockSetServiceName,
    instanceName: "",
    setInstanceName: mockSetInstanceName,
    localDataCenter: "",
    setLocalDataCenter: mockSetLocalDataCenter,
    showSSH: false,
    setShowSSH: mockSetShowSSH,
    sshEnabled: false,
    setSSHEnabled: mockSetSSHEnabled,
    sshHost: "",
    setSSHHost: mockSetSSHHost,
    sshPort: "22",
    setSSHPort: mockSetSSHPort,
    sshUsername: "",
    setSSHUsername: mockSetSSHUsername,
    sshAuthMethod: "password" as const,
    setSSHAuthMethod: mockSetSSHAuthMethod,
    sshPassword: "",
    setSSHPassword: mockSetSSHPassword,
    sshPrivateKey: "",
    setSSHPrivateKey: mockSetSSHPrivateKey,
    sshPassphrase: "",
    setSSHPassphrase: mockSetSSHPassphrase,
    handleTestConnection: mockHandleTestConnection,
    handleConnect: mockHandleConnect,
    handlePasteConnectionString: mockHandlePasteConnectionString,
    dbTypes: [
      {
        value: "postgres",
        label: "PostgreSQL",
        icon: () => React.createElement("span", null, "PG"),
        color: "text-blue-400",
      },
      { value: "mysql", label: "MySQL", icon: () => React.createElement("span", null, "MY"), color: "text-amber-400" },
      { value: "sqlite", label: "SQLite", icon: () => React.createElement("span", null, "SL"), color: "text-cyan-400" },
      {
        value: "mongodb",
        label: "MongoDB",
        icon: () => React.createElement("span", null, "MG"),
        color: "text-emerald-400",
      },
      { value: "redis", label: "Redis", icon: () => React.createElement("span", null, "RD"), color: "text-red-400" },
    ],
    ...mockFormOverrides,
  };
}

mock.module("@/hooks/use-connection-form", () => ({
  useConnectionForm: mock(() => getDefaultForm()),
}));

// ── Mock @/lib/db-ui-config ─────────────────────────────────────────────────
mock.module("@/lib/db-ui-config", () => ({
  getDBConfig: (type: string) => ({
    icon: () => null,
    color: "text-blue-400",
    label: type,
    defaultPort: type === "mysql" ? "3306" : type === "mongodb" ? "27017" : "5432",
    // Mirrors the real config: the URI-addressed providers offer the toggle.
    showConnectionStringToggle: type === "mongodb" || type === "couchbase",
    connectionFields: ["host", "port", "user", "password", "database"],
  }),
  getDBIcon: () => () => null,
  getDBColor: () => "text-blue-400",
  // `isFileBased` must be mocked now that `DB_UI_CONFIG` is an exported binding (#425 made
  // it one so the login showcase can enumerate it). The real `isFileBased` reads that
  // binding, and this mock replaces it with `{}`, so leaving the function to the real module
  // makes it throw on `DB_UI_CONFIG[type].connectionFields` for every render. Mirrors the
  // real rule: a file-based provider carries only a path.
  isFileBased: (type: string) => type === "sqlite" || type === "libredb",
  DB_UI_CONFIG: {},
}));

// ── Mock lucide-react icons as simple spans ─────────────────────────────────
mock.module("lucide-react", () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "__esModule") return true;
        return (props: Record<string, unknown>) =>
          React.createElement("span", { "data-icon": prop, className: props.className as string });
      },
    },
  );
});

// ── Imports AFTER mocks ─────────────────────────────────────────────────────
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { ConnectionModal } from "@/components/ConnectionModal";

// =============================================================================
// ConnectionModal Tests
// =============================================================================

function createDefaultProps(overrides: Partial<Parameters<typeof ConnectionModal>[0]> = {}) {
  return {
    isOpen: true,
    onClose: mock(() => {}),
    onConnect: mock(() => {}),
    editConnection: null,
    ...overrides,
  };
}

describe("ConnectionModal", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockFormOverrides = {};
    mockSetType.mockClear();
    mockSetName.mockClear();
    mockSetHost.mockClear();
    mockSetPort.mockClear();
    mockSetShowPasteInput.mockClear();
    mockSetShowSSL.mockClear();
    mockHandleTestConnection.mockClear();
    mockHandleConnect.mockClear();
  });

  // ── 1. Does not render when isOpen=false ────────────────────────────────────

  test("does not render dialog content when isOpen is false", () => {
    const props = createDefaultProps({ isOpen: false });
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("New Connection")).toBeNull();
    expect(queryByText("Establish Connection")).toBeNull();
  });

  // ── 2. Renders dialog when isOpen=true ──────────────────────────────────────

  test("renders dialog content when isOpen is true", () => {
    const props = createDefaultProps({ isOpen: true });
    const { queryAllByText } = render(React.createElement(ConnectionModal, props));

    expect(queryAllByText("New Connection").length).toBeGreaterThan(0);
  });

  // ── 3. Shows "New Connection" title for new connection ──────────────────────

  test('shows "New Connection" title for new connection', () => {
    const props = createDefaultProps({ editConnection: null });
    const { queryAllByText } = render(React.createElement(ConnectionModal, props));

    expect(queryAllByText("New Connection").length).toBeGreaterThan(0);
  });

  // ── 4. Shows "Edit Connection" title when editConnection provided ───────────

  test('shows "Edit Connection" title when editConnection provided', () => {
    mockFormOverrides = { isEditMode: true };

    const editConn = {
      id: "e1",
      name: "My PG",
      type: "postgres" as const,
      host: "localhost",
      port: 5432,
      createdAt: new Date(),
    };
    const props = createDefaultProps({ editConnection: editConn });
    const { queryAllByText } = render(React.createElement(ConnectionModal, props));

    expect(queryAllByText("Edit Connection").length).toBeGreaterThan(0);
  });

  // ── 5. Database type buttons render ─────────────────────────────────────────

  test("database type buttons render", () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("PostgreSQL")).not.toBeNull();
    expect(queryByText("MySQL")).not.toBeNull();
    expect(queryByText("SQLite")).not.toBeNull();
    expect(queryByText("MongoDB")).not.toBeNull();
    expect(queryByText("Redis")).not.toBeNull();
  });

  // ── 6. Name input renders ──────────────────────────────────────────────────

  test("connection name input renders", () => {
    const props = createDefaultProps();
    const { queryByText, container } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Connection Name")).not.toBeNull();
    const nameInput = container.querySelector("#name");
    expect(nameInput).not.toBeNull();
  });

  // ── 7. Host/Port inputs render ─────────────────────────────────────────────

  test("host and port inputs render", () => {
    const props = createDefaultProps();
    const { queryByText, container } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Host & Instance")).not.toBeNull();
    const hostInput = container.querySelector("#host");
    const portInput = container.querySelector("#port");
    expect(hostInput).not.toBeNull();
    expect(portInput).not.toBeNull();
  });

  // ── 8. Test Connection button renders ──────────────────────────────────────

  test("Test Connection button renders", () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Test Connection")).not.toBeNull();
  });

  // ── 9. Connect button renders ──────────────────────────────────────────────

  test("Establish Connection button renders", () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Establish Connection")).not.toBeNull();
  });

  // ── 10. Save Changes button renders in edit mode ───────────────────────────

  test("shows Save Changes button in edit mode", () => {
    mockFormOverrides = { isEditMode: true };
    const editConn = {
      id: "e1",
      name: "My PG",
      type: "postgres" as const,
      host: "localhost",
      port: 5432,
      createdAt: new Date(),
    };
    const props = createDefaultProps({ editConnection: editConn });
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Save Changes")).not.toBeNull();
  });

  // ── 11. onClose fires when Cancel clicked ──────────────────────────────────

  test("onClose fires when Cancel button clicked", () => {
    const onClose = mock(() => {});
    const props = createDefaultProps({ onClose });
    const { getByText } = render(React.createElement(ConnectionModal, props));

    const cancelBtn = getByText("Cancel");
    fireEvent.click(cancelBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── 12. SSL section expandable ─────────────────────────────────────────────

  test("SSL / TLS section toggle button renders", () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("SSL / TLS")).not.toBeNull();
  });

  // ── 13. SSH Tunnel section renders ─────────────────────────────────────────

  test("SSH Tunnel section toggle button renders", () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("SSH Tunnel")).not.toBeNull();
  });

  // ── 14. Paste URL button renders for new connection ────────────────────────

  test("Paste URL button renders for new connection", () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Paste URL")).not.toBeNull();
  });

  // ── 15. Environment selector renders ───────────────────────────────────────

  test("Environment selector renders with environment options", () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Environment")).not.toBeNull();
    expect(queryByText("PROD")).not.toBeNull();
    expect(queryByText("STAGING")).not.toBeNull();
    expect(queryByText("DEV")).not.toBeNull();
    expect(queryByText("LOCAL")).not.toBeNull();
  });

  // ── 16. Paste URL shows input area when clicked ─────────────────────────

  test("Paste URL shows paste input area when showPasteInput is true", () => {
    mockFormOverrides = { showPasteInput: true };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText("Paste Connection URL")).not.toBeNull();
    expect(queryByText("Parse")).not.toBeNull();
  });

  // ── 17. SSL expanded shows SSL fields ───────────────────────────────────

  test("SSL section shows fields when expanded", () => {
    mockFormOverrides = { showSSL: true };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText("SSL Mode")).not.toBeNull();
  });

  // ── 18. SSH expanded shows SSH fields ───────────────────────────────────

  test("SSH section shows fields when expanded", () => {
    mockFormOverrides = { showSSH: true };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText("Enable SSH Tunnel")).not.toBeNull();
  });

  // ── 19. SSH enabled shows all SSH fields ─────────────────────────────────

  test("SSH enabled shows SSH connection fields", () => {
    mockFormOverrides = { showSSH: true, sshEnabled: true };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText("Enable SSH Tunnel")).not.toBeNull();
  });

  // ── 20. Test result success displayed ──────────────────────────────────

  test("test result success message displayed", () => {
    mockFormOverrides = { testResult: { success: true, message: "Connection successful" } };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText("Connection successful")).not.toBeNull();
  });

  // ── 21. Test result failure displayed ──────────────────────────────────

  test("test result failure message displayed", () => {
    mockFormOverrides = { testResult: { success: false, message: "Connection failed: timeout" } };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText("Connection failed: timeout")).not.toBeNull();
  });

  // ── 22. isTesting shows spinner state ─────────────────────────────────

  test("Test Connection button shows testing state", () => {
    mockFormOverrides = { isTesting: true };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText("Testing...")).not.toBeNull();
  });

  // ── 24. MongoDB connection string mode ──────────────────────────────────

  test("MongoDB shows connection mode toggle", () => {
    mockFormOverrides = { type: "mongodb" };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText("Host / Port")).not.toBeNull();
    expect(queryByText("Connection String")).not.toBeNull();
  });

  // ── 25. MongoDB connection string mode shows URI field ─────────────────

  test("MongoDB connection string mode shows URI field", () => {
    mockFormOverrides = { type: "mongodb", mongoConnectionMode: "connectionString" };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText("Connection URI")).not.toBeNull();
  });

  // ── 26. Advanced section for Oracle ────────────────────────────────────

  test("Oracle type shows advanced section", () => {
    mockFormOverrides = { type: "oracle", showAdvanced: true };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText("Service Name")).not.toBeNull();
  });

  // ── 27. Advanced section for MSSQL ─────────────────────────────────────

  test("MSSQL type shows instance name in advanced section", () => {
    mockFormOverrides = { type: "mssql", showAdvanced: true };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText("Instance Name")).not.toBeNull();
  });

  // ── 28. Paste URL hidden in edit mode ────────────────────────────────

  test("Paste URL button hidden in edit mode", () => {
    mockFormOverrides = { isEditMode: true };
    const editConn = {
      id: "e1",
      name: "My PG",
      type: "postgres" as const,
      host: "localhost",
      port: 5432,
      createdAt: new Date(),
    };
    const props = createDefaultProps({ editConnection: editConn });
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText("Paste URL")).toBeNull();
  });

  // ── 29. Supports URL text shown in paste area ────────────────────────

  test("paste area shows supported URL protocols", () => {
    mockFormOverrides = { showPasteInput: true };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText(/postgres:\/\//)).not.toBeNull();
  });

  // ── 30. SSL section for verify-ca shows client cert fields ─────────────

  test("SSL verify-ca mode renders SSL section", () => {
    mockFormOverrides = { showSSL: true, sslMode: "verify-ca" };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText("SSL Mode")).not.toBeNull();
  });

  // ── 31. Clicking a different DB type card sets type, default port, and resets test result ──

  test("clicking a different DB type card sets type, default port, and resets test result", () => {
    const props = createDefaultProps();
    const { getByText } = render(React.createElement(ConnectionModal, props));

    const mysqlButton = getByText("MySQL").closest("button");
    expect(mysqlButton).not.toBeNull();
    fireEvent.click(mysqlButton as HTMLButtonElement);

    expect(mockSetType).toHaveBeenCalledWith("mysql");
    expect(mockSetPort).toHaveBeenCalledWith("3306");
    expect(mockSetTestResult).toHaveBeenCalledWith(null);
  });

  // ── 32. SQLite type renders the file path input and its onChange updates database ──

  test("SQLite type renders Database File Path input and updates on change", () => {
    mockFormOverrides = { type: "sqlite" };
    const props = createDefaultProps();
    const { queryByText, container } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Database File Path")).not.toBeNull();

    const pathInput = container.querySelector("#database");
    expect(pathInput).not.toBeNull();
    fireEvent.change(pathInput as HTMLInputElement, { target: { value: "/data/app.db" } });

    expect(mockSetDatabase).toHaveBeenCalledWith("/data/app.db");
  });

  // ── 33. SSH private key auth mode renders PEM and passphrase fields ──

  test("SSH private key auth mode renders private key fields and their onChange handlers fire", () => {
    mockFormOverrides = { showSSH: true, sshEnabled: true, sshAuthMethod: "privateKey" };
    const props = createDefaultProps();
    const { queryByText, container } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Private Key (PEM)")).not.toBeNull();
    expect(queryByText("Passphrase (optional)")).not.toBeNull();

    const privateKeyTextarea = container.querySelector('textarea[placeholder*="OPENSSH PRIVATE KEY"]');
    expect(privateKeyTextarea).not.toBeNull();
    fireEvent.change(privateKeyTextarea as HTMLTextAreaElement, { target: { value: "fake-key-content" } });
    expect(mockSetSSHPrivateKey).toHaveBeenCalledWith("fake-key-content");

    const passphraseInput = container.querySelector('input[placeholder="Key passphrase (if encrypted)"]');
    expect(passphraseInput).not.toBeNull();
    fireEvent.change(passphraseInput as HTMLInputElement, { target: { value: "secret-pass" } });
    expect(mockSetSSHPassphrase).toHaveBeenCalledWith("secret-pass");
  });

  // ── 34. Couchbase labels the database field as the bucket it actually is ──

  test("Couchbase type labels the database field Bucket Name", () => {
    mockFormOverrides = { type: "couchbase" };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Bucket Name")).not.toBeNull();
    expect(queryByText("Database Name")).toBeNull();
  });

  test("Couchbase connection-string mode labels the override Bucket and shows a couchbase:// example", () => {
    mockFormOverrides = { type: "couchbase", mongoConnectionMode: "connectionString" };
    const props = createDefaultProps();
    const { queryByText, container } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Bucket Name (optional override)")).not.toBeNull();
    const uriInput = container.querySelector("#connectionString") as HTMLInputElement | null;
    expect(uriInput).not.toBeNull();
    expect(uriInput!.placeholder).toContain("couchbase://");
  });

  test("non-Couchbase types keep the Database Name label", () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Database Name")).not.toBeNull();
    expect(queryByText("Bucket Name")).toBeNull();
  });

  // ── 34b. Trino labels the same field as the CATALOG it actually is ────────
  //
  // Not cosmetic, and not the same claim Couchbase makes. A Trino catalog is a whole
  // external system - `hive`, `iceberg`, `tpch` - and it is the one value a user
  // cannot guess: a coordinator with no catalog pinned resolves no table at all.
  // Measured on 476, `SHOW CATALOGS` on the probe cluster answers five of them.

  test("Trino type labels the database field Catalog and says what belongs in it", () => {
    mockFormOverrides = { type: "trino" };
    const props = createDefaultProps();
    const { queryByText, container } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Catalog Name")).not.toBeNull();
    expect(queryByText("Database Name")).toBeNull();
    const databaseInput = container.querySelector("#database") as HTMLInputElement | null;
    expect(databaseInput!.placeholder).toBe("tpch");
    expect(queryByText(/The Trino catalog to open/)).not.toBeNull();
  });

  test("Trino warns that a password needs TLS, before the connection can 401 on it", () => {
    // Measured on 476 with authentication DISABLED: `Authorization: Basic` over plain
    // HTTP is answered 401, "Password not allowed for insecure authentication". So
    // typing a password into an http:// connection BREAKS one that would otherwise
    // work, which is the one failure mode a form must not produce silently.
    mockFormOverrides = { type: "trino" };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText(/refuses a password over plain HTTP/)).not.toBeNull();
  });

  test("no other type carries the Trino hints", () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Catalog Name")).toBeNull();
    expect(queryByText(/refuses a password over plain HTTP/)).toBeNull();
  });

  // ── 34c. Cassandra asks for the one field its driver cannot start without ──
  //
  // `cassandra-driver` 4.9.0 refuses to connect with no local data centre at all
  // ("'localDataCenter' is not defined in Client options and also was not specified in
  // constructor", measured), and names the data centres it DID find when the value is
  // wrong. No other engine here needs a topology answer from the connection, so the
  // field is rendered in the open rather than behind the Advanced accordion.

  test("Cassandra type labels the database field Keyspace and asks for the data centre", () => {
    mockFormOverrides = { type: "cassandra" };
    const props = createDefaultProps();
    const { queryByText, container } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Keyspace Name")).not.toBeNull();
    expect(queryByText("Database Name")).toBeNull();
    const keyspaceInput = container.querySelector("#database") as HTMLInputElement | null;
    expect(keyspaceInput!.placeholder).toBe("probe");

    const dataCentre = container.querySelector("#localDataCenter") as HTMLInputElement | null;
    expect(dataCentre).not.toBeNull();
    expect(dataCentre!.placeholder).toBe("datacenter1");
    expect(queryByText(/refuses to connect without/)).not.toBeNull();
  });

  test("editing the data centre reaches the form state", () => {
    mockFormOverrides = { type: "cassandra" };
    const props = createDefaultProps();
    const { container } = render(React.createElement(ConnectionModal, props));

    const dataCentre = container.querySelector("#localDataCenter") as HTMLInputElement;
    fireEvent.change(dataCentre, { target: { value: "eu-west-1" } });

    expect(mockSetLocalDataCenter).toHaveBeenCalledWith("eu-west-1");
  });

  test("no other type carries the Cassandra fields", () => {
    const props = createDefaultProps();
    const { queryByText, container } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Keyspace Name")).toBeNull();
    expect(container.querySelector("#localDataCenter")).toBeNull();
  });

  // ── 35. Browser autofill stays out of the credential fields ───────────────
  // These are server credentials, not the user's own login: Chrome's heuristic
  // sees "Username" + type=password and injects saved site passwords. Only
  // autocomplete="new-password" suppresses that ("off" is ignored on password
  // inputs by design), and it must be on the password field for the username
  // fill to drop too.

  test("connection credential inputs opt out of browser autofill", () => {
    const props = createDefaultProps();
    const { container } = render(React.createElement(ConnectionModal, props));

    expect(container.querySelector("#user")?.getAttribute("autocomplete")).toBe("off");
    expect(container.querySelector("#password")?.getAttribute("autocomplete")).toBe("new-password");
    expect(container.querySelector("#host")?.getAttribute("autocomplete")).toBe("off");
    expect(container.querySelector("#port")?.getAttribute("autocomplete")).toBe("off");
  });

  test("SSH password input opts out of browser autofill", () => {
    mockFormOverrides = { showSSH: true, sshEnabled: true, sshAuthMethod: "password" };
    const props = createDefaultProps();
    const { container } = render(React.createElement(ConnectionModal, props));

    const passwordInputs = Array.from(container.querySelectorAll('input[type="password"]'));
    expect(passwordInputs.length).toBe(2);
    for (const input of passwordInputs) {
      expect(input.getAttribute("autocomplete")).toBe("new-password");
    }

    // SSH Username sits next to a password field — same heuristic as the DB pair.
    const sshUsername = container.querySelector('input[placeholder="ubuntu"]');
    expect(sshUsername?.getAttribute("autocomplete")).toBe("off");
    const sshHost = container.querySelector('input[placeholder="bastion.example.com"]');
    expect(sshHost?.getAttribute("autocomplete")).toBe("off");
  });

  test("SSH passphrase input opts out of browser autofill", () => {
    mockFormOverrides = { showSSH: true, sshEnabled: true, sshAuthMethod: "privateKey" };
    const props = createDefaultProps();
    const { container } = render(React.createElement(ConnectionModal, props));

    const passphraseInput = container.querySelector('input[placeholder="Key passphrase (if encrypted)"]');
    expect(passphraseInput?.getAttribute("autocomplete")).toBe("new-password");
  });
});
