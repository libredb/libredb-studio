import type { ForkOptions } from "node:child_process";
import { ENABLED_PROVIDERS } from "./channel";

/**
 * The options the supervisor forks the child with (part 1, "Starting the child"); the integration and e2e legs fork
 * with these too.
 * Without an execPath, fork() uses this process's own, which inside an extension host is VS Code's binary.
 */
export function backendForkOptions(extensionRoot: string, execPath?: string): ForkOptions {
  return {
    ...(execPath !== undefined && { execPath }),
    execArgv: [],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ASAR: "1",
      NODE_ENV: "production",
      LIBREDB_ENABLED_PROVIDERS: ENABLED_PROVIDERS.join(","),
    },
    cwd: extensionRoot,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "json",
    windowsHide: true,
  };
}
