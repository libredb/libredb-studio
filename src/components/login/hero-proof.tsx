import { AGENT_EXECUTION_ENGINES, namedList } from "@/lib/agent/engine-support";
import { getDBConfig } from "@/lib/db-ui-config";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { LIVE_CHANNELS, LIVE_PLATFORMS } from "@/lib/distribution/channels.generated";
import { DEPLOY_GROUP_LABELS, DEPLOY_GROUP_ORDER } from "@/lib/distribution/deploy-groups";

/**
 * The two agent modes, in the order a user meets them.
 *
 * The descriptions are pinned to `docs/AGENT.md` and the split is load-bearing: plan mode
 * executes nothing on any engine, agent mode executes read-only and only where the provider
 * implements `queryReadOnly`. The engine names in the second line come from
 * `AGENT_EXECUTION_ENGINES`, so an engine that gains that method updates this claim without
 * a copy edit - and the count below is this array's length, never a typed "2".
 *
 * They are joined by `namedList` rather than by `join(" and ")`, which is what this file
 * used to do: with three engines that printed "PostgreSQL and SQLite and DuckDB" on the
 * login page. The helper is shared with the posture popover, which had the same join.
 *
 * `tests/components/LoginPage.test.tsx` pins the claim rather than the wording: dropping a
 * mode, or naming an engine agent mode cannot execute on, fails CI.
 */
const AGENT_MODES: readonly { key: string; label: string; detail: string }[] = [
  { key: "plan", label: "plan mode", detail: "drafts one statement, runs nothing" },
  {
    key: "agent",
    label: "agent mode",
    detail: `runs read-only on ${namedList(AGENT_EXECUTION_ENGINES.map((type) => getDBConfig(type).label))}`,
  },
];

/**
 * Three claims, three derived numbers, nothing else.
 *
 * This replaces the four feature cards that used to sit here. The cards said the same
 * things at four different lengths, which is what made the panel ragged: the agent card ran
 * to four lines while the engine card ran to two, so the 2x2 grid never had a baseline.
 * A number, a noun and one qualifying line give each claim the same shape, and the reader
 * can compare them at a glance instead of reading four paragraphs.
 *
 * Every count is a `.length` on a derived array. That is the whole point of issue #425:
 * "7+" was written when the answer was 7, and it stayed while the answer became 11.
 */
/**
 * The three claims, shared by both login surfaces so they cannot drift: the desktop hero
 * renders them as a three-column figure, the mobile block joins the same strings into one
 * line. Every input is static, so this is computed once at module load rather than per
 * render.
 */
export const HERO_CLAIMS: readonly { key: string; value: number; unit: string; detail: string }[] = [
  {
    key: "engines",
    // EXTERNAL_DATABASE_TYPES, not the showcase length. The two differ by one and the one is
    // the embedded store: it is a provider this app carries, not a database anyone points us
    // at, so counting it here claimed one external engine more than the product has and put
    // this page one out of step with the number README.md publishes. The pill for it stays -
    // it is a provider the connection picker offers - marked as embedded so the reader can
    // see why seventeen pills sit under a claim of sixteen.
    value: EXTERNAL_DATABASE_TYPES.length,
    unit: "database engines",
    detail: "one client, one workspace, every one of them",
  },
  {
    key: "channels",
    value: LIVE_CHANNELS.length,
    unit: "install channels",
    detail: DEPLOY_GROUP_ORDER.map((group) => DEPLOY_GROUP_LABELS[group]).join(", "),
  },
  {
    key: "agent",
    value: AGENT_MODES.length,
    unit: "agent modes",
    detail: AGENT_MODES.map((mode) => `${mode.label} ${mode.detail}`).join(" · "),
  },
];

/**
 * The workstation and server operating systems, taken from `LIVE_PLATFORMS`.
 *
 * Filtered rather than rendered whole, and the filter is the point: `container`,
 * `kubernetes` and `cloud` are already the first three channel groups above, so printing
 * them again here would say Containers and Kubernetes twice in adjacent lines. What is left
 * is the question this line answers and the claim above cannot - whether the machine in
 * front of you can run it.
 */
const OS_PLATFORM_LABELS: Record<string, string> = { linux: "Linux", macos: "macOS", windows: "Windows" };
const OS_PLATFORMS = LIVE_PLATFORMS.filter((platform) => platform in OS_PLATFORM_LABELS);

export function HeroProof() {
  const claims = HERO_CLAIMS;

  return (
    <div className="space-y-2">
      <dl data-testid="hero-proof" className="grid grid-cols-3 gap-x-6 gap-y-2 select-none">
        {claims.map((claim) => (
          <div key={claim.key} className="space-y-1">
            <dt className="flex items-baseline gap-1.5">
              <span className="text-2xl xl:text-3xl font-semibold text-white tabular-nums tracking-tight">
                {claim.value}
              </span>
              <span className="text-xs text-fg-tertiary">{claim.unit}</span>
            </dt>
            <dd
              className="text-xs text-fg-tertiary leading-relaxed"
              data-testid={claim.key === "agent" ? "agent-claim" : undefined}
            >
              {claim.detail}
            </dd>
          </div>
        ))}
      </dl>

      <p data-testid="platform-line" className="text-xs text-fg-tertiary select-none">
        Runs on {OS_PLATFORMS.map((platform) => OS_PLATFORM_LABELS[platform]).join(" · ")}
      </p>
    </div>
  );
}
