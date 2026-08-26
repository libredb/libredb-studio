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
import {
  AGENT_ENABLED_ENV,
  AGENT_MODEL_TUNING_ENV,
  AGENT_THREAD_CONTEXT_ENV,
  AGENT_WORLD_TARGET_ENV,
} from "@/lib/agent/config";
import { resetTuning } from "@/lib/agent/model-tuning";
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
  AGENT_MODEL_TUNING_ENV,
  AGENT_THREAD_CONTEXT_ENV,
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
  // The tuning document is memoised for the process, so a case that mounted one would otherwise
  // leave it in force for whatever runs next.
  resetTuning();
});

/** A model configuration that validates without reaching anything. */
function configureModel(): void {
  process.env.LLM_PROVIDER = "gemini";
  process.env.LLM_API_KEY = "test-key";
}

/**
 * The session that is allowed to read `detail`. The underlying messages name an
 * absolute server path and an OS error string when the ledger is the problem, and
 * the person who acts on that is the operator — so the diagnosis is admin-only and
 * `reason`, which names no path, is what every session keeps.
 */
function asAdmin(): void {
  mockGetSession.mockResolvedValue({ role: "admin", username: "root" });
}

describe("GET /api/agent/config", () => {
  test("reports the runtime as enabled when a model is configured and the ledger is writable", async () => {
    configureModel();

    const res = await GET();

    expect(res.status).toBe(200);
    // An ordinary session's whole answer: no operator state at all.
    expect(await parseResponseJSON<Record<string, unknown>>(res)).toEqual({
      enabled: true,
      ledgerVerified: true,
    });
  });

  test("says a postgres ledger was not verified here, instead of letting it read as a checked one (B31)", async () => {
    // The rail still renders — this is a carve-out, not a new refusal — but the
    // answer states that the durable backend was never contacted, so an operator
    // reading `curl /api/agent/config` is not told a database was reached when the
    // only thing checked was the value of a variable.
    configureModel();
    process.env[AGENT_WORLD_TARGET_ENV] = "@workflow/world-postgres";

    const body = await parseResponseJSON<Record<string, unknown>>(await GET());

    expect(body).toEqual({ enabled: true, ledgerVerified: false });
  });

  test("tells an ADMIN that conversation context is switched off, so the switch can be confirmed", async () => {
    // The operator is the only reader this field has, and confirming the switch took is
    // the whole reason it exists — the same reason `modelTuning` reports itself.
    asAdmin();
    configureModel();
    process.env[AGENT_THREAD_CONTEXT_ENV] = "false";

    const body = await parseResponseJSON<Record<string, unknown>>(await GET());

    expect(body.enabled).toBe(true);
    expect(body.threadContext).toBe(false);
  });

  test("does not report the conversation switch to an ordinary session, which has no reader for it", async () => {
    /*
      Nothing in the browser consumes it: `use-agent-capability.ts` reads `enabled` and
      nothing else, and the rail's "switched off on this server" sentence comes from the
      RUN's own `thread.declined` rather than from this probe. An earlier version sent it
      to every session justified by a rail consumer that did not exist.

      It is also the wrong moment for a user: what they need is said when a follow-up was
      not read as one, not on page load.
    */
    configureModel();
    process.env[AGENT_THREAD_CONTEXT_ENV] = "false";

    const body = await parseResponseJSON<Record<string, unknown>>(await GET());

    // Non-vacuous: the probe DID answer, and answered enabled, so the absence below is
    // about this field rather than about a refused request.
    expect(body.enabled).toBe(true);
    expect(body).not.toHaveProperty("threadContext");
  });

  test("reports it disabled and names the missing model, so the operator is told why", async () => {
    asAdmin();

    const res = await GET();
    const body = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(body.reason).toBe("NO_MODEL_CONFIGURED");
    expect(String(body.detail)).toContain("LLM_API_KEY");
  });

  test("reports the operator's own off-switch as itself", async () => {
    asAdmin();
    configureModel();
    process.env[AGENT_ENABLED_ENV] = "false";

    const body = await parseResponseJSON<Record<string, unknown>>(await GET());

    expect(body.enabled).toBe(false);
    expect(body.reason).toBe("OPERATOR_DISABLED");
    expect(String(body.detail)).toContain(AGENT_ENABLED_ENV);
  });

  test("reports an unwritable ledger rather than an agent that cannot record a run", async () => {
    asAdmin();
    configureModel();
    const blocker = path.join(ledgerDir, "not-a-directory");
    fs.writeFileSync(blocker, "");
    process.env.WORKFLOW_LOCAL_DATA_DIR = path.join(blocker, "workflow");

    const body = await parseResponseJSON<Record<string, unknown>>(await GET());

    expect(body.enabled).toBe(false);
    expect(body.reason).toBe("LEDGER_UNAVAILABLE");
    // The path is what an operator needs, and it is the operator who gets it.
    expect(String(body.detail)).toContain(blocker);
  });

  test("does not hand an ordinary session the server path and OS error the ledger detail carries", async () => {
    // The rail renders nothing when the answer is no, so a non-admin session loses
    // nothing by not being told WHERE on the server disk the ledger was refused.
    // `reason` is the field an operator filters on and it names no path, so that one
    // is kept for everybody.
    configureModel();
    const blocker = path.join(ledgerDir, "not-a-directory");
    fs.writeFileSync(blocker, "");
    process.env.WORKFLOW_LOCAL_DATA_DIR = path.join(blocker, "workflow");

    const body = await parseResponseJSON<Record<string, unknown>>(await GET());

    expect(body.enabled).toBe(false);
    expect(body.reason).toBe("LEDGER_UNAVAILABLE");
    const detail = String(body.detail ?? "");
    expect(detail).not.toContain(blocker);
    expect(detail).not.toContain(ledgerDir);
    expect(detail).not.toMatch(/ENOTDIR|EACCES|EPERM|ENOENT/);
  });

  test("gives every non-admin refusal the same stable message, so the reason is the only thing that varies", async () => {
    // One message for all reasons rather than a per-reason allowlist: a rule that
    // has to be re-audited each time a reason is added is a rule that eventually
    // leaks the next detail somebody writes.
    const withoutModel = await parseResponseJSON<Record<string, unknown>>(await GET());
    configureModel();
    process.env[AGENT_ENABLED_ENV] = "false";
    const switchedOff = await parseResponseJSON<Record<string, unknown>>(await GET());

    expect(withoutModel.reason).toBe("NO_MODEL_CONFIGURED");
    expect(switchedOff.reason).toBe("OPERATOR_DISABLED");
    expect(String(withoutModel.detail)).toBe(String(switchedOff.detail));
    expect(String(withoutModel.detail)).not.toContain("LLM_API_KEY");
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
    asAdmin();
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

/**
 * What became of `AGENT_MODEL_TUNING_PATH`, which is the one thing about the agent's
 * configuration that fails OPEN.
 *
 * Every other misconfiguration here makes the rail disappear, so the operator finds out by
 * looking. A tuning document that cannot be read is different: the agent runs, the rail renders,
 * and the settings the operator mounted are simply not the ones in force. Nothing about the
 * running system says so, which makes it the case this route exists for.
 *
 * Admin-only, under the rule this route already states for `detail`: the status names an absolute
 * server filesystem path and a parser message, and the person who acts on that is the operator.
 */
describe("GET /api/agent/config, on the operator's tuning document", () => {
  const writeTuning = (body: string): string => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "libredb-tuning-route-")), "models.json");
    fs.writeFileSync(file, body);
    return file;
  };

  test("tells an admin the document was ignored, and why", async () => {
    asAdmin();
    configureModel();
    const file = writeTuning("{ not json");
    process.env[AGENT_MODEL_TUNING_ENV] = file;
    resetTuning();

    const body = await parseResponseJSON<Record<string, unknown>>(await GET());

    expect(body.modelTuning).toMatchObject({ state: "ignored", path: file });
    expect(String((body.modelTuning as Record<string, unknown>).reason)).toContain("JSON");
  });

  test("tells an admin when nothing was configured, so silence is not read as a fault", async () => {
    asAdmin();
    configureModel();
    resetTuning();

    const body = await parseResponseJSON<Record<string, unknown>>(await GET());

    expect(body.modelTuning).toEqual({ state: "unset" });
  });

  test("withholds it from a session that cannot act on it", async () => {
    // The same rule as `detail`, and withheld as a whole rather than field by field: a path is
    // server topology, and a rule re-audited per field is one that leaks the next field somebody
    // adds.
    configureModel();
    process.env[AGENT_MODEL_TUNING_ENV] = writeTuning("{ not json");
    resetTuning();

    const body = await parseResponseJSON<Record<string, unknown>>(await GET());

    expect(body).not.toHaveProperty("modelTuning");
  });
});
