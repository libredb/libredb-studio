/**
 * DOM environment setup for hook and component tests.
 * Uses happy-dom to provide document, window, and other browser globals.
 * Import this at the top of test files that need a DOM environment.
 */
import { GlobalWindow } from "happy-dom";

if (typeof globalThis.document === "undefined") {
  const window = new GlobalWindow({ url: "http://localhost:3000" });

  // Copy essential DOM globals to globalThis
  const domGlobals = [
    "document",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "HTMLButtonElement",
    "HTMLFormElement",
    "HTMLDivElement",
    "HTMLSpanElement",
    "HTMLAnchorElement",
    "Element",
    "Node",
    "Event",
    "CustomEvent",
    "MouseEvent",
    "KeyboardEvent",
    "MutationObserver",
    "IntersectionObserver",
    "ResizeObserver",
    "navigator",
    "location",
    "history",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "DOMParser",
    "XMLSerializer",
    "URL",
    "URLSearchParams",
    "AbortController",
    "AbortSignal",
    "Headers",
    "Request",
    "Response",
    "FormData",
    "Blob",
    "File",
    "FileReader",
    "FileList",
    "MediaQueryList",
    "matchMedia",
    "SVGElement",
    "SVGSVGElement",
    "Text",
    "Comment",
    "DocumentFragment",
    "NodeList",
    "HTMLCollection",
    "NodeFilter",
    "TreeWalker",
    "Range",
    "Selection",
    "HTMLTableElement",
    "HTMLTableRowElement",
    "HTMLTableCellElement",
    "HTMLLabelElement",
    "HTMLImageElement",
    "HTMLCanvasElement",
    "HTMLPreElement",
    "CSSStyleDeclaration",
  ];

  // Event constructors must come from the SAME realm as the EventTarget that
  // will receive them. Bun ships its own global Event/CustomEvent, so the
  // "only if missing" rule below silently keeps Bun's - and happy-dom >= 20.11
  // validates `dispatchEvent`'s argument against its own Event class, which a
  // Bun-constructed CustomEvent fails with "parameter 1 is not of type
  // 'Event'". Earlier happy-dom skipped that check, so the realm mismatch was
  // latent rather than absent. These few always override.
  const realmBoundGlobals = new Set(["Event", "CustomEvent", "MouseEvent", "KeyboardEvent"]);

  for (const key of domGlobals) {
    if (key in window && (realmBoundGlobals.has(key) || !(key in globalThis))) {
      try {
        Object.defineProperty(globalThis, key, {
          value: (window as unknown as Record<string, unknown>)[key],
          writable: true,
          configurable: true,
        });
      } catch {
        // Some properties may not be transferable
      }
    }
  }

  // Ensure window itself is available
  if (typeof globalThis.window === "undefined") {
    Object.defineProperty(globalThis, "window", {
      value: window,
      writable: true,
      configurable: true,
    });
  }
}
