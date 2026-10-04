"use client";

import { useEffect, useState } from "react";
import { Radar, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { appFetch } from "@/lib/config/base-path";
import type { DiscoveryState, DiscoveryStatus } from "@/lib/seed/discovery-loader";

const CARD_TITLE = "Platform Discovery (CapRover)";
const STATE_LABEL = "State";
const LAST_SCAN_LABEL = "Last successful scan";
const NEVER_LABEL = "Never";
const LAST_ERROR_LABEL = "Last error";
const CONNECTED_LABEL = "Connected";
const SKIPPED_LABEL = "Skipped";
const NONE_LABEL = "None";
const COOKIE_WARNING =
  "The Studio session cookie can travel over plain HTTP, and it unlocks every discovered database. Enable HTTPS and Force HTTPS for this app in CapRover, then set AUTH_COOKIE_SECURE to true and restart.";
const REFRESH_INTERVAL_MS = 60000;

const STATE_BADGES: Record<DiscoveryState, { label: string; className: string }> = {
  ok: { label: "Running", className: "bg-success-tint/10 text-success border border-success-tint/20 text-xs" },
  waiting: { label: "Waiting", className: "bg-warning-tint/10 text-warning border border-warning-tint/20 text-xs" },
  stale: { label: "Stale", className: "bg-warning-tint/10 text-warning border border-warning-tint/20 text-xs" },
  error: { label: "Failed", className: "bg-danger-tint/10 text-danger border border-danger-tint/20 text-xs" },
};

type DiscoveryResponse =
  | { discovery: null }
  | { discovery: DiscoveryStatus; transport: { plainHttp: boolean; cookieSecureOff: boolean } };

/**
 * The CapRover discovery status (GET /api/admin/discovery). Mounted on the Overview page above
 * OverviewTab, because OverviewTab returns its empty state early when there are no connections,
 * which is exactly when discovery has failed. Renders nothing on a non-OK answer or when discovery is off.
 */
export function PlatformDiscoveryCard() {
  const [data, setData] = useState<DiscoveryResponse | null>(null);

  // Same ignore flag as OverviewTab's fleet-health effect: an answer that lands after unmount wins nothing.
  useEffect(() => {
    let ignore = false;

    async function load() {
      try {
        const res = await appFetch("/api/admin/discovery");
        const body = res.ok ? ((await res.json()) as DiscoveryResponse) : null;
        if (!ignore) setData(body);
      } catch {
        // A failed read hides the card; the next refresh asks again.
        if (!ignore) setData(null);
      }
    }

    void load();
    const interval = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => {
      ignore = true;
      clearInterval(interval);
    };
  }, []);

  if (data === null || data.discovery === null) return null;
  const { discovery, transport } = data;
  const badge = STATE_BADGES[discovery.state];
  const showCookieWarning = discovery.connected.length > 0 && (transport.plainHttp || transport.cookieSecureOff);

  return (
    <section data-testid="platform-discovery-card" className="rounded-xl border border-hairline bg-panel p-5 space-y-3">
      <h3 className="text-sm font-bold text-fg-secondary flex items-center gap-2">
        <Radar className="h-4 w-4 text-brand" />
        {CARD_TITLE}
      </h3>
      {showCookieWarning && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-warning-tint/20 bg-warning-tint/10 p-3 text-xs text-warning"
        >
          <TriangleAlert className="h-4 w-4 shrink-0" />
          <span>{COOKIE_WARNING}</span>
        </div>
      )}
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between gap-4">
          <span className="text-fg-muted">{STATE_LABEL}</span>
          <Badge className={badge.className}>{badge.label}</Badge>
        </div>
        <p className="text-fg-secondary">{discovery.message}</p>
        <Separator className="bg-fill" />
        <div className="flex items-center justify-between gap-4">
          <span className="text-fg-muted">{LAST_SCAN_LABEL}</span>
          <span className="text-fg-secondary">
            {discovery.generatedAt ? new Date(discovery.generatedAt).toLocaleString() : NEVER_LABEL}
          </span>
        </div>
        {discovery.error && (
          <>
            <Separator className="bg-fill" />
            <div className="flex items-start justify-between gap-4">
              <span className="text-fg-muted">{LAST_ERROR_LABEL}</span>
              <span data-testid="platform-discovery-error" className="text-danger text-right">
                {`${discovery.error.code}: ${discovery.error.message}`}
              </span>
            </div>
          </>
        )}
        <Separator className="bg-fill" />
        <div className="space-y-1.5">
          <span className="text-fg-muted">{`${CONNECTED_LABEL} (${discovery.connected.length})`}</span>
          {discovery.connected.length === 0 ? (
            <p className="text-xs text-fg-muted">{NONE_LABEL}</p>
          ) : (
            <ul className="space-y-1">
              {discovery.connected.map((entry) => (
                <li key={`${entry.type}:${entry.name}`} className="flex items-center justify-between gap-4">
                  <span className="text-fg-secondary">{entry.name}</span>
                  <Badge variant="secondary" className="text-xs">
                    {entry.type}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Separator className="bg-fill" />
        <div className="space-y-1.5">
          <span className="text-fg-muted">{`${SKIPPED_LABEL} (${discovery.skipped.length})`}</span>
          {discovery.skipped.length === 0 ? (
            <p className="text-xs text-fg-muted">{NONE_LABEL}</p>
          ) : (
            <ul className="space-y-1">
              {discovery.skipped.map((entry, index) => (
                <li
                  // oxlint-disable-next-line react/no-array-index-key -- srv-captain--foo and a bare foo are both "foo", so two entries can share a name and a reason; the list is read-only and rebuilt whole on every answer.
                  key={`${index}:${entry.appName}:${entry.reason}`}
                  className="flex items-start justify-between gap-4"
                >
                  <span className="text-fg-secondary">{entry.appName}</span>
                  <span className="text-xs text-fg-muted text-right">{entry.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
