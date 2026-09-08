"use client";

import React from "react";
import { Info, TriangleAlert } from "lucide-react";
import { describesAbsentObject } from "@/lib/monitoring-absence";

interface PanelUnavailableProps {
  /** The engine's own sentence, from `MonitoringData.errors[panel]`. */
  message: string;
}

/**
 * Shown in place of ONE monitoring panel whose read failed.
 *
 * `getMonitoringData` reads the seven panels independently, so a panel the engine cannot
 * answer is absent from the payload with its own message recorded under `errors` while the
 * rest of the dashboard still renders. This is the honest rendering of that absence: not an
 * empty table (which would claim the engine answered "nothing"), and not the whole-dashboard
 * error state (which would discard the panels that did answer). The engine's own sentence is
 * shown verbatim, because it is the only text that says what the database actually refused -
 * StarRocks 3.3 answers "Unknown table 'information_schema.PROCESSLIST'" for active sessions,
 * and that sentence is what tells the user the table is not there.
 *
 * The headline above that sentence distinguishes the two absences `describesAbsentObject`
 * separates: an object the engine never had is a property of the engine and no fault, while
 * a statement it refused might succeed in another shape and is worth attention. Materialize
 * reaches this component on three panels with nothing wrong; Cloudberry reaches it on two
 * with a planner restriction a reader can act on. Same component, different sentence.
 */
export function PanelUnavailable({ message }: PanelUnavailableProps) {
  const isEngineLimit = describesAbsentObject(message);
  const Icon = isEngineLimit ? Info : TriangleAlert;

  return (
    <div className="text-center py-8 text-muted-foreground" data-testid="panel-unavailable">
      <Icon strokeWidth={1.5} className="h-8 w-8 mx-auto mb-2 opacity-50" />
      <p className="text-xs">
        {isEngineLimit ? "This engine does not publish this." : "This database could not answer this panel."}
      </p>
      <p className="text-xs mt-1 max-w-xl mx-auto break-words" data-testid="panel-unavailable-message">
        {message}
      </p>
    </div>
  );
}
