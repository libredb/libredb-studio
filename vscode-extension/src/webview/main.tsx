// The Results webview bundle's entry: a classic script, so document.currentScript carries its nonce.
import type { VsCodeApi } from "./results-store";
import { startResultsView } from "./start";

declare function acquireVsCodeApi(): VsCodeApi;

startResultsView({ window, document, acquireVsCodeApi });
