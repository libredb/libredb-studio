import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { verifyAuthEnvAtBoot } from "@/lib/config/auth-preflight";

/**
 * Issue #227: a set-but-too-short JWT_SECRET used to pass every startup path
 * untouched (zero-config bootstrap only fills a MISSING secret) and only
 * surfaced as a 503 when a user tried to log in, while GET /api/db/health kept
 * reporting "healthy". The preflight turns that into a boot-time hard exit.
 */
describe("config/auth-preflight verifyAuthEnvAtBoot", () => {
  const origSecret = process.env.JWT_SECRET;

  afterEach(() => {
    setSecret(origSecret);
  });

  function setSecret(value: string | undefined): void {
    if (value === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = value;
  }

  /** Stub process.exit so a fatal preflight cannot take the test runner down. */
  function stubProcessExit(): { exitCalls: Array<number | undefined>; restore: () => void } {
    const originalExit = process.exit;
    const exitCalls: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exitCalls.push(code);
    }) as unknown as typeof process.exit;
    return {
      exitCalls,
      restore: () => {
        process.exit = originalExit;
      },
    };
  }

  test("allows boot to continue when JWT_SECRET meets the 32-character minimum", () => {
    setSecret("a-valid-secret-that-is-32-chars!");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(true);
      expect(exitCalls).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      restore();
      errorSpy.mockRestore();
    }
  });

  test("allows boot to continue when JWT_SECRET is unset (zero-config bootstrap owns that case)", () => {
    setSecret(undefined);
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(true);
      expect(exitCalls).toEqual([]);
    } finally {
      restore();
    }
  });

  test("treats an empty JWT_SECRET as unset, not as too short", () => {
    setSecret("");
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(true);
      expect(exitCalls).toEqual([]);
    } finally {
      restore();
    }
  });

  test("exits 1 with an actionable banner when JWT_SECRET is shorter than 32 characters", () => {
    setSecret("x".repeat(24)); // Cosmos randomString(24), issue #227
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(false);
      expect(exitCalls).toEqual([1]);
      const banner = errorSpy.mock.calls.flat().join("\n");
      expect(banner).toContain("JWT_SECRET is too short");
      expect(banner).toContain("24 characters");
      expect(banner).toContain("32");
      expect(banner).toContain("openssl rand -base64 32");
      // The secret value itself must never reach the logs.
      expect(banner).not.toContain("x".repeat(24));
    } finally {
      restore();
      errorSpy.mockRestore();
    }
  });

  test("fails a one-character-under secret (boundary)", () => {
    setSecret("y".repeat(31));
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(false);
      expect(exitCalls).toEqual([1]);
      expect(errorSpy.mock.calls.flat().join("\n")).toContain("31 characters");
    } finally {
      restore();
      errorSpy.mockRestore();
    }
  });

  test("accepts an exactly-32-character secret (boundary)", () => {
    setSecret("z".repeat(32));
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(true);
      expect(exitCalls).toEqual([]);
    } finally {
      restore();
    }
  });

  describe("when nothing will produce a secret", () => {
    const origBootstrap = process.env.AUTH_BOOTSTRAP;
    const origNodeEnv = process.env.NODE_ENV;

    function setEnv(name: "AUTH_BOOTSTRAP" | "NODE_ENV", value: string | undefined): void {
      if (value === undefined) delete process.env[name];
      else Object.defineProperty(process.env, name, { value, configurable: true, writable: true, enumerable: true });
    }

    afterEach(() => {
      setEnv("AUTH_BOOTSTRAP", origBootstrap);
      setEnv("NODE_ENV", origNodeEnv);
    });

    test("refuses to boot in production with bootstrap off and no secret", () => {
      setSecret(undefined);
      setEnv("AUTH_BOOTSTRAP", "off");
      setEnv("NODE_ENV", "production");
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const { exitCalls, restore } = stubProcessExit();

      const result = verifyAuthEnvAtBoot();

      expect(result).toBe(false);
      expect(exitCalls).toEqual([1]);
      const banner = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(banner).toContain("JWT_SECRET is not set");
      expect(banner).toContain("AUTH_BOOTSTRAP is off");
      restore();
      errorSpy.mockRestore();
    });

    test("leaves bootstrap-on deployments alone: the first run generates one", () => {
      setSecret(undefined);
      setEnv("AUTH_BOOTSTRAP", undefined);
      setEnv("NODE_ENV", "production");
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const { exitCalls, restore } = stubProcessExit();

      verifyAuthEnvAtBoot();

      expect(exitCalls).toEqual([]);
      restore();
      errorSpy.mockRestore();
    });

    test("leaves development alone: getJwtSecret still has its fallback there", () => {
      setSecret(undefined);
      setEnv("AUTH_BOOTSTRAP", "off");
      setEnv("NODE_ENV", "development");
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const { exitCalls, restore } = stubProcessExit();

      verifyAuthEnvAtBoot();

      expect(exitCalls).toEqual([]);
      restore();
      errorSpy.mockRestore();
    });
  });
});

