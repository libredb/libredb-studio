/**
 * One process-wide cookie jar behind a `next/headers` module mock, for code that calls `cookies()` and `headers()`.
 * bun's module mocks are process-wide, so a test file installs this once, before importing any module that
 * imports `next/headers`, and clears the jar between cases with `resetCookieJar`.
 */
import { mock } from "bun:test";
import { createMockCookies } from "./mock-next";

const jar = createMockCookies();
export const cookieJar = jar._store;
export const deletedCookies = jar._deleted;
/** Request headers `headers()` answers with; keys are lower case. */
export const requestHeaders = new Map<string, string>();

/** Call at the top of a test file, before importing any module that imports next/headers. */
export function installNextHeadersMock(): void {
  mock.module("next/headers", () => ({
    cookies: async () => jar,
    headers: async () => ({ get: (name: string) => requestHeaders.get(name.toLowerCase()) ?? null }),
  }));
}

export function resetCookieJar(): void {
  cookieJar.clear();
  deletedCookies.length = 0;
  requestHeaders.clear();
}
