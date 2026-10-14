import { detectSensitiveColumnsFromConfig, type MaskingConfig, type MaskingPattern } from "@/lib/data-masking";
import type { ProviderCapabilities } from "@/lib/db/types";

/**
 * WHERE AN ENGINE'S VOCABULARY MEETS THE MASKING RULES.
 *
 * Its own module, and that is the point of it. `data-masking.ts` must not learn what engine a
 * result came from: its rules are the user's, they apply to every connection alike, and an engine
 * able to reach inside them could widen what another engine's user sees. `db/types.ts` must not
 * learn the masking rules either. So the one place that knows both is here, and it is the only
 * thing either side has to agree on.
 */

/**
 * The result columns a provider exempts from the masking rules, keyed by field, with the reason
 * each one carries (`ProviderCapabilities.maskingExemptColumns`).
 *
 * Takes the declaration rather than the whole capabilities for the reason
 * `inlineEditRefusedColumns` is passed that way: the grid is handed one field, not a provider. An
 * absent declaration exempts nothing, which is also what a `/api/db/provider-meta` call answers
 * with both while it is in flight and when it failed, and neither of those is a permission.
 *
 * Not exported: callers take `splitMaskedColumns` below, so that nobody can read the exemptions
 * without also being handed what is still masked. Those two answers are only ever right together.
 */
function maskingExemptionsFor(
  declared: ProviderCapabilities["maskingExemptColumns"],
  fields: readonly string[],
): Map<string, string> {
  const exemptions = new Map<string, string>();
  if (declared === undefined) return exemptions;
  const exempt = new RegExp(declared.column);
  for (const field of fields) if (exempt.test(field)) exemptions.set(field, declared.reason);
  return exemptions;
}

/**
 * What a result's columns are, once the engine has had its say: the ones still masked, and the
 * ones it excused with the reason to show for each.
 *
 * Both halves are returned because a caller needs both and they must not be derived twice: the
 * grid draws a lock from `masked` and the exemption mark from `exempt`, and `Studio` writes
 * asterisks into the rows it hands on using `masked` alone. Two callers each subtracting for
 * themselves is how a column ends up drawn open over values that are already asterisks.
 *
 * It exempts, it never adds: `masked` is always a subset of what the rules matched, so no
 * provider can put a column INTO the masked set, only take its own out.
 */
export function splitMaskedColumns(
  fields: readonly string[],
  config: MaskingConfig,
  declared: ProviderCapabilities["maskingExemptColumns"],
): { masked: Map<string, MaskingPattern>; exempt: Map<string, string> } {
  const detected = detectSensitiveColumnsFromConfig([...fields], config);
  const exempt = maskingExemptionsFor(declared, fields);
  if (exempt.size === 0) return { masked: detected, exempt };
  const masked = new Map(detected);
  for (const field of exempt.keys()) masked.delete(field);
  return { masked, exempt };
}
