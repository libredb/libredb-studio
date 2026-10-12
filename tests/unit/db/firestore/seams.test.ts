import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { ENV } from "@/lib/db/providers/document/firestore/constants";
import { FIRESTORE_ENV_NAMES, readFirestoreEnv, resolveSeams } from "@/lib/db/providers/document/firestore/seams";
import { fakeSeams } from "../../../helpers/firestore-seams";

const LANE_OPTIONS = {
  origin: { scheme: "http", host: "127.0.0.1", port: 9 },
  tls: null,
  maxSockets: 1,
  headers: {},
} as const;

describe("firestore readFirestoreEnv", () => {
  test("names exactly the variables the provider reads", () => {
    expect(FIRESTORE_ENV_NAMES).toEqual([
      ENV.emulatorHost,
      ENV.serverCredentials,
      ENV.credentialsFile,
      ENV.metadataHost,
      "APPDATA",
      "HOME",
    ]);
  });

  test("keeps those variables and nothing else, frozen", () => {
    const env = readFirestoreEnv({
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      FIRESTORE_SERVER_CREDENTIALS: "true",
      GOOGLE_APPLICATION_CREDENTIALS: "/srv/key.json",
      GCE_METADATA_HOST: "meta.internal:8080",
      APPDATA: "C:\\Users\\ana\\AppData\\Roaming",
      HOME: "/home/ana",
      PATH: "/usr/bin",
      JWT_SECRET: "not-for-firestore",
    });
    expect(env).toEqual({
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      FIRESTORE_SERVER_CREDENTIALS: "true",
      GOOGLE_APPLICATION_CREDENTIALS: "/srv/key.json",
      GCE_METADATA_HOST: "meta.internal:8080",
      APPDATA: "C:\\Users\\ana\\AppData\\Roaming",
      HOME: "/home/ana",
    });
    expect(Object.isFrozen(env)).toBe(true);
  });

  test("leaves an unset variable out", () => {
    expect(readFirestoreEnv({ PATH: "/usr/bin" })).toEqual({});
  });
});

describe("firestore resolveSeams real defaults", () => {
  const seams = resolveSeams();

  test("is frozen, and its environment holds only the provider's variables", () => {
    expect(Object.isFrozen(seams)).toBe(true);
    expect(Object.isFrozen(seams.env)).toBe(true);
    for (const name of Object.keys(seams.env)) expect(FIRESTORE_ENV_NAMES).toContain(name);
  });

  test("clock, platform, home directory and file read are the runtime's", () => {
    const before = Date.now();
    const now = seams.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect(seams.platform).toBe(process.platform);
    expect(seams.homeDir()).toBe(homedir());
    expect(seams.readFile(import.meta.path)).toContain("firestore resolveSeams real defaults");
    expect(() => seams.readFile(`${import.meta.path}.missing`)).toThrow();
  });

  test("sleep resolves, and rejects with the signal's reason when aborted before or during the wait", async () => {
    await seams.sleep(0);
    await seams.sleep(0, new AbortController().signal);
    const reason = new Error("stop");
    await expect(seams.sleep(60_000, AbortSignal.abort(reason))).rejects.toBe(reason);
    const controller = new AbortController();
    const pending = seams.sleep(60_000, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  test("timeoutSignal hands back a live signal", () => {
    const signal = seams.timeoutSignal(60_000);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  test("createTransport builds a shared node transport without opening a socket", () => {
    const transport = seams.createTransport(LANE_OPTIONS, "emulator");
    expect(typeof transport.request).toBe("function");
    transport.close();
  });
});

describe("firestore resolveSeams overrides", () => {
  test("a partial record replaces only the members it names", () => {
    const fake = fakeSeams({
      env: { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
      now: 42,
      platform: "win32",
      home: "C:\\Users\\ana",
    });
    const seams = resolveSeams({
      createTransport: fake.createTransport,
      now: fake.now,
      env: fake.env,
      homeDir: fake.homeDir,
      platform: fake.platform,
      timeoutSignal: fake.timeoutSignal,
    });
    expect(seams.now()).toBe(42);
    expect(seams.env.FIRESTORE_EMULATOR_HOST).toBe("127.0.0.1:8080");
    expect(seams.platform).toBe("win32");
    expect(seams.homeDir()).toBe("C:\\Users\\ana");
    seams.timeoutSignal(5);
    expect(fake.deadlines.map((deadline) => deadline.ms)).toEqual([5]);
    seams.createTransport(LANE_OPTIONS, "api");
    expect(fake.lanes.map((lane) => lane.lane)).toEqual(["api"]);
    expect(seams.readFile(import.meta.path)).toContain("a partial record replaces only the members it names");
  });
});
