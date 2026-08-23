import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/**
 * Threat: a route that records an audit event in the ring buffer WITHOUT the authoritative
 * `libredb.audit.v1` stdout line. `src/lib/audit.ts` exports both `emitAuditEvent` (buffer AND
 * stdout) and `getServerAuditBuffer` (buffer only), and an event pushed straight to the buffer is
 * visible in the admin UI, invisible to every log pipeline, and caught by no other test - the
 * existing audit tests pin the CONTENT of the stdout line, never the set of call sites permitted
 * to skip it (B/K1).
 *
 * The inversion is the one `tests/security/route-auth.test.ts` applied to route discovery, for the
 * same reason: a hand-curated inventory of "the places that do X" had already lost eleven routes,
 * so this enumerates what is on disk and requires a commented reason for every exemption. A new
 * buffer-only call site is red by default instead of invisible by default.
 *
 * It also does not reproduce that test's own recorded weakness (H10): an allowlist entry here is
 * not satisfied by the file merely existing. Each entry carries the number of push sites it is
 * allowed to have, and the two `reason still true` tests below re-check the substance of both
 * reasons against the current source - audit.ts's push is still the one paired with the stdout
 * write, and the admin route still sanitizes and still has no access to the stdout channel.
 */

const SRC_DIR = join(import.meta.dir, "..", "..", "src");

interface AuditBufferUse {
  /** Times `getServerAuditBuffer` is named at all - the capability, however it is later used. */
  references: number;
  /** Times a buffer obtained from it is pushed to, directly or through a local binding. */
  pushes: number;
}

/**
 * Finds every file under `rootDir` that obtains the server audit buffer, and counts how often it
 * pushes to it. Both spellings are counted, because the two real call sites use one each and a
 * regex for only the direct form would find zero of the two that matter:
 *   - direct:   `getServerAuditBuffer().push(...)`            (src/lib/audit.ts)
 *   - indirect: `const buffer = getServerAuditBuffer(); ... buffer.push(...)`  (the admin route)
 * A file that holds the buffer but never pushes (a reader) reports 0 pushes and is not required
 * to be allowlisted - reading the buffer grants no authority over the audit channel.
 */
/** Every .ts/.tsx file under `rootDir`, as paths relative to it. */
function listSources(rootDir: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        files.push(relative(rootDir, full));
      }
    }
  }

  walk(rootDir);
  // A walk bug that silently visits nothing would make every enumeration below vacuously pass.
  if (files.length === 0) throw new Error(`no TypeScript sources found under ${rootDir}`);
  return files;
}

/**
 * Finds every file under `rootDir` that obtains the server audit buffer, and counts how often it
 * pushes to it. Both spellings are counted, because the two real call sites use one each and a
 * regex for only the direct form would find zero of the two that matter:
 *   - direct:   `getServerAuditBuffer().push(...)`            (src/lib/audit.ts)
 *   - indirect: `const buffer = getServerAuditBuffer(); ... buffer.push(...)`  (the admin route)
 * A file that holds the buffer but never pushes (a reader) reports 0 pushes and is not required
 * to be allowlisted - reading the buffer grants no authority over the audit channel.
 */
