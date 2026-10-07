"use client";

import { useEffect, useState } from "react";
import { FileCog } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { SeedSourcesResponse } from "@/app/api/admin/seed-sources/route";
import { appFetch } from "@/lib/config/base-path";
import type {
  OperatorSourceName,
  OperatorSourceReport,
  OperatorSourceState,
  SourceNote,
} from "@/lib/seed/sources/types";

const CARD_TITLE = "Seed sources";
const CONNECTED_LABEL = "Connected";
const SKIPPED_LABEL = "Skipped";
const IGNORED_LABEL = "Ignored";
const FILE_NOT_FOUND_LABEL = "File not found";
const REFRESH_INTERVAL_MS = 60_000;

const SOURCE_LABELS: Record<OperatorSourceName, string> = {
  SEED_CONFIG_PATH: "Seed file",
  SEED_CONFIG_DIR: "Seed directory",
  SEED_CONFIG_INLINE: "Inline config",
  SEED_CONFIG_BASE64: "Inline config (base64)",
  SEED_CONNECTION: "Environment URLs",
};

const STATE_BADGES: Record<OperatorSourceState, { label: string; className: string }> = {
  ok: { label: "Loaded", className: "bg-success-tint/10 text-success border border-success-tint/20 text-xs" },
  empty: { label: "Empty", className: "bg-fill text-fg-muted border border-hairline text-xs" },
  missing: { label: "Not found", className: "bg-warning-tint/10 text-warning border border-warning-tint/20 text-xs" },
  error: { label: "Failed", className: "bg-danger-tint/10 text-danger border border-danger-tint/20 text-xs" },
};

function noteText(note: SourceNote): string {
  return note.kind === "ignored-variable"
    ? `Ignored variable ${note.name}`
    : `Ignored URL parameter ${note.name} in ${note.origin}`;
}

/** A zero-config install: every source empty, with nothing skipped and nothing ignored. */
function hasNothingToSay(sources: readonly OperatorSourceReport[]): boolean {
  return sources.every(
    (report) => report.state === "empty" && report.skipped.length === 0 && report.notes.length === 0,
  );
}

function SourceRow({ report }: { report: OperatorSourceReport }) {
  const badge = STATE_BADGES[report.state];
  return (
    <li
      data-testid={`seed-source-${report.source}`}
      className="space-y-2 border-t border-hairline pt-3 first:border-t-0 first:pt-0"
    >
      <div className="flex items-center justify-between gap-4">
        <span className="text-fg-secondary">{SOURCE_LABELS[report.source]}</span>
        <Badge className={badge.className}>{badge.label}</Badge>
      </div>
      {report.state === "missing" ? (
        <p className="text-xs text-warning break-all">{`${FILE_NOT_FOUND_LABEL}: ${report.location ?? report.source}`}</p>
      ) : (
        report.location !== null && <p className="text-xs text-fg-muted break-all">{report.location}</p>
      )}
      {report.error !== null && (
        <p data-testid="seed-source-error" className="text-xs text-danger break-words">
          {`${report.error.code}: ${report.error.message}`}
        </p>
      )}
      {report.connected.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs text-fg-muted">{`${CONNECTED_LABEL} (${report.connected.length})`}</span>
          <ul className="space-y-1">
            {report.connected.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-4">
                <span className="text-fg-secondary">{entry.name}</span>
                <Badge variant="secondary" className="text-xs">
                  {entry.type}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.skipped.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs text-fg-muted">{`${SKIPPED_LABEL} (${report.skipped.length})`}</span>
          <ul className="space-y-1">
            {report.skipped.map((skip, index) => (
              <li
                // oxlint-disable-next-line react/no-array-index-key -- a source's own skip and a resolution skip can share an id, origin and reason; the list is read-only and rebuilt whole on every answer.
                key={`${index}:${skip.id}`}
                data-testid="seed-source-skip"
                className="text-xs text-fg-secondary break-words"
              >
                {`${skip.id} (${skip.origin}): ${skip.reason}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.notes.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs text-fg-muted">{`${IGNORED_LABEL} (${report.notes.length})`}</span>
          <ul className="space-y-1">
            {report.notes.map((note, index) => (
              <li
                // oxlint-disable-next-line react/no-array-index-key -- two entries can ignore the same parameter name in one origin; the list is read-only and rebuilt whole on every answer.
                key={`${index}:${note.name}`}
                data-testid="seed-source-note"
                className="text-xs text-fg-secondary break-words"
              >
                {noteText(note)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/**
 * The operator seed sources' status (GET /api/admin/seed-sources, Spec A 5.3): for each enabled source its
 * state, path, error, connections, skips and ignored names, so an admin sees why a seed connection is
 * missing without the server logs. Mounted on the Overview page beside PlatformDiscoveryCard, not inside it,
 * because that card hides itself whenever CapRover discovery is off. Renders nothing on a failed read and on
 * a zero-config install.
 */
export function SeedSourcesCard() {
  const [sources, setSources] = useState<OperatorSourceReport[] | null>(null);

  // Same ignore flag as PlatformDiscoveryCard: an answer that lands after unmount wins nothing.
  useEffect(() => {
    let ignore = false;

    async function load() {
      try {
        const res = await appFetch("/api/admin/seed-sources");
        const body = res.ok ? ((await res.json()) as SeedSourcesResponse) : null;
        if (!ignore) setSources(body === null ? null : body.sources);
      } catch {
        // A failed read hides the card; the next refresh asks again.
        if (!ignore) setSources(null);
      }
    }

    void load();
    const interval = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => {
      ignore = true;
      clearInterval(interval);
    };
  }, []);

  if (sources === null || hasNothingToSay(sources)) return null;

  return (
    <section
      data-testid="seed-sources-card"
      aria-labelledby="seed-sources-heading"
      className="rounded-xl border border-hairline bg-panel p-5 space-y-3"
    >
      <h3 id="seed-sources-heading" className="text-sm font-bold text-fg-secondary flex items-center gap-2">
        <FileCog className="h-4 w-4 text-brand" />
        {CARD_TITLE}
      </h3>
      <ul className="space-y-3 text-sm">
        {sources.map((report) => (
          <SourceRow key={report.source} report={report} />
        ))}
      </ul>
    </section>
  );
}
