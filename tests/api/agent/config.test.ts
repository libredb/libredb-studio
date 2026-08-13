/**
 * The agent capability probe (#329 T10a; derived availability #331 T5): what the
 * browser is allowed to know about whether this server runs agents.
 *
 * The rail cannot read the server's configuration — `LIBREDB_AGENT_ENABLED` and the
 * `LLM_*` keys are server-side only, and the standalone pages are statically
 * prerendered, so baking an answer into the bundle at build time would answer for
 * the build rather than for the operator's running container. Discovery is therefore
 * a request, the same shape the storage mode already uses (`/api/storage/config`,
 * `src/hooks/use-storage-sync.ts:184`), with one deliberate difference: this one
 * requires a session, because T9 pinned that an unauthenticated caller may not learn
 * whether an agent surface exists here.
 *
 * Since T5 the answer is DERIVED rather than read off a flag, so this route is also
 * the only place that reports WHICH condition is missing. Two properties are load
 * bearing and pinned below: `enabled` stays a literal boolean, because
 * `use-agent-capability.ts` reads `body.enabled === true` and anything else makes the
 * rail silently disappear; and no misconfiguration may turn the probe into a 500,
 * because a 500 is indistinguishable from "this server runs no agents", which is the
 * state the operator would be trying to diagnose.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AGENT_ENABLED_ENV, AGENT_WORLD_TARGET_ENV } from "@/lib/agent/config";
import * as realAuth from "@/lib/auth";
import { parseResponseJSON } from "../../helpers/mock-next";

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "ada" }),
);

// Spread over the real module: a partial replacement stays installed process-wide
// and breaks the next file that imports an export this one forgot (T9's lesson).
function installMocks(): void {
  mock.module("@/lib/auth", () => ({ ...realAuth, getSession: mockGetSession }));
}

installMocks();

const { GET } = await import("@/app/api/agent/config/route");

// The LLM keys are cleared for the same reason as in the config unit test: `bun`
// loads a checkout's `.env`, so a developer machine with a real key would answer
// differently from CI, which has none.
const ENV_KEYS = [
  AGENT_ENABLED_ENV,
  AGENT_WORLD_TARGET_ENV,
  "WORKFLOW_LOCAL_DATA_DIR",
  "LLM_PROVIDER",
  "LLM_API_KEY",
  "LLM_MODEL",
  "LLM_API_URL",
] as const;

let originalEnv: Record<string, string | undefined>;
let ledgerDir: string;

beforeEach(() => {
  installMocks();
  mockGetSession.mockResolvedValue({ role: "user", username: "ada" });
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "libredb-agent-probe-"));
  process.env.WORKFLOW_LOCAL_DATA_DIR = ledgerDir;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  fs.rmSync(ledgerDir, { recursive: true, force: true });
});

/** A model configuration that validates without reaching anything. */
function configureModel(): void {
  process.env.LLM_PROVIDER = "gemini";
  process.env.LLM_API_KEY = "test-key";
}

describe("GET /api/agent/config", () => {
  test("reports the runtime as enabled when a model is configured and the ledger is writable", async () => {
    configureModel();

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await parseResponseJSON<{ enabled: boolean }>(res)).toEqual({ enabled: true });
  });

  test("reports it disabled and names the missing model, so the operator is told why", async () => {
    const res = await GET();
    const body = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(body.reason).toBe("NO_MODEL_CONFIGURED");
    expect(String(body.detail)).toContain("LLM_API_KEY");
  });

  test("reports the operator's own off-switch as itself", async () => {
    configureModel();
    process.env[AGENT_ENABLED_ENV] = "false";

    const body = await parseResponseJSON<Record<string, unknown>>(await GET());

    expect(body.enabled).toBe(false);
    expect(body.reason).toBe("OPERATOR_DISABLED");
    expect(String(body.detail)).toContain(AGENT_ENABLED_ENV);
  });

  test("reports an unwritable ledger rather than an agent that cannot record a run", async () => {
    configureModel();
    const blocker = path.join(ledgerDir, "not-a-directory");
    fs.writeFileSync(blocker, "");
    process.env.WORKFLOW_LOCAL_DATA_DIR = path.join(blocker, "workflow");

    const body = await parseResponseJSON<Record<string, unknown>>(await GET());

    expect(body.enabled).toBe(false);
    expect(body.reason).toBe("LEDGER_UNAVAILABLE");
  });

  test("keeps `enabled` a literal boolean, which is the only field the rail reads", async () => {
    // `use-agent-capability.ts` compares with `===` precisely so that a richer
    // body cannot accidentally start meaning "on". A truthy string here would
    // therefore turn the rail off, silently, on every deployment.
    configureModel();

    const enabledBody = await parseResponseJSON<Record<string, unknown>>(await GET());
    process.env[AGENT_ENABLED_ENV] = "off";
    const disabledBody = await parseResponseJSON<Record<string, unknown>>(await GET());

    expect(typeof enabledBody.enabled).toBe("boolean");
    expect(typeof disabledBody.enabled).toBe("boolean");
  });

  test("an unauthenticated caller learns nothing about the agent", async () => {
    configureModel();
    mockGetSession.mockResolvedValue(null);

    const res = await GET();
    const body = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(401);
    expect(body).not.toHaveProperty("enabled");
    expect(body).not.toHaveProperty("reason");
  });

  /**
   * The backend selector is validated where a world is actually built
   * (`resolveAgentDurableBackend`, refusing an unsanctioned value). This route
   * answers a visibility question and builds nothing, so a misconfigured backend
   * must not turn the probe into a 500 — the rail would then be indistinguishable
   * from a server that runs no agents, which is the state the operator would be
   * trying to diagnose. Since T5 it does better than not-500: it reports the
   * refusal's own message, under the refusal's OWN code — a backend that is not on
   * the allowlist is fixed by editing a variable, and reporting it as an unwritable
   * ledger would send an operator to the disk instead.
   */
  test("an unsanctioned durable backend is reported under its own code, not as a ledger fault", async () => {
    configureModel();
    process.env[AGENT_WORLD_TARGET_ENV] = "@workflow/world-turso";

    const res = await GET();
    const body = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(body.reason).toBe("UNSANCTIONED_WORLD_TARGET");
    expect(String(body.detail)).toContain(AGENT_WORLD_TARGET_ENV);
  });
});