function findAuditBufferUses(rootDir: string): Map<string, AuditBufferUse> {
  const uses = new Map<string, AuditBufferUse>();

  for (const file of listSources(rootDir)) {
    const source = readFileSync(join(rootDir, file), "utf8");
    const references = source.split("getServerAuditBuffer").length - 1;
    if (references === 0) continue;

    let pushes = (source.match(/getServerAuditBuffer\([^()]*\)\s*\.push\s*\(/g) ?? []).length;
    // Locals bound to the buffer, so `const buffer = getServerAuditBuffer()` followed by a later
    // `buffer.push(` counts as the same call site it plainly is. The names are deduped first: the
    // admin audit route binds the SAME name `buffer` in both GET and POST, and counting per
    // binding double-counted its single push (measured, not hypothetical).
    const boundNames = new Set(
      [...source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*getServerAuditBuffer\(/g)].map((m) => m[1]),
    );
    for (const name of boundNames) {
      pushes += (source.match(new RegExp(`\\b${name}\\s*\\.push\\s*\\(`, "g")) ?? []).length;
    }
    uses.set(file, { references, pushes });
  }

  return uses;
}

/**
 * Every file allowed to push an event into the audit ring buffer without also writing the
 * authoritative stdout line, with the exact number of push sites it may have. Anything else is a
 * bug: use `emitAuditEvent`.
 */
const BUFFER_PUSH_ALLOWLIST: Record<string, { pushes: number; reason: string }> = {
  "lib/audit.ts": {
    pushes: 1,
    reason:
      "the module that owns both destinations: its single push is emitAuditEvent's own, immediately followed by the stdout line, so it IS the authoritative channel rather than a bypass of it",
  },
  "app/api/admin/audit/route.ts": {
    pushes: 1,
    reason:
      "display-only passthrough: its body is fully client-supplied and none of type/result/reason is validated at runtime, so it must never gain the authority to write the stdout channel - it sanitizes with sanitizeAuditInput and pushes to the buffer the admin UI reads, nothing more",
  },
};

const REAL_USES = findAuditBufferUses(SRC_DIR);

describe("the authoritative audit channel has no unlisted bypass", () => {
  // Non-vacuity for the real scan: today two files push to the buffer (src/lib/audit.ts and the
  // admin audit route). If this drops to zero the enumeration below proves nothing.
  test("the scan finds today's buffer push sites", () => {
    const pushers = [...REAL_USES].filter(([, use]) => use.pushes > 0);
    expect(pushers.length).toBeGreaterThanOrEqual(2);
  });

  test("every file pushing to the audit buffer is allowlisted, with the recorded push count", () => {
    for (const [file, use] of REAL_USES) {
      if (use.pushes === 0) continue;
      const entry = BUFFER_PUSH_ALLOWLIST[file];
      if (!entry) {
        throw new Error(
          `${file} pushes to the audit ring buffer ${use.pushes}x without writing the libredb.audit.v1 stdout line. ` +
            `Use emitAuditEvent, or add an allowlist entry with a reason in tests/security/audit-channel-callsites.test.ts.`,
        );
      }
      expect(use.pushes).toBe(entry.pushes);
    }
  });

  // Two ways a bypass could dodge the enumeration above without ever touching the allowlist: build
  // its own ring buffer, or rename the accessor on import so neither the direct nor the bound-name
  // pattern matches. Both are cheap to forbid outright, so they are.
  test("no file outside src/lib/audit.ts builds its own buffer or renames the accessor", () => {
    for (const file of listSources(SRC_DIR)) {
      if (file === join("lib", "audit.ts")) continue;
      const source = readFileSync(join(SRC_DIR, file), "utf8");
      expect(source).not.toMatch(/new\s+AuditRingBuffer\s*\(/);
      expect(source).not.toMatch(/getServerAuditBuffer\s+as\s+/);
    }
  });

  test("every allowlist entry still names a file that still pushes", () => {
    for (const [file, entry] of Object.entries(BUFFER_PUSH_ALLOWLIST)) {
      expect(REAL_USES.get(file)?.pushes).toBe(entry.pushes);
    }
  });
});

describe("each allowlisted reason is still true", () => {
  test("audit.ts's push is the one paired with the stdout line", () => {
    const source = readFileSync(join(SRC_DIR, "lib", "audit.ts"), "utf8");
    const at = source.search(/getServerAuditBuffer\([^()]*\)\s*\.push\s*\(/);
    expect(at).toBeGreaterThan(-1);
    // The stdout write must follow the push in the same function, not merely exist somewhere in
    // the file: that adjacency is the whole reason this call site is not a bypass.
    expect(source.slice(at, at + 600)).toContain("console.log(JSON.stringify(toAuditLine(");
  });

  test("the admin audit route still sanitizes and still cannot reach the stdout channel", () => {
    const source = readFileSync(join(SRC_DIR, "app", "api", "admin", "audit", "route.ts"), "utf8");

    // Its exemption is only defensible while the event it pushes goes through the shared
    // sanitizer, and while it never imports the emitter that writes stdout. Asserted against the
    // import clause rather than the whole file: the route's own comment says the words
    // "NOT emitAuditEvent", so a bare substring check on the source can never be true.
    expect(source).toContain("buffer.push(");
    expect(source).toContain("sanitizeAuditInput({");
    const auditImport = source.match(/import\s*\{([^}]*)\}\s*from\s*"@\/lib\/audit"/);
    expect(auditImport).not.toBeNull();
    expect((auditImport as RegExpMatchArray)[1]).not.toContain("emitAuditEvent");
  });
});

// ─── The detector itself, proven against synthetic sources ───────────────────────────────────
//
// The enumeration above can only fail if this function actually recognises a bypass, and the real
// tree (correctly) contains no unlisted one to prove that with. These cases are the proof: each
// shape a bypass can take is written to a temp tree and asserted to be found.

const fixtureRoot = mkdtempSync(join(tmpdir(), "audit-callsites-"));

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function fixture(name: string, files: Record<string, string>): string {
  const dir = join(fixtureRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const full = join(dir, file);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe("findAuditBufferUses", () => {
  test("catches a direct getServerAuditBuffer().push(...)", () => {
    const dir = fixture("direct", {
      "app/api/rogue/route.ts": `import { getServerAuditBuffer } from "@/lib/audit";\n
export async function POST() {\n  getServerAuditBuffer().push({ type: "logout" });\n}\n`,
    });

    expect(findAuditBufferUses(dir).get("app/api/rogue/route.ts")).toEqual({ references: 2, pushes: 1 });
  });

  test("catches a push through a local binding in a nested directory", () => {
    const dir = fixture("indirect", {
      "app/api/deep/nested/route.ts": `import { getServerAuditBuffer } from "@/lib/audit";\n
export async function POST() {\n  const buffer = getServerAuditBuffer();\n  buffer.push({ type: "logout" });\n  buffer.push({ type: "logout" });\n}\n`,
    });

    expect(findAuditBufferUses(dir).get("app/api/deep/nested/route.ts")).toEqual({ references: 2, pushes: 2 });
  });

  test("does not flag a file that only reads the buffer", () => {
    const dir = fixture("reader", {
      "app/api/reader/route.tsx": `import { getServerAuditBuffer } from "@/lib/audit";\n
export async function GET() {\n  return Response.json(getServerAuditBuffer().getRecent(10));\n}\n`,
    });

    expect(findAuditBufferUses(dir).get("app/api/reader/route.tsx")?.pushes).toBe(0);
  });

  test("ignores files that never name the buffer, and non-TypeScript files", () => {
    const dir = fixture("ignored", {
      "lib/plain.ts": `export const events: string[] = [];\nevents.push("nope");\n`,
      "notes.md": `getServerAuditBuffer().push({})\n`,
    });

    expect(findAuditBufferUses(dir).size).toBe(0);
  });

  // The two negative assertions in "no file ... builds its own buffer or renames the accessor"
  // pass today because nothing in src/ has those shapes - which is exactly the state in which a
  // typo'd pattern would also pass. These two lines are what prove the patterns still match.
  test("the forbidden-shape patterns match the shapes they forbid", () => {
    expect("  const own = new AuditRingBuffer(50);").toMatch(/new\s+AuditRingBuffer\s*\(/);
    expect('import { getServerAuditBuffer as gb } from "@/lib/audit";').toMatch(/getServerAuditBuffer\s+as\s+/);
  });

  test("throws rather than silently passing when the walk finds no sources", () => {
    const dir = fixture("empty", { "notes.md": "nothing here\n" });

    expect(() => findAuditBufferUses(dir)).toThrow(/no TypeScript sources/);
  });
});
