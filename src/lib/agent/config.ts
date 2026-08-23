import { access, constants, mkdir, unlink, writeFile } from "fs/promises";
import * as path from "path";
import { resolveConfig, validateConfig } from "@/lib/llm/utils/config";
import { AGENT_MODEL_TURN_TIMEOUT_MS, AGENT_WORKFLOW_BUDGETS } from "./execution-policy";

/**
 * Server-side configuration for the agent runtime (#329, epic #325; availability
 * derived in #331 T5).
 *
 * Until T2 removed the NL2SQL and Autopilot panels, this module answered one
 * question — "did an operator set the flag" — and a deployment that never set it
 * still had AI. With those panels gone, `LIBREDB_AGENT_ENABLED` unset would have
 * meant **the product has no AI at all**, so the flag stopped being a feature
 * toggle and became the switch that decides whether Studio has an AI story. The
 * owner ratified deriving the answer instead
 * (github.com/libredb/libredb-studio/issues/331#issuecomment-5277689616).
 *
 * The agent is available when both of these hold, and it says which one does not:
 *
 *  - **A model is configured** — the same `LLM_*` configuration that used to power
 *    NL2SQL, resolved through `@/lib/llm`'s own `resolveConfig`/`validateConfig`
 *    rather than by reading its variables here. There is no second place to enter
 *    a key, so there must be no second reader of one either.
 *  - **The durable ledger has a writable path.** That one needs I/O, so it is not
 *    answered here — see `resolveAgentAvailability` below. It is checked for the
 *    `local` backend and deliberately NOT for `postgres`, where the only possible
 *    check is a connection attempt per page load; that carve-out is reported as
 *    one (`ledgerVerified`) rather than left to read as verified (B31).
 *
 * `LIBREDB_AGENT_ENABLED` survives as the **explicit off-switch**: its default is
 * now *auto*, and a negative value is the documented, supported way to have AI
 * configuration present and no agent. Its spelling and its negative values are
 * unchanged. An affirmative value is still accepted and still means "yes", but it
 * cannot conjure a model: deriving the answer is what keeps the surface from
 * appearing where it cannot work, and an override that renders a rail whose first
 * Start must fail would give that back.
 *
 * An unrecognised backend is **refused**, not defaulted away. The storage factory
 * can safely fall back to `local` because every value it accepts is one of its
 * own; this variable is read by the workflow runtime itself, which treats any
 * value other than its own two keywords as a MODULE SPECIFIER it require()s. An
 * allowlist is therefore the control that stops a stray value from loading
 * arbitrary code into the server, and it is also what keeps the running backend
 * equal to one of the two ratified ones.
 *
 * The variables are read from `process.env` on every call, not captured at
 * module load, so this module sees exactly what the runtime sees.
 */

/**
 * Explicit off-switch for the whole agent rail. Absent means "derive the answer"
 * rather than "off" (#331 T5).
 */
export const AGENT_ENABLED_ENV = "LIBREDB_AGENT_ENABLED";

/**
 * Durable-execution backend selector. The name is the workflow runtime's own
 * variable — this module validates it rather than introducing a second one, so
 * there is exactly one value in play and no way for the two to disagree.
 */
export const AGENT_WORLD_TARGET_ENV = "WORKFLOW_TARGET_WORLD";

/**
 * How long ONE model call may take before the drive stops waiting for it.
 *
 * Lives here rather than beside the constant it overrides, because this module is the one
 * place in the agent tree that reads the environment — `tests/unit/agent-documentation.test.ts`
 * asserts exactly that, and it caught this read in the wrong file.
 */
const AGENT_TURN_TIMEOUT_ENV = "AGENT_MODEL_TURN_TIMEOUT_MS";

/**
 * The configured per-turn ceiling, or `undefined` when nothing usable was set.
 *
 * Measured across 25 local Ollama models on six agent surfaces: NINE runs ended
 * `stopReason=model-timeout` with the model still working, six of them recorded as the
 * `no-report` shortfall. One was a reasoning model in PLAN mode — which holds no tools, so
 * thinking time is the only thing that can fail — cut 92 seconds into its first turn with a
 * zero-event ledger. Those runs are scored as having answered nothing, which is a fact about
 * the ceiling and not about the model.
 *
 * A value that is not a positive whole number is ignored rather than clamped or thrown on: a
 * mistyped variable must not end every turn instantly, which is worse than the value the
 * operator meant to set.
 *
 * What it IS bounded against is the workflow deadlines, which live in `execution-policy.ts`.
 * The import goes THIS way for a reason the build caught: `execution-policy.ts` is reachable
 * from the browser (`Studio.tsx` -> `use-agent-prefill.ts`) and this module imports
 * `fs/promises`, so a read placed there would have pulled Node's filesystem into the client
 * bundle. The dependency has to point from the server-only module to the client-safe one.
 *
 * `AGENT_WORKFLOW_BUDGETS` guarantees every workflow can take at least two turns — an
 * invariant that file's own test asserts — so a ceiling past half the smallest deadline would
 * configure a run that cannot finish. Capped rather than obeyed into incoherence.
 */
