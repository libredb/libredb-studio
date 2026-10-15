"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { GovernanceStatusResponse } from "@/app/api/admin/governance/route";
import { appFetch } from "@/lib/config/base-path";
import type { FreshnessState } from "@/lib/governance/freshness";
import type { GovernanceStatus, GovernanceStatusSkip } from "@/lib/governance/status";

const CARD_TITLE = "Governance";
const NOT_LOADED = "none yet";
const NO_CANARY = "none published";
const REFRESH_INTERVAL_MS = 30_000;

const NEUTRAL = "bg-fill text-fg-muted border border-hairline text-xs";
const SUCCESS = "bg-success-tint/10 text-success border border-success-tint/20 text-xs";
const WARNING = "bg-warning-tint/10 text-warning border border-warning-tint/20 text-xs";
const DANGER = "bg-danger-tint/10 text-danger border border-danger-tint/20 text-xs";

const FRESHNESS_BADGES: Record<FreshnessState, { label: string; className: string }> = {
  loading: { label: "Loading", className: NEUTRAL },
  ok: { label: "Fresh", className: SUCCESS },
  degraded: { label: "Degraded", className: WARNING },
  unavailable: { label: "Unavailable", className: DANGER },
  misconfigured: { label: "Misconfigured", className: DANGER },
  incompatible: { label: "Incompatible", className: DANGER },
};

/** A snapshot age in whole seconds, as the status card shows it. */
function ageText(ageMs: number): string {
  return `${Math.floor(ageMs / 1000)} s`;
}

function listenerText(listener: GovernanceStatus["listener"]): string {
  if (listener === null) return "not started";
  return `${listener.state} for ${ageText(listener.heldMs)} (since ${listener.since})`;
}

function canaryText(canary: GovernanceStatus["canary"]): string {
  if (canary === null) return NOT_LOADED;
  const results = Object.entries(canary);
  if (results.length === 0) return NO_CANARY;
  return results.map(([kid, result]) => `${kid}: ${result}`).join(", ");
}

function skipText(skip: GovernanceStatusSkip): string {
  const where = [skip.level, skip.path].filter((part) => part !== undefined).join(", ");
  const codes = skip.envelopeCode === undefined ? skip.code : `${skip.code} (${skip.envelopeCode})`;
  return `${skip.id}${where === "" ? "" : ` [${where}]`}: ${codes}`;
}

function Row({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-fg-muted">{label}</span>
      <span data-testid={testId} className="text-fg-secondary break-all text-right">
        {value}
      </span>
    </div>
  );
}

function StatusBody({ status }: { status: GovernanceStatus }) {
  const badge = FRESHNESS_BADGES[status.freshness];
  const { contract, snapshot, lastError } = status;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center justify-between gap-4">
        <span className="text-fg-muted">State</span>
        <Badge data-testid="governance-freshness" className={badge.className}>
          {badge.label}
        </Badge>
      </div>
      <Row label="Source" value={`${status.source}, schema ${status.schema}`} testId="governance-source" />
      <Row
        label="Contract"
        value={`active ${contract.active ?? NOT_LOADED}; supported ${contract.supported.join(", ")}; published ${contract.published?.join(", ") ?? NOT_LOADED}`}
        testId="governance-contract"
      />
      <Row
        label="Snapshot age"
        value={snapshot === null ? NOT_LOADED : `${ageText(snapshot.ageMs)} (loaded ${snapshot.loadedAt})`}
        testId="governance-snapshot-age"
      />
      {lastError !== null && (
        <Row
          label="Last error"
          value={`${lastError.kind}${lastError.code === null ? "" : ` ${lastError.code}`} at ${lastError.at}: ${lastError.message}`}
          testId="governance-last-error"
        />
      )}
      <Row
        label="Admitted connections"
        value={String(status.admittedConnections ?? NOT_LOADED)}
        testId="governance-admitted"
      />
      <Row label="Key ids" value={status.keyringKids.join(", ")} testId="governance-kids" />
      <Row label="Seal canary" value={canaryText(status.canary)} testId="governance-canary" />
      <Row label="Listener" value={listenerText(status.listener)} testId="governance-listener" />
      <Row
        label="Last notification"
        value={status.listener?.lastNotificationAt ?? NOT_LOADED}
        testId="governance-last-notification"
      />
      <div className="space-y-1">
        <span className="text-xs text-fg-muted">Runtime settings</span>
        <ul className="space-y-1">
          {status.settings.map((setting) => (
            <li key={setting.key} data-testid="governance-setting" className="text-xs text-fg-secondary break-words">
              {"held" in setting
                ? `${setting.key}: ${setting.source}, held: ${setting.note}`
                : `${setting.key}: ${setting.source}`}
            </li>
          ))}
          {status.ignoredSettings.map(({ key, code }) => (
            <li
              key={`ignored:${key}`}
              data-testid="governance-ignored-setting"
              className="text-xs text-warning break-words"
            >
              {`${key}: ignored, ${code}`}
            </li>
          ))}
        </ul>
      </div>
      {status.skipped.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs text-fg-muted">{`Skipped (${status.skipped.length})`}</span>
          <ul className="space-y-1">
            {status.skipped.map((skip, index) => (
              <li
                // oxlint-disable-next-line react/no-array-index-key -- one row can be skipped at the read and at the write level; the list is read-only and rebuilt whole on every answer.
                key={`${index}:${skip.id}`}
                data-testid="governance-skip"
                className="text-xs text-fg-secondary break-words"
              >
                {skipText(skip)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The governance status (GET /api/admin/governance, spec 9.3): the freshness state, the contract versions, the
 * snapshot's age, the latest load failure with its full message, the admitted and skipped rows, the keyring's key ids,
 * the seal canary of each key id, the change notification listener's state, how long it has held and the last
 * notification, and where each runtime setting comes from with the setting keys that were ignored, so an admin sees
 * why a governed connection is missing, why a change arrives late, or why a setting has no effect, without the server
 * logs. Mounted on the Overview page beside SeedSourcesCard. Renders nothing with governance off and on a
 * failed read.
 */
export function GovernanceStatusCard() {
  const [status, setStatus] = useState<GovernanceStatus | null>(null);

  // Same ignore flag as SeedSourcesCard: an answer that lands after unmount wins nothing.
  useEffect(() => {
    let ignore = false;

    async function load() {
      try {
        const res = await appFetch("/api/admin/governance");
        const body = res.ok ? ((await res.json()) as GovernanceStatusResponse) : null;
        if (!ignore) setStatus(body === null ? null : body.governance);
      } catch {
        // A failed read hides the card; the next refresh asks again.
        if (!ignore) setStatus(null);
      }
    }

    void load();
    const interval = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => {
      ignore = true;
      clearInterval(interval);
    };
  }, []);

  if (status === null) return null;

  return (
    <section
      data-testid="governance-status-card"
      aria-labelledby="governance-status-heading"
      className="rounded-xl border border-hairline bg-panel p-5 space-y-3"
    >
      <h3 id="governance-status-heading" className="text-sm font-bold text-fg-secondary flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-brand" />
        {CARD_TITLE}
      </h3>
      <StatusBody status={status} />
    </section>
  );
}
