"use client";

/**
 * The Graph tab: one result's nodes and relationships, drawn
 *
 * It draws only what the statement returned (`buildResultGraph`), never a second
 * query, and masks exactly as the grid does: the same `maskingInForce` decision, and
 * a property whose key the config flags is masked before any caption, the inspector
 * or an export can see it.
 *
 * The canvas library arrives through `loadCytoscape`, awaited inside an effect, so
 * nothing here touches `window` at module load or on the server. Tests pass a
 * factory of their own instead of mocking a module. A load that fails is rethrown
 * during render, so it lands in the panel's `ChunkBoundary` like any other view
 * whose chunk never arrived.
 *
 * Keyboard: the canvas is focusable; `+` and `=` zoom in, `-` zooms out, `0` fits,
 * the arrow keys pan, and Escape clears the selection. The toolbar, the inspector
 * and the legend are ordinary DOM, reached by Tab.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileBraces, ImageDown, Maximize, RefreshCw, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  type Core,
  type CytoscapeFactory,
  type EventObject,
  fcoseLayout,
  loadCytoscape as defaultLoadCytoscape,
} from "@/components/results-graph/cytoscape-host";
import {
  MAX_GRAPH_NODES,
  capNotice,
  droppedNotice,
  graphAriaLabel,
  graphElements,
  graphJson,
  graphMask,
  graphStylesheet,
  nodeKey,
  propertyText,
  relationshipKey,
} from "@/components/results-graph/graph-canvas";
import { ViewLoading } from "@/components/LazyView";
import { Button } from "@/components/ui/button";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import { chartTheme } from "@/lib/charts/palette";
import { type MaskingConfig, maskingInForce } from "@/lib/data-masking";
import {
  type GraphViewNode,
  type GraphViewRelationship,
  type ResultGraph,
  buildResultGraph,
  paletteColor,
} from "@/lib/db/graph/result-graph";
import { downloadBlob } from "@/lib/export/download";
import type { QueryResult } from "@/lib/types";

/** How far one zoom step or one arrow key moves the view. */
const ZOOM_STEP = 1.25;
const PAN_STEP = 40;
/** Room left around the graph when it is fitted. */
const FIT_PADDING = 30;

const PAN_KEYS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: PAN_STEP, y: 0 },
  ArrowRight: { x: -PAN_STEP, y: 0 },
  ArrowUp: { x: 0, y: PAN_STEP },
  ArrowDown: { x: 0, y: -PAN_STEP },
};

interface GraphViewProps {
  result: QueryResult;
  // The grid's masking inputs, handed down the same way (graph view spec, Masking).
  maskingEnabled: boolean | undefined;
  userRole: string | undefined;
  maskingConfig: MaskingConfig;
  /** Loads the canvas library; a test passes its own. */
  loadCytoscape?: CytoscapeFactory;
  /** Hands a file to the user; a test passes its own. */
  save?: (blob: Blob, fileName: string) => void;
}

type Tool = "fit" | "zoomIn" | "zoomOut" | "relayout";

const TOOLS: readonly { tool: Tool; label: string; icon: typeof ZoomIn }[] = [
  { tool: "fit", label: "Fit the graph", icon: Maximize },
  { tool: "zoomIn", label: "Zoom in", icon: ZoomIn },
  { tool: "zoomOut", label: "Zoom out", icon: ZoomOut },
  { tool: "relayout", label: "Re-layout", icon: RefreshCw },
];

type Selected = { kind: "node"; item: GraphViewNode } | { kind: "relationship"; item: GraphViewRelationship };

