/**
 * Monaco Editor mock for component tests
 * Replaces the heavy Monaco Editor with a simple textarea
 */
import { mock } from 'bun:test';

export function setupMonacoMock() {
  mock.module('@monaco-editor/react', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return {
      default: function MockEditor(props: {
        value?: string;
        onChange?: (value: string | undefined) => void;
        language?: string;
        'data-testid'?: string;
      }) {
        return React.createElement('textarea', {
          'data-testid': props['data-testid'] ?? 'mock-monaco-editor',
          value: props.value ?? '',
          onChange: (e: { target: { value: string } }) => props.onChange?.(e.target.value),
          'aria-label': `${props.language ?? 'sql'} editor`,
        });
      },
      Editor: function MockEditor(props: {
        value?: string;
        onChange?: (value: string | undefined) => void;
        language?: string;
      }) {
        return React.createElement('textarea', {
          'data-testid': 'mock-monaco-editor',
          value: props.value ?? '',
          onChange: (e: { target: { value: string } }) => props.onChange?.(e.target.value),
        });
      },
      loader: {
        init: mock(() => Promise.resolve()),
        config: mock(() => {}),
      },
      useMonaco: mock(() => null),
    };
  });
}

export function setupRechartssMock() {
  mock.module('recharts', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return {
      ResponsiveContainer: ({ children }: { children: unknown }) => children,
      AreaChart: ({ children }: { children: unknown }) => React.createElement('div', { 'data-testid': 'mock-area-chart' }, children),
      BarChart: ({ children }: { children: unknown }) => React.createElement('div', { 'data-testid': 'mock-bar-chart' }, children),
      LineChart: ({ children }: { children: unknown }) => React.createElement('div', { 'data-testid': 'mock-line-chart' }, children),
      RadialBarChart: ({ children }: { children: unknown }) => React.createElement('div', { 'data-testid': 'mock-radial-chart' }, children),
      Area: () => null,
      Bar: () => null,
      Line: () => null,
      RadialBar: () => null,
      XAxis: () => null,
      YAxis: () => null,
      CartesianGrid: () => null,
      Tooltip: () => null,
      Legend: () => null,
      PolarAngleAxis: () => null,
    };
  });
}

export function setupXYFlowMock() {
  mock.module('@xyflow/react', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return {
      ReactFlow: ({ children }: { children: unknown }) => React.createElement('div', { 'data-testid': 'mock-react-flow' }, children),
      ReactFlowProvider: ({ children }: { children: unknown }) => children,
      MiniMap: () => React.createElement('div', { 'data-testid': 'mock-minimap' }),
      Controls: () => null,
      Background: () => null,
      Handle: () => null,
      useNodesState: () => [[], mock(() => {}), mock(() => {})],
      useEdgesState: () => [[], mock(() => {}), mock(() => {})],
      useReactFlow: () => ({ fitView: mock(() => {}), getNodes: mock(() => []), getEdges: mock(() => []) }),
      Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
      MarkerType: { ArrowClosed: 'arrowclosed' },
      Panel: ({ children, position }: { children: unknown; position?: string }) => React.createElement('div', { 'data-testid': `mock-panel-${position || 'default'}` }, children),
    };
  });
}

export function setupFramerMotionMock() {
  mock.module('framer-motion', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    const motionPropKeys = ['initial', 'animate', 'exit', 'transition', 'variants', 'whileHover', 'whileTap', 'whileInView', 'layout', 'layoutId'];
    const passthrough = ({ children, ...props }: Record<string, unknown>) => {
      // Filter out framer-motion-specific props that React doesn't understand
      const domProps = Object.fromEntries(
        Object.entries(props).filter(([key]) => !motionPropKeys.includes(key))
      );
      return React.createElement('div', domProps, children);
    };

    return {
      motion: new Proxy({}, {
        get: () => passthrough,
      }),
      AnimatePresence: ({ children }: { children: unknown }) => children,
      useAnimation: () => ({ start: mock(() => {}), stop: mock(() => {}) }),
      useInView: () => true,
    };
  });
}
