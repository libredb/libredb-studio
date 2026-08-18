import type { ShowcaseGroup } from "@/lib/distribution/channels.generated";

/**
 * Reading order for the four channel groups, broadest first: a reader who already runs
 * containers recognises the first name and can stop there.
 *
 * Typed `readonly ShowcaseGroup[]` and paired with the exhaustive label map below, so a new
 * group in `scripts/generate-channel-showcase.mjs` fails `bun run typecheck` on the missing
 * key rather than rendering an unlabelled one - the same compile-time rule the generator
 * applies to an unknown `category`, which throws instead of defaulting.
 */
export const DEPLOY_GROUP_ORDER: readonly ShowcaseGroup[] = ["containers", "kubernetes", "paas", "packages"];

/** Human labels for the four groups. */
export const DEPLOY_GROUP_LABELS: Record<ShowcaseGroup, string> = {
  containers: "Containers",
  kubernetes: "Kubernetes",
  paas: "PaaS",
  packages: "Packages",
};
