/**
 * The server-identity gate: the server's own identity only for a server-written connection (managed exactly true, and
 * not a seed-file row read in literal mode), and only when the provider's opt-in is exactly "true". Neutral rules: no
 * provider's gate is used here.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { admitServerIdentity, isServerWritten, type ServerIdentityGate } from "@/lib/db/auth/server-identity-gate";
import { LITERAL_SEED_FILE } from "@/lib/types";
import { fakeIo } from "../../../helpers/auth-fakes";

const GATE: ServerIdentityGate = Object.freeze({
  optIn: "SAMPLE_SERVER_CREDENTIALS",
  unmanaged: "Paste a credential: the server's own identity is for managed connections",
  withoutOptIn: "Set SAMPLE_SERVER_CREDENTIALS=true to let this connection use the server's own identity",
  literalSeedFile: "Paste a credential: the server's own identity is not used for a seed file read in literal mode",
});

const LITERAL = { [LITERAL_SEED_FILE]: true } as const;

describe("isServerWritten", () => {
  test("is true only for managed exactly true without the literal-mode marker", () => {
    expect(isServerWritten({ managed: true })).toBe(true);
    expect(isServerWritten({ managed: true, ...LITERAL })).toBe(false);
    for (const managed of [false, undefined]) {
      expect(isServerWritten({ managed })).toBe(false);
      expect(isServerWritten({ managed, ...LITERAL })).toBe(false);
    }
    expect(isServerWritten({})).toBe(false);
  });
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

describe("admitServerIdentity", () => {
  test("admits a managed connection whose opt-in is exactly true, reading only the opt-in", () => {
    const io = fakeIo({ env: { SAMPLE_SERVER_CREDENTIALS: "true", OTHER_SERVER_CREDENTIALS: "true" } });
    expect(() => admitServerIdentity(GATE, { managed: true }, io.env, "bigquery")).not.toThrow();
    expect(io.envReads).toEqual(["SAMPLE_SERVER_CREDENTIALS"]);
  });

  test("refuses a connection whose managed flag is not exactly true, before reading anything", () => {
    for (const managed of [false, undefined]) {
      const io = fakeIo({ env: { SAMPLE_SERVER_CREDENTIALS: "true" } });
      const error = refusal(() => admitServerIdentity(GATE, { managed }, io.env, "bigquery"));
      expect(error.message).toBe(GATE.unmanaged);
      expect(error.provider).toBe("bigquery");
      expect(io.envReads).toEqual([]);
    }
  });

  test("refuses a seed-file row read in literal mode with its own sentence, before reading anything", () => {
    const io = fakeIo({ env: { SAMPLE_SERVER_CREDENTIALS: "true" } });
    const error = refusal(() => admitServerIdentity(GATE, { managed: true, ...LITERAL }, io.env, "bigquery"));
    expect(error.message).toBe(GATE.literalSeedFile);
    expect(error.provider).toBe("bigquery");
    expect(io.envReads).toEqual([]);
  });

  test("refuses a connection that is not managed with the unmanaged sentence, marker or not", () => {
    for (const managed of [false, undefined]) {
      const error = refusal(() => admitServerIdentity(GATE, { managed, ...LITERAL }, {}, "bigquery"));
      expect(error.message).toBe(GATE.unmanaged);
    }
  });

  test("refuses a managed connection whose opt-in is unset or any spelling but exactly true", () => {
    for (const value of [undefined, "", "TRUE", "True", "1", " true", "true ", "yes", "false"]) {
      const io = fakeIo({ env: value === undefined ? {} : { SAMPLE_SERVER_CREDENTIALS: value } });
      const error = refusal(() => admitServerIdentity(GATE, { managed: true }, io.env, "firestore"));
      expect(error.message).toBe(GATE.withoutOptIn);
      expect(error.provider).toBe("firestore");
    }
  });

  test("labels a refusal with no provider when none is given", () => {
    expect(refusal(() => admitServerIdentity(GATE, { managed: false }, {}, undefined)).provider).toBeUndefined();
  });
});
