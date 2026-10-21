import assert from "node:assert/strict";
import { BackendError } from "../../../src/host/backend-client";
import {
  CredentialsNotGivenError,
  ENTER_CREDENTIALS,
  MISSING_SECRET_PROMPT,
  ProfileConnectionSource,
  REASK_PROMPT,
} from "../../../src/host/connections/connection-source";
import { UnknownConnectionError } from "../../../src/host/connections/connection-store";
import type { ProfileEntry } from "../../../src/host/connections/profile";
import { PG, wirePg } from "../../fakes/profiles";
import { answerInputBoxes, answerMessages, shownInputBoxes, shownMessages, window } from "../../fakes/vscode";
import { TEST_PASSWORD } from "../../fakes/credentials";

/** A second stand-in password, built at run time as TEST_PASSWORD is. */
const RETYPED_PASSWORD = ["n3w", "2"].join("-");

const NO_SECRETS: ProfileEntry = { ...PG, id: "nosecret1", name: "open" };
delete NO_SECRETS.secretFields;
const AUTH = 'password authentication failed for user "app"';
const DECLINED = "No credentials were given for shop, so it stays not connected.";

/** The store's four calls the source makes, over PG and an entry with no secret, with each store recorded. */
class FakeStore {
  readonly entries = new Map<string, ProfileEntry>([
    [PG.id, PG],
    [NO_SECRETS.id, NO_SECRETS],
  ]);
  /** What revision() answers, for any id. */
  current = 0;
  /** What readSecrets() answers. */
  secrets: { values: Record<string, string>; missing: string[] } = { values: { password: TEST_PASSWORD }, missing: [] };
  readonly stored: [string, Readonly<Record<string, string>>][] = [];

  get(id: string): ProfileEntry | undefined {
    return this.entries.get(id);
  }

  revision(): number {
    return this.current;
  }

  async readSecrets(): Promise<{ values: Record<string, string>; missing: string[] }> {
    return this.secrets;
  }

  async storeSecrets(id: string, values: Readonly<Record<string, string>>): Promise<void> {
    this.stored.push([id, values]);
  }
}

function setup(isTrusted = true) {
  const store = new FakeStore();
  return { store, source: new ProfileConnectionSource({ store, window, workspace: { isTrusted } }) };
}

/** The error a call rejected with; fails when it resolved. */
async function rejection(call: Promise<unknown>): Promise<unknown> {
  return await call.then(
    (value) => assert.fail(`expected a rejection, got ${JSON.stringify(value)}`),
    (error: unknown) => error,
  );
}

