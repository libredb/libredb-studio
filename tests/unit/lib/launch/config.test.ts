import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  LAUNCH_SECRET_MIN_LENGTH,
  type ReadyLaunchConfig,
  readLaunchConfig,
  resetLaunchConfigWarning,
} from "@/lib/launch/config";
import { DEV_FALLBACK_SECRET } from "@/lib/config/auth-env";
import { logger } from "@/lib/logger";

// NEXT_PUBLIC_AUTH_PROVIDER is cleared with the three, so every case starts in local sign-in unless it sets oidc.
const VARS = [
  "LAUNCH_TOKEN_SECRET",
  "LAUNCH_TOKEN_AUDIENCE",
  "LAUNCH_TOKEN_ISSUER",
  "NEXT_PUBLIC_AUTH_PROVIDER",
] as const;
const saved: Record<string, string | undefined> = {};

// Built rather than written out, so no literal here reads as a credential to a secret scanner.
const SECRET = "s".repeat(LAUNCH_SECRET_MIN_LENGTH);
const SESSION_KEY_PROBLEM =
  "LAUNCH_TOKEN_SECRET must differ from the key that signs sessions (JWT_SECRET): launch sign-in is unavailable until it does.";

beforeEach(() => {
  for (const name of VARS) saved[name] = process.env[name];
  for (const name of VARS) delete process.env[name];
  resetLaunchConfigWarning();
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function configure(secret: string, audience = "studio-1", issuer = "platform") {
  process.env.LAUNCH_TOKEN_SECRET = secret;
  process.env.LAUNCH_TOKEN_AUDIENCE = audience;
  process.env.LAUNCH_TOKEN_ISSUER = issuer;
}

describe("readLaunchConfig", () => {
  test("is off while LAUNCH_TOKEN_SECRET is unset or empty, whatever the other two say", () => {
    expect(readLaunchConfig()).toEqual({ state: "off" });
    configure("");
    expect(readLaunchConfig()).toEqual({ state: "off" });
  });

  test("is ready with the secret's UTF-8 bytes and the trimmed audience and issuer", () => {
    configure(SECRET, " studio-1 ", " platform ");
    // Typed as the ready state, so this test stops compiling if that state gains or loses a field.
    const ready: ReadyLaunchConfig = {
      state: "ready",
      secret: new TextEncoder().encode(SECRET),
      audience: "studio-1",
      issuer: "platform",
    };
    expect(readLaunchConfig()).toEqual(ready);
  });

  test("uses the secret exactly as set: surrounding whitespace is part of the key, not trimmed away", () => {
    configure(` ${SECRET} `);
    const config = readLaunchConfig();
    expect(config.state).toBe("ready");
    expect(config.state === "ready" && new TextDecoder().decode(config.secret)).toBe(` ${SECRET} `);
  });

  test("a secret one character short of the minimum is misconfigured, not off", () => {
    configure("s".repeat(LAUNCH_SECRET_MIN_LENGTH - 1));
    expect(readLaunchConfig()).toEqual({
      state: "misconfigured",
      problem: "LAUNCH_TOKEN_SECRET must be at least 32 characters: launch sign-in is unavailable until it is fixed.",
    });
  });

  test("a set secret makes LAUNCH_TOKEN_AUDIENCE required, and blank counts as missing", () => {
    configure(SECRET, "   ");
    expect(readLaunchConfig()).toEqual({
      state: "misconfigured",
      problem:
        "LAUNCH_TOKEN_AUDIENCE must be set when LAUNCH_TOKEN_SECRET is set: launch sign-in is unavailable until it is.",
    });
    delete process.env.LAUNCH_TOKEN_AUDIENCE;
    expect(readLaunchConfig().state).toBe("misconfigured");
  });

  test("a set secret makes LAUNCH_TOKEN_ISSUER required", () => {
    configure(SECRET, "studio-1", "");
    expect(readLaunchConfig()).toEqual({
      state: "misconfigured",
      problem:
        "LAUNCH_TOKEN_ISSUER must be set when LAUNCH_TOKEN_SECRET is set: launch sign-in is unavailable until it is.",
    });
    delete process.env.LAUNCH_TOKEN_ISSUER;
    expect(readLaunchConfig().state).toBe("misconfigured");
  });

  test("a secret equal to JWT_SECRET is misconfigured, so a launch token can never pass as a session", () => {
    const jwtSecret = process.env.JWT_SECRET;
    try {
      process.env.JWT_SECRET = SECRET;
      configure(SECRET);
      expect(readLaunchConfig()).toEqual({ state: "misconfigured", problem: SESSION_KEY_PROBLEM } as const);
    } finally {
      if (jwtSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = jwtSecret;
    }
  });

  test("a secret equal to the development fallback is misconfigured while JWT_SECRET is unset", () => {
    const jwtSecret = process.env.JWT_SECRET;
    try {
      delete process.env.JWT_SECRET;
      configure(DEV_FALLBACK_SECRET);
      expect(readLaunchConfig()).toEqual({ state: "misconfigured", problem: SESSION_KEY_PROBLEM } as const);
      configure(SECRET);
      expect(readLaunchConfig().state).toBe("ready");
    } finally {
      if (jwtSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = jwtSecret;
    }
  });

  test("is unavailable under NEXT_PUBLIC_AUTH_PROVIDER=oidc, whether or not the launch variables are set, and says so once", () => {
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
      const unavailable = {
        state: "misconfigured",
        problem: "Launch sign-in is not available when NEXT_PUBLIC_AUTH_PROVIDER=oidc.",
      } as const;
      expect(readLaunchConfig()).toEqual(unavailable);
      configure(SECRET);
      expect(readLaunchConfig()).toEqual(unavailable);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("logs each distinct problem once per process and never the secret itself", () => {
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      configure("short-value");
      readLaunchConfig();
      readLaunchConfig();
      configure(SECRET, "");
      readLaunchConfig();
      readLaunchConfig();
      expect(errorSpy).toHaveBeenCalledTimes(2);
      const messages = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(messages[0]).toContain("LAUNCH_TOKEN_SECRET must be at least 32 characters");
      expect(messages[1]).toContain("LAUNCH_TOKEN_AUDIENCE must be set");
      for (const message of messages) expect(message).not.toContain("short-value");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("a ready or off configuration logs nothing", () => {
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      readLaunchConfig();
      configure(SECRET);
      readLaunchConfig();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
