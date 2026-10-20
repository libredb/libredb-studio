import { type ChildProcess, fork } from "node:child_process";
import { join } from "node:path";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import versions from "../vscode-versions.json";

export type BackendRuntimeName = "node" | "vscode";

export interface BackendRuntime {
  readonly name: BackendRuntimeName;
  readonly execPath: string;
}

const EXTENSION_ROOT = join(__dirname, "..", "..");

/** Throws `LIBREDB_BACKEND_RUNTIME is "<value>"; set it to node or vscode.` for anything else, unset included. */
export function runtimeName(value: string | undefined): BackendRuntimeName {
  if (value === "node" || value === "vscode") return value;
  throw new Error(`LIBREDB_BACKEND_RUNTIME is "${value}"; set it to node or vscode.`);
}

/** node: this process's execPath. vscode: the binary of LIBREDB_VSCODE_VERSION, else the pinned stable build, downloaded into .vscode-test/. */
export async function backendRuntime(): Promise<BackendRuntime> {
  const name = runtimeName(process.env.LIBREDB_BACKEND_RUNTIME);
  if (name === "node") return { name, execPath: process.execPath };
  const execPath = await downloadAndUnzipVSCode({
    version: process.env.LIBREDB_VSCODE_VERSION ?? versions.stable,
    cachePath: join(EXTENSION_ROOT, ".vscode-test"),
  });
  return { name, execPath };
}

/** Forks dist/backend.js on the runtime with the supervisor's options (part 1, "Starting the child"). */
export function forkBackend(runtime: BackendRuntime): ChildProcess {
  return fork(join(EXTENSION_ROOT, "dist", "backend.js"), [], {
    execPath: runtime.execPath,
    execArgv: [],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ASAR: "1", NODE_ENV: "production" },
    cwd: EXTENSION_ROOT,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "json",
    windowsHide: true,
  });
}
