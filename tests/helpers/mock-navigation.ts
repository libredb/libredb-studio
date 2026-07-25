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
import { mock } from "bun:test";

export const mockRouterPush = mock(() => {});
export const mockRouterRefresh = mock(() => {});
export const mockRouterBack = mock(() => {});
export const mockRouterForward = mock(() => {});
export const mockRedirect = mock((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

// Mutable search params so tests can simulate query strings (e.g. ?error=...).
// Defaults to empty; tests that set it MUST reset it in afterEach to avoid
// leaking state into later files in the same process.
let mockSearchParams = new URLSearchParams();
export function setMockSearchParams(params: URLSearchParams) {
  mockSearchParams = params;
}
export function resetMockSearchParams() {
  mockSearchParams = new URLSearchParams();
}

// Mutable pathname for route-aware UI (e.g. admin section nav).
let mockPathname = "/";
export function setMockPathname(pathname: string) {
  mockPathname = pathname;
}
export function resetMockPathname() {
  mockPathname = "/";
}

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: mockRouterPush,
    refresh: mockRouterRefresh,
    back: mockRouterBack,
    forward: mockRouterForward,
  }),
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearchParams,
  redirect: mockRedirect,
}));
