import { describe, it, expect } from "bun:test";
import {
  DISCOVERY_FILE_MAX_BYTES,
  type DiscoveredService,
  DiscoveryExportSchema,
  type ExporterStatus,
  parseDiscoveryExport,
} from "@/lib/seed/discovery-export";

const PG_SECRET = "pg-secret-value-7d1f";

function pgService(overrides: Record<string, unknown> = {}) {
  return {
    id: "ekvet0906pri",
    name: "pgtest",
    appName: "pgtest",
    host: "srv-captain--pgtest",
    image: "postgres:16",
    env: { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: PG_SECRET, POSTGRES_DB: "appdb" },
    requirepassEnv: null,
    tasks: { running: 1, desired: 1 },
    ...overrides,
  };
}

/** The example of spec section 8.5. */
function validExport(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    platform: "caprover",
    generatedAt: "2026-10-04T12:00:00.000Z",
    checkedAt: "2026-10-04T12:00:10.000Z",
    status: { ok: true },
    network: { name: "captain-overlay-network", id: "jolhlap6b0rctoqh21rk8sidt" },
    services: [pgService()],
    excluded: [],
    ...overrides,
  };
}

const parse = (value: unknown) => parseDiscoveryExport(JSON.stringify(value));

function reasonOf(result: ReturnType<typeof parseDiscoveryExport>): string {
  if (result.ok) throw new Error("expected the export to be refused");
  return result.reason;
}

