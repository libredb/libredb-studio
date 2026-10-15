/**
 * Drift guards for `docs/GOVERNANCE.md`, the public half of governance contract v1
 * (docs/GOVERNANCE.md#conformance-files).
 *
 * The manifest is what a control plane's tests read; the document is what its engineers read. A name the manifest
 * publishes and the document never mentions is a part of the contract nobody explained, so every object, setting
 * key, code, heartbeat shape and conformance file the manifest lists must appear in the document. The document is
 * also written for any governance source, so it never names one particular product.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const DOC = read("docs/GOVERNANCE.md");
const ARCHITECTURE = read("docs/ARCHITECTURE.md");

interface Manifest {
  schema: string;
  conformanceFiles: string[];
  objects: { name: string }[];
  settings: { key: string }[];
  statements: { id: string }[];
  codes: { skip: string[]; envelope: string[]; api: { code: string }[] };
  listenerStates: string[];
  heartbeat: Record<string, unknown>;
  readiness: { examples: { status: string }[] };
  definitionAllowlist: { path: string }[];
  plaintext: { keys: string[] };
}
const MANIFEST = JSON.parse(read("tests/fixtures/governance/contract-v1.json")) as Manifest;

const named = (name: string): boolean => DOC.includes(`\`${name}\``);

describe("docs/GOVERNANCE.md", () => {
  test("docs/GOVERNANCE.md names every manifest object, setting key, skip code, heartbeat shape and conformance file and never names libredb-platform", () => {
    const missing = [
      ...MANIFEST.objects.map((object) => `${MANIFEST.schema}.${object.name}`).filter((name) => !DOC.includes(name)),
      ...MANIFEST.settings.map((setting) => setting.key).filter((key) => !named(key)),
      ...MANIFEST.codes.skip.filter((code) => !named(code)),
      ...Object.keys(MANIFEST.heartbeat).filter((shape) => !named(shape)),
      ...MANIFEST.conformanceFiles.filter((file) => !named(file)),
    ];
    expect(missing).toEqual([]);
    // Non-vacuity: eleven objects, eight keys, eight codes, three shapes and three files.
    expect(
      MANIFEST.objects.length +
        MANIFEST.settings.length +
        MANIFEST.codes.skip.length +
        Object.keys(MANIFEST.heartbeat).length +
        MANIFEST.conformanceFiles.length,
    ).toBe(33);
    // The control plane's database role is `libredb_platform`, a fixed name of the contract; the product is not named.
    expect(DOC).not.toMatch(/libredb[- ]platform/i);
  });

  test("it names every envelope code, API code, listener state, readiness status and definition key", () => {
    const missing = [
      ...MANIFEST.codes.envelope.filter((code) => !named(code)),
      ...MANIFEST.codes.api.map((entry) => entry.code).filter((code) => !named(code)),
      ...MANIFEST.listenerStates.filter((state) => !named(state)),
      ...MANIFEST.readiness.examples.map((example) => example.status).filter((status) => !named(status)),
      ...MANIFEST.definitionAllowlist.map((entry) => entry.path).filter((key) => !named(key)),
      ...MANIFEST.plaintext.keys.filter((key) => !named(key)),
    ];
    expect(missing).toEqual([]);
  });

  test("it speaks of a governance source and a control plane", () => {
    expect(DOC).toContain("governance source");
    expect(DOC).toContain("control plane");
  });

  test("docs/ARCHITECTURE.md links it and the link resolves", () => {
    const links = [...ARCHITECTURE.matchAll(/\]\(([^)]*GOVERNANCE\.md)\)/g)].map((match) => match[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(existsSync(path.join(ROOT, "docs", link))).toBe(true);
  });
});
