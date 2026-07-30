import { loader } from "@monaco-editor/react";

/**
 * Where the self-hosted Monaco AMD bundle is served from.
 *
 * `@monaco-editor/react` defaults to `https://cdn.jsdelivr.net/npm/monaco-editor@<v>/min/vs`,
 * which leaves the editor broken on air-gapped installs and makes CI depend on a third-party
 * CDN. `scripts/copy-monaco.mjs` stages `node_modules/monaco-editor/min/vs` into
 * `public/monaco/vs` at build time, so this path is served from our own origin.
 */
export const DEFAULT_MONACO_VS_PATH = "/monaco/vs";

interface MonacoLoaderLike {
  config: (config: { paths?: { vs?: string } }) => void;
}

/**
 * Resolves the base path Monaco's AMD loader should fetch from. Deployments that serve the
 * assets elsewhere (a sub-path mount, or platform embedding the npm package) set
 * `NEXT_PUBLIC_MONACO_VS_PATH`.
 */
export function resolveMonacoVsPath(override: string | undefined): string {
  const trimmed = override?.trim();
  if (!trimmed) return DEFAULT_MONACO_VS_PATH;
  return trimmed.replace(/\/+$/, "");
}

/** Points Monaco's AMD loader at our own origin. Must run before the first `<Editor>` mounts. */
export function configureMonacoLoader(monacoLoader: MonacoLoaderLike = loader): void {
  monacoLoader.config({ paths: { vs: resolveMonacoVsPath(process.env.NEXT_PUBLIC_MONACO_VS_PATH) } });
}
