import "../setup-dom";

import { describe, test, expect, afterEach, mock } from "bun:test";
import { renderHook, act } from "@testing-library/react";

import { useConnectionForm } from "@/hooks/use-connection-form";
import type { DatabaseConnection } from "@/lib/types";
import { declareHostUri } from "../helpers/synthetic-host-uri";
import { credentialWarningFor, readOnlySeedRefusal } from "@/lib/db/credential-warnings";
import { declareCredentialWarnings, SYNTHETIC_PAIR } from "../helpers/synthetic-credential-warnings";

/**
 * The Host box of an engine that declares `hostAcceptsUri`, through the real form hook and the real
 * `DB_UI_CONFIG`: unlike tests/hooks/use-connection-form.test.ts, nothing here mocks `@/lib/db-ui-config`,
 * because the declaration is read from the real table. No shipped entry declares it, so each test declares it on
 * the etcd entry for its own duration.
 */

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

const USERINFO_SENTENCE =
  "Host takes no user name or password inside the address: remove the part before @ and enter the credentials in their own fields.";

function renderForm(editConnection: DatabaseConnection | null = null) {
  const onConnect = mock((_connection: DatabaseConnection) => {});
  const onTestConnection = mock(async (_connection: DatabaseConnection) => ({ success: true }));
  const view = renderHook(() =>
    useConnectionForm({ isOpen: true, onClose: () => {}, onConnect, editConnection, onTestConnection }),
  );
  return { ...view, onConnect, onTestConnection };
}

describe("useConnectionForm: an address in the Host box", () => {
  test("a pasted http:// address fills Host and Port and leaves SSL Mode as it was", () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setHost("http://localhost:6333", "insertFromPaste"));
    expect([result.current.host, result.current.port, result.current.sslMode]).toEqual([
      "localhost",
      "6333",
      "disable",
    ]);
  });

  test("a pasted https:// address keeps an explicit 443 and raises a disabled SSL Mode to verify-system", () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setHost("https://h.example:443", "insertFromPaste"));
    expect([result.current.host, result.current.port, result.current.sslMode, result.current.showSSL]).toEqual([
      "h.example",
      "443",
      "verify-system",
      true,
    ]);
  });

  test("a dropped https:// address with no port means 443, and a stricter SSL Mode stays", () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setSSLMode("verify-full"));
    act(() => result.current.setHost("https://h.example", "insertFromDrop"));
    expect([result.current.host, result.current.port, result.current.sslMode]).toEqual([
      "h.example",
      "443",
      "verify-full",
    ]);
  });

  test("a pasted http:// address never lowers a TLS mode the dialog holds", () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setSSLMode("require"));
    act(() => result.current.setHost("http://h.example:80", "insertFromPaste"));
    expect([result.current.host, result.current.port, result.current.sslMode]).toEqual(["h.example", "80", "require"]);
  });

  test("a typed address is kept as typed, and split when the connection is tested", async () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const { result, onTestConnection } = renderForm();
    act(() => result.current.setType("etcd"));
    const text = "http://localhost:6333";
    for (let end = 1; end <= text.length; end++) {
      act(() => result.current.setHost(text.slice(0, end), "insertText"));
    }
    expect([result.current.host, result.current.port, result.current.testResult]).toEqual([text, "5432", null]);
    await act(async () => {
      await result.current.handleTestConnection();
    });
    const sent = onTestConnection.mock.calls[0][0];
    expect([sent.host, sent.port, sent.ssl]).toEqual(["localhost", 6333, undefined]);
  });

  test("a typed https:// address is saved split, with SSL Mode raised", async () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const { result, onConnect } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setHost("https://h.example"));
    await act(async () => {
      await result.current.handleConnect();
    });
    const saved = onConnect.mock.calls[0][0];
    expect([saved.host, saved.port, saved.ssl]).toEqual(["h.example", 443, { mode: "verify-system" }]);
  });

  test("a refused paste says which part to remove, keeps the text, and Test Connection sends nothing", async () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const { result, onTestConnection } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setHost("https://user:s3cret-value@h.example", "insertFromPaste"));
    expect(result.current.host).toBe("https://user:s3cret-value@h.example");
    expect(result.current.testResult).toEqual({ tone: "error", message: USERINFO_SENTENCE });
    await act(async () => {
      await result.current.handleTestConnection();
    });
    await act(async () => {
      await result.current.handleConnect();
    });
    expect(onTestConnection).not.toHaveBeenCalled();
    expect(result.current.testResult).toEqual({ tone: "error", message: USERINFO_SENTENCE });
  });

  test("an engine that declares nothing keeps the Host box raw, pasted or typed", async () => {
    const { result, onConnect } = renderForm();
    act(() => result.current.setHost("http://localhost:6333", "insertFromPaste"));
    expect([result.current.type, result.current.host, result.current.port]).toEqual([
      "postgres",
      "http://localhost:6333",
      "5432",
    ]);
    await act(async () => {
      await result.current.handleConnect();
    });
    const saved = onConnect.mock.calls[0][0];
    expect([saved.host, saved.port]).toEqual(["http://localhost:6333", 5432]);
  });

  test("editing a saved connection shows its stored host as it was saved, and a save splits it", async () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const stored: DatabaseConnection = {
      id: "conn-etcd",
      name: "Stored",
      type: "etcd",
      host: "http://legacy.example:2379",
      port: 2379,
      createdAt: new Date(),
    };
    const { result, onConnect } = renderForm(stored);
    expect([result.current.host, result.current.port]).toEqual(["http://legacy.example:2379", "2379"]);
    await act(async () => {
      await result.current.handleConnect();
    });
    const saved = onConnect.mock.calls[0][0];
    expect([saved.host, saved.port]).toEqual(["legacy.example", 2379]);
  });

  test("the paste box and the Host box read one address differently, by design", () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    // The connection-string box reads http(s):// as ClickHouse for every form, whatever type it holds.
    const pasteBox = renderForm();
    act(() => pasteBox.result.current.setType("etcd"));
    act(() => pasteBox.result.current.setPasteInput("http://localhost:6333"));
    act(() => pasteBox.result.current.handlePasteConnectionString());
    expect([
      pasteBox.result.current.type,
      pasteBox.result.current.host,
      pasteBox.result.current.port,
      pasteBox.result.current.sslMode,
    ]).toEqual(["clickhouse", "localhost", "6333", "disable"]);
    // The Host box of a type that declares hostAcceptsUri keeps the type and takes the address.
    const hostBox = renderForm();
    act(() => hostBox.result.current.setType("etcd"));
    act(() => hostBox.result.current.setHost("http://localhost:6333", "insertFromPaste"));
    expect([hostBox.result.current.type, hostBox.result.current.host, hostBox.result.current.port]).toEqual([
      "etcd",
      "localhost",
      "6333",
    ]);
  });
});

