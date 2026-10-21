import assert from "node:assert/strict";
import {
  type ProfileEntry,
  readProfiles,
  SSL_MODES,
  toEntry,
  toWireConnection,
} from "../../../src/host/connections/profile";
import type { WireConnection } from "../../../src/protocol";
import { MONGO, PG, SRV, wireMongo, wirePg } from "../../fakes/profiles";
import { TEST_PASSWORD } from "../../fakes/credentials";

const invalid = (raw: unknown) => readProfiles([raw])[0];
const valid = (entry: unknown) => ({ kind: "valid", entry });
/** The item an element gets once its id and name are usable and a later rule refuses it. */
const refusedShop = (reason: string) => ({ kind: "invalid", reason, id: "1kq2v7x93j0ab", name: "shop" });

describe("readProfiles", () => {
  it("reads part 2's two entries as valid, and an empty setting as no item", () => {
    assert.deepEqual(readProfiles([PG, MONGO]), [valid(PG), valid(MONGO)]);
    assert.deepEqual(readProfiles([]), []);
  });

  it("stands one item for a setting that is not an array (rule 1)", () => {
    for (const raw of [{ a: 1 }, "x", null, undefined]) {
      assert.deepEqual(readProfiles(raw), [
        {
          kind: "invalid",
          reason: "libredb.connections in your user settings is not an array, so LibreDB lists no connection from it.",
        },
      ]);
    }
  });

  it("refuses an element that is not an object, an array included (rule 2)", () => {
    const reason = "Entry 2 of libredb.connections is not an object.";
    assert.deepEqual(readProfiles([PG, 7])[1], { kind: "invalid", reason });
    assert.deepEqual(readProfiles([PG, []])[1], { kind: "invalid", reason });
    assert.deepEqual(readProfiles([PG, null])[1], { kind: "invalid", reason });
  });

  it("refuses an id off the pattern, and a repeated id with no id of its own (rule 3)", () => {
    const reason = "Entry 1 of libredb.connections has no id of 1 to 64 letters, digits, _ or -.";
    for (const id of [undefined, "a/b", "x".repeat(65), "", 12345]) {
      assert.deepEqual(invalid({ ...PG, id }), { kind: "invalid", reason }, String(id));
    }
    assert.deepEqual(readProfiles([PG, { ...PG, name: "copy" }]), [
      valid(PG),
      {
        kind: "invalid",
        reason: "Entry 2 of libredb.connections repeats the id 1kq2v7x93j0ab of an earlier entry.",
      },
    ]);
  });

  it("counts the id of an earlier entry a later rule refused", () => {
    const [first, second] = readProfiles([{ ...PG, name: "" }, PG]);
    assert.deepEqual(first, { kind: "invalid", reason: "The connection 1kq2v7x93j0ab has no name.", id: PG.id });
    assert.deepEqual(second, {
      kind: "invalid",
      reason: "Entry 2 of libredb.connections repeats the id 1kq2v7x93j0ab of an earlier entry.",
    });
  });

  it("refuses a missing or blank name, keeping the id (rule 4)", () => {
    const item = { kind: "invalid", reason: "The connection 1kq2v7x93j0ab has no name.", id: "1kq2v7x93j0ab" };
    for (const name of ["  ", 3, undefined]) assert.deepEqual(invalid({ ...PG, name }), item, String(name));
  });

  it("refuses a type that is not an external database, and keeps one the channel does not enable (rule 5)", () => {
    assert.deepEqual(
      invalid({ ...PG, type: "postgresql" }),
      refusedShop("The connection shop has the type postgresql, which is not a database LibreDB Studio connects to."),
    );
    assert.deepEqual(
      invalid({ ...PG, type: "libredb" }),
      refusedShop("The connection shop has the type libredb, which is not a database LibreDB Studio connects to."),
    );
    assert.deepEqual(
      invalid({ ...PG, type: undefined }),
      refusedShop("The connection shop has the type undefined, which is not a database LibreDB Studio connects to."),
    );
    assert.deepEqual(invalid({ ...PG, type: "sqlite" }), valid({ ...PG, type: "sqlite" }));
  });

  it("refuses a createdAt that is not a date string (rule 6)", () => {
    const item = refusedShop("The connection shop has no createdAt date.");
    for (const createdAt of ["yesterday", undefined, 1760955243512]) {
      assert.deepEqual(invalid({ ...PG, createdAt }), item, String(createdAt));
    }
  });

  it("refuses a port that is not a whole number from 1 to 65535 (rule 7)", () => {
    const item = refusedShop("The connection shop has a port that is not a whole number from 1 to 65535.");
    for (const port of [0, 65536, 5432.5, "5432", null]) {
      assert.deepEqual(invalid({ ...PG, port }), item, String(port));
    }
    assert.equal(invalid({ ...PG, port: 1 }).kind, "valid");
    assert.equal(invalid({ ...PG, port: 65535 }).kind, "valid");
    assert.equal(invalid(MONGO).kind, "valid");
  });

  it("refuses an ssl setting without one of the five modes, and keeps each of them (rule 8)", () => {
    const item = refusedShop(
      "The connection shop has an ssl setting whose mode is not disable, require, verify-system, verify-ca or verify-full.",
    );
    for (const ssl of [{ mode: "prefer" }, "require", {}, ["require"]]) {
      assert.deepEqual(invalid({ ...PG, ssl }), item, JSON.stringify(ssl));
    }
    for (const mode of SSL_MODES) assert.equal(invalid({ ...PG, ssl: { mode } }).kind, "valid", mode);
  });

  it("refuses a secret field in the setting by its path, never by its value (rule 9)", () => {
    const sentence = (path: string) =>
      `Remove ${path} from this connection in your user settings: LibreDB keeps secrets in VS Code's secret storage and asks for them when it connects.`;
    const leaked = invalid({ ...PG, password: TEST_PASSWORD });
    assert.deepEqual(leaked, refusedShop(sentence("password")));
    assert.equal(JSON.stringify(leaked).includes(TEST_PASSWORD), false);
    assert.deepEqual(invalid({ ...PG, connectionString: "" }), refusedShop(sentence("connectionString")));
    assert.deepEqual(
      invalid({ ...PG, ssl: { mode: "require", clientKey: "k" } }),
      refusedShop(sentence("ssl.clientKey")),
    );
    assert.deepEqual(
      invalid({ ...PG, sshTunnel: { enabled: true, password: "p" } }),
      refusedShop(sentence("sshTunnel.password")),
    );
  });

  it("refuses a secretFields that is not a list of distinct secret paths the entry can hold (rule 10)", () => {
    const item = refusedShop(
      "The connection shop lists in secretFields a path that is not a distinct secret field it can hold.",
    );
    for (const secretFields of ["password", ["host"], ["password", "password"], [7], ["ssl.clientKey"]]) {
      assert.deepEqual(invalid({ ...PG, secretFields }), item, JSON.stringify(secretFields));
    }
    const keyed = { ...PG, ssl: { mode: "require" }, secretFields: ["ssl.clientKey"] };
    assert.deepEqual(invalid(keyed), valid(keyed));
    const tunnelled = { ...PG, sshTunnel: "on", secretFields: ["sshTunnel.password"] };
    assert.deepEqual(invalid(tunnelled), item);
  });

  it("passes every other key through to the entry unchanged", () => {
    const more = { ...PG, environment: "production", color: "#ff0000", queryTimeout: 5000, futureField: { a: [1] } };
    assert.deepEqual(readProfiles([more]), [valid(more)]);
  });

  it("names the five SSL modes", () => {
    assert.deepEqual(SSL_MODES, ["disable", "require", "verify-system", "verify-ca", "verify-full"]);
  });
});

describe("toWireConnection and toEntry", () => {
  it("writes the secrets at their paths and drops secretFields", () => {
    assert.deepEqual(toWireConnection(PG, { password: TEST_PASSWORD }), wirePg);
    assert.deepEqual(toWireConnection(MONGO, { connectionString: SRV }), wireMongo);
  });

  it("splits a connection into its entry and its secrets, the inverse", () => {
    assert.deepEqual(toEntry(wirePg), { entry: PG, secrets: { password: TEST_PASSWORD } });
    assert.deepEqual(toEntry(wireMongo), { entry: MONGO, secrets: { connectionString: SRV } });
  });

  it("lists no secretFields for a connection with no secret", () => {
    const open: WireConnection = { ...wirePg };
    delete open.password;
    const { entry, secrets } = toEntry(open);
    assert.equal(Object.hasOwn(entry, "secretFields"), false);
    assert.deepEqual(entry, open satisfies ProfileEntry);
    assert.deepEqual(secrets, {});
  });

  it("refuses to leave an empty secret in the entry, naming its path", () => {
    const empty: WireConnection = { ...wirePg, password: "" };
    assert.throws(() => toEntry(empty), { message: "password is a secret field and cannot be saved in the setting." });
  });
});
