import { describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "fs";
import path from "path";
import { z } from "zod";
import {
  describeIssues,
  entriesFromConfig,
  parseSeedConfigText,
  seedConfigFormatOf,
} from "@/lib/seed/sources/config-text";
import { OperatorSourceError } from "@/lib/seed/sources/types";

const FIXTURES = path.resolve(__dirname, "../../../fixtures/seed-connections");
const fixturePath = (name: string): string => path.join(FIXTURES, name);
const fixtureText = (name: string): string => readFileSync(fixturePath(name), "utf8");

/** The OperatorSourceError `run` throws; any other outcome fails the test. */
function sourceErrorOf(run: () => unknown): OperatorSourceError {
  try {
    run();
  } catch (err) {
    if (err instanceof OperatorSourceError) return err;
    throw err;
  }
  throw new Error("expected an OperatorSourceError, and nothing was thrown");
}

const connection = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Connection ${id}`,
  type: "postgres",
  host: `${id}.internal`,
  roles: ["admin"],
  ...extra,
});

describe("OperatorSourceError", () => {
  it("is an Error with its name, its code and the cause it was given", () => {
    const cause = new Error("parser detail");
    const error = new OperatorSourceError("unparseable", "Failed to parse seed config at X: Y", { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("OperatorSourceError");
    expect(error.code).toBe("unparseable");
    expect(error.message).toBe("Failed to parse seed config at X: Y");
    expect(error.cause).toBe(cause);
  });
});

describe("seedConfigFormatOf", () => {
  it.each([
    ["seed-connections.json", "json"],
    ["seed-connections.yaml", "yaml"],
    ["seed-connections.yml", "yaml"],
    // The extension is compared as written, as the seed file loader always did.
    ["seed-connections.JSON", "yaml"],
    ["SEED_CONFIG_INLINE", "yaml"],
  ] as const)("reads %s as %s", (name, format) => {
    expect(seedConfigFormatOf(name)).toBe(format);
  });
});

describe("describeIssues", () => {
  it("writes each issue as its dotted path and its message, joined by '; '", () => {
    const schema = z.object({
      a: z.string({ error: "a is wrong" }),
      b: z.object({ c: z.number({ error: "c is wrong" }) }),
    });
    const parsed = schema.safeParse({ a: 1, b: { c: "x" } });
    if (parsed.success) throw new Error("the premise: this input is refused");

    expect(describeIssues(parsed.error)).toBe("a: a is wrong; b.c: c is wrong");
  });
});

describe("parseSeedConfigText", () => {
  it("parses and validates a YAML config", () => {
    const config = parseSeedConfigText(fixtureText("valid-config.yaml"), "/seed/valid.yaml", "yaml");

    expect(config.version).toBe("1");
    expect(config.connections.map((conn) => conn.id)).toEqual([
      "test-postgres",
      "test-mysql",
      "test-mongo",
      "test-redis",
    ]);
  });

  it("parses and validates a JSON config", () => {
    const config = parseSeedConfigText(fixtureText("valid-config.json"), "/seed/valid.json", "json");

    expect(config.connections.map((conn) => conn.id)).toEqual(["test-postgres"]);
  });

  // A parser's message quotes the line it failed on, and in a seed file that line can hold a plaintext password.
  it("says where YAML fails to parse, with the code, the line and the column, and quotes none of it", () => {
    const origin = fixturePath("malformed-secret-config.yaml");
    const error = sourceErrorOf(() => parseSeedConfigText(fixtureText("malformed-secret-config.yaml"), origin, "yaml"));

    expect(error.code).toBe("unparseable");
    expect(error.message).toBe(`Failed to parse seed config at ${origin}: BAD_SCALAR_START at line 8, column 15`);
    // Control: the parser's own message quotes the password, and stays reachable as the cause.
    expect((error.cause as Error).message).toContain("CanaryPlaintextPassword");
  });

  // `parse` from `yaml` hands a warning to process.emitWarning, which prints the quoted source line to stderr outside
  // the logger; an unquoted password that starts with "!" is an unresolved tag, and its warning names the password.
  it("fails on a YAML warning, names its code and position only, and prints nothing", () => {
    const emitWarning = spyOn(process, "emitWarning").mockImplementation(() => {});
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const text = [
        'version: "1"',
        "connections:",
        "  - id: tagged",
        "    name: Tagged",
        "    type: postgres",
        "    host: db.internal",
        "    password: !Passw0rd",
        "",
      ].join("\n");
      const error = sourceErrorOf(() => parseSeedConfigText(text, "/seed/tagged.yaml", "yaml"));

      expect(error.code).toBe("unparseable");
      expect(error.message).toBe(
        "Failed to parse seed config at /seed/tagged.yaml: TAG_RESOLVE_FAILED at line 7, column 15",
      );
      expect(error.message).not.toContain("Passw0rd");
      expect(emitWarning).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      emitWarning.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it("says YAML fails to load without quoting an alias it names", () => {
    const origin = fixturePath("malformed-alias-config.yaml");
    const error = sourceErrorOf(() => parseSeedConfigText(fixtureText("malformed-alias-config.yaml"), origin, "yaml"));

    expect(error.code).toBe("unparseable");
    expect(error.message).toBe(`Failed to parse seed config at ${origin}: the file is not valid YAML`);
    expect((error.cause as Error).message).toContain("CanaryAliasPassword");
  });

  it("says JSON fails to parse without quoting it", () => {
    const origin = fixturePath("malformed-secret-config.json");
    const error = sourceErrorOf(() => parseSeedConfigText(fixtureText("malformed-secret-config.json"), origin, "json"));

    expect(error.code).toBe("unparseable");
    expect(error.message).toBe(`Failed to parse seed config at ${origin}: the file is not valid JSON`);
    expect((error.cause as Error).message).toContain("CanaryPlaintextPassword");
  });

  it("names the origin of a config the schema refuses", () => {
    const origin = fixturePath("invalid-config.yaml");
    const error = sourceErrorOf(() => parseSeedConfigText(fixtureText("invalid-config.yaml"), origin, "yaml"));

    expect(error.code).toBe("invalid");
    expect(error.message.startsWith(`Invalid seed config at ${origin}: `)).toBe(true);
  });

  it("writes every schema issue with the issue format of describeIssues", () => {
    const text = JSON.stringify({ version: "2", connections: [] });
    const error = sourceErrorOf(() => parseSeedConfigText(text, "SEED_CONFIG_INLINE", "json"));

    expect(error.message).toBe(
      'Invalid seed config at SEED_CONFIG_INLINE: version: Invalid input: expected "1"; connections: At least one connection is required',
    );
  });

  it("refuses two connections with one id inside one config", () => {
    const text = JSON.stringify({ version: "1", connections: [connection("dup"), connection("dup")] });
    const error = sourceErrorOf(() => parseSeedConfigText(text, "/seed/dup.json", "json"));

    expect(error.code).toBe("invalid");
    // The refine on SeedConfigSchema (src/lib/seed/types.ts:247-249) has an empty path, as it has today.
    expect(error.message).toBe("Invalid seed config at /seed/dup.json: : Connection IDs must be unique");
  });

  it("names the fields of a refused connection and none of their values", () => {
    const values = ["Canary_Id_Value", "canary-type-value", "9876543210", "canary-color-value", "canary-role-value"];
    const text = JSON.stringify({
      version: "1",
      connections: [
        {
          id: values[0],
          name: "Refused",
          type: values[1],
          password: Number(values[2]),
          color: values[3],
          roles: [values[4]],
        },
      ],
    });
    const error = sourceErrorOf(() => parseSeedConfigText(text, "/seed/refused.json", "json"));

    expect(error.code).toBe("invalid");
    for (const field of ["connections.0.id", "connections.0.type", "connections.0.password", "connections.0.color"]) {
      expect(error.message).toContain(`${field}: `);
    }
    for (const value of values) expect(error.message).not.toContain(value);
  });
});

describe("entriesFromConfig", () => {
  it("merges each config's own defaults into its own entries only", () => {
    const withDefaults = parseSeedConfigText(
      JSON.stringify({
        version: "1",
        defaults: { managed: false, environment: "staging", ssl: { mode: "require" } },
        connections: [connection("a"), connection("b", { environment: "production" })],
      }),
      "/seed/one.json",
      "json",
    );
    const withoutDefaults = parseSeedConfigText(
      JSON.stringify({ version: "1", connections: [connection("c")] }),
      "/seed/two.json",
      "json",
    );

    const shape = (entries: ReturnType<typeof entriesFromConfig>) =>
      entries.map((entry) => [
        entry.origin,
        entry.literal,
        entry.connection.id,
        entry.connection.managed,
        entry.connection.environment,
        entry.connection.ssl?.mode,
      ]);

    expect(shape(entriesFromConfig(withDefaults, "/seed/one.json", false))).toEqual([
      ["/seed/one.json", false, "a", false, "staging", "require"],
      ["/seed/one.json", false, "b", false, "production", "require"],
    ]);
    expect(shape(entriesFromConfig(withoutDefaults, "/seed/two.json", true))).toEqual([
      ["/seed/two.json", true, "c", undefined, undefined, undefined],
    ]);
  });

  it("leaves every ${ENV} reference for the loader to resolve", () => {
    const config = parseSeedConfigText(fixtureText("valid-config.yaml"), "/seed/valid.yaml", "yaml");

    expect(entriesFromConfig(config, "/seed/valid.yaml", false)[0]?.connection.password).toBe("${TEST_PG_PASSWORD}");
  });
});