describe("ProfileConnectionSource", () => {
  describe("read", () => {
    it("joins the stored secrets to the entry and asks nothing", async () => {
      const { store, source } = setup();
      const sourced = await source.read(PG.id);
      assert.deepEqual(sourced.params, { connection: wirePg, posture: { allowExternalFileAccess: true } });
      assert.equal(sourced.revision, 0);
      assert.deepEqual(shownInputBoxes, []);
      await sourced.opened();
      assert.deepEqual(store.stored, []);
    });

    it("asks for a secret not stored on this machine and stores it only once the open succeeded (criterion 16)", async () => {
      const { store, source } = setup();
      store.secrets = { values: {}, missing: ["password"] };
      answerInputBoxes(() => TEST_PASSWORD);
      const sourced = await source.read(PG.id);
      assert.deepEqual(shownInputBoxes, [
        { title: "shop: Password", prompt: MISSING_SECRET_PROMPT, password: true, ignoreFocusOut: true },
      ]);
      assert.deepEqual(sourced.params.connection, wirePg);
      assert.deepEqual(store.stored, []);
      await sourced.opened();
      assert.deepEqual(store.stored, [[PG.id, { password: TEST_PASSWORD }]]);
    });

    it("rejects CredentialsNotGivenError on Escape and stores nothing (criterion 16)", async () => {
      const { store, source } = setup();
      store.secrets = { values: {}, missing: ["password"] };
      const error = await rejection(source.read(PG.id));
      assert.ok(error instanceof CredentialsNotGivenError);
      assert.equal(error.name, "CredentialsNotGivenError");
      assert.equal(error.message, DECLINED);
      assert.equal(error.refusal, undefined);
      assert.deepEqual(store.stored, []);
    });

    it("stores nothing when every value typed is empty", async () => {
      const { store, source } = setup();
      store.secrets = { values: {}, missing: ["password"] };
      answerInputBoxes(() => "");
      await (await source.read(PG.id)).opened();
      assert.deepEqual(store.stored, []);
    });

    it("denies external file access in Restricted Mode", async () => {
      const { source } = setup(false);
      assert.deepEqual((await source.read(PG.id)).params.posture, { allowExternalFileAccess: false });
    });

    it("takes the revision before it asks, so an edit while the person types leaves the open stale", async () => {
      const { store, source } = setup();
      store.secrets = { values: {}, missing: ["password"] };
      answerInputBoxes(() => {
        store.current = 1;
        return TEST_PASSWORD;
      });
      assert.equal((await source.read(PG.id)).revision, 0);
      assert.equal(source.revision(PG.id), 1);
    });

    it("rejects UnknownConnectionError for an id the store no longer lists", async () => {
      const { source } = setup();
      const error = await rejection(source.read("gone"));
      assert.ok(error instanceof UnknownConnectionError);
      assert.equal(error.message, "The connection gone is no longer in libredb.connections.");
    });
  });

  describe("reask (Enter Credentials)", () => {
    it("offers Enter Credentials, asks every listed path again, and stores what was typed once the open succeeded", async () => {
      const { store, source } = setup();
      answerMessages(() => ENTER_CREDENTIALS);
      answerInputBoxes(() => RETYPED_PASSWORD);
      const sourced = await source.reask(PG.id, new BackendError(401, "AUTH_ERROR", AUTH));
      assert.deepEqual(shownMessages, [
        { level: "error", message: AUTH, options: { modal: true }, items: [ENTER_CREDENTIALS] },
      ]);
      assert.deepEqual(shownInputBoxes, [
        { title: "shop: Password", prompt: REASK_PROMPT, password: true, ignoreFocusOut: true },
      ]);
      assert.ok(sourced !== undefined);
      assert.deepEqual(sourced.params.connection, { ...wirePg, password: RETYPED_PASSWORD });
      assert.equal(sourced.revision, 0);
      assert.deepEqual(store.stored, []);
      await sourced.opened();
      assert.deepEqual(store.stored, [[PG.id, { password: RETYPED_PASSWORD }]]);
    });

    it("shows the fix statement as the dialog's detail", async () => {
      const { source } = setup();
      answerMessages(() => ENTER_CREDENTIALS);
      answerInputBoxes(() => RETYPED_PASSWORD);
      await source.reask(PG.id, new BackendError(401, "AUTH_ERROR", AUTH, { fixStatement: "ALTER ROLE app LOGIN;" }));
      assert.deepEqual(shownMessages[0].options, { modal: true, detail: "ALTER ROLE app LOGIN;" });
    });

    it("rejects CredentialsNotGivenError and stores nothing when the person declines the dialog", async () => {
      const { store, source } = setup();
      const refusal = new BackendError(401, "AUTH_ERROR", AUTH);
      const error = await rejection(source.reask(PG.id, refusal));
      assert.ok(error instanceof CredentialsNotGivenError);
      assert.equal(error.message, DECLINED);
      assert.equal(error.refusal, refusal);
      assert.deepEqual(shownInputBoxes, []);
      assert.deepEqual(store.stored, []);
    });

    it("rejects CredentialsNotGivenError and stores nothing when the person escapes the box", async () => {
      const { store, source } = setup();
      answerMessages(() => ENTER_CREDENTIALS);
      const refusal = new BackendError(401, "AUTH_ERROR", AUTH);
      const error = await rejection(source.reask(PG.id, refusal));
      assert.ok(error instanceof CredentialsNotGivenError);
      assert.equal(error.refusal, refusal);
      assert.deepEqual(store.stored, []);
    });

    it("offers Enter Credentials the same way for a CONNECTION_ERROR open (D387)", async () => {
      const { source } = setup();
      answerMessages(() => ENTER_CREDENTIALS);
      answerInputBoxes(() => RETYPED_PASSWORD);
      const sourced = await source.reask(PG.id, new BackendError(503, "CONNECTION_ERROR", AUTH));
      assert.deepEqual(shownMessages, [
        { level: "error", message: AUTH, options: { modal: true }, items: [ENTER_CREDENTIALS] },
      ]);
      assert.ok(sourced !== undefined);
      assert.deepEqual(sourced.params.connection, { ...wirePg, password: RETYPED_PASSWORD });
    });

    it("answers undefined and shows nothing for a CONNECTION_ERROR on an entry with no secretFields", async () => {
      const { source } = setup();
      assert.equal(await source.reask(NO_SECRETS.id, new BackendError(503, "CONNECTION_ERROR", AUTH)), undefined);
      assert.deepEqual(shownMessages, []);
    });

    it("answers undefined and shows nothing for an entry with no secretFields", async () => {
      const { source } = setup();
      assert.equal(await source.reask(NO_SECRETS.id, new BackendError(401, "AUTH_ERROR", AUTH)), undefined);
      assert.deepEqual(shownMessages, []);
    });

    it("rejects UnknownConnectionError for an id the store no longer lists", async () => {
      const { source } = setup();
      const error = await rejection(source.reask("gone", new BackendError(401, "AUTH_ERROR", AUTH)));
      assert.ok(error instanceof UnknownConnectionError);
    });
  });
});
