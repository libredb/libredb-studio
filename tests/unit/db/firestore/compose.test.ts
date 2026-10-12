/**
 * The Firestore emulator fixture of database-compose.yml: the official Cloud SDK emulators image pinned by tag and
 * digest, published on loopback only, and a one-shot seeder on the same image that writes docker/firestore/seed.json
 * over REST. The seed set's own properties are pinned by tests/unit/db/firestore/evidence-plan.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

interface Service {
  readonly image?: string;
  readonly command?: unknown;
  readonly entrypoint?: unknown;
  readonly ports?: readonly string[];
  readonly restart?: string;
  readonly volumes?: readonly string[];
  readonly profiles?: readonly string[];
  readonly depends_on?: Readonly<Record<string, { readonly condition: string }>>;
  readonly healthcheck?: { readonly test?: unknown };
  readonly deploy?: { readonly resources?: { readonly limits?: { readonly cpus?: string; readonly memory?: string } } };
  readonly memswap_limit?: string;
}

const compose = parseYaml(read("database-compose.yml")) as { services: Record<string, Service> };
const seed = JSON.parse(read("docker/firestore/seed.json")) as { project: string; documents: unknown[] };
const IMAGE =
  "gcr.io/google.com/cloudsdktool/google-cloud-cli:587.0.0-emulators@sha256:8d8573471c489a409f03891d2c24d177fa531276184f7002b9a2d853d1b3ed54";

describe("the firestore service", () => {
  const service = compose.services.firestore;

  test("runs the official emulators image, pinned by tag and by digest", () => {
    expect(service?.image).toBe(IMAGE);
  });

  test("starts the Firestore emulator on 0.0.0.0:8080 under the demo- project the seed writes", () => {
    expect(service?.command).toEqual([
      "gcloud",
      "emulators",
      "firestore",
      "start",
      "--host-port=0.0.0.0:8080",
      `--project=${seed.project}`,
    ]);
    expect(seed.project).toBe("demo-libredb");
  });

  test("publishes on loopback only, on host port 8380, because Trino holds host port 8080", () => {
    expect(service?.ports).toEqual(["127.0.0.1:8380:8080"]);
    expect(compose.services.trino?.ports).toContain("8080:8080");
  });

  test("is healthy when the emulator answers its root, and starts on a plain docker compose up", () => {
    expect(service?.healthcheck?.test).toEqual(["CMD", "curl", "-fsS", "http://127.0.0.1:8080/"]);
    expect(service?.profiles).toBeUndefined();
  });

  test("is bounded, with no swap past the bound", () => {
    expect(service?.deploy?.resources?.limits).toEqual({ cpus: "2", memory: "2G" });
    expect(service?.memswap_limit).toBe("2G");
  });
});

describe("the firestore-seed one-shot", () => {
  const seeder = compose.services["firestore-seed"];

  test("runs once, on the same image, after the emulator is healthy", () => {
    expect(seeder?.image).toBe(IMAGE);
    expect(seeder?.restart).toBe("no");
    expect(seeder?.depends_on).toEqual({ firestore: { condition: "service_healthy" } });
  });

  test("mounts the seed read-only and runs seed.py against the service by name", () => {
    expect(seeder?.volumes).toEqual(["./docker/firestore:/seed:ro"]);
    expect(seeder?.entrypoint).toEqual(["python3", "/seed/seed.py"]);
    expect(seeder?.command).toEqual(["--host", "firestore:8080"]);
    expect(seeder?.deploy?.resources?.limits).toEqual({ cpus: "1", memory: "256M" });
  });
});

describe("seed.py", () => {
  const script = read("docker/firestore/seed.py");

  test("imports the standard library only, so the image needs nothing installed", () => {
    const imports = [...script.matchAll(/^(?:import|from) ([\w.]+)/gm)].map((match) => match[1]).sort();
    expect(imports).toEqual(["argparse", "json", "sys", "time", "urllib.error", "urllib.request"]);
  });

  test("writes every document in one commit whose body names each document, never an id in a URL path", () => {
    expect(script).toContain(":commit");
    expect(script).toContain('"update": {"name": f"{root}/{doc[\'path\']}"');
    expect(script).toContain('"authorization": "Bearer owner"');
  });

  test("the seed set it writes holds documents", () => {
    expect(seed.documents.length).toBe(21);
  });
});
