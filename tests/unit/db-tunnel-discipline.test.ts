import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

/**
 * The SSH tunnel boundary, made mechanical (#457).
 *
 * `createDatabaseProvider` is a provider switch and nothing more: it does NOT open the
 * connection's SSH tunnel. Only the two caching entry points do that -
 * `getOrCreateProvider` and `acquireExecutionProfileProvider` - so anything that builds a
 * provider directly and then CONNECTS it must go through `withOneShotTunnel`, or it
 * silently dials the raw database host.
 *
 * That is not a hypothetical. Two routes followed this pattern and both were written
 * without the tunnel: `/api/db/test-connection` (reported as #457) and
 * `/api/db/schema-snapshot` (found while fixing it). Two for two. The unit and route
 * tests added with the fix pin those two files; nothing pinned the RULE, so a third
 * route would have repeated it - and fifteen green tunnel tests would not have noticed,
 * because they all exercised the two paths that already had the code.
 *
 * Deliberately a source scan rather than a live probe. A live probe asserts against
 * named endpoints, so a NEW route that forgets the tunnel is invisible to it - it would
 * need the same awareness the author was missing. This rule needs none: the violation is
 * the shape of the file.
 *
 * Its limit, stated so nobody over-trusts it: it reads text. A provider obtained through
 * a helper, or a `connect()` reached by indirection, passes. It catches the careless
 * repeat, which is the case that actually happened, not a determined one.
 */

const SRC = path.join(process.cwd(), "src");

/** Import specifiers that resolve to the factory. */
const FACTORY_SPECIFIERS = ["@/lib/db/factory", "@/lib/db"] as const;

/**
 * Files exempt from the rule, each with the reason it cannot apply. An entry here is a
 * reviewed decision, not a silencer: adding one has to survive the question "why does
 * this connect without a tunnel?".
 */
const EXEMPT: Readonly<Record<string, string>> = {
  // Defines both sides of the rule.
  "src/lib/db/factory.ts": "the factory itself - it defines createDatabaseProvider and withOneShotTunnel",
  // Re-export surfaces: they name the symbols, they call nothing.
  "src/lib/db/index.ts": "re-export barrel, no call sites",
  "src/exports/providers.ts": "published package surface, no call sites",
};

interface Violation {
  file: string;
  reason: string;
}

/**
 * The rule, over one file's text. Returns null when the file is compliant or the rule
 * does not apply to it.
 */
function analyseTunnelDiscipline(relPath: string, source: string): Violation | null {
  if (EXEMPT[relPath]) return null;

  const importsFactory = FACTORY_SPECIFIERS.some((specifier) =>
    new RegExp(`import\\s+\\{[^}]*\\bcreateDatabaseProvider\\b[^}]*\\}\\s+from\\s+["']${specifier}["']`, "s").test(
      source,
    ),
  );
  if (!importsFactory) return null;

  // A provider that is never connected has no transport to tunnel: `provider-meta` and
  // the agent runtime read type-driven capabilities off a constructed provider and stop
  // there. Those are correct as they stand, and the rule must not force a tunnel on them.
  if (!/\.connect\s*\(\s*\)/.test(source)) return null;

  if (/\bwithOneShotTunnel\b/.test(source)) return null;

  return {
    file: relPath,
    reason:
      "builds a provider with createDatabaseProvider and connects it, without withOneShotTunnel - " +
      "so a connection with an SSH tunnel would dial the raw database host (#457)",
  };
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      acc.push(full);
    }
  }
  return acc;
}

