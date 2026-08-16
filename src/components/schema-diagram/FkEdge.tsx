"use client";

import React, { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import type { FkFlowEdge } from "./graph";
import { useEdgeHighlight } from "./highlight-store";

/**
 * FK edge that reads its highlight state from the highlight store instead of
 * edge data, so selecting a table never rebuilds the edges array. The label
 * is only rendered while highlighted - label DOM for every edge is one of the
 * bigger costs on schemas with hundreds of relationships.
 */
export const FkEdge = memo(function FkEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<FkFlowEdge>) {
  const highlight = useEdgeHighlight(source, target);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const heuristic = data?.heuristic === true;
  const stroke = heuristic ? "#6b7280" : "#3b82f6";
  const baseOpacity = heuristic ? 0.3 : 0.4;
  const opacity = highlight === "highlighted" ? 1 : highlight === "dimmed" ? 0.12 : baseOpacity;
  const strokeWidth = highlight === "highlighted" ? 2 : heuristic ? 1 : 1.5;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{ stroke, strokeWidth, opacity, strokeDasharray: heuristic ? "4 2" : undefined }}
      />
      {highlight === "highlighted" && (
        <EdgeLabelRenderer>
          <div
            className="absolute bg-raised/80 border border-hairline-strong rounded px-1 text-[0.5625rem] text-fg-tertiary pointer-events-none"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {heuristic ? "1:N?" : "1:N"}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
