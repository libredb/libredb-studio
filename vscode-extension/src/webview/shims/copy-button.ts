// Replaces @/components/copy-button in the webview bundle (part 4's shim table): the host writes the clipboard.
// It exports only what the bundled graph imports, so a new import from that module fails the build.
import { requestCopy } from "../clipboard";

export const writeToClipboard: (text: string) => Promise<boolean> = requestCopy;