/**
 * Backlog K3: STORAGE_ENCRYPTION_KEY had no boot check, so a too-short key threw only at the first
 * storage write - after login, after the migration attempt - and surfaced as a syncError in the UI.
 */
describe("config/auth-preflight STORAGE_ENCRYPTION_KEY", () => {
  const origSecret = process.env.JWT_SECRET;
  const origKey = process.env.STORAGE_ENCRYPTION_KEY;
  const origProvider = process.env.STORAGE_PROVIDER;

  afterEach(() => {
    setEnv("JWT_SECRET", origSecret);
    setEnv("STORAGE_ENCRYPTION_KEY", origKey);
    setEnv("STORAGE_PROVIDER", origProvider);
  });

  function setEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  function stubProcessExit(): { exitCalls: Array<number | undefined>; restore: () => void } {
    const originalExit = process.exit;
    const exitCalls: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exitCalls.push(code);
    }) as unknown as typeof process.exit;
    return {
      exitCalls,
      restore: () => {
        process.exit = originalExit;
      },
    };
  }

  test("exits 1 with an actionable banner when a server storage provider has a too-short key", () => {
    setEnv("JWT_SECRET", "a-valid-secret-that-is-32-chars!");
    setEnv("STORAGE_PROVIDER", "postgres");
    setEnv("STORAGE_ENCRYPTION_KEY", "k".repeat(24));
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(false);
      expect(exitCalls).toEqual([1]);
      const banner = errorSpy.mock.calls.flat().join("\n");
      expect(banner).toContain("STORAGE_ENCRYPTION_KEY is too short");
      expect(banner).toContain("24 characters");
      expect(banner).toContain("32");
      // The key value itself must never reach the logs.
      expect(banner).not.toContain("k".repeat(24));
    } finally {
      restore();
      errorSpy.mockRestore();
    }
  });

  test("stays silent about the same too-short key when STORAGE_PROVIDER is local", () => {
    setEnv("JWT_SECRET", "a-valid-secret-that-is-32-chars!");
    setEnv("STORAGE_PROVIDER", "local");
    setEnv("STORAGE_ENCRYPTION_KEY", "k".repeat(24));
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(true);
      expect(exitCalls).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      restore();
      errorSpy.mockRestore();
    }
  });

  test("stays silent when STORAGE_PROVIDER is unset (the default is local)", () => {
    setEnv("JWT_SECRET", "a-valid-secret-that-is-32-chars!");
    setEnv("STORAGE_PROVIDER", undefined);
    setEnv("STORAGE_ENCRYPTION_KEY", "k".repeat(8));
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(true);
      expect(exitCalls).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      restore();
      errorSpy.mockRestore();
    }
  });

  test("accepts an exactly-32-character key with a server storage provider (boundary)", () => {
    setEnv("JWT_SECRET", "a-valid-secret-that-is-32-chars!");
    setEnv("STORAGE_PROVIDER", "sqlite");
    setEnv("STORAGE_ENCRYPTION_KEY", "m".repeat(32));
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(true);
      expect(exitCalls).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      restore();
      errorSpy.mockRestore();
    }
  });

  test("stays silent when the key is absent under a server provider: encryption falls back to JWT_SECRET", () => {
    setEnv("JWT_SECRET", "a-valid-secret-that-is-32-chars!");
    setEnv("STORAGE_PROVIDER", "sqlite");
    setEnv("STORAGE_ENCRYPTION_KEY", undefined);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(true);
      expect(exitCalls).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      restore();
      errorSpy.mockRestore();
    }
  });

  test("treats an empty key as absent, not as too short", () => {
    setEnv("JWT_SECRET", "a-valid-secret-that-is-32-chars!");
    setEnv("STORAGE_PROVIDER", "postgres");
    setEnv("STORAGE_ENCRYPTION_KEY", "");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const { exitCalls, restore } = stubProcessExit();

    try {
      expect(verifyAuthEnvAtBoot()).toBe(true);
      expect(exitCalls).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      restore();
      errorSpy.mockRestore();
    }
  });

  // ── AUTH_BOOTSTRAP=off with no secret (#908) ───────────────────────────────
  //
  // The setting is documented as turning off credential generation so an operator supplies
  // their own. It also turns off SECRET generation, which was documented nowhere, and the
  // failure was silent: the server started, the health probe answered "healthy", and every
  // login returned 503. A monitor stayed green through all of it and the first report came
  // from a user who could not sign in.
});

