import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { FIRESTORE_TYPE } from "@/lib/db/providers/document/firestore/constants";
import {
  emulatorAddressOf,
  FIRESTORE_CREDENTIAL_RULES,
  FIRESTORE_CREDENTIAL_SENTENCES as S,
  parseEmulatorHost,
  resolveFirestoreAuth,
} from "@/lib/db/providers/document/firestore/credential-policy";
import { GOOGLE_CREDENTIAL_SENTENCES } from "@/lib/db/providers/document/firestore/google-credentials";
import { projectIdRefusal } from "@/lib/db/providers/document/firestore/names";
import { fakeSeams } from "../../../helpers/firestore-seams";

const TOKEN = "ya29.a0AfB_byC-test-token_value.123";
const userFile = JSON.stringify({
  type: "authorized_user",
  client_id: "cid.apps.googleusercontent.com",
  client_secret: "user-secret-value",
  refresh_token: "1//refresh-token-value",
  quota_project_id: "demo-quota-1",
});

function refusal(run: () => unknown): DatabaseConfigError {
  try {
    run();
  } catch (error) {
    if (error instanceof DatabaseConfigError) return error;
    throw error;
  }
  throw new Error("expected a DatabaseConfigError");
}

describe("firestore credential sentences", () => {
  test("read as the spec writes them", () => {
    expect(S.browserEmpty).toBe(
      "Paste a service-account key JSON, an authorized-user JSON or an access token: the server's own Google identity is used only for operator-seeded connections",
    );
    expect(S.seedWithoutOptIn).toBe(
      "Set FIRESTORE_SERVER_CREDENTIALS=true on the server to let this seeded connection use the server's own Google identity",
    );
    expect(S.emulatorCredential("127.0.0.1:8080")).toBe(
      "This server sends every Firestore connection to the emulator at 127.0.0.1:8080 (FIRESTORE_EMULATOR_HOST): clear the credential field, or ask the operator to unset the variable",
    );
    expect(S.emulatorHost).toBe(
      "FIRESTORE_EMULATOR_HOST must be host:port or [ipv6]:port with no scheme, such as 127.0.0.1:8080",
    );
  });

  test("the rules carry the provider and the project id rule", () => {
    expect(FIRESTORE_CREDENTIAL_RULES.provider).toBe(FIRESTORE_TYPE);
    expect(FIRESTORE_CREDENTIAL_RULES.quotaProjectRefusal).toBe(projectIdRefusal);
  });
});

describe("firestore parseEmulatorHost", () => {
  test("host:port and [ipv6]:port, trimmed and in URL form", () => {
    expect(parseEmulatorHost("127.0.0.1:8080")).toEqual({
      host: "127.0.0.1",
      port: 8080,
      origin: "http://127.0.0.1:8080",
      display: "127.0.0.1:8080",
    });
    expect(parseEmulatorHost(" Firestore:8080 ")).toEqual({
      host: "firestore",
      port: 8080,
      origin: "http://firestore:8080",
      display: "firestore:8080",
    });
    expect(parseEmulatorHost("[::1]:9000")).toEqual({
      host: "[::1]",
      port: 9000,
      origin: "http://[::1]:9000",
      display: "[::1]:9000",
    });
    expect(parseEmulatorHost("host.docker.internal:8080").display).toBe("host.docker.internal:8080");
  });

  test("every other shape is refused with the variable's own sentence", () => {
    const shapes = [
      "",
      "127.0.0.1",
      "http://127.0.0.1:8080",
      "::1:8080",
      "[::1]",
      "[zz]:8080",
      "127.0.0.1:0",
      "127.0.0.1:70000",
      "127.0.0.1:80a",
      "a/b:8080",
      "user@host:8080",
      "host:8080/path",
    ];
    for (const shape of shapes) {
      const error = refusal(() => parseEmulatorHost(shape));
      expect(error.message).toBe(S.emulatorHost);
      expect(error.provider).toBe(FIRESTORE_TYPE);
    }
  });
});

describe("firestore emulatorAddressOf", () => {
  test("unset or blank is no emulator", () => {
    expect(emulatorAddressOf({})).toBeNull();
    expect(emulatorAddressOf({ FIRESTORE_EMULATOR_HOST: undefined })).toBeNull();
    expect(emulatorAddressOf({ FIRESTORE_EMULATOR_HOST: "" })).toBeNull();
    expect(emulatorAddressOf({ FIRESTORE_EMULATOR_HOST: "   " })).toBeNull();
  });

  test("a set value is the address parseEmulatorHost reads, and only the emulator variable is read", () => {
    const seams = fakeSeams({ env: { FIRESTORE_EMULATOR_HOST: "[::1]:9000", FIRESTORE_SERVER_CREDENTIALS: "true" } });
    expect(emulatorAddressOf(seams.env)).toEqual(parseEmulatorHost("[::1]:9000"));
    expect(new Set(seams.envReads)).toEqual(new Set(["FIRESTORE_EMULATOR_HOST"]));
  });

  test("a value with a scheme is refused with the variable's sentence", () => {
    const error = refusal(() => emulatorAddressOf({ FIRESTORE_EMULATOR_HOST: "http://127.0.0.1:8080" }));
    expect(error.message).toBe(S.emulatorHost);
    expect(error.provider).toBe(FIRESTORE_TYPE);
  });
});

