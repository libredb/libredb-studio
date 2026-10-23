import assert from "node:assert/strict";
import {
  ConnectionStore,
  type ConnectionsChange,
  connectionsSetting,
  SETTING_NOT_AN_ARRAY,
  SecretStoreError,
  SettingWriteError,
  secretStoreFailed,
  UnknownConnectionError,
} from "../../../src/host/connections/connection-store";
import type { ProfileEntry } from "../../../src/host/connections/profile";
import { FakeSetting } from "../../fakes/connections-setting";
import { MONGO, PG, SRV } from "../../fakes/profiles";
import { MemorySecretStorage, type Op } from "../../fakes/secret-storage";
import {
  ConfigurationTarget,
  changeConfiguration,
  configurationUpdates,
  fakeExtensionContext,
  settings,
  workspace,
} from "../../fakes/vscode";
import { TEST_PASSWORD } from "../../fakes/credentials";

/** A second stand-in password, built at run time as TEST_PASSWORD is. */
const RETYPED_PASSWORD = ["n3w", "2"].join("-");

const NEW: ProfileEntry = { ...PG, id: "9zq0k1m2n3p4", name: "new" };
/** The SecretStorage keys of the two profiles' passwords, built from parts as the stand-in values are. */
const PG_PASSWORD_KEY = ["connection", PG.id, "password"].join("/");
const NEW_PASSWORD_KEY = ["connection", NEW.id, "password"].join("/");
const VSCODE_REFUSAL =
  "Unable to write into user settings. Please open the user settings to correct errors/warnings in it and try again.";

/** A store over [PG, MONGO] (or the raw value given), PG's password stored, with every event and warning recorded. */
function setup(value: unknown = [PG, MONGO]) {
  const ops: Op[] = [];
  const setting = new FakeSetting(value, ops);
  const secrets = new MemorySecretStorage(ops);
  secrets.values.set(PG_PASSWORD_KEY, TEST_PASSWORD);
  const warnings: string[] = [];
  const store = new ConnectionStore({ setting, secrets, log: { warn: (message: string) => warnings.push(message) } });
  const events: ConnectionsChange[] = [];
  store.onDidChange((change) => events.push(change));
  return { store, setting, secrets, ops, warnings, events };
}

/** The error a call rejected with; fails when it resolved. */
async function rejection(call: Promise<unknown>): Promise<unknown> {
  return await call.then(
    (value) => assert.fail(`expected a rejection, got ${JSON.stringify(value)}`),
    (error: unknown) => error,
  );
}

const changed = (id: string): ConnectionsChange => ({ added: [], removed: [], changed: [id] });