describe("parseDiscoveryExport: valid files", () => {
  it("accepts the export of spec section 8.5", () => {
    const result = parse(validExport());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(1);
    expect(result.value.platform).toBe("caprover");
    expect(result.value.network).toEqual({ name: "captain-overlay-network", id: "jolhlap6b0rctoqh21rk8sidt" });
    expect(result.value.services).toEqual([pgService()]);
    expect(result.value.excluded).toEqual([]);
    const first: DiscoveredService | undefined = result.value.services[0];
    expect(first?.requirepassEnv).toBeNull();
  });

  it("validates the export of spec section 8.5 with DiscoveryExportSchema itself", () => {
    const result = DiscoveryExportSchema.safeParse(validExport());
    expect(result.success).toBe(true);
    expect(result.data?.excluded).toEqual([]);
  });

  it("narrows the status on its literal ok", () => {
    const result = parse(validExport({ status: { ok: false, code: "docker_error", message: "m" } }));
    if (!result.ok) throw new Error(result.reason);
    const status: ExporterStatus = result.value.status;
    // This compiles only while ok is a literal discriminant: with ok a plain boolean, message would be optional.
    const message: string | null = status.ok ? null : status.message;
    expect(message).toBe("m");
  });

  it("keeps the excluded app names as the exporter sorted them", () => {
    const result = parse(validExport({ excluded: ["redis1", "wordpress-db"] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.excluded).toEqual(["redis1", "wordpress-db"]);
  });

  it("accepts 500 excluded names of 63 characters each", () => {
    const excluded = Array.from({ length: 500 }, (_, i) => String(i).padStart(63, "e"));
    expect(parse(validExport({ excluded })).ok).toBe(true);
  });

  it("accepts generatedAt null with no services and an error status, the file before the first scan", () => {
    const result = parse(
      validExport({
        generatedAt: null,
        status: { ok: false, code: "socket_unavailable", message: "cannot open /var/run/docker.sock" },
        services: [],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.generatedAt).toBeNull();
    expect(result.value.services).toEqual([]);
  });

  it.each([
    "socket_unavailable",
    "swarm_unavailable",
    "api_version",
    "network_not_found",
    "docker_error",
    "limit_exceeded",
  ])("accepts the exporter status code %s", (code) => {
    const result = parse(validExport({ status: { ok: false, code, message: "m" } }));
    expect(result.ok).toBe(true);
  });

  it("accepts an error status with the daemon's HTTP status", () => {
    const status = {
      ok: false,
      code: "swarm_unavailable",
      httpStatus: 503,
      message: "This node is not a swarm manager.",
    } as const;
    const result = parse(validExport({ status }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toEqual(status);
  });

  it("accepts network null, the exporter's answer when no network matched exactly", () => {
    const result = parse(
      validExport({ network: null, status: { ok: false, code: "network_not_found", message: "m" } }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts exactly 500 services", () => {
    const services = Array.from({ length: 500 }, (_, i) => pgService({ id: `s${i}`, name: `a${i}`, appName: `a${i}` }));
    expect(parse(validExport({ services })).ok).toBe(true);
  });

  it("accepts every bound at its limit", () => {
    const service = pgService({
      name: "n".repeat(63),
      appName: "a".repeat(63),
      host: "h".repeat(253),
      image: "i".repeat(512),
      env: { POSTGRES_PASSWORD: "p".repeat(1024) },
      requirepassEnv: "REDIS_PASSWORD",
      tasks: { running: 0, desired: 0 },
    });
    expect(parse(validExport({ services: [service] })).ok).toBe(true);
  });

  /**
   * Review focus (Task 3): a service that is not a CapRover app can carry a host CapRover would never
   * produce. The file stays valid, so the other services survive; the mapping skips that one alone.
   */
  it.each(["My_Postgres", "UPPER-CASE", "under_score"])("keeps a file valid when a service host is %s", (host) => {
    const result = parse(
      validExport({ services: [pgService({ host }), pgService({ id: "two", host: "srv-captain--b" })] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.services.map((s) => s.host)).toEqual([host, "srv-captain--b"]);
  });

  it("drops every undeclared key, so the file cannot set roles, managed, mcp or a connection string", () => {
    const service = {
      ...pgService(),
      managed: false,
      roles: ["*"],
      mcp: true,
      readOnly: true,
      literal: false,
      connectionString: "postgres://attacker@example.com/x",
      command: ["redis-server", "--requirepass", "literal-secret"],
    };
    const result = parse({ ...validExport({ services: [service] }), roles: ["*"], extra: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value).sort()).toEqual(
      ["checkedAt", "excluded", "generatedAt", "network", "platform", "services", "status", "version"].sort(),
    );
    expect(Object.keys(result.value.services[0]).sort()).toEqual(
      ["appName", "env", "host", "id", "image", "name", "requirepassEnv", "tasks"].sort(),
    );
  });
});

describe("parseDiscoveryExport: invalid files", () => {
  it.each([
    ["version 2", { version: 2 }, "version"],
    ["version as a string", { version: "1" }, "version"],
    ["another platform", { platform: "dokploy" }, "platform"],
    ["checkedAt missing", { checkedAt: undefined }, "checkedAt"],
    ["checkedAt not an ISO time", { checkedAt: "yesterday" }, "checkedAt"],
    ["generatedAt not an ISO time", { generatedAt: "2026-10-04" }, "generatedAt"],
    ["generatedAt a number", { generatedAt: 1_780_000_000_000 }, "generatedAt"],
    ["status missing", { status: undefined }, "status"],
    ["status with an unknown code", { status: { ok: false, code: "exploded", message: "m" } }, "status"],
    ["status error without a message", { status: { ok: false, code: "docker_error" } }, "status"],
    [
      "status message over 512 characters",
      { status: { ok: false, code: "docker_error", message: "m".repeat(513) } },
      "status.message",
    ],
    [
      "status httpStatus not an integer",
      { status: { ok: false, code: "docker_error", httpStatus: 5.5, message: "m" } },
      "status",
    ],
    ["network without an id", { network: { name: "captain-overlay-network" } }, "network.id"],
    ["services not an array", { services: {} }, "services"],
    ["excluded missing", { excluded: undefined }, "excluded"],
    ["excluded not an array", { excluded: "wordpress-db" }, "excluded"],
    ["an empty excluded name", { excluded: [""] }, "excluded.0"],
    ["an excluded name that is not a string", { excluded: [42] }, "excluded.0"],
  ])("refuses %s", (_label, overrides, path) => {
    const reason = reasonOf(parse(validExport(overrides)));
    expect(reason).toStartWith(`the file does not match the export schema at ${path} (`);
  });

  it("names the field and the issue code", () => {
    expect(reasonOf(parse(validExport({ version: 2 })))).toBe(
      "the file does not match the export schema at version (invalid_value)",
    );
  });

  it("refuses more than 500 services", () => {
    const services = Array.from({ length: 501 }, (_, i) => pgService({ id: `s${i}`, name: `a${i}`, appName: `a${i}` }));
    expect(reasonOf(parse(validExport({ services })))).toStartWith(
      "the file does not match the export schema at services (too_big)",
    );
  });

  it("refuses an excluded name over 63 characters", () => {
    expect(reasonOf(parse(validExport({ excluded: ["e".repeat(64)] })))).toBe(
      "the file does not match the export schema at excluded.0 (too_big)",
    );
  });

  it("refuses more than 500 excluded names", () => {
    const excluded = Array.from({ length: 501 }, (_, i) => `app${i}`);
    expect(reasonOf(parse(validExport({ excluded })))).toBe(
      "the file does not match the export schema at excluded (too_big)",
    );
  });

  /**
   * The exporter's contract (Task 1, selectServices): a service whose image or appName is empty is left
   * out of the file and counted in droppedValues. A file that still carries one is refused whole.
   */
  it("refuses a file whose service has an empty image, even next to a valid service", () => {
    const file = validExport({
      services: [pgService({ image: "" }), pgService({ id: "two", name: "b", appName: "b", host: "srv-captain--b" })],
    });
    expect(reasonOf(parse(file))).toBe("the file does not match the export schema at services.0.image (too_small)");
  });

  it.each([
    ["an empty id", { id: "" }, "services.0.id"],
    ["an empty name", { name: "" }, "services.0.name"],
    ["an empty appName", { appName: "" }, "services.0.appName"],
    ["a name over 63 characters", { name: "n".repeat(64) }, "services.0.name"],
    ["an appName over 63 characters", { appName: "a".repeat(64) }, "services.0.appName"],
    ["an empty host", { host: "" }, "services.0.host"],
    ["a host over 253 characters", { host: "h".repeat(254) }, "services.0.host"],
    ["an image over 512 characters", { image: "i".repeat(513) }, "services.0.image"],
    ["env as an array", { env: ["POSTGRES_PASSWORD=x"] }, "services.0.env"],
    ["a requirepassEnv that is not an env var name", { requirepassEnv: "redis_password" }, "services.0.requirepassEnv"],
    ["requirepassEnv missing", { requirepassEnv: undefined }, "services.0.requirepassEnv"],
    ["negative running tasks", { tasks: { running: -1, desired: 1 } }, "services.0.tasks.running"],
    ["fractional desired tasks", { tasks: { running: 1, desired: 1.5 } }, "services.0.tasks.desired"],
  ])("refuses a service with %s", (_label, overrides, path) => {
    const reason = reasonOf(parse(validExport({ services: [pgService(overrides)] })));
    expect(reason).toStartWith(`the file does not match the export schema at ${path} (`);
  });

  it("refuses services listed while generatedAt is null", () => {
    const file = validExport({ generatedAt: null, status: { ok: false, code: "docker_error", message: "m" } });
    expect(reasonOf(parse(file))).toBe("the file does not match the export schema at services (custom)");
  });

  it("refuses excluded names listed while generatedAt is null", () => {
    const file = validExport({
      generatedAt: null,
      status: { ok: false, code: "docker_error", message: "m" },
      services: [],
      excluded: ["wordpress-db"],
    });
    expect(reasonOf(parse(file))).toBe("the file does not match the export schema at excluded (custom)");
  });

  it("refuses an ok status while generatedAt is null", () => {
    const file = validExport({ generatedAt: null, services: [] });
    expect(reasonOf(parse(file))).toBe("the file does not match the export schema at status (custom)");
  });

  it("reports how many more issues there are after the first", () => {
    const reason = reasonOf(parse(validExport({ version: 2, platform: "x", checkedAt: "x" })));
    expect(reason).toBe("the file does not match the export schema at version (invalid_value) (and 2 more)");
  });

  it.each([
    ["an array", "[]"],
    ["a number", "42"],
    ["null", "null"],
  ])("refuses %s at the top level", (_label, raw) => {
    expect(reasonOf(parseDiscoveryExport(raw))).toStartWith(
      "the file does not match the export schema at the top level (",
    );
  });

  it("refuses text that is not JSON without quoting it", () => {
    const raw = `{"services": [{"env": {"POSTGRES_PASSWORD": "${PG_SECRET}"`;
    const reason = reasonOf(parseDiscoveryExport(raw));
    expect(reason).toBe("the file is not valid JSON");
  });

  it("refuses a half-written file: the first 100 bytes of a valid one", () => {
    const raw = JSON.stringify(validExport()).slice(0, 100);
    expect(reasonOf(parseDiscoveryExport(raw))).toBe("the file is not valid JSON");
  });

  it("refuses an empty file", () => {
    expect(reasonOf(parseDiscoveryExport(""))).toBe("the file is not valid JSON");
  });

  it("never quotes an env key or value in a refusal", () => {
    const service = pgService({ env: { LEAKED_KEY_NAME: `${PG_SECRET}${"x".repeat(1024)}` } });
    const reason = reasonOf(parse(validExport({ services: [service] })));
    expect(reason).toBe("the file does not match the export schema at services.0.env (too_big)");
    expect(reason).not.toContain("LEAKED_KEY_NAME");
    expect(reason).not.toContain(PG_SECRET);
  });

  it("refuses a non-string env value at the env record, not at its key", () => {
    const service = pgService({ env: { POSTGRES_PASSWORD: 12345 } });
    expect(reasonOf(parse(validExport({ services: [service] })))).toBe(
      "the file does not match the export schema at services.0.env (invalid_type)",
    );
  });
});

describe("parseDiscoveryExport: size cap", () => {
  it("is two MiB", () => {
    expect(DISCOVERY_FILE_MAX_BYTES).toBe(2_097_152);
  });

  it("accepts a valid file of exactly the cap", () => {
    const json = JSON.stringify(validExport());
    const raw = json + " ".repeat(DISCOVERY_FILE_MAX_BYTES - json.length);
    expect(Buffer.byteLength(raw, "utf8")).toBe(DISCOVERY_FILE_MAX_BYTES);
    expect(parseDiscoveryExport(raw).ok).toBe(true);
  });

  it("refuses one byte over the cap before parsing it", () => {
    const json = JSON.stringify(validExport());
    const raw = json + " ".repeat(DISCOVERY_FILE_MAX_BYTES - json.length + 1);
    expect(reasonOf(parseDiscoveryExport(raw))).toBe("the file is 2097153 bytes, over the 2097152-byte limit");
  });

  it("measures bytes, not characters", () => {
    const json = JSON.stringify(validExport());
    // One two-byte character keeps the length in characters at the cap and puts the byte count one over.
    const raw = json + " ".repeat(DISCOVERY_FILE_MAX_BYTES - json.length - 1) + String.fromCharCode(0xe9);
    expect(raw.length).toBe(DISCOVERY_FILE_MAX_BYTES);
    expect(reasonOf(parseDiscoveryExport(raw))).toBe("the file is 2097153 bytes, over the 2097152-byte limit");
  });
});