/**
 * STORAGE_POSTGRES_SCHEMA names the schema the PostgreSQL storage tables live in. A value that is
 * not a plain lowercase identifier would otherwise surface only at the first storage request, after
 * sign-in, as a failed sync, so the boot refuses it while that provider is selected.
 */
describe("config/auth-preflight STORAGE_POSTGRES_SCHEMA", () => {
  const original = {
    JWT_SECRET: process.env.JWT_SECRET,
    STORAGE_PROVIDER: process.env.STORAGE_PROVIDER,
    STORAGE_POSTGRES_SCHEMA: process.env.STORAGE_POSTGRES_SCHEMA,
    STORAGE_ENCRYPTION_KEY: process.env.STORAGE_ENCRYPTION_KEY,
  };

  afterEach(() => {
    for (const [name, value] of Object.entries(original)) setEnv(name, value);
  });

  function setEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  function run(provider: string | undefined, schema: string | undefined) {
    setEnv("JWT_SECRET", "a-valid-secret-that-is-32-chars!");
    setEnv("STORAGE_ENCRYPTION_KEY", undefined);
    setEnv("STORAGE_PROVIDER", provider);
    setEnv("STORAGE_POSTGRES_SCHEMA", schema);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const originalExit = process.exit;
    const exitCalls: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exitCalls.push(code);
    }) as unknown as typeof process.exit;
    try {
      const result = verifyAuthEnvAtBoot();
      return { result, exitCalls, banner: errorSpy.mock.calls.flat().join("\n") };
    } finally {
      process.exit = originalExit;
      errorSpy.mockRestore();
    }
  }

  test("an invalid STORAGE_POSTGRES_SCHEMA stops the boot when STORAGE_PROVIDER=postgres", () => {
    const { result, exitCalls, banner } = run("postgres", "Studio-Schema");
    expect(result).toBe(false);
    expect(exitCalls).toEqual([1]);
    expect(banner).toContain("LibreDB Studio cannot start: STORAGE_POSTGRES_SCHEMA is invalid");
    expect(banner).toContain(
      'STORAGE_POSTGRES_SCHEMA must be a lowercase PostgreSQL schema name matching ^[a-z_][a-z0-9_]{0,62}$, got "Studio-Schema"',
    );
  });

  test("a valid or unset STORAGE_POSTGRES_SCHEMA lets the postgres provider boot", () => {
    for (const schema of ["studio", undefined]) {
      const { result, exitCalls, banner } = run("postgres", schema);
      expect(result).toBe(true);
      expect(exitCalls).toEqual([]);
      expect(banner).toBe("");
    }
  });

  test("the variable is inert, and not checked, under any other storage provider", () => {
    for (const provider of ["local", "sqlite", undefined]) {
      const { result, exitCalls } = run(provider, "Studio-Schema");
      expect(result).toBe(true);
      expect(exitCalls).toEqual([]);
    }
  });
});
