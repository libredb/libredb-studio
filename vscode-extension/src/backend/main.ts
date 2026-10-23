// The child entry. The floor's one source is the root package.json's engines.node: a named JSON import, so esbuild
// bundles only the engines property of that file.
import { testConnection } from "@/lib/api/test-connection";
import { clearProviderCache, enabledProviderTypes, getOrCreateProvider, removeProvider } from "@/lib/db/factory";
import { engines } from "../../../package.json";
import { startBackend } from "./start";

startBackend(
  process,
  { getOrCreateProvider, removeProvider, clearProviderCache, enabledProviderTypes, testConnection },
  engines.node,
);
