// Replaces sonner in the webview bundle (part 4's shim table): sonner inserts an un-nonced <style> at import, which
// the CSP blocks, and no Toaster is mounted. Each toast posts notify, which the host shows on VS Code's own surfaces.
// It exports only toast, so a new import from sonner fails the build.
import { RESULTS_LIMITS } from "../../results-protocol";
import { postToHost } from "../host-channel";

type Notice = (message: string) => void;

/** Cut to the host's bound, so a long engine sentence cannot make the host refuse the message. */
const notify =
  (level: "info" | "error"): Notice =>
  (message) =>
    postToHost({ v: 1, type: "notify", level, message: message.slice(0, RESULTS_LIMITS.notifyChars) });

const info = notify("info");
const error = notify("error");

/** toast(message) and toast.message, .info, .success post notify at level info; .warning and .error at level error. */
export const toast: Notice & { message: Notice; info: Notice; success: Notice; warning: Notice; error: Notice } =
  Object.assign((message: string) => info(message), { message: info, info, success: info, warning: error, error });
