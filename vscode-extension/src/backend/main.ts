// The child entry, and its composition root: it installs the process's one provider host core
// (src/lib/provider-host/instance.ts, docs/providers/CONTRACT.md clause C-52) before it starts the backend, so every
// query/run and query/cancel reads that core. The floor's one source is the root package.json's engines.node: a named
// JSON import, so esbuild bundles only the engines property of that file.
import { testConnection } from "@/lib/api/test-connection";
import { clearProviderCache, enabledProviderTypes, getOrCreateProvider, removeProvider } from "@/lib/db/factory";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { installHostCore } from "@/lib/provider-host/instance";
import { engines } from "../../../package.json";
import { startBackend } from "./start";

installHostCore(createHostCore());
startBackend(
  process,
  { getOrCreateProvider, removeProvider, clearProviderCache, enabledProviderTypes, testConnection },
  engines.node,
);