describe("SSH tunnel discipline (#457)", () => {
  // ── The rule's own teeth ───────────────────────────────────────────────────
  // Without these, the tree scan below is a negative assertion that would keep
  // passing even if the rule stopped detecting anything at all.

  test("flags a file that builds a provider and connects it without the scope", () => {
    const offender = `
      import { createDatabaseProvider } from "@/lib/db/factory";
      export async function POST() {
        const provider = await createDatabaseProvider(connection);
        await provider.connect();
      }
    `;
    expect(analyseTunnelDiscipline("src/app/api/db/new-route/route.ts", offender)).not.toBeNull();
  });

  test("flags it through the barrel specifier too", () => {
    const offender = `
      import { createDatabaseProvider } from "@/lib/db";
      const p = await createDatabaseProvider(c);
      await p.connect();
    `;
    expect(analyseTunnelDiscipline("src/app/api/db/other/route.ts", offender)).not.toBeNull();
  });

  test("accepts a file that wraps the provider in the scope", () => {
    const compliant = `
      import { createDatabaseProvider, withOneShotTunnel } from "@/lib/db/factory";
      export async function POST() {
        return await withOneShotTunnel(connection, async (effective) => {
          const provider = await createDatabaseProvider(effective);
          await provider.connect();
        });
      }
    `;
    expect(analyseTunnelDiscipline("src/app/api/db/wrapped/route.ts", compliant)).toBeNull();
  });

  test("ignores a file that builds a provider but never connects it", () => {
    // The provider-meta and agent-runtime shape: type-driven reads, no socket.
    const metadataOnly = `
      import { createDatabaseProvider } from "@/lib/db";
      const provider = await createDatabaseProvider(connection);
      return { capabilities: provider.getCapabilities(), labels: provider.getLabels() };
    `;
    expect(analyseTunnelDiscipline("src/app/api/db/meta/route.ts", metadataOnly)).toBeNull();
  });

  test("ignores a file that connects a provider it did not build with the factory", () => {
    const pooled = `
      import { getOrCreateProvider } from "@/lib/db";
      const provider = await getOrCreateProvider(connection);
      await provider.connect();
    `;
    expect(analyseTunnelDiscipline("src/app/api/db/pooled/route.ts", pooled)).toBeNull();
  });

  test("respects the exemption list", () => {
    const barrel = `
      import { createDatabaseProvider } from "@/lib/db/factory";
      await x.connect();
    `;
    expect(analyseTunnelDiscipline("src/lib/db/index.ts", barrel)).toBeNull();
  });

  // ── The tree ──────────────────────────────────────────────────────────────

  test("every connecting caller of createDatabaseProvider tunnels", () => {
    const violations = walk(SRC)
      .map((full) => {
        const relPath = path.relative(process.cwd(), full);
        return analyseTunnelDiscipline(relPath, fs.readFileSync(full, "utf8"));
      })
      .filter((v): v is Violation => v !== null);

    expect(violations.map((v) => `${v.file}: ${v.reason}`)).toEqual([]);
  });

  test("the rule actually reaches the two routes it exists for", () => {
    // Guards against the scan silently covering nothing - a rename, a moved route or a
    // changed import specifier would otherwise leave this suite green and blind.
    const scanned = walk(SRC).map((full) => path.relative(process.cwd(), full));
    expect(scanned).toContain("src/app/api/db/test-connection/route.ts");
    expect(scanned).toContain("src/app/api/db/schema-snapshot/route.ts");

    for (const route of ["src/app/api/db/test-connection/route.ts", "src/app/api/db/schema-snapshot/route.ts"]) {
      const source = fs.readFileSync(path.join(process.cwd(), route), "utf8");
      // Compliant today, and provably in scope: strip the scope and the rule bites.
      expect(analyseTunnelDiscipline(route, source)).toBeNull();
      expect(analyseTunnelDiscipline(route, source.replace(/withOneShotTunnel/g, "somethingElse"))).not.toBeNull();
    }
  });

  test("every exemption names a file that exists", () => {
    // A stale exemption is a hole nobody can see. If a file moves, the entry must move
    // with it or be deleted.
    for (const file of Object.keys(EXEMPT)) {
      expect(fs.existsSync(path.join(process.cwd(), file))).toBe(true);
    }
  });
});
