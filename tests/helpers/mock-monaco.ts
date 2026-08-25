/**
 * Monaco Editor mock for component tests
 * Replaces the heavy Monaco Editor with a simple textarea
 */
import { mock } from "bun:test";

export function setupMonacoMock() {
  mock.module("@monaco-editor/react", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return {
      default: function MockEditor(props: {
        value?: string;
        onChange?: (value: string | undefined) => void;
        language?: string;
        "data-testid"?: string;
      }) {
        return React.createElement("textarea", {
          "data-testid": props["data-testid"] ?? "mock-monaco-editor",
          value: props.value ?? "",
          onChange: (e: { target: { value: string } }) => props.onChange?.(e.target.value),
          "aria-label": `${props.language ?? "sql"} editor`,
        });
      },
      Editor: function MockEditor(props: {
        value?: string;
        onChange?: (value: string | undefined) => void;
        language?: string;
      }) {
        return React.createElement("textarea", {
          "data-testid": "mock-monaco-editor",
          value: props.value ?? "",
          onChange: (e: { target: { value: string } }) => props.onChange?.(e.target.value),
        });
      },
      loader: {
        init: mock(() => Promise.resolve()),
        config: mock(() => {}),
        __getMonacoInstance: mock(() => null),
      },
    };
  });
}

export function setupRechartssMock() {
  mock.module("recharts", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return {
      ResponsiveContainer: ({ children }: { children: unknown }) => children,
      AreaChart: ({ children }: { children: unknown }) =>
        React.createElement("div", { "data-testid": "mock-area-chart" }, children),
      BarChart: ({ children }: { children: unknown }) =>
        React.createElement("div", { "data-testid": "mock-bar-chart" }, children),
      LineChart: ({ children }: { children: unknown }) =>
        React.createElement("div", { "data-testid": "mock-line-chart" }, children),
      RadialBarChart: ({ children }: { children: unknown }) =>
        React.createElement("div", { "data-testid": "mock-radial-chart" }, children),
      Area: () => null,
      Bar: () => null,
      Line: () => null,
      RadialBar: () => null,
      XAxis: () => null,
      YAxis: () => null,
      CartesianGrid: () => null,
      // Surfaces `contentStyle` so a test can check which palette the chart handed
      // the tooltip — recharts inline-styles it, so there is no class to assert on.
      Tooltip: ({ contentStyle }: { contentStyle?: Record<string, unknown> }) =>
        React.createElement("div", {
          "data-testid": "mock-tooltip",
          "data-bg": contentStyle?.backgroundColor as string | undefined,
          "data-color": contentStyle?.color as string | undefined,
        }),
      Legend: () => null,
      PolarAngleAxis: () => null,
    };
  });
}

export function setupXYFlowMock() {
  mock.module("@xyflow/react", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return {
      ReactFlow: ({ children }: { children: unknown }) =>
        React.createElement("div", { "data-testid": "mock-react-flow" }, children),
      ReactFlowProvider: ({ children }: { children: unknown }) => children,
      MiniMap: () => React.createElement("div", { "data-testid": "mock-minimap" }),
      Controls: () => null,
      Background: () => null,
      Handle: () => null,
      useNodesState: () => [[], mock(() => {}), mock(() => {})],
      useEdgesState: () => [[], mock(() => {}), mock(() => {})],
      useReactFlow: () => ({ fitView: mock(() => {}), getNodes: mock(() => []), getEdges: mock(() => []) }),
      Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
      MarkerType: { ArrowClosed: "arrowclosed" },
      Panel: ({ children, position }: { children: unknown; position?: string }) =>
        React.createElement("div", { "data-testid": `mock-panel-${position || "default"}` }, children),
    };
  });
}

export function setupFramerMotionMock() {
  mock.module("framer-motion", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    const motionPropKeys = [
      "initial",
      "animate",
      "exit",
      "transition",
      "variants",
      "whileHover",
      "whileTap",
      "whileInView",
      "layout",
      "layoutId",
    ];
    const passthrough = ({ children, ...props }: Record<string, unknown>) => {
      // Real framer-motion resolves function-valued variants (e.g. `visible: (i) => ({...})`)
      // by invoking them with the `custom` prop. Emulate that here so components relying on
      // per-item computed variants get exercised under test.
      const variants = props.variants as Record<string, unknown> | undefined;
      const animateKey = typeof props.animate === "string" ? props.animate : undefined;
      if (variants && animateKey) {
        const variant = variants[animateKey];
        if (typeof variant === "function") {
          (variant as (custom: unknown) => unknown)(props.custom);
        }
      }
      // Filter out framer-motion-specific props that React doesn't understand
      const domProps = Object.fromEntries(Object.entries(props).filter(([key]) => !motionPropKeys.includes(key)));
      return React.createElement("div", domProps, children);
    };

    return {
      motion: new Proxy(
        {},
        {
          get: () => passthrough,
        },
      ),
      AnimatePresence: ({ children }: { children: unknown }) => children,
      useAnimation: () => ({ start: mock(() => {}), stop: mock(() => {}) }),
      useInView: () => true,
    };
  });
}
