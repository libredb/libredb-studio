/**
 * Shared next/navigation mock for all hook and component tests.
 *
 * IMPORTANT: Bun's mock.module() is process-wide — calling it from multiple files
 * causes the LAST call to win. This shared module ensures mock.module('next/navigation')
 * is called exactly once, and all test files can assert on the same mock functions.
 *
 * Usage:
 *   import { mockRouterPush, mockRouterRefresh } from '../helpers/mock-navigation';
 *   beforeEach(() => { mockRouterPush.mockClear(); mockRouterRefresh.mockClear(); });
 */
import { mock } from 'bun:test';

export const mockRouterPush = mock(() => {});
export const mockRouterRefresh = mock(() => {});
export const mockRouterBack = mock(() => {});
export const mockRouterForward = mock(() => {});

mock.module('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    refresh: mockRouterRefresh,
    back: mockRouterBack,
    forward: mockRouterForward,
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