export function GraphView({
  result,
  maskingEnabled,
  userRole,
  maskingConfig,
  loadCytoscape = defaultLoadCytoscape,
  save = downloadBlob,
}: GraphViewProps) {
  const theme = chartTheme(useEffectiveTheme());
  const graph = useMemo(
    () =>
      buildResultGraph(result.rows, result.fields, {
        maxNodes: MAX_GRAPH_NODES,
        mask: graphMask(maskingConfig, maskingInForce(userRole, maskingConfig, maskingEnabled)),
      }),
    [result, maskingConfig, userRole, maskingEnabled],
  );
  const stylesheet = useMemo(() => graphStylesheet(theme, graph.labels.length), [theme, graph]);
  const byKey = useMemo(
    () =>
      new Map<string, Selected>([
        ...graph.nodes.map((item) => [nodeKey(item.id), { kind: "node", item }] as const),
        ...graph.relationships.map((item) => [relationshipKey(item.id), { kind: "relationship", item }] as const),
      ]),
    [graph],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const stylesheetRef = useRef(stylesheet);
  // Each is kept with the graph it belongs to, so a new result starts with neither.
  const [readyFor, setReadyFor] = useState<ResultGraph | null>(null);
  const [selection, setSelection] = useState<{ graph: ResultGraph; key: string } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  if (loadError !== null) throw loadError;

  const ready = readyFor === graph;
  const selected = selection?.graph === graph ? byKey.get(selection.key) : undefined;

  // Declared before the canvas effect, so a canvas built later starts from the current theme.
  useEffect(() => {
    stylesheetRef.current = stylesheet;
    cyRef.current?.style(stylesheet);
  }, [stylesheet]);

  useEffect(() => {
    let cancelled = false;
    let cy: Core | null = null;
    loadCytoscape().then(
      (create) => {
        if (cancelled) return;
        const instance = create({
          container: containerRef.current,
          elements: graphElements(graph),
          style: stylesheetRef.current,
          minZoom: 0.1,
          maxZoom: 4,
          boxSelectionEnabled: false,
        });
        cy = instance;
        instance.layout(fcoseLayout()).run();
        instance.on("tap", "node, edge", (event: EventObject) => setSelection({ graph, key: event.target.id() }));
        instance.on("tap", (event: EventObject) => {
          if (event.target === instance) setSelection(null);
        });
        cyRef.current = instance;
        setReadyFor(graph);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(error);
      },
    );
    return () => {
      cancelled = true;
      cy?.destroy();
      cyRef.current = null;
    };
  }, [graph, loadCytoscape]);

  const withCanvas = useCallback((act: (cy: Core) => void) => {
    if (cyRef.current) act(cyRef.current);
  }, []);

  const zoomBy = (factor: number) =>
    withCanvas((cy) =>
      cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }),
    );
  const fit = () => withCanvas((cy) => cy.fit(undefined, FIT_PADDING));
  const relayout = () => withCanvas((cy) => cy.layout(fcoseLayout()).run());
  const clearSelection = () => {
    withCanvas((cy) => cy.elements().unselect());
    setSelection(null);
  };
  const exportPng = () =>
    withCanvas((cy) =>
      save(cy.png({ output: "blob", full: true, scale: 2, bg: theme.exportBackground }), `graph_${Date.now()}.png`),
    );
  const exportJson = () => save(new Blob([graphJson(graph)], { type: "application/json" }), `graph_${Date.now()}.json`);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const pan = PAN_KEYS[event.key];
    if (pan) withCanvas((cy) => cy.panBy(pan));
    else if (event.key === "+" || event.key === "=") zoomBy(ZOOM_STEP);
    else if (event.key === "-") zoomBy(1 / ZOOM_STEP);
    else if (event.key === "0") fit();
    else if (event.key === "Escape") clearSelection();
    else return;
    event.preventDefault();
  };

  const notices = [capNotice(graph), droppedNotice(graph)].filter((notice) => notice !== null);
  const runTool = (tool: Tool) => {
    if (tool === "fit") fit();
    else if (tool === "zoomIn") zoomBy(ZOOM_STEP);
    else if (tool === "zoomOut") zoomBy(1 / ZOOM_STEP);
    else relayout();
  };

  return (
    <div className="h-full flex flex-col bg-surface" data-testid="graph-view">
      <div className="h-8 shrink-0 flex items-center gap-1 px-2 border-b border-hairline overflow-x-auto">
        {TOOLS.map(({ tool, label, icon: Icon }) => (
          <Button
            key={label}
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-fg-muted hover:text-fg-bright"
            aria-label={label}
            title={label}
            disabled={!ready}
            onClick={() => runTool(tool)}
          >
            <Icon strokeWidth={1.5} className="w-3.5 h-3.5" />
          </Button>
        ))}
        <span className="mx-1 h-4 w-px bg-hairline" aria-hidden="true" />
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-fg-muted hover:text-fg-bright gap-1"
          aria-label="Export PNG"
          disabled={!ready}
          onClick={exportPng}
        >
          <ImageDown strokeWidth={1.5} className="w-3.5 h-3.5" /> PNG
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-fg-muted hover:text-fg-bright gap-1"
          aria-label="Export JSON"
          disabled={!ready}
          onClick={exportJson}
        >
          <FileBraces strokeWidth={1.5} className="w-3.5 h-3.5" /> JSON
        </Button>
      </div>

      {notices.map((notice) => (
        <p key={notice} className="shrink-0 px-3 py-1 text-xs text-warning border-b border-hairline">
          {notice}
        </p>
      ))}

      {/* The inspector stacks under the canvas below `md`, beside it from `md` up. */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <div className="relative flex-1 min-h-0 min-w-0">
          {/*
            oxlint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex --
            WAI-ARIA's application role is the one for a widget that takes its own keys,
            which this canvas does; the plugin counts that role as non-interactive.
          */}
          <div
            ref={containerRef}
            role="application"
            aria-label={graphAriaLabel(graph)}
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="absolute inset-0 bg-sunken focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-hue-blue"
          />
          {/* oxlint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
          {!ready && <ViewLoading label="Drawing the graph" className="absolute inset-0" />}
        </div>
        <div className="shrink-0 max-h-[40%] md:max-h-none md:w-72 overflow-auto border-t md:border-t-0 md:border-l border-hairline">
          {selected && <Inspector selected={selected} graph={graph} onClose={clearSelection} />}
          <Legend graph={graph} palette={theme.series} />
        </div>
      </div>
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      data-swatch=""
      aria-hidden="true"
      className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
      style={{ backgroundColor: color }}
    />
  );
}

function Legend({ graph, palette }: { graph: ResultGraph; palette: readonly string[] }) {
  return (
    <section aria-label="Legend" className="p-3 text-xs">
      {graph.labels.length > 0 && (
        <>
          <h3 className="mb-1 font-medium text-fg-secondary">Labels</h3>
          <ul className="mb-3 space-y-1">
            {graph.labels.map(({ label, count, colorIndex }) => (
              <li key={label} className="flex items-center gap-2">
                <Swatch color={paletteColor(colorIndex, palette) as string} />
                <span className="truncate text-fg">{label}</span>
                <span className="ml-auto font-mono text-fg-muted">{count}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {graph.relationshipTypes.length > 0 && (
        <>
          <h3 className="mb-1 font-medium text-fg-secondary">Relationship types</h3>
          <ul className="space-y-1">
            {graph.relationshipTypes.map(({ type, count }) => (
              <li key={type} className="flex items-center gap-2">
                <span className="truncate font-mono text-fg">{type}</span>
                <span className="ml-auto font-mono text-fg-muted">{count}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Inspector({ selected, graph, onClose }: { selected: Selected; graph: ResultGraph; onClose: () => void }) {
  const captionOfNode = (id: string) => graph.nodes.find((node) => node.id === id)?.caption;
  const { value } = selected.item;
  const properties = Object.entries(value.properties);
  return (
    <section aria-label="Inspector" className="p-3 text-xs border-b border-hairline">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-medium text-fg-secondary">{selected.kind === "node" ? "Node" : "Relationship"}</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the inspector"
          className="p-1 rounded text-fg-tertiary hover:bg-fill hover:text-fg transition-colors"
        >
          <X strokeWidth={1.5} className="w-3 h-3" />
        </button>
      </div>
      <div className="mb-2 flex flex-wrap gap-1">
        {(selected.kind === "node" ? selected.item.value.labels : [selected.item.value.type]).map((name) => (
          <span key={name} className="px-1.5 py-0.5 rounded bg-fill font-mono text-fg">
            {name}
          </span>
        ))}
      </div>
      <dl className="space-y-1">
        <dt className="text-fg-muted">elementId</dt>
        <dd className="font-mono text-fg break-all">{value.elementId}</dd>
        {selected.kind === "relationship" && (
          <>
            <dt className="text-fg-muted">From, to</dt>
            <dd className="text-fg break-all">
              {`${captionOfNode(selected.item.source)} → ${captionOfNode(selected.item.target)}`}
            </dd>
          </>
        )}
      </dl>
      <h4 className="mt-3 mb-1 font-medium text-fg-secondary">Properties</h4>
      {properties.length === 0 ? (
        <p className="text-fg-muted">No properties</p>
      ) : (
        <dl className="space-y-1">
          {properties.map(([key, property]) => (
            <div key={key}>
              <dt className="text-fg-muted">{key}</dt>
              <dd className="font-mono text-fg break-all whitespace-pre-wrap">{propertyText(property)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
