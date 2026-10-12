/** The argument reading of tests/live/firestore-live-check.ts, the one part of a hand-run script a unit test can hold. */
import { describe, expect, test } from "bun:test";
import { liveTarget } from "../../../live/firestore-live-check";

describe("liveTarget", () => {
  test("exits 2 with a sentence when FIRESTORE_EMULATOR_HOST is unset or blank", () => {
    for (const env of [{}, { FIRESTORE_EMULATOR_HOST: "  " }]) {
      expect(liveTarget(env)).toEqual({
        exit: 2,
        message:
          "firestore-live-check: set FIRESTORE_EMULATOR_HOST (e.g. 127.0.0.1:8380 for the compose fixture) to a running emulator holding docker/firestore/seed.json",
      });
    }
  });

  test("reads the host and the seed's project, or FIRESTORE_LIVE_PROJECT when set", () => {
    expect(liveTarget({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:8380" })).toEqual({
      host: "127.0.0.1:8380",
      project: "demo-libredb",
    });
    expect(liveTarget({ FIRESTORE_EMULATOR_HOST: "firestore:8080", FIRESTORE_LIVE_PROJECT: "demo-other" })).toEqual({
      host: "firestore:8080",
      project: "demo-other",
    });
  });
});
