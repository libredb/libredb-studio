import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import path from "path";
import { loadConfig, resetCache } from "@/lib/seed/config-loader";

const FIXTURES = path.resolve(__dirname, "../../fixtures/seed-connections");

describe("config-loader", () => {
  beforeEach(() => {
    resetCache();
  });

  afterEach(() => {
    delete process.env.SEED_CONFIG_PATH;
    delete process.env.SEED_CACHE_TTL_MS;
  });

  it("loads and parses valid YAML config", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "valid-config.yaml");
    const config = await loadConfig();
    expect(config).not.toBeNull();
    expect(config!.version).toBe("1");
    expect(config!.connections).toHaveLength(4);
    expect(config!.connections[0].id).toBe("test-postgres");
  });

  it("loads and parses valid JSON config", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "valid-config.json");
    const config = await loadConfig();
    expect(config).not.toBeNull();
    expect(config!.version).toBe("1");
    expect(config!.connections).toHaveLength(1);
  });

  it("returns null when config file does not exist", async () => {
    process.env.SEED_CONFIG_PATH = "/nonexistent/path/config.yaml";
    const config = await loadConfig();
    expect(config).toBeNull();
  });

  it("throws on invalid YAML (validation fails)", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "invalid-config.yaml");
    await expect(loadConfig()).rejects.toThrow();
  });

  it("throws a parse error on malformed JSON", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "malformed-config.json");
    await expect(loadConfig()).rejects.toThrow(/Failed to parse seed config/);
  });

  // A parser's message quotes the line it failed on, and in a seed file that line can hold a
  // plaintext password. The loader's message reaches every caller of a `seed:` route through the
  // error response, so it says where the file fails and quotes none of it.
  it("says where a YAML file fails to parse without quoting the file", async () => {
    const file = path.join(FIXTURES, "malformed-secret-config.yaml");
    process.env.SEED_CONFIG_PATH = file;
    const error = (await loadConfig().catch((thrown: unknown) => thrown)) as Error;
    expect(error).toBeInstanceOf(Error);

    expect(error.message).toBe(`Failed to parse seed config at ${file}: BAD_SCALAR_START at line 8, column 15`);
    // Control: the parser's own message quotes the password, and the operator can still reach it.
    expect((error.cause as Error).message).toContain("CanaryPlaintextPassword");
  });

  // An unresolved alias is not a YAMLParseError, and its message is the alias name itself.
  it("says a YAML file fails to load without quoting an alias it names", async () => {
    const file = path.join(FIXTURES, "malformed-alias-config.yaml");
    process.env.SEED_CONFIG_PATH = file;
    const error = (await loadConfig().catch((thrown: unknown) => thrown)) as Error;
    expect(error).toBeInstanceOf(Error);

    expect(error.message).toBe(`Failed to parse seed config at ${file}: the file is not valid YAML`);
    expect((error.cause as Error).message).toContain("CanaryAliasPassword");
  });

  it("says a JSON file fails to parse without quoting the file", async () => {
    const file = path.join(FIXTURES, "malformed-secret-config.json");
    process.env.SEED_CONFIG_PATH = file;
    const error = (await loadConfig().catch((thrown: unknown) => thrown)) as Error;
    expect(error).toBeInstanceOf(Error);

    expect(error.message).toBe(`Failed to parse seed config at ${file}: the file is not valid JSON`);
    expect((error.cause as Error).message).toContain("CanaryPlaintextPassword");
  });

  it("rethrows non-ENOENT read errors", async () => {
    // Reading a directory fails with EISDIR, which must NOT be swallowed.
    process.env.SEED_CONFIG_PATH = FIXTURES;
    await expect(loadConfig()).rejects.toThrow();
  });

  it("uses default path when SEED_CONFIG_PATH not set", async () => {
    const config = await loadConfig();
    expect(config).toBeNull();
  });

  it("caches result within TTL", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "valid-config.yaml");
    process.env.SEED_CACHE_TTL_MS = "60000";
    const config1 = await loadConfig();
    const config2 = await loadConfig();
    expect(config1).toBe(config2);
  });

  it("reloads after cache reset", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "valid-config.yaml");
    const config1 = await loadConfig();
    resetCache();
    const config2 = await loadConfig();
    expect(config1).not.toBe(config2);
    expect(config1!.connections).toHaveLength(config2!.connections.length);
  });

  it("loads minimal config with only required fields", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "minimal-config.yaml");
    const config = await loadConfig();
    expect(config).not.toBeNull();
    expect(config!.connections).toHaveLength(1);
  });
});
