import "../setup-dom";

import { describe, test, expect, afterEach, mock } from "bun:test";
import { renderHook, act } from "@testing-library/react";

import { useConnectionForm } from "@/hooks/use-connection-form";
import type { DatabaseConnection } from "@/lib/types";
import { declareHostUri } from "../helpers/synthetic-host-uri";
import { CREDENTIAL_WARNINGS, credentialWarningFor, readOnlySeedRefusal } from "@/lib/db/credential-warnings";
import {
  declareCredentialWarnings,
  SYNTHETIC_PAIR,
  SYNTHETIC_PASSWORD,
} from "../helpers/synthetic-credential-warnings";

/**
 * The Host box of an engine that declares `hostAcceptsUri`, through the real form hook and the real
 * `DB_UI_CONFIG`: unlike tests/hooks/use-connection-form.test.ts, nothing here mocks `@/lib/db-ui-config`,
 * because the declaration is read from the real table. Milvus, Qdrant and both InfluxDB types are the shipped entries that declare it;
 * the synthetic cases declare it on the etcd entry for their own duration, so they read as before.
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

  test("a typed address is split when the user leaves the Host box, so the dialog shows what Test and Save use", () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setPort("6333"));
    act(() => result.current.setHost("https://localhost", "insertText"));
    expect([result.current.host, result.current.port, result.current.sslMode]).toEqual([
      "https://localhost",
      "6333",
      "disable",
    ]);
    act(() => result.current.settleHost());
    expect([result.current.host, result.current.port, result.current.sslMode]).toEqual([
      "localhost",
      "443",
      "verify-system",
    ]);
  });

  test("leaving a Host box that holds a host, or a refused address, changes nothing but the refusal", () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setPort("2379"));
    act(() => result.current.setHost("db.internal", "insertText"));
    act(() => result.current.settleHost());
    expect([result.current.host, result.current.port, result.current.sslMode]).toEqual([
      "db.internal",
      "2379",
      "disable",
    ]);
    act(() => result.current.setHost("https://user:pw@db.internal", "insertText"));
    act(() => result.current.settleHost());
    expect(result.current.host).toBe("https://user:pw@db.internal");
    expect(result.current.testResult).toEqual({ tone: "error", message: USERINFO_SENTENCE });
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

  test("a refusal clears once the Host box is edited, and a test result it did not write stays", async () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setHost("http://u:p@h.example:1", "insertFromPaste"));
    expect(result.current.testResult).toEqual({ tone: "error", message: USERINFO_SENTENCE });
    act(() => result.current.setHost("h.example", "deleteContentBackward"));
    expect([result.current.host, result.current.testResult]).toEqual(["h.example", null]);
    await act(async () => {
      await result.current.handleTestConnection();
    });
    const tested = result.current.testResult;
    expect(tested).not.toBeNull();
    act(() => result.current.setHost("h.example.org", "insertText"));
    expect(result.current.testResult).toBe(tested);
  });

  test("a refusal Test Connection said clears once the Host box is edited", async () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setHost("http://h.example/path", "insertText"));
    await act(async () => {
      await result.current.handleTestConnection();
    });
    expect(result.current.testResult?.tone).toBe("error");
    act(() => result.current.setHost("http://h.example", "deleteContentBackward"));
    expect(result.current.testResult).toBeNull();
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

describe("useConnectionForm: an address pasted into a Host box that already holds text", () => {
  test("replaces the prefilled host and is split, whatever the box held", () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setPort("2379"));
    expect(result.current.host).toBe("localhost");
    let taken = false;
    act(() => {
      taken = result.current.takeHostAddress("https://cluster.example.test");
    });
    expect(taken).toBe(true);
    expect([result.current.host, result.current.port, result.current.sslMode, result.current.testResult]).toEqual([
      "cluster.example.test",
      "443",
      "verify-system",
      null,
    ]);
  });

  test("a refused address replaces the box too, and shows its refusal", () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    let taken = false;
    act(() => {
      taken = result.current.takeHostAddress("https://user:pw@h.example.test");
    });
    expect(taken).toBe(true);
    expect(result.current.host).toBe("https://user:pw@h.example.test");
    expect(result.current.testResult).toEqual({ tone: "error", message: USERINFO_SENTENCE });
  });

  test("text that is not an address is left to the box, which inserts it at the caret", () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    let taken = true;
    act(() => {
      taken = result.current.takeHostAddress("cluster.example.test");
    });
    expect(taken).toBe(false);
    expect([result.current.host, result.current.testResult]).toEqual(["localhost", null]);
  });

  test("an engine that declares nothing leaves every paste to the box", () => {
    const { result } = renderForm();
    let taken = true;
    act(() => {
      taken = result.current.takeHostAddress("https://cluster.example.test");
    });
    expect(taken).toBe(false);
    expect([result.current.host, result.current.port]).toEqual(["localhost", "5432"]);
  });
});

describe("useConnectionForm: the Host box's own refusal", () => {
  test("names the refusal of a pasted address, and drops it once the box is edited", () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    expect(result.current.hostError).toBeUndefined();
    act(() => result.current.setHost("https://user:pw@h.example.test", "insertFromPaste"));
    expect(result.current.hostError).toBe(USERINFO_SENTENCE);
    act(() => result.current.setHost("https://h.example.test", "deleteContentBackward"));
    expect(result.current.hostError).toBeUndefined();
  });

  test("names the refusal Test Connection said about the Host box", async () => {
    restores.push(declareHostUri("etcd", ["http", "https"]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setHost("http://h.example/path", "insertText"));
    await act(async () => {
      await result.current.handleTestConnection();
    });
    expect(result.current.hostError).toBe(
      "Host takes a scheme, a host and a port only: remove the path after the host.",
    );
  });

  test("is not a test result about anything else", async () => {
    const { result, onTestConnection } = renderForm();
    onTestConnection.mockImplementation(async () => ({ success: false, error: "connection refused" }));
    await act(async () => {
      await result.current.handleTestConnection();
    });
    expect(result.current.testResult?.tone).toBe("error");
    expect(result.current.hostError).toBeUndefined();
  });
});

describe("useConnectionForm: the declared credential warning", () => {
  const PAIR_SENTENCE = `Credential warning: ${SYNTHETIC_PAIR.message}`;

  test("warns for the declared pair, with the sentence the seed refusal uses", () => {
    restores.push(declareCredentialWarnings("etcd", [SYNTHETIC_PAIR]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setUser("root"));
    act(() => result.current.setPassword(SYNTHETIC_PASSWORD));
    const credential = { user: "root", password: SYNTHETIC_PASSWORD };
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

  test("an empty user with the password root:<the declared password> is read as the pair", () => {
    restores.push(declareCredentialWarnings("etcd", [SYNTHETIC_PAIR]));
    const { result } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setPassword(`root:${SYNTHETIC_PASSWORD}`));
    expect(result.current.credentialWarning).toBe(PAIR_SENTENCE);
  });

  test("a user left from another engine does not count where this engine takes no user", () => {
    restores.push(declareCredentialWarnings("libsql", [SYNTHETIC_PAIR]));
    const { result } = renderForm();
    act(() => result.current.setUser("root"));
    act(() => result.current.setType("libsql"));
    act(() => result.current.setPassword(SYNTHETIC_PASSWORD));
    expect(result.current.credentialWarning).toBeUndefined();
  });

  test("the warning blocks nothing: Test Connection and Establish Connection still run", async () => {
    restores.push(declareCredentialWarnings("etcd", [SYNTHETIC_PAIR]));
    const { result, onTestConnection, onConnect } = renderForm();
    act(() => result.current.setType("etcd"));
    act(() => result.current.setUser("root"));
    act(() => result.current.setPassword(SYNTHETIC_PASSWORD));
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
    act(() => result.current.setPassword(SYNTHETIC_PASSWORD));
    expect(result.current.credentialWarning).toBeUndefined();
  });
});

describe("useConnectionForm: the real qdrant row (vector-family spec 3.12, 6.2)", () => {
  const TEST_PASSWORD = "password";

  test("the real qdrant row splits a pasted address in the Host box and keeps the port as typed", () => {
    const { result } = renderForm();
    act(() => result.current.setType("qdrant"));
    act(() => result.current.setHost("http://localhost:6333", "insertFromPaste"));
    expect([result.current.type, result.current.host, result.current.port, result.current.sslMode]).toEqual([
      "qdrant",
      "localhost",
      "6333",
      "disable",
    ]);
    act(() => result.current.setHost("https://xyz-example.cloud.example.com:443", "insertFromPaste"));
    expect([result.current.host, result.current.port, result.current.sslMode]).toEqual([
      "xyz-example.cloud.example.com",
      "443",
      "verify-system",
    ]);
  });

  test("the real qdrant row warns for a JWT that declares no expiry, before Test Connection", () => {
    const jwt = CREDENTIAL_WARNINGS.qdrant?.find((entry) => entry.kind === "jwt");
    if (jwt?.kind !== "jwt") throw new Error("the qdrant record declares no jwt entry");
    const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${b64url({ alg: "HS256" })}.${b64url({ access: "r" })}.c2ln`;
    const { result, onTestConnection } = renderForm();
    act(() => result.current.setType("qdrant"));
    act(() => result.current.setPassword(token));
    expect(result.current.credentialWarning).toBe(`Credential warning: ${jwt.message}`);
    expect(onTestConnection).not.toHaveBeenCalled();
  });

  test("a user typed for another engine is neither saved nor tested on a Qdrant connection", async () => {
    const { result, onConnect, onTestConnection } = renderForm();
    act(() => result.current.setUser("root"));
    act(() => result.current.setType("qdrant"));
    act(() => result.current.setHost("127.0.0.1"));
    act(() => result.current.setPassword(TEST_PASSWORD));
    await act(async () => {
      await result.current.handleTestConnection();
    });
    await act(async () => {
      await result.current.handleConnect();
    });
    expect(onTestConnection.mock.calls[0][0].user).toBeUndefined();
    expect(onConnect.mock.calls[0][0].user).toBeUndefined();
    expect(onConnect.mock.calls[0][0].database).toBeUndefined();
  });
});

describe("useConnectionForm: the real milvus row (vector-family spec 3.12, 5.2)", () => {
  test("the real milvus row splits a pasted https address in the Host box and keeps 443", () => {
    const { result } = renderForm();
    act(() => result.current.setType("milvus"));
    act(() => result.current.setHost("https://in03-abc.serverless.example.com:443", "insertFromPaste"));
    expect([result.current.type, result.current.host, result.current.port, result.current.sslMode]).toEqual([
      "milvus",
      "in03-abc.serverless.example.com",
      "443",
      "verify-system",
    ]);
  });

  test("the real milvus row warns for the declared pair before Test Connection", () => {
    const pair = CREDENTIAL_WARNINGS.milvus?.find((entry) => entry.kind === "pair");
    if (pair?.kind !== "pair") throw new Error("the milvus record declares no pair");
    const { result } = renderForm();
    act(() => result.current.setType("milvus"));
    act(() => result.current.setUser(pair.user));
    act(() => result.current.setPassword(pair.password));
    expect(result.current.credentialWarning).toBe(`Credential warning: ${pair.message}`);
  });
});

describe("useConnectionForm: the real InfluxDB rows (InfluxDB spec A.3)", () => {
  test.each(["influxdb", "influxdb3"] as const)(
    "the real %s row splits a pasted InfluxDB Cloud https address in the Host box and keeps 443",
    (type) => {
      const { result } = renderForm();
      act(() => result.current.setType(type));
      act(() => result.current.setHost("https://us-east-1-1.aws.cloud2.influxdata.com:443", "insertFromPaste"));
      expect([result.current.type, result.current.host, result.current.port, result.current.sslMode]).toEqual([
        type,
        "us-east-1-1.aws.cloud2.influxdata.com",
        "443",
        "verify-system",
      ]);
    },
  );
});