describe("useConnectionForm: the declared credential warning", () => {
  const PAIR_SENTENCE = `Credential warning: ${SYNTHETIC_PAIR.message}`;

  test("warns for the declared pair, with the sentence the seed refusal uses", () => {
    restores.push(declareCredentialWarnings("etcd", [SYNTHETIC_PAIR]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setUser("root"));
    act(() => result.current.setPassword("Milvus"));
    const credential = { user: "root", password: "Milvus" };
    expect(result.current.credentialWarning).toBe(PAIR_SENTENCE);
    expect(result.current.credentialWarning).toBe(credentialWarningFor("etcd", credential));
    expect(result.current.credentialWarning).toBe(readOnlySeedRefusal("etcd", credential));
  });

  test("no warning for the declared user with another password", () => {
    restores.push(declareCredentialWarnings("etcd", [SYNTHETIC_PAIR]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setUser("root"));
    act(() => result.current.setPassword("Other1"));
    expect(result.current.credentialWarning).toBeUndefined();
  });

  test("an empty user with the password root:Milvus is read as the pair", () => {
    restores.push(declareCredentialWarnings("etcd", [SYNTHETIC_PAIR]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setPassword("root:Milvus"));
    expect(result.current.credentialWarning).toBe(PAIR_SENTENCE);
  });

  test("a user left from another engine does not count where this engine takes no user", () => {
    restores.push(declareCredentialWarnings("libsql", [SYNTHETIC_PAIR]));
    const { result } = renderForm();
    act(() => result.current.setUser("root"));
    act(() => result.current.setType("libsql"));
    act(() => result.current.setPassword("Milvus"));
    expect(result.current.credentialWarning).toBeUndefined();
  });

  test("the warning blocks nothing: Test Connection and Establish Connection still run", async () => {
    restores.push(declareCredentialWarnings("etcd", [SYNTHETIC_PAIR]));
    const { result, onTestConnection, onConnect } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setUser("root"));
    act(() => result.current.setPassword("Milvus"));
    await act(async () => {
      await result.current.handleTestConnection();
    });
    await act(async () => {
      await result.current.handleConnect();
    });
    expect(onTestConnection).toHaveBeenCalledTimes(2);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  test("an engine that declares nothing never warns", () => {
    const { result } = renderForm();
    act(() => result.current.setUser("root"));
    act(() => result.current.setPassword("Milvus"));
    expect(result.current.credentialWarning).toBeUndefined();
  });
});
