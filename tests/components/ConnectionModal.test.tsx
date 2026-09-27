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
const mockSetQueryTimeout = mock(() => {});
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
const mockSetAuthSource = mock(() => {});
const mockSetApiKeyId = mock(() => {});
const mockSetApiKeySecret = mock(() => {});
const mockSetSkipObjectScan = mock(() => {});
const mockSetSaslMechanism = mock(() => {});

let mockFormOverrides: Record<string, unknown> = {};

function getDefaultForm() {
  return {
    type: "postgres" as const,
    setType: mockSetType,
    name: "",
    setName: mockSetName,
    queryTimeout: "",
    setQueryTimeout: mockSetQueryTimeout,
    skipObjectScan: false,
    setSkipObjectScan: mockSetSkipObjectScan,
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
    schema: "",
    setSchema: mock(() => {}),
    authSource: "",
    setAuthSource: mockSetAuthSource,
    apiKeyId: "",
    setApiKeyId: mockSetApiKeyId,
    apiKeySecret: "",
    setApiKeySecret: mockSetApiKeySecret,
    saslMechanism: "",
    setSaslMechanism: mockSetSaslMechanism,
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
        color: "text-hue-blue",
      },
      { value: "mysql", label: "MySQL", icon: () => React.createElement("span", null, "MY"), color: "text-hue-amber" },
      { value: "sqlite", label: "SQLite", icon: () => React.createElement("span", null, "SL"), color: "text-hue-cyan" },
      {
        value: "mongodb",
        label: "MongoDB",
        icon: () => React.createElement("span", null, "MG"),
        color: "text-hue-emerald",
      },
      { value: "redis", label: "Redis", icon: () => React.createElement("span", null, "RD"), color: "text-hue-red" },
    ],
    ...mockFormOverrides,
  };
}

mock.module("@/hooks/use-connection-form", () => ({
  useConnectionForm: mock(() => getDefaultForm()),
}));

// ── Mock @/lib/db-ui-config ─────────────────────────────────────────────────
// Mirrors the real table for the engines that diverge from the networked default. A mock
// that gave every type the full field set is what let the modal draw a Username box for
// libSQL and a Database box for Druid unnoticed: the assertion that the box is absent
// passes or fails against THIS list, not against src/lib/db-ui-config.ts. The real table is
// the authority and tests/unit/lib/db-ui-config.test.ts derives it from the providers.
const MOCK_CONNECTION_FIELDS: Record<string, string[]> = {
  trino: ["host", "port", "user", "password", "database", "schema"],
  sqlite: ["database"],
  libredb: ["database"],
  duckdb: ["database"],
  libsql: ["host", "port", "password", "connectionString"],
  druid: ["host", "port", "user", "password"],
  elasticsearch: ["host", "port", "user", "password", "apiKeyId", "apiKeySecret"],
  opensearch: ["host", "port", "user", "password"],
  prometheus: ["host", "port", "user", "password"],
  kafka: ["host", "port", "saslMechanism", "user", "password"],
};
const mockFields = (type: string): string[] =>
  MOCK_CONNECTION_FIELDS[type] ?? ["host", "port", "user", "password", "database"];

/**
 * What a `DatabaseUIConfig` may declare about its connection fields: labels and hints keyed by
 * field (#1085), the choices of a field drawn as a select, and whether the SSH panel is offered
 * (#1088).
 */
interface MockFieldCopy {
  readonly fieldLabels?: Readonly<Record<string, string>>;
  readonly fieldHints?: Readonly<Record<string, string>>;
  readonly fieldOptions?: Readonly<Record<string, readonly { readonly value: string; readonly label: string }[]>>;
  readonly showSshTunnel?: false;
}

/**
 * The copy each engine DECLARES for its connection fields (#1085), mirrored from the real table the
 * way MOCK_CONNECTION_FIELDS mirrors its field lists. Prometheus and Kafka are the shipped entries
 * that declare any, which tests/unit/lib/db-ui-config.test.ts pins against the real table.
 */
const MOCK_FIELD_COPY: Record<string, MockFieldCopy> = {
  prometheus: {
    fieldLabels: { user: "User", password: "Password or token" },
    fieldHints: { password: "Leave User empty to send this as a bearer token." },
  },
  kafka: {
    fieldLabels: { saslMechanism: "SASL mechanism" },
    fieldHints: { saslMechanism: "PLAIN and SCRAM require TLS" },
    fieldOptions: {
      saslMechanism: [
        { value: "PLAIN", label: "PLAIN" },
        { value: "SCRAM-SHA-256", label: "SCRAM-SHA-256" },
        { value: "SCRAM-SHA-512", label: "SCRAM-SHA-512" },
      ],
    },
    showSshTunnel: false,
  },
};

