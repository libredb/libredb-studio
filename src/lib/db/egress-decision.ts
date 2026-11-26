/**
 * The egress decision: whether Studio's database connections may reach loopback, private and the other non-public
 * destinations, as `DB_HTTP_BLOCK_PRIVATE_HOSTS` sets it.
 *
 * Core owns the decision (FND-2, the provider plugins design section 0.1): this module is the only code that reads the
 * variable, and every guard decides by its decision, so no two readers can disagree. The variable is parsed once per process and the outcome kept for the life of the process, so
 * the line logged is the decision every guard keeps, and a change of the variable takes effect when Studio restarts.
 *
 * The spellings: trimmed and lower-cased, `true`, `on` and `1` block private destinations, and `false`, `off` and `0`
 * keep them reachable, both as set by the operator; unset, empty or blank keeps them reachable as the documented
 * default. Any other value is invalid: the outcome is a refusal, kept like a decision, and every read of the decision
 * throws a `DatabaseConfigError` with `INVALID_EGRESS_SETTING`.
 *
 * Who reads first: on a standalone server the boot preflight (`@/lib/config/egress-preflight`), which refuses an
 * invalid value before the server serves; in a channel with no boot hook, the published package and the VS Code
 * backend, the provider factory's first entry point call. The read that takes a decision logs it once, with whether it
 * is the documented default; a refusal logs nothing, since the boot banner or the thrown error speaks for it.
 *
 * The outcome lives on `globalThis` under a registered symbol, not in a module-level variable: Next.js bundles the
 * instrumentation, which takes the decision at boot, apart from the route handlers, so one server process holds this
 * module twice (src/lib/governance/keyring.ts does the same for the same reason).
 *
 * No provider reads the decision here: the legacy adapter's open (`@/lib/provider-host/legacy-adapter/open`) hands it
 * to every provider that takes a context, in the build context (`ProviderBuildContext` in `./types`), and every guard
 * and transport takes it as an argument or an option. For an engine a provider package serves,
 * `@/lib/provider-host/open-context` hands it to the package's `open` in its open context. Every open takes the
 * decision first in the one ordered open check (`./open-check`), and the provider factory (`./factory`) takes it before
 * it caches, dials or builds anything. No other module reads it. `tests/unit/lib/db/provider-environment-scan.test.ts`
 * holds who imports this module, that no provider module reaches it, and that no module under `packages/` imports it.
 *
 * `forgetEgressDecision` is a test seam.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import type { EgressDecision } from "@/lib/db/types";
import { logger } from "@/lib/logger";

/** The refusal of a value outside the accepted spellings, on every read of the decision. */
export const INVALID_EGRESS_SETTING = "Invalid DB_HTTP_BLOCK_PRIVATE_HOSTS: expected true or false";

/** The kept outcome: the decision, or the value as written when it is none of the accepted spellings. */
export type EgressSetting = EgressDecision | { readonly invalid: string };

const DECISION_KEY = Symbol.for("libredb-studio.egress-decision");

type DecisionHolder = { [DECISION_KEY]?: EgressSetting };

function parsed(value: string | undefined): EgressSetting {
  const spelled = value?.trim().toLowerCase();
  if (spelled === undefined || spelled === "") return { blocksPrivateHosts: false, source: "default" };
  if (spelled === "false" || spelled === "off" || spelled === "0") return { blocksPrivateHosts: false, source: "set" };
  if (spelled === "true" || spelled === "on" || spelled === "1") return { blocksPrivateHosts: true, source: "set" };
  return { invalid: value as string };
}

/**
 * The outcome of this process, for the boot preflight: never throws. The first read parses the variable, keeps the
 * outcome and, for a decision, logs it; every later read returns the kept outcome.
 */
export function egressSetting(): EgressSetting {
  const holder = globalThis as DecisionHolder;
  const kept = holder[DECISION_KEY];
  if (kept !== undefined) return kept;
  const setting = parsed(process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS);
  holder[DECISION_KEY] = setting;
  if ("blocksPrivateHosts" in setting) {
    logger.info(`Private database destinations are ${setting.blocksPrivateHosts ? "blocked" : "reachable"}`, {
      route: "egress-decision",
      variable: "DB_HTTP_BLOCK_PRIVATE_HOSTS",
      blocksPrivateHosts: setting.blocksPrivateHosts,
      source: setting.source,
    });
  }
  return setting;
}

/** The decision the provider factory takes: throws `INVALID_EGRESS_SETTING` for a refused setting, on every call. */
export function egressDecision(): EgressDecision {
  const setting = egressSetting();
  if ("invalid" in setting) throw new DatabaseConfigError(INVALID_EGRESS_SETTING);
  return setting;
}

/** Test seam: forgets this process's outcome, so the next read decides as a new process would. */
export function forgetEgressDecision(): void {
  delete (globalThis as DecisionHolder)[DECISION_KEY];
}