describe("firestore resolveFirestoreAuth with the emulator", () => {
  test("an empty field talks to the emulator and reads no other variable and no file", () => {
    const seams = fakeSeams({
      env: {
        FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
        FIRESTORE_SERVER_CREDENTIALS: "true",
        GOOGLE_APPLICATION_CREDENTIALS: "/srv/key.json",
      },
      files: { "/srv/key.json": userFile },
    });
    for (const managed of [true, false, undefined]) {
      expect(resolveFirestoreAuth({ password: "", managed }, seams)).toEqual({
        mode: "emulator",
        emulator: parseEmulatorHost("127.0.0.1:8080"),
      });
    }
    expect(new Set(seams.envReads)).toEqual(new Set(["FIRESTORE_EMULATOR_HOST"]));
    expect(seams.fileReads).toEqual([]);
  });

  test("a credential in the field is refused naming the variable and the address, and is never parsed", () => {
    for (const password of [TOKEN, userFile, "{not json at all"]) {
      const seams = fakeSeams({ env: { FIRESTORE_EMULATOR_HOST: "[::1]:9000" } });
      const error = refusal(() => resolveFirestoreAuth({ password, managed: true }, seams));
      expect(error.message).toBe(S.emulatorCredential("[::1]:9000"));
      expect(error.message).toContain("FIRESTORE_EMULATOR_HOST");
      expect(error.message).not.toContain("user-secret-value");
      expect(error.message).not.toContain(TOKEN);
      expect(new Set(seams.envReads)).toEqual(new Set(["FIRESTORE_EMULATOR_HOST"]));
    }
  });

  test("a malformed emulator variable is refused before anything else", () => {
    const seams = fakeSeams({ env: { FIRESTORE_EMULATOR_HOST: "http://127.0.0.1:8080" } });
    expect(refusal(() => resolveFirestoreAuth({ password: "" }, seams)).message).toBe(S.emulatorHost);
  });

  test("a blank emulator variable counts as unset", () => {
    const seams = fakeSeams({ env: { FIRESTORE_EMULATOR_HOST: "   " } });
    expect(resolveFirestoreAuth({ password: TOKEN }, seams)).toEqual({
      mode: "google",
      credentials: { type: "access_token", token: TOKEN },
    });
  });
});

describe("firestore resolveFirestoreAuth against Google", () => {
  test("a pasted credential is used, browser-sent or seeded, and the opt-in is not read", () => {
    for (const managed of [true, false, undefined]) {
      const seams = fakeSeams({ env: { FIRESTORE_SERVER_CREDENTIALS: "true" } });
      expect(resolveFirestoreAuth({ password: `  Bearer ${TOKEN}\n`, managed }, seams)).toEqual({
        mode: "google",
        credentials: { type: "access_token", token: TOKEN },
      });
      expect(seams.envReads).not.toContain("FIRESTORE_SERVER_CREDENTIALS");
    }
  });

  test("a pasted user JSON's quota project passes the project id rule or is refused", () => {
    const seams = fakeSeams();
    const auth = resolveFirestoreAuth({ password: userFile }, seams);
    expect(auth).toMatchObject({
      mode: "google",
      credentials: { type: "authorized_user", quotaProjectId: "demo-quota-1" },
    });
    const bad = userFile.replace("demo-quota-1", "Bad Quota");
    const error = refusal(() => resolveFirestoreAuth({ password: bad }, seams));
    expect(error.message).toBe(GOOGLE_CREDENTIAL_SENTENCES.quotaProject(projectIdRefusal("Bad Quota") ?? ""));
  });

  test("an empty field on a browser-sent connection is refused, whatever the opt-in says", () => {
    for (const managed of [false, undefined]) {
      for (const password of ["", "   ", undefined]) {
        const seams = fakeSeams({
          env: { FIRESTORE_SERVER_CREDENTIALS: "true" },
          files: { "/srv/key.json": userFile },
        });
        expect(refusal(() => resolveFirestoreAuth({ password, managed }, seams)).message).toBe(S.browserEmpty);
        expect(seams.fileReads).toEqual([]);
      }
    }
  });

  test("an empty field on a seeded connection without the exact opt-in is refused", () => {
    for (const value of [undefined, "", "1", "TRUE", "yes", " true"]) {
      const seams = fakeSeams({ env: value === undefined ? {} : { FIRESTORE_SERVER_CREDENTIALS: value } });
      expect(refusal(() => resolveFirestoreAuth({ password: "", managed: true }, seams)).message).toBe(
        S.seedWithoutOptIn,
      );
      expect(seams.fileReads).toEqual([]);
    }
  });

  test("an empty field on a seeded connection with the opt-in reads the server's identity in ADC order", () => {
    const named = fakeSeams({
      env: { FIRESTORE_SERVER_CREDENTIALS: "true", GOOGLE_APPLICATION_CREDENTIALS: "/srv/key.json" },
      files: { "/srv/key.json": userFile },
    });
    expect(resolveFirestoreAuth({ password: "", managed: true }, named)).toMatchObject({
      mode: "google",
      credentials: { type: "authorized_user", clientId: "cid.apps.googleusercontent.com" },
    });
    const workload = fakeSeams({ env: { FIRESTORE_SERVER_CREDENTIALS: "true" } });
    expect(resolveFirestoreAuth({ password: "", managed: true }, workload)).toEqual({
      mode: "google",
      credentials: { type: "metadata", host: "metadata.google.internal" },
    });
  });
});
