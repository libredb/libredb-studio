"use client";

import { useEffect, useState } from "react";
import { Radar, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { DiscoveryResponse } from "@/app/api/admin/discovery/route";
import { appFetch } from "@/lib/config/base-path";
import type { DiscoveryState } from "@/lib/seed/discovery-loader";

const CAPROVER_TITLE = "Platform Discovery (CapRover)";
const KUBERNETES_TITLE = "Platform Discovery (Kubernetes)";
const STATE_LABEL = "State";
const LAST_SCAN_LABEL = "Last successful scan";
const NEVER_LABEL = "Never";
const LAST_ERROR_LABEL = "Last error";
const NAMESPACES_LABEL = "Namespaces";
const NAMESPACE_READ = "Read";
const CONNECTED_LABEL = "Connected";
const SKIPPED_LABEL = "Skipped";
const NONE_LABEL = "None";
const CAPROVER_COOKIE_WARNING =
  "The Studio session cookie can travel over plain HTTP, and it unlocks every discovered database. Enable HTTPS and Force HTTPS for this app in CapRover, then set AUTH_COOKIE_SECURE to true and restart.";
const KUBERNETES_COOKIE_WARNING =
  "The Studio session cookie can travel over plain HTTP, and it unlocks the discovered databases its user may open. Serve Studio over HTTPS, then set AUTH_COOKIE_SECURE to true and restart.";
const REFRESH_INTERVAL_MS = 60000;

const STATE_BADGES: Record<DiscoveryState, { label: string; className: string }> = {
  ok: { label: "Running", className: "bg-success-tint/10 text-success border border-success-tint/20 text-xs" },
  waiting: { label: "Waiting", className: "bg-warning-tint/10 text-warning border border-warning-tint/20 text-xs" },
  stale: { label: "Stale", className: "bg-warning-tint/10 text-warning border border-warning-tint/20 text-xs" },
  error: { label: "Failed", className: "bg-danger-tint/10 text-danger border border-danger-tint/20 text-xs" },
};

/** What one source's section shows: names, types and reasons only, never a host or a credential. */
interface SectionProps {
  testId: string;
  headingId: string;
  errorTestId: string;
  title: string;
  cookieWarning: string;
  insecureTransport: boolean;
  state: DiscoveryState;
  message: string;
  generatedAt: string | null;
  error: { code: string; message: string } | null;
  /** The namespaces a source reads, when it reads any. */
  namespaces?: { name: string; error: { code: string; message: string } | null }[];
  connected: { name: string; type: string }[];
  skipped: { label: string; reason: string }[];
}

function DiscoverySection(props: SectionProps) {
  const { testId, headingId, title, state, message, generatedAt, error, namespaces, connected, skipped } = props;
  const badge = STATE_BADGES[state];
  const showCookieWarning = connected.length > 0 && props.insecureTransport;

  return (
    <section
      data-testid={testId}
      aria-labelledby={headingId}
      className="rounded-xl border border-hairline bg-panel p-5 space-y-3"
    >
      <h3 id={headingId} className="text-sm font-bold text-fg-secondary flex items-center gap-2">
        <Radar className="h-4 w-4 text-brand" />
        {title}
      </h3>
      {showCookieWarning && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-warning-tint/20 bg-warning-tint/10 p-3 text-xs text-warning"
        >
          <TriangleAlert className="h-4 w-4 shrink-0" />
          <span>{props.cookieWarning}</span>
        </div>
      )}
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between gap-4">
          <span className="text-fg-muted">{STATE_LABEL}</span>
          <Badge className={badge.className}>{badge.label}</Badge>
        </div>
        <p className="text-fg-secondary">{message}</p>
        <Separator className="bg-fill" />
        <div className="flex items-center justify-between gap-4">
          <span className="text-fg-muted">{LAST_SCAN_LABEL}</span>
          <span className="text-fg-secondary">
            {generatedAt ? new Date(generatedAt).toLocaleString() : NEVER_LABEL}
          </span>
        </div>
        {error && (
          <>
            <Separator className="bg-fill" />
            <div className="flex items-start justify-between gap-4">
              <span className="text-fg-muted">{LAST_ERROR_LABEL}</span>
              <span data-testid={props.errorTestId} className="text-danger text-right">
                {`${error.code}: ${error.message}`}
              </span>
            </div>
          </>
        )}
        {namespaces && (
          <>
            <Separator className="bg-fill" />
            <div className="space-y-1.5">
              <span className="text-fg-muted">{`${NAMESPACES_LABEL} (${namespaces.length})`}</span>
              {namespaces.length === 0 ? (
                <p className="text-xs text-fg-muted">{NONE_LABEL}</p>
              ) : (
                <ul className="space-y-1">
                  {namespaces.map((entry) => (
                    <li key={entry.name} className="flex items-start justify-between gap-4">
                      <span className="text-fg-secondary">{entry.name}</span>
                      {entry.error ? (
                        <span className="text-xs text-danger text-right">{`${entry.error.code}: ${entry.error.message}`}</span>
                      ) : (
                        <span className="text-xs text-fg-muted text-right">{NAMESPACE_READ}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
        <Separator className="bg-fill" />
        <div className="space-y-1.5">
          <span className="text-fg-muted">{`${CONNECTED_LABEL} (${connected.length})`}</span>
          {connected.length === 0 ? (
            <p className="text-xs text-fg-muted">{NONE_LABEL}</p>
          ) : (
            <ul className="space-y-1">
              {connected.map((entry) => (
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
          <span className="text-fg-muted">{`${SKIPPED_LABEL} (${skipped.length})`}</span>
          {skipped.length === 0 ? (
            <p className="text-xs text-fg-muted">{NONE_LABEL}</p>
          ) : (
            <ul className="space-y-1">
              {skipped.map((entry, index) => (
                <li
                  // oxlint-disable-next-line react/no-array-index-key -- srv-captain--foo and a bare foo are both "foo", so two entries can share a name and a reason; the list is read-only and rebuilt whole on every answer.
                  key={`${index}:${entry.label}:${entry.reason}`}
                  className="flex items-start justify-between gap-4"
                >
                  <span className="text-fg-secondary">{entry.label}</span>
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

/**
 * The platform discovery sources' status (GET /api/admin/discovery): one section for CapRover and one for
 * Kubernetes, each shown while its source is on. Mounted on the Overview page above OverviewTab, not inside it, so it
 * shows both when OverviewTab returns its early empty state (no connection at all) and when it renders the full
 * overview. Renders nothing on a non-OK answer or when every source is off.
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

  if (data === null) return null;
  const { discovery, kubernetesDiscovery: kubernetes, transport } = data;
  if (discovery === null && kubernetes === null) return null;
  const insecureTransport = transport !== undefined && (transport.plainHttp || transport.cookieSecureOff);

  return (
    <>
      {discovery !== null && (
        <DiscoverySection
          testId="platform-discovery-card"
          headingId="platform-discovery-heading"
          errorTestId="platform-discovery-error"
          title={CAPROVER_TITLE}
          cookieWarning={CAPROVER_COOKIE_WARNING}
          insecureTransport={insecureTransport}
          state={discovery.state}
          message={discovery.message}
          generatedAt={discovery.generatedAt}
          error={discovery.error}
          connected={discovery.connected}
          skipped={discovery.skipped.map((entry) => ({ label: entry.appName, reason: entry.reason }))}
        />
      )}
      {kubernetes !== null && (
        <DiscoverySection
          testId="kubernetes-discovery-card"
          headingId="kubernetes-discovery-heading"
          errorTestId="kubernetes-discovery-error"
          title={KUBERNETES_TITLE}
          cookieWarning={KUBERNETES_COOKIE_WARNING}
          insecureTransport={insecureTransport}
          state={kubernetes.state}
          message={kubernetes.message}
          generatedAt={kubernetes.generatedAt}
          error={kubernetes.error}
          namespaces={kubernetes.namespaces}
          connected={kubernetes.connected}
          skipped={kubernetes.skipped.map((entry) => ({ label: entry.resource, reason: entry.reason }))}
        />
      )}
    </>
  );
}