describe("ConnectionStore", () => {
  describe("load", () => {
    it("lists the setting's entries in order, needs nothing else, and fires and logs nothing", () => {
      const { store, events, warnings } = setup();
      assert.deepEqual(store.list(), [
        { kind: "valid", entry: PG },
        { kind: "valid", entry: MONGO },
      ]);
      assert.deepEqual(store.get(PG.id), PG);
      assert.equal(store.revision(PG.id), 0);
      assert.equal(store.revision(MONGO.id), 0);
      assert.deepEqual(events, []);
      assert.deepEqual(warnings, []);
    });

    it("lists an invalid entry and logs its reason at warn once per load", () => {
      const { store, warnings } = setup([PG, { ...PG }]);
      const reason = "Entry 2 of libredb.connections repeats the id 1kq2v7x93j0ab of an earlier entry.";
      assert.deepEqual(store.list()[1], { kind: "invalid", reason });
      assert.deepEqual(warnings, [`Ignoring a libredb.connections entry: ${reason}`]);
      store.reload();
      assert.deepEqual(warnings, [
        `Ignoring a libredb.connections entry: ${reason}`,
        `Ignoring a libredb.connections entry: ${reason}`,
      ]);
    });

    it("lists one invalid item for a setting that is not an array", () => {
      const { store, warnings } = setup({ broken: true });
      const reason =
        "libredb.connections in your user settings is not an array, so LibreDB lists no connection from it.";
      assert.deepEqual(store.list(), [{ kind: "invalid", reason }]);
      assert.deepEqual(warnings, [`Ignoring a libredb.connections entry: ${reason}`]);
    });
  });

  describe("add", () => {
    it("stores the secrets, then writes the setting, then fires one added event (criterion 13)", async () => {
      const { store, setting, secrets, ops, events } = setup();
      await store.add(NEW, { password: TEST_PASSWORD });
      assert.deepEqual(ops, [["store", NEW_PASSWORD_KEY], ["write"]]);
      assert.deepEqual(setting.writes, [[PG, MONGO, NEW]]);
      assert.deepEqual(events, [{ added: [NEW.id], removed: [], changed: [] }]);
      assert.deepEqual(store.get(NEW.id), NEW);
      assert.equal(store.revision(NEW.id), 0);
      assert.equal(secrets.values.get(NEW_PASSWORD_KEY), TEST_PASSWORD);
    });

    it("fires one added event when VS Code reports its own write before the write settles", async () => {
      const { store, setting, events } = setup();
      setting.events = "before-settle";
      await store.add(NEW, { password: TEST_PASSWORD });
      assert.deepEqual(events, [{ added: [NEW.id], removed: [], changed: [] }]);
    });

    it("writes an entry with no secret and stores nothing", async () => {
      const { store, setting, ops } = setup();
      const plain: ProfileEntry = { ...NEW };
      delete plain.secretFields;
      await store.add(plain, {});
      assert.deepEqual(ops, [["write"]]);
      assert.deepEqual(setting.writes, [[PG, MONGO, plain]]);
    });

    it("deletes the secrets it stored and writes nothing when a store fails (criterion 13)", async () => {
      const { store, setting, secrets, ops, events } = setup();
      secrets.failStore("connection/9zq0k1m2n3p4/connectionString", "keyring locked");
      const error = await rejection(
        store.add({ ...NEW, secretFields: ["password", "connectionString"] }, { password: "a", connectionString: "b" }),
      );
      assert.ok(error instanceof SecretStoreError);
      assert.equal(error.name, "SecretStoreError");
      assert.equal(error.message, secretStoreFailed("keyring locked"));
      assert.deepEqual(ops, [
        ["store", NEW_PASSWORD_KEY],
        ["store", "connection/9zq0k1m2n3p4/connectionString"],
        ["delete", NEW_PASSWORD_KEY],
      ]);
      assert.deepEqual(setting.writes, []);
      assert.deepEqual(await secrets.keys(), [PG_PASSWORD_KEY]);
      assert.deepEqual(events, []);
    });

    it("says how a secret store failed, and where VS Code documents the keyring", () => {
      assert.equal(
        secretStoreFailed("keyring locked"),
        `LibreDB could not store a secret in VS Code's secret storage, so it saved nothing: keyring locked. On Linux, VS Code's secret storage needs a keyring; see "Configure a keyring backend" in VS Code's Settings Sync documentation.`,
      );
    });

    it("logs a stored secret it could not delete after a failed store", async () => {
      const { store, secrets, warnings } = setup();
      secrets.failStore("connection/9zq0k1m2n3p4/connectionString", "keyring locked");
      secrets.failDelete(NEW_PASSWORD_KEY, "denied");
      const error = await rejection(
        store.add({ ...NEW, secretFields: ["password", "connectionString"] }, { password: "a", connectionString: "b" }),
      );
      assert.ok(error instanceof SecretStoreError);
      assert.deepEqual(warnings, [
        `Could not delete ${NEW_PASSWORD_KEY} from VS Code's secret storage: it stays on this machine.`,
      ]);
    });

    it("deletes every key of the new id when the setting write fails (criterion 13)", async () => {
      const { store, setting, secrets, events } = setup();
      setting.failNextWrite(VSCODE_REFUSAL);
      const error = await rejection(store.add(NEW, { password: TEST_PASSWORD }));
      assert.ok(error instanceof SettingWriteError);
      assert.equal(error.name, "SettingWriteError");
      assert.equal(
        error.message,
        `LibreDB could not write libredb.connections in your user settings: ${VSCODE_REFUSAL}`,
      );
      assert.deepEqual(
        (await secrets.keys()).filter((key) => key.startsWith("connection/9zq0k1m2n3p4/")),
        [],
      );
      assert.equal(store.get(NEW.id), undefined);
      assert.deepEqual(events, []);
    });

    it("reads the setting again just before it writes, keeping elements it cannot read", async () => {
      const { store, setting } = setup();
      const OTHER = { ...MONGO, id: "other1", name: "other" };
      setting.value = [PG, 7, MONGO, OTHER];
      await store.add(NEW, { password: TEST_PASSWORD });
      assert.deepEqual(setting.writes, [[PG, 7, MONGO, OTHER, NEW]]);
    });

    it("refuses a setting that is not an array and stores nothing", async () => {
      const { store, setting, ops } = setup();
      setting.value = { broken: true };
      const error = await rejection(store.add(NEW, { password: TEST_PASSWORD }));
      assert.ok(error instanceof SettingWriteError);
      assert.equal(error.message, SETTING_NOT_AN_ARRAY);
      assert.deepEqual(ops, []);
    });

    it("deletes the new id's keys when the setting stops being an array while it stores them", async () => {
      const { store, setting, secrets, ops } = setup();
      secrets.onDidChange(() => {
        setting.value = { broken: true };
      });
      const error = await rejection(store.add(NEW, { password: TEST_PASSWORD }));
      assert.ok(error instanceof SettingWriteError);
      assert.equal(error.message, SETTING_NOT_AN_ARRAY);
      assert.deepEqual(ops, [
        ["store", NEW_PASSWORD_KEY],
        ["delete", NEW_PASSWORD_KEY],
      ]);
      assert.deepEqual(setting.writes, []);
    });

    it("refuses an id the setting already lists", async () => {
      const { store, ops } = setup();
      const error = await rejection(store.add({ ...PG, name: "again" }, { password: TEST_PASSWORD }));
      assert.ok(error instanceof Error);
      assert.equal(error.message, "A connection with id 1kq2v7x93j0ab is already saved.");
      assert.deepEqual(ops, []);
    });

    it("refuses an entry the load would call invalid, with its reason", async () => {
      const { store, ops } = setup();
      const error = await rejection(store.add({ ...NEW, port: 0 }, { password: TEST_PASSWORD }));
      assert.ok(error instanceof Error);
      assert.equal(error.message, "The connection new has a port that is not a whole number from 1 to 65535.");
      assert.deepEqual(ops, []);
    });

    it("refuses secrets that are not the ones the entry's secretFields lists", async () => {
      const { store, ops } = setup();
      const given: Record<string, string>[] = [{}, { password: "" }, { password: "a", connectionString: "b" }];
      const errors = await Promise.all(given.map((secrets) => rejection(store.add(NEW, secrets))));
      for (const error of errors) {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "The secrets given for 9zq0k1m2n3p4 are not the ones its secretFields lists.");
      }
      assert.deepEqual(ops, []);
    });
  });

  describe("reconciliation (criteria 18 and 19)", () => {
    it("reports each kind of edit once, nested values included, and keeps a removed id's secrets", async () => {
      const { store, setting, secrets, events } = setup();
      const moved = { ...PG, host: "db2.internal" };
      setting.edit([moved, MONGO]);
      assert.deepEqual(events, [changed(PG.id)]);
      assert.equal(store.revision(PG.id), 1);
      setting.edit([{ ...moved, ssl: { mode: "require" } }, MONGO]);
      setting.edit([{ ...moved, ssl: { mode: "verify-system" } }, MONGO]);
      assert.deepEqual(events.length, 3);
      assert.equal(store.revision(PG.id), 3);
      const both = { ...moved, ssl: { mode: "verify-system" }, secretFields: ["password", "connectionString"] };
      setting.edit([both, MONGO]);
      assert.deepEqual(events.length, 4);
      setting.edit([{ ...both, secretFields: ["connectionString", "password"] }, MONGO]);
      setting.edit([{ ...both, secretFields: ["connectionString", "password"] }, MONGO]);
      assert.deepEqual(events.length, 4);
      setting.edit([MONGO]);
      assert.deepEqual(events.at(-1), { added: [], removed: [PG.id], changed: [] });
      assert.ok((await secrets.keys()).includes(PG_PASSWORD_KEY));
      assert.equal(store.get(PG.id), undefined);
      setting.edit([PG, MONGO]);
      assert.deepEqual(events.at(-1), { added: [PG.id], removed: [], changed: [] });
      assert.deepEqual(await store.readSecrets(PG.id), { values: { password: TEST_PASSWORD }, missing: [] });
      // The counter never resets within an activation, so an id that comes back is a change.
      assert.equal(store.revision(PG.id), 5);
      setting.edit({ broken: true });
      assert.deepEqual(events.at(-1), { added: [], removed: [PG.id, MONGO.id], changed: [] });
      assert.equal(events.length, 7);
    });

    it("reconciles on reload as on a change event", () => {
      const { store, setting, events } = setup();
      setting.value = [{ ...PG, name: "renamed" }, MONGO, NEW];
      store.reload();
      assert.deepEqual(events, [{ added: [NEW.id], removed: [], changed: [PG.id] }]);
    });

    it("counts a change to an entry the load calls invalid, which then has no revision", () => {
      const { store, setting, events } = setup();
      setting.edit([{ ...PG, password: "x" }, MONGO]);
      assert.deepEqual(events, [changed(PG.id)]);
      assert.equal(store.get(PG.id), undefined);
      assert.throws(() => store.revision(PG.id), UnknownConnectionError);
    });
  });

  describe("secret events", () => {
    it("reports an outside store or delete of a listed connection's secret as a change", () => {
      const { store, secrets, events } = setup();
      secrets.external.store(PG_PASSWORD_KEY, RETYPED_PASSWORD);
      assert.deepEqual(events, [changed(PG.id)]);
      assert.equal(store.revision(PG.id), 1);
      secrets.external.delete(PG_PASSWORD_KEY);
      assert.deepEqual(events, [changed(PG.id), changed(PG.id)]);
      assert.equal(store.revision(PG.id), 2);
    });

    it("ignores a key of an unlisted id and a key that is not a connection's", () => {
      const { secrets, events } = setup();
      secrets.external.store("connection/zz/password", "x");
      secrets.external.store("other", "x");
      assert.deepEqual(events, []);
    });

    it("ignores its own writes when their event comes before they settle (the controller's ruling)", async () => {
      const { store, secrets, events } = setup();
      await store.storeSecrets(PG.id, { password: RETYPED_PASSWORD });
      await store.add(NEW, { password: TEST_PASSWORD });
      assert.deepEqual(events, [{ added: [NEW.id], removed: [], changed: [] }]);
      assert.equal(store.revision(PG.id), 0);
      secrets.external.store(NEW_PASSWORD_KEY, "other");
      assert.deepEqual(events.at(-1), changed(NEW.id));
    });

    it("drops its record when a write settles with no event, so a later outside change counts", async () => {
      const { store, secrets, events } = setup();
      secrets.events = "none";
      await store.storeSecrets(PG.id, { password: RETYPED_PASSWORD });
      assert.deepEqual(events, []);
      secrets.external.store(PG_PASSWORD_KEY, "outside");
      assert.deepEqual(events, [changed(PG.id)]);
    });
  });

  describe("storeSecrets", () => {
    it("stores each non-empty value under its key", async () => {
      const { store, secrets, ops } = setup();
      await store.storeSecrets(PG.id, { password: RETYPED_PASSWORD, connectionString: "" });
      assert.deepEqual(ops, [["store", PG_PASSWORD_KEY]]);
      assert.equal(secrets.values.get(PG_PASSWORD_KEY), RETYPED_PASSWORD);
    });

    it("deletes what it stored and rejects SecretStoreError when a store fails", async () => {
      const { store, secrets, ops } = setup();
      secrets.failStore("connection/1kq2v7x93j0ab/connectionString", "denied");
      const error = await rejection(store.storeSecrets(PG.id, { password: RETYPED_PASSWORD, connectionString: SRV }));
      assert.ok(error instanceof SecretStoreError);
      assert.equal(error.message, secretStoreFailed("denied"));
      assert.deepEqual(ops.at(-1), ["delete", PG_PASSWORD_KEY]);
      assert.equal(secrets.values.has(PG_PASSWORD_KEY), false);
    });

    it("refuses an id the setting no longer lists and stores nothing, so Remove leaves no key behind", async () => {
      const { store, secrets } = setup();
      await store.remove(PG.id);
      const error = await rejection(store.storeSecrets(PG.id, { password: RETYPED_PASSWORD }));
      assert.ok(error instanceof UnknownConnectionError);
      assert.deepEqual(await secrets.keys(), []);
    });

    it("deletes what it stored and rejects UnknownConnectionError when Remove ran while it stored", async () => {
      const { store, secrets } = setup();
      const held = Promise.withResolvers<void>();
      const write = secrets.store.bind(secrets);
      secrets.store = async (key: string, value: string) => {
        await held.promise;
        await write(key, value);
      };
      const storing = rejection(store.storeSecrets(PG.id, { password: RETYPED_PASSWORD }));
      assert.deepEqual(await store.remove(PG.id), { removed: true, undeletedKeys: [] });
      held.resolve();
      assert.ok((await storing) instanceof UnknownConnectionError);
      assert.deepEqual(await secrets.keys(), []);
    });
  });

  describe("readSecrets", () => {
    it("answers the stored values of the entry's secretFields, and each one missing", async () => {
      const { store, secrets } = setup();
      assert.deepEqual(await store.readSecrets(PG.id), { values: { password: TEST_PASSWORD }, missing: [] });
      secrets.values.set(PG_PASSWORD_KEY, "");
      assert.deepEqual(await store.readSecrets(PG.id), { values: {}, missing: ["password"] });
      secrets.values.delete(PG_PASSWORD_KEY);
      assert.deepEqual(await store.readSecrets(PG.id), { values: {}, missing: ["password"] });
      assert.deepEqual(await store.readSecrets(MONGO.id), { values: {}, missing: ["connectionString"] });
      secrets.values.set("connection/3f9wz0c1m2rt/connectionString", SRV);
      assert.deepEqual(await store.readSecrets(MONGO.id), { values: { connectionString: SRV }, missing: [] });
    });

    it("answers nothing missing for an entry with no secretFields, and rejects an unknown id", async () => {
      const plain: ProfileEntry = { ...NEW };
      delete plain.secretFields;
      const { store } = setup([PG, plain]);
      assert.deepEqual(await store.readSecrets(NEW.id), { values: {}, missing: [] });
      const error = await rejection(store.readSecrets("missing"));
      assert.ok(error instanceof UnknownConnectionError);
    });
  });

  describe("remove (criterion 17's store steps)", () => {
    it("writes the setting without the id, then deletes every key of the id", async () => {
      const { store, setting, secrets, ops, events } = setup();
      secrets.values.set("connection/1kq2v7x93j0ab/ssl.clientKey", "stray");
      secrets.values.set("connection/3f9wz0c1m2rt/connectionString", SRV);
      assert.deepEqual(await store.remove(PG.id), { removed: true, undeletedKeys: [] });
      assert.deepEqual(setting.writes, [[MONGO]]);
      assert.deepEqual(ops, [
        ["write"],
        ["delete", PG_PASSWORD_KEY],
        ["delete", "connection/1kq2v7x93j0ab/ssl.clientKey"],
      ]);
      assert.deepEqual(await secrets.keys(), ["connection/3f9wz0c1m2rt/connectionString"]);
      assert.deepEqual(events, [{ added: [], removed: [PG.id], changed: [] }]);
    });

    it("removes every element with the id, a repeat included", async () => {
      const { store, setting } = setup([PG, MONGO, { ...PG, name: "copy" }]);
      await store.remove(PG.id);
      assert.deepEqual(setting.writes, [[MONGO]]);
    });

    it("answers the keys it could not delete", async () => {
      const { store, secrets } = setup();
      secrets.failDelete(PG_PASSWORD_KEY, "denied");
      assert.deepEqual(await store.remove(PG.id), { removed: true, undeletedKeys: [PG_PASSWORD_KEY] });
    });

    it("deletes nothing when the setting write fails", async () => {
      const { store, setting, ops } = setup();
      setting.failNextWrite("x");
      const error = await rejection(store.remove(PG.id));
      assert.ok(error instanceof SettingWriteError);
      assert.equal(error.message, "LibreDB could not write libredb.connections in your user settings: x");
      assert.deepEqual(ops, [["write"]]);
    });

    it("does nothing for an id the setting does not list", async () => {
      const { store, ops, events } = setup();
      assert.deepEqual(await store.remove("missing"), { removed: false, undeletedKeys: [] });
      assert.deepEqual(ops, []);
      assert.deepEqual(events, []);
    });

    it("refuses a setting that is not an array", async () => {
      const { store, setting, ops } = setup();
      setting.value = "x";
      const error = await rejection(store.remove(PG.id));
      assert.ok(error instanceof SettingWriteError);
      assert.equal(error.message, SETTING_NOT_AN_ARRAY);
      assert.deepEqual(ops, []);
    });
  });

  describe("unknown ids", () => {
    it("has no revision for an id it does not list", () => {
      const { store } = setup();
      assert.throws(() => store.revision("missing"), {
        name: "UnknownConnectionError",
        message: "The connection missing is no longer in libredb.connections.",
      });
      const error = new UnknownConnectionError("c1");
      assert.equal(error.connectionId, "c1");
    });

    it("has no entry and no revision for an invalid entry", () => {
      const { store } = setup([{ ...PG, password: "x" }]);
      assert.equal(store.get(PG.id), undefined);
      assert.throws(() => store.revision(PG.id), UnknownConnectionError);
    });
  });

  it("stops listening once disposed", () => {
    const { store, setting, secrets, events } = setup();
    store.dispose();
    setting.edit([MONGO]);
    secrets.external.store(PG_PASSWORD_KEY, RETYPED_PASSWORD);
    assert.deepEqual(events, []);
  });
});

describe("connectionsSetting", () => {
  it("reads, writes and watches libredb.connections in user settings", async () => {
    settings.set("libredb.connections", [PG]);
    const setting = connectionsSetting(workspace);
    let fired = 0;
    setting.onDidChange(() => {
      fired += 1;
    });
    assert.deepEqual(setting.read(), [PG]);
    await setting.write([MONGO]);
    assert.deepEqual(configurationUpdates, [
      { section: "libredb", key: "connections", value: [MONGO], target: ConfigurationTarget.Global },
    ]);
    assert.equal(fired, 1);
    changeConfiguration("libredb.connections");
    assert.equal(fired, 2);
    changeConfiguration("libredb.query.rowLimit");
    assert.equal(fired, 2);
    setting.dispose();
    changeConfiguration("libredb.connections");
    assert.equal(fired, 2);
  });

  it("gives the extension context its own empty secret storage", async () => {
    assert.deepEqual(await fakeExtensionContext().secrets.keys(), []);
  });
});
