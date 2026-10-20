import type { ChildProcess } from "node:child_process";

/**
 * The child's first message, shared by the integration and e2e legs.
 * Rejects with `child exited <code or signal> before answering: <stderr>` when the child ends first,
 * so a missing or crashing dist/backend.js fails at once with its own error instead of at Mocha's timeout.
 * It reads both pipes for as long as the child runs, so a chatty child never blocks on a full one.
 */
export function firstAnswer(child: ChildProcess): Promise<unknown> {
  let stderr = "";
  child.stdout?.resume();
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      child.off("close", onClose);
      resolve(message);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      child.off("message", onMessage);
      reject(new Error(`child exited ${code ?? signal} before answering: ${stderr.trim()}`));
    };
    child.once("message", onMessage);
    child.once("close", onClose);
  });
}