/** Copy one test declares on top of the mirrored table, reset before every test. */
let mockDeclaredCopy: MockFieldCopy = {};

mock.module("@/lib/db-ui-config", () => ({
  getDBConfig: (type: string) => ({
    icon: () => null,
    color: "text-hue-blue",
    label: type,
    defaultPort: type === "mysql" ? "3306" : type === "mongodb" ? "27017" : "5432",
    // Mirrors the real config: the URI-addressed providers offer the toggle.
    showConnectionStringToggle: type === "mongodb" || type === "couchbase",
    connectionFields: mockFields(type),
    ...MOCK_FIELD_COPY[type],
    ...mockDeclaredCopy,
  }),
  takesConnectionField: (type: string, field: string) => mockFields(type).includes(field),
  // The real rule over the mirrored table: false only where an entry declares `showSshTunnel: false`.
  offersSshTunnel: (type: string) => MOCK_FIELD_COPY[type]?.showSshTunnel !== false,
  // The real pair's rule, mirrored the way `isFileBased` below mirrors its own: the modal reads
  // its field copy through these two, and the real ones run in tests/unit/lib/db-ui-config.test.ts.
  connectionFieldLabel: (config: MockFieldCopy, field: string, fallback: string) =>
    config.fieldLabels?.[field] ?? fallback,
  connectionFieldHint: (config: MockFieldCopy, field: string) => config.fieldHints?.[field],
  getDBIcon: () => () => null,
  getDBColor: () => "text-hue-blue",
  // `isFileBased` must be mocked now that `DB_UI_CONFIG` is an exported binding (#425 made
  // it one so the login showcase can enumerate it). The real `isFileBased` reads that
  // binding, and this mock replaces it with `{}`, so leaving the function to the real module
  // makes it throw on `DB_UI_CONFIG[type].connectionFields` for every render. Mirrors the
  // real rule: a file-based provider carries only a path.
  isFileBased: (type: string) => mockFields(type).length === 1 && mockFields(type)[0] === "database",
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
    mockDeclaredCopy = {};
    mockSetType.mockClear();
    mockSetName.mockClear();
    mockSetQueryTimeout.mockClear();
    mockSetHost.mockClear();
    mockSetPort.mockClear();
    mockSetShowPasteInput.mockClear();
    mockSetShowSSL.mockClear();
    mockSetSaslMechanism.mockClear();
    mockHandleTestConnection.mockClear();
    mockHandleConnect.mockClear();
  });

  // ── 1. Does not render when isOpen=false ────────────────────────────────────

  test("shows an optional query timeout with the default hint and forwards edits", () => {
    const { getByLabelText, getByText, rerender } = render(React.createElement(ConnectionModal, createDefaultProps()));
    const input = getByLabelText("Query Timeout (ms)") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("60000");
    expect(input.min).toBe("1");
    expect(input.max).toBe("2147483647");
    expect(input.step).toBe("1");
    expect(getByText("Leave blank to use the default of 60 seconds.")).toBeDefined();
    fireEvent.change(input, { target: { value: "120000" } });
    expect(mockSetQueryTimeout).toHaveBeenCalledWith("120000");
    mockFormOverrides = { queryTimeout: "120000" };
    rerender(React.createElement(ConnectionModal, createDefaultProps()));
    fireEvent.change(input, { target: { value: "" } });
    expect(mockSetQueryTimeout).toHaveBeenCalledWith("");
  });

  // #765: the connection that holds tens of thousands of objects is the one that knows,
  // so the choice is made here rather than in a global setting.
  test("offers the no-scan choice with its consequence spelled out, and forwards it", () => {
    const { getByLabelText, getByText } = render(React.createElement(ConnectionModal, createDefaultProps()));
    const box = getByLabelText("Do not read the object list on connect") as HTMLInputElement;

    expect(box.checked).toBe(false);
    expect(getByText("The editor still works. The object panel offers a load action instead.")).toBeDefined();

    fireEvent.click(box);
    expect(mockSetSkipObjectScan).toHaveBeenCalledWith(true);
  });

  test("shows the saved no-scan choice when editing", () => {
    mockFormOverrides = { isEditMode: true, skipObjectScan: true };
    const { getByLabelText } = render(React.createElement(ConnectionModal, createDefaultProps()));
    expect((getByLabelText("Do not read the object list on connect") as HTMLInputElement).checked).toBe(true);
  });

  test("shows the saved query timeout when editing", () => {
    mockFormOverrides = { isEditMode: true, queryTimeout: "120000" };
    const { getByLabelText } = render(React.createElement(ConnectionModal, createDefaultProps()));
    expect((getByLabelText("Query Timeout (ms)") as HTMLInputElement).value).toBe("120000");
  });

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
    mockFormOverrides = { testResult: { tone: "success", message: "Connection successful" } };
    const props = createDefaultProps();
    const { queryByText, getByTestId } = render(React.createElement(ConnectionModal, props));
    expect(queryByText("Connection successful")).not.toBeNull();
    expect(getByTestId("connection-test-result").getAttribute("data-tone")).toBe("success");
  });

  // ── 21. Test result failure displayed ──────────────────────────────────

  test("test result failure message displayed", () => {
    mockFormOverrides = { testResult: { tone: "error", message: "Connection failed: timeout" } };
    const props = createDefaultProps();
    const { queryByText, getByTestId } = render(React.createElement(ConnectionModal, props));
    expect(queryByText("Connection failed: timeout")).not.toBeNull();
    expect(getByTestId("connection-test-result").getAttribute("data-tone")).toBe("error");
  });

  // ── 21b. Test result warning displayed (#498) ────────────────────────────

  test("test result warning message renders as neither success nor failure", () => {
    // A degraded save/connect asks the user to act again - it is not a completed
    // action and not a refusal either, so it must not render as the success
    // (success token/CircleCheck) or error (danger token/CircleX) tone.
    mockFormOverrides = {
      testResult: { tone: "warning", message: "Connected, but this server answered no health data." },
    };
    const props = createDefaultProps();
    const { queryByText, getByTestId } = render(React.createElement(ConnectionModal, props));
    expect(queryByText("Connected, but this server answered no health data.")).not.toBeNull();
    const banner = getByTestId("connection-test-result");
    expect(banner.getAttribute("data-tone")).toBe("warning");
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

  // ── 29b. verify-system is offered, and says what it verifies (D26) ──────

  test("the SSL mode row offers verify-system and selecting it reaches the form", () => {
    mockFormOverrides = { showSSL: true };
    const props = createDefaultProps();
    const { getByText } = render(React.createElement(ConnectionModal, props));

    const button = getByText("verify-system").closest("button");
    expect(button).not.toBeNull();
    fireEvent.click(button as HTMLButtonElement);
    expect(mockSetSSLMode).toHaveBeenCalledWith("verify-system");
  });

  // The copy is the whole point of the mode: a user who cannot tell it from verify-ca will
  // go looking for the CA file it does not need. Each mode gets its own sentence, so the
  // panel says what the selected one verifies rather than only naming it.
  test("each SSL mode explains what it verifies", () => {
    mockFormOverrides = { showSSL: true, sslMode: "verify-system" };
    const { queryByTestId } = render(React.createElement(ConnectionModal, createDefaultProps()));
    expect(queryByTestId("ssl-mode-hint")?.textContent).toContain("system trust store");
    expect(queryByTestId("ssl-mode-hint")?.textContent).toContain("no certificate");
  });

  test("the hint for require says it checks nothing", () => {
    mockFormOverrides = { showSSL: true, sslMode: "require" };
    const { queryByTestId } = render(React.createElement(ConnectionModal, createDefaultProps()));
    expect(queryByTestId("ssl-mode-hint")?.textContent).toContain("Encrypts but verifies nothing");
  });

  test("the hint for disable says the traffic is plaintext", () => {
    mockFormOverrides = { showSSL: true, sslMode: "disable" };
    const { queryByTestId } = render(React.createElement(ConnectionModal, createDefaultProps()));
    expect(queryByTestId("ssl-mode-hint")?.textContent).toContain("Plaintext");
  });

  test("the hints for verify-ca and verify-full both name the pasted CA", () => {
    mockFormOverrides = { showSSL: true, sslMode: "verify-ca" };
    const ca = render(React.createElement(ConnectionModal, createDefaultProps()));
    expect(ca.queryByTestId("ssl-mode-hint")?.textContent).toContain("CA certificate below");
    ca.unmount();

    mockFormOverrides = { showSSL: true, sslMode: "verify-full" };
    const full = render(React.createElement(ConnectionModal, createDefaultProps()));
    expect(full.queryByTestId("ssl-mode-hint")?.textContent).toContain("CA certificate below");
    expect(full.queryByTestId("ssl-mode-hint")?.textContent).toContain("names the host you typed");
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

  // ── an addressing input exists exactly where a value is written ──────────
  //
  // `connectionFields` decides what `buildConnection` saves. The modal used to draw
  // Username and Database for every networked engine regardless, so four engines asked
  // for a value that was then discarded on save - a box that collects nothing is the UI
  // form of reporting an absence as a measurement.

  test("libSQL renders neither a Username nor a Database box, because it takes neither", () => {
    // libSQL authenticates with a token the server minted - it has no user names at all -
    // and addresses the whole database by URL. Its `connectionFields` say so, and nothing
    // carried either box's value before this.
    mockFormOverrides = { type: "libsql" };
    const props = createDefaultProps();
    const { container } = render(React.createElement(ConnectionModal, props));

    expect(container.querySelector("#user")).toBeNull();
    expect(container.querySelector("#database")).toBeNull();
    // Not a blanket removal: the engine is still addressed, and still takes a credential.
    expect(container.querySelector("#host")).not.toBeNull();
    expect(container.querySelector("#password")).not.toBeNull();
  });

  test.each(["druid", "elasticsearch", "opensearch"] as const)(
    "%s renders a Username but no Database box, matching what it takes",
    (type) => {
      // These three authenticate with HTTP Basic - their transports build the header from
      // `config.user` - and name the datasource or index in the statement instead of on
      // the connection. So exactly one of the two boxes belongs.
      mockFormOverrides = { type };
      const props = createDefaultProps();
      const { container } = render(React.createElement(ConnectionModal, props));

      expect(container.querySelector("#user")).not.toBeNull();
      expect(container.querySelector("#database")).toBeNull();
    },
  );

  test("redis renders a Username box, because its provider authenticates with one", () => {
    // The Redis 6 ACL user. #502 taught the provider to send it to ioredis as `username`,
    // measured on both arms, and the box has to be here for a value to reach it.
    mockFormOverrides = { type: "redis" };
    const props = createDefaultProps();
    const { container } = render(React.createElement(ConnectionModal, props));

    expect(container.querySelector("#user")).not.toBeNull();
    expect(container.querySelector("#database")).not.toBeNull();
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

  test("Trino exposes an editable session schema beside the catalog", () => {
    const setSchema = mock(() => {});
    mockFormOverrides = { type: "trino", schema: "tiny", setSchema };
    const { getByLabelText } = render(React.createElement(ConnectionModal, createDefaultProps()));
    const input = getByLabelText("Schema Name") as HTMLInputElement;
    expect(input.value).toBe("tiny");
    fireEvent.change(input, { target: { value: "default" } });
    expect(setSchema).toHaveBeenCalledWith("default");
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
    expect(queryByText("Schema Name")).toBeNull();
    expect(queryByText(/refuses a password over plain HTTP/)).toBeNull();
  });

  // ── 34b-bis. libSQL asks for a TOKEN, and says where one comes from ───────
  //
  // libSQL has no user names at all: the credential a server checks is a JWT it
  // minted, so the shared `password` field holds a token here. A field labelled
  // Password invites a password no libSQL server has, and a self-hosted server
  // started without authentication takes none at all - both measured on sqld 0.24.33
  // and on Turso Cloud, 2026-08-27.

  test("libSQL type labels the password field Auth Token and says where one comes from", () => {
    mockFormOverrides = { type: "libsql" };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Auth Token")).not.toBeNull();
    expect(queryByText("Password")).toBeNull();
    expect(queryByText(/turso db tokens create/)).not.toBeNull();
  });

  test("no other type is asked for an Auth Token", () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText("Auth Token")).toBeNull();
    expect(queryByText(/turso db tokens create/)).toBeNull();
  });

  // ── 34b-ter. Prometheus: one password box that also carries a token (#1085 6.1) ──
  //
  // Prometheus declares its password label and hint on `DB_UI_CONFIG` (#1085 3.3) instead of
  // joining the per-type chain libSQL's Auth Token belongs to. The dialog reads them here from the
  // mock's mirror, `MOCK_FIELD_COPY`; the real entry's values are pinned in
  // tests/unit/lib/db-ui-config.test.ts. Together they are the unit half of the registration gate
  // of #1085 section 9, and the browser pass is its other half.

  test("Prometheus labels the password field Password or token and says a lone password is sent as a bearer token", () => {
    mockFormOverrides = { type: "prometheus" };
    const { container, getByTestId, queryByText } = render(React.createElement(ConnectionModal, createDefaultProps()));

    expect(container.querySelector('label[for="password"]')?.textContent).toBe("Password or token");
    expect(getByTestId("password-hint").textContent).toBe("Leave User empty to send this as a bearer token.");
    // The hint names the field "User", so the field is labelled that.
    expect(container.querySelector('label[for="user"]')?.textContent).toBe("User");
    expect(container.querySelector("#password")?.getAttribute("aria-describedby")).toBe("password-hint");
    // No Database box: every read of the HTTP API goes to the one TSDB the server holds (#1085 6.1).
    expect(container.querySelector("#database")).toBeNull();
    // libSQL's token wording stays libSQL's: the declaration replaced a label, not the chain.
    expect(queryByText("Auth Token")).toBeNull();
    // The controls: the engine is still addressed, and takes its user box beside the password box.
    expect(container.querySelector("#host")).not.toBeNull();
    expect(container.querySelector("#user")).not.toBeNull();
  });

  // ── 34b-quater. Kafka: a declared SASL select, the TLS panel, and no SSH tunnel (#1088 6.1) ──
  //
  // The select is drawn from the `kafka` entry's `fieldOptions` declaration, never from an
  // `isKafka` branch, and the SSH panel is withheld through `offersSshTunnel`: a tunnel forwards one
  // address, and a Kafka client reaches every broker at the address the broker advertises. The
  // mock mirrors the declaration in `MOCK_FIELD_COPY`; the real entry is pinned in
  // tests/unit/lib/db-ui-config.test.ts.

  test("Kafka offers a SASL mechanism select with a None choice and the three mechanisms", () => {
    mockFormOverrides = { type: "kafka" };
    const { container, getByTestId } = render(React.createElement(ConnectionModal, createDefaultProps()));

    const select = container.querySelector("#saslMechanism") as HTMLSelectElement | null;
    expect(select?.tagName).toBe("SELECT");
    expect(container.querySelector('label[for="saslMechanism"]')?.textContent).toBe("SASL mechanism");
    const options = [...(select?.options ?? [])].map((option) => ({ value: option.value, label: option.textContent }));
    expect(options).toEqual([
      { value: "", label: "None" },
      { value: "PLAIN", label: "PLAIN" },
      { value: "SCRAM-SHA-256", label: "SCRAM-SHA-256" },
      { value: "SCRAM-SHA-512", label: "SCRAM-SHA-512" },
    ]);
    // The form holds no mechanism, so the select shows None.
    expect(select?.value).toBe("");
    // The declared hint is drawn under it and named by it, before the provider's refusal says so.
    expect(getByTestId("saslMechanism-hint").textContent).toBe("PLAIN and SCRAM require TLS");
    expect(select?.getAttribute("aria-describedby")).toBe("saslMechanism-hint");
  });

  test("choosing a mechanism, and then None, reaches the form state", () => {
    mockFormOverrides = { type: "kafka" };
    const { container } = render(React.createElement(ConnectionModal, createDefaultProps()));
    const select = container.querySelector("#saslMechanism") as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "SCRAM-SHA-512" } });
    expect(mockSetSaslMechanism).toHaveBeenLastCalledWith("SCRAM-SHA-512");
    fireEvent.change(select, { target: { value: "" } });
    expect(mockSetSaslMechanism).toHaveBeenLastCalledWith("");
    expect(mockSetSaslMechanism).toHaveBeenCalledTimes(2);
  });

  test("the select shows the mechanism the form holds", () => {
    mockFormOverrides = { type: "kafka", saslMechanism: "SCRAM-SHA-256" };
    const { container } = render(React.createElement(ConnectionModal, createDefaultProps()));

    expect((container.querySelector("#saslMechanism") as HTMLSelectElement).value).toBe("SCRAM-SHA-256");
  });

  test("Kafka renders no Database box, and keeps the host, user and password boxes", () => {
    mockFormOverrides = { type: "kafka" };
    const { container } = render(React.createElement(ConnectionModal, createDefaultProps()));

    // One connection is one cluster (#1088 6.1), so there is no database to name.
    expect(container.querySelector("#database")).toBeNull();
    expect(container.querySelector("#host")).not.toBeNull();
    expect(container.querySelector("#user")).not.toBeNull();
    expect(container.querySelector("#password")).not.toBeNull();
  });

  test("Kafka keeps the SSL/TLS panel and draws no SSH Tunnel toggle, even with a tunnel left on in the form", () => {
    // `sshEnabled` and an open panel are what a tunnel switched on under another type leaves in the
    // dialog's state; the toggle and the panel stay withheld all the same.
    mockFormOverrides = { type: "kafka", sshEnabled: true, showSSH: true };
    const { queryByText } = render(React.createElement(ConnectionModal, createDefaultProps()));

    expect(queryByText("SSL / TLS")).not.toBeNull();
    expect(queryByText("SSH Tunnel")).toBeNull();
    expect(queryByText("Enable SSH Tunnel")).toBeNull();
  });

  test("the control: an engine that offers a tunnel draws the SSH toggle and no SASL select", () => {
    mockFormOverrides = { type: "postgres", sshEnabled: true, showSSH: true };
    const { container, queryByText } = render(React.createElement(ConnectionModal, createDefaultProps()));

    expect(queryByText("SSH Tunnel")).not.toBeNull();
    expect(queryByText("Enable SSH Tunnel")).not.toBeNull();
    expect(container.querySelector("#saslMechanism")).toBeNull();
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

  // ── 34d. MongoDB asks where the credentials live ───────────────────────────
  //
  // The driver checks a user against whichever database the URI names, so a
  // deployment with its users in `admin` and its data elsewhere - the ordinary one -
  // could not be reached through the discrete fields at all, and said so as a
  // credentials error. The field is in the open, not behind Advanced.

  test("MongoDB offers an authentication database field", () => {
    mockFormOverrides = { type: "mongodb" };
    const props = createDefaultProps();
    const { queryByText, container } = render(React.createElement(ConnectionModal, props));

    const authDb = container.querySelector("#authSource") as HTMLInputElement | null;
    expect(authDb).not.toBeNull();
    expect(authDb!.placeholder).toBe("admin");
    expect(queryByText(/The database the user was created in/)).not.toBeNull();
  });

  test("editing the authentication database reaches the form state", () => {
    mockFormOverrides = { type: "mongodb" };
    const props = createDefaultProps();
    const { container } = render(React.createElement(ConnectionModal, props));

    fireEvent.change(container.querySelector("#authSource") as HTMLInputElement, { target: { value: "admin" } });

    expect(mockSetAuthSource).toHaveBeenCalledWith("admin");
  });

  test("the connection-string mode has no authentication database field", () => {
    // A pasted URI carries `?authSource=` itself and is used verbatim, so a second
    // input would be a value with nowhere to go.
    mockFormOverrides = { type: "mongodb", mongoConnectionMode: "connectionString" };
    const props = createDefaultProps();
    const { container } = render(React.createElement(ConnectionModal, props));

    expect(container.querySelector("#authSource")).toBeNull();
  });

  test("no other type carries the MongoDB field", () => {
    const props = createDefaultProps();
    const { container } = render(React.createElement(ConnectionModal, props));

    expect(container.querySelector("#authSource")).toBeNull();
  });

  // ── 34e. Elasticsearch offers the API key pair (#708) ──────────────────────

  test("Elasticsearch offers API key ID and secret fields", () => {
    mockFormOverrides = { type: "elasticsearch" };
    const props = createDefaultProps();
    const { container, queryByText } = render(React.createElement(ConnectionModal, props));

    expect(container.querySelector("#apiKeyId")).not.toBeNull();
    expect(container.querySelector("#apiKeySecret")).not.toBeNull();
    expect(queryByText(/Beats/)).not.toBeNull();
  });

  test("editing the API key pair reaches the form state", () => {
    mockFormOverrides = { type: "elasticsearch" };
    const props = createDefaultProps();
    const { container } = render(React.createElement(ConnectionModal, props));

    fireEvent.change(container.querySelector("#apiKeyId") as HTMLInputElement, { target: { value: "seed-key-id" } });
    fireEvent.change(container.querySelector("#apiKeySecret") as HTMLInputElement, {
      target: { value: "seed-key-secret" },
    });

    expect(mockSetApiKeyId).toHaveBeenCalledWith("seed-key-id");
    expect(mockSetApiKeySecret).toHaveBeenCalledWith("seed-key-secret");
  });

  test("OpenSearch does not offer the API key pair", () => {
    mockFormOverrides = { type: "opensearch" };
    const props = createDefaultProps();
    const { container } = render(React.createElement(ConnectionModal, props));

    expect(container.querySelector("#apiKeyId")).toBeNull();
    expect(container.querySelector("#apiKeySecret")).toBeNull();
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

  /*
    The copy an engine DECLARES for a connection field (#1085). `DatabaseUIConfig.fieldLabels` and
    `fieldHints` are read before this dialog's own words, and Prometheus and Kafka are the shipped
    entries that declare either. So the census pins every shipped type's field labels and hints:
    those two as `MOCK_FIELD_COPY` mirrors their declarations, and every other type's as they were
    before the declaration existed. The cases after it declare copy for every field and read it back from each
    place a field is drawn; that copy is synthetic and lives in `mockDeclaredCopy`. The real table's
    copy is pinned in tests/unit/lib/db-ui-config.test.ts, which runs the real helpers.
  */
  describe("declared connection-field copy (#1085)", () => {
    /** Every connection field, in the order `DatabaseUIConfig.connectionFields` names them. */
    const EVERY_FIELD = [
      "host",
      "port",
      "user",
      "password",
      "database",
      "schema",
      "connectionString",
      "serviceName",
      "instanceName",
      "localDataCenter",
      "authSource",
      "apiKeyId",
      "apiKeySecret",
      "saslMechanism",
    ] as const;

    /** Each connection-field label a render draws, keyed by the input it names (`htmlFor`). */
    const fieldLabelsOf = (container: HTMLElement): Record<string, string> => {
      const labels: Record<string, string> = {};
      for (const field of EVERY_FIELD) {
        const label = container.querySelector(`label[for="${field}"]`);
        if (label !== null) labels[field] = label.textContent ?? "";
      }
      return labels;
    };

    /** Each declared field hint a render draws, keyed by its field. */
    const fieldHintsOf = (container: HTMLElement): Record<string, string> => {
      const hints: Record<string, string> = {};
      for (const field of EVERY_FIELD) {
        const hint = container.querySelector(`[data-testid="${field}-hint"]`);
        if (hint !== null) hints[field] = hint.textContent ?? "";
      }
      return hints;
    };

    const NETWORKED = { host: "Host & Instance", user: "Username", password: "Password", database: "Database Name" };
    const CREDENTIALS_ONLY = { host: "Host & Instance", user: "Username", password: "Password" };
    const FILE_PATH = { database: "Database File Path" };

    /**
     * [case, type, form state, labels drawn, declared hints drawn] for every shipped type, read off
     * the dialog's code under the field lists and the field copy this file mirrors. Every row but
     * Prometheus's and Kafka's is what the dialog drew before the declaration existed.
     */
    const SHIPPED: readonly (readonly [
      string,
      string,
      Record<string, unknown>,
      Record<string, string>,
      Record<string, string>,
    ])[] = [
      ["postgres", "postgres", {}, NETWORKED, {}],
      ["mysql", "mysql", {}, NETWORKED, {}],
      ["redis", "redis", {}, NETWORKED, {}],
      ["oracle", "oracle", {}, NETWORKED, {}],
      ["mssql", "mssql", {}, NETWORKED, {}],
      ["clickhouse", "clickhouse", {}, NETWORKED, {}],
      ["mongodb", "mongodb", {}, { ...NETWORKED, authSource: "Authentication Database" }, {}],
      [
        "mongodb in connection-string mode",
        "mongodb",
        { mongoConnectionMode: "connectionString" },
        { connectionString: "Connection URI", database: "Database Name (optional override)" },
        {},
      ],
      ["couchbase", "couchbase", {}, { ...NETWORKED, database: "Bucket Name" }, {}],
      [
        "couchbase in connection-string mode",
        "couchbase",
        { mongoConnectionMode: "connectionString" },
        { connectionString: "Connection URI", database: "Bucket Name (optional override)" },
        {},
      ],
      ["trino", "trino", {}, { ...NETWORKED, database: "Catalog Name", schema: "Schema Name" }, {}],
      [
        "cassandra",
        "cassandra",
        {},
        { ...NETWORKED, database: "Keyspace Name", localDataCenter: "Local Data Center" },
        {},
      ],
      ["libsql", "libsql", {}, { host: "Host & Instance", password: "Auth Token" }, {}],
      ["druid", "druid", {}, CREDENTIALS_ONLY, {}],
      [
        "elasticsearch",
        "elasticsearch",
        {},
        { ...CREDENTIALS_ONLY, apiKeyId: "API Key ID", apiKeySecret: "API Key Secret" },
        {},
      ],
      ["opensearch", "opensearch", {}, CREDENTIALS_ONLY, {}],
      [
        "prometheus",
        "prometheus",
        {},
        { ...CREDENTIALS_ONLY, user: "User", password: "Password or token" },
        { password: "Leave User empty to send this as a bearer token." },
      ],
      [
        "kafka",
        "kafka",
        {},
        { ...CREDENTIALS_ONLY, saslMechanism: "SASL mechanism" },
        { saslMechanism: "PLAIN and SCRAM require TLS" },
      ],
      ["sqlite", "sqlite", {}, FILE_PATH, {}],
      ["duckdb", "duckdb", {}, FILE_PATH, {}],
      ["libredb", "libredb", {}, FILE_PATH, {}],
    ];

    test.each(SHIPPED)("%s draws exactly these field labels and declared hints", (_case, type, form, labels, hints) => {
      mockFormOverrides = { type, ...form };
      const { container } = render(React.createElement(ConnectionModal, createDefaultProps()));

      expect(fieldLabelsOf(container)).toEqual(labels);
      expect(fieldHintsOf(container)).toEqual(hints);
    });

    const declaredLabel = (field: string): string => `Declared label for ${field}`;
    const declaredHint = (field: string): string => `Declared hint for ${field}.`;
    const labelsFor = (...fields: string[]): Record<string, string> =>
      Object.fromEntries(fields.map((field) => [field, declaredLabel(field)]));
    const EVERY_FIELD_COPY: MockFieldCopy = {
      fieldLabels: Object.fromEntries(EVERY_FIELD.map((field) => [field, declaredLabel(field)])),
      fieldHints: Object.fromEntries(EVERY_FIELD.map((field) => [field, declaredHint(field)])),
    };

    /** [case, type, form state, labels drawn, fields whose declared hint is drawn], every field's copy declared. */
    const DECLARED: readonly (readonly [
      string,
      string,
      Record<string, unknown>,
      Record<string, string>,
      readonly string[],
    ])[] = [
      [
        "postgres",
        "postgres",
        {},
        labelsFor("host", "user", "password", "database"),
        ["host", "port", "user", "password", "database"],
      ],
      [
        "mongodb",
        "mongodb",
        {},
        labelsFor("host", "user", "password", "database", "authSource"),
        ["host", "port", "user", "password", "database", "authSource"],
      ],
      [
        "mongodb in connection-string mode",
        "mongodb",
        { mongoConnectionMode: "connectionString" },
        {
          connectionString: declaredLabel("connectionString"),
          database: `${declaredLabel("database")} (optional override)`,
        },
        ["connectionString", "database"],
      ],
      [
        "trino",
        "trino",
        {},
        labelsFor("host", "user", "password", "database", "schema"),
        ["host", "port", "user", "password", "database", "schema"],
      ],
      [
        "cassandra",
        "cassandra",
        {},
        labelsFor("host", "user", "password", "database", "localDataCenter"),
        ["host", "port", "user", "password", "database", "localDataCenter"],
      ],
      ["libsql", "libsql", {}, labelsFor("host", "password"), ["host", "port", "password"]],
      [
        "elasticsearch",
        "elasticsearch",
        {},
        labelsFor("host", "user", "password", "apiKeyId", "apiKeySecret"),
        ["host", "port", "user", "password", "apiKeyId", "apiKeySecret"],
      ],
      [
        "kafka",
        "kafka",
        {},
        labelsFor("host", "user", "password", "saslMechanism"),
        ["host", "port", "user", "password", "saslMechanism"],
      ],
      ["sqlite", "sqlite", {}, labelsFor("database"), ["database"]],
    ];

    test.each(DECLARED)(
      "%s draws the declared label and hint of every field it draws",
      (_case, type, form, labels, hinted) => {
        mockFormOverrides = { type, ...form };
        mockDeclaredCopy = EVERY_FIELD_COPY;
        const { container } = render(React.createElement(ConnectionModal, createDefaultProps()));

        // The declaration wins over the per-type chains too: Cassandra's "Keyspace" and libSQL's
        // "Auth Token" are replaced like every other word.
        expect(fieldLabelsOf(container)).toEqual(labels);
        expect(fieldHintsOf(container)).toEqual(
          Object.fromEntries(hinted.map((field) => [field, declaredHint(field)])),
        );
        for (const field of hinted) {
          expect(container.querySelector(`#${field}`)?.getAttribute("aria-describedby"), field).toBe(`${field}-hint`);
        }
      },
    );

    test.each([
      ["oracle", "serviceName", "Service Name", "ORCL or XEPDB1"],
      ["mssql", "instanceName", "Instance Name", "SQLEXPRESS"],
    ] as const)("%s's Advanced field draws its declared label and hint", (type, field, ownWord, placeholder) => {
      mockFormOverrides = { type, showAdvanced: true };
      mockDeclaredCopy = EVERY_FIELD_COPY;
      const { container, queryByText, getByTestId } = render(
        React.createElement(ConnectionModal, createDefaultProps()),
      );

      expect(queryByText(declaredLabel(field))).not.toBeNull();
      expect(queryByText(ownWord)).toBeNull();
      expect(getByTestId(`${field}-hint`).textContent).toBe(declaredHint(field));
      expect(container.querySelector(`input[placeholder="${placeholder}"]`)?.getAttribute("aria-describedby")).toBe(
        `${field}-hint`,
      );
    });

    test("the control: with nothing declared, an Advanced field keeps its own word and points at no hint", () => {
      mockFormOverrides = { type: "oracle", showAdvanced: true };
      const { container, queryByText, queryByTestId } = render(
        React.createElement(ConnectionModal, createDefaultProps()),
      );

      expect(queryByText("Service Name")).not.toBeNull();
      expect(queryByTestId("serviceName-hint")).toBeNull();
      expect(container.querySelector('input[placeholder="ORCL or XEPDB1"]')?.hasAttribute("aria-describedby")).toBe(
        false,
      );
    });

    test("a declared password hint joins libSQL's own sentence rather than replacing it", () => {
      // The per-type branches stay as they are (#1085); moving them onto the declaration is a
      // backlog item, so a declaration adds to what they draw, and a label left undeclared keeps
      // the branch's word.
      mockFormOverrides = { type: "libsql" };
      mockDeclaredCopy = { fieldHints: { password: "Declared hint for password." } };
      const { getByTestId, queryByText } = render(React.createElement(ConnectionModal, createDefaultProps()));

      expect(getByTestId("password-hint").textContent).toBe("Declared hint for password.");
      expect(queryByText(/turso db tokens create/)).not.toBeNull();
      expect(queryByText("Auth Token")).not.toBeNull();
    });
  });
});
