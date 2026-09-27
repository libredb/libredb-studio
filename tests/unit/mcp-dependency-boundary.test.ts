import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as client from "@modelcontextprotocol/client";
import * as server from "@modelcontextprotocol/server";

/**
 * The MCP server's dependency line (#246), in the shape of agent-dependency-boundary.test.ts.
 *
 * Three rules. The official TypeScript SDK is installed at exactly the ratified versions and
 * only as development dependencies: the standalone build bundles it, and a consumer of the
 * published package must never install it. The frozen v1 helpers and the v1 SDK stay out
 * entirely. And the lockfile resolves every SDK package onto one core and the root zod, so a
 * second copy of either cannot slip in underneath.
 *
 * The imports above are the fourth rule: the exact exports this server builds on exist in the
 * installed packages and load under Bun, which is the runtime the whole suite runs on.
 */

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const ROOT = path.resolve(import.meta.dir, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as PackageManifest;
const lockfile = fs.readFileSync(path.join(ROOT, "bun.lock"), "utf8");

const RATIFIED_SDK: Readonly<Record<string, string>> = {
  "@modelcontextprotocol/server": "2.1.0",
  "@modelcontextprotocol/client": "2.1.0",
};
/** Every field npm installs on a consumer of the published package. */
const PUBLISHED_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;
const ALL_FIELDS = [...PUBLISHED_FIELDS, "devDependencies"] as const;
/** Copied out of the namespaces so an export is looked up by name without a computed namespace access. */
const serverExports: Readonly<Record<string, unknown>> = { ...server };
const clientExports: Readonly<Record<string, unknown>> = { ...client };

describe("the MCP SDK is installed at the ratified versions", () => {
  test.each(Object.entries(RATIFIED_SDK))("declares %s at exactly %s under devDependencies", (name, version) => {
    expect(manifest.devDependencies?.[name]).toBe(version);
  });
});

describe("no MCP package reaches a consumer of the published package", () => {
  test.each([...PUBLISHED_FIELDS])("%s declares no @modelcontextprotocol package", (field) => {
    const declared = Object.keys(manifest[field] ?? {}).filter((name) => name.startsWith("@modelcontextprotocol/"));
    expect(declared).toEqual([]);
  });

  test("neither the frozen v1 helpers nor the v1 SDK is declared anywhere", () => {
    const names = ALL_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {}));
    // The control: the scan reads the manifest that declares the ratified package.
    expect(names).toContain("@modelcontextprotocol/server");
    expect(names).not.toContain("@modelcontextprotocol/server-legacy");
    expect(names).not.toContain("@modelcontextprotocol/sdk");
    expect(names).not.toContain("@modelcontextprotocol/core");
  });
});

describe("bun.lock resolves the SDK onto one core and the root zod", () => {
  test("@modelcontextprotocol/core resolves only at 2.1.0", () => {
    const versions = [...lockfile.matchAll(/\["@modelcontextprotocol\/core@([^"]+)"/g)].map((match) => match[1]);
    expect(versions.length).toBeGreaterThan(0);
    expect([...new Set(versions)]).toEqual(["2.1.0"]);
  });

  test.each(["server", "client", "core"])("no nested zod copy sits under @modelcontextprotocol/%s", (name) => {
    // The control: bun.lock names a nested copy by this key shape, as it does for @vercel/cli-auth.
    expect(lockfile).toContain('"@vercel/cli-auth/zod": [');
    expect(lockfile).not.toContain(`"@modelcontextprotocol/${name}/zod": [`);
  });
});

describe("the installed SDK exports what this server builds on", () => {
  test.each([
    "createMcpHandler",
    "McpServer",
    "isLegacyRequest",
    "readRequestBody",
    "isJsonContentType",
    "originValidationResponse",
    "localhostAllowedOrigins",
    "hostHeaderValidationResponse",
    "localhostAllowedHostnames",
    "verifyBearerToken",
    "bearerAuthChallengeResponse",
    "OAuthError",
    "OAuthErrorCode",
  ])("@modelcontextprotocol/server exports %s", (name) => {
    expect(serverExports[name]).toBeDefined();
  });

  test("the request-body bound the route copies is 4 MiB", () => {
    expect(server.DEFAULT_MAX_REQUEST_BODY_SIZE).toBe(4_194_304);
  });

  test.each(["Client", "StreamableHTTPClientTransport", "SdkHttpError", "SdkErrorCode"])(
    "@modelcontextprotocol/client exports %s",
    (name) => {
      expect(clientExports[name]).toBeDefined();
    },
  );
});
