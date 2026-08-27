/**
 * Gemini endpoint resolution (B20).
 *
 * `LLM_API_URL` is one variable and the two Gemini consumers spell the same
 * endpoint differently, so it has to be read two ways. Measured in the installed
 * builds rather than taken from the vendors' documentation:
 *
 *  - `@google/generative-ai` (the chat surface) takes `RequestOptions.baseUrl` as
 *    an ORIGIN and appends the version itself —
 *    `` `${baseUrl}/${apiVersion}/${model}:${task}` `` with `apiVersion` defaulting
 *    to `v1beta` (`node_modules/@google/generative-ai/dist/index.js:333-335`),
 *  - `@ai-sdk/google` (the agent adapter) takes a `baseURL` that already CARRIES
 *    the version path, defaulting to
 *    `https://generativelanguage.googleapis.com/v1beta`
 *    (`node_modules/@ai-sdk/google/dist/index.js:7855`).
 *
 * The value the operator enters is the versioned one, because that is the form
 * Google's own documentation and every proxy's configuration print, and because it
 * matches what `LLM_API_URL` already means for the OpenAI-compatible kinds — a
 * complete base URL ending in the API version. The version segment is optional:
 * an operator who names a bare origin gets `v1beta` appended for the agent and the
 * origin passed through for the chat surface, so both surfaces reach one host either
 * way. Leaving the variable unset returns undefined on both paths, which selects
 * each SDK's own Google default; `@ai-sdk/google`'s base URL has no environment
 * fallback for an undefined value to re-open (same line 7855).
 */

/** The version segment both SDKs default to; the only one this repository composes. */
export const GEMINI_DEFAULT_API_VERSION = "v1beta";

/** Version segments Google serves, so a configured one is preserved rather than doubled. */
const API_VERSION_SUFFIX = /\/v1(?:alpha|beta)?$/;

function withoutTrailingSlashes(apiUrl: string | undefined): string | undefined {
  const trimmed = apiUrl?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : undefined;
}

/**
 * The `RequestOptions.baseUrl` for `@google/generative-ai`: an origin with any
 * version segment removed, because that SDK appends the version itself.
 */
export function resolveGeminiChatBaseUrl(apiUrl: string | undefined): string | undefined {
  const base = withoutTrailingSlashes(apiUrl)?.replace(API_VERSION_SUFFIX, "");
  return base ? base : undefined;
}

/**
 * The `baseURL` for `@ai-sdk/google`: the same endpoint WITH a version segment,
 * appended only when the configured value does not already carry one.
 */
export function resolveGeminiSdkBaseUrl(apiUrl: string | undefined): string | undefined {
  const base = withoutTrailingSlashes(apiUrl);
  if (!base) return undefined;
  return API_VERSION_SUFFIX.test(base) ? base : `${base}/${GEMINI_DEFAULT_API_VERSION}`;
}
