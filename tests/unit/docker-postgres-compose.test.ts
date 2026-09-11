/**
 * Drift guard for the development PostgreSQL compose files (#792).
 *
 * `docker/postgres.yml` ran `postgres:18` with the data volume mounted at
 * `/var/lib/postgresql/data`, the pre-18 path. The 18 image moved the expected
 * mount to `/var/lib/postgresql` (the data dir is a PGDATA subdirectory of it),
 * so the documented `docker compose -f docker/postgres.yml up -d` restart-looped
 * on a fresh volume and nobody could bring up the repo's only engine seed.
 * Reproduced against a live daemon on 2026-09-11: the container emits
 * "The suggested container configuration for 18+ is to place a single mount at
 * /var/lib/postgresql" and enters `Restarting (1)`.
 *
 * The same file also hardcoded `container_name: libredb-postgres` and
 * `5432:5432` — identical to `database-compose.yml`'s postgres service — so the
 * two files could never run side by side, and `database-compose.yml` mounted no
 * init scripts at all, so the two disagreed about what a development
 * PostgreSQL is.
 *
 * These assertions pin the fixed shape structurally (parsed YAML, not text
 * greps) so a future edit that reintroduces any of the three defects fails here
 * rather than in someone's `docker compose up`.
 */

import { describe, test, expect } from "bun:test";
import { parse as parseYaml } from "yaml";

type ComposeService = {
  image?: string;
  container_name?: string;
  ports?: string[];
  volumes?: string[];
};

type ComposeFile = {
  services: Record<string, ComposeService>;
  volumes?: Record<string, { name?: string } | null>;
};

async function load(path: string): Promise<ComposeFile> {
  return parseYaml(await Bun.file(path).text()) as ComposeFile;
}

/** The host-side spec of the first port mapping of a service. Split on the LAST
 * colon: the compose default-value syntax `${VAR:-5432}` itself contains one. */
function publishedPort(service: ComposeService): string {
  const first = service.ports?.[0];
  expect(first).toBeString();
  const spec = first as string;
  return spec.slice(0, spec.lastIndexOf(":"));
}

describe("docker/postgres.yml (#792)", () => {
  const file = load("docker/postgres.yml");

  test("mounts the data volume at the postgres:18 expected path, not the pre-18 one", async () => {
    const postgres = (await file).services.postgres;
    expect(postgres.image).toBe("postgres:18");
    const dataMounts = (postgres.volumes ?? []).filter((v) => v.includes("/var/lib/postgresql"));
    expect(dataMounts.length).toBe(1);
    // The 18 image refuses /var/lib/postgresql/data as a mount root: it restart-loops.
    expect(dataMounts[0]).toContain(":/var/lib/postgresql");
    expect(dataMounts[0]).not.toContain("/var/lib/postgresql/data");
  });

  test("applies the seed scripts in docker/postgres-init on first run", async () => {
    const postgres = (await file).services.postgres;
    expect(postgres.volumes ?? []).toContain("./postgres-init:/docker-entrypoint-initdb.d:ro");
  });

  test("parameterises container name, host port and volume name with today's values as defaults", async () => {
    const postgres = (await file).services.postgres;
    // Defaults keep the documented zero-config command working unchanged...
    expect(postgres.container_name).toBe("${LIBREDB_CONTAINER_PREFIX:-libredb}-postgres");
    expect(publishedPort(postgres)).toBe("${LIBREDB_POSTGRES_HOST_PORT:-5432}");
    // ...while the prefix lets a contributor run this file next to their own
    // PostgreSQL, or next to database-compose.yml, without a name collision.
    const volumeName = (await file).volumes?.postgres_data?.name;
    expect(volumeName).toBe("${LIBREDB_CONTAINER_PREFIX:-libredb}_postgres_data");
  });
});

describe("database-compose.yml postgres service (#792)", () => {
  const file = load("database-compose.yml");

  test("applies the same seed scripts docker/postgres.yml does", async () => {
    const postgres = (await file).services.postgres;
    expect(postgres.image).toBe("postgres:18");
    expect(postgres.volumes ?? []).toContain("./docker/postgres-init:/docker-entrypoint-initdb.d:ro");
    // Its whole data story: no persistent volume at all (the fixture restarts
    // stateless), so the init mount is its only one and the seed applies on
    // every first-init — README's sample-data section now says so for this file
    // too. Pin the absence so a future edit does not half-mount a data volume
    // and silently make the seed first-run-only here.
    expect((postgres.volumes ?? []).length).toBe(1);
  });

  test("the three files move together under one override (collision at defaults is by design)", async () => {
    const postgres = (await file).services.postgres;
    const standalone = (await load("docker/postgres.yml")).services.postgres;
    const root = (await load("docker-compose.yml")).services["libredb-postgres"];
    // All three resolve to the SAME container name and host port at their
    // defaults — that collision is #792's own design choice, recorded in
    // docs/providers/README.md, not a defect this test hides. What it guards
    // is the coupling: ONE pair of overrides now separates all three fleets
    // together; if anyone diverges one file's template, an override that looks
    // global stops being one.
    expect(postgres.container_name).toBe(standalone.container_name);
    expect(publishedPort(postgres)).toBe(publishedPort(standalone));
    expect(root.container_name).toBe(standalone.container_name);
    expect(publishedPort(root)).toBe(publishedPort(standalone));
  });
});

describe("docker-compose.yml libredb-postgres service (#792, same defect)", () => {
  test("mounts the data volume at the postgres:18 expected path", async () => {
    // The storage-backend Postgres at the repo root is active (not commented) and
    // ran the identical image-plus-path pair; measured on a live daemon, the 18
    // image exits on the old path exactly as docker/postgres.yml did.
    const root = (await load("docker-compose.yml")) as ComposeFile & {
      services: Record<string, ComposeService>;
    };
    const postgres = root.services["libredb-postgres"];
    expect(postgres.image).toBe("postgres:18");
    const dataMounts = (postgres.volumes ?? []).filter((v) => v.includes("/var/lib/postgresql"));
    expect(dataMounts.length).toBe(1);
    expect(dataMounts[0]).toContain(":/var/lib/postgresql");
    expect(dataMounts[0]).not.toContain("/var/lib/postgresql/data");
  });
});
