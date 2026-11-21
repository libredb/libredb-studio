/**
 * The built-in LibreDB sample, through the sample service: its enablement, which follows LIBREDB_ENABLED_PROVIDERS
 * like every sample, and a copy of its committed asset as the engine opens it.
 */
import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { open, catalog, kv } from "@libredb/libredb";
import { copySampleAsset } from "@/lib/seed/sample-copy";
import { SAMPLES, sampleAssetPath, sampleEnabled, type SampleSpec } from "@/lib/seed/samples";

const ROOT = path.resolve(import.meta.dir, "../../..");
const tmpDirs: string[] = [];

function libredbRow(): SampleSpec {
  const spec = SAMPLES.get("libredb");
  if (spec === undefined) throw new Error("no LibreDB sample row");
  return spec;
}

const enabled = (): boolean => sampleEnabled("libredb", libredbRow());

function tmpPath(): string {
  // mkdtempSync atomically creates a unique 0700 dir — the secure-temp pattern
  // (avoids the predictable-name race CodeQL flags for os.tmpdir + Math.random).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libredb-sample-"));
  tmpDirs.push(dir);
  return path.join(dir, "sample.libredb");
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.LIBREDB_EMBEDDED_SAMPLE;
  delete process.env.GOVERNANCE_SOURCE;
  delete process.env.KUBERNETES_ACCESS_REVIEW;
  delete process.env.LIBREDB_ENABLED_PROVIDERS;
  delete process.env.SEED_ASSETS_DIR;
});

describe("the LibreDB sample", () => {
  test('enabled by default; only "false" disables', () => {
    expect(enabled()).toBe(true);
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    expect(enabled()).toBe(false);
    process.env.LIBREDB_EMBEDDED_SAMPLE = "true";
    expect(enabled()).toBe(true);
  });

  test("under governance it is off although LIBREDB_EMBEDDED_SAMPLE is true", () => {
    process.env.LIBREDB_EMBEDDED_SAMPLE = "true";
    process.env.GOVERNANCE_SOURCE = "postgres";
    expect(enabled()).toBe(false);
    delete process.env.LIBREDB_EMBEDDED_SAMPLE;
    expect(enabled()).toBe(false);
  });

  // With the Kubernetes access review on (Rancher mode), the sample is not offered unless LIBREDB_EMBEDDED_SAMPLE is
  // exactly "true": every signed-in person would see it, and no review gates it, since it names no Secret.
  test("with the access review on it is off unless LIBREDB_EMBEDDED_SAMPLE is exactly true", () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "on";
    expect(enabled()).toBe(false);
    process.env.LIBREDB_EMBEDDED_SAMPLE = "";
    expect(enabled()).toBe(false);
    process.env.LIBREDB_EMBEDDED_SAMPLE = "TRUE";
    expect(enabled()).toBe(false);
    process.env.LIBREDB_EMBEDDED_SAMPLE = "false";
    expect(enabled()).toBe(false);
    process.env.LIBREDB_EMBEDDED_SAMPLE = "true";
    expect(enabled()).toBe(true);
    // A switch value Studio does not know counts as on, so the sample stays off.
    delete process.env.LIBREDB_EMBEDDED_SAMPLE;
    process.env.KUBERNETES_ACCESS_REVIEW = "maybe";
    expect(enabled()).toBe(false);
    // Switched off, the default is on again.
    process.env.KUBERNETES_ACCESS_REVIEW = "off";
    expect(enabled()).toBe(true);
  });

  test("governance wins over an explicit true with the access review on", () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "on";
    process.env.LIBREDB_EMBEDDED_SAMPLE = "true";
    process.env.GOVERNANCE_SOURCE = "postgres";
    expect(enabled()).toBe(false);
  });

  // The factory refuses every open of a type LIBREDB_ENABLED_PROVIDERS leaves out, so the sample is off then (D473).
  test("it is off when LIBREDB_ENABLED_PROVIDERS leaves out libredb or is refused as a whole", () => {
    process.env.LIBREDB_ENABLED_PROVIDERS = "sqlite";
    expect(enabled()).toBe(false);
    process.env.LIBREDB_ENABLED_PROVIDERS = "sqlite, libredb";
    expect(enabled()).toBe(true);
    process.env.LIBREDB_ENABLED_PROVIDERS = "libredb,postgresql";
    expect(enabled()).toBe(false);
    process.env.LIBREDB_ENABLED_PROVIDERS = " , ,";
    expect(enabled()).toBe(false);
    process.env.LIBREDB_ENABLED_PROVIDERS = "  ";
    expect(enabled()).toBe(true);
  });

  test("the copy opens with all three lenses, and leaves no lock beside it once closed", async () => {
    const spec = libredbRow();
    process.env.SEED_ASSETS_DIR = path.join(ROOT, "seed-assets");
    const file = tmpPath();
    expect(await copySampleAsset({ asset: sampleAssetPath(spec), sha256: spec.sha256, bytes: spec.bytes }, file)).toBe(
      "copied",
    );
    expect(fs.readdirSync(path.dirname(file))).toEqual(["sample.libredb"]);

    const db = open({ path: file });
    try {
      const reg = catalog(db);
      expect(reg.get("users")?.kind).toBe("relational");
      expect(reg.get("articles")?.kind).toBe("document");
      expect(
        kv(db)
          .prefix("config:")
          .toArray()
          .map((e) => e.key),
      ).toEqual(["config:locale", "config:theme"]);
    } finally {
      db.close();
    }
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });
});
