/**
 * Regression guard for SQL Server connections addressed by IP address.
 *
 * `tedious` negotiates TLS in two places, and only one of them used to obey RFC 6066,
 * which forbids an IP address as the TLS SNI server name. `connection.js`'s strict
 * (TDS 8.0) path has always blanked SNI for an IP; the `startTls` path that a normal
 * `encrypt: true` connection takes passed the server address straight through as
 * `servername`. Node tolerated that until it did not: measured on 2026-08-18, the same
 * image and the same server answer a hostname and refuse an IP —
 *
 *   | runtime      | tedious | `server: "127.0.0.1"`                    |
 *   | ------------ | ------- | ---------------------------------------- |
 *   | Node 24.16.0 | 20.0.0  | connects                                 |
 *   | Node 26.7.0  | 20.0.0  | `Setting the TLS ServerName to an IP ...` |
 *   | Node 26.7.0  | 20.0.5  | connects                                 |
 *
 * So the failure needed BOTH the Node bump this release ships and a `tedious` old
 * enough to lack the guard. `package.json` pins the fixed one through `overrides`,
 * because the range `mssql` declares (`^19.2.2 || ^20.0.0`) is satisfied by the broken
 * version and a lockfile refresh would happily resolve back to it.
 *
 * The version assertion alone would not catch a re-broken upstream, so the guard also
 * reads the shipped file: what protects a user is the code in `node_modules`, not the
 * number beside it in a manifest.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** `20.0.5` -> `[20, 0, 5]`, so the comparison is numeric rather than lexicographic. */
const parts = (version: string) => version.split(".").map((n) => Number.parseInt(n, 10));

const atLeast = (version: string, floor: string) => {
  const [a, b, c] = parts(version);
  const [x, y, z] = parts(floor);
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c >= z;
};

describe("a SQL Server connection addressed by IP keeps its TLS handshake", () => {
  const pkg = JSON.parse(read("package.json")) as { overrides?: Record<string, string> };
  const installed = JSON.parse(read("node_modules/tedious/package.json")) as { version: string };

  test("the parser this test compares with orders releases numerically, not as text", () => {
    // 20.0.10 sorts BELOW 20.0.5 as text, which is the way a version floor is usually
    // got wrong; a vacuous comparison here would pass every assertion below.
    expect(atLeast("20.0.10", "20.0.5")).toBe(true);
    expect(atLeast("20.0.0", "20.0.5")).toBe(false);
    expect(atLeast("19.9.9", "20.0.5")).toBe(false);
  });

  test("package.json pins tedious past the release that blanks SNI for an IP", () => {
    expect(pkg.overrides?.tedious).toBeDefined();
  });

  test("the installed tedious is at or past that release", () => {
    expect(atLeast(installed.version, "20.0.5")).toBe(true);
  });

  test("the installed startTls omits SNI for an IP rather than sending the address", () => {
    // The fix upstream is `servername: isIP(hostname) ? '' : hostname`. Assert the
    // decision is present rather than the exact expression, so a reformat or a rename
    // of the import does not fail this while the behaviour still holds.
    const messageIo = read("node_modules/tedious/lib/message-io.js");
    const startTls = messageIo.slice(messageIo.indexOf("startTls("));
    const handshake = startTls.slice(0, startTls.indexOf("rejectUnauthorized"));

    expect(handshake).toContain("servername");
    expect(handshake).toMatch(/isIP\)?\(hostname\)/);
  });
});