export function agentModelTurnTimeoutMs(): number {
  const raw = process.env[AGENT_TURN_TIMEOUT_ENV];
  if (raw === undefined) return AGENT_MODEL_TURN_TIMEOUT_MS;
  const asked = Number(raw.trim());
  if (!Number.isSafeInteger(asked) || asked <= 0) return AGENT_MODEL_TURN_TIMEOUT_MS;
  const smallestDeadline = Math.min(...Object.values(AGENT_WORKFLOW_BUDGETS).map((budget) => budget.runDeadlineMs));
  return Math.min(asked, Math.floor(smallestDeadline / 2) - 1);
}

/**
 * Set by the hosted platform the runtime targets by default. Read here only to
 * refuse that implicit selection: with no explicit target the runtime would
 * pick its hosted world, which is not one of the two ratified backends.
 */
const HOSTED_DEPLOYMENT_ENV = "VERCEL_DEPLOYMENT_ID";

/**
 * Where the `local` backend keeps run state. Also the workflow runtime's own
 * variable, and read here for the same reason as the one above: introducing a
 * second name would let the directory this module probes differ from the one the
 * world actually builds. Note that `@workflow/world-local` captures it **once**
 * per process (its `config` is `once()`-wrapped) while this module re-reads it,
 * so a probe answered after the world was built describes the configured path,
 * not necessarily the running one.
 */
const AGENT_LOCAL_DATA_DIR_ENV = "WORKFLOW_LOCAL_DATA_DIR";

/** The SDK's own default, mirrored so the probe tests the directory it would pick. */
const LOCAL_DATA_DIR_DEFAULT = ".workflow-data";

/** How long a ledger probe's answer is reused before the directory is touched again. */
export const LEDGER_PROBE_TTL_MS = 5_000;

/** The two official modes. `local` is zero-config; `postgres` is multi-replica. */
export type AgentDurableBackend = "local" | "postgres";

/**
 * Allowlist of accepted `WORKFLOW_TARGET_WORLD` values, mapped onto the backend
 * they select. The keys are the exact strings the runtime itself recognises —
 * matching is case-sensitive and untrimmed on purpose, because the runtime
 * compares the raw value, so accepting a variant here would validate one thing
 * and run another.
 */
export const SANCTIONED_WORLD_TARGETS: Readonly<Record<string, AgentDurableBackend>> = Object.freeze({
  local: "local",
  "@workflow/world-postgres": "postgres",
});

/**
 * Why a durable backend was refused. Exported because `AgentUnavailableReason`
 * carries these codes through unchanged rather than flattening them.
 */
export type AgentConfigDenyCode = "UNSANCTIONED_WORLD_TARGET" | "IMPLICIT_HOSTED_WORLD";

/**
 * Raised when the agent runtime cannot be configured safely. This is an
 * operator error, and it is thrown lazily at call time rather than at module
 * load so a misconfiguration cannot take down unrelated imports.
 */
export class AgentConfigError extends Error {
  constructor(
    message: string,
    public readonly reasonCode: AgentConfigDenyCode,
  ) {
    super(message);
    this.name = "AgentConfigError";
    Object.setPrototypeOf(this, AgentConfigError.prototype);
  }
}

/** Resolved runtime configuration. Disabled carries no backend at all. */
export type AgentRuntimeConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly backend: AgentDurableBackend };

/**
 * Why the agent is unavailable — **one code per operator action**, which is what
 * makes this the field an operator can filter on.
 *
 * The backend selector's own refusals keep their own codes rather than folding
 * into `LEDGER_UNAVAILABLE`. They are not ledger faults: `IMPLICIT_HOSTED_WORLD`
 * fires before anything is asked of a filesystem, and the fix for both is a
 * variable, not a disk. Sharing a code would send an operator to the wrong one.
 */
export type AgentUnavailableReason =
  | "OPERATOR_DISABLED"
  | "NO_MODEL_CONFIGURED"
  | "LEDGER_UNAVAILABLE"
  | AgentConfigDenyCode;

