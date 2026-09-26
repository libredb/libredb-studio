/**
 * The MCP server's configuration (#246): the kill switch, the canonical URL, the token label and
 * the token lifetime, each read from process.env on every call. A problem names its variable and
 * the rule it broke, and never the configured value, which can carry credentials in its user info.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MCP_ENABLED_ENV,
  MCP_ENABLED_INVALID_MESSAGE,
  MCP_PATH,
  MCP_TOKEN_LABEL_ENV,
  MCP_TOKEN_TTL_DAYS_DEFAULT,
  MCP_TOKEN_TTL_DAYS_ENV,
  MCP_TOKEN_TTL_DAYS_MAX,
  MCP_URL_ENV,
  McpConfigError,
  mcpChannelStatus,
  readMcpSwitch,
  readMcpTokenLabel,
  readMcpTokenTtlDays,
  readMcpUrl,
} from "@/lib/mcp/config";

const NAMES = [MCP_ENABLED_ENV, MCP_URL_ENV, MCP_TOKEN_LABEL_ENV, MCP_TOKEN_TTL_DAYS_ENV];
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of NAMES) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of NAMES) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const SWITCH_OFF = "LIBREDB_MCP_ENABLED is off: set it to true, on or 1 to enable MCP";
const URL_UNSET =
  "LIBREDB_MCP_URL is not set: set it to the address clients use, such as https://studio.example.com/api/mcp";
const URL_NOT_ABSOLUTE =
  "LIBREDB_MCP_URL is not an absolute URL: set it to the address clients use, such as https://studio.example.com/api/mcp";
const LABEL_UNSET =
  "LIBREDB_MCP_TOKEN_LABEL is not set: set it to any value, and change it to revoke every MCP token at once";
const TTL_INVALID = "LIBREDB_MCP_TOKEN_TTL_DAYS must be a whole number of days from 1 to 365";

describe("LIBREDB_MCP_ENABLED", () => {
  test("is off when unset", () => {
    expect(readMcpSwitch()).toEqual({ state: "off" });
  });

  test.each(["true", "on", "1", " TRUE ", "On"])("%p turns MCP on", (value) => {
    process.env[MCP_ENABLED_ENV] = value;
    expect(readMcpSwitch()).toEqual({ state: "on" });
  });

  test.each(["false", "off", "0", "", "   "])("%p leaves MCP off", (value) => {
    process.env[MCP_ENABLED_ENV] = value;
    expect(readMcpSwitch()).toEqual({ state: "off" });
  });

  test.each(["yes", "enabled", "2"])("%p is an unrecognized value, never a default", (value) => {
    process.env[MCP_ENABLED_ENV] = value;
    expect(readMcpSwitch()).toEqual({ state: "invalid", raw: value });
  });

  test("is read on every call, so a change is seen by the next request", () => {
    process.env[MCP_ENABLED_ENV] = "true";
    expect(readMcpSwitch().state).toBe("on");
    process.env[MCP_ENABLED_ENV] = "off";
    expect(readMcpSwitch().state).toBe("off");
  });
});

describe("LIBREDB_MCP_URL", () => {
  test("must end in the endpoint's own path", () => {
    expect(MCP_PATH).toBe("/api/mcp");
  });

  test("is canonicalized to origin plus path, a base path included", () => {
    process.env[MCP_URL_ENV] = "  https://MCP-Host.test:443/tools/libredb/api/mcp  ";
    expect(readMcpUrl()).toEqual({ ok: true, value: "https://mcp-host.test/tools/libredb/api/mcp" });
  });

  test("keeps a port that is not the scheme's default", () => {
    process.env[MCP_URL_ENV] = "http://127.0.0.1:3000/api/mcp";
    expect(readMcpUrl()).toEqual({ ok: true, value: "http://127.0.0.1:3000/api/mcp" });
  });

  test("unset or blank names the variable and an example", () => {
    expect(readMcpUrl()).toEqual({ ok: false, problem: URL_UNSET });
    process.env[MCP_URL_ENV] = "   ";
    expect(readMcpUrl()).toEqual({ ok: false, problem: URL_UNSET });
  });

  test.each([
    ["mcp-host.test/api/mcp", URL_NOT_ABSOLUTE],
    ["ftp://mcp-host.test/api/mcp", "LIBREDB_MCP_URL must use http or https"],
    ["https://mcp-host.test/api/mcp?next=1", "LIBREDB_MCP_URL must not carry a query or a fragment"],
    ["https://mcp-host.test/api/mcp#part", "LIBREDB_MCP_URL must not carry a query or a fragment"],
    ["https://mcp-host.test/api/mcp/", "LIBREDB_MCP_URL must end in /api/mcp, with no trailing slash"],
    ["https://mcp-host.test/xapi/mcp", "LIBREDB_MCP_URL must end in /api/mcp, with no trailing slash"],
  ])("%p is refused, and the problem does not repeat the value", (value, problem) => {
    process.env[MCP_URL_ENV] = value;
    expect(readMcpUrl()).toEqual({ ok: false, problem });
    expect(problem).not.toContain("mcp-host.test");
  });

  test("a URL with user info is refused without quoting any part of it", () => {
    // Built from parts with a password generated at run time, so the file holds no credential for a secret scanner to flag.
    const credentialed = new URL("https://mcp-host.test/api/mcp");
    credentialed.username = "someone";
    credentialed.password = crypto.randomUUID();
    process.env[MCP_URL_ENV] = credentialed.href;
    const reading = readMcpUrl();
    expect(reading).toEqual({ ok: false, problem: "LIBREDB_MCP_URL must not carry a user name or password" });
    for (const part of ["someone", credentialed.password, "mcp-host.test"])
      expect(JSON.stringify(reading)).not.toContain(part);
  });
});

describe("LIBREDB_MCP_TOKEN_LABEL", () => {
  test("has no default: unset or blank is a problem", () => {
    expect(readMcpTokenLabel()).toEqual({ ok: false, problem: LABEL_UNSET });
    process.env[MCP_TOKEN_LABEL_ENV] = "  ";
    expect(readMcpTokenLabel()).toEqual({ ok: false, problem: LABEL_UNSET });
  });

  test("is any non-empty value, trimmed", () => {
    process.env[MCP_TOKEN_LABEL_ENV] = "  rotation-two  ";
    expect(readMcpTokenLabel()).toEqual({ ok: true, value: "rotation-two" });
  });
});

describe("LIBREDB_MCP_TOKEN_TTL_DAYS", () => {
  test("defaults to 30 days and allows at most 365", () => {
    expect(MCP_TOKEN_TTL_DAYS_DEFAULT).toBe(30);
    expect(MCP_TOKEN_TTL_DAYS_MAX).toBe(365);
    expect(readMcpTokenTtlDays()).toEqual({ ok: true, value: 30 });
  });

  test.each([
    ["1", 1],
    [" 365 ", 365],
    ["7", 7],
  ])("%p is %p days", (value, days) => {
    process.env[MCP_TOKEN_TTL_DAYS_ENV] = value;
    expect(readMcpTokenTtlDays()).toEqual({ ok: true, value: days });
  });

  test.each(["0", "366", "abc", "1.5", "-3", "7d"])("%p is refused", (value) => {
    process.env[MCP_TOKEN_TTL_DAYS_ENV] = value;
    expect(readMcpTokenTtlDays()).toEqual({ ok: false, problem: TTL_INVALID });
  });
});

describe("the channel status", () => {
  test("of a default deployment is off and lists what enabling it needs", () => {
    expect(mcpChannelStatus()).toEqual({
      state: "off",
      problems: [SWITCH_OFF, URL_UNSET, LABEL_UNSET],
      url: null,
      tokenTtlDays: 30,
    });
  });

  test("is ready when the switch is on and the URL and the label are usable", () => {
    process.env[MCP_ENABLED_ENV] = "on";
    process.env[MCP_URL_ENV] = "https://mcp-host.test/api/mcp";
    process.env[MCP_TOKEN_LABEL_ENV] = "label-one";
    expect(mcpChannelStatus()).toEqual({
      state: "ready",
      problems: [],
      url: "https://mcp-host.test/api/mcp",
      tokenTtlDays: 30,
    });
  });

  test("is misconfigured by an unrecognized switch value, named first", () => {
    process.env[MCP_ENABLED_ENV] = "yes";
    process.env[MCP_URL_ENV] = "https://mcp-host.test/api/mcp";
    process.env[MCP_TOKEN_LABEL_ENV] = "label-one";
    expect(mcpChannelStatus()).toEqual({
      state: "misconfigured",
      problems: [MCP_ENABLED_INVALID_MESSAGE],
      url: "https://mcp-host.test/api/mcp",
      tokenTtlDays: 30,
    });
  });

  test("is misconfigured by an unusable URL or lifetime while the switch is on", () => {
    process.env[MCP_ENABLED_ENV] = "true";
    process.env[MCP_URL_ENV] = "https://mcp-host.test/api/mcp/";
    process.env[MCP_TOKEN_LABEL_ENV] = "label-one";
    process.env[MCP_TOKEN_TTL_DAYS_ENV] = "0";
    expect(mcpChannelStatus()).toEqual({
      state: "misconfigured",
      problems: ["LIBREDB_MCP_URL must end in /api/mcp, with no trailing slash", TTL_INVALID],
      url: null,
      tokenTtlDays: null,
    });
  });
});

describe("McpConfigError", () => {
  test("carries every problem and joins them in its message", () => {
    const error = new McpConfigError([URL_UNSET, LABEL_UNSET]);
    expect(error.problems).toEqual([URL_UNSET, LABEL_UNSET]);
    expect(error.message).toBe(`${URL_UNSET}; ${LABEL_UNSET}`);
    expect(error.name).toBe("McpConfigError");
  });
});
