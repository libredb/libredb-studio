/**
 * Unit tests for the elkjs section of THIRD_PARTY_NOTICES.txt (issue #1292).
 *
 * elkjs is taken under EPL-2.0 and bundled unmodified into the web client's
 * chunks, which carry no license header. THIRD_PARTY_NOTICES.txt already
 * travels at the root of every image and payload, so the EPL-2.0 text and the
 * source location travel there. The section is generated from the installed
 * package, and these tests fail when the committed file no longer matches it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderElkjsNotice, replaceElkjsSection } from "../../scripts/generate-elkjs-notice.mjs";

const ROOT = join(import.meta.dir, "..", "..");
const readRepoFile = (path: string) => readFileSync(join(ROOT, path), "utf8");
const installed = JSON.parse(readRepoFile("node_modules/elkjs/package.json")) as { version: string };

describe("elkjs notice", () => {
  test("the committed notices end with the section generated from the installed elkjs", () => {
    const notices = readRepoFile("THIRD_PARTY_NOTICES.txt");

    expect(notices.endsWith(renderElkjsNotice(ROOT))).toBe(true);
  });

  test("the section names the version, the EPL-2.0 choice, the source and the license text", () => {
    const section = renderElkjsNotice(ROOT);

    expect(section).toContain(`elkjs ${installed.version} (https://github.com/kieler/elkjs)`);
    expect(section).toContain(
      "License: EPL-2.0 (offered as EPL-2.0 OR GPL-3.0-or-later; distributed here under EPL-2.0)",
    );
    expect(section).toContain(`https://github.com/kieler/elkjs/tree/${installed.version}`);
    expect(section).toContain("https://github.com/eclipse-elk/elk");
    expect(section).toContain(readRepoFile("node_modules/elkjs/LICENSE.md").replace(/\r$/gm, ""));
  });

  test("replacing the section appends it once and is idempotent", () => {
    const head = "THIRD-PARTY NOTICES\n\nother notices\n";
    const section = renderElkjsNotice(ROOT);
    const once = replaceElkjsSection(head, section);

    expect(once).toBe(`${head}\n${section}`);
    expect(replaceElkjsSection(once, section)).toBe(once);
    expect(replaceElkjsSection(once.replace(installed.version, "0.0.1"), section)).toBe(once);
  });

  test("a full regeneration of the notices file writes the elkjs section too", () => {
    const db2 = readRepoFile("scripts/generate-db2-node-notices.sh");

    expect(db2).toContain('node "$(dirname "$0")/generate-elkjs-notice.mjs" "$OUT"');
  });

  test("docs/THIRD_PARTY_LICENSES.md says where the EPL-2.0 text travels", () => {
    const doc = readRepoFile("docs/THIRD_PARTY_LICENSES.md");

    expect(doc).toContain("scripts/generate-elkjs-notice.mjs");
  });
});