/**
 * Whether the agent can run here, and if not, which condition failed. The detail
 * is the underlying message rather than a restatement of it, so the operator
 * reads what the check actually said.
 *
 * A green answer carries `ledgerVerified`, because the two backends are green for
 * different reasons and only one of them was tested. `true` means the ledger's own
 * writable-path check ran and passed; `false` means this answer is a **carve-out**
 * — the durable backend was accepted without being contacted (B31). Nothing is
 * allowed to report availability without saying which of the two it is.
 */
export type AgentAvailability =
  | { readonly available: true; readonly ledgerVerified: boolean }
  | { readonly available: false; readonly reason: AgentUnavailableReason; readonly detail: string };

// Affirmative/negative vocabulary copied from the AUTH_BOOTSTRAP convention in
// src/lib/auth-bootstrap.ts so operators meet one spelling of "on" per project.
const AFFIRMATIVE_VALUES = new Set(["on", "true", "1"]);
const NEGATIVE_VALUES = new Set(["off", "false", "0"]);

const ACCEPTED_TARGETS = Object.keys(SANCTIONED_WORLD_TARGETS).join(", ");

// Messages are built on one line each: bun's line coverage under-counts the
// continuation lines of multi-line string concatenation.
const unrecognizedFlagMessage = (raw: string): string =>
  `LibreDB Studio: unrecognized ${AGENT_ENABLED_ENV} value "${raw}"; it is ignored and the agent's availability is derived from the AI configuration (use "false" to switch the agent off)`;

// States only what this branch checked. It fires before the model configuration is
// read at all, so a server with the flag off and no key set was once told "even
// though a model is configured" — an assertion about something nobody looked at,
// pointing the reader at an LLM_API_KEY they never set.
const operatorDisabledMessage = (): string =>
  `${AGENT_ENABLED_ENV} is set to a negative value, so this server runs no agent whatever else is configured`;

const ledgerUnwritableMessage = (directory: string, cause: string): string =>
  `the agent's durable ledger cannot be written at "${directory}" (${cause}); point ${AGENT_LOCAL_DATA_DIR_ENV} at a writable directory`;

const unsanctionedTargetMessage = (raw: string): string =>
  `LibreDB Studio: unsupported ${AGENT_WORLD_TARGET_ENV} value "${raw}"; the agent runtime accepts only: ${ACCEPTED_TARGETS}`;

const implicitHostedWorldMessage = (): string =>
  `LibreDB Studio: ${HOSTED_DEPLOYMENT_ENV} is set with no ${AGENT_WORLD_TARGET_ENV}; set it explicitly to one of: ${ACCEPTED_TARGETS}`;

const describeCause = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The off-switch's two states. `auto` covers absent, empty, affirmative and
 * unrecognised alike: the pre-T5 rule was that a typo must never silently enable
 * the agent, and with a derived default the same rule now also says a typo must
 * never silently take the product's only AI surface away. Landing on the default
 * satisfies both, and the warning is what makes the typo visible.
 */
function readAgentEnableFlag(): "off" | "auto" {
  const raw = process.env[AGENT_ENABLED_ENV];
  if (!raw) return "auto";

  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return "auto";
  if (NEGATIVE_VALUES.has(normalized)) return "off";
  if (!AFFIRMATIVE_VALUES.has(normalized)) console.warn(unrecognizedFlagMessage(raw));
  return "auto";
}

/**
 * The half of the answer that needs no I/O: the off-switch and whether a model
 * configuration validates. Both `resolveConfig` and `validateConfig` are
 * synchronous and issue no request — the network check is a separate, cached
 * concern on the start path (`capability-gate.ts`).
 */
function availabilityWithoutIO(): AgentAvailability {
  if (readAgentEnableFlag() === "off") {
    return { available: false, reason: "OPERATOR_DISABLED", detail: operatorDisabledMessage() };
  }

  try {
    validateConfig(resolveConfig());
  } catch (error) {
    return { available: false, reason: "NO_MODEL_CONFIGURED", detail: describeCause(error) };
  }

  // `ledgerVerified: false` is the literal truth of this half: it asked nothing of
  // any ledger. `resolveAgentAvailability` replaces this answer with one that did.
  return { available: true, ledgerVerified: false };
}

