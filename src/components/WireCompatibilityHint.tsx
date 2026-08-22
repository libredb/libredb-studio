"use client";

import type { DatabaseType } from "@/lib/types";
import { compatibleEnginesFor, type WireCompatibleEngine } from "@/lib/db/compatibility";

interface WireCompatibilityHintProps {
  type: DatabaseType;
  /** Injectable for tests; defaults to the registry. */
  engines?: readonly WireCompatibleEngine[];
}

/**
 * Tells the user that the driver they just selected also serves other engines
 * (issue #424, Phase 0). It exists because the connection dialog offers fourteen
 * driver buttons and none of them says "MariaDB", so a MariaDB user has no way to
 * know that MySQL is the right button.
 *
 * Caveats are ANNOUNCED here, not listed. Every verified engine diverges from its
 * driver somewhere in the introspection surface, and printing every caveat line
 * would turn a hint into a wall; the per-engine detail lives in the docs
 * compatibility table, which is scannable and has room for it. What the dialog
 * must not do is publish a bare name and imply parity we never measured - hence
 * the notice.
 */
export function WireCompatibilityHint({ type, engines }: WireCompatibilityHintProps) {
  const verified = engines ?? compatibleEnginesFor(type);
  if (verified.length === 0) return null;

  const hasCaveats = verified.some((engine) => engine.caveats.length > 0);

  return (
    <div
      className="rounded-lg border border-hairline bg-panel px-3 py-2 text-xs text-fg-muted"
      data-testid="wire-compat-hint"
    >
      <p>
        This driver also serves{" "}
        {verified.map((engine, index) => (
          <span key={engine.name}>
            {index > 0 && ", "}
            <span className="text-fg">{engine.name}</span>{" "}
            <span className="text-fg-subtle">(verified on {engine.probedVersion})</span>
            {engine.tier !== "full" && (
              <span className="text-fg-subtle" data-testid={`wire-compat-tier-${engine.name}`}>
                {engine.tier === "query-only" ? " - query editor only" : " - partial support"}
              </span>
            )}
          </span>
        ))}
        .
      </p>
      {hasCaveats && (
        <p className="mt-1 text-fg-subtle" data-testid="wire-compat-caveat-notice">
          Some of these expose fewer monitoring and statistics views than the driver&apos;s own engine. The
          compatibility table in the docs lists what each one is missing.
        </p>
      )}
    </div>
  );
}
