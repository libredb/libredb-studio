import '../setup-dom';

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useIsMobile } from '@/hooks/use-mobile';

// =============================================================================
// matchMedia mock helpers
// =============================================================================

interface MockMediaQueryList {
  matches: boolean;
  media: string;
  onchange: null;
  addListener: ReturnType<typeof mock>;
  removeListener: ReturnType<typeof mock>;
  addEventListener: ReturnType<typeof mock>;
  removeEventListener: ReturnType<typeof mock>;
  dispatchEvent: ReturnType<typeof mock>;
  _listeners: Array<(event: { matches: boolean }) => void>;
  _triggerChange: (matches: boolean) => void;
}

function createMockMatchMedia(initialMatches: boolean) {
  let currentMql: MockMediaQueryList;

  const mockMatchMedia = mock((query: string): MediaQueryList => {
    const listeners: Array<(event: { matches: boolean }) => void> = [];

    currentMql = {
      matches: initialMatches,
      media: query,
      onchange: null,
      addListener: mock(() => {}),
      removeListener: mock(() => {}),
      addEventListener: mock((event: string, listener: (event: { matches: boolean }) => void) => {
        if (event === 'change') {
          listeners.push(listener);
        }
      }),
      removeEventListener: mock((event: string, listener: (event: { matches: boolean }) => void) => {
        if (event === 'change') {
          const index = listeners.indexOf(listener);
          if (index > -1) listeners.splice(index, 1);
        }
      }),
      dispatchEvent: mock(() => true),
      _listeners: listeners,
      _triggerChange(matches: boolean) {
        this.matches = matches;
        for (const listener of listeners) {
          listener({ matches });
        }
      },
    };

    return currentMql as unknown as MediaQueryList;
  });

  return {
    mockMatchMedia,
    getMql: () => currentMql,
  };
}

// =============================================================================
// useIsMobile Tests
// =============================================================================
describe('useIsMobile', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    // Restore original matchMedia
    Object.defineProperty(window, 'matchMedia', {
      value: originalMatchMedia,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'matchMedia', {
      value: originalMatchMedia,
      writable: true,
      configurable: true,
    });
  });

  test('initially returns false when matchMedia does not match', () => {
    const { mockMatchMedia } = createMockMatchMedia(false);
    Object.defineProperty(window, 'matchMedia', {
      value: mockMatchMedia,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useIsMobile());

    // After the useEffect runs and sets initial value from mql.matches (false)
    expect(result.current).toBe(false);
  });

  test('returns true when matchMedia matches (viewport below breakpoint)', async () => {
    const { mockMatchMedia } = createMockMatchMedia(true);
    Object.defineProperty(window, 'matchMedia', {
      value: mockMatchMedia,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useIsMobile());

    await waitFor(() => {
      expect(result.current).toBe(true);
    });

    // Verify matchMedia was called with the correct query
    expect(mockMatchMedia).toHaveBeenCalledWith('(max-width: 767px)');
  });

  test('responds to matchMedia change events', async () => {
    const { mockMatchMedia, getMql } = createMockMatchMedia(false);
    Object.defineProperty(window, 'matchMedia', {
      value: mockMatchMedia,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useIsMobile());

    // Initially not mobile
    expect(result.current).toBe(false);

    // Simulate viewport narrowing below breakpoint
    act(() => {
      getMql()._triggerChange(true);
    });

    await waitFor(() => {
      expect(result.current).toBe(true);
    });

    // Simulate viewport widening above breakpoint
    act(() => {
      getMql()._triggerChange(false);
    });

    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  test('cleans up event listener on unmount', () => {
    const { mockMatchMedia, getMql } = createMockMatchMedia(false);
    Object.defineProperty(window, 'matchMedia', {
      value: mockMatchMedia,
      writable: true,
      configurable: true,
    });

    const { unmount } = renderHook(() => useIsMobile());

    const mql = getMql();
    expect(mql.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    unmount();

    expect(mql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    // Verify the same listener function was added and removed
    const addedListener = mql.addEventListener.mock.calls[0][1];
    const removedListener = mql.removeEventListener.mock.calls[0][1];
    expect(addedListener).toBe(removedListener);
  });
});
