import assert from "node:assert/strict";
import {
  CONNECTION_FIELDS as SECRET_CLASS,
  type SecretFieldRecord,
  SSH_TUNNEL_FIELDS,
  SSL_FIELDS,
  secretFieldValues,
  withSecretFieldValues,
} from "@/lib/storage/secret-fields";
import {
  ID_PATTERN,
  idOfSecretKey,
  isPlainObject,
  SECRET_PATHS,
  secretKey,
  secretPathsIn,
} from "../../../src/host/connections/secret-keys";
import { wirePg } from "../../fakes/profiles";

/** "v" under every key of a classification map. */
const filled = (map: Record<string, unknown>) => Object.fromEntries(Object.keys(map).map((key) => [key, "v"]));

/**
 * Two connection ids and their keys, joined from parts: a random-looking id inside a key ending "password" reads like
 * a credential to a secret scanner.
 */
const PG_ID = "1kq2v7x93j0ab";
const SRV_ID = "3f9wz0c1m2rt";
const PG_KEY = ["connection", PG_ID, "password"].join("/");
const SRV_KEY = ["connection", SRV_ID, "ssl.clientKey"].join("/");

describe("secret keys", () => {
  it("keys a secret by its connection id and its path", () => {
    assert.equal(secretKey(PG_ID, "password"), PG_KEY);
    assert.equal(secretKey(SRV_ID, "ssl.clientKey"), SRV_KEY);
  });

  it("refuses an id off the setting's id pattern, naming the id", () => {
    assert.throws(() => secretKey("a/b", "password"), { message: '"a/b" is not a connection id.' });
    assert.throws(() => secretKey("", "password"), { message: '"" is not a connection id.' });
    assert.equal(ID_PATTERN.test("x".repeat(64)), true);
    assert.equal(ID_PATTERN.test("x".repeat(65)), false);
  });

  it("reads the id back out of a key, and nothing out of any other string", () => {
    assert.equal(idOfSecretKey(PG_KEY), PG_ID);
    assert.equal(idOfSecretKey(SRV_KEY), SRV_ID);
    for (const key of [
      "connection/abc",
      "connection//password",
      "connection/abc/",
      "connection/a b/password",
      "other/abc/password",
    ]) {
      assert.equal(idOfSecretKey(key), undefined, key);
    }
  });

  it("holds exactly the paths the leaf's own walk reports, at its three levels", () => {
    const record = { ...filled(SECRET_CLASS), ssl: filled(SSL_FIELDS), sshTunnel: filled(SSH_TUNNEL_FIELDS) };
    assert.deepEqual(new Set(Object.keys(secretFieldValues(record as unknown as SecretFieldRecord))), SECRET_PATHS);
    const every = Object.fromEntries([...SECRET_PATHS].map((path) => [path, `v-${path}`]));
    const holder = {
      ...wirePg,
      ssl: { mode: "require" },
      sshTunnel: { enabled: true },
    } as unknown as SecretFieldRecord;
    assert.deepEqual(secretFieldValues(withSecretFieldValues(holder, every)), every);
  });

  it("finds each secret path a record carries as a key, whatever its value", () => {
    assert.deepEqual(
      secretPathsIn({
        password: 1,
        connectionString: "",
        host: "h",
        ssl: { mode: "require", clientKey: "" },
        sshTunnel: "on",
      }),
      ["password", "connectionString", "ssl.clientKey"],
    );
    assert.deepEqual(secretPathsIn({ sshTunnel: ["password"], ssl: null }), []);
  });

  it("calls an object that is not null and not an array a plain object", () => {
    assert.equal(isPlainObject({}), true);
    for (const value of [null, [], "x", 7, undefined]) assert.equal(isPlainObject(value), false, String(value));
  });
});