/**
 * Whether the agent runtime is available on this server.
 *
 * **Deliberately synchronous**, and it therefore answers only the part that needs
 * no I/O. Five call sites read it inside request handling — three route handlers,
 * the run-access helper and `getAgentRuntimeConfig` — and a writable-path probe is
 * inherently async, so making this async would have turned a visibility question
 * into a signature change across all of them. The ledger half is answered by
 * `resolveAgentAvailability`, which the config probe route awaits.
 *
 * The consequence, stated rather than hidden: a deployment with a model but an
 * unwritable ledger path answers `true` here, so its agent routes exist and a run
 * fails when the world is built — which is where a filesystem error can be
 * reported as itself. The rail still stays absent, because the browser asks the
 * probe route.
 */
export function isAgentRuntimeEnabled(): boolean {
  return availabilityWithoutIO().available;
}

/**
 * The directory the `local` backend would keep run state in. Pure and
 * side-effect free so the resolution can be asserted without creating anything.
 */
export function resolveAgentLedgerDirectory(): string {
  const configured = process.env[AGENT_LOCAL_DATA_DIR_ENV]?.trim();
  return path.resolve(configured || LOCAL_DATA_DIR_DEFAULT);
}

/**
 * Distinguishes one probe from the next **within a process**. `process.pid` alone
 * does not: it is constant for the process's whole lifetime, so two page loads
 * served concurrently would write and remove the *same* file — A writes, B writes,
 * A removes, and B's removal meets nothing and is reported as an unwritable
 * ledger on a server whose ledger is perfectly writable. `use-agent-capability`
 * probes once on mount and never retries, so that browser would have no rail for
 * the rest of the page session.
 */
let probeSequence = 0;

/**
 * The same four steps `@workflow/world-local`'s own `ensureDataDir` performs —
 * create, read-check, write a probe file, remove it — rather than a cheaper
 * `access(W_OK)`, and including the two details upstream needs for concurrency:
 * the probe filename varies per call, and an `ENOENT` while removing it is not a
 * failure (upstream's comment names this exact race).
 *
 * **What a green answer promises, stated exactly:** the world's own `ensureDataDir`
 * will pass. It does NOT promise that `initDataDir` will, because that runs a fifth
 * step this does not — reading and parsing `version.txt` — and a corrupt or
 * incompatible one throws after this probe has already answered green (B30).
 */
