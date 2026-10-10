import "../setup-dom";

import { describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import { useConnectionForm } from "@/hooks/use-connection-form";
import type { ImportedContext } from "@/lib/connection-import";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";

/**
 * `applyImported`, the one entry point an import fills the form through, run on the real form hook and the real
 * `DB_UI_CONFIG`: no type declares an import yet, and the hook never reads the declaration, only the entry it is given.
 */

const MARKER = "import-marker-7f3a";

function renderForm(editConnection: DatabaseConnection | null = null) {
  const onConnect = mock((_connection: DatabaseConnection) => {});
  const onTestConnection = mock(async (_connection: DatabaseConnection) => ({ success: true }));
  const view = renderHook(() =>
    useConnectionForm({ isOpen: true, onClose: () => {}, onConnect, editConnection, onTestConnection }),
  );
  return { ...view, onConnect, onTestConnection };
}

function entry(overrides: Partial<ImportedContext> = {}): ImportedContext {
  return {
    name: "staging",
    fields: { host: "db.example", port: "6543", user: "reader", password: MARKER, database: "app" },
    notices: [],
    ...overrides,
  };
}

describe("useConnectionForm: applyImported fills a new connection", () => {
  test("every field the entry gives, the entry's name and a success banner", () => {
    const { result } = renderForm();
    act(() => result.current.applyImported(entry()));
    expect({
      name: result.current.name,
      host: result.current.host,
      port: result.current.port,
      user: result.current.user,
      password: result.current.password,
      database: result.current.database,
      testResult: result.current.testResult,
    }).toEqual({
      name: "staging",
      host: "db.example",
      port: "6543",
      user: "reader",
      password: MARKER,
      database: "app",
      testResult: { tone: "success", message: "Filled from staging. Review the fields and connect." },
    });
  });

  test("a name already typed and the environment chosen are kept", () => {
    const { result } = renderForm();
    act(() => result.current.setName("mine"));
    act(() => result.current.setEnvironment("production"));
    act(() => result.current.applyImported(entry()));
    expect([result.current.name, result.current.environment]).toEqual(["mine", "production"]);
  });

  test("an entry with no port takes the type's default port, not the one left in the form", () => {
    const { result } = renderForm();
    act(() => result.current.setType("mysql"));
    act(() => result.current.setPort("9999"));
    act(() => result.current.applyImported(entry({ fields: { host: "db.example" } })));
    expect([result.current.type, result.current.port]).toEqual(["mysql", "3306"]);
  });

  test("nothing typed for another server survives: password, certificates and the SSH tunnel are cleared", () => {
    const { result } = renderForm();
    act(() => result.current.setPassword("left-over"));
    act(() => result.current.setSSLMode("verify-ca"));
    act(() => result.current.setCaCert("LEFT-OVER CA"));
    act(() => result.current.setSSHEnabled(true));
    act(() => result.current.setSSHHost("bastion.example"));
    act(() => result.current.applyImported(entry({ fields: { host: "db.example" } })));
    expect({
      password: result.current.password,
      sslMode: result.current.sslMode,
      caCert: result.current.caCert,
      sshEnabled: result.current.sshEnabled,
      sshHost: result.current.sshHost,
    }).toEqual({ password: "", sslMode: "disable", caCert: "", sshEnabled: false, sshHost: "" });
  });

  test("SSL / TLS settings fill the panel and open it, and the connection carries them", async () => {
    const { result, onConnect } = renderForm();
    act(() =>
      result.current.applyImported(
        entry({ ssl: { mode: "verify-full", caCert: "CA PEM", clientCert: "CERT PEM", clientKey: "KEY PEM" } }),
      ),
    );
    expect([result.current.sslMode, result.current.showSSL, result.current.caCert]).toEqual([
      "verify-full",
      true,
      "CA PEM",
    ]);
    await act(async () => {
      await result.current.handleConnect();
    });
    expect(onConnect.mock.calls[0]?.[0].ssl).toEqual({
      mode: "verify-full",
      caCert: "CA PEM",
      clientCert: "CERT PEM",
      clientKey: "KEY PEM",
    });
  });

  test("an SSL mode alone clears certificates left in the form", () => {
    const { result } = renderForm();
    act(() => result.current.setCaCert("LEFT-OVER CA"));
    act(() => result.current.applyImported(entry({ ssl: { mode: "verify-system" } })));
    expect([result.current.sslMode, result.current.caCert, result.current.clientKey]).toEqual([
      "verify-system",
      "",
      "",
    ]);
  });

  test("an entry's notices make the banner a warning that carries them", () => {
    const { result } = renderForm();
    act(() => result.current.applyImported(entry({ notices: ["The token was not imported.", "Fill it in."] })));
    expect(result.current.testResult).toEqual({
      tone: "warning",
      message: "Filled from staging. The token was not imported. Fill it in.",
    });
  });

  test("a caution acknowledged for the server before is shown again for the imported one", async () => {
    const caution = { message: "the earlier server's caution", severity: "NOTICE" };
    const onConnect = mock((_connection: DatabaseConnection) => {});
    const onTestConnection = mock(async (_connection: DatabaseConnection) => ({ success: true, warnings: [caution] }));
    const { result } = renderHook(() =>
      useConnectionForm({ isOpen: true, onClose: () => {}, onConnect, editConnection: null, onTestConnection }),
    );
    act(() => result.current.setHost("earlier.example"));
    await act(async () => {
      await result.current.handleConnect();
    });
    expect(result.current.testResult?.tone).toBe("warning");
    act(() => result.current.applyImported(entry()));
    await act(async () => {
      await result.current.handleConnect();
    });
    expect(onConnect).not.toHaveBeenCalled();
    expect(result.current.testResult?.tone).toBe("warning");
    expect(result.current.testResult?.message).toContain("the earlier server's caution");
  });

  test.each([
    ["mongodb", { connectionString: "mongodb://db.example/app" }, "connectionString", "mongodb://db.example/app"],
    ["oracle", { serviceName: "ORCLPDB1" }, "serviceName", "ORCLPDB1"],
    ["mssql", { instanceName: "SQLEXPRESS" }, "instanceName", "SQLEXPRESS"],
    ["kafka", { saslMechanism: "SCRAM-SHA-256" }, "saslMechanism", "SCRAM-SHA-256"],
    ["cassandra", { localDataCenter: "dc1" }, "localDataCenter", "dc1"],
    ["mongodb", { authSource: "admin" }, "authSource", "admin"],
    ["elasticsearch", { apiKeyId: "id", apiKeySecret: "secret" }, "apiKeySecret", "secret"],
    ["oxia", { dataServers: "a:6648,b:6648" }, "dataServers", "a:6648,b:6648"],
    ["databend", { warehouse: "wh" }, "warehouse", "wh"],
    ["trino", { schema: "public" }, "schema", "public"],
    ["s3", { region: "eu-west-1" }, "region", "eu-west-1"],
  ] as const)("%s takes %p", (type, fields, read, value) => {
    const { result } = renderForm();
    act(() => result.current.setType(type as DatabaseType));
    act(() => result.current.applyImported(entry({ fields })));
    expect(result.current[read]).toBe(value);
    expect(result.current.testResult?.tone).toBe("success");
  });

  test("the choices about how to connect are kept: read-only, the object scan and the query timeout", async () => {
    const { result, onConnect } = renderForm();
    act(() => result.current.setType("neo4j"));
    act(() => result.current.setReadOnly(true));
    act(() => result.current.setSkipObjectScan(true));
    act(() => result.current.setQueryTimeout("30000"));
    act(() => result.current.applyImported(entry({ fields: { host: "db.example" } })));
    expect([result.current.readOnly, result.current.skipObjectScan, result.current.queryTimeout]).toEqual([
      true,
      true,
      "30000",
    ]);
    await act(async () => {
      await result.current.handleConnect();
    });
    expect(onConnect.mock.calls[0]?.[0]).toMatchObject({ readOnly: true, skipObjectScan: true, queryTimeout: 30000 });
  });

  test("a connection string pasted for another server and not applied is dropped with its box", () => {
    const { result } = renderForm();
    act(() => result.current.setShowPasteInput(true));
    act(() => result.current.setPasteInput(`postgres://other:${MARKER}@other.example/app`));
    act(() => result.current.applyImported(entry()));
    expect([result.current.showPasteInput, result.current.pasteInput]).toEqual([false, ""]);
  });

  test("the entry is read once: a value that changes after the check is not the one filled", () => {
    const { result } = renderForm();
    let reads = 0;
    const fields = {
      get host() {
        reads += 1;
        return reads === 1 ? "checked.example" : MARKER;
      },
    };
    const given = { name: "staging", notices: [], fields } as unknown as ImportedContext;
    let filled: boolean | undefined;
    act(() => {
      filled = result.current.applyImported(given);
    });
    expect([filled, result.current.host, reads]).toEqual([true, "checked.example", 1]);
  });

  test("a connection string switches the form to the connection-string mode", () => {
    const { result } = renderForm();
    act(() => result.current.setType("mongodb"));
    act(() => result.current.applyImported(entry({ fields: { connectionString: "mongodb://db.example/app" } })));
    expect(result.current.mongoConnectionMode).toBe("connectionString");
  });

  test("a service or instance name opens the Advanced section, as the edit load does", () => {
    const { result } = renderForm();
    act(() => result.current.setType("oracle"));
    act(() => result.current.applyImported(entry({ fields: { serviceName: "ORCLPDB1" } })));
    expect(result.current.showAdvanced).toBe(true);
  });
});

describe("useConnectionForm: applyImported refuses an entry and fills nothing", () => {
  const FIELD = "The imported entry names a field this connection type does not take, so nothing was filled.";
  const VALUE =
    "The imported entry gives a value that is not text, or a choice this connection type does not offer, so nothing was filled.";
  const SSL =
    "The imported entry gives an SSL / TLS setting the dialog does not offer, or certificates without an SSL mode, so nothing was filled.";
  const SHAPE = "The imported entry is not in the shape an import gives, so nothing was filled.";

  test.each([
    ["a field the type does not take", entry({ fields: { warehouse: MARKER } }), FIELD],
    ["the consent to send a password without TLS", { ...entry(), fields: { allowInsecureAuth: "true" } }, FIELD],
    ["a field no type takes", { ...entry(), fields: { [MARKER]: MARKER } }, FIELD],
    ["a value that is not text", { ...entry(), fields: { host: 5432 } }, VALUE],
    [
      "an SSL setting the dialog draws no control for",
      { ...entry(), ssl: { mode: "require", rejectUnauthorized: false } },
      SSL,
    ],
    ["an SSL mode that does not exist", { ...entry(), ssl: { mode: MARKER } }, SSL],
    ["certificates without an SSL mode", entry({ ssl: { caCert: MARKER } }), SSL],
    ["an SSL value that is not text", { ...entry(), ssl: { mode: "verify-full", caCert: 1 } }, SSL],
    ["a name that is not text", { ...entry(), name: 7 }, SHAPE],
    ["notices that are not a list of sentences", { ...entry(), notices: [MARKER, 1] }, SHAPE],
    ["notices that are not a list", { ...entry(), notices: MARKER }, SHAPE],
    ["fields that are not a record", { ...entry(), fields: [MARKER] }, SHAPE],
    ["an SSL panel that is not a record", { ...entry(), ssl: MARKER }, SHAPE],
    ["no entry at all", null, SHAPE],
  ] as const)("%s", (_label, given, sentence) => {
    const { result } = renderForm();
    act(() => result.current.setHost("kept.example"));
    act(() => result.current.applyImported(given as unknown as ImportedContext));
    expect(result.current.testResult).toEqual({ tone: "error", message: sentence });
    expect(result.current.testResult?.message).not.toContain(MARKER);
    expect([result.current.host, result.current.password, result.current.name]).toEqual(["kept.example", "", ""]);
  });

  test.each([
    [
      "a client certificate under require, where the dialog draws no box for it",
      { mode: "require", clientCert: MARKER },
    ],
    [
      "a client key under verify-system, where the dialog draws no box for it",
      { mode: "verify-system", clientKey: MARKER },
    ],
    ["a client key with SSL off", { mode: "disable", clientKey: MARKER }],
    ["a CA certificate with SSL off", { mode: "disable", caCert: MARKER }],
  ] as const)("%s", (_label, ssl) => {
    const { result, onConnect } = renderForm();
    act(() => result.current.setHost("kept.example"));
    let filled: boolean | undefined;
    act(() => {
      filled = result.current.applyImported(entry({ ssl }));
    });
    expect(filled).toBe(false);
    expect(result.current.testResult).toEqual({ tone: "error", message: SSL });
    expect([result.current.host, result.current.caCert, result.current.clientCert, result.current.clientKey]).toEqual([
      "kept.example",
      "",
      "",
      "",
    ]);
    expect(onConnect).not.toHaveBeenCalled();
  });

  test("an SSL setting for a file-based type, whose dialog draws no SSL panel", () => {
    const { result } = renderForm();
    act(() => result.current.setType("sqlite"));
    act(() =>
      result.current.applyImported(
        entry({ fields: { database: "/tmp/app.db" }, ssl: { mode: "verify-full", caCert: MARKER } }),
      ),
    );
    expect(result.current.testResult).toEqual({ tone: "error", message: SSL });
    expect([result.current.database, result.current.sslMode, result.current.caCert]).toEqual(["", "disable", ""]);
  });

  test("an entry that throws while it is read is refused as a shape, and nothing escapes", () => {
    const { result } = renderForm();
    const given = {
      name: "staging",
      notices: [],
      get fields() {
        throw new Error(MARKER);
      },
    } as unknown as ImportedContext;
    let filled: boolean | undefined;
    expect(() =>
      act(() => {
        filled = result.current.applyImported(given);
      }),
    ).not.toThrow();
    expect(filled).toBe(false);
    expect(result.current.testResult).toEqual({ tone: "error", message: SHAPE });
  });

  test("a choice the type's select does not offer", () => {
    const { result } = renderForm();
    act(() => result.current.setType("kafka"));
    act(() => result.current.applyImported(entry({ fields: { saslMechanism: "GSSAPI" } })));
    expect(result.current.testResult).toEqual({ tone: "error", message: VALUE });
    expect(result.current.saslMechanism).toBe("");
  });

  // Every case above runs on PostgreSQL, which does not take the consent field, so this one runs on a type that does.
  test("the consent to send a password without TLS, on a type that takes it", () => {
    const { result } = renderForm();
    act(() => result.current.setType("db2"));
    act(() => result.current.setHost("kept.example"));
    act(() =>
      result.current.applyImported({
        ...entry(),
        fields: { host: "db.example", allowInsecureAuth: "true" },
      } as unknown as ImportedContext),
    );
    expect(result.current.testResult).toEqual({ tone: "error", message: FIELD });
    expect([result.current.allowInsecureAuth, result.current.host]).toEqual([false, "kept.example"]);
  });

  test("an edited connection is never filled", () => {
    const editing: DatabaseConnection = {
      id: "c1",
      name: "saved",
      type: "postgres",
      host: "saved.example",
      port: 5432,
      createdAt: new Date(0),
    };
    const { result } = renderForm(editing);
    act(() => result.current.applyImported(entry()));
    expect(result.current.testResult).toEqual({
      tone: "error",
      message: "An import fills a new connection, so it is not applied while a connection is being edited.",
    });
    expect([result.current.host, result.current.password]).toEqual(["saved.example", ""]);
  });
});
