import type { ForkOptions } from "node:child_process";

/**
 * The supervisor's fork options (part 1, "Starting the child"), shared by the integration and e2e legs.
 * Without an execPath, fork() uses this process's own, which inside an extension host is VS Code's binary.
 */
export function backendForkOptions(extensionRoot: string, execPath?: string): ForkOptions {
  return {
    ...(execPath !== undefined && { execPath }),
    execArgv: [],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ASAR: "1", NODE_ENV: "production" },
    cwd: extensionRoot,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "json",
    windowsHide: true,
  };
}