async function runLedgerProbe(directory: string): Promise<AgentAvailability> {
  probeSequence += 1;
  const probeFile = path.join(directory, `.libredb-agent-write-probe-${process.pid}-${probeSequence}`);
  try {
    await mkdir(directory, { recursive: true });
    await access(directory, constants.R_OK);
    await writeFile(probeFile, "");
    // The write is the question this asked, and it was answered. A missing file at
    // cleanup means something else removed it first — a concurrent probe, a tmp
    // reaper — which says nothing about whether the directory is writable.
    await unlink(probeFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return { available: true, ledgerVerified: true };
  } catch (error) {
    const detail = ledgerUnwritableMessage(directory, describeCause(error));
    return { available: false, reason: "LEDGER_UNAVAILABLE", detail };
  }
}

/**
 * The current probe for a directory: the promise while it runs, and the same
 * promise as the memoised answer once it has. Holding the PROMISE rather than the
 * resolved value is what makes the bound below true of concurrent callers and not
 * only of sequential ones.
 */
type LedgerProbeMemo = {
  readonly directory: string;
  readonly expiresAt: number;
  readonly answer: Promise<AgentAvailability>;
};

/** The last probe, held just long enough to bound what a caller can cost. */
let ledgerProbeMemo: LedgerProbeMemo | null = null;

/**
 * The probe, shared while it is in flight and its answer reused for
 * `LEDGER_PROBE_TTL_MS` afterwards.
 *
 * The route that reaches this requires a session but deliberately sits outside the
 * `ai` rate-limit bucket — metering a visibility probe there would spend a run's
 * budget on rendering a panel, and throttling it would make the rail vanish for a
 * user who reloads. That leaves a `mkdir` + write + unlink per authenticated
 * request, which a logged-in caller can issue in a loop. Memoising bounds the
 * filesystem work to once per interval per directory per process instead, and the
 * interval is short enough that an operator who fixes a permission sees the rail
 * appear without a restart.
 *
 * **The in-flight promise is shared, and that is what makes "once per interval"
 * true.** A memo written only after the probe resolved bounded nothing against a
 * burst: every request that arrived during the gap found no memo and ran its own
 * write and unlink. The earlier reason for not sharing — that de-duplicating
 * concurrent probes would hide the race the per-call filename exists for — expired
 * when that race was fixed rather than only tested: the filename varies per call and
 * cleanup tolerates `ENOENT`, so nothing about the protection depends on two callers
 * of THIS function overlapping. Two probes still reach one directory concurrently
 * from a second process on a shared volume, from a re-pointed variable, and in the
 * test that drives exactly that against a real filesystem.
 *
 * The memo is keyed by directory, so a re-pointed `WORKFLOW_LOCAL_DATA_DIR` is never
 * answered from the previous one's result. The TTL is stamped when the probe
 * RESOLVES, so a slow probe is never evicted while it is still in flight, and the
 * interval measures how stale an answer may be rather than how long one took.
 */
async function probeLedgerDirectory(directory: string): Promise<AgentAvailability> {
  const memo = ledgerProbeMemo;
  if (memo?.directory === directory && memo.expiresAt > Date.now()) return memo.answer;

  // Published before the first await returns to the event loop, so every caller that
  // arrives while this runs joins it instead of starting a second one. `Infinity`
  // holds it un-evictable until it resolves.
  const answer = runLedgerProbe(directory);
  ledgerProbeMemo = { directory, expiresAt: Number.POSITIVE_INFINITY, answer };

  const result = await answer;
  // Only if nothing else claimed the slot meanwhile: a probe of ANOTHER directory
  // that started while this one ran owns the memo now, and stamping this answer over
  // it would leave that one un-evictable at `Infinity` forever.
  if (ledgerProbeMemo?.answer === answer) {
    ledgerProbeMemo = { directory, expiresAt: Date.now() + LEDGER_PROBE_TTL_MS, answer };
  }
  return result;
}

/**
 * The whole answer, including the ledger. Never throws: the caller is the
 * visibility probe, and a refusal that escaped would become a 500 the operator
 * could not tell apart from "this server runs no agents".
 *
 * The ledger is probed only after the no-I/O half passes, so a Studio with no AI
 * configuration never creates a `.workflow-data` directory it will never use.
 */
export async function resolveAgentAvailability(): Promise<AgentAvailability> {
  const withoutIO = availabilityWithoutIO();
  if (!withoutIO.available) return withoutIO;

  let backend: AgentDurableBackend;
  try {
    backend = resolveAgentDurableBackend();
  } catch (error) {
    // `resolveAgentDurableBackend` throws nothing but `AgentConfigError` — it reads
    // two environment variables and consults a frozen allowlist — so its own reason
    // code is carried through rather than flattened. The cast is what avoids an
    // else-branch no input can reach; the two codes are pinned by tests.
    const { reasonCode, message } = error as AgentConfigError;
    return { available: false, reason: reasonCode, detail: message };
  }

  // **The documented carve-out (B31).** The postgres world's ledger is a database,
  // and the only way to test it is to open a connection — on every page load of a
  // logged-in user, from a route outside the rate-limit bucket. So this backend is
  // accepted WITHOUT being contacted, and the answer says so rather than reading like
  // the probed one: with an unreachable WORKFLOW_POSTGRES_URL the rail appears and
  // the first Start fails, which is the outcome deriving availability exists to
  // prevent, surviving here in a narrower case. A real readiness check is a separate
  // piece of work; what is NOT acceptable is leaving this reading as verified.
  if (backend === "postgres") return { available: true, ledgerVerified: false };

  return probeLedgerDirectory(resolveAgentLedgerDirectory());
}

/**
 * The durable-execution backend to run on. Absent selects the zero-config local
 * backend; anything outside the allowlist is refused rather than defaulted.
 */
export function resolveAgentDurableBackend(): AgentDurableBackend {
  const raw = process.env[AGENT_WORLD_TARGET_ENV];

  if (!raw) {
    if (process.env[HOSTED_DEPLOYMENT_ENV]) {
      throw new AgentConfigError(implicitHostedWorldMessage(), "IMPLICIT_HOSTED_WORLD");
    }
    return "local";
  }

  // Own-property check, not a truthiness check on the lookup: the allowlist is
  // an object literal, so it also answers for every member of Object.prototype
  // ("constructor", "toString", ...) and a truthy inherited function would be
  // handed back as if it were a sanctioned backend.
  if (Object.hasOwn(SANCTIONED_WORLD_TARGETS, raw)) return SANCTIONED_WORLD_TARGETS[raw];

  throw new AgentConfigError(unsanctionedTargetMessage(raw), "UNSANCTIONED_WORLD_TARGET");
}

/**
 * The composed configuration. The backend is resolved only when the runtime is
 * enabled: while the agent is unavailable nothing builds a world, so refusing
 * over a variable no code path reads would take the server down for no gain.
 */
export function getAgentRuntimeConfig(): AgentRuntimeConfig {
  if (!isAgentRuntimeEnabled()) return { enabled: false };
  return { enabled: true, backend: resolveAgentDurableBackend() };
}
