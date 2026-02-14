/**
 * DOM environment setup for hook and component tests.
 * Uses happy-dom to provide document, window, and other browser globals.
 * Import this at the top of test files that need a DOM environment.
 */
import { GlobalWindow } from 'happy-dom';

if (typeof globalThis.document === 'undefined') {
  const window = new GlobalWindow({ url: 'http://localhost:3000' });

  // Copy essential DOM globals to globalThis
  const domGlobals = [
    'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
    'HTMLSelectElement', 'HTMLButtonElement', 'HTMLFormElement',
    'HTMLDivElement', 'HTMLSpanElement', 'HTMLAnchorElement',
    'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
    'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
    'navigator', 'location', 'history', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'DOMParser', 'XMLSerializer', 'URL', 'URLSearchParams',
    'AbortController', 'AbortSignal', 'Headers', 'Request', 'Response',
    'FormData', 'Blob', 'File', 'FileReader', 'FileList',
    'MediaQueryList', 'matchMedia',
    'SVGElement', 'SVGSVGElement',
    'Text', 'Comment', 'DocumentFragment',
    'NodeList', 'HTMLCollection',
    'NodeFilter', 'TreeWalker', 'Range', 'Selection',
    'HTMLTableElement', 'HTMLTableRowElement', 'HTMLTableCellElement',
    'HTMLLabelElement', 'HTMLImageElement', 'HTMLCanvasElement',
    'HTMLPreElement', 'CSSStyleDeclaration',
  ];

  for (const key of domGlobals) {
    if (key in window && !(key in globalThis)) {
      try {
        Object.defineProperty(globalThis, key, {
          value: (window as Record<string, unknown>)[key],
          writable: true,
          configurable: true,
        });
      } catch {
        // Some properties may not be transferable
      }
    }
  }

  // Ensure window itself is available
  if (typeof globalThis.window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
      value: window,
      writable: true,
      configurable: true,
    });
  }
}

export {};
